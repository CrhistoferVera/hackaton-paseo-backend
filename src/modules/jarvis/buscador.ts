/**
 * Buscador de evidencia de Jarvis: dado lo que el cliente pregunta, encuentra qué datos del Paseo
 * lo respaldan (locales, productos, servicios, zonas, información general) y qué palabras de la
 * pregunta no tienen respaldo. Con eso Jarvis responde lo que se le preguntó o dice con honestidad
 * que no tiene ese dato, en vez de contestar otra cosa.
 */

/** Sin tildes, minúsculas, sin signos. */
export function normalizar(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Singular aproximado: «salteñas» → «salteña», «audifonos» → «audifono». */
export const singular = (w: string) => (w.length > 4 && w.endsWith('es') && !/(ces|ses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Raíz para comparar: singular y sin la vocal de género («vegana» = «vegano», «zapatillas» = «zapatilla»). */
export const raiz = (w: string) => {
  const s = singular(w);
  return s.length >= 5 && /[ao]$/.test(s) ? s.slice(0, -1) : s;
};

/**
 * Palabras que no dicen qué busca la persona: forma de la pregunta, artículos, verbos de pedir,
 * personas («para mi mamá»), lugares genéricos y adjetivos de gusto.
 */
const VACIAS = new Set(
  (
    'a al algo alguien algun alguna algunas alguno algunos alla alli ahi aqui aca ahora hoy ya ante bajo cabe con contra de del desde donde dónde durante en entre hacia hasta mediante para por segun sin so sobre tras ' +
    'el la lo los las un una unos unas este esta esto estos estas ese esa eso esos esas aquel aquella mi mis tu tus su sus nuestro nuestra me te se le les nos yo usted ustedes ' +
    'que cual cuales quien quienes como cuando cuanto cuanta cuantos cuantas porque pues y e o u ni pero si no tambien muy mas menos tan bien mal ' +
    'hay habia hubo tienen tiene tienes tengo tener venden vende vendes vender venta compro comprar compra conseguir consigo encuentro encontrar encuentra busco buscar busca buscame ' +
    'quiero quisiera queria necesito necesitaria puedo puede pueden podria podrias sabes sabe saber dime decir dices dame dar ver mira hola oye jarvis porfa favor gracias disculpa ' +
    'es son era ser estar estoy esta estan queda quedan existe existen hace haber va voy vamos ir llevar llevame lleva tomar beber ' +
    'abre abren abrir abierto abierta cierra cierran cerrar cerrado atiende atienden atender horario horarios ' +
    'tarda tardan demora demoran tiempo preparacion minuto minutos hora horas lejos ruta camino llegar llego recoger recojo retirar retiro ' +
    'pedido pedidos orden punto puntos saldo nivel canje canjes canjear promo promos promocion promociones evento eventos ' +
    'paseo aranjuez centro comercial mall edificio piso tienda tiendas local locales negocio negocios lugar lugares sitio sitios cosa cosas opcion opciones tipo clase ' +
    'cerca cercano cercana lejos rapido barato barata baratos baratas economico economica caro cara rico rica buen bueno buena buenos buenas mejor mejores lindo linda nuevo nueva grande chico pequeno ' +
    'recomiendas recomienda recomendar recomendacion sugieres sugerencia ideas idea alguna otro otra otros otras mismo misma todo todos toda todas cada solo sola ' +
    'mama mami papa papi madre padre abuela abuelo hermano hermana hijo hija novia novio esposa esposo amigo amiga amigos tio tia jefe jefa pareja familia gente persona personas ' +
    'dia dias semana mes noche tarde manana momento rato vez veces precio precios cuesta cuestan vale valen sale salen costo'
  ).split(' '),
);

/** Palabras de la pregunta que nombran lo buscado (sin vacías), como raíces. */
export function palabrasClave(frase: string): string[] {
  return [...new Set(normalizar(frase).split(' ').filter((w) => w.length >= 3 && !VACIAS.has(w) && !/^\d+$/.test(w)).map(raiz))];
}

export interface FuenteLocal { id: string; nombre: string; categoria: string; raicesNombre: string[]; raicesRubro: string[]; claves: string[] }
export interface FuenteProducto { id: string; nombre: string; local_id: string; local: string; precio: number; raicesNombre: string[]; raicesExtra: string[] }
export interface FuenteServicio { id: string; tipo: string; nombre: string; claves: string[]; raices: string[] }
export interface FuenteZona { id: string; nombre: string; piso: string; raices: string[] }
export interface FuenteInfo { id: string; tema: string; respuesta: string; claves: string[]; raices: string[] }

export interface Indice {
  locales: FuenteLocal[];
  productos: FuenteProducto[];
  servicios: FuenteServicio[];
  zonas: FuenteZona[];
  info: FuenteInfo[];
}

/** Sinónimos de categoría que usa la gente al hablar. */
export const CATEGORIAS: Record<string, string[]> = {
  Comida: ['comida', 'comer', 'hambre', 'almorzar', 'almuerzo', 'cenar', 'cena', 'restaurante', 'restaurantes', 'desayuno', 'desayunar', 'merienda', 'patio de comidas'],
  Tecnología: ['tecnologia', 'electronica', 'computacion', 'gadgets'],
  Moda: ['ropa', 'moda', 'vestir', 'vestimenta'],
  Accesorios: ['accesorios', 'joyas', 'bisuteria'],
  Servicios: ['servicios'],
  Regalos: ['regalo', 'regalos', 'obsequio', 'obsequios', 'detalle', 'cumpleanos'],
  Hogar: ['hogar', 'decoracion', 'muebles'],
  Entretenimiento: ['entretenimiento', 'diversion', 'divertirme', 'jugar', 'juegos'],
};
const RAICES_CATEGORIA = new Map<string, string>(
  Object.entries(CATEGORIAS).flatMap(([c, ws]) => ws.filter((w) => !w.includes(' ')).map((w) => [raiz(w), c] as [string, string])),
);

/** «ropa», «comida», «regalo»: la palabra nombra una categoría de locales. */
export const esDeCategoria = (r: string) => RAICES_CATEGORIA.has(r);

/** Ascensor y escaleras: están en el grafo del edificio. */
const VERTICALES: Record<string, 'ascensor' | 'escalera'> = { ascensor: 'ascensor', elevador: 'ascensor', escalera: 'escalera', gradas: 'escalera' };

export interface Evidencia {
  /** raíces significativas de la pregunta */
  palabras: string[];
  servicios: FuenteServicio[];
  info: FuenteInfo[];
  /** la información general coincide con una frase completa («tarjeta de crédito») o con varias claves */
  infoFuerte: boolean;
  zonas: FuenteZona[];
  vertical: 'ascensor' | 'escalera' | null;
  /** locales por nombre */
  localesNombre: FuenteLocal[];
  /** locales por rubro (palabras clave) o por categoría */
  localesRubro: FuenteLocal[];
  categoria: string | null;
  /** productos cuyo nombre contiene lo buscado (con cuántas palabras coincide) */
  productos: FuenteProducto[];
  /** productos que solo lo mencionan en la descripción o etiquetas (p. ej. «funda para celular») */
  productosRelacionados: FuenteProducto[];
  /** palabras de la pregunta que ningún dato respalda («nike», «vegana», «gimnasio») */
  faltantes: string[];
}

const contieneFrase = (t: string, k: string) => ` ${t} `.includes(` ${k} `);

/** Junta la evidencia del Paseo para una frase. */
export function evidencia(idx: Indice, frase: string): Evidencia {
  const t = normalizar(frase);
  const palabras = palabrasClave(frase);
  const cubiertas = new Set<string>();
  const marca = (ws: string[]) => ws.forEach((w) => cubiertas.add(w));
  const hits = (fuente: string[]) => palabras.filter((w) => fuente.includes(w));

  // Servicios: una clave completa dentro de la frase («cajero automático», «baño»)
  const servicios = idx.servicios.filter((s) => s.claves.some((k) => contieneFrase(t, k)));
  for (const s of servicios) marca(hits(s.raices));
  // Si nombró un servicio puntual («cajero del Banco Unión»), primero ese
  servicios.sort((a, b) => hits(raicesDe(b.nombre)).length - hits(raicesDe(a.nombre)).length);
  for (const s of servicios) marca(hits(raicesDe(s.nombre)));

  const puntajes = idx.info
    .map((i) => {
      const frases = i.claves.filter((k) => contieneFrase(t, k));
      return { i, n: frases.length * 2 + hits(i.raices).length, fuerte: frases.some((k) => k.includes(' ')) || frases.length >= 2 };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const info = puntajes.map((x) => x.i);
  const infoFuerte = !!puntajes[0]?.fuerte;
  for (const i of info.slice(0, 1)) marca(hits(i.raices));

  const zonas = idx.zonas.filter((z) => z.raices.length && z.raices.every((r) => palabras.includes(r)));
  for (const z of zonas) marca(z.raices);

  const vertical = (Object.entries(VERTICALES).find(([w]) => palabras.includes(raiz(w)))?.[1] ?? null) as Evidencia['vertical'];
  if (vertical) marca(Object.keys(VERTICALES).map(raiz).filter((w) => palabras.includes(w)));

  const localesNombre = idx.locales.filter((l) => contieneFrase(t, normalizar(l.nombre)) || (l.raicesNombre.length && l.raicesNombre.every((r) => palabras.includes(r))));
  for (const l of localesNombre) marca(hits(l.raicesNombre));

  let categoria: string | null = Object.entries(CATEGORIAS).find(([, ws]) => ws.some((w) => w.includes(' ') && contieneFrase(t, w)))?.[0] ?? null;
  for (const w of palabras) {
    const c = RAICES_CATEGORIA.get(w);
    if (c) {
      categoria ??= c;
      cubiertas.add(w);
    }
  }
  const localesRubro = idx.locales.filter((l) => !localesNombre.includes(l) && (hits(l.raicesRubro).length > 0 || (categoria !== null && l.categoria === categoria)));
  for (const l of localesRubro) marca(hits(l.raicesRubro));

  // Productos por nombre: los que cubren más palabras de la pregunta
  const porNombre = idx.productos.map((p) => ({ p, n: hits(p.raicesNombre).length })).filter((x) => x.n > 0);
  const mejor = Math.max(0, ...porNombre.map((x) => x.n));
  const productos = porNombre.filter((x) => x.n === mejor).sort((a, b) => a.p.precio - b.p.precio).map((x) => x.p);
  for (const p of productos) marca(hits(p.raicesNombre));
  const productosRelacionados = productos.length
    ? []
    : idx.productos.filter((p) => hits(p.raicesExtra).length > 0).sort((a, b) => a.precio - b.precio);
  for (const p of productosRelacionados) marca(hits(p.raicesExtra));

  return {
    palabras, servicios, info, infoFuerte, zonas, vertical, localesNombre, localesRubro, categoria, productos, productosRelacionados,
    faltantes: palabras.filter((w) => !cubiertas.has(w)),
  };
}

export function raicesDe(s: string) {
  return palabrasClave(s);
}

/** La palabra tal como la dijo el cliente (con tildes), para repetirla en la respuesta. */
export function comoLaDijo(frase: string, r: string) {
  const ws = frase.replace(/[¿?¡!.,;:«»"]/g, ' ').split(/\s+/).filter(Boolean);
  return ws.find((w) => raiz(normalizar(w)) === r) ?? r;
}

/**
 * Lo que la persona busca, sin la forma de la pregunta: «¿hay algún gimnasio en el Paseo?» → «gimnasio».
 * Sirve para decir con honestidad «no encontré gimnasio».
 */
export function objetoDe(frase: string) {
  const ws = frase.replace(/[¿?¡!.,;:«»"]/g, ' ').split(/\s+/).filter(Boolean);
  const utiles = ws.filter((w) => {
    const n = normalizar(w);
    return n.length >= 2 && !VACIAS.has(n);
  });
  return utiles.join(' ').toLowerCase();
}
