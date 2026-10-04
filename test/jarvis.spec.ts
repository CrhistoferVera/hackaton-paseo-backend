import { describe, expect, it } from 'vitest';
import { JarvisService } from '../src/modules/integraciones/jarvis.service.js';
import { levenshtein, normalizar, singular } from '../src/modules/jarvis/conocimiento.service.js';
import { limpiarTranscripcion } from '../src/modules/jarvis/oido.service.js';
import { horaVoz, lista } from '../src/modules/jarvis/voz.js';
import { type Indice, evidencia, objetoDe, raicesDe } from '../src/modules/jarvis/buscador.js';
import { CerebroJarvis } from '../src/modules/jarvis/cerebro.js';

// detectar() solo usa la frase, las entidades reconocidas y la memoria: se prueba sin base de datos
const jarvis = new (JarvisService as any)(...Array(10).fill(null)) as JarvisService;
const evVacia = { palabras: [], servicios: [], info: [], infoFuerte: false, zonas: [], vertical: null, localesNombre: [], localesRubro: [], categoria: null, productos: [], productosRelacionados: [], faltantes: [] };
const sinEntidades: Record<string, any> = { locales: [], productos: [], servicio: null, actividad: null, categoria: null, ev: evVacia, localPorRubro: false };
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
    ['¿hay gimnasio en el Paseo?', 'buscar'],
    ['quiero un café', 'buscar'],
    ['¿cuántos locales hay?', 'conteo'],
    ['¿qué películas dan hoy?', 'cartelera'],
    ['¿abren los domingos?', 'horario'],
    ['¿qué tiempo hace hoy?', 'fuera_de_tema'],
    ['cuéntame un chiste', 'fuera_de_tema'],
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

  it('una pregunta ajena al Paseo no se responde de memoria', () => {
    expect(detectar('¿quién ganó el partido de ayer?')).toBe('fuera_de_tema');
    expect(detectar('¿cuál es la capital de Francia?')).toBe('fuera_de_tema');
  });

  it('la información del Paseo gana a un producto con una palabra parecida', () => {
    expect(detectar('¿aceptan tarjeta de crédito?', { productos: [{ id: 'tarjeta' }], ev: { ...evVacia, info: [{ id: 'pagos' }], infoFuerte: true, productos: [{ id: 'tarjeta' }] } })).toBe('info');
  });
});

describe('Evidencia: Jarvis sabe qué está en los datos y qué no', () => {
  const idx: Indice = {
    locales: [
      { id: 'sport', nombre: 'Sport Center', categoria: 'Moda', raicesNombre: raicesDe('Sport Center'), raicesRubro: raicesDe('deporte zapatillas gimnasio'), claves: ['deporte', 'zapatillas', 'gimnasio'] },
      { id: 'urban', nombre: 'Urban Style', categoria: 'Moda', raicesNombre: raicesDe('Urban Style'), raicesRubro: raicesDe('ropa jeans'), claves: ['ropa', 'jeans'] },
    ],
    productos: [{ id: 'z1', nombre: 'Zapatillas running', local_id: 'sport', local: 'Sport Center', precio: 520, raicesNombre: raicesDe('Zapatillas running'), raicesExtra: [] }],
    servicios: [],
    zonas: [{ id: 'patio', nombre: 'Patio de comidas', piso: 'T', raices: raicesDe('Patio de comidas') }],
    info: [{ id: 'pagos', tema: 'Medios de pago', respuesta: '…', claves: ['tarjeta de credito', 'efectivo'], raices: raicesDe('tarjeta credito efectivo') }],
  };

  it('«zapatillas nike»: encuentra las zapatillas y marca «nike» como sin respaldo', () => {
    const ev = evidencia(idx, '¿qué tienda vende zapatillas nike?');
    expect(ev.productos.map((p) => p.id)).toEqual(['z1']);
    expect(ev.faltantes).toEqual(['nike']);
  });

  it('«gimnasio» solo es un rubro relacionado; «spa» no tiene ningún dato', () => {
    expect(evidencia(idx, '¿hay gimnasio?').localesRubro.map((l) => l.id)).toEqual(['sport']);
    const spa = evidencia(idx, '¿hay un spa?');
    expect(spa.faltantes).toEqual(['spa']);
    expect(spa.localesRubro.length + spa.productos.length + spa.localesNombre.length).toBe(0);
  });

  it('«para mi mamá» no es una condición que falte; la zona y la info general se reconocen', () => {
    expect(evidencia(idx, 'necesito un regalo para mi mamá').faltantes).toEqual([]);
    expect(evidencia(idx, '¿dónde está el patio de comidas?').zonas.map((z) => z.id)).toEqual(['patio']);
    expect(evidencia(idx, '¿aceptan tarjeta de crédito?').infoFuerte).toBe(true);
    expect(objetoDe('¿Hay algún gimnasio en el Paseo?')).toBe('gimnasio');
  });
});

describe('El modelo local no puede cambiar el sentido', () => {
  it('rechaza quitar una negación o agregar datos', () => {
    expect(CerebroJarvis.cambiaSentido('Napoli no atiende los lunes.', 'Napoli atiende los lunes.')).toBe(true);
    expect(CerebroJarvis.cambiaSentido('Sport Center tiene zapatillas a 520 bolivianos.', 'Sport Center tiene zapatillas Nike importadas a 520 bolivianos.')).toBe(true);
    expect(CerebroJarvis.cambiaSentido('Dulce Arte atiende de 9 a 21:30.', 'Dulce Arte atiende de 9 a 21:30, así que puedes ir ahora mismo.')).toBe(false);
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
    expect(horaVoz('23:59')).toBe('la medianoche');
    expect(lista(['A', 'B', 'C'])).toBe('A, B y C');
  });

  it('descarta las muletillas de Whisper en silencio', () => {
    expect(limpiarTranscripcion('Gracias por ver el video.')).toBe('');
    expect(limpiarTranscripcion(' ¿Dónde hay un baño? ')).toBe('¿Dónde hay un baño?');
  });
});
