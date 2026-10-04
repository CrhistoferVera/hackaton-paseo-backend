import { describe, expect, it, vi } from 'vitest';
import { CerebroJarvis } from '../src/modules/jarvis/cerebro.js';
import { validarPlan } from '../src/modules/jarvis/comprension.js';
import { limpiarTranscripcion } from '../src/modules/jarvis/oido.service.js';
import { JarvisService } from '../src/modules/integraciones/jarvis.service.js';

describe('Comprensión del mensaje completo', () => {
  it('envía sin truncar mensaje, historial y catálogo al modelo', async () => {
    const generar = vi.fn().mockResolvedValue(JSON.stringify({ consultas: [{intencion:'saldo',pregunta:'Mi saldo'}], aclaracion:null }));
    const motor = {nombre:'prueba', disponible:async()=>true, generar};
    const c = new CerebroJarvis(motor as any, {disponible:async()=>false} as any);
    const mensaje = 'Contexto '.repeat(300) + 'No quiero promociones, dime mi saldo.';
    const plan = await c.comprender('cliente', mensaje, 'Conversación anterior', ['saldo'], {locales:['Tienda real']});
    expect(plan?.consultas[0].intencion).toBe('saldo');
    const payload = JSON.parse(generar.mock.calls[0][1]);
    expect(JSON.stringify(payload)).toContain(mensaje);
    expect(JSON.stringify(payload)).toContain('Conversación anterior');
    expect(JSON.stringify(payload)).toContain('Tienda real');
  });
  it('rechaza herramientas inventadas y respuestas vacías', () => {
    expect(validarPlan({consultas:[{intencion:'borrar_datos',pregunta:'Todo'}],aclaracion:null},['saldo'])).toBeNull();
    expect(validarPlan({consultas:[],aclaracion:null},['saldo'])).toBeNull();
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
