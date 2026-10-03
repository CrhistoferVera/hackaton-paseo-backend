import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { codigoLegible, pinNumerico } from '../../common/util.js';
import { firmaCorta } from '../../common/auth/tokens.js';
import { AuditoriaService, NotificacionesService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { PresenciaService } from '../presencia/presencia.service.js';
import { RecintoService } from '../recinto/recinto.service.js';
import { enmascararNombre } from '../identidad/identidad.service.js';
import { ETIQUETA_ESTADO, EstadoSubpedido, puedeTransicionar } from './domain/estado-subpedido.js';

const MINUTOS_GRACIA_RETIRO = 30;

export interface ItemPedido {
  productoId: string;
  cantidad: number;
  dropId?: string | null;
}

export interface DatosProducto {
  nombre: string;
  descripcion?: string;
  precioBs: number;
  stock: number;
  categoriaId: string;
  fotoUrl?: string | null;
  activo?: boolean;
  tiempoPreparacionMin?: number | null;
  etiquetas?: string[];
}

/** PaseoYa: marketplace con retiro presencial obligatorio (reto 3 integrado). */
@Injectable()
export class PaseoYaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PaseoYa');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly presencia: PresenciaService,
    private readonly recinto: RecintoService,
    private readonly telemetria: TelemetriaService,
    private readonly notif: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly rt: RealtimeService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.vencerPedidos().catch((e) => this.log.error(e)), 5 * 60_000);
    // HU-Y08: el check-in de entrada también avisa a los locales que el cliente llegó
    this.bus.on('visita.iniciada', (e) => this.marcarLlegada(e.recintoId, e.clienteId, null).then(() => undefined));
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ catálogo (HU-Y01, Y02, Y03, Y19)
  categorias(ambito?: string) {
    return many(
      this.db,
      `select c.*, (select count(*)::int from producto p join local l on l.id = p.local_id where p.categoria_id = c.id and p.activo and l.activo and p.stock > 0) as productos
       from categoria c where ($1::text is null or c.ambito = $1) order by c.orden, c.nombre`,
      [ambito ?? null],
    );
  }

  private readonly selectProducto = `select p.id, p.nombre, p.descripcion, p.precio_bs, p.stock, p.foto_url, p.destacado_hasta, p.categoria_id, p.tiempo_preparacion_min, p.etiquetas,
      c.nombre as categoria, c.ambito, l.id as local_id, l.nombre as local, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y,
      l.horario_apertura, l.horario_cierre
    from producto p join local l on l.id = p.local_id join categoria c on c.id = p.categoria_id`;

  async productos(recintoId: string, f: { categoriaId?: string; ambito?: string; localId?: string }, clienteId: string | null) {
    const filas = await many(
      this.db,
      `${this.selectProducto}
       where l.recinto_id = $1 and p.activo and l.activo
         and ($2::uuid is null or p.categoria_id = $2) and ($3::text is null or c.ambito = $3) and ($4::uuid is null or l.id = $4)
       order by (p.destacado_hasta >= current_date) desc nulls last, p.nombre limit 200`,
      [recintoId, f.categoriaId ?? null, f.ambito ?? null, f.localId ?? null],
    );
    if (clienteId && f.categoriaId) {
      await this.telemetria.registrarSuelto({ recintoId, clienteId, tipo: 'paseoya.categoria_vista', payload: { categoria_id: f.categoriaId } });
    }
    return filas;
  }

  destacados(recintoId: string) {
    return many(this.db, `${this.selectProducto} where l.recinto_id = $1 and p.activo and l.activo and p.destacado_hasta >= current_date order by p.destacado_hasta limit 20`, [recintoId]);
  }

  /** HU-Y02: «audífonos bluetooth» muestra todos los locales que lo venden, ordenado por precio. */
  buscarDesdeJarvis(recintoId: string, termino: string, clienteId: string | null) {
    return this.buscar(recintoId, termino, clienteId, 'precio', 'jarvis');
  }

  async buscar(recintoId: string, termino: string, clienteId: string | null, orden: 'precio' | 'nombre' = 'precio', origen: 'paseoya' | 'jarvis' = 'paseoya') {
    const t = termino.trim().toLowerCase();
    if (t.length < 2) return [];
    const palabras = t.split(/\s+/).filter(Boolean);
    const cond = palabras.map((_, i) => `(lower(p.nombre) like $${i + 2} or lower(p.descripcion) like $${i + 2} or lower(c.nombre) like $${i + 2})`).join(' and ');
    const filas = await many(
      this.db,
      `${this.selectProducto} where l.recinto_id = $1 and p.activo and l.activo and ${cond}
       order by ${orden === 'precio' ? 'p.precio_bs' : 'p.nombre'} limit 60`,
      [recintoId, ...palabras.map((w) => `%${w}%`)],
    );
    await this.recinto.registrarBusqueda(recintoId, t, clienteId, origen, filas.length);
    return filas;
  }

  async producto(recintoId: string, id: string, clienteId: string | null) {
    const p = await one(this.db, `${this.selectProducto} where p.id = $1 and l.recinto_id = $2`, [id, recintoId]);
    if (!p) throw new NotFoundException('Producto no encontrado');
    if (clienteId) await this.telemetria.registrarSuelto({ recintoId, clienteId, tipo: 'paseoya.producto_visto', localId: (p as any).local_id, payload: { producto_id: id } });
    const favorito = clienteId ? await one(this.db, 'select id from favorito where cliente_id = $1 and producto_id = $2', [clienteId, id]) : null;
    return { ...p, favorito: !!favorito };
  }

  // ------------------------------------------------------------------ pedidos del cliente (HU-Y04 a Y09, Y11)
  async crearPedido(
    recintoId: string,
    clienteId: string,
    d: { items: ItemPedido[]; franjaInicio: string; franjaFin: string; pago: 'en_local' | 'qr_anticipado' },
  ) {
    if (!d.items.length) throw new BadRequestException('Tu carrito está vacío');
    const ini = new Date(d.franjaInicio);
    const fin = new Date(d.franjaFin);
    if (!(fin > ini)) throw new BadRequestException('La franja de retiro no es válida');
    if (ini.getTime() < Date.now() - 5 * 60_000) throw new BadRequestException('La franja de retiro ya pasó');

    const r = await this.db.tx(async (q) => {
      const ids = d.items.map((i) => i.productoId);
      const prods = await many<any>(
        q,
        `select p.*, l.nombre as local, l.horario_apertura, l.horario_cierre, l.activo as local_activo
         from producto p join local l on l.id = p.local_id where p.id = any($1::uuid[]) and l.recinto_id = $2 for update of p`,
        [ids, recintoId],
      );
      const mapa = new Map(prods.map((p) => [p.id, p]));
      const porLocal = new Map<string, { local: string; items: (ItemPedido & { precio: number; nombre: string })[]; apertura: string; cierre: string }>();
      for (const it of d.items) {
        const p = mapa.get(it.productoId);
        if (!p || !p.activo || !p.local_activo) throw new BadRequestException('Un producto del carrito ya no está disponible');
        if (p.stock < it.cantidad) throw new BadRequestException(`Solo quedan ${p.stock} unidades de ${p.nombre}`);
        let precio = Number(p.precio_bs);
        if (it.dropId) {
          const drop = await one<any>(
            q,
            `select d.precio_especial from drop_espacial d join reclamo_drop r on r.drop_id = d.id
             where d.id = $1 and d.producto_id = $2 and r.cliente_id = $3 and not r.usado and d.fin > now()`,
            [it.dropId, p.id, clienteId],
          );
          if (!drop) throw new BadRequestException('El precio especial del Drop ya no está disponible');
          precio = Number(drop.precio_especial);
          await q.query('update reclamo_drop set usado = true where drop_id = $1 and cliente_id = $2', [it.dropId, clienteId]);
        }
        type Grupo = { local: string; items: (ItemPedido & { precio: number; nombre: string })[]; apertura: string; cierre: string };
        const g: Grupo = porLocal.get(p.local_id) ?? { local: p.local, items: [], apertura: p.horario_apertura, cierre: p.horario_cierre };
        g.items.push({ ...it, precio, nombre: p.nombre });
        porLocal.set(p.local_id, g);
      }
      if (d.pago === 'qr_anticipado' && porLocal.size > 1) {
        throw new BadRequestException('El pago anticipado por QR solo está disponible para pedidos de un solo local');
      }
      // La franja debe caer dentro del horario de cada local (hora boliviana)
      const hhmm = (x: Date) => new Date(x.getTime() - 4 * 3600_000).toISOString().slice(11, 16);
      for (const g of porLocal.values()) {
        if (hhmm(ini) < String(g.apertura).slice(0, 5) || hhmm(fin) > String(g.cierre).slice(0, 5)) {
          throw new BadRequestException(`${g.local} atiende de ${String(g.apertura).slice(0, 5)} a ${String(g.cierre).slice(0, 5)}`);
        }
      }
      const total = [...porLocal.values()].reduce((a, g) => a + g.items.reduce((b, i) => b + i.precio * i.cantidad, 0), 0);
      const pedido = await one<any>(
        q,
        `insert into pedido (recinto_id, codigo, cliente_id, total_bs, franja_inicio, franja_fin) values ($1,$2,$3,$4,$5,$6) returning *`,
        [recintoId, `P-${codigoLegible(6)}`, clienteId, total, ini, fin],
      );
      for (const [localId, g] of porLocal) {
        const sub = g.items.reduce((b, i) => b + i.precio * i.cantidad, 0);
        const base = codigoLegible(8);
        const s = await one<any>(
          q,
          `insert into subpedido (pedido_id, local_id, total_bs, codigo_retiro, pin, pago) values ($1,$2,$3,$4,$5,$6) returning *`,
          [pedido.id, localId, sub, `${base}.${firmaCorta(base)}`, pinNumerico(4), d.pago],
        );
        for (const i of g.items) {
          await q.query(`insert into subpedido_item (subpedido_id, producto_id, nombre, cantidad, precio_bs, drop_id) values ($1,$2,$3,$4,$5,$6)`, [
            s.id, i.productoId, i.nombre, i.cantidad, i.precio, i.dropId ?? null,
          ]);
          await q.query('update producto set stock = stock - $2 where id = $1', [i.productoId, i.cantidad]);
        }
        setTimeout(() => this.rt.aLocal(localId, 'pedido', { tipo: 'nuevo', subpedidoId: s.id }), 50);
        await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'pedido.creado', localId, payload: { total_bs: sub, items: g.items.length } });
      }
      const regla = await this.fidelizacion.reglaVigente(q, recintoId);
      return { pedidoId: pedido.id, codigo: pedido.codigo, totalBs: total, puntosEstimados: Math.floor(total / Number(regla.bs_por_punto)) };
    });
    this.bus.publicar('pedido.creado', { recintoId, clienteId, pedidoId: r.pedidoId });
    return { ...r, detalle: await this.pedido(clienteId, r.pedidoId) };
  }

  async misPedidos(clienteId: string) {
    const pedidos = await many<any>(this.db, `select * from pedido where cliente_id = $1 order by creado_en desc limit 30`, [clienteId]);
    return Promise.all(pedidos.map((p) => this.armarPedido(p)));
  }

  async pedido(clienteId: string, id: string) {
    const p = await one<any>(this.db, 'select * from pedido where id = $1 and cliente_id = $2', [id, clienteId]);
    if (!p) throw new NotFoundException('Pedido no encontrado');
    return this.armarPedido(p);
  }

  private async armarPedido(p: any) {
    const subs = await many<any>(
      this.db,
      `select s.*, 'PPR:' || s.codigo_retiro as qr, l.nombre as local, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y
       from subpedido s join local l on l.id = s.local_id where s.pedido_id = $1 order by l.nombre`,
      [p.id],
    );
    for (const s of subs) {
      s.items = await many(this.db, 'select producto_id, nombre, cantidad, precio_bs, drop_id from subpedido_item where subpedido_id = $1', [s.id]);
      s.etiqueta = ETIQUETA_ESTADO[s.estado as EstadoSubpedido];
    }
    return { ...p, subpedidos: subs };
  }

  /** HU-Y08: «Llegué» pasa los sub-pedidos listos a «Cliente llegó» y avisa a cada local. */
  async marcarLlegada(recintoId: string, clienteId: string, pedidoId: string | null) {
    const subs = await many<any>(
      this.db,
      `update subpedido s set llego_en = coalesce(s.llego_en, now()),
              estado = case when s.estado = 'listo' then 'cliente_llego' else s.estado end
       from pedido p where p.id = s.pedido_id and p.cliente_id = $1 and ($2::uuid is null or p.id = $2)
         and s.estado in ('recibido','confirmado','preparando','listo') and p.franja_fin > now() - interval '3 hours'
       returning s.id, s.local_id, s.estado, p.codigo`,
      [clienteId, pedidoId],
    );
    const cliente = (await one<{ nombre: string }>(this.db, 'select nombre from usuario where id = $1', [clienteId]))?.nombre ?? '';
    for (const s of subs) {
      this.rt.aLocal(s.local_id, 'pedido', { tipo: 'cliente_llego', subpedidoId: s.id, cliente: enmascararNombre(cliente), pedido: s.codigo });
      this.rt.aUsuario(clienteId, 'pedido', { subpedidoId: s.id, estado: s.estado });
    }
    return subs.length;
  }

  async llegue(recintoId: string, clienteId: string, pedidoId: string) {
    await this.pedido(clienteId, pedidoId);
    const visita = await this.db.tx((q) => this.presencia.asegurarVisita(q, recintoId, clienteId, 'paseoya'));
    const n = await this.marcarLlegada(recintoId, clienteId, pedidoId);
    return { avisados: n, puntosVisita: visita.puntos, pedido: await this.pedido(clienteId, pedidoId) };
  }

  async subirComprobante(clienteId: string, pedidoId: string, url: string) {
    const r = await one(
      this.db,
      `update subpedido s set comprobante_url = $3 from pedido p where p.id = s.pedido_id and p.id = $1 and p.cliente_id = $2 and s.pago = 'qr_anticipado' returning s.id, s.local_id`,
      [pedidoId, clienteId, url],
    );
    if (!r) throw new BadRequestException('Este pedido no usa pago anticipado por QR');
    this.rt.aLocal((r as any).local_id, 'pedido', { tipo: 'comprobante', subpedidoId: (r as any).id });
    return { ok: true, comprobanteUrl: url };
  }

  // ------------------------------------------------------------------ favoritos e historial (HU-Y10)
  favoritos(clienteId: string) {
    return Promise.all([
      many(this.db, `${this.selectProducto} join favorito f on f.producto_id = p.id where f.cliente_id = $1 order by f.creado_en desc`, [clienteId]),
      many(
        this.db,
        `select l.id, l.nombre, l.piso, l.sector, l.numero_local, c.nombre as categoria from favorito f join local l on l.id = f.local_id
         join categoria c on c.id = l.categoria_id where f.cliente_id = $1 order by f.creado_en desc`,
        [clienteId],
      ),
    ]).then(([productos, locales]) => ({ productos, locales }));
  }

  async alternarFavorito(clienteId: string, d: { productoId?: string; localId?: string }) {
    const col = d.productoId ? 'producto_id' : 'local_id';
    const val = d.productoId ?? d.localId;
    if (!val) throw new BadRequestException('Indica un producto o un local');
    const existe = await one(this.db, `select id from favorito where cliente_id = $1 and ${col} = $2`, [clienteId, val]);
    if (existe) {
      await this.db.query('delete from favorito where id = $1', [(existe as any).id]);
      return { favorito: false };
    }
    await this.db.query(`insert into favorito (cliente_id, ${col}) values ($1,$2)`, [clienteId, val]);
    return { favorito: true };
  }

  /** Recompra en un toque: devuelve los ítems disponibles para cargar en el carrito. */
  async repetir(clienteId: string, pedidoId: string) {
    const p = await this.pedido(clienteId, pedidoId);
    const items = p.subpedidos.flatMap((s: any) => s.items.map((i: any) => ({ productoId: i.producto_id, cantidad: i.cantidad })));
    const disponibles = await many<any>(
      this.db,
      `${this.selectProducto} where p.id = any($1::uuid[]) and p.activo and l.activo and p.stock > 0`,
      [items.map((i: any) => i.productoId)],
    );
    const d = new Map(disponibles.map((x) => [x.id, x]));
    return items.filter((i: any) => d.has(i.productoId)).map((i: any) => ({ ...i, producto: d.get(i.productoId), cantidad: Math.min(i.cantidad, d.get(i.productoId).stock) }));
  }

  // ------------------------------------------------------------------ local: productos (HU-Y13)
  productosDelLocal(localId: string) {
    return many(this.db, `select p.*, c.nombre as categoria from producto p join categoria c on c.id = p.categoria_id where p.local_id = $1 order by p.activo desc, p.nombre`, [localId]);
  }

  async crearProducto(s: Sesion, d: DatosProducto) {
    if (!s.localId) throw new ForbiddenException('Tu usuario no está asignado a un local');
    return one(
      this.db,
      `insert into producto (local_id, nombre, descripcion, precio_bs, stock, categoria_id, foto_url, activo, tiempo_preparacion_min, etiquetas)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [s.localId, d.nombre, d.descripcion ?? '', d.precioBs, d.stock, d.categoriaId, d.fotoUrl ?? null, d.activo ?? true, d.tiempoPreparacionMin ?? null, d.etiquetas ?? []],
    );
  }

  async actualizarProducto(s: Sesion, id: string, d: Partial<DatosProducto>) {
    const p = await one(
      this.db,
      `update producto set nombre = coalesce($3,nombre), descripcion = coalesce($4,descripcion), precio_bs = coalesce($5,precio_bs),
         stock = coalesce($6,stock), categoria_id = coalesce($7,categoria_id), foto_url = coalesce($8,foto_url), activo = coalesce($9,activo),
         tiempo_preparacion_min = case when $10::boolean then $11::int else tiempo_preparacion_min end, etiquetas = coalesce($12,etiquetas)
       where id = $1 and local_id = $2 returning *`,
      [id, s.localId, d.nombre ?? null, d.descripcion ?? null, d.precioBs ?? null, d.stock ?? null, d.categoriaId ?? null, d.fotoUrl ?? null, d.activo ?? null,
        d.tiempoPreparacionMin !== undefined, d.tiempoPreparacionMin ?? null, d.etiquetas ?? null],
    );
    if (!p) throw new NotFoundException('Producto no encontrado en tu local');
    return p;
  }

  async eliminarProducto(s: Sesion, id: string) {
    const usado = await one(this.db, 'select 1 from subpedido_item where producto_id = $1 union all select 1 from drop_espacial where producto_id = $1 limit 1', [id]);
    if (usado) {
      await this.db.query('update producto set activo = false where id = $1 and local_id = $2', [id, s.localId]);
      return { eliminado: false, desactivado: true };
    }
    await this.db.tx(async (q) => {
      if (!(await one(q, 'select 1 from producto where id = $1 and local_id = $2', [id, s.localId]))) throw new NotFoundException('Producto no encontrado en tu local');
      await q.query('delete from favorito where producto_id = $1', [id]);
      await q.query('delete from producto where id = $1', [id]);
    });
    return { eliminado: true };
  }

  // ------------------------------------------------------------------ local: bandeja de pedidos (HU-Y14, Y15)
  async bandeja(localId: string, estado?: string) {
    const subs = await many<any>(
      this.db,
      `select s.*, p.codigo as pedido, p.franja_inicio, p.franja_fin, p.creado_en, u.nombre as cliente
       from subpedido s join pedido p on p.id = s.pedido_id join usuario u on u.id = p.cliente_id
       where s.local_id = $1 and ($2::text is null or s.estado = $2)
         and (s.estado not in ('entregado','vencido') or p.creado_en > now() - interval '2 days')
       order by case s.estado when 'cliente_llego' then 0 when 'recibido' then 1 when 'confirmado' then 2 when 'preparando' then 3 when 'listo' then 4 else 5 end, p.franja_inicio`,
      [localId, estado ?? null],
    );
    for (const s of subs) {
      s.items = await many(this.db, 'select nombre, cantidad, precio_bs from subpedido_item where subpedido_id = $1', [s.id]);
      s.cliente = enmascararNombre(s.cliente);
      s.etiqueta = ETIQUETA_ESTADO[s.estado as EstadoSubpedido];
      delete s.pin;
      delete s.codigo_retiro;
    }
    return subs;
  }

  async avanzar(s: Sesion, subpedidoId: string, a: 'confirmado' | 'preparando' | 'listo') {
    const r = await this.db.tx(async (q) => {
      const sp = await one<any>(
        q,
        `select s.*, p.cliente_id, p.codigo from subpedido s join pedido p on p.id = s.pedido_id where s.id = $1 and s.local_id = $2 for update of s`,
        [subpedidoId, s.localId],
      );
      if (!sp) throw new NotFoundException('Pedido no encontrado en tu local');
      if (!puedeTransicionar(sp.estado, a)) throw new BadRequestException(`No se puede pasar de «${ETIQUETA_ESTADO[sp.estado as EstadoSubpedido]}» a «${ETIQUETA_ESTADO[a]}»`);
      // Si el cliente ya avisó que llegó, al quedar listo pasa directo a «Cliente llegó»
      const destino: EstadoSubpedido = a === 'listo' && sp.llego_en ? 'cliente_llego' : a;
      const col = { confirmado: 'confirmado_en', preparando: 'preparando_en', listo: 'listo_en' }[a];
      const act = await one<any>(q, `update subpedido set estado = $2, ${col} = now() where id = $1 returning *`, [subpedidoId, destino]);
      await this.notif.crear(q, sp.cliente_id, 'pedido', `Pedido ${sp.codigo}`, `${ETIQUETA_ESTADO[destino]}`, { pedidoId: sp.pedido_id, subpedidoId });
      return { ...act, cliente_id: sp.cliente_id };
    });
    this.rt.aUsuario(r.cliente_id, 'pedido', { subpedidoId, estado: r.estado });
    this.bus.publicar('subpedido.estado', { recintoId: s.recintoId, clienteId: r.cliente_id, subpedidoId, localId: s.localId!, estado: r.estado });
    this.rt.aLocal(s.localId!, 'pedido', { tipo: 'estado', subpedidoId, estado: r.estado });
    return r;
  }

  /** HU-Y15 y HU-Y09: el local valida el QR o el PIN, confirma el nombre y entrega. Caen los puntos. */
  async consultarRetiro(s: Sesion, codigo: string) {
    const sp = await this.buscarRetiro(this.db, s.localId!, codigo);
    return {
      subpedidoId: sp.id,
      pedido: sp.codigo,
      cliente: sp.cliente_nombre,
      estado: sp.estado,
      etiqueta: ETIQUETA_ESTADO[sp.estado as EstadoSubpedido],
      totalBs: Number(sp.total_bs),
      pago: sp.pago,
      comprobanteUrl: sp.comprobante_url,
      items: await many(this.db, 'select nombre, cantidad, precio_bs from subpedido_item where subpedido_id = $1', [sp.id]),
      entregable: ['listo', 'cliente_llego'].includes(sp.estado),
    };
  }

  private async buscarRetiro(q: Queryable, localId: string, codigo: string) {
    const c = codigo.trim().replace(/^PPR:/, '');
    let sp: any;
    if (/^\d{4}$/.test(c)) {
      const lista = await many<any>(
        q,
        `select s.*, p.codigo, p.cliente_id, u.nombre as cliente_nombre from subpedido s join pedido p on p.id = s.pedido_id join usuario u on u.id = p.cliente_id
         where s.local_id = $1 and s.pin = $2 and s.estado in ('recibido','confirmado','preparando','listo','cliente_llego')`,
        [localId, c],
      );
      if (lista.length > 1) throw new BadRequestException('Hay más de un pedido con ese PIN; escanea el QR');
      sp = lista[0];
    } else {
      const [base, firma] = c.split('.');
      if (!base || firmaCorta(base) !== firma) throw new BadRequestException('El código de retiro no es válido');
      sp = await one(
        q,
        `select s.*, p.codigo, p.cliente_id, u.nombre as cliente_nombre from subpedido s join pedido p on p.id = s.pedido_id join usuario u on u.id = p.cliente_id
         where s.codigo_retiro = $1`,
        [c],
      );
      if (sp && sp.local_id !== localId) throw new ForbiddenException('Este código corresponde a otro local');
    }
    if (!sp) throw new NotFoundException('No encontramos un pedido activo con ese código');
    return sp;
  }

  async entregar(s: Sesion, codigo: string) {
    const r = await this.db.tx(async (q) => {
      const sp = await this.buscarRetiro(q, s.localId!, codigo);
      await q.query('select id from subpedido where id = $1 for update', [sp.id]);
      if (!puedeTransicionar(sp.estado, 'entregado')) {
        throw new BadRequestException(`El pedido está «${ETIQUETA_ESTADO[sp.estado as EstadoSubpedido]}»; márcalo como listo antes de entregar`);
      }
      const regla = await this.fidelizacion.reglaVigente(q, s.recintoId);
      const total = Number(sp.total_bs);
      const puntos = Math.floor(total / Number(regla.bs_por_punto));
      // La entrega es una venta identificada: se registra como transacción con origen PaseoYa
      const t = await one<{ id: string }>(
        q,
        `insert into transaccion (clave_idempotencia, recinto_id, cliente_id, local_id, empleado_id, monto_bs, categoria, origen, puntos)
         values ($1,$2,$3,$4,$5,$6,(select c.nombre from local l join categoria c on c.id = l.categoria_id where l.id = $4),'paseoya',$7) returning id`,
        [randomUUID(), s.recintoId, sp.cliente_id, s.localId, s.sub, total, puntos],
      );
      await this.fidelizacion.acreditar(q, {
        recintoId: s.recintoId, clienteId: sp.cliente_id, tipo: 'paseoya', puntos, referenciaId: t!.id, localId: s.localId,
        descripcion: `Retiro PaseoYa ${sp.codigo}`,
      });
      const act = await one<any>(q, `update subpedido set estado = 'entregado', entregado_en = now(), puntos = $2 where id = $1 returning *`, [sp.id, puntos]);
      await this.presencia.marcarCompra(q, s.recintoId, sp.cliente_id, s.localId!);
      await this.telemetria.registrar(q, {
        recintoId: s.recintoId, clienteId: sp.cliente_id, tipo: 'subpedido.entregado', localId: s.localId, payload: { monto_bs: total, puntos },
      });
      await this.notif.crear(q, sp.cliente_id, 'pedido', `Pedido ${sp.codigo} entregado`, `Sumaste ${puntos} pts. Si compras en otro local durante esta visita, también suma.`, {
        pedidoId: sp.pedido_id,
      });
      return { ...act, cliente_id: sp.cliente_id, transaccionId: t!.id, puntos };
    });
    this.rt.aUsuario(r.cliente_id, 'pedido', { subpedidoId: r.id, estado: 'entregado', puntos: r.puntos });
    this.rt.aLocal(s.localId!, 'pedido', { tipo: 'estado', subpedidoId: r.id, estado: 'entregado' });
    this.bus.publicar('subpedido.entregado', { recintoId: s.recintoId, clienteId: r.cliente_id, localId: s.localId!, subpedidoId: r.id, totalBs: Number(r.total_bs) });
    this.bus.publicar('compra.registrada', {
      recintoId: s.recintoId, transaccionId: r.transaccionId, clienteId: r.cliente_id, localId: s.localId!, montoBs: Number(r.total_bs), categoria: null, puntos: r.puntos, origen: 'paseoya',
    });
    return { entregado: true, puntos: r.puntos, subpedidoId: r.id };
  }

  /** Pedidos no retirados dentro del horario pactado pasan a «Vencido» y se libera el stock. */
  async vencerPedidos() {
    const vencidos = await this.db.tx(async (q) => {
      const subs = await many<any>(
        q,
        `select s.id, s.local_id, p.cliente_id from subpedido s join pedido p on p.id = s.pedido_id
         where s.estado in ('recibido','confirmado','preparando','listo','cliente_llego')
           and p.franja_fin < now() - interval '${MINUTOS_GRACIA_RETIRO} minutes' for update of s`,
      );
      for (const s of subs) {
        await q.query(`update subpedido set estado = 'vencido' where id = $1`, [s.id]);
        await q.query(`update producto p set stock = p.stock + i.cantidad from subpedido_item i where i.subpedido_id = $1 and p.id = i.producto_id`, [s.id]);
      }
      return subs;
    });
    for (const s of vencidos) {
      this.rt.aUsuario(s.cliente_id, 'pedido', { subpedidoId: s.id, estado: 'vencido' });
      this.rt.aLocal(s.local_id, 'pedido', { tipo: 'estado', subpedidoId: s.id, estado: 'vencido' });
    }
    if (vencidos.length) this.log.log(`sub-pedidos vencidos: ${vencidos.length}`);
  }

  // ------------------------------------------------------------------ HU-Y16 ventas PaseoYa del local
  async ventasLocal(localId: string, dias = 30) {
    const t = await one(
      this.db,
      `select count(*)::int as pedidos, coalesce(sum(total_bs),0)::numeric(14,2) as total_bs, coalesce(avg(total_bs),0)::numeric(14,2) as ticket_promedio,
              count(*) filter (where estado = 'vencido')::int as vencidos
       from subpedido s join pedido p on p.id = s.pedido_id
       where s.local_id = $1 and p.creado_en > now() - ($2 || ' days')::interval and s.estado in ('entregado','vencido')`,
      [localId, dias],
    );
    const top = await many(
      this.db,
      `select i.nombre, sum(i.cantidad)::int as unidades, sum(i.cantidad * i.precio_bs)::numeric(14,2) as total_bs
       from subpedido_item i join subpedido s on s.id = i.subpedido_id join pedido p on p.id = s.pedido_id
       where s.local_id = $1 and s.estado = 'entregado' and p.creado_en > now() - ($2 || ' days')::interval
       group by i.nombre order by unidades desc limit 10`,
      [localId, dias],
    );
    const tiempos = await one(
      this.db,
      `select round(avg(extract(epoch from (listo_en - p.creado_en)) / 60))::int as minutos_preparacion
       from subpedido s join pedido p on p.id = s.pedido_id where s.local_id = $1 and s.listo_en is not null`,
      [localId],
    );
    return { ...t, ...tiempos, productosMasVendidos: top };
  }

  // ------------------------------------------------------------------ HU-Y19 destacados (admin)
  async destacar(s: Sesion, productoId: string, hasta: string | null) {
    return this.db.tx(async (q) => {
      const p = await one(q, 'update producto set destacado_hasta = $2 where id = $1 returning id, nombre, destacado_hasta', [productoId, hasta]);
      if (!p) throw new NotFoundException('Producto no encontrado');
      await this.auditoria.registrar(q, s.sub, 'destacar_producto', 'producto', productoId, null, p);
      return p;
    });
  }

  todosLosProductos(recintoId: string, q?: string) {
    return many(
      this.db,
      `${this.selectProducto} where l.recinto_id = $1 and ($2::text is null or lower(p.nombre) like $2) order by (p.destacado_hasta >= current_date) desc nulls last, l.nombre, p.nombre limit 300`,
      [recintoId, q ? `%${q.toLowerCase()}%` : null],
    );
  }
}
