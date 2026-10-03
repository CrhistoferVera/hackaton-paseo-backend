import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { codigoLegible } from '../../common/util.js';
import { firmaCorta } from '../../common/auth/tokens.js';
import { AuditoriaService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { FraudeService } from '../confianza/fraude.service.js';
import { enmascararNombre } from '../identidad/identidad.service.js';

const MINUTOS_CUPON = 15;

export interface DatosRecompensa {
  nombre: string;
  descripcion?: string;
  costoPuntos: number;
  localId?: string | null;
  stock?: number | null;
  temporada?: string | null;
  vigenciaDesde?: string | null;
  vigenciaHasta?: string | null;
  activo?: boolean;
}

/**
 * Catálogo y canjes (HU-C07, HU-C08, HU-L04, HU-A04). Al emitir un cupón los puntos quedan
 * reservados; se descuentan recién cuando el local lo valida. Si vence, no se descuenta nada.
 */
@Injectable()
export class RecompensasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Recompensas');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly fraude: FraudeService,
    private readonly telemetria: TelemetriaService,
    private readonly auditoria: AuditoriaService,
    private readonly rt: RealtimeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.vencerCupones().catch((e) => this.log.error(e)), 60_000);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async vencerCupones() {
    const vencidos = await many<{ id: string; cliente_id: string }>(
      this.db,
      `update canje set estado = 'vencido' where estado = 'emitido' and expira_en <= now() returning id, cliente_id`,
    );
    for (const v of vencidos) this.rt.aUsuario(v.cliente_id, 'canje', { id: v.id, estado: 'vencido' });
  }

  /** HU-C07: catálogo ordenado por «puedes canjear ahora» y luego por costo. */
  async catalogo(recintoId: string, clienteId: string | null) {
    const disp = clienteId ? (await this.fidelizacion.disponible(this.db, clienteId)).disponible : null;
    const filas = await many<any>(
      this.db,
      `select r.*, l.nombre as local, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y
       from recompensa r left join local l on l.id = r.local_id
       where r.recinto_id = $1 and r.activo and (r.stock is null or r.stock > 0)
         and (r.vigencia_desde is null or r.vigencia_desde <= current_date)
         and (r.vigencia_hasta is null or r.vigencia_hasta >= current_date)
       order by r.costo_puntos`,
      [recintoId],
    );
    const lista = filas.map((r) => ({
      ...r,
      puedeCanjear: disp === null ? null : disp >= r.costo_puntos,
      faltan: disp === null ? null : Math.max(0, r.costo_puntos - disp),
    }));
    if (disp !== null) lista.sort((a, b) => Number(b.puedeCanjear) - Number(a.puedeCanjear) || a.costo_puntos - b.costo_puntos);
    if (clienteId) await this.telemetria.registrarSuelto({ recintoId, clienteId, tipo: 'catalogo.visto', payload: { items: lista.length } });
    return { disponible: disp, recompensas: lista };
  }

  /** HU-C08: emite el cupón con QR de un solo uso válido 15 minutos. */
  async canjear(recintoId: string, clienteId: string, recompensaId: string) {
    const r = await this.db.tx(async (q) => {
      const rec = await one<any>(q, 'select * from recompensa where id = $1 and recinto_id = $2 and activo for update', [recompensaId, recintoId]);
      if (!rec) throw new NotFoundException('La recompensa no existe o ya no está disponible');
      if (rec.stock !== null && rec.stock <= 0) throw new BadRequestException('Se agotó esta recompensa');
      await q.query('select id from usuario where id = $1 for update', [clienteId]);
      const { disponible } = await this.fidelizacion.disponible(q, clienteId);
      if (disponible < rec.costo_puntos) throw new BadRequestException(`Te faltan ${rec.costo_puntos - disponible} puntos para esta recompensa`);
      const base = codigoLegible(10);
      const c = await one<any>(
        q,
        `insert into canje (cliente_id, recompensa_id, codigo, costo_puntos, estado, expira_en)
         values ($1,$2,$3,$4,'emitido', now() + interval '${MINUTOS_CUPON} minutes') returning *`,
        [clienteId, recompensaId, `${base}.${firmaCorta(base)}`, rec.costo_puntos],
      );
      await this.fraude.evaluarCanje(q, recintoId, clienteId, c.id, rec.costo_puntos);
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'cupon.emitido', localId: rec.local_id, payload: { recompensa: rec.nombre, costo: rec.costo_puntos } });
      return { ...c, qr: `PPC:${c.codigo}`, recompensa: rec.nombre };
    });
    this.rt.aUsuario(clienteId, 'puntos', { tipo: 'reserva' });
    return r;
  }

  misCanjes(clienteId: string) {
    return many(
      this.db,
      `select c.*, 'PPC:' || c.codigo as qr, r.nombre as recompensa, r.descripcion, l.nombre as local, l.piso, l.sector, l.numero_local,
              lv.nombre as local_validador
       from canje c join recompensa r on r.id = c.recompensa_id left join local l on l.id = r.local_id left join local lv on lv.id = c.validado_local
       where c.cliente_id = $1 order by c.emitido_en desc limit 50`,
      [clienteId],
    );
  }

  private leerCodigo(codigo: string) {
    const c = codigo.trim().replace(/^PPC:/, '');
    const [base, firma] = c.split('.');
    if (!base || !firma || firmaCorta(base) !== firma) throw new BadRequestException('El código no es un cupón válido de Paseo Points');
    return c;
  }

  /** HU-L04: el local consulta el cupón antes de entregar. */
  async consultarCupon(s: Sesion, codigo: string) {
    const cod = this.leerCodigo(codigo);
    const c = await one<any>(
      this.db,
      `select c.*, r.nombre as recompensa, r.descripcion, r.local_id, l.nombre as local_recompensa, u.nombre as cliente, lv.nombre as local_validador
       from canje c join recompensa r on r.id = c.recompensa_id left join local l on l.id = r.local_id join usuario u on u.id = c.cliente_id
       left join local lv on lv.id = c.validado_local where c.codigo = $1`,
      [cod],
    );
    if (!c) throw new NotFoundException('Cupón no encontrado');
    const vencido = c.estado === 'vencido' || (c.estado === 'emitido' && new Date(c.expira_en) <= new Date());
    let motivo: string | null = null;
    if (c.estado === 'validado') motivo = `Ya fue usado el ${new Date(c.validado_en).toLocaleString('es-BO', { timeZone: 'America/La_Paz' })} en ${c.local_validador}`;
    else if (vencido) motivo = `Venció el ${new Date(c.expira_en).toLocaleString('es-BO', { timeZone: 'America/La_Paz' })}`;
    else if (c.local_id && c.local_id !== s.localId) motivo = `Este cupón se canjea en ${c.local_recompensa}`;
    return {
      codigo: c.codigo,
      recompensa: c.recompensa,
      descripcion: c.descripcion,
      costoPuntos: c.costo_puntos,
      cliente: enmascararNombre(c.cliente),
      estado: vencido && c.estado === 'emitido' ? 'vencido' : c.estado,
      expiraEn: c.expira_en,
      valido: !motivo,
      motivo,
    };
  }

  /** Valida y entrega: convierte la reserva en débito en una sola transacción. */
  async entregarCupon(s: Sesion, codigo: string) {
    const cod = this.leerCodigo(codigo);
    const r = await this.db.tx(async (q) => {
      const c = await one<any>(q, `select c.*, r.local_id, r.stock, r.nombre from canje c join recompensa r on r.id = c.recompensa_id where c.codigo = $1 for update of c`, [cod]);
      if (!c) throw new NotFoundException('Cupón no encontrado');
      if (c.estado === 'validado') throw new BadRequestException('Este cupón ya fue usado');
      if (c.estado === 'vencido' || new Date(c.expira_en) <= new Date()) {
        await q.query(`update canje set estado = 'vencido' where id = $1`, [c.id]);
        throw new BadRequestException('El cupón venció; el cliente no perdió puntos');
      }
      if (c.local_id && c.local_id !== s.localId) throw new ForbiddenException('Este cupón corresponde a otro local');
      await this.fidelizacion.debitar(
        q,
        { recintoId: s.recintoId, clienteId: c.cliente_id, tipo: 'canje', puntos: c.costo_puntos, referenciaId: c.id, localId: s.localId, descripcion: `Canje: ${c.nombre}` },
        { ignorarReservaDe: c.costo_puntos },
      );
      if (c.stock !== null) await q.query('update recompensa set stock = stock - 1 where id = $1 and stock > 0', [c.recompensa_id]);
      const v = await one(q, `update canje set estado = 'validado', validado_por = $2, validado_local = $3, validado_en = now() where id = $1 returning *`, [c.id, s.sub, s.localId]);
      await this.telemetria.registrar(q, { recintoId: s.recintoId, clienteId: c.cliente_id, tipo: 'cupon.validado', localId: s.localId, payload: { recompensa: c.nombre, costo: c.costo_puntos } });
      return { ...v, recompensa: c.nombre };
    });
    this.rt.aUsuario(r.cliente_id, 'canje', { id: r.id, estado: 'validado', recompensa: r.recompensa });
    this.rt.aSala(s.recintoId, 'canje', { localId: s.localId, puntos: r.costo_puntos });
    return r;
  }

  // ------------------------------------------------------------------ HU-A04 gestión del catálogo
  listarAdmin(recintoId: string) {
    return many(
      this.db,
      `select r.*, l.nombre as local,
              (select count(*)::int from canje c where c.recompensa_id = r.id and c.estado = 'validado') as canjes
       from recompensa r left join local l on l.id = r.local_id where r.recinto_id = $1 order by r.activo desc, r.costo_puntos`,
      [recintoId],
    );
  }

  async crear(s: Sesion, d: DatosRecompensa) {
    return this.db.tx(async (q) => {
      const r = await one(
        q,
        `insert into recompensa (recinto_id, nombre, descripcion, costo_puntos, local_id, stock, temporada, vigencia_desde, vigencia_hasta, activo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [s.recintoId, d.nombre, d.descripcion ?? '', d.costoPuntos, d.localId ?? null, d.stock ?? null, d.temporada ?? null, d.vigenciaDesde ?? null, d.vigenciaHasta ?? null, d.activo ?? true],
      );
      await this.auditoria.registrar(q, s.sub, 'crear_recompensa', 'recompensa', r.id, null, r);
      return r;
    });
  }

  async actualizar(s: Sesion, id: string, d: Partial<DatosRecompensa>) {
    return this.db.tx(async (q) => {
      const antes = await one(q, 'select * from recompensa where id = $1 and recinto_id = $2', [id, s.recintoId]);
      if (!antes) throw new NotFoundException('Recompensa no encontrada');
      const r = await one(
        q,
        `update recompensa set nombre = coalesce($2,nombre), descripcion = coalesce($3,descripcion), costo_puntos = coalesce($4,costo_puntos),
           local_id = case when $5::boolean then $6::uuid else local_id end, stock = case when $7::boolean then $8::int else stock end,
           temporada = coalesce($9,temporada), vigencia_desde = coalesce($10::date,vigencia_desde), vigencia_hasta = coalesce($11::date,vigencia_hasta),
           activo = coalesce($12,activo)
         where id = $1 returning *`,
        [
          id, d.nombre ?? null, d.descripcion ?? null, d.costoPuntos ?? null, d.localId !== undefined, d.localId ?? null,
          d.stock !== undefined, d.stock ?? null, d.temporada ?? null, d.vigenciaDesde ?? null, d.vigenciaHasta ?? null, d.activo ?? null,
        ],
      );
      await this.auditoria.registrar(q, s.sub, 'actualizar_recompensa', 'recompensa', id, antes, r);
      return r;
    });
  }
}
