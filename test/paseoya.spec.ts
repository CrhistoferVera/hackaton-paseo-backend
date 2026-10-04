import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { MIGRACIONES } from '../src/infra/db/migraciones.js';
import { PaseoYaService } from '../src/modules/paseoya/paseoya.service.js';
import { fechaRetail } from '../src/modules/paseoya/domain/variantes.js';

const hoy = () => new Date(Date.now()-4*3600_000).toISOString().slice(0,10);
describe('Pedidos y variantes con PostgreSQL embebido', () => {
  let pg: PGlite, svc: PaseoYaService, recinto: string, cliente: string, comida: any, retail: any, sesion: any;
  const rt = {aLocal:vi.fn(),aUsuario:vi.fn()};
  const bus = {publicar:vi.fn()};
  const fila = async (sql: string, params: unknown[] = []) => (await pg.query<any>(sql,params)).rows[0];
  beforeAll(async () => {
    pg = new PGlite();
    for (const m of MIGRACIONES) await pg.exec(m.sql);
    recinto = (await fila("insert into recinto(nombre,lat,lng) values ('Test',0,0) returning id")).id;
    cliente = (await fila("insert into usuario(recinto_id,rol,nombre) values ($1,'cliente','Cliente') returning id",[recinto])).id;
    const db = {query:pg.query.bind(pg),tx:(fn: any) => pg.transaction(fn)};
    svc = new PaseoYaService(db as any,{reglaVigente:async()=>({bs_por_punto:1})} as any,{} as any,{} as any,{registrar:async()=>{}} as any,{crear:async()=>{}} as any,{} as any,rt as any,bus as any);
    for (const ambito of ['comida','tiendas']) {
      const cat = await fila('insert into categoria(nombre,ambito) values ($1,$1) returning id',[ambito]);
      const local = await fila("insert into local(recinto_id,nombre,categoria_id,piso,sector,numero_local,coord_x,coord_y,codigo_puerta) values ($1,$2,$3,'N1','A',$2,0,0,$2) returning id",[recinto,ambito,cat.id]);
      const producto = await fila("insert into producto(local_id,nombre,precio_bs,stock,categoria_id,tiempo_preparacion_min) values ($1,$2,100,10,$3,20) returning *",[local.id,ambito,cat.id]);
      if (ambito==='comida') comida=producto;
      else { retail=producto; sesion={sub:cliente,recintoId:recinto,localId:local.id,rol:'comercio'}; }
    }
  },30000);
  afterAll(async()=>{await pg?.close();});
  it('rechaza mezcla con 400 antes de descontar inventario o emitir eventos',async()=>{
    rt.aLocal.mockClear();
    await expect(svc.crearPedido(recinto,cliente,{items:[{productoId:comida.id,cantidad:1},{productoId:retail.id,cantidad:1}],pago:'en_local'})).rejects.toMatchObject({status:400,message:'No se pueden combinar productos de comida y retail en un mismo pedido'});
    expect((await fila('select stock from producto where id=$1',[comida.id])).stock).toBe(10);
    expect(rt.aLocal).not.toHaveBeenCalled();
  });
  it('comida entra inmediatamente, sin franjas, con estimación y evento',async()=>{
    const p=await svc.crearPedido(recinto,cliente,{items:[{productoId:comida.id,cantidad:1}],pago:'en_local'});
    expect(p.detalle).toMatchObject({tipo:'comida',franja_inicio:null,franja_fin:null});
    expect(p.detalle.subpedidos[0]).toMatchObject({estado:'recibido',tiempo_preparacion_min:20});
    expect(rt.aLocal).toHaveBeenCalledWith(comida.local_id,'pedido',expect.objectContaining({tipo:'nuevo'}));
    const s={...sesion,localId:comida.local_id};
    await svc.avanzar(s,p.detalle.subpedidos[0].id,'confirmado',35);
    expect((await svc.pedido(cliente,p.pedidoId)).subpedidos[0].tiempo_preparacion_min).toBe(35);
    await svc.avanzar(s,p.detalle.subpedidos[0].id,'preparando');
    await svc.avanzar(s,p.detalle.subpedidos[0].id,'listo');
    expect(rt.aUsuario).toHaveBeenCalledWith(cliente,'pedido',expect.objectContaining({estado:'listo'}));
  });
  it('rechaza fecha ausente y cantidades acumuladas que exceden el stock; revierte todo',async()=>{
    await expect(svc.crearPedido(recinto,cliente,{items:[{productoId:retail.id,cantidad:1}],pago:'en_local'})).rejects.toMatchObject({status:400});
    await expect(svc.crearPedido(recinto,cliente,{items:[{productoId:comida.id,cantidad:8},{productoId:comida.id,cantidad:8}],pago:'en_local'})).rejects.toMatchObject({status:400});
    expect((await fila('select stock from producto where id=$1',[comida.id])).stock).toBe(9);
  });
  it('valida propiedad de variantes y todas las dimensiones',async()=>{
    await svc.guardarVariantes(sesion,retail.id,[{titulo:'Talla',opciones:[{nombre:'M',stock:5}]},{titulo:'Color',opciones:[{nombre:'Azul',stock:3,precioBs:120,fotoUrl:'/uploads/azul.png'}]}]);
    const g=await svc.variantesDelLocal(sesion,retail.id);
    await expect(svc.guardarVariantes({...sesion,localId:comida.local_id},retail.id,[])).rejects.toMatchObject({status:404});
    await expect(svc.crearPedido(recinto,cliente,{items:[{productoId:retail.id,cantidad:1,varianteIds:[g[0].opciones[0].id]}],fechaEstimadaRetiro:hoy(),pago:'en_local'})).rejects.toMatchObject({status:400});
  });
  it('reserva talla + color, conserva historia, empaqueta y restituye stock una sola vez',async()=>{
    const g=await svc.variantesDelLocal(sesion,retail.id);
    const ids=g.map(x=>x.opciones[0].id);
    const catalogo=await svc.producto(recinto,retail.id,null);
    expect(catalogo.stock).toBe(3);
    expect(catalogo.variantes[1].opciones[0].foto_url).toBe('/uploads/azul.png');
    const p=await svc.crearPedido(recinto,cliente,{items:[{productoId:retail.id,cantidad:2,varianteIds:ids}],fechaEstimadaRetiro:hoy(),pago:'en_local'});
    expect(p.totalBs).toBe(240);
    expect(p.detalle.subpedidos[0].items[0]).toMatchObject({variante_detalle:'Talla: M | Color: Azul',variante_ids:expect.arrayContaining(ids)});
    expect((await fila('select stock from producto where id=$1',[retail.id])).stock).toBe(10);
    expect((await fila('select stock from producto_variante where id=$1',[ids[1]])).stock).toBe(1);
    await svc.avanzar(sesion,p.detalle.subpedidos[0].id,'listo');
    const recompra=await svc.repetir(cliente,p.pedidoId);
    expect(recompra[0]).toMatchObject({precioBs:120,varianteIds:expect.arrayContaining(ids),cantidad:1});
    await svc.guardarVariantes(sesion,retail.id,[]);
    expect((await svc.pedido(cliente,p.pedidoId)).subpedidos[0].items[0].variante_detalle).toBe('Talla: M | Color: Azul');
    await pg.query("update pedido set fecha_estimada_retiro=((now() at time zone 'America/La_Paz')::date-1) where id=$1",[p.pedidoId]);
    await svc.vencerPedidos(); await svc.vencerPedidos();
    expect((await fila('select stock from producto_variante where id=$1',[ids[1]])).stock).toBe(3);
    expect((await svc.pedido(cliente,p.pedidoId)).subpedidos[0].estado).toBe('vencido');
  });
});
describe('Tres días calendario en Bolivia',()=>{
  const ahora=new Date('2026-10-04T02:00:00Z'); // Todavía es 3 de octubre en Bolivia.
  it.each(['2026-10-03','2026-10-04','2026-10-05'])('acepta %s',d=>expect(fechaRetail(d,ahora)).toBe(d));
  it.each([undefined,'2026-10-02','2026-10-06','2026-02-30','2026-10-03T00:00:00Z'])('rechaza %s',d=>expect(()=>fechaRetail(d,ahora)).toThrow());
});
