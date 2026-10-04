import { describe, expect, it, vi } from 'vitest';
import { CerebroJarvis } from '../src/modules/jarvis/cerebro.js';
import { validarPlan } from '../src/modules/jarvis/comprension.js';
import { limpiarTranscripcion } from '../src/modules/jarvis/oido.service.js';
import { JarvisService } from '../src/modules/integraciones/jarvis.service.js';

describe('Comprensión del mensaje completo', () => {
  it('envía sin truncar mensaje e historial al modelo', async () => {
    const generar = vi.fn().mockResolvedValueOnce(JSON.stringify({preguntas:['Mi saldo'],aclaracion:null})).mockResolvedValueOnce(JSON.stringify({intencion:'saldo'}));
    const motor = {nombre:'prueba', disponible:async()=>true, generar};
    const c = new CerebroJarvis(motor as any, {disponible:async()=>false} as any);
    const mensaje = 'Contexto '.repeat(300) + 'No quiero promociones, dime mi saldo.';
    const plan = await c.comprender('cliente', mensaje, 'Conversación anterior', ['saldo'], {locales:['Tienda real']});
    expect(plan?.consultas[0].intencion).toBe('saldo');
    const payload = JSON.parse(generar.mock.calls[0][1]);
    expect(JSON.stringify(payload)).toContain(mensaje);
    expect(JSON.stringify(payload)).toContain('Conversación anterior');
    expect(JSON.parse(generar.mock.calls[1][1]).pregunta).toBe('Mi saldo');
  });
  it('rechaza herramientas inventadas y respuestas vacías', () => {
    expect(validarPlan({consultas:[{intencion:'borrar_datos',pregunta:'Todo'}],aclaracion:null},['saldo'])).toBeNull();
    expect(validarPlan({consultas:[],aclaracion:null},['saldo'])).toBeNull();
  });
  it('clasifica todas las preguntas extraídas sin permitir que el segundo paso las reescriba', async () => {
    const preguntas = ['Mis puntos disponibles', 'Cuándo vencen mis puntos'];
    const generar = vi.fn().mockResolvedValueOnce(JSON.stringify({preguntas,aclaracion:null})).mockResolvedValueOnce(JSON.stringify({intencion:'saldo'})).mockResolvedValueOnce(JSON.stringify({intencion:'vencimiento'}));
    const c = new CerebroJarvis({nombre:'prueba',disponible:async()=>true,generar} as any,{disponible:async()=>false} as any);
    expect((await c.comprender('cliente','No descuentos. Mis puntos y vencimiento.','',['saldo','vencimiento'],{}))?.consultas.map(q=>q.pregunta)).toEqual(preguntas);
  });
  it('rechaza una clasificación que omite preguntas y no inventa un referente para una aclaración', async () => {
    const generar = vi.fn().mockResolvedValueOnce(JSON.stringify({preguntas:['Saldo','Vencimiento'],aclaracion:null})).mockResolvedValueOnce(JSON.stringify({intencion:'saldo'})).mockResolvedValueOnce(null);
    const c = new CerebroJarvis({nombre:'prueba',disponible:async()=>true,generar} as any,{disponible:async()=>false} as any);
    expect(await c.comprender('cliente','Saldo y vencimiento','',['saldo','vencimiento'],{})).toBeNull();
    generar.mockResolvedValueOnce(JSON.stringify({preguntas:[],aclaracion:'¿Qué producto quieres consultar?'}));
    expect((await c.comprender('cliente','¿Cuánto cuesta?','',['precio'],{}))?.aclaracion).toContain('Qué producto');
    expect(generar).toHaveBeenCalledTimes(4);
  });
  it('ejecuta todas las consultas planeadas, sin elegir solo la primera palabra', async () => {
    const cerebro = {comprender:async()=>({consultas:[{intencion:'saldo',pregunta:'Mi saldo'},{intencion:'vencimiento',pregunta:'Vencimiento de mis puntos'}],aclaracion:null})};
    const saber = {encontrar:async()=>({locales:[],productos:[]}),catalogoConversacion:async()=>({})};
    const memoria = {contexto:()=>({})};
    const j = new (JarvisService as any)(null,null,null,null,null,cerebro,null,saber,memoria,null);
    const manejar = vi.spyOn(j,'manejar').mockImplementation(async (intent:any)=>({texto:intent==='saldo'?'Tienes 50 puntos.':'Vencen el 30 de noviembre.',reescribir:false}));
    const r = await j.consultar('recinto',null,'No busco promociones. Dime mi saldo y cuándo vence.');
    expect(manejar).toHaveBeenCalledTimes(2);
    expect(r.texto).toContain('50 puntos');
    expect(r.texto).toContain('30 de noviembre');
  });
  it('no ejecuta como consulta una aclaración colocada por el modelo en el campo equivocado', async () => {
    const generar = vi.fn().mockResolvedValue(JSON.stringify({preguntas:['¿De qué producto quieres saber el precio?'],aclaracion:null}));
    const c = new CerebroJarvis({nombre:'prueba',disponible:async()=>true,generar} as any,{disponible:async()=>false} as any);
    const plan = await c.comprender('cliente','¿Cuánto cuesta?','',['precio'],{});
    expect(plan?.consultas).toEqual([]);
    expect(plan?.aclaracion).toContain('qué producto');
    expect(generar).toHaveBeenCalledTimes(1);
  });
  it('reduce las opciones según el ámbito y rechaza saltar a una herramienta de otro ámbito', async () => {
    const generar = vi.fn().mockResolvedValueOnce(JSON.stringify({preguntas:['Ventas de esta semana'],aclaracion:null}))
      .mockResolvedValueOnce(JSON.stringify({grupo:'ventas_visitas_y_puntos'})).mockResolvedValueOnce(JSON.stringify({intencion:'inventario'}));
    const c = new CerebroJarvis({nombre:'prueba',disponible:async()=>true,generar} as any,{disponible:async()=>false} as any);
    expect(await c.comprender('admin','Ventas de esta semana','',['inventario','resumen'],{})).toBeNull();
    expect(generar.mock.calls[2][0]).not.toContain('inventario:');
  });
  it('conserva aclaraciones entre paréntesis y solicitudes después de un agradecimiento', () => {
    expect(limpiarTranscripcion('Busco ropa (sin promociones) en el segundo piso.')).toContain('(sin promociones)');
    expect(limpiarTranscripcion('Gracias por ver, ahora dime mis puntos.')).toContain('dime mis puntos');
  });
});

import { RecintoService } from '../src/modules/recinto/recinto.service.js';
import { AsistenteAdmin } from '../src/modules/inteligencia/asistente.service.js';
describe('Mapas e inventario basados en registros', () => {
  const locales = Array.from({length:64},(_,i)=>({id:String(i),nombre:'Negocio '+i,piso:['T','N1','N2','N3'][i%4],numero_local:String(i),activo:true,dias_atencion:[0,1,2,3,4,5,6],horario_apertura:'00:00',horario_cierre:'23:59',coord_x:100+i,coord_y:100}));
  it('la respuesta del administrador incluye todos los nombres sin recortar la tabla', async () => {
    const a = new (AsistenteAdmin as any)({query:async()=>({rows:locales})},null,null,null,null,null);
    const resultado = await a.inventario('r');
    expect(resultado.tabla.filas).toHaveLength(64);
    expect(resultado.texto).toContain('64 locales');
    expect(resultado.texto).toContain('4 niveles');
  });
  it('devuelve los 64 locales y solo los cuatro pisos registrados, con accesos reales', async () => {
    const query = vi.fn(async (sql:string)=>({rows:sql.includes('from local l')?locales:sql.includes('from recinto')?[{id:'r'}]:[]}));
    const recinto = new RecintoService({query} as any,null as any,null as any,null as any);
    const mapa = await recinto.plano('r');
    expect(mapa.locales).toHaveLength(64);
    expect(mapa.pisos.map(p=>p.id)).toEqual(['T','N1','N2','N3']);
    expect(mapa.entradas).toEqual([]);
    expect(query.mock.calls.every((c)=>! /insert|update|delete/i.test(c[0]))).toBe(true);
  });
});

import { OidoJarvis } from '../src/modules/jarvis/oido.service.js';
describe('Audio completo', () => {
  function wav(segundos:number) {
    const muestras=16000*segundos;
    const b=Buffer.alloc(44+muestras*2);
    b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(muestras*2,40);
    for(let i=0;i<muestras;i++)b.writeInt16LE(Math.round(Math.sin(i/10)*2000),44+i*2);
    return b;
  }
  it('decodifica los 45 segundos y no corta a los 30', async()=>{
    const o=new OidoJarvis();
    const pcm=await (o as any).decodificar(wav(45));
    expect(pcm.length/16000).toBe(45);
  });
  it('rechaza audio mayor de dos minutos en vez de transcribir solo el inicio',async()=>{
    const o=new OidoJarvis();
    await expect(o.transcribir(wav(121))).rejects.toThrow('no se procesó parcialmente');
  });
});


describe('Continuidad y respuestas precisas', () => {
  const vacias = {locales:[],productos:[],categoria:null,actividad:null,servicio:null,ev:{info:[]}};
  function admin(consultas:any[], hilo:any[]=[]) {
    const memoria = {hilo:async()=>hilo,contexto:()=>({localId:'anterior',periodo:'ayer'}),guardar:vi.fn()};
    const cerebro = {comprender:async()=>({consultas,aclaracion:null}),redactar:async(texto:string)=>({texto})};
    const saber = {catalogoConversacion:async()=>({}),encontrar:async(t:string,p:string)=>({...vacias,locales:p.includes('Tienda B')||p.includes('tienda b')?[{id:'b'}]:[]})};
    const a = new (AsistenteAdmin as any)(null,cerebro,saber,memoria,null,null);
    vi.spyOn(a,'fueraDeCobertura').mockResolvedValue(null);
    return {a,memoria};
  }
  it('recuerda el local resuelto en la pregunta, sin guardar el nombre descartado', async()=>{
    const {a,memoria}=admin([{intencion:'local',pregunta:'Ventas de Tienda B ayer'}]);
    const manejar=vi.spyOn(a,'manejar').mockResolvedValue({texto:'Ventas verificadas: Bs 50.'});
    await a.preguntar({sub:'u',recintoId:'r'},'No Tienda A; quería las ventas de Tienda B ayer');
    expect((manejar.mock.calls[0][1] as any).localId).toBe('b');
    expect(memoria.guardar.mock.calls[1][4].localId).toBe('b');
    expect(memoria.guardar.mock.calls[1][5].consultas[0].pregunta).toContain('Tienda B');
  });
  it('un fallo en una pregunta no descarta las otras respuestas',async()=>{
    const {a}=admin([{intencion:'inventario',pregunta:'Negocios por piso'},{intencion:'ranking',pregunta:'Ranking'}]);
    vi.spyOn(a,'manejar').mockImplementation(async(i:any)=>{if(i==='ranking')throw Error('desconectado');return {texto:'Hay 64 negocios.'};});
    const r=await a.preguntar({sub:'u',recintoId:'r'},'Negocios por piso y ranking');
    expect(r.secciones).toHaveLength(2);
    expect(r.texto).toContain('64 negocios');
    expect(r.texto).toContain('No pude consultar esta parte');
  });
  it('no convierte una fecha exacta o un intervalo en un año entero',()=>{
    const a=new (AsistenteAdmin as any)(null,null,null,null,null,null);
    expect(a.periodo('ventas del 2026-02-03').desde).toBe('2026-02-03');
    expect(a.periodo('ventas del 2026-02-03').hasta).toBe('2026-02-03');
    expect(a.periodo('ventas del 3 de febrero de 2026').desde).toBe('2026-02-03');
    const rango=a.periodo('del 2026-02-03 al 2026-02-06');
    expect(a.periodo('ticket',rango.clave).hasta).toBe('2026-02-06');
    expect(()=>a.periodo('ventas del 2026-02-30')).toThrow('no es válida');
    expect(()=>a.periodo('del 2026-02-06 al 2026-02-03')).toThrow('anterior');
  });
  it('no responde un ranking cuando el negocio solicitado falta',async()=>{
    const {a}=admin([]);
    const r=await a.manejar('local',{s:{recintoId:'r'},periodo:a.periodo('ayer')});
    expect(r.texto).toContain('qué negocio');
  });
  it('una pregunta desconocida no se reemplaza por productos solo porque nombra un local',async()=>{
    const j = new (JarvisService as any)(...Array(10).fill(null));
    const r=await j.libre({original:'¿Cuántas calorías tiene la pizza de Tienda B?',ent:{...vacias,locales:[{id:'b'}]}});
    expect(r.texto).toContain('calorías');
    expect(r.texto).not.toContain('Puedo ayudarte con promociones');
    expect(r.productos).toBeUndefined();
  });
});


it('consultar todo el Paseo no hereda el negocio de una pregunta anterior',async()=>{
  const memoria={hilo:async()=>[],contexto:()=>({localId:'anterior'}),guardar:vi.fn()};
  const cerebro={comprender:async()=>({consultas:[{intencion:'metrica',pregunta:'Visitas del Paseo hoy'}],aclaracion:null}),redactar:async(texto:string)=>({texto})};
  const saber={catalogoConversacion:async()=>({}),encontrar:async()=>({locales:[],categoria:null})};
  const a=new (AsistenteAdmin as any)(null,cerebro,saber,memoria,null,null);
  vi.spyOn(a,'fueraDeCobertura').mockResolvedValue(null);
  const manejar=vi.spyOn(a,'manejar').mockResolvedValue({texto:'Hay 32 visitas.'});
  await a.preguntar({sub:'u',recintoId:'r'},'¿Visitas del Paseo hoy?');
  expect((manejar.mock.calls[0][1] as any).localId).toBeUndefined();
  expect(memoria.guardar.mock.calls[1][4].ambito).toBe('paseo');
});
