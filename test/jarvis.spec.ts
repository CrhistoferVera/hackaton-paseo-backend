import { describe, expect, it } from 'vitest';
import { JarvisService } from '../src/modules/integraciones/jarvis.service.js';
import { levenshtein, normalizar, singular } from '../src/modules/jarvis/conocimiento.service.js';
import { limpiarTranscripcion } from '../src/modules/jarvis/oido.service.js';
import { horaVoz, lista } from '../src/modules/jarvis/voz.js';

// detectar() solo usa la frase, las entidades reconocidas y la memoria: se prueba sin base de datos
const jarvis = new (JarvisService as any)(...Array(10).fill(null)) as JarvisService;
const sinEntidades: Record<string, any> = { locales: [], productos: [], servicio: null, actividad: null, categoria: null };
const detectar = (frase: string, extra: Record<string, any> = {}, mem = {}, hilo: any[] = []) =>
  jarvis.detectar({ t: normalizar(frase), ent: { ...sinEntidades, ...extra } as any, mem, hilo });

describe('Jarvis entiende la intención', () => {
  it.each([
    ['¿Qué promociones hay ahora?', 'promociones'],
    ['¿qué eventos hay este fin de semana?', 'eventos'],
    ['¿qué hay el fin de semana?', 'eventos'],
    ['¿Cuántos puntos gano si gasto 100 bolivianos?', 'puntos_ganar'],
    ['¿dónde gano más puntos?', 'oportunidades'],
    ['¿Cuántos puntos tengo?', 'saldo'],
    ['¿Dónde recojo mi hamburguesa?', 'pedido_donde'],
    ['¿cómo va mi pedido?', 'pedido_estado'],
    ['tengo hambre', 'recomendacion'],
    ['¿cuánto cuesta la pizza?', 'precio'],
    ['¿a qué hora cierra el Paseo?', 'horario'],
    ['¿cuánto llevo en el parqueo?', 'parqueo'],
    ['hola', 'saludo'],
    ['gracias, chau', 'gracias'],
    ['sí', 'afirmacion'],
    ['¿qué es Paseo Points?', 'ayuda'],
  ])('%s → %s', (frase, intencion) => {
    expect(detectar(frase)).toBe(intencion);
  });

  it('un servicio reconocido lleva a la intención de servicio', () => {
    expect(detectar('necesito un baño', { servicio: { id: 's', tipo: 'bano', nombre: 'baño', claves: [] } as any })).toBe('servicio');
  });

  it('las preguntas cortas de seguimiento usan la memoria', () => {
    expect(detectar('¿y cómo llego?', {}, { localId: 'napoli' })).toBe('donde');
    expect(detectar('¿y cuánto cuesta?', {}, { productoId: 'p1' })).toBe('precio');
  });

  it('«¿y la óptica?» repite la pregunta anterior con otro local', () => {
    const hilo = [{ rol: 'cliente', texto: '¿a qué hora cierra Napoli?', intencion: 'horario', entidades: {}, creado_en: new Date() }];
    expect(detectar('¿y la óptica?', { locales: [{ id: 'optica' } as any] }, {}, hilo)).toBe('horario');
  });

  it('una pregunta ajena al Paseo no se fuerza a una intención', () => {
    expect(detectar('¿quién ganó el partido de ayer?')).toBe('desconocida');
  });
});

describe('Lenguaje', () => {
  it('normaliza lo que escribe el reconocedor de voz', () => {
    expect(normalizar('¿Dónde está NAPOLI?')).toBe('donde esta napoli');
    expect(singular('salteñas')).toBe('salteña');
    expect(levenshtein('napoly', 'napoli')).toBe(1);
  });

  it('dice las horas como se hablan', () => {
    expect(horaVoz('15:00')).toBe('las 3 de la tarde');
    expect(horaVoz('13:30')).toBe('la 1:30 de la tarde');
    expect(horaVoz('12:00')).toBe('el mediodía');
    expect(horaVoz('21:00')).toBe('las 9 de la noche');
    expect(lista(['A', 'B', 'C'])).toBe('A, B y C');
  });

  it('descarta las muletillas de Whisper en silencio', () => {
    expect(limpiarTranscripcion('Gracias por ver el video.')).toBe('');
    expect(limpiarTranscripcion(' ¿Dónde hay un baño? ')).toBe('¿Dónde hay un baño?');
  });
});
