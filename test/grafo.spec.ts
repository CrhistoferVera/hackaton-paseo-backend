import { describe, expect, it } from 'vitest';
import { alcanzables, caminoMasCorto, construirGrafo, type Arista, type Nodo } from '../src/modules/orientacion/domain/grafo.js';
import { CerebroJarvis } from '../src/modules/jarvis/cerebro.js';

const zonas = ['N1', 'N2', 'T'].flatMap((piso) => [
  { id: `${piso}-A`, piso, sector: 'A', nombre: 'Sector A', x: 0, y: 0, ancho: 333, alto: 600 },
  { id: `${piso}-B`, piso, sector: 'B', nombre: 'Sector B', x: 333, y: 0, ancho: 334, alto: 600 },
  { id: `${piso}-C`, piso, sector: 'C', nombre: 'Sector C', x: 667, y: 0, ancho: 333, alto: 600 },
]);
const locales = [
  { id: 'cafe', nombre: 'Café Alameda', piso: 'N1', numero_local: '104', coord_x: 80, coord_y: 140, zona_id: 'N1-A', codigo_puerta: 'L-CAFE', activo: true },
  { id: 'tecno', nombre: 'TecnoCentro', piso: 'N1', numero_local: '136', coord_x: 750, coord_y: 140, zona_id: 'N1-C', codigo_puerta: 'L-TECNO', activo: true },
  { id: 'burger', nombre: 'Burger House', piso: 'T', numero_local: 'T06', coord_x: 200, coord_y: 480, zona_id: 'T-A', codigo_puerta: 'L-BURGER', activo: true },
];
const hitos = [{ id: 'h1', nombre: 'Cartel', zona_id: 'N2-B', codigo: 'N2-B' }];
const servicios = [{ id: 'b1', nombre: 'el baño del Nivel 1', piso: 'N1', x: 330, y: 230, zona_id: 'N1-A' }];

function cargar() {
  const { nodos, aristas } = construirGrafo({ zonas, locales, hitos, servicios } as any);
  const mapa = new Map<string, Nodo>(nodos.map((n) => [n.id, n]));
  const ady = new Map<string, Arista[]>();
  for (const a of aristas) ady.set(a.desde, [...(ady.get(a.desde) ?? []), a]);
  return { mapa, ady, nodos };
}

describe('Grafo del edificio', () => {
  it('todos los nodos quedan conectados', () => {
    const { ady, nodos } = cargar();
    const alcance = alcanzables(ady, 'N1:entrada:norte', 10_000);
    expect(alcance.size).toBe(nodos.length);
  });

  it('ruta en el mismo piso con instrucciones y lado de llegada', () => {
    const { mapa, ady } = cargar();
    const r = caminoMasCorto(mapa, ady, 'local:cafe', 'local:tecno')!;
    expect(r.metros).toBeGreaterThan(70);
    expect(r.metros).toBeLessThan(140);
    expect(r.pasos[0]).toMatch(/^Sal de Café Alameda/);
    expect(r.pasos.some((p) => /hasta el Sector C/.test(p))).toBe(true);
    // Cada paso indica qué tramo del camino cubre, para resaltarlo en el mapa
    expect(r.tramos.length).toBe(r.pasos.length);
    expect(r.tramos.at(-1)!.hasta).toBe(r.nodos.length - 1);
    expect(r.tramos.every((t) => t.desde <= t.hasta)).toBe(true);
    expect(r.pasos[r.pasos.length - 1]).toBe('Llegas a TecnoCentro, local 136, a tu izquierda.');
  });

  it('ruta entre pisos usa la escalera o el ascensor', () => {
    const { mapa, ady } = cargar();
    const r = caminoMasCorto(mapa, ady, 'N1:entrada:norte', 'local:burger')!;
    expect(r.nodos.some((n) => n.piso === 'T')).toBe(true);
    expect(r.pasos.filter((p) => /sube a/.test(p))).toEqual(['Usa la escalera central y sube a las Terrazas.']);
    expect(r.pasos.at(-1)).toMatch(/^Llegas a Burger House/);
  });

  it('los servicios son destinos de una ruta', () => {
    const { mapa, ady } = cargar();
    const r = caminoMasCorto(mapa, ady, 'local:tecno', 'servicio:b1')!;
    expect(r.pasos.at(-1)).toMatch(/^Llegas a el baño del Nivel 1|^Llegas al baño del Nivel 1/);
  });

  it('el contexto cercano respeta el radio caminando', () => {
    const { ady } = cargar();
    const cerca = alcanzables(ady, 'local:cafe', 25);
    expect(cerca.has('local:tecno')).toBe(false);
    expect([...cerca.values()].every((m) => m <= 25)).toBe(true);
  });
});

describe('Voz de Jarvis', () => {
  it('corta a dos oraciones y quita adornos', () => {
    expect(CerebroJarvis.limpiar('**¡Hola!** Tu pedido está listo. Camina 20 metros. Gracias 😊')).toBe('¡Hola! Tu pedido está listo.');
  });
});

describe('Fidelidad de cifras', () => {
  it('rechaza respuestas que cambian o agregan números', () => {
    expect(CerebroJarvis.mismosNumeros('A 40 metros, 15 puntos.', 'Camina 40 metros y gana 15 puntos.')).toBe(true);
    expect(CerebroJarvis.mismosNumeros('A 40 metros.', 'Camina 40 metros y estarás a 155 metros.')).toBe(false);
  });
});

describe('Persona gramatical', () => {
  it('descarta respuestas en primera persona que el borrador no tenía', () => {
    expect(CerebroJarvis.primeraPersonaNueva('De paso, en el cartel hay una moneda.', 'Paso por el cartel y encuentra una moneda.')).toBe(true);
    expect(CerebroJarvis.primeraPersonaNueva('Pasa por el cartel.', 'Pasa por el cartel y encuentra una moneda.')).toBe(false);
  });
});
