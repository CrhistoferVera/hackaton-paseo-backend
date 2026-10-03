import { describe, expect, it } from 'vitest';
import { calcularNivel, cotizarPuntos, type ReglaPuntos } from '../src/modules/fidelizacion/domain/politica-puntos.js';
import { puedeTransicionar } from '../src/modules/paseoya/domain/estado-subpedido.js';
import { IsolationForest } from '../src/modules/confianza/domain/isolation-forest.js';
import { kmeans, normalizar } from '../src/modules/inteligencia/domain/kmeans.js';
import { totp, totpValido } from '../src/common/util.js';
import { ComprasService } from '../src/modules/comercio/compras.service.js';

const regla: ReglaPuntos = {
  id: 'r',
  version: 3,
  bs_por_punto: 1,
  valor_punto_bs: 0.02,
  multiplicadores_categoria: { Entretenimiento: 1.2 },
  multiplicadores_horario: [{ dias: [1, 2, 3, 4], desde: '15:00', hasta: '17:00', mult: 1.5, etiqueta: 'Tarde tranquila' }],
  dias_vencimiento: 365,
  niveles: [
    { nombre: 'Bronce', minimo: 0, beneficios: [] },
    { nombre: 'Plata', minimo: 1000, beneficios: [] },
    { nombre: 'Oro', minimo: 2000, beneficios: [] },
    { nombre: 'Platinum', minimo: 3000, beneficios: [] },
  ],
  bono_bienvenida: 100,
  puntos_descubrimiento: 20,
  puntos_visita_diaria: 10,
  puntos_referido: 150,
  puntos_hora_parqueo: 300,
};
// Martes 2026-10-06 16:00 en Bolivia = 20:00 UTC
const martesTarde = new Date('2026-10-06T20:00:00Z');
const martesMediodia = new Date('2026-10-06T16:00:00Z');

describe('Política de puntos', () => {
  it('Bs 1 = 1 punto sin multiplicadores', () => {
    expect(cotizarPuntos(regla, 45.9, 'Comida', martesMediodia, null).puntos).toBe(45);
  });
  it('aplica horario, categoría y promoción', () => {
    const c = cotizarPuntos(regla, 100, 'Entretenimiento', martesTarde, { multiplicador: 2, titulo: 'Doble' });
    expect(c.puntos).toBe(360);
    expect(c.detalle).toHaveLength(3);
    expect(c.reglaVersion).toBe(3);
  });
  it('el nivel usa puntos ganados y calcula lo que falta', () => {
    const n = calcularNivel(regla.niveles, 2480);
    expect(n.nivel).toBe('Oro');
    expect(n.faltan).toBe(520);
    expect(n.progreso).toBeCloseTo(0.48);
    expect(calcularNivel(regla.niveles, 9000).siguiente).toBeNull();
  });
});

describe('Máquina de estados de PaseoYa', () => {
  it('no permite saltar estados', () => {
    expect(puedeTransicionar('recibido', 'entregado')).toBe(false);
    expect(puedeTransicionar('listo', 'entregado')).toBe(true);
    expect(puedeTransicionar('cliente_llego', 'entregado')).toBe(true);
    expect(puedeTransicionar('entregado', 'vencido')).toBe(false);
  });
});

describe('Pase TOTP', () => {
  const secreto = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  it('el código cambia cada 60 s y se acepta ±1 paso', () => {
    const t = Date.UTC(2026, 9, 3, 12, 0, 30);
    const c = totp(secreto, t);
    expect(c).toMatch(/^\d{6}$/);
    expect(totpValido(secreto, c, t + 60_000)).toBe(true);
    expect(totpValido(secreto, c, t + 10 * 60_000)).toBe(false);
  });
});

describe('Factura SIAT', () => {
  it('lee el formato con código de control', () => {
    const f = ComprasService.leerQrFactura('1020300000|1234|29040011007|03/10/2026|85.50|85.50|7B-F3|0|0|0|0.00');
    expect(f).toMatchObject({ nit: '1020300000', numero: '1234', monto: 85.5, fecha: '2026-10-03' });
  });
  it('la URL en línea exige monto y fecha', () => {
    expect(() => ComprasService.leerQrFactura('https://siat.impuestos.gob.bo/consulta/QR?nit=1&cuf=X&numero=9&t=2')).toThrow();
  });
});

describe('Modelos', () => {
  it('Isolation Forest puntúa más alto un monto atípico', () => {
    const datos = Array.from({ length: 400 }, (_, i) => [Math.log1p(30 + (i % 20)), 1 + (i % 5) / 10, i % 3, 12 + (i % 8), i % 2]);
    const f = new IsolationForest(80);
    f.entrenar(datos);
    expect(f.puntaje([Math.log1p(50000), 1300, 1, 3, 0])).toBeGreaterThan(f.puntaje([Math.log1p(35), 1.1, 1, 13, 0]));
  });
  it('K-Means separa dos grupos evidentes', () => {
    const a = Array.from({ length: 30 }, () => [1, 1]);
    const b = Array.from({ length: 30 }, () => [10, 10]);
    const { asignacion } = kmeans(normalizar([...a, ...b]).x, 2);
    expect(new Set(asignacion.slice(0, 30)).size).toBe(1);
    expect(asignacion[0]).not.toBe(asignacion[59]);
  });
});
