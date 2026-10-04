import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { AuditoriaService, NotificacionesService } from '../nucleo/nucleo.services.js';
import { DropsService } from './drops.service.js';
import { EventBus } from '../nucleo/event-bus.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';

export interface DatosActividad {
  titulo: string;
  descripcion?: string;
  tipo: string;
  inicio: string;
  fin: string;
  zonaId?: string | null;
  lugar?: string;
  precioBs?: number | null;
  cupos?: number | null;
  puntos?: number;
}

export interface DatosSolicitudDrop {
  productoId: string;
  precioEspecial: number;
  mensaje: string;
  zonaId?: string | null;
  fechaDeseada?: string | null;
  minutos?: number;
  maxReclamos?: number;
}

/**
 * Eventos del Paseo (conciertos, ferias, talleres…) y solicitudes de Drop de los comercios.
 * Un comercio propone; administración o marketing aprueba. Así la app y Jarvis solo muestran lo aprobado.
 */
@Injectable()
export class EventosService implements OnModuleInit {
  private readonly log = new Logger('Eventos');

  constructor(
    private readonly db: Db,
    private readonly notif: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly drops: DropsService,
    private readonly bus: EventBus,
    private readonly fidelizacion: FidelizacionService,
  ) {}

  /** Asistencia: escanear la puerta del local anfitrión o el QR del evento (`PPA:<id>`) mientras ocurre. */
  onModuleInit() {
    this.bus.on('checkin.registrado', (e) => this.registrarAsistencia(e.recintoId, e.clienteId, { localId: e.localId }).catch((x) => this.log.warn(x.message)));
  }

  /** Escaneo del QR del evento: registra la asistencia (y los puntos) si el evento está ocurriendo. */
  async asistirPorCodigo(recintoId: string, clienteId: string, codigo: string) {
    const m = /^PPA:([0-9a-f-]{36})$/i.exec(codigo.trim());
    if (!m) throw new BadRequestException('Ese QR no es de un evento del Paseo');
    const a = await one<any>(this.db, `select id, titulo, puntos, inicio, fin from actividad where id = $1 and recinto_id = $2 and estado = 'aprobada'`, [m[1], recintoId]);
    if (!a) throw new NotFoundException('Evento no encontrado');
    const ahora = Date.now();
    if (ahora < new Date(a.inicio).getTime() - 15 * 60_000) throw new BadRequestException(`${a.titulo} todavía no empieza: vuelve a escanear cuando comience`);
    if (ahora > new Date(a.fin).getTime()) throw new BadRequestException(`${a.titulo} ya terminó`);
    const ya = await one(this.db, 'select 1 from asistencia_actividad where actividad_id = $1 and cliente_id = $2', [a.id, clienteId]);
    if (ya) return { actividadId: a.id, titulo: a.titulo, puntos: 0, yaRegistrada: true };
    await this.registrarAsistencia(recintoId, clienteId, { actividadId: a.id });
    return { actividadId: a.id, titulo: a.titulo, puntos: a.puntos, yaRegistrada: false };
  }

  /** Cartel imprimible con el QR de asistencia del evento (`PPA:<id>`). */
  async qrPdf(recintoId: string, id: string, localId: string | null = null): Promise<Buffer> {
    const a = await one<any>(
      this.db,
      `select a.*, z.nombre as zona from actividad a left join zona z on z.id = a.zona_id where a.id = $1 and a.recinto_id = $2 and ($3::uuid is null or a.local_id = $3)`,
      [id, recintoId, localId],
    );
    if (!a) throw new NotFoundException('Evento no encontrado');
    const contenido = `PPA:${a.id}`;
    const png = await QRCode.toBuffer(contenido, { errorCorrectionLevel: 'M', width: 900, margin: 1, color: { dark: '#16140F', light: '#FFFFFF' } });
    const hora = (d: Date) => new Date(d).toLocaleString('es-BO', { timeZone: 'America/La_Paz', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return new Promise((resolve) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const partes: Buffer[] = [];
      doc.on('data', (b: Buffer) => partes.push(b));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      const ancho = doc.page.width;
      doc.rect(0, 0, ancho, 8).fill('#C99A3A');
      doc.fillColor('#8E6A1E').font('Helvetica-Bold').fontSize(9).text('PASEO POINTS · EVENTO', 40, 36, { characterSpacing: 2 });
      doc.fillColor('#16140F').font('Times-Roman').fontSize(24).text(a.titulo, 40, 56, { width: ancho - 80 });
      doc.fillColor('#5F594F').font('Helvetica').fontSize(10).text(`${hora(a.inicio)} · ${a.lugar ?? a.zona ?? ''}`, 40, doc.y + 6, { width: ancho - 80 });
      const lado = ancho - 140;
      const y = doc.y + 14;
      doc.image(png, 70, y, { width: lado, height: lado });
      doc.fillColor('#16140F').font('Helvetica-Bold').fontSize(13).text(a.puntos ? `Escanea y suma ${a.puntos} puntos por venir` : 'Escanea para registrar tu asistencia', 40, y + lado + 16, { align: 'center', width: ancho - 80 });
      doc.fillColor('#5F594F').font('Helvetica').fontSize(9).text('Abre la app Paseo Points y toca «Escanear». Vale mientras dura el evento, una vez por persona.', 40, doc.y + 4, { align: 'center', width: ancho - 80 });
      doc.fillColor('#9A9182').fontSize(7).text(contenido, 40, doc.page.height - 50, { align: 'center', width: ancho - 80 });
      doc.end();
    });
  }

  async registrarAsistencia(recintoId: string, clienteId: string, donde: { localId?: string; actividadId?: string }) {
    const evs = await many<any>(
      this.db,
      `select a.id, a.titulo, a.puntos from actividad a
       where a.recinto_id = $1 and a.estado = 'aprobada' and now() between a.inicio - interval '15 minutes' and a.fin
         and (a.local_id = $2::uuid or a.id = $3::uuid)
         and not exists (select 1 from asistencia_actividad x where x.actividad_id = a.id and x.cliente_id = $4)`,
      [recintoId, donde.localId ?? null, donde.actividadId ?? null, clienteId],
    );
    for (const ev of evs) {
      await this.db.tx(async (q) => {
        const r = await one(q, 'insert into asistencia_actividad (actividad_id, cliente_id, puntos) values ($1,$2,$3) on conflict do nothing returning actividad_id', [ev.id, clienteId, ev.puntos]);
        if (!r) return;
        if (ev.puntos > 0) {
          await this.fidelizacion.acreditar(q, { recintoId, clienteId, tipo: 'bono', puntos: ev.puntos, referenciaId: ev.id, descripcion: `Asististe a ${ev.titulo}` });
        }
        await this.notif.crear(q, clienteId, 'evento', `¡Gracias por venir a ${ev.titulo}!`, ev.puntos > 0 ? `Sumaste ${ev.puntos} puntos por asistir.` : 'Registramos tu asistencia.', { actividadId: ev.id });
      });
    }
  }

  // ------------------------------------------------------------------ eventos

  /** Eventos aprobados que no terminaron, del más próximo al más lejano. */
  proximos(recintoId: string, dias = 30) {
    return many(
      this.db,
      `select a.id, a.titulo, a.descripcion, a.tipo, a.inicio, a.fin, a.lugar, a.precio_bs, a.cupos, a.puntos,
              a.zona_id, z.nombre as zona, z.piso, a.local_id, l.nombre as local, (now() between a.inicio and a.fin) as en_curso
       from actividad a left join zona z on z.id = a.zona_id left join local l on l.id = a.local_id
       where a.recinto_id = $1 and a.estado = 'aprobada' and a.fin > now() and a.inicio < now() + ($2 || ' days')::interval
       order by a.inicio`,
      [recintoId, dias],
    );
  }

  todos(recintoId: string, estado?: string) {
    return many(
      this.db,
      `select a.*, z.nombre as zona, z.piso, l.nombre as local, u.nombre as creado_por_nombre
       from actividad a left join zona z on z.id = a.zona_id left join local l on l.id = a.local_id left join usuario u on u.id = a.creado_por
       where a.recinto_id = $1 and ($2::text is null or a.estado = $2)
       order by (a.estado = 'pendiente') desc, a.inicio desc limit 200`,
      [recintoId, estado ?? null],
    );
  }

  delLocal(localId: string) {
    return many(this.db, `select a.*, z.nombre as zona from actividad a left join zona z on z.id = a.zona_id where a.local_id = $1 order by a.inicio desc`, [localId]);
  }

  private async validarActividad(q: Queryable, recintoId: string, d: DatosActividad) {
    if (new Date(d.fin) <= new Date(d.inicio)) throw new BadRequestException('El evento debe terminar después de empezar');
    if (d.zonaId && !(await one(q, 'select 1 from zona where id = $1 and recinto_id = $2', [d.zonaId, recintoId]))) throw new NotFoundException('Zona no encontrada');
  }

  private insertarActividad(q: Queryable, s: Sesion, d: DatosActividad, localId: string | null, estado: string, lugar: string) {
    return one(
      q,
      `insert into actividad (recinto_id, titulo, descripcion, tipo, inicio, fin, zona_id, local_id, lugar, precio_bs, cupos, puntos, estado, creado_por, revisado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [s.recintoId, d.titulo, d.descripcion ?? '', d.tipo, d.inicio, d.fin, d.zonaId ?? null, localId, lugar, d.precioBs ?? null, d.cupos ?? null, d.puntos ?? 0,
        estado, s.sub, estado === 'aprobada' ? s.sub : null],
    );
  }

  /** El comercio propone un evento en su local o en una zona; queda pendiente. */
  async proponer(s: Sesion, d: DatosActividad) {
    if (!s.localId) throw new BadRequestException('Tu cuenta no está asignada a un comercio');
    return this.db.tx(async (q) => {
      await this.validarActividad(q, s.recintoId, d);
      const l = await one<any>(q, 'select nombre, numero_local, zona_id from local where id = $1', [s.localId]);
      const a = await this.insertarActividad(q, s, { ...d, zonaId: d.zonaId ?? l.zona_id, puntos: 0 }, s.localId!, 'pendiente', d.lugar?.trim() || `${l.nombre}, local ${l.numero_local}`);
      await this.avisarAdmins(q, s.recintoId, 'evento_pendiente', 'Evento por aprobar', `${l.nombre} propone «${d.titulo}»`, { actividadId: a.id });
      return a;
    });
  }

  async crearDeAdmin(s: Sesion, d: DatosActividad & { localId?: string | null }) {
    return this.db.tx(async (q) => {
      await this.validarActividad(q, s.recintoId, d);
      const z = d.zonaId ? await one<any>(q, 'select nombre from zona where id = $1', [d.zonaId]) : null;
      const a = await this.insertarActividad(q, s, d, d.localId ?? null, 'aprobada', d.lugar?.trim() || z?.nombre || 'Paseo Aranjuez');
      await this.auditoria.registrar(q, s.sub, 'crear_evento', 'actividad', a.id, null, a);
      return a;
    });
  }

  async revisarActividad(s: Sesion, id: string, estado: 'aprobada' | 'rechazada' | 'cancelada', comentario?: string, puntos?: number) {
    return this.db.tx(async (q) => {
      const antes = await one<any>(q, 'select * from actividad where id = $1 and recinto_id = $2 for update', [id, s.recintoId]);
      if (!antes) throw new NotFoundException('Evento no encontrado');
      if (estado !== 'aprobada' && !comentario?.trim()) throw new BadRequestException('Explica el motivo');
      const a = await one(q, 'update actividad set estado = $2, comentario = $3, revisado_por = $4, puntos = coalesce($5, puntos) where id = $1 returning *', [
        id, estado, comentario ?? null, s.sub, puntos ?? null,
      ]);
      await this.auditoria.registrar(q, s.sub, `evento_${estado}`, 'actividad', id, antes, a);
      if (antes.creado_por && antes.creado_por !== s.sub) {
        await this.notif.crear(q, antes.creado_por, 'evento_revisado', estado === 'aprobada' ? 'Evento aprobado' : `Evento ${estado}`,
          estado === 'aprobada' ? `«${antes.titulo}» ya aparece en la app y Jarvis lo recomienda` : `«${antes.titulo}»: ${comentario}`, { actividadId: id });
      }
      return a;
    });
  }

  /** El comercio retira su propuesta (pendiente) o cancela su evento aprobado. */
  async cancelarDeLocal(s: Sesion, id: string) {
    const a = await one<any>(this.db, 'select * from actividad where id = $1 and local_id = $2', [id, s.localId]);
    if (!a) throw new NotFoundException('Evento no encontrado');
    if (a.estado === 'pendiente') {
      await this.db.query('delete from actividad where id = $1', [id]);
      return { id, eliminado: true };
    }
    return one(this.db, `update actividad set estado = 'cancelada', comentario = 'Cancelado por el comercio' where id = $1 returning *`, [id]);
  }

  // ------------------------------------------------------------------ solicitudes de Drop

  async solicitarDrop(s: Sesion, d: DatosSolicitudDrop) {
    if (!s.localId) throw new BadRequestException('Tu cuenta no está asignada a un comercio');
    return this.db.tx(async (q) => {
      const p = await one<any>(q, 'select p.*, l.zona_id, l.nombre as local from producto p join local l on l.id = p.local_id where p.id = $1 and p.local_id = $2 and p.activo', [
        d.productoId, s.localId,
      ]);
      if (!p) throw new NotFoundException('Ese producto no es de tu comercio o está inactivo');
      if (d.precioEspecial >= Number(p.precio_bs)) throw new BadRequestException(`El precio del Drop debe ser menor a Bs ${Number(p.precio_bs).toFixed(2)}`);
      if (d.fechaDeseada && new Date(d.fechaDeseada).getTime() < Date.now() - 60_000) throw new BadRequestException('La fecha deseada ya pasó');
      const sol = await one<any>(
        q,
        `insert into solicitud_drop (recinto_id, local_id, producto_id, zona_id, precio_especial, mensaje, fecha_deseada, minutos, max_reclamos, creado_por)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [s.recintoId, s.localId, d.productoId, d.zonaId ?? p.zona_id, d.precioEspecial, d.mensaje, d.fechaDeseada ?? null, d.minutos ?? 60, d.maxReclamos ?? 50, s.sub],
      );
      await this.avisarAdmins(q, s.recintoId, 'drop_solicitado', 'Drop solicitado', `${p.local} pide un Drop de ${p.nombre} a Bs ${d.precioEspecial.toFixed(2)}`, { solicitudId: sol.id });
      return sol;
    });
  }

  solicitudesDelLocal(localId: string) {
    return many(
      this.db,
      `select s.*, p.nombre as producto, p.precio_bs, z.nombre as zona, z.piso,
              (select count(*)::int from reclamo_drop r where r.drop_id = s.drop_id) as reclamos
       from solicitud_drop s join producto p on p.id = s.producto_id left join zona z on z.id = s.zona_id
       where s.local_id = $1 order by s.creado_en desc`,
      [localId],
    );
  }

  solicitudes(recintoId: string, estado?: string) {
    return many(
      this.db,
      `select s.*, p.nombre as producto, p.precio_bs, p.stock, l.nombre as local, z.nombre as zona, z.piso
       from solicitud_drop s join producto p on p.id = s.producto_id join local l on l.id = s.local_id left join zona z on z.id = s.zona_id
       where s.recinto_id = $1 and ($2::text is null or s.estado = $2)
       order by (s.estado = 'pendiente') desc, s.creado_en desc limit 200`,
      [recintoId, estado ?? null],
    );
  }

  /** Aprobar = lanzar el Drop ahora con los datos pedidos (el admin puede ajustar zona y duración). */
  async lanzarSolicitud(s: Sesion, id: string, ajustes: { zonaId?: string; minutos?: number; maxReclamos?: number }) {
    const sol = await one<any>(this.db, 'select * from solicitud_drop where id = $1 and recinto_id = $2', [id, s.recintoId]);
    if (!sol) throw new NotFoundException('Solicitud no encontrada');
    if (sol.estado !== 'pendiente') throw new BadRequestException('La solicitud ya fue atendida');
    const zonaId = ajustes.zonaId ?? sol.zona_id;
    const drop = await this.drops.lanzarDrop(s, {
      zonaId, productoId: sol.producto_id, precioEspecial: Number(sol.precio_especial), mensaje: sol.mensaje,
      minutos: ajustes.minutos ?? sol.minutos, maxReclamos: ajustes.maxReclamos ?? sol.max_reclamos, localId: sol.local_id,
    });
    await this.db.tx(async (q) => {
      await q.query(`update solicitud_drop set estado = 'lanzada', drop_id = $2, revisado_por = $3 where id = $1`, [id, drop.id, s.sub]);
      await this.notif.crear(q, sol.creado_por, 'drop_lanzado', 'Tu Drop está activo', `${drop.producto} a Bs ${Number(sol.precio_especial).toFixed(2)} ya está en la app`, { dropId: drop.id });
    });
    return drop;
  }

  async rechazarSolicitud(s: Sesion, id: string, comentario: string) {
    if (!comentario?.trim()) throw new BadRequestException('Explica el motivo del rechazo');
    return this.db.tx(async (q) => {
      const sol = await one<any>(q, `update solicitud_drop set estado = 'rechazada', comentario = $3, revisado_por = $4 where id = $1 and recinto_id = $2 and estado = 'pendiente' returning *`, [
        id, s.recintoId, comentario, s.sub,
      ]);
      if (!sol) throw new NotFoundException('Solicitud no encontrada o ya atendida');
      await this.notif.crear(q, sol.creado_por, 'drop_rechazado', 'Drop no aprobado', comentario, { solicitudId: id });
      return sol;
    });
  }

  async cancelarSolicitud(s: Sesion, id: string) {
    const r = await one(this.db, `update solicitud_drop set estado = 'cancelada' where id = $1 and local_id = $2 and estado = 'pendiente' returning id`, [id, s.localId]);
    if (!r) throw new NotFoundException('Solo puedes cancelar solicitudes pendientes de tu comercio');
    return r;
  }

  private async avisarAdmins(q: Queryable, recintoId: string, tipo: string, titulo: string, cuerpo: string, datos: Record<string, unknown>) {
    const admins = await many<{ id: string }>(q, `select id from usuario where recinto_id = $1 and rol in ('admin','marketing') and estado = 'activo'`, [recintoId]);
    for (const a of admins) await this.notif.crear(q, a.id, tipo, titulo, cuerpo, datos);
  }
}
