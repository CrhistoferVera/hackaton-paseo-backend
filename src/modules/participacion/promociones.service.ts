import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia } from '../../common/util.js';
import { AuditoriaService, NotificacionesService } from '../nucleo/nucleo.services.js';

export interface DatosPromocion {
  titulo: string;
  tipo: 'puntos_dobles' | 'cupon';
  multiplicador?: number;
  descripcion?: string;
  segmentoId?: string | null;
  diasSemana?: number[];
  horaInicio?: string;
  horaFin?: string;
  inicio: string;
  fin: string;
}

/** Promociones de locales y del Paseo (HU-L11, HU-A06) y su aplicación al cotizar puntos. */
@Injectable()
export class PromocionesService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly notif: NotificacionesService,
  ) {}

  private condicionVigente(alias = 'p') {
    return `${alias}.estado = 'aprobada' and $FECHA::date between ${alias}.inicio and ${alias}.fin
      and $DIA = any(${alias}.dias_semana) and $HORA::time between ${alias}.hora_inicio and ${alias}.hora_fin`;
  }

  /** Mejor promoción de puntos dobles que aplica a esta compra (local o general, y segmento del cliente). */
  async mejorPara(q: Queryable, recintoId: string, localId: string, clienteId: string, en: Date) {
    const { fecha, dia, hhmm } = ahoraBolivia(en);
    const p = await one<{ id: string; titulo: string; multiplicador: number }>(
      q,
      `select p.id, p.titulo, p.multiplicador from promocion p
       left join segmento s on s.id = p.segmento_id
       where p.recinto_id = $1 and (p.local_id = $2 or p.local_id is null) and p.tipo = 'puntos_dobles'
         and ${this.condicionVigente().replace('$FECHA', '$4').replace('$DIA', '$5').replace('$HORA', '$6')}
         and (p.segmento_id is null or $3 = any(s.cliente_ids))
       order by p.multiplicador desc limit 1`,
      [recintoId, localId, clienteId, fecha, dia, hhmm],
    );
    return p ? { ...p, multiplicador: Number(p.multiplicador) } : null;
  }

  /** Promociones vigentes que puede ver un cliente (por segmento) o cualquiera si clienteId es null. */
  async vigentes(recintoId: string, clienteId: string | null, en = new Date()) {
    const { fecha, dia, hhmm } = ahoraBolivia(en);
    return many(
      this.db,
      `select p.id, p.titulo, p.tipo, p.multiplicador, p.descripcion, p.hora_inicio, p.hora_fin, p.inicio, p.fin, p.dias_semana,
              l.id as local_id, l.nombre as local, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y,
              ($5::time between p.hora_inicio and p.hora_fin and $4 = any(p.dias_semana)) as activa_ahora
       from promocion p left join local l on l.id = p.local_id left join segmento s on s.id = p.segmento_id
       where p.recinto_id = $1 and p.estado = 'aprobada' and $3::date between p.inicio and p.fin
         and (p.segmento_id is null or $2::uuid is null or $2::uuid = any(s.cliente_ids))
       order by activa_ahora desc, p.multiplicador desc`,
      [recintoId, clienteId, fecha, dia, hhmm],
    );
  }

  private validar(d: DatosPromocion) {
    if (d.fin < d.inicio) throw new BadRequestException('La fecha de fin es anterior a la de inicio');
    if (d.tipo === 'puntos_dobles' && (d.multiplicador ?? 2) <= 1) throw new BadRequestException('El multiplicador debe ser mayor a 1');
  }

  /** HU-L11: el local crea una promoción; queda pendiente de aprobación. */
  async crearDeLocal(s: Sesion, d: DatosPromocion) {
    if (!s.localId) throw new BadRequestException('Tu usuario no está asignado a un local');
    this.validar(d);
    return this.db.tx(async (q) => {
      const p = await this.insertar(q, s, s.localId!, d, 'pendiente');
      const admins = await many<{ id: string }>(q, `select id from usuario where recinto_id = $1 and rol in ('admin','marketing') and estado = 'activo'`, [s.recintoId]);
      for (const a of admins) {
        await this.notif.crear(q, a.id, 'promocion_pendiente', 'Promoción por aprobar', `${p.titulo} espera tu revisión`, { promocionId: p.id });
      }
      return p;
    });
  }

  /** El administrador crea promociones generales del Paseo, aprobadas de inmediato. */
  async crearDeAdmin(s: Sesion, d: DatosPromocion & { localId?: string | null }) {
    this.validar(d);
    return this.db.tx(async (q) => {
      const p = await this.insertar(q, s, d.localId ?? null, d, 'aprobada');
      await this.auditoria.registrar(q, s.sub, 'crear_promocion', 'promocion', p.id, null, p);
      return p;
    });
  }

  private insertar(q: Queryable, s: Sesion, localId: string | null, d: DatosPromocion, estado: string) {
    return one(
      q,
      `insert into promocion (recinto_id, local_id, titulo, tipo, multiplicador, descripcion, segmento_id, dias_semana, hora_inicio, hora_fin, inicio, fin, estado, creado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [
        s.recintoId, localId, d.titulo, d.tipo, d.tipo === 'puntos_dobles' ? (d.multiplicador ?? 2) : 1, d.descripcion ?? '',
        d.segmentoId ?? null, d.diasSemana ?? [0, 1, 2, 3, 4, 5, 6], d.horaInicio ?? '00:00', d.horaFin ?? '23:59', d.inicio, d.fin, estado, s.sub,
      ],
    );
  }

  /** El comercio retira una promoción pendiente o termina hoy una aprobada. */
  async finalizarDeLocal(s: Sesion, id: string) {
    const p = await one<any>(this.db, 'select * from promocion where id = $1 and local_id = $2', [id, s.localId]);
    if (!p) throw new NotFoundException('Promoción no encontrada');
    if (p.estado !== 'aprobada') {
      await this.db.query('delete from promocion where id = $1', [id]);
      return { id, eliminada: true };
    }
    return one(this.db, `update promocion set fin = least(fin, (now() at time zone 'America/La_Paz')::date - 1) where id = $1 returning *`, [id]);
  }

  delLocal(localId: string) {
    return many(
      this.db,
      `select p.*, s.nombre as segmento from promocion p left join segmento s on s.id = p.segmento_id where p.local_id = $1 order by p.creado_en desc`,
      [localId],
    );
  }

  todas(recintoId: string, estado?: string) {
    return many(
      this.db,
      `select p.*, l.nombre as local, s.nombre as segmento, u.nombre as creado_por_nombre
       from promocion p left join local l on l.id = p.local_id left join segmento s on s.id = p.segmento_id left join usuario u on u.id = p.creado_por
       where p.recinto_id = $1 and ($2::text is null or p.estado = $2)
       order by (p.estado = 'pendiente') desc, p.creado_en desc`,
      [recintoId, estado ?? null],
    );
  }

  /** HU-A06: aprobar o rechazar con comentario. */
  async revisar(s: Sesion, id: string, estado: 'aprobada' | 'rechazada', comentario?: string) {
    return this.db.tx(async (q) => {
      const antes = await one<any>(q, 'select * from promocion where id = $1 and recinto_id = $2 for update', [id, s.recintoId]);
      if (!antes) throw new NotFoundException('Promoción no encontrada');
      if (estado === 'rechazada' && !comentario?.trim()) throw new BadRequestException('Explica el motivo del rechazo');
      const p = await one(q, 'update promocion set estado = $2, comentario = $3, revisado_por = $4 where id = $1 returning *', [id, estado, comentario ?? null, s.sub]);
      await this.auditoria.registrar(q, s.sub, `promocion_${estado}`, 'promocion', id, antes, p);
      if (antes.creado_por) {
        await this.notif.crear(
          q, antes.creado_por, 'promocion_revisada',
          estado === 'aprobada' ? 'Promoción aprobada' : 'Promoción rechazada',
          estado === 'aprobada' ? `${antes.titulo} ya está visible en la app` : `${antes.titulo}: ${comentario}`,
          { promocionId: id },
        );
      }
      return p;
    });
  }
}
