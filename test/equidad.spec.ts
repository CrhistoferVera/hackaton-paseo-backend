import { describe, expect, it } from 'vitest';
import { gini } from '../src/modules/jarvis/equidad.service.js';
import { AsistenteAdmin } from '../src/modules/inteligencia/asistente.service.js';
import { textoParaVoz } from '../src/modules/jarvis/voz-neural.service.js';
import { normalizar } from '../src/modules/jarvis/conocimiento.service.js';

describe('Equidad del flujo', () => {
  it('Gini: 0 cuando todos reciben lo mismo, cerca de 1 cuando uno se lleva todo', () => {
    expect(gini([10, 10, 10, 10])).toBe(0);
    expect(gini([0, 0, 0, 100])).toBe(0.75);
    expect(gini([5, 10, 15, 20])).toBeGreaterThan(0.2);
    expect(gini([])).toBe(0);
  });
});

describe('Asistente del admin', () => {
  const a = new (AsistenteAdmin as any)(null, null, null, null, null, null) as AsistenteAdmin;
  const d = (t: string, locales = 0, mem = {}) => a.detectar(normalizar(t), locales, mem);

  it.each([
    ['Resumen de esta semana', 'resumen'],
    ['¿Cómo está la equidad del flujo?', 'equidad'],
    ['¿qué locales tienen menos gente?', 'equidad'],
    ['¿Qué debería hacer hoy?', 'acciones'],
    ['¿Cómo van las ofertas de la IA?', 'ofertas'],
    ['¿Qué está pendiente de aprobar?', 'pendientes'],
    ['¿Qué locales venden menos?', 'ranking'],
    ['¿Cuáles son las horas pico?', 'horas'],
    ['¿qué le preguntan los clientes a Jarvis?', 'jarvis'],
    ['clientes dormidos', 'clientes'],
    ['¿qué buscan y no encuentran?', 'demanda'],
    ['¿qué preguntas no supo responder Jarvis?', 'jarvis_sin_datos'],
    ['¿cuál es el ticket promedio?', 'metrica'],
    ['¿cuál es el local con más ventas este mes?', 'ranking'],
    ['dame el NPS', 'sin_datos'],
    ['¿cuántos empleados tiene Napoli?', 'sin_datos'],
    ['¿qué tiempo hace?', 'fuera_de_tema'],
    ['¿cuántos litros de agua se consumen?', 'libre'],
  ])('%s → %s', (t, i) => expect(d(t)).toBe(i));

  it('dos locales nombrados se comparan; uno solo es su detalle', () => {
    expect(d('Napoli y Panchita', 2)).toBe('comparar');
    expect(d('Napoli', 1)).toBe('local');
  });

  it('entiende los períodos y calcula el anterior del mismo largo', () => {
    const s = a.periodo('ventas de los ultimos 10 dias');
    expect(s.etiqueta).toBe('los últimos 10 días');
    expect((Date.parse(s.hasta) - Date.parse(s.desde)) / 86400_000).toBe(9);
    expect((Date.parse(s.antesHasta) - Date.parse(s.antesDesde)) / 86400_000).toBe(9);
    expect(a.periodo('ayer').clave).toBe('ayer');
    expect(a.periodo('el mes pasado').clave).toBe('mes_pasado');
    expect(a.periodo('¿y napoli?', 'semana').clave).toBe('semana');
  });

  it('entiende un día de la semana, un mes y un año', () => {
    const dom = a.periodo('¿cuántas visitas hubo el domingo?');
    expect(dom.desde).toBe(dom.hasta);
    expect(new Date(`${dom.desde}T12:00:00Z`).getUTCDay()).toBe(0);
    expect(a.periodo('ventas de agosto de 2026')).toMatchObject({ desde: '2026-08-01', hasta: '2026-08-31' });
    expect(a.periodo('la venta del 2020')).toMatchObject({ desde: '2020-01-01', hasta: '2020-12-31' });
    expect(a.periodo('¿y el ticket?', `f${dom.desde}`).desde).toBe(dom.desde);
  });
});

describe('Voz de Jarvis', () => {
  it('convierte lo escrito en lo que se dice', () => {
    expect(textoParaVoz('Puntos ×2 en PaseoYa, 30 % menos')).toBe('Puntos por 2 en Paseo Ya, 30 por ciento menos');
    expect(textoParaVoz('Escanea el «QR» 😊')).toBe('Escanea el cu erre');
    expect(textoParaVoz('Hoy vendió Bs 42.794 (+33,7 %) y cayó (-9,5 %), de 18:00 a 20:30.')).toBe('Hoy vendió 42794 bolivianos (más 33 coma 7 por ciento) y cayó (menos 9 coma 5 por ciento), de 18 a 20 y 30.');
    expect(textoParaVoz('Llama al 2-2794204')).toBe('Llama al 2-2794204');
  });
});
