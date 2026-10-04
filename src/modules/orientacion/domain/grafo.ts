/**
 * El edificio como grafo de nodos de ubicación. Dominio puro: construcción a partir del plano,
 * camino más corto (Dijkstra) e instrucciones de voz paso a paso.
 *
 * Cada piso mide 1000 × 600 unidades de plano; el pasillo central corre por y = 300.
 * Escala: 1 unidad = 0,12 m (el piso mide 120 m × 72 m).
 */
export const METROS_POR_UNIDAD = 0.12;
export const VELOCIDAD_M_S = 1.2;
const Y_PASILLO = 300;
const PASO_PASILLO = 100;
const PISOS = ['N1', 'N2', 'T'] as const;
export const NOMBRE_PISO: Record<string, string> = { N1: 'Nivel 1', N2: 'Nivel 2', T: 'las Terrazas' };

/** «el Sector B», «el patio de comidas», «los cines», «la terraza». */
export function conArticulo(nombre: string) {
  if (nombre.startsWith('Sector ')) return `el ${nombre}`;
  const n = nombre.toLowerCase();
  const primera = n.split(' ')[0];
  const art = primera.endsWith('as') ? 'las' : (primera.endsWith('os') || primera.endsWith('es')) ? 'los' : primera.endsWith('a') ? 'la' : 'el';
  return `${art} ${n}`;
}

export type TipoNodo = 'pasillo' | 'local' | 'entrada' | 'escalera' | 'ascensor' | 'servicio';

export interface Nodo {
  id: string;
  piso: string;
  tipo: TipoNodo;
  nombre: string;
  x: number;
  y: number;
  zonaId?: string | null;
  localId?: string | null;
  servicioId?: string | null;
  codigoQr?: string | null;
}

export interface Arista {
  desde: string;
  hasta: string;
  metros: number;
  tipo: 'caminar' | 'escalera' | 'ascensor';
}

export interface EntradaPlano {
  zonas: { id: string; piso: string; sector: string; nombre: string; x: number; y: number; ancho: number; alto: number }[];
  locales: { id: string; nombre: string; piso: string; numero_local: string; coord_x: number; coord_y: number; zona_id: string | null; codigo_puerta: string; activo: boolean }[];
  servicios?: { id: string; nombre: string; piso: string; x: number; y: number; zona_id: string | null }[];
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.round(Math.hypot(a.x - b.x, a.y - b.y) * METROS_POR_UNIDAD * 10) / 10;

/** Construye nodos y aristas desde el plano: pasillos, locales, servicios, entradas y conexiones verticales. */
export function construirGrafo(e: EntradaPlano): { nodos: Nodo[]; aristas: Arista[] } {
  const nodos: Nodo[] = [];
  const aristas: Arista[] = [];
  const unir = (a: Nodo, b: Nodo, tipo: Arista['tipo'] = 'caminar', metros?: number) => {
    const m = metros ?? dist(a, b);
    aristas.push({ desde: a.id, hasta: b.id, metros: m, tipo }, { desde: b.id, hasta: a.id, metros: m, tipo });
  };
  const zonaEn = (piso: string, x: number, y: number) =>
    e.zonas.find((z) => z.piso === piso && x >= Number(z.x) && x <= Number(z.x) + Number(z.ancho) && y >= Number(z.y) && y <= Number(z.y) + Number(z.alto));

  const pasillos = new Map<string, Nodo[]>();
  for (const piso of PISOS) {
    const fila: Nodo[] = [];
    for (let x = 50; x <= 950; x += PASO_PASILLO) {
      const z = zonaEn(piso, x, Y_PASILLO);
      const n: Nodo = { id: `${piso}:pasillo:${x}`, piso, tipo: 'pasillo', nombre: `pasillo ${z ? `de ${conArticulo(z.nombre)}`.replace('de el ', 'del ') : 'central'}`, x, y: Y_PASILLO, zonaId: z?.id ?? null };
      nodos.push(n);
      if (fila.length) unir(fila[fila.length - 1], n);
      fila.push(n);
    }
    pasillos.set(piso, fila);
  }
  const pasilloCercano = (piso: string, x: number) =>
    pasillos.get(piso)!.reduce((m, n) => (Math.abs(n.x - x) < Math.abs(m.x - x) ? n : m));

  for (const l of e.locales.filter((l) => l.activo)) {
    const n: Nodo = {
      id: `local:${l.id}`, piso: l.piso, tipo: 'local', nombre: `${l.nombre}, local ${l.numero_local}`,
      x: Number(l.coord_x), y: Number(l.coord_y), zonaId: l.zona_id, localId: l.id, codigoQr: `PPL:${l.codigo_puerta}`,
    };
    nodos.push(n);
    unir(n, pasilloCercano(l.piso, n.x));
  }


  // Servicios (baños, cajeros automáticos, lactancia…): se llega a ellos como a un local
  for (const s of e.servicios ?? []) {
    const n: Nodo = { id: `servicio:${s.id}`, piso: s.piso, tipo: 'servicio', nombre: s.nombre, x: Number(s.x), y: Number(s.y), zonaId: s.zona_id, servicioId: s.id };
    nodos.push(n);
    unir(n, pasilloCercano(s.piso, n.x));
  }

  const entradas: Nodo[] = [
    { id: 'N1:entrada:norte', piso: 'N1', tipo: 'entrada', nombre: 'Puerta Norte', x: 500, y: 0, codigoQr: 'PPE:Puerta Norte' },
    { id: 'N1:entrada:sur', piso: 'N1', tipo: 'entrada', nombre: 'Puerta Sur', x: 500, y: 600, codigoQr: 'PPE:Puerta Sur' },
    { id: 'N1:entrada:parqueo', piso: 'N1', tipo: 'entrada', nombre: 'acceso del parqueo', x: 1000, y: 300, codigoQr: 'PPE:Parqueo' },
  ];
  for (const n of entradas) {
    n.zonaId = zonaEn('N1', Math.min(n.x, 999), Math.min(n.y, 599))?.id ?? null;
    nodos.push(n);
    unir(n, pasilloCercano('N1', n.x));
  }

  // Conexiones verticales: escalera central (x = 450) y ascensor (x = 850)
  for (const [tipo, x, metrosEntrePisos] of [['escalera', 450, 22], ['ascensor', 850, 30]] as const) {
    const porPiso = PISOS.map((piso) => {
      const n: Nodo = { id: `${piso}:${tipo}`, piso, tipo, nombre: tipo === 'escalera' ? 'escalera central' : 'ascensor', x, y: Y_PASILLO - 20 };
      nodos.push(n);
      unir(n, pasilloCercano(piso, x));
      return n;
    });
    unir(porPiso[0], porPiso[1], tipo, metrosEntrePisos);
    unir(porPiso[1], porPiso[2], tipo, metrosEntrePisos);
  }
  return { nodos, aristas };
}

/** Un paso de la ruta con el tramo de nodos que cubre (desde/hasta son índices en `nodos`). */
export interface Tramo {
  texto: string;
  piso: string;
  desde: number;
  hasta: number;
}

export interface Ruta {
  nodos: Nodo[];
  metros: number;
  minutos: number;
  pasos: string[];
  tramos: Tramo[];
}

/** Camino más corto. `penalizar` permite encarecer nodos (por ejemplo, zonas saturadas). */
export function caminoMasCorto(nodos: Map<string, Nodo>, ady: Map<string, Arista[]>, origen: string, destino: string): Ruta | null {
  if (!nodos.has(origen) || !nodos.has(destino)) return null;
  const distancia = new Map<string, number>([[origen, 0]]);
  const previo = new Map<string, string>();
  const visitados = new Set<string>();
  const pendientes = new Set<string>([origen]);
  while (pendientes.size) {
    let actual = '';
    let mejor = Infinity;
    for (const id of pendientes) {
      const d = distancia.get(id)!;
      if (d < mejor) {
        mejor = d;
        actual = id;
      }
    }
    pendientes.delete(actual);
    if (actual === destino) break;
    visitados.add(actual);
    for (const a of ady.get(actual) ?? []) {
      if (visitados.has(a.hasta)) continue;
      const nd = mejor + a.metros;
      if (nd < (distancia.get(a.hasta) ?? Infinity)) {
        distancia.set(a.hasta, nd);
        previo.set(a.hasta, actual);
        pendientes.add(a.hasta);
      }
    }
  }
  if (!distancia.has(destino)) return null;
  const camino: Nodo[] = [];
  for (let id: string | undefined = destino; id; id = previo.get(id)) camino.unshift(nodos.get(id)!);
  const metros = Math.round(distancia.get(destino)!);
  const tramos = instrucciones(camino);
  return { nodos: camino, metros, minutos: Math.max(1, Math.round(metros / VELOCIDAD_M_S / 60)), pasos: tramos.map((t) => t.texto), tramos };
}

/** Distancias desde un nodo a todos los alcanzables dentro de un radio (para inyectar contexto cercano). */
export function alcanzables(ady: Map<string, Arista[]>, origen: string, radioM: number): Map<string, number> {
  const d = new Map<string, number>([[origen, 0]]);
  const cola: [string, number][] = [[origen, 0]];
  while (cola.length) {
    cola.sort((a, b) => a[1] - b[1]);
    const [id, m] = cola.shift()!;
    if (m > (d.get(id) ?? Infinity)) continue;
    for (const a of ady.get(id) ?? []) {
      const nm = m + a.metros;
      if (nm <= radioM && nm < (d.get(a.hasta) ?? Infinity)) {
        d.set(a.hasta, nm);
        cola.push([a.hasta, nm]);
      }
    }
  }
  return d;
}

/** «pasillo del Sector B» → «el Sector B»; «pasillo de las terrazas» → «las terrazas». */
function zonaDePasillo(n: Nodo) {
  return n.nombre.replace(/^pasillo del /, 'el ').replace(/^pasillo de /, '');
}

/**
 * Instrucciones cortas, pensadas para escucharse mientras se camina. Cada paso indica qué tramo
 * del camino cubre, así el mapa puede resaltar el paso actual.
 */
export function instrucciones(camino: Nodo[]): Tramo[] {
  if (camino.length < 2) return [{ texto: 'Ya estás en el lugar.', piso: camino[0]?.piso ?? 'N1', desde: 0, hasta: 0 }];
  const tramos: Tramo[] = [];
  const agregar = (texto: string, desde: number, hasta: number) =>
    tramos.push({ texto: texto.replace(' a el ', ' al ').replace(' de el ', ' del '), piso: camino[hasta].piso, desde, hasta });
  let acumulado = 0;
  let inicio = 0;
  let primerPasillo: Nodo | null = null;
  let ultimoPasillo: Nodo | null = null;
  let rumbo = 0;
  const volcar = (hasta: number) => {
    if (acumulado > 0 && ultimoPasillo) {
      const m = Math.max(5, Math.round(acumulado / 5) * 5);
      const destinoZona = zonaDePasillo(ultimoPasillo);
      const cambia = primerPasillo && zonaDePasillo(primerPasillo) !== destinoZona && !/central/.test(destinoZona);
      agregar(cambia ? `Camina ${m} metros por el pasillo hasta ${destinoZona}.` : `Camina ${m} metros por el ${ultimoPasillo.nombre}.`, inicio, hasta);
    }
    acumulado = 0;
    primerPasillo = null;
    inicio = hasta;
  };
  if (['local', 'servicio'].includes(camino[0].tipo)) {
    agregar(`Sal de ${camino[0].nombre.split(',')[0]} al pasillo.`, 0, 1);
    inicio = 1;
  }
  for (let k = 1; k < camino.length; k++) {
    const a = camino[k - 1];
    const b = camino[k];
    if (a.piso !== b.piso) {
      volcar(k - 1);
      // Varios pisos seguidos por la misma escalera o ascensor se dicen en un solo paso
      let k2 = k;
      while (k2 + 1 < camino.length && camino[k2 + 1].piso !== camino[k2].piso) k2++;
      const llegada = camino[k2];
      const sube = PISOS.indexOf(llegada.piso as (typeof PISOS)[number]) > PISOS.indexOf(a.piso as (typeof PISOS)[number]);
      agregar(`${b.tipo === 'ascensor' ? 'Toma el ascensor' : 'Usa la escalera central'} y ${sube ? 'sube' : 'baja'} a ${NOMBRE_PISO[llegada.piso]}.`, k - 1, k2);
      k = k2;
      inicio = k2;
      continue;
    }
    const metros = Math.hypot(b.x - a.x, b.y - a.y) * METROS_POR_UNIDAD;
    if (b.x !== a.x) rumbo = Math.sign(b.x - a.x);
    if (b.tipo === 'pasillo' || b.tipo === 'escalera' || b.tipo === 'ascensor') {
      acumulado += metros;
      if (b.tipo === 'pasillo') {
        primerPasillo ??= b;
        ultimoPasillo = b;
      }
      continue;
    }
    volcar(k - 1);
    // Mirando al este, el lado norte del pasillo (y menor) queda a la izquierda
    const norte = b.y < Y_PASILLO;
    const lado = Math.abs(b.y - Y_PASILLO) < 40 || rumbo === 0 ? 'al frente' : norte === rumbo > 0 ? 'a tu izquierda' : 'a tu derecha';
    agregar(`${k === camino.length - 1 ? 'Llegas a' : 'Pasa por'} ${b.nombre}, ${lado}.`, k - 1, k);
    inicio = k;
  }
  volcar(camino.length - 1);
  return tramos;
}
