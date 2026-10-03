import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia, codigoLegible } from '../../common/util.js';
import { AuditoriaService, NotificacionesService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { EventBus } from '../nucleo/event-bus.js';
import { PresenciaService } from '../presencia/presencia.service.js';

/**
 * Experiencias de presencia: monedas en hitos (Proof of Presence, HU-X04) y Drops espaciales (HU-X05).
 * El cartel del hito lleva un QR `PPH:<código>`; la app lo reconoce con la cámara, verifica la geocerca
 * y muestra la moneda. Si hay un Drop activo en la zona del hito, el mismo cartel lo desbloquea.
 */
@Injectable()
export class ExperienciasService {
  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly presencia: PresenciaService,
    private readonly telemetria: TelemetriaService,
    private readonly notif: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly rt: RealtimeService,
    private readonly bus: EventBus,
  ) {}

  hitos(recintoId: string) {
    return many(
      this.db,
      `select h.*, z.nombre as zona, z.piso, l.nombre as local,
              (select count(*)::int from reclamo_hito r where r.hito_id = h.id) as reclamos
       from hito h left join zona z on z.id = h.zona_id left join local l on l.id = h.local_id where h.recinto_id = $1 order by z.piso, h.nombre`,
      [recintoId],
    );
  }

  /** Lo que la app muestra al reconocer el cartel, antes de reclamar. */
  async inspeccionar(recintoId: string, clienteId: string, codigo: string) {
    const h = await this.hitoPorCodigo(recintoId, codigo);
    const { fecha } = ahoraBolivia();
    const reclamado = await one(this.db, 'select id from reclamo_hito where hito_id = $1 and cliente_id = $2 and fecha = $3', [h.id, clienteId, fecha]);
    const drop = await this.dropActivoEnZona(h.zona_id, clienteId);
    return { hito: { id: h.id, nombre: h.nombre, puntos: h.puntos, zona: h.zona, piso: h.piso }, monedaDisponible: !reclamado, drop };
  }

  private async hitoPorCodigo(recintoId: string, codigo: string) {
    const m = /^PPH:([A-Z0-9-]+)$/.exec(codigo.trim());
    if (!m) throw new BadRequestException('Este cartel no es un hito de Paseo Points');
    const h = await one<any>(
      this.db,
      `select h.*, z.nombre as zona, z.piso from hito h left join zona z on z.id = h.zona_id where h.codigo = $1 and h.recinto_id = $2 and h.activo`,
      [m[1], recintoId],
    );
    if (!h) throw new NotFoundException('Hito no encontrado');
    return h;
  }

  private async dropActivoEnZona(zonaId: string | null, clienteId: string) {
    if (!zonaId) return null;
    const d = await one<any>(
      this.db,
      `select d.id, d.mensaje, d.precio_especial, d.fin, p.id as producto_id, p.nombre as producto, p.precio_bs, p.foto_url, l.nombre as local,
              (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as reclamos, d.max_reclamos,
              exists (select 1 from reclamo_drop r where r.drop_id = d.id and r.cliente_id = $2) as ya_reclamado
       from drop_espacial d join producto p on p.id = d.producto_id join local l on l.id = p.local_id
       where d.zona_id = $1 and now() between d.inicio and d.fin order by d.creado_en desc limit 1`,
      [zonaId, clienteId],
    );
    return d ?? null;
  }

  /** Reclama la moneda del hito: geocerca activa y un reclamo por hito por día. */
  async reclamarHito(recintoId: string, clienteId: string, codigo: string, lat?: number, lng?: number) {
    const h = await this.hitoPorCodigo(recintoId, codigo);
    const r = await this.db.tx(async (q) => {
      const g = await this.presencia.verificarGeocerca(q, recintoId, lat, lng);
      if (!g.dentro) throw new BadRequestException(`Estás a ${g.distancia} m del Paseo; la moneda solo aparece dentro del edificio`);
      const { fecha } = ahoraBolivia();
      const ins = await one(
        q,
        `insert into reclamo_hito (hito_id, cliente_id, fecha) values ($1,$2,$3) on conflict (hito_id, cliente_id, fecha) do nothing returning id`,
        [h.id, clienteId, fecha],
      );
      if (!ins) throw new BadRequestException('Ya reclamaste la moneda de este hito hoy. Vuelve mañana.');
      await this.presencia.asegurarVisita(q, recintoId, clienteId, 'ar');
      await this.fidelizacion.acreditar(q, { recintoId, clienteId, tipo: 'hito', puntos: h.puntos, referenciaId: h.id, localId: h.local_id, descripcion: `Moneda en ${h.nombre}` });
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'hito.reclamado', zonaId: h.zona_id, localId: h.local_id, payload: { hito: h.nombre } });
      // Ficha personalizada: cruza intereses declarados con promociones activas de la zona
      const ficha = await one(
        q,
        `select l.id, l.nombre, l.piso, l.numero_local, c.nombre as categoria, p.titulo as promocion
         from local l join categoria c on c.id = l.categoria_id
         left join promocion p on p.local_id = l.id and p.estado = 'aprobada' and current_date between p.inicio and p.fin
         where l.zona_id = $1 and l.activo
         order by (c.nombre = any(coalesce((select intereses from cliente_perfil where usuario_id = $2), '{}'::text[]))) desc, (p.id is not null) desc, random() limit 1`,
        [h.zona_id, clienteId],
      );
      return { puntos: h.puntos, hito: h.nombre, ficha };
    });
    this.rt.aSala(recintoId, 'evento', { tipo: 'hito.reclamado', zonaId: h.zona_id });
    this.bus.publicar('hito.reclamado', { recintoId, clienteId, hitoId: h.id });
    return r;
  }

  /** Reclama el Drop activo de la zona: desbloquea el precio especial en PaseoYa. */
  async reclamarDrop(recintoId: string, clienteId: string, codigo: string, lat?: number, lng?: number) {
    const h = await this.hitoPorCodigo(recintoId, codigo);
    const drop = await this.dropActivoEnZona(h.zona_id, clienteId);
    if (!drop) throw new NotFoundException('No hay un Drop activo en esta zona');
    const r = await this.db.tx(async (q) => {
      const g = await this.presencia.verificarGeocerca(q, recintoId, lat, lng);
      if (!g.dentro) throw new BadRequestException('El Drop solo se abre dentro del Paseo');
      const n = await one<{ n: number }>(q, 'select count(*)::int as n from reclamo_drop where drop_id = $1', [drop.id]);
      if ((n?.n ?? 0) >= drop.max_reclamos) throw new BadRequestException('Se agotaron las cajas de este Drop');
      const ins = await one(q, `insert into reclamo_drop (drop_id, cliente_id) values ($1,$2) on conflict do nothing returning id`, [drop.id, clienteId]);
      if (!ins) throw new BadRequestException('Ya abriste esta caja');
      await this.presencia.asegurarVisita(q, recintoId, clienteId, 'ar');
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'drop.reclamado', zonaId: h.zona_id, payload: { drop: drop.id } });
      return {
        dropId: drop.id,
        producto: { id: drop.producto_id, nombre: drop.producto, precioBs: Number(drop.precio_bs), fotoUrl: drop.foto_url, local: drop.local },
        precioEspecial: Number(drop.precio_especial),
        venceEn: drop.fin,
        mensaje: drop.mensaje,
      };
    });
    this.rt.aSala(recintoId, 'drop', { tipo: 'reclamado', dropId: drop.id, zonaId: h.zona_id });
    return r;
  }

  /** El administrador lanza un Drop sobre una zona fría desde el gemelo digital. */
  async lanzarDrop(s: Sesion, d: { zonaId: string; productoId: string; precioEspecial: number; mensaje: string; minutos: number; maxReclamos: number; localId?: string }) {
    const r = await this.db.tx(async (q) => {
      const zona = await one<any>(q, 'select * from zona where id = $1 and recinto_id = $2', [d.zonaId, s.recintoId]);
      if (!zona) throw new NotFoundException('Zona no encontrada');
      const prod = await one<any>(q, 'select p.*, l.nombre as local from producto p join local l on l.id = p.local_id where p.id = $1', [d.productoId]);
      if (!prod) throw new NotFoundException('Producto no encontrado');
      if (d.precioEspecial >= Number(prod.precio_bs)) throw new BadRequestException('El precio especial debe ser menor al precio normal');
      const hito = await one<any>(q, 'select codigo from hito where zona_id = $1 and activo limit 1', [d.zonaId]);
      if (!hito) throw new BadRequestException('La zona no tiene un cartel (hito) donde abrir el Drop');
      const drop = await one<any>(
        q,
        `insert into drop_espacial (recinto_id, zona_id, producto_id, precio_especial, mensaje, codigo, fin, max_reclamos, creado_por, local_id)
         values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval, $8, $9, $10) returning *`,
        [s.recintoId, d.zonaId, d.productoId, d.precioEspecial, d.mensaje, `D-${codigoLegible(6)}`, d.minutos, d.maxReclamos, s.sub, d.localId ?? prod.local_id],
      );
      // Aviso a clientes con permiso de ubicación que están en el Paseo ahora
      const presentes = await many<{ cliente_id: string }>(
        q,
        `select distinct v.cliente_id from visita v join cliente_perfil p on p.usuario_id = v.cliente_id
         where v.recinto_id = $1 and v.salida_en is null and v.entrada_en > now() - interval '6 hours' and p.consent_ubicacion`,
        [s.recintoId],
      );
      for (const c of presentes) {
        await this.notif.crear(q, c.cliente_id, 'drop', `Drop en ${zona.nombre} (${zona.piso})`, `${d.mensaje} · ${prod.nombre} a Bs ${d.precioEspecial.toFixed(2)}`, {
          dropId: drop.id, zonaId: zona.id, hito: `PPH:${hito.codigo}`,
        });
      }
      await this.auditoria.registrar(q, s.sub, 'lanzar_drop', 'drop_espacial', drop.id, null, drop);
      await this.telemetria.registrar(q, { recintoId: s.recintoId, tipo: 'drop.lanzado', zonaId: zona.id, payload: { avisados: presentes.length } });
      return { ...drop, zona: zona.nombre, producto: prod.nombre, avisados: presentes.length, cartel: `PPH:${hito.codigo}` };
    });
    this.rt.aSala(s.recintoId, 'drop', { tipo: 'lanzado', dropId: r.id, zonaId: d.zonaId });
    this.bus.publicar('drop.lanzado', { recintoId: s.recintoId, dropId: r.id, zonaId: d.zonaId, hitoCodigo: r.cartel });
    return r;
  }

  drops(recintoId: string) {
    return many(
      this.db,
      `select d.*, z.nombre as zona, z.piso, p.nombre as producto, p.precio_bs,
              (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as reclamos,
              (select count(*)::int from reclamo_drop r where r.drop_id = d.id and r.usado) as compras,
              (now() between d.inicio and d.fin) as activo
       from drop_espacial d join zona z on z.id = d.zona_id join producto p on p.id = d.producto_id
       where d.recinto_id = $1 order by d.creado_en desc limit 50`,
      [recintoId],
    );
  }

  misDrops(clienteId: string) {
    return many(
      this.db,
      `select r.drop_id, r.usado, d.precio_especial, d.fin, d.mensaje, p.id as producto_id, p.nombre as producto, p.precio_bs, p.foto_url, l.nombre as local
       from reclamo_drop r join drop_espacial d on d.id = r.drop_id join producto p on p.id = d.producto_id join local l on l.id = p.local_id
       where r.cliente_id = $1 and not r.usado and d.fin > now()`,
      [clienteId],
    );
  }
}
