import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { codigoLegible } from '../../common/util.js';
import { AuditoriaService, NotificacionesService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';
import { PresenciaService } from '../presencia/presencia.service.js';

/**
 * Drops (HU-X05): un producto de un local a precio especial, por poco tiempo y con cupos.
 * El cliente lo ve en la app (aviso, mapa o Jarvis) y lo reclama estando dentro del Paseo;
 * el precio especial queda desbloqueado en PaseoYa o se cobra en el local.
 */
@Injectable()
export class DropsService {
  constructor(
    private readonly db: Db,
    private readonly presencia: PresenciaService,
    private readonly telemetria: TelemetriaService,
    private readonly notif: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly rt: RealtimeService,
    private readonly bus: EventBus,
  ) {}

  /** Drops abiertos ahora, con cupos restantes y si el cliente ya reclamó cada uno. */
  activos(recintoId: string, clienteId: string | null) {
    return many<any>(
      this.db,
      `select d.id, d.zona_id, d.mensaje, d.precio_especial, d.inicio, d.fin, d.max_reclamos, p.id as producto_id, p.nombre as producto, p.precio_bs, p.foto_url,
              l.id as local_id, l.nombre as local, l.piso, l.numero_local,
              d.max_reclamos - (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as quedan,
              ($2::uuid is not null and exists (select 1 from reclamo_drop r where r.drop_id = d.id and r.cliente_id = $2)) as ya_reclamado
       from drop_espacial d join producto p on p.id = d.producto_id join local l on l.id = coalesce(d.local_id, p.local_id)
       where d.recinto_id = $1 and now() between d.inicio and d.fin order by d.fin`,
      [recintoId, clienteId],
    );
  }

  /** Reclama un Drop: hay que estar en el Paseo, quedar cupos y no haberlo reclamado antes. */
  async reclamar(recintoId: string, clienteId: string, dropId: string, lat?: number, lng?: number) {
    const drop = (await this.activos(recintoId, clienteId)).find((d) => d.id === dropId);
    if (!drop) throw new NotFoundException('Ese Drop ya terminó');
    if (drop.ya_reclamado) throw new BadRequestException('Ya reclamaste este Drop: el precio especial te espera en PaseoYa');
    const r = await this.db.tx(async (q) => {
      const g = await this.presencia.verificarGeocerca(q, recintoId, lat, lng);
      if (!g.dentro) throw new BadRequestException(`Estás a ${g.distancia} m del Paseo: los Drops se reclaman dentro del edificio`);
      const n = await one<{ n: number }>(q, 'select count(*)::int as n from reclamo_drop where drop_id = $1', [drop.id]);
      if ((n?.n ?? 0) >= drop.max_reclamos) throw new BadRequestException('Se agotaron los cupos de este Drop');
      const ins = await one(q, `insert into reclamo_drop (drop_id, cliente_id) values ($1,$2) on conflict do nothing returning id`, [drop.id, clienteId]);
      if (!ins) throw new BadRequestException('Ya reclamaste este Drop');
      await this.presencia.asegurarVisita(q, recintoId, clienteId, 'geocerca');
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'drop.reclamado', zonaId: drop.zona_id, localId: drop.local_id, payload: { drop: drop.id } });
      return {
        dropId: drop.id,
        producto: { id: drop.producto_id, nombre: drop.producto, precioBs: Number(drop.precio_bs), fotoUrl: drop.foto_url, local: drop.local },
        precioEspecial: Number(drop.precio_especial),
        venceEn: drop.fin,
        mensaje: drop.mensaje,
      };
    });
    this.rt.aSala(recintoId, 'drop', { tipo: 'reclamado', dropId: drop.id, localId: drop.local_id });
    return r;
  }

  /** El administrador lanza un Drop (propio o aprobado de una solicitud de comercio). */
  async lanzarDrop(s: Sesion, d: { zonaId?: string | null; productoId: string; precioEspecial: number; mensaje: string; minutos: number; maxReclamos: number; localId?: string }) {
    const r = await this.db.tx(async (q) => {
      const prod = await one<any>(q, 'select p.*, l.nombre as local, l.zona_id as local_zona, l.piso, l.numero_local from producto p join local l on l.id = p.local_id where p.id = $1', [d.productoId]);
      if (!prod) throw new NotFoundException('Producto no encontrado');
      if (d.precioEspecial >= Number(prod.precio_bs)) throw new BadRequestException('El precio especial debe ser menor al precio normal');
      const zonaId = d.zonaId ?? prod.local_zona;
      const zona = await one<any>(q, 'select * from zona where id = $1 and recinto_id = $2', [zonaId, s.recintoId]);
      if (!zona) throw new NotFoundException('Zona no encontrada');
      const drop = await one<any>(
        q,
        `insert into drop_espacial (recinto_id, zona_id, producto_id, precio_especial, mensaje, codigo, fin, max_reclamos, creado_por, local_id)
         values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval, $8, $9, $10) returning *`,
        [s.recintoId, zona.id, d.productoId, d.precioEspecial, d.mensaje, `D-${codigoLegible(6)}`, d.minutos, d.maxReclamos, s.sub, d.localId ?? prod.local_id],
      );
      // Aviso a clientes con permiso de ubicación que están en el Paseo ahora
      const presentes = await many<{ cliente_id: string }>(
        q,
        `select distinct v.cliente_id from visita v join cliente_perfil p on p.usuario_id = v.cliente_id
         where v.recinto_id = $1 and v.salida_en is null and v.entrada_en > now() - interval '6 hours' and p.consent_ubicacion`,
        [s.recintoId],
      );
      for (const c of presentes) {
        await this.notif.crear(q, c.cliente_id, 'drop', `Drop en ${prod.local}`, `${d.mensaje} · ${prod.nombre} a Bs ${d.precioEspecial.toFixed(2)}`, { dropId: drop.id, localId: drop.local_id });
      }
      await this.auditoria.registrar(q, s.sub, 'lanzar_drop', 'drop_espacial', drop.id, null, drop);
      await this.telemetria.registrar(q, { recintoId: s.recintoId, tipo: 'drop.lanzado', zonaId: zona.id, payload: { avisados: presentes.length } });
      return { ...drop, zona: zona.nombre, producto: prod.nombre, local: prod.local, avisados: presentes.length };
    });
    this.rt.aSala(s.recintoId, 'drop', { tipo: 'lanzado', dropId: r.id, localId: r.local_id });
    this.bus.publicar('drop.lanzado', { recintoId: s.recintoId, dropId: r.id, localId: r.local_id });
    return r;
  }

  drops(recintoId: string) {
    return many(
      this.db,
      `select d.*, z.nombre as zona, z.piso, p.nombre as producto, p.precio_bs, l.nombre as local,
              (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as reclamos,
              (select count(*)::int from reclamo_drop r where r.drop_id = d.id and r.usado) as compras,
              (now() between d.inicio and d.fin) as activo
       from drop_espacial d join zona z on z.id = d.zona_id join producto p on p.id = d.producto_id join local l on l.id = coalesce(d.local_id, p.local_id)
       where d.recinto_id = $1 order by d.creado_en desc limit 50`,
      [recintoId],
    );
  }

  misDrops(clienteId: string) {
    return many(
      this.db,
      `select r.drop_id, r.usado, d.precio_especial, d.fin, d.mensaje, p.id as producto_id, p.nombre as producto, p.precio_bs, p.foto_url, l.nombre as local, c.ambito
       from reclamo_drop r join drop_espacial d on d.id = r.drop_id join producto p on p.id = d.producto_id join local l on l.id = p.local_id left join categoria c on c.id = p.categoria_id
       where r.cliente_id = $1 and not r.usado and d.fin > now()`,
      [clienteId],
    );
  }
}
