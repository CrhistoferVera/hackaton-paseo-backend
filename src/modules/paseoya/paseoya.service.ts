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

import { fechaRetail, precioVariantes, type GrupoVariante } from './domain/variantes.js';

export interface ItemPedido {
  productoId: string;
  cantidad: number;
  dropId?: string | null;
  varianteId?: string;
  varianteIds?: string[];
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
  variantes?: GrupoVariante[];
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
      `select c.*, (select count(*)::int from producto p join local l on l.id = p.local_id where p.categoria_id = c.id and p.activo and l.activo and (p.stock > 0 or exists (select 1 from producto_variante v where v.producto_id=p.id and v.activo and v.stock>0))) as productos
       from categoria c where ($1::text is null or c.ambito = $1) order by c.orden, c.nombre`,
      [ambito === 'retail' ? 'tiendas' : ambito ?? null],
    );
  }

  private readonly selectProducto = `select p.id, p.nombre, p.descripcion, p.precio_bs, coalesce((select min(gs.stock)::int from
      (select coalesce(sum(v.stock) filter (where v.activo),0) stock from producto_grupo_variante g
       left join producto_variante v on v.grupo_id=g.id where g.producto_id=p.id and g.activo group by g.id) gs),p.stock) as stock, p.foto_url, p.destacado_hasta, p.categoria_id, p.tiempo_preparacion_min, p.etiquetas,
      c.nombre as categoria, c.ambito, l.id as local_id, l.nombre as local, l.descripcion as local_descripcion, l.foto_url as local_foto_url, l.banner_url as local_banner_url, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y,
      l.horario_apertura, l.horario_cierre
    from producto p join local l on l.id = p.local_id join categoria c on c.id = p.categoria_id`;

  async locales(recintoId: string, f?: { ambito?: string; categoriaId?: string }) {
    const amb = f?.ambito === 'retail' ? 'tiendas' : f?.ambito ?? null;
    return many(
      this.db,
      `select l.id, l.nombre, l.descripcion, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y,
              l.horario_apertura, l.horario_cierre, l.foto_url, l.banner_url, l.activo,
              c.id as categoria_id, c.nombre as categoria, c.ambito,
              (select count(*)::int from producto p where p.local_id = l.id and p.activo and
                (p.stock > 0 or exists (select 1 from producto_variante v where v.producto_id = p.id and v.activo and v.stock > 0))) as total_productos
       from local l
       join categoria c on c.id = l.categoria_id
       where l.recinto_id = $1 and l.activo
         and ($2::text is null or c.ambito = $2)
         and ($3::uuid is null or c.id = $3)
       order by (select count(*)::int from producto p where p.local_id = l.id and p.activo) desc, l.nombre`,
      [recintoId, amb, f?.categoriaId ?? null],
    );
  }

  async promocionesPaseoYa(recintoId: string, tipo?: 'food' | 'shop') {
    return many(
      this.db,
      `select pr.id, pr.titulo, pr.imagen_url, pr.tipo, pr.negocio_id, pr.activo, pr.orden, pr.fecha_inicio, pr.fecha_fin, pr.created_at,
              l.nombre as negocio_nombre, l.piso as negocio_piso
       from promociones pr
       left join local l on l.id = pr.negocio_id
       where pr.activo = true
         and ($1::text is null or pr.tipo = $1)
         and (pr.fecha_inicio is null or pr.fecha_inicio <= now())
         and (pr.fecha_fin is null or pr.fecha_fin >= now())
       order by pr.orden asc, pr.created_at desc`,
      [tipo ?? null],
    );
  }

  async productos(recintoId: string, f: { categoriaId?: string; ambito?: string; localId?: string }, clienteId: string | null) {
    const filas = await many(
      this.db,
      `${this.selectProducto}
       where l.recinto_id = $1 and p.activo and l.activo
         and ($2::uuid is null or p.categoria_id = $2) and ($3::text is null or c.ambito = $3) and ($4::uuid is null or l.id = $4)
       order by (p.destacado_hasta >= current_date) desc nulls last, p.nombre limit 200`,
      [recintoId, f.categoriaId ?? null, f.ambito === 'retail' ? 'tiendas' : f.ambito ?? null, f.localId ?? null],
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
    return { ...p, tipo: (p as any).ambito === 'comida' ? 'comida' : 'retail', variantes: await this.leerVariantes(this.db, id), favorito: !!favorito };
  }

  // ------------------------------------------------------------------ pedidos del cliente (HU-Y04 a Y09, Y11)
  async crearPedido(
    recintoId: string,
    clienteId: string,
    d: { items: ItemPedido[]; tipo?: 'comida' | 'retail'; fechaEstimadaRetiro?: string; fecha_estimada_retiro?: string; pago: 'en_local' | 'qr_anticipado' },
  ) {
    if (!d.items.length) throw new BadRequestException('Tu carrito está vacío');
    const r = await this.db.tx(async (q) => {
      const prods = await many<any>(q,
        `select p.*, c.ambito, l.nombre as local, l.activo as local_activo from producto p
         join local l on l.id=p.local_id join categoria c on c.id=p.categoria_id
         where p.id=any($1::uuid[]) and l.recinto_id=$2 order by p.id for update of p`,
        [d.items.map(i => i.productoId), recintoId]);
      const tipos = new Set(prods.map(p => p.ambito === 'comida' ? 'comida' : 'retail'));
      if (tipos.size > 1) throw new BadRequestException('No se pueden combinar productos de comida y retail en un mismo pedido');
      const tipo = prods[0]?.ambito === 'comida' ? 'comida' : 'retail';
      if (d.tipo && d.tipo !== tipo) throw new BadRequestException('El tipo del pedido no corresponde a sus productos');
      const fecha = tipo === 'retail' ? fechaRetail(d.fechaEstimadaRetiro ?? d.fecha_estimada_retiro) : null;
      const mapa = new Map(prods.map(p => [p.id,p]));
      type Linea = ItemPedido & { precio: number; nombre: string; detalle: string; variantes: any[] };
      const porLocal = new Map<string, { items: Linea[]; minutos: number | null }>();
      for (const it of d.items) {
        if (!Number.isInteger(it.cantidad) || it.cantidad < 1 || it.cantidad > 20) throw new BadRequestException('Cantidad no válida');
        const p = mapa.get(it.productoId);
        if (!p || !p.activo || !p.local_activo) throw new BadRequestException('Un producto del carrito ya no está disponible');
        const grupos = await this.leerVariantes(q, p.id);
        const ids = it.varianteIds ?? (it.varianteId ? [it.varianteId] : []);
        if (new Set(ids).size !== ids.length) throw new BadRequestException('No repitas una variante');
        const opciones = grupos.flatMap(g => g.opciones);
        const elegidas = ids.map(id => opciones.find(v => v.id === id));
        if (elegidas.some(v => !v || !v.activo) || grupos.some(g => elegidas.filter(v => v?.grupo_id === g.id).length !== 1) || ids.length !== grupos.length) {
          throw new BadRequestException('Selecciona una opción disponible de cada grupo de variantes');
        }
        let precio = precioVariantes(Number(p.precio_bs), elegidas);
        if (precio < 0) throw new BadRequestException('La combinación de precios de variantes no es válida');
        if (it.dropId) {
          const drop = await one<any>(q, `select d.precio_especial from drop_espacial d join reclamo_drop r on r.drop_id=d.id
            where d.id=$1 and d.producto_id=$2 and r.cliente_id=$3 and not r.usado and d.fin>now() for update of r`, [it.dropId,p.id,clienteId]);
          if (!drop) throw new BadRequestException('El precio especial del Drop ya no está disponible');
          precio = Math.round((precio + Number(drop.precio_especial) - Number(p.precio_bs))*100)/100;
          if (precio < 0) throw new BadRequestException('El Drop no es compatible con estas variantes');
          await q.query('update reclamo_drop set usado=true where drop_id=$1 and cliente_id=$2',[it.dropId,clienteId]);
        }
        // El UPDATE condicional evita sobreventas incluso con líneas repetidas.
        if (elegidas.length) {
          for (const v of elegidas) {
            const stock = await one(q, 'update producto_variante set stock=stock-$2 where id=$1 and stock >= $2 returning id',[v.id,it.cantidad]);
            if (!stock) throw new BadRequestException(`Stock insuficiente para ${p.nombre}: ${v.nombre}`);
          }
        } else {
          const stock = await one(q,'update producto set stock=stock-$2 where id=$1 and stock >= $2 returning id',[p.id,it.cantidad]);
          if (!stock) throw new BadRequestException(`Stock insuficiente para ${p.nombre}`);
        }
        const g = porLocal.get(p.local_id) ?? { items: [], minutos: null };
        if (p.tiempo_preparacion_min != null) g.minutos = Math.max(g.minutos ?? 0, p.tiempo_preparacion_min);
        g.items.push({ ...it, precio, nombre:p.nombre, variantes:elegidas,
          detalle: grupos.map(g => `${g.titulo}: ${elegidas.find(v => v.grupo_id === g.id).nombre}`).join(' | ') });
        porLocal.set(p.local_id,g);
      }
      if (d.pago === 'qr_anticipado' && porLocal.size > 1) throw new BadRequestException('El pago anticipado por QR solo está disponible para pedidos de un solo local');
      const total = [...porLocal.values()].reduce((a,g) => a+g.items.reduce((b,i) => b+i.precio*i.cantidad,0),0);
      const pedido = await one<any>(q, 'insert into pedido (recinto_id,codigo,cliente_id,total_bs,tipo,fecha_estimada_retiro) values ($1,$2,$3,$4,$5,$6) returning *',
        [recintoId,`P-${codigoLegible(6)}`,clienteId,total,tipo,fecha]);
      const avisos: { localId: string; subpedidoId: string }[] = [];
      for (const [localId,g] of porLocal) {
        const base = codigoLegible(8);
        const sub = g.items.reduce((a,i) => a+i.precio*i.cantidad,0);
        const sp = await one<any>(q, 'insert into subpedido (pedido_id,local_id,total_bs,codigo_retiro,pin,pago,tiempo_preparacion_min) values ($1,$2,$3,$4,$5,$6,$7) returning *',
          [pedido.id,localId,sub,`${base}.${firmaCorta(base)}`,pinNumerico(4),d.pago,tipo === 'comida' ? g.minutos : null]);
        for (const i of g.items) {
          const item = await one<any>(q, 'insert into subpedido_item (subpedido_id,producto_id,nombre,cantidad,precio_bs,drop_id,variante_id,variante_detalle) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
            [sp.id,i.productoId,i.nombre,i.cantidad,i.precio,i.dropId ?? null,i.variantes[0]?.id ?? null,i.detalle || null]);
          for (const v of i.variantes) await q.query('insert into subpedido_item_variante (item_id,variante_id) values ($1,$2)',[item.id,v.id]);
        }
        avisos.push({localId,subpedidoId:sp.id});
        await this.telemetria.registrar(q,{recintoId,clienteId,tipo:'pedido.creado',localId,payload:{total_bs:sub,items:g.items.length}});
      }
      const regla = await this.fidelizacion.reglaVigente(q,recintoId);
      return { pedidoId:pedido.id,codigo:pedido.codigo,totalBs:total,puntosEstimados:Math.floor(total/Number(regla.bs_por_punto)),avisos };
    });
    // Publicar solamente después del commit: nunca anunciar pedidos revertidos.
    for (const aviso of r.avisos) this.rt.aLocal(aviso.localId,'pedido',{tipo:'nuevo',subpedidoId:aviso.subpedidoId});
    this.bus.publicar('pedido.creado',{recintoId,clienteId,pedidoId:r.pedidoId});
    const { avisos: _, ...resultado } = r;
    return { ...resultado, detalle:await this.pedido(clienteId,r.pedidoId) };
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
      s.items = await many(this.db, `select i.*, coalesce((select json_agg(v.variante_id) from subpedido_item_variante v where v.item_id=i.id),'[]') as variante_ids from subpedido_item i where subpedido_id=$1`, [s.id]);
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
         and s.estado in ('recibido','confirmado','preparando','listo') and (p.tipo='comida' or p.fecha_estimada_retiro >= (now() at time zone 'America/La_Paz')::date)
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
    const resultado: any[] = [];
    for (const sp of p.subpedidos) for (const i of sp.items) {
      const producto = await one<any>(this.db,`${this.selectProducto} where p.id=$1 and p.activo and l.activo`,[i.producto_id]);
      if (!producto) continue;
      const grupos = await this.leerVariantes(this.db,producto.id);
      const opciones = grupos.flatMap(g => g.opciones).filter(v => i.variante_ids.includes(v.id));
      if (opciones.length !== i.variante_ids.length || grupos.some(g => opciones.filter(v => v.grupo_id===g.id).length!==1)) continue;
      const stock = opciones.length ? Math.min(...opciones.map(v => v.stock)) : producto.stock;
      if (stock < 1) continue;
      const precioBs = precioVariantes(Number(producto.precio_bs),opciones);
      if (precioBs < 0) continue;
      resultado.push({ productoId:producto.id,producto,cantidad:Math.min(i.cantidad,stock),varianteIds:i.variante_ids,
        varianteDetalle:grupos.map(g => `${g.titulo}: ${opciones.find(v => v.grupo_id===g.id).nombre}`).join(' | '),precioBs });
    }
    return resultado;
  }

  // ------------------------------------------------------------------ local: productos (HU-Y13)
  private async leerVariantes(q: Queryable, productoId: string) {
    const grupos = await many<any>(q,'select * from producto_grupo_variante where producto_id=$1 and activo order by orden,id',[productoId]);
    const opciones = await many<any>(q,'select * from producto_variante where producto_id=$1 and activo order by nombre,id',[productoId]);
    return grupos.map(g => ({...g,opciones:opciones.filter(v => v.grupo_id===g.id)}));
  }

  async variantesDelLocal(s: Sesion, id: string) {
    if (!await one(this.db,'select id from producto where id=$1 and local_id=$2',[id,s.localId])) throw new NotFoundException('Producto no encontrado en tu local');
    return this.leerVariantes(this.db,id);
  }

  async guardarVariantes(s: Sesion, id: string, grupos: GrupoVariante[]) {
    return this.db.tx(async q => {
      if (!await one(q,'select id from producto where id=$1 and local_id=$2 for update',[id,s.localId])) throw new NotFoundException('Producto no encontrado en tu local');
      await this.escribirVariantes(q,id,grupos);
      return this.leerVariantes(q,id);
    });
  }

  private async escribirVariantes(q: Queryable, productoId: string, grupos: GrupoVariante[]) {
    const ids = new Set<string>();
    for (const g of grupos) for (const id of [g.id,...g.opciones.map(v => v.id)].filter(Boolean) as string[]) {
      if (ids.has(id)) throw new BadRequestException('Identificador de variante repetido');
      ids.add(id);
    }
    // Desactivar en lugar de borrar mantiene las referencias de pedidos históricos.
    await q.query('update producto_grupo_variante set activo=false where producto_id=$1',[productoId]);
    await q.query('update producto_variante set activo=false where producto_id=$1',[productoId]);
    for (const [orden,g] of grupos.entries()) {
      const grupoId = g.id ?? randomUUID();
      if (g.id) {
        if (!await one(q,'update producto_grupo_variante set titulo=$3,orden=$4,activo=true where id=$1 and producto_id=$2 returning id',[g.id,productoId,g.titulo,orden])) throw new BadRequestException('El grupo no pertenece al producto');
      } else await q.query('insert into producto_grupo_variante (id,producto_id,titulo,orden) values ($1,$2,$3,$4)',[grupoId,productoId,g.titulo,orden]);
      for (const v of g.opciones) {
        if (v.id) {
          if (!await one(q,'update producto_variante set nombre=$4,stock=$5,precio_bs=$6,foto_url=$7,activo=$8 where id=$1 and grupo_id=$2 and producto_id=$3 returning id',
            [v.id,grupoId,productoId,v.nombre,v.stock,v.precioBs ?? null,v.fotoUrl ?? null,v.activo ?? true])) throw new BadRequestException('La opción no pertenece a este grupo');
        } else await q.query('insert into producto_variante (grupo_id,producto_id,nombre,stock,precio_bs,foto_url,activo) values ($1,$2,$3,$4,$5,$6,$7)',
          [grupoId,productoId,v.nombre,v.stock,v.precioBs ?? null,v.fotoUrl ?? null,v.activo ?? true]);
      }
    }
  }

  async productosDelLocal(localId: string) {
    const productos = await many<any>(this.db, `select p.*, c.nombre as categoria from producto p join categoria c on c.id = p.categoria_id where p.local_id = $1 order by p.activo desc, p.nombre`, [localId]);
    return Promise.all(productos.map(async p => ({...p,variantes:await this.leerVariantes(this.db,p.id)})));
  }

  private async validarCategoria(q: Queryable, localId: string | undefined, categoriaId: string) {
    if (!await one(q, 'select 1 from local l join categoria lc on lc.id=l.categoria_id join categoria pc on pc.id=$2 where l.id=$1 and lc.ambito=pc.ambito',[localId,categoriaId])) {
      throw new BadRequestException('La categoría debe pertenecer al mismo ámbito que el comercio');
    }
  }

  async crearProducto(s: Sesion, d: DatosProducto) {
    if (!s.localId) throw new ForbiddenException('Tu usuario no está asignado a un local');
    return this.db.tx(async q => {
    await this.validarCategoria(q,s.localId,d.categoriaId);
    const p = await one<any>(
      q,
      `insert into producto (local_id, nombre, descripcion, precio_bs, stock, categoria_id, foto_url, activo, tiempo_preparacion_min, etiquetas)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [s.localId, d.nombre, d.descripcion ?? '', d.precioBs, d.stock, d.categoriaId, d.fotoUrl ?? null, d.activo ?? true, d.tiempoPreparacionMin ?? null, d.etiquetas ?? []],
    );
    if (d.variantes) await this.escribirVariantes(q,p.id,d.variantes);
    return p;
    });
  }

  async actualizarProducto(s: Sesion, id: string, d: Partial<DatosProducto>) {
    return this.db.tx(async q => {
    if (d.categoriaId) await this.validarCategoria(q,s.localId,d.categoriaId);
    const p = await one(
      q,
      `update producto set nombre = coalesce($3,nombre), descripcion = coalesce($4,descripcion), precio_bs = coalesce($5,precio_bs),
         stock = coalesce($6,stock), categoria_id = coalesce($7,categoria_id), foto_url = coalesce($8,foto_url), activo = coalesce($9,activo),
         tiempo_preparacion_min = case when $10::boolean then $11::int else tiempo_preparacion_min end, etiquetas = coalesce($12,etiquetas)
       where id = $1 and local_id = $2 returning *`,
      [id, s.localId, d.nombre ?? null, d.descripcion ?? null, d.precioBs ?? null, d.stock ?? null, d.categoriaId ?? null, d.fotoUrl ?? null, d.activo ?? null,
        d.tiempoPreparacionMin !== undefined, d.tiempoPreparacionMin ?? null, d.etiquetas ?? null],
    );
    if (!p) throw new NotFoundException('Producto no encontrado en tu local');
    if (d.variantes) await this.escribirVariantes(q,id,d.variantes);
    return p;
    });
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
      `select s.*, p.codigo as pedido, p.tipo, p.fecha_estimada_retiro, p.franja_inicio, p.franja_fin, p.creado_en, u.nombre as cliente
       from subpedido s join pedido p on p.id = s.pedido_id join usuario u on u.id = p.cliente_id
       where s.local_id = $1 and ($2::text is null or s.estado = $2)
         and (s.estado not in ('entregado','vencido') or p.creado_en > now() - interval '2 days')
       order by case s.estado when 'cliente_llego' then 0 when 'recibido' then 1 when 'confirmado' then 2 when 'preparando' then 3 when 'listo' then 4 else 5 end, p.creado_en`,
      [localId, estado ?? null],
    );
    for (const s of subs) {
      s.items = await many(this.db, 'select id, nombre, cantidad, precio_bs, variante_detalle from subpedido_item where subpedido_id = $1', [s.id]);
      s.cliente = enmascararNombre(s.cliente);
      s.etiqueta = ETIQUETA_ESTADO[s.estado as EstadoSubpedido];
      delete s.pin;
      delete s.codigo_retiro;
    }
    return subs;
  }

  async avanzar(s: Sesion, subpedidoId: string, a: 'confirmado' | 'preparando' | 'listo', tiempoPreparacionMin?: number) {
    const r = await this.db.tx(async (q) => {
      const sp = await one<any>(
        q,
        `select s.*, p.cliente_id, p.codigo, p.tipo from subpedido s join pedido p on p.id = s.pedido_id where s.id = $1 and s.local_id = $2 for update of s`,
        [subpedidoId, s.localId],
      );
      if (!sp) throw new NotFoundException('Pedido no encontrado en tu local');
      if (!(sp.tipo === 'retail' && a === 'listo' && ['recibido','confirmado','preparando'].includes(sp.estado)) && !puedeTransicionar(sp.estado, a)) throw new BadRequestException(`No se puede pasar de «${ETIQUETA_ESTADO[sp.estado as EstadoSubpedido]}» a «${ETIQUETA_ESTADO[a]}»`);
      // Si el cliente ya avisó que llegó, al quedar listo pasa directo a «Cliente llegó»
      const destino: EstadoSubpedido = a === 'listo' && sp.llego_en ? 'cliente_llego' : a;
      const col = { confirmado: 'confirmado_en', preparando: 'preparando_en', listo: 'listo_en' }[a];
      const act = await one<any>(q, `update subpedido set estado = $2, ${col} = now(), tiempo_preparacion_min=coalesce($3,tiempo_preparacion_min) where id = $1 returning *`, [subpedidoId, destino, sp.tipo === 'comida' ? tiempoPreparacionMin ?? null : null]);
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
      items: await many(this.db, 'select id, nombre, cantidad, precio_bs, variante_detalle from subpedido_item where subpedido_id = $1', [sp.id]),
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
           and p.tipo='retail' and p.fecha_estimada_retiro < (now() at time zone 'America/La_Paz')::date for update of s`,
      );
      for (const s of subs) {
        await q.query(`update subpedido set estado = 'vencido' where id = $1`, [s.id]);
        await q.query(`update producto p set stock=p.stock+x.cantidad from (select producto_id,sum(cantidad)::int cantidad from subpedido_item where subpedido_id=$1 and variante_id is null group by producto_id) x where p.id=x.producto_id`,[s.id]);
        await q.query(`update producto_variante v set stock=v.stock+x.cantidad from (select iv.variante_id,sum(i.cantidad)::int cantidad from subpedido_item i join subpedido_item_variante iv on iv.item_id=i.id where i.subpedido_id=$1 group by iv.variante_id) x where v.id=x.variante_id`,[s.id]);
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
