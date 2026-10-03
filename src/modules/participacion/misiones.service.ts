import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia } from '../../common/util.js';
import { AuditoriaService, NotificacionesService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { LlmService } from '../ia/llm.service.js';

export type Plantilla = 'locales_distintos' | 'compras_categoria' | 'franja_horaria' | 'primera_visita' | 'local_especifico';

export interface ReglaMision {
  n?: number;
  categoria?: string | null;
  desde?: string;
  hasta?: string;
  localId?: string;
  montoMin?: number;
}

interface Mision {
  id: string;
  recinto_id: string;
  nombre: string;
  descripcion: string;
  plantilla: Plantilla;
  regla: ReglaMision;
  meta: number;
  recompensa_puntos: number;
  vigencia_desde: string;
  vigencia_hasta: string;
  cliente_id: string | null;
  origen: string;
}

/**
 * Misiones (Specification): cada plantilla es una regla JSON que se evalúa con SQL
 * sobre las compras y check-ins del cliente dentro de la vigencia. El avance se recalcula
 * siempre desde los datos, así es idempotente.
 */
@Injectable()
export class MisionesService implements OnModuleInit {
  private readonly log = new Logger('Misiones');

  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly notif: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly bus: EventBus,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    this.bus.on('compra.registrada', (e) => this.evaluarCliente(e.recintoId, e.clienteId));
    this.bus.on('checkin.registrado', (e) => this.evaluarCliente(e.recintoId, e.clienteId));
  }

  private aplicables(q: Queryable, recintoId: string, clienteId: string) {
    const { fecha } = ahoraBolivia();
    return many<Mision>(
      q,
      `select m.* from mision m left join segmento s on s.id = m.segmento_id
       where m.recinto_id = $1 and m.activa and $3::date between m.vigencia_desde and m.vigencia_hasta
         and (m.cliente_id = $2 or (m.cliente_id is null and (m.segmento_id is null or $2 = any(s.cliente_ids))))`,
      [recintoId, clienteId, fecha],
    );
  }

  /** Cuenta el avance de una misión para un cliente según su plantilla. */
  private async avance(q: Queryable, m: Mision, clienteId: string): Promise<number> {
    const r = m.regla ?? {};
    const desde = m.vigencia_desde;
    const hasta = m.vigencia_hasta;
    const base = `from transaccion t join local l on l.id = t.local_id join categoria c on c.id = l.categoria_id
                  where t.cliente_id = $1 and t.estado = 'valida' and bo(t.creado_en)::date between $2::date and $3::date`;
    switch (m.plantilla) {
      case 'locales_distintos': {
        const x = await one<{ n: number }>(q, `select count(distinct t.local_id)::int as n ${base} and ($4::text is null or c.nombre = $4)`, [clienteId, desde, hasta, r.categoria ?? null]);
        return x?.n ?? 0;
      }
      case 'compras_categoria': {
        const x = await one<{ n: number }>(q, `select count(*)::int as n ${base} and ($4::text is null or c.nombre = $4)`, [clienteId, desde, hasta, r.categoria ?? null]);
        return x?.n ?? 0;
      }
      case 'franja_horaria': {
        const x = await one<{ n: number }>(
          q,
          `select count(*)::int as n ${base} and bo(t.creado_en)::time between $4::time and $5::time and ($6::text is null or c.nombre = $6)`,
          [clienteId, desde, hasta, r.desde ?? '00:00', r.hasta ?? '23:59', r.categoria ?? null],
        );
        return x?.n ?? 0;
      }
      case 'primera_visita': {
        const x = await one<{ n: number }>(
          q,
          `select count(*)::int as n from (
             select local_id, min(en) as primera from (
               select local_id, entrada_en as en from checkin_local where cliente_id = $1
               union all select local_id, creado_en from transaccion where cliente_id = $1 and estado = 'valida') a
             group by local_id) p
           where bo(p.primera)::date between $2::date and $3::date`,
          [clienteId, desde, hasta],
        );
        return x?.n ?? 0;
      }
      case 'local_especifico': {
        const x = await one<{ n: number }>(q, `select count(*)::int as n ${base} and t.local_id = $4 and t.monto_bs >= $5`, [
          clienteId, desde, hasta, r.localId, r.montoMin ?? 0,
        ]);
        return x?.n ?? 0;
      }
    }
  }

  /** Recalcula todas las misiones del cliente y acredita las completadas. */
  async evaluarCliente(recintoId: string, clienteId: string) {
    const completadas = await this.db.tx(async (q) => {
      const lista = await this.aplicables(q, recintoId, clienteId);
      const hechas: Mision[] = [];
      for (const m of lista) {
        const prog = await one<{ completada_en: string | null }>(q, 'select completada_en from progreso_mision where mision_id = $1 and cliente_id = $2 for update', [m.id, clienteId]);
        if (prog?.completada_en) continue;
        const avance = Math.min(await this.avance(q, m, clienteId), m.meta);
        const completa = avance >= m.meta;
        await q.query(
          `insert into progreso_mision (mision_id, cliente_id, avance, completada_en) values ($1,$2,$3, case when $4 then now() end)
           on conflict (mision_id, cliente_id) do update set avance = excluded.avance, completada_en = excluded.completada_en`,
          [m.id, clienteId, avance, completa],
        );
        if (completa) {
          await this.fidelizacion.acreditar(q, {
            recintoId, clienteId, tipo: 'mision', puntos: m.recompensa_puntos, referenciaId: m.id, descripcion: `Misión cumplida: ${m.nombre}`,
          });
          await this.notif.crear(q, clienteId, 'mision', 'Misión cumplida', `${m.nombre}: +${m.recompensa_puntos} pts`, { misionId: m.id });
          hechas.push(m);
        }
      }
      return hechas;
    });
    if (completadas.length) this.log.log(`cliente ${clienteId.slice(0, 8)} completó ${completadas.length} misión(es)`);
  }

  /** HU-C13: lista de misiones con progreso; genera la misión personalizada si corresponde. */
  async delCliente(recintoId: string, clienteId: string) {
    await this.asegurarMisionIA(recintoId, clienteId).catch((e) => this.log.warn(`misión IA: ${e.message}`));
    await this.evaluarCliente(recintoId, clienteId);
    const lista = await this.aplicables(this.db, recintoId, clienteId);
    const progreso = await many<{ mision_id: string; avance: number; completada_en: string | null }>(
      this.db,
      'select mision_id, avance, completada_en from progreso_mision where cliente_id = $1',
      [clienteId],
    );
    const mapa = new Map(progreso.map((p) => [p.mision_id, p]));
    const locales = await many<{ id: string; nombre: string; piso: string; sector: string; numero_local: string }>(
      this.db,
      `select id, nombre, piso, sector, numero_local from local where id = any($1::uuid[])`,
      [lista.filter((m) => m.regla?.localId).map((m) => m.regla.localId!)],
    );
    const ml = new Map(locales.map((l) => [l.id, l]));
    return lista
      .map((m) => ({
        id: m.id,
        nombre: m.nombre,
        descripcion: m.descripcion,
        plantilla: m.plantilla,
        meta: m.meta,
        avance: mapa.get(m.id)?.avance ?? 0,
        completada: !!mapa.get(m.id)?.completada_en,
        completadaEn: mapa.get(m.id)?.completada_en ?? null,
        recompensa: m.recompensa_puntos,
        vigenteHasta: m.vigencia_hasta,
        personal: m.origen === 'ia',
        local: m.regla?.localId ? ml.get(m.regla.localId) ?? null : null,
      }))
      .sort((a, b) => Number(a.completada) - Number(b.completada) || Number(b.personal) - Number(a.personal));
  }

  /**
   * Orquestación por IA: busca la categoría que más le gusta al cliente (compras + intereses)
   * y le propone un local de esa categoría que todavía no visitó, priorizando los que comparten
   * más clientes con los locales que ya frecuenta (matriz de afinidad). Si visita sin comprar,
   * propone una compra pequeña en un local que ya conoce.
   */
  async asegurarMisionIA(recintoId: string, clienteId: string) {
    const perfil = await one<{ consent_personalizacion: boolean; intereses: string[] }>(
      this.db,
      'select consent_personalizacion, intereses from cliente_perfil where usuario_id = $1',
      [clienteId],
    );
    if (!perfil?.consent_personalizacion) return;
    const { fecha } = ahoraBolivia();
    const activa = await one(
      this.db,
      `select m.id from mision m left join progreso_mision p on p.mision_id = m.id and p.cliente_id = $1
       where m.cliente_id = $1 and m.origen = 'ia' and m.activa and $2::date <= m.vigencia_hasta and p.completada_en is null`,
      [clienteId, fecha],
    );
    if (activa) return;

    const compras = await many<{ categoria: string; local: string; local_id: string; n: number }>(
      this.db,
      `select c.nombre as categoria, l.nombre as local, l.id as local_id, count(*)::int as n
       from transaccion t join local l on l.id = t.local_id join categoria c on c.id = l.categoria_id
       where t.cliente_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '120 days'
       group by 1,2,3 order by n desc`,
      [clienteId],
    );
    const puntaje = new Map<string, number>();
    for (const c of compras) puntaje.set(c.categoria, (puntaje.get(c.categoria) ?? 0) + c.n);
    for (const i of perfil.intereses ?? []) puntaje.set(i, (puntaje.get(i) ?? 0) + 2);
    const categorias = [...puntaje.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);

    let elegido: { id: string; nombre: string; piso: string; numero_local: string; categoria: string; afinidad: number } | undefined;
    for (const cat of categorias.slice(0, 3)) {
      elegido = await one(
        this.db,
        `with mios as (select distinct local_id from transaccion where cliente_id = $1 and estado = 'valida'),
              vecinos as (select distinct t.cliente_id from transaccion t where t.local_id in (select local_id from mios) and t.cliente_id <> $1)
         select l.id, l.nombre, l.piso, l.numero_local, c.nombre as categoria,
                (select count(distinct t.cliente_id) from transaccion t where t.local_id = l.id and t.cliente_id in (select cliente_id from vecinos))::int as afinidad
         from local l join categoria c on c.id = l.categoria_id
         where c.nombre = $2 and l.activo and l.recinto_id = $3
           and not exists (select 1 from transaccion t where t.cliente_id = $1 and t.local_id = l.id)
           and not exists (select 1 from checkin_local k where k.cliente_id = $1 and k.local_id = l.id)
         order by afinidad desc, random() limit 1`,
        [clienteId, cat, recintoId],
      );
      if (elegido) break;
    }

    let nombre: string;
    let descripcion: string;
    let regla: ReglaMision;
    let puntos = 150;
    if (elegido) {
      const favoritos = compras.filter((c) => c.categoria === elegido!.categoria).slice(0, 2);
      const contexto = favoritos.length
        ? `ya fuiste ${favoritos.map((f) => `${f.n} ${f.n === 1 ? 'vez' : 'veces'} a ${f.local}`).join(' y ')}`
        : `marcaste ${elegido.categoria} entre tus intereses`;
      nombre = `Prueba ${elegido.nombre}`;
      descripcion = `Te gusta ${elegido.categoria.toLowerCase()}: ${contexto}. Haz tu primera compra en ${elegido.nombre} (${elegido.piso} · Local ${elegido.numero_local}) y gana ${puntos} pts.`;
      regla = { localId: elegido.id, n: 1 };
      const redaccion = await this.llm.completar(
        'Redactas misiones breves para una app de puntos de un centro comercial boliviano. Español neutro, tuteo, máximo 2 frases, sin emojis. Responde solo el texto.',
        `Cliente: ${contexto}. Categoría favorita: ${elegido.categoria}. Local sugerido: ${elegido.nombre}, ${elegido.piso} local ${elegido.numero_local}. Recompensa: ${puntos} puntos por la primera compra.`,
        { maxTokens: 120 },
      );
      if (redaccion) descripcion = redaccion;
    } else {
      // Visita sin comprar: compra pequeña en un local ya visitado
      const visitado = await one<{ id: string; nombre: string; piso: string; numero_local: string }>(
        this.db,
        `select l.id, l.nombre, l.piso, l.numero_local from checkin_local k join local l on l.id = k.local_id
         where k.cliente_id = $1 and not k.con_compra group by l.id order by count(*) desc limit 1`,
        [clienteId],
      );
      if (!visitado) return;
      puntos = 80;
      nombre = `Tu primera compra en ${visitado.nombre}`;
      descripcion = `Ya pasaste por ${visitado.nombre}. Compra desde Bs 20 y suma ${puntos} pts extra.`;
      regla = { localId: visitado.id, montoMin: 20, n: 1 };
    }
    const hasta = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    await this.db.query(
      `insert into mision (recinto_id, nombre, descripcion, plantilla, regla, meta, recompensa_puntos, cliente_id, vigencia_desde, vigencia_hasta, origen)
       values ($1,$2,$3,'local_especifico',$4,1,$5,$6,$7,$8,'ia')`,
      [recintoId, nombre, descripcion, JSON.stringify(regla), puntos, clienteId, fecha, hasta],
    );
  }

  // ------------------------------------------------------------------ HU-A05 constructor por plantilla
  listar(recintoId: string) {
    return many(
      this.db,
      `select m.*, s.nombre as segmento,
              (select count(*)::int from progreso_mision p where p.mision_id = m.id) as participantes,
              (select count(*)::int from progreso_mision p where p.mision_id = m.id and p.completada_en is not null) as completadas
       from mision m left join segmento s on s.id = m.segmento_id
       where m.recinto_id = $1 and m.cliente_id is null order by m.activa desc, m.creado_en desc`,
      [recintoId],
    );
  }

  resumenIA(recintoId: string) {
    return one(
      this.db,
      `select count(*)::int as generadas,
              count(p.completada_en)::int as completadas,
              coalesce(sum(case when p.completada_en is not null then m.recompensa_puntos end),0)::int as puntos
       from mision m left join progreso_mision p on p.mision_id = m.id where m.recinto_id = $1 and m.origen = 'ia'`,
      [recintoId],
    );
  }

  async crear(
    s: Sesion,
    d: { nombre: string; descripcion: string; plantilla: Plantilla; regla: ReglaMision; recompensaPuntos: number; segmentoId?: string | null; vigenciaDesde: string; vigenciaHasta: string },
  ) {
    if (d.vigenciaHasta < d.vigenciaDesde) throw new BadRequestException('La vigencia termina antes de empezar');
    if (d.plantilla === 'local_especifico' && !d.regla.localId) throw new BadRequestException('Elige el local de la misión');
    const meta = d.plantilla === 'local_especifico' ? 1 : Math.max(1, d.regla.n ?? 1);
    return this.db.tx(async (q) => {
      const m = await one(
        q,
        `insert into mision (recinto_id, nombre, descripcion, plantilla, regla, meta, recompensa_puntos, segmento_id, vigencia_desde, vigencia_hasta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [s.recintoId, d.nombre, d.descripcion, d.plantilla, JSON.stringify(d.regla), meta, d.recompensaPuntos, d.segmentoId ?? null, d.vigenciaDesde, d.vigenciaHasta],
      );
      await this.auditoria.registrar(q, s.sub, 'crear_mision', 'mision', m.id, null, m);
      return m;
    });
  }

  async activar(s: Sesion, id: string, activa: boolean) {
    return this.db.tx(async (q) => {
      const m = await one(q, 'update mision set activa = $2 where id = $1 and recinto_id = $3 returning *', [id, activa, s.recintoId]);
      if (!m) throw new NotFoundException('Misión no encontrada');
      await this.auditoria.registrar(q, s.sub, activa ? 'activar_mision' : 'pausar_mision', 'mision', id, null, { activa });
      return m;
    });
  }
}
