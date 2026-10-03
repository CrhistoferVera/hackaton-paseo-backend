import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia } from '../../common/util.js';
import { EventBus } from '../nucleo/event-bus.js';
import { AuditoriaService } from '../nucleo/nucleo.services.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { EquidadService, type EstadoLocal } from '../jarvis/equidad.service.js';

export interface AjustesIa {
  ofertas_activas: boolean;
  ofertas_por_cliente: number;
  multiplicador_max: number;
  peso_equidad: number;
  hora_generacion: number;
  ultima_generacion: string | null;
}

const NOMBRE_CATEGORIA: Record<string, string> = {
  Comida: 'la comida', Tecnología: 'la tecnología', Moda: 'la moda', Accesorios: 'los accesorios', Servicios: 'los servicios',
  Regalos: 'los regalos', Hogar: 'el hogar', Entretenimiento: 'el entretenimiento',
};
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Generador determinista por fecha: el mismo día produce las mismas ofertas (reproducible y auditable). */
function azar(semilla: string) {
  let s = [...semilla].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Ofertas personales diarias generadas por la IA. Cada mañana, para cada cliente activo que aceptó
 * la personalización, elige 1 a 5 locales combinando lo que le gusta (categorías, favoritos, locales
 * que no conoce) con la equidad del flujo: los locales con menos tráfico que sus competidores reciben
 * más ofertas (cupo por local) y en sus horas flojas, así el público se reparte en el día y entre
 * todos. Al comprar en el local dentro de la franja, los puntos extra se acreditan solos.
 */
@Injectable()
export class OfertasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OfertasIA');
  private reloj?: NodeJS.Timeout;
  private generando = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly rt: RealtimeService,
    private readonly equidad: EquidadService,
    private readonly fidelizacion: FidelizacionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    this.bus.on('compra.registrada', (e) => this.canjear(e.recintoId, e.clienteId, e.localId, e.transaccionId, e.puntos).then(() => undefined));
    if (process.env.OFERTAS_AUTOMATICAS === 'false') return;
    const revisar = () => void this.generarSiToca().catch((e) => this.log.warn(e.message));
    this.reloj = setInterval(revisar, 10 * 60_000);
    setTimeout(revisar, 8000);
  }

  onModuleDestroy() {
    clearInterval(this.reloj);
  }

  async ajustes(recintoId: string, q: Queryable = this.db): Promise<AjustesIa> {
    await q.query('insert into ajuste_ia (recinto_id) values ($1) on conflict do nothing', [recintoId]);
    const a = await one<any>(q, 'select *, ultima_generacion::text as ultima_generacion from ajuste_ia where recinto_id = $1', [recintoId]);
    return { ...a, multiplicador_max: Number(a.multiplicador_max), peso_equidad: Number(a.peso_equidad) };
  }

  async guardarAjustes(s: Sesion, d: Partial<Omit<AjustesIa, 'ultima_generacion'>>) {
    const antes = await this.ajustes(s.recintoId);
    const a = await one(
      this.db,
      `update ajuste_ia set ofertas_activas = coalesce($2, ofertas_activas), ofertas_por_cliente = coalesce($3, ofertas_por_cliente),
         multiplicador_max = coalesce($4, multiplicador_max), peso_equidad = coalesce($5, peso_equidad), hora_generacion = coalesce($6, hora_generacion),
         actualizado_por = $7, actualizado_en = now() where recinto_id = $1 returning *`,
      [s.recintoId, d.ofertas_activas ?? null, d.ofertas_por_cliente ?? null, d.multiplicador_max ?? null, d.peso_equidad ?? null, d.hora_generacion ?? null, s.sub],
    );
    await this.auditoria.registrar(this.db, s.sub, 'ajustar_ia', 'ajuste_ia', s.recintoId, antes, a);
    return a;
  }

  private async generarSiToca() {
    const r = await one<{ id: string }>(this.db, 'select id from recinto order by nombre limit 1');
    if (!r) return;
    const a = await this.ajustes(r.id);
    const { fecha, hhmm } = ahoraBolivia();
    if (!a.ofertas_activas || a.ultima_generacion === fecha || Number(hhmm.slice(0, 2)) < a.hora_generacion) return;
    await this.generarDia(r.id, fecha);
  }

  /**
   * Genera las ofertas de un día. `notificar` avisa a cada cliente (en el seed histórico se omite).
   * Si ya había ofertas ese día y `forzar` es true, se reemplazan las que aún no se usaron.
   */
  async generarDia(recintoId: string, fecha: string, op: { forzar?: boolean; notificar?: boolean } = {}) {
    if (this.generando) return { fecha, generadas: 0, clientes: 0, mensaje: 'Ya se están generando' };
    this.generando = true;
    const t0 = Date.now();
    try {
      const aj = await this.ajustes(recintoId);
      const existentes = await one<{ n: number }>(this.db, 'select count(*)::int as n from oferta_personal where recinto_id = $1 and fecha = $2', [recintoId, fecha]);
      if (existentes!.n && !op.forzar) return { fecha, generadas: 0, clientes: 0, mensaje: 'Las ofertas de ese día ya existen' };
      if (op.forzar) await this.db.query(`delete from oferta_personal where recinto_id = $1 and fecha = $2 and estado = 'activa'`, [recintoId, fecha]);

      const dow = new Date(`${fecha}T12:00:00Z`).getUTCDay();
      this.equidad.invalidar(recintoId);
      const locales = (await this.equidad.estado(recintoId)).filter((l) => l.dias_atencion.includes(dow));
      const flojas = await this.horasFlojasTodos(recintoId);
      const clientes = await this.clientesActivos(recintoId);
      if (!clientes.length || !locales.length) return { fecha, generadas: 0, clientes: 0, mensaje: 'No hay clientes o locales para generar' };

      // Cupo por local: los que necesitan más gente reciben más ofertas, nadie se queda sin ninguna
      const objetivo = clientes.length * aj.ofertas_por_cliente;
      const sumaPesos = locales.reduce((a, l) => a + (0.4 + l.equidad), 0);
      const cupo = new Map(locales.map((l) => [l.id, Math.max(3, Math.ceil(((0.4 + l.equidad) / sumaPesos) * objetivo * 1.15))]));
      const usados = new Map<string, number>();
      const rnd = azar(`${recintoId}${fecha}`);
      const w = aj.peso_equidad;
      const filas: unknown[][] = [];
      const porCliente = new Map<string, { local: string; m: number; desde: number; hasta: number }[]>();

      for (const c of [...clientes].sort(() => rnd() - 0.5)) {
        const puntuados = locales
          .filter((l) => (usados.get(l.id) ?? 0) < cupo.get(l.id)!)
          .map((l) => {
            const afin = c.afinidad[l.categoria] ?? 0;
            const conoce = c.conocidos.has(l.id);
            const favorito = c.favoritos.has(l.id);
            const gusto = 0.55 * afin + 0.2 * (favorito ? 1 : 0) + 0.25 * (conoce ? 0.3 : 1);
            return { l, afin, conoce, favorito, p: (1 - w) * gusto + w * l.equidad + rnd() * 0.08 };
          })
          .sort((a, b) => b.p - a.p);
        const elegidos: typeof puntuados = [];
        for (const x of puntuados) {
          if (elegidos.some((e) => e.l.categoria === x.l.categoria)) continue;
          elegidos.push(x);
          if (elegidos.length >= aj.ofertas_por_cliente) break;
        }
        for (const e of elegidos) {
          usados.set(e.l.id, (usados.get(e.l.id) ?? 0) + 1);
          const ventanas = flojas.get(e.l.id) ?? [];
          const habitual = c.hora ?? 16;
          const v = [...ventanas].sort((a, b) => Math.abs(a.desde + 1 - habitual) - Math.abs(b.desde + 1 - habitual))[0] ?? { desde: Math.max(Number(e.l.horario_apertura.slice(0, 2)) + 1, 15), hasta: Math.max(Number(e.l.horario_apertura.slice(0, 2)) + 1, 15) + 2 };
          const m = Math.min(aj.multiplicador_max, e.l.equidad >= 0.62 ? 3 : 2);
          const motivo = this.motivo(e, c.nombre, v);
          filas.push([recintoId, c.id, e.l.id, fecha, `Puntos ×${m} en ${e.l.nombre}`, motivo, m, hh(v.desde), hh(v.hasta), Math.round(e.p * 1000) / 1000, e.l.equidad]);
          porCliente.set(c.id, [...(porCliente.get(c.id) ?? []), { local: e.l.nombre, m, desde: v.desde, hasta: v.hasta }]);
        }
      }

      await this.db.tx(async (q) => {
        for (let i = 0; i < filas.length; i += 800) {
          const lote = filas.slice(i, i + 800);
          const p: unknown[] = [];
          const v = lote.map((f, k) => {
            p.push(...f);
            return `(${f.map((_, j) => `$${k * f.length + j + 1}`).join(',')})`;
          });
          await q.query(
            `insert into oferta_personal (recinto_id, cliente_id, local_id, fecha, titulo, motivo, multiplicador, hora_inicio, hora_fin, puntaje, equidad)
             values ${v.join(',')} on conflict (cliente_id, local_id, fecha) do nothing`,
            p,
          );
        }
        await q.query(`update oferta_personal set estado = 'vencida' where recinto_id = $1 and fecha < $2 and estado = 'activa'`, [recintoId, fecha]);
        await q.query(
          `insert into exposicion_local (recinto_id, local_id, cliente_id, fuente, creado_en)
           select recinto_id, local_id, cliente_id, 'oferta', ($2::date + time '06:00') + interval '4 hours' from oferta_personal where recinto_id = $1 and fecha = $2`,
          [recintoId, fecha],
        );
        if (op.notificar !== false) {
          const notifs = [...porCliente].map(([cid, os]) => [
            cid, 'ofertas', 'Tus ofertas de hoy',
            os.map((o) => `×${o.m} en ${o.local} de ${hh(o.desde)} a ${hh(o.hasta)}`).join(' · '), JSON.stringify({ fecha }),
          ]);
          for (let i = 0; i < notifs.length; i += 1000) {
            const lote = notifs.slice(i, i + 1000);
            const p: unknown[] = [];
            const v = lote.map((f, k) => {
              p.push(...f);
              return `($${k * 5 + 1},$${k * 5 + 2},$${k * 5 + 3},$${k * 5 + 4},$${k * 5 + 5})`;
            });
            await q.query(`insert into notificacion (usuario_id, tipo, titulo, cuerpo, datos) values ${v.join(',')}`, p);
          }
        }
        await q.query('update ajuste_ia set ultima_generacion = greatest(coalesce(ultima_generacion, $2::date), $2::date) where recinto_id = $1', [recintoId, fecha]);
      });
      if (op.notificar !== false) for (const cid of porCliente.keys()) this.rt.aUsuario(cid, 'ofertas', { fecha });
      this.equidad.invalidar(recintoId);
      const resultado = { fecha, generadas: filas.length, clientes: porCliente.size, locales: usados.size, segundos: Math.round((Date.now() - t0) / 100) / 10 };
      this.log.log(`ofertas del ${fecha}: ${resultado.generadas} para ${resultado.clientes} clientes en ${resultado.locales} locales (${resultado.segundos} s)`);
      return resultado;
    } finally {
      this.generando = false;
    }
  }

  private motivo(e: { l: EstadoLocal; afin: number; conoce: boolean; favorito: boolean }, nombre: string, v: { desde: number; hasta: number }) {
    const franja = `de ${hh(v.desde)} a ${hh(v.hasta)}`;
    const cat = NOMBRE_CATEGORIA[e.l.categoria] ?? e.l.categoria.toLowerCase();
    if (e.favorito) return `${nombre}, vuelve a ${e.l.nombre}, uno de tus favoritos: ${franja} tus puntos valen más.`;
    if (!e.conoce && e.afin >= 0.4) return `Como te gusta ${cat}, te invitamos a conocer ${e.l.nombre}: ${franja} ganas puntos extra.`;
    if (!e.conoce) return `Descubre ${e.l.nombre}, todavía no lo conoces: ${franja} tus compras suman puntos extra.`;
    if (e.afin >= 0.4) return `Para ti que disfrutas ${cat}: ${franja} en ${e.l.nombre} tus puntos se multiplican.`;
    return `${franja} en ${e.l.nombre} hay menos gente y tus puntos se multiplican.`.replace(/^de/, 'De');
  }

  /** Ventanas de 2 horas con menos ventas de cada local (28 días), dentro de su horario. */
  private async horasFlojasTodos(recintoId: string) {
    const filas = await many<any>(
      this.db,
      `select l.id, l.horario_apertura::text as a, l.horario_cierre::text as c, extract(hour from bo(t.creado_en))::int as hora, count(t.id)::float8 / 4 as n
       from local l left join transaccion t on t.local_id = l.id and t.estado = 'valida' and t.creado_en > now() - interval '28 days'
       where l.recinto_id = $1 and l.activo group by l.id, 4`,
      [recintoId],
    );
    const porLocal = new Map<string, { a: number; c: number; horas: Map<number, number> }>();
    for (const f of filas) {
      const x = porLocal.get(f.id) ?? { a: Number(f.a.slice(0, 2)), c: Math.min(22, Number(f.c.slice(0, 2))), horas: new Map() };
      if (f.hora !== null) x.horas.set(f.hora, Number(f.n));
      porLocal.set(f.id, x);
    }
    const r = new Map<string, { desde: number; hasta: number }[]>();
    for (const [id, x] of porLocal) {
      const vs: { desde: number; hasta: number; n: number }[] = [];
      for (let h = Math.max(x.a + 1, 10); h + 2 <= x.c; h++) vs.push({ desde: h, hasta: h + 2, n: (x.horas.get(h) ?? 0) + (x.horas.get(h + 1) ?? 0) });
      r.set(id, vs.sort((a, b) => a.n - b.n).slice(0, 3));
    }
    return r;
  }

  /** Clientes activos con consentimiento de personalización, con su perfil resumido (en pocas consultas). */
  private async clientesActivos(recintoId: string) {
    const base = await many<any>(
      this.db,
      `select u.id, split_part(u.nombre, ' ', 1) as nombre, p.intereses
       from usuario u join cliente_perfil p on p.usuario_id = u.id
       where u.recinto_id = $1 and u.rol = 'cliente' and u.estado = 'activo' and p.consent_personalizacion
         and (exists (select 1 from visita v where v.cliente_id = u.id and v.entrada_en > now() - interval '60 days') or u.creado_en > now() - interval '30 days')`,
      [recintoId],
    );
    const ids = base.map((b) => b.id);
    const afin = await many<any>(
      this.db,
      `select t.cliente_id, coalesce(t.categoria, 'Comida') as categoria, count(*)::int as n from transaccion t
       where t.cliente_id = any($1::uuid[]) and t.estado = 'valida' and t.creado_en > now() - interval '120 days' group by 1, 2`,
      [ids],
    );
    const conocidos = await many<any>(this.db, `select distinct cliente_id, local_id from transaccion where cliente_id = any($1::uuid[]) union select distinct cliente_id, local_id from checkin_local where cliente_id = any($1::uuid[])`, [ids]);
    const favoritos = await many<any>(this.db, `select cliente_id, local_id from favorito where cliente_id = any($1::uuid[]) and local_id is not null`, [ids]);
    const horas = await many<any>(
      this.db,
      `select cliente_id, mode() within group (order by extract(hour from bo(entrada_en))::int) as hora from visita
       where cliente_id = any($1::uuid[]) and entrada_en > now() - interval '90 days' group by 1`,
      [ids],
    );
    const porCliente = new Map(base.map((b) => [b.id, { id: b.id as string, nombre: b.nombre as string, afinidad: {} as Record<string, number>, conocidos: new Set<string>(), favoritos: new Set<string>(), hora: null as number | null, intereses: b.intereses as string[] }]));
    const maximos = new Map<string, number>();
    for (const a of afin) maximos.set(a.cliente_id, Math.max(maximos.get(a.cliente_id) ?? 1, a.n));
    for (const a of afin) porCliente.get(a.cliente_id)!.afinidad[a.categoria] = (0.7 * a.n) / maximos.get(a.cliente_id)!;
    for (const c of porCliente.values()) for (const i of c.intereses ?? []) c.afinidad[i] = Math.min(1, (c.afinidad[i] ?? 0) + 0.3);
    for (const k of conocidos) porCliente.get(k.cliente_id)?.conocidos.add(k.local_id);
    for (const f of favoritos) porCliente.get(f.cliente_id)?.favoritos.add(f.local_id);
    for (const h of horas) {
      const c = porCliente.get(h.cliente_id);
      if (c) c.hora = h.hora;
    }
    return [...porCliente.values()];
  }

  /** Canje automático: compra en el local de una oferta activa, dentro de su franja → puntos extra. */
  async canjear(recintoId: string, clienteId: string, localId: string, transaccionId: string, puntos: number) {
    const { fecha, hhmm } = ahoraBolivia();
    await this.db.tx(async (q) => {
      const o = await one<any>(
        q,
        `select o.id, o.multiplicador, l.nombre from oferta_personal o join local l on l.id = o.local_id
         where o.cliente_id = $1 and o.local_id = $2 and o.fecha = $3::date and o.estado = 'activa' and $4::time between o.hora_inicio and o.hora_fin
         for update of o`,
        [clienteId, localId, fecha, hhmm],
      );
      if (!o) return;
      const bono = Math.max(1, Math.floor(puntos * (Number(o.multiplicador) - 1)));
      await q.query(`update oferta_personal set estado = 'usada', usada_en = now(), transaccion_id = $2, puntos_bono = $3 where id = $1`, [o.id, transaccionId, bono]);
      await this.fidelizacion.acreditar(q, { recintoId, clienteId, tipo: 'bono', puntos: bono, referenciaId: o.id, localId, descripcion: `Oferta personal ×${Number(o.multiplicador)} en ${o.nombre}` });
    });
  }

  // ------------------------------------------------------------------ consultas

  delCliente(clienteId: string) {
    const { fecha, hhmm } = ahoraBolivia();
    return many(
      this.db,
      `select o.id, o.titulo, o.motivo, o.multiplicador, o.hora_inicio::text, o.hora_fin::text, o.estado, o.puntos_bono,
              l.id as local_id, l.nombre as local, l.piso, l.numero_local, c.nombre as categoria,
              ($2::time between o.hora_inicio and o.hora_fin) as ahora, ($2::time > o.hora_fin) as paso
       from oferta_personal o join local l on l.id = o.local_id join categoria c on c.id = l.categoria_id
       where o.cliente_id = $1 and o.fecha = $3::date order by o.hora_inicio`,
      [clienteId, hhmm, fecha],
    );
  }

  async delLocal(localId: string) {
    const { fecha } = ahoraBolivia();
    const hoy = await one<any>(
      this.db,
      `select count(*)::int as ofertas, count(*) filter (where estado = 'usada')::int as usadas,
              min(hora_inicio)::text as desde, max(hora_fin)::text as hasta
       from oferta_personal where local_id = $1 and fecha = $2::date`,
      [localId, fecha],
    );
    const serie = await many(
      this.db,
      `select fecha::text, count(*)::int as ofertas, count(*) filter (where estado = 'usada')::int as usadas, coalesce(sum(t.monto_bs), 0)::float8 as ventas_bs
       from oferta_personal o left join transaccion t on t.id = o.transaccion_id
       where o.local_id = $1 and o.fecha > current_date - 14 group by fecha order by fecha`,
      [localId],
    );
    return { hoy, serie };
  }

  async resumen(recintoId: string) {
    const { fecha } = ahoraBolivia();
    const aj = await this.ajustes(recintoId);
    const hoy = await one<any>(
      this.db,
      `select count(*)::int as ofertas, count(distinct cliente_id)::int as clientes, count(distinct local_id)::int as locales,
              count(*) filter (where estado = 'usada')::int as usadas, coalesce(sum(puntos_bono), 0)::int as puntos_bono
       from oferta_personal where recinto_id = $1 and fecha = $2::date`,
      [recintoId, fecha],
    );
    const serie = await many(
      this.db,
      `select fecha::text, count(*)::int as ofertas, count(*) filter (where estado = 'usada')::int as usadas, coalesce(sum(puntos_bono), 0)::int as puntos_bono
       from oferta_personal where recinto_id = $1 and fecha > $2::date - 14 group by fecha order by fecha`,
      [recintoId, fecha],
    );
    const porLocal = await many(
      this.db,
      `select l.nombre as local, c.nombre as categoria, count(*)::int as ofertas, count(*) filter (where o.estado = 'usada')::int as usadas,
              round(100.0 * count(*) filter (where o.estado = 'usada') / greatest(count(*), 1), 1)::float8 as tasa, round(avg(o.equidad)::numeric, 2)::float8 as equidad
       from oferta_personal o join local l on l.id = o.local_id join categoria c on c.id = l.categoria_id
       where o.recinto_id = $1 and o.fecha > $2::date - 7 group by l.id, c.nombre order by ofertas desc`,
      [recintoId, fecha],
    );
    const ejemplo = await many(
      this.db,
      `select o.titulo, o.motivo, o.hora_inicio::text, o.hora_fin::text, o.estado from oferta_personal o where o.recinto_id = $1 and o.fecha = $2::date order by o.puntaje desc limit 5`,
      [recintoId, fecha],
    );
    return { fecha, ajustes: aj, hoy, serie, porLocal, ejemplo };
  }
}
