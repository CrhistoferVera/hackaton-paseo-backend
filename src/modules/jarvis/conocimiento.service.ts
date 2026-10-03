import { Injectable } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { ahoraBolivia, enRangoHorario } from '../../common/util.js';
import { EventBus } from '../nucleo/event-bus.js';

/** Sin tildes, minúsculas, sin signos: así se compara lo que dice el reconocedor de voz. */
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
export const singular = (w: string) => (w.length > 4 && /es$/.test(w) && !/(ces|ses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) ? w.slice(0, -1) : w);

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const v = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = v[0];
    v[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = v[j];
      v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return v[b.length];
}

/** Palabras comunes que no identifican a un local por sí solas («algo dulce» no es «Dulce Arte»). */
const COMUNES = new Set(
  ('paseo aranjuez cafe casa club center centro zone style express total mundo magico arte hogar moda sport kids fashion piel bella tiempo dulce regalos sorpresa deco ' +
    'vision estilo sol andes musical felices mascotas bolso strike lounge terraza tostado frio tropicales jugos pollos burger house sushi cine bowling gamer farmacia ' +
    'optica peluqueria zapateria joyeria libreria jugueteria relojeria perfumeria heladeria pizzeria urban electro celular esencia barber fotostudio').split(' '),
);
const VACIAS = new Set('para con sin una uno unos unas los las del que por como donde esta este esto cual cuanto cuanta mas menos muy algo quiero tiene tienen hay ahi aqui alla media docena familiar combo caja juego pack porcion'.split(' '));

export interface LocalIdx { id: string; nombre: string; norm: string; tokens: string[]; distintivos: string[]; categoria: string; claves: string[]; piso: string; numero_local: string }
export interface ProductoIdx { id: string; nombre: string; tokens: string[]; local_id: string; local: string; precio: number }
export interface ServicioIdx { id: string; tipo: string; nombre: string; claves: string[] }
export interface ActividadIdx { id: string; titulo: string; tokens: string[] }

export interface Encontrado {
  locales: LocalIdx[];
  productos: ProductoIdx[];
  servicio: ServicioIdx | null;
  actividad: ActividadIdx | null;
  categoria: string | null;
}

/** Sinónimos de categoría que usa la gente al hablar. */
const CATEGORIAS: Record<string, string[]> = {
  Comida: ['comida', 'comer', 'hambre', 'almorzar', 'almuerzo', 'cenar', 'cena', 'restaurante', 'desayuno', 'desayunar', 'merienda', 'patio de comidas'],
  Tecnología: ['tecnologia', 'electronica', 'computacion', 'celulares', 'gadgets'],
  Moda: ['ropa', 'moda', 'vestir', 'zapatos', 'calzado', 'zapatillas'],
  Accesorios: ['accesorios', 'joyas', 'maquillaje', 'perfumes', 'cosmeticos'],
  Servicios: ['servicios'],
  Regalos: ['regalo', 'regalos', 'obsequio', 'detalle', 'cumpleanos'],
  Hogar: ['hogar', 'decoracion', 'muebles', 'cocina'],
  Entretenimiento: ['entretenimiento', 'diversion', 'divertirme', 'jugar', 'juegos', 'peliculas', 'pelicula'],
};

/**
 * Lo que Jarvis sabe del Paseo, leído de la base en tiempo real. Mantiene un índice de nombres
 * (locales, productos, servicios, eventos) para reconocer de qué habla el cliente, aunque el
 * reconocedor de voz escriba «napoly» o «tecno centro»; los datos (precios, horarios, stock,
 * promociones) se consultan siempre en el momento.
 */
@Injectable()
export class ConocimientoPaseo {
  private indice = new Map<string, { locales: LocalIdx[]; productos: ProductoIdx[]; servicios: ServicioIdx[]; actividades: ActividadIdx[]; en: number }>();

  constructor(
    private readonly db: Db,
    bus: EventBus,
  ) {
    bus.on('recinto.cambiado', (e) => {
      this.indice.delete(e.recintoId);
    });
  }

  private async cargar(recintoId: string) {
    const c = this.indice.get(recintoId);
    if (c && Date.now() - c.en < 30_000) return c;
    const filas = await many<any>(
      this.db,
      `select l.id, l.nombre, l.piso, l.numero_local, l.palabras_clave, c.nombre as categoria from local l join categoria c on c.id = l.categoria_id where l.recinto_id = $1 and l.activo`,
      [recintoId],
    );
    const cuenta = new Map<string, number>();
    const tok = filas.map((f) => normalizar(f.nombre).split(' ').filter((w) => w.length >= 3));
    for (const ts of tok) for (const t of new Set(ts)) cuenta.set(t, (cuenta.get(t) ?? 0) + 1);
    const locales: LocalIdx[] = filas.map((f, i) => ({
      id: f.id, nombre: f.nombre, norm: normalizar(f.nombre), tokens: tok[i], piso: f.piso, numero_local: f.numero_local,
      distintivos: tok[i].filter((t) => t.length >= 4 && !COMUNES.has(t) && cuenta.get(t) === 1),
      categoria: f.categoria, claves: (f.palabras_clave ?? []).map(normalizar),
    }));
    const prods = await many<any>(
      this.db,
      `select p.id, p.nombre, p.local_id, l.nombre as local, p.precio_bs from producto p join local l on l.id = p.local_id where l.recinto_id = $1 and p.activo and l.activo`,
      [recintoId],
    );
    const productos: ProductoIdx[] = prods.map((p) => ({
      id: p.id, nombre: p.nombre, local_id: p.local_id, local: p.local, precio: Number(p.precio_bs),
      tokens: normalizar(p.nombre).split(' ').filter((w) => w.length >= 3 && !VACIAS.has(w) && !/^\d/.test(w)).map(singular),
    }));
    const servicios: ServicioIdx[] = (await many<any>(this.db, 'select id, tipo, nombre, palabras_clave from servicio_paseo where recinto_id = $1 and activo', [recintoId])).map((s) => ({
      id: s.id, tipo: s.tipo, nombre: s.nombre, claves: (s.palabras_clave ?? []).map(normalizar),
    }));
    const actividades: ActividadIdx[] = (
      await many<any>(this.db, `select id, titulo from actividad where recinto_id = $1 and estado = 'aprobada' and fin > now()`, [recintoId])
    ).map((a) => ({ id: a.id, titulo: a.titulo, tokens: normalizar(a.titulo).split(' ').filter((w) => w.length >= 4 && !VACIAS.has(w)).map(singular) }));
    const r = { locales, productos, servicios, actividades, en: Date.now() };
    this.indice.set(recintoId, r);
    return r;
  }

  /** Reconoce entidades en la frase. Tolera errores del reconocedor (una letra de diferencia). */
  async encontrar(recintoId: string, frase: string): Promise<Encontrado> {
    const idx = await this.cargar(recintoId);
    const t = normalizar(frase);
    const palabras = t.split(' ');
    const sing = palabras.map(singular);
    const pegado = palabras.join('');
    const parecida = (w: string) => sing.some((p) => p === w || (w.length >= 6 && p.length >= 5 && levenshtein(p, w) <= 1));

    const locales = idx.locales
      .map((l) => {
        let s = 0;
        if (` ${t} `.includes(` ${l.norm} `) || (l.norm.length >= 8 && pegado.includes(l.norm.replace(/ /g, '')))) s = 3;
        else if (l.distintivos.some(parecida)) s = 2;
        return { l, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.l);

    const productos = idx.productos
      .map((p) => {
        const hits = p.tokens.filter(parecida);
        const fuerte = hits.some((h) => h.length >= 5);
        return { p, s: fuerte ? hits.length / Math.max(1, Math.min(p.tokens.length, 3)) : 0 };
      })
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s || a.p.precio - b.p.precio);
    const mejor = productos[0]?.s ?? 0;

    // Un servicio coincide si la frase contiene todas las palabras de una de sus claves («cargar mi celular» ⊇ «cargar celular»)
    const contiene = (k: string) => {
      const ws = k.split(" ").filter((w) => w.length >= 3);
      return ` ${t} `.includes(` ${k} `) || (ws.length > 1 && ws.every((w) => parecida(singular(w))));
    };
    const servicio = idx.servicios.find((s) => s.claves.some(contiene)) ?? null;
    const actividad =
      idx.actividades.map((a) => ({ a, s: a.tokens.filter(parecida).length / Math.max(1, a.tokens.length) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s)[0]?.a ?? null;
    const categoria = Object.entries(CATEGORIAS).find(([, sin]) => sin.some((k) => ` ${t} `.includes(` ${k} `)))?.[0] ?? null;

    // «la farmacia», «la óptica», «el cine»: el rubro identifica al local cuando hay uno solo
    if (!locales.length && !productos.length) {
      for (const w of sing.filter((x) => x.length >= 4)) {
        const ls = idx.locales.filter((l) => l.claves.some((k) => singular(k) === w));
        if (ls.length === 1) {
          locales.push(ls[0]);
          break;
        }
      }
    }
    return { locales, productos: productos.filter((x) => x.s === mejor).map((x) => x.p).slice(0, 8), servicio, actividad, categoria };
  }

  /** Locales cuyo rubro o palabras clave coinciden con un término («farmacia», «pizza»). */
  async localesPorTermino(recintoId: string, termino: string) {
    const idx = await this.cargar(recintoId);
    const w = singular(normalizar(termino));
    if (w.length < 3) return [];
    return idx.locales.filter((l) => l.claves.some((k) => singular(k) === w || k.includes(w)) || normalizar(l.categoria) === w);
  }

  // ------------------------------------------------------------------ datos en tiempo real

  async local(localId: string) {
    const { dia, hhmm, fecha } = ahoraBolivia();
    const l = await one<any>(
      this.db,
      `select l.*, c.nombre as categoria, z.nombre as zona from local l join categoria c on c.id = l.categoria_id left join zona z on z.id = l.zona_id where l.id = $1`,
      [localId],
    );
    if (!l) return null;
    const ap = String(l.horario_apertura).slice(0, 5);
    const ci = String(l.horario_cierre).slice(0, 5);
    const abiertoHoy = (l.dias_atencion ?? [0, 1, 2, 3, 4, 5, 6]).includes(dia);
    const abierto = l.activo && abiertoHoy && enRangoHorario(hhmm, ap, ci);
    const promos = await many<any>(
      this.db,
      `select titulo, tipo, multiplicador, descripcion, hora_inicio, hora_fin, ($3::time between hora_inicio and hora_fin and $2 = any(dias_semana)) as ahora
       from promocion where local_id = $1 and estado = 'aprobada' and $4::date between inicio and fin and segmento_id is null order by ahora desc`,
      [localId, dia, hhmm, fecha],
    );
    const productos = await many<any>(
      this.db,
      `select id, nombre, precio_bs, stock, tiempo_preparacion_min from producto where local_id = $1 and activo order by (destacado_hasta >= current_date) desc nulls last, precio_bs limit 5`,
      [localId],
    );
    const minutosParaCerrar = abierto ? minutosEntre(hhmm, ci) : null;
    return { ...l, apertura: ap, cierre: ci, abierto, abiertoHoy, minutosParaCerrar, promos, productos };
  }

  /** Productos con local y stock, del más barato al más caro. */
  productos(ids: string[]) {
    return many<any>(
      this.db,
      `select p.id, p.nombre, p.precio_bs, p.stock, p.tiempo_preparacion_min, p.descripcion, l.id as local_id, l.nombre as local, l.piso, l.numero_local,
              l.horario_apertura, l.horario_cierre
       from producto p join local l on l.id = p.local_id where p.id = any($1::uuid[]) order by p.precio_bs`,
      [ids],
    );
  }

  /** Promociones visibles para el cliente; `ahora` = activas en este momento. */
  async promociones(recintoId: string, clienteId: string | null, f: { localId?: string; categoria?: string } = {}) {
    const { dia, hhmm, fecha } = ahoraBolivia();
    return many<any>(
      this.db,
      `select p.id, p.titulo, p.tipo, p.multiplicador, p.descripcion, p.hora_inicio, p.hora_fin, p.dias_semana, p.fin,
              l.id as local_id, l.nombre as local, l.piso, l.numero_local, c.nombre as categoria,
              ($4::time between p.hora_inicio and p.hora_fin and $3 = any(p.dias_semana)) as ahora,
              ($3 = any(p.dias_semana) and $4::time < p.hora_inicio) as mas_tarde_hoy
       from promocion p left join local l on l.id = p.local_id left join categoria c on c.id = l.categoria_id left join segmento s on s.id = p.segmento_id
       where p.recinto_id = $1 and p.estado = 'aprobada' and $5::date between p.inicio and p.fin
         and (p.segmento_id is null or $2::uuid is null or $2::uuid = any(s.cliente_ids))
         and ($6::uuid is null or p.local_id = $6) and ($7::text is null or c.nombre = $7)
       order by ahora desc, mas_tarde_hoy desc, p.multiplicador desc`,
      [recintoId, clienteId, dia, hhmm, fecha, f.localId ?? null, f.categoria ?? null],
    );
  }

  /** Eventos aprobados entre dos instantes. */
  eventos(recintoId: string, desde: Date, hasta: Date) {
    return many<any>(
      this.db,
      `select a.id, a.titulo, a.descripcion, a.tipo, a.inicio, a.fin, a.lugar, a.precio_bs, a.cupos, a.puntos, a.local_id, a.zona_id, z.piso,
              (now() between a.inicio and a.fin) as en_curso
       from actividad a left join zona z on z.id = a.zona_id
       where a.recinto_id = $1 and a.estado = 'aprobada' and a.fin > $2 and a.inicio < $3 order by a.inicio`,
      [recintoId, desde, hasta],
    );
  }

  actividad(id: string) {
    return one<any>(this.db, `select a.*, z.piso from actividad a left join zona z on z.id = a.zona_id where a.id = $1`, [id]);
  }

  dropsActivos(recintoId: string) {
    return many<any>(
      this.db,
      `select d.id, d.precio_especial, d.mensaje, d.fin, z.nombre as zona, z.piso, p.id as producto_id, p.nombre as producto, p.precio_bs, l.nombre as local, h.id as hito_id, h.codigo,
              d.max_reclamos - (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as quedan
       from drop_espacial d join zona z on z.id = d.zona_id join producto p on p.id = d.producto_id join local l on l.id = p.local_id
       left join hito h on h.zona_id = d.zona_id and h.activo
       where d.recinto_id = $1 and now() between d.inicio and d.fin order by d.fin`,
      [recintoId],
    );
  }

  /** Servicios del tipo pedido, para elegir el más cercano. */
  servicios(recintoId: string, tipo: string) {
    return many<any>(this.db, 'select * from servicio_paseo where recinto_id = $1 and tipo = $2 and activo', [recintoId, tipo]);
  }

  /** Monedas de hoy que el cliente aún no recogió. */
  monedasPendientes(recintoId: string, clienteId: string) {
    const { fecha } = ahoraBolivia();
    return many<any>(
      this.db,
      `select h.id, h.codigo, h.puntos, z.nombre as zona, z.piso from hito h join zona z on z.id = h.zona_id
       where h.recinto_id = $1 and h.activo and not exists (select 1 from reclamo_hito r where r.hito_id = h.id and r.cliente_id = $2 and r.fecha = $3::date)`,
      [recintoId, clienteId, fecha],
    );
  }

  /** Pedidos PaseoYa abiertos del cliente, con lo que lleva cada uno. */
  pedidosAbiertos(clienteId: string) {
    return many<any>(
      this.db,
      `select s.id, s.estado, s.local_id, s.pin, s.total_bs, s.confirmado_en, s.preparando_en, s.listo_en, l.nombre, l.piso, l.numero_local, p.codigo, p.franja_inicio, p.franja_fin,
              string_agg(i.cantidad || ' ' || i.nombre, ', ') as items,
              max(coalesce(pr.tiempo_preparacion_min, 10)) as preparacion_min
       from subpedido s join pedido p on p.id = s.pedido_id join local l on l.id = s.local_id
       join subpedido_item i on i.subpedido_id = s.id left join producto pr on pr.id = i.producto_id
       where p.cliente_id = $1 and s.estado not in ('entregado','vencido')
       group by s.id, l.id, p.id order by p.franja_inicio`,
      [clienteId],
    );
  }

  /** Ofertas personales de hoy (las genera la IA cada mañana), con si están vigentes ahora. */
  ofertasHoy(clienteId: string) {
    const { fecha, hhmm } = ahoraBolivia();
    return many<any>(
      this.db,
      `select o.id, o.titulo, o.motivo, o.multiplicador, o.hora_inicio::text, o.hora_fin::text, o.estado, o.puntos_bono, o.local_id, l.nombre as local,
              ($2::time between o.hora_inicio and o.hora_fin) as ahora, ($2::time > o.hora_fin) as paso
       from oferta_personal o join local l on l.id = o.local_id where o.cliente_id = $1 and o.fecha = $3::date order by o.hora_inicio`,
      [clienteId, hhmm, fecha],
    );
  }

  ultimosMovimientos(clienteId: string, n = 3) {
    return many<any>(
      this.db,
      `select m.tipo, m.puntos, m.descripcion, m.creado_en, l.nombre as local from movimiento_puntos m left join local l on l.id = m.local_id
       where m.cliente_id = $1 order by m.creado_en desc limit $2`,
      [clienteId, n],
    );
  }

  favoritos(clienteId: string) {
    return many<any>(this.db, `select l.id, l.nombre, c.nombre as categoria from favorito f join local l on l.id = f.local_id join categoria c on c.id = l.categoria_id where f.cliente_id = $1`, [clienteId]);
  }

  async parqueoAbierto(clienteId: string) {
    return one<any>(this.db, `select * from parqueo where cliente_id = $1 and estado = 'abierto' order by entrada_en desc limit 1`, [clienteId]);
  }

  async perfil(clienteId: string) {
    return one<any>(
      this.db,
      `select u.nombre, p.intereses, p.fecha_nacimiento from usuario u join cliente_perfil p on p.usuario_id = u.id where u.id = $1`,
      [clienteId],
    );
  }

  /** Mejor promoción de puntos que aplica hoy y ahora en un local (para cotizar). */
  async mejorPromo(recintoId: string, localId: string, clienteId: string | null) {
    const { dia, hhmm, fecha } = ahoraBolivia();
    const p = await one<any>(
      this.db,
      `select p.titulo, p.multiplicador from promocion p left join segmento s on s.id = p.segmento_id
       where p.recinto_id = $1 and (p.local_id = $2 or p.local_id is null) and p.tipo = 'puntos_dobles' and p.estado = 'aprobada'
         and $5::date between p.inicio and p.fin and $3 = any(p.dias_semana) and $4::time between p.hora_inicio and p.hora_fin
         and (p.segmento_id is null or $6::uuid is null or $6::uuid = any(s.cliente_ids))
       order by p.multiplicador desc limit 1`,
      [recintoId, localId, dia, hhmm, fecha, clienteId],
    );
    return p ? { titulo: p.titulo, multiplicador: Number(p.multiplicador) } : null;
  }
}

export function minutosEntre(desde: string, hasta: string) {
  const [h1, m1] = desde.split(':').map(Number);
  const [h2, m2] = hasta.split(':').map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 24 * 60;
  return d;
}
