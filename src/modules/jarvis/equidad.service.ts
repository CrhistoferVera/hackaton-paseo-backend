import { Injectable } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { ahoraBolivia } from '../../common/util.js';

/** Coeficiente de Gini (0 = todos reciben lo mismo, 1 = uno se lleva todo). */
export function gini(valores: number[]) {
  const v = valores.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  const total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || total === 0) return 0;
  let acumulado = 0;
  for (let i = 0; i < n; i++) acumulado += (2 * (i + 1) - n - 1) * v[i];
  return Math.round((acumulado / (n * total)) * 1000) / 1000;
}

const limitar = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export interface EstadoLocal {
  id: string;
  nombre: string;
  categoria: string;
  piso: string;
  numero_local: string;
  horario_apertura: string;
  horario_cierre: string;
  dias_atencion: number[];
  /** clientes distintos por día en 7 días (compras y check-ins) */
  visitas7: number;
  /** movimientos en los últimos 60 minutos */
  ahora: number;
  /** promedio esperado para este día de la semana y esta hora (4 semanas) */
  base: number;
  /** recomendaciones que recibió en 7 días (Jarvis, ofertas) */
  exposicion7: number;
  /** -1 (le sobra público frente a su categoría) a 1 (le falta) */
  deficit: number;
  /** ahora / esperado: 1 = normal, < 1 = más vacío que de costumbre */
  saturacion: number;
  /** 0 a 1: cuánto conviene mandarle gente para equilibrar el flujo */
  equidad: number;
}

/**
 * Equidad del flujo de personas. El reto: que el tráfico del Paseo se reparta entre todos los
 * locales, incluso entre competidores, sin dejar de recomendar lo que le gusta a cada cliente.
 * Para cada local mide su tráfico frente a la mediana de su categoría, cuán lleno está ahora frente
 * a lo normal a esta hora, y cuántas veces lo recomendamos (exposición). Con eso calcula un puntaje
 * de equidad que usan Jarvis, las ofertas diarias y el Centro de Inteligencia.
 */
@Injectable()
export class EquidadService {
  private cache = new Map<string, { en: number; locales: EstadoLocal[] }>();

  constructor(private readonly db: Db) {}

  async estado(recintoId: string): Promise<EstadoLocal[]> {
    const c = this.cache.get(recintoId);
    if (c && Date.now() - c.en < 120_000) return c.locales;
    const { dia } = ahoraBolivia();
    const hora = Number(ahoraBolivia().hhmm.slice(0, 2));
    const filas = await many<any>(
      this.db,
      `with mov as (
         select t.local_id, t.cliente_id, t.creado_en as en from transaccion t
         where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '29 days'
         union all
         select c.local_id, c.cliente_id, c.entrada_en from checkin_local c join local l on l.id = c.local_id
         where l.recinto_id = $1 and c.entrada_en > now() - interval '29 days'
       ), agg as (
         select local_id,
                count(distinct (cliente_id, bo(en)::date)) filter (where en > now() - interval '7 days')::int as visitas7,
                count(*) filter (where en > now() - interval '60 minutes')::int as ahora,
                (count(*) filter (where en < now() - interval '1 day' and extract(dow from bo(en)) = $2 and extract(hour from bo(en)) = $3))::float8 / 4 as base
         from mov group by local_id
       ), expo as (
         select local_id, count(*)::int as n from exposicion_local where recinto_id = $1 and creado_en > now() - interval '7 days' group by local_id
       )
       select l.id, l.nombre, c.nombre as categoria, l.piso, l.numero_local, l.horario_apertura::text, l.horario_cierre::text, l.dias_atencion,
              coalesce(a.visitas7, 0) as visitas7, coalesce(a.ahora, 0) as ahora, coalesce(a.base, 0) as base, coalesce(e.n, 0) as exposicion7
       from local l join categoria c on c.id = l.categoria_id left join agg a on a.local_id = l.id left join expo e on e.local_id = l.id
       where l.recinto_id = $1 and l.activo`,
      [recintoId, dia, hora],
    );
    // Mediana de tráfico por categoría: un local se compara con sus competidores directos
    const porCategoria = new Map<string, number[]>();
    for (const f of filas) porCategoria.set(f.categoria, [...(porCategoria.get(f.categoria) ?? []), f.visitas7]);
    const mediana = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
    };
    const locales: EstadoLocal[] = filas.map((f) => {
      const med = mediana(porCategoria.get(f.categoria)!);
      const deficit = med > 0 ? limitar((med - f.visitas7) / med, -1, 1) : 0;
      const saturacion = (f.ahora + 1) / (Number(f.base) + 1);
      const equidad = limitar(0.5 + 0.35 * deficit + 0.15 * (1 - Math.min(saturacion, 2)));
      return { ...f, base: Math.round(Number(f.base) * 10) / 10, deficit: Math.round(deficit * 100) / 100, saturacion: Math.round(saturacion * 100) / 100, equidad: Math.round(equidad * 100) / 100 };
    });
    this.cache.set(recintoId, { en: Date.now(), locales });
    return locales;
  }

  invalidar(recintoId: string) {
    this.cache.delete(recintoId);
  }

  async registrarExposicion(recintoId: string, localIds: string[], clienteId: string | null, fuente: 'jarvis' | 'oferta' | 'proactivo') {
    if (!localIds.length) return;
    const p: unknown[] = [];
    const v = localIds.map((id, i) => {
      p.push(recintoId, id, clienteId, fuente);
      return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`;
    });
    await this.db.query(`insert into exposicion_local (recinto_id, local_id, cliente_id, fuente) values ${v.join(',')}`, p);
  }

  /** Horas con menos movimiento de un local (dentro de su horario), en ventanas de 2 horas. */
  async horasFlojas(localId: string, n = 2): Promise<{ desde: number; hasta: number; promedio: number }[]> {
    const l = await one<any>(this.db, 'select horario_apertura::text as a, horario_cierre::text as c from local where id = $1', [localId]);
    if (!l) return [];
    const abre = Number(l.a.slice(0, 2));
    const cierra = Math.min(23, Number(l.c.slice(0, 2)));
    const filas = await many<{ hora: number; n: number }>(
      this.db,
      `select extract(hour from bo(t.creado_en))::int as hora, count(*)::float8 / 4 as n from transaccion t
       where t.local_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '28 days' group by 1`,
      [localId],
    );
    const porHora = new Map(filas.map((f) => [f.hora, Number(f.n)]));
    const ventanas: { desde: number; hasta: number; promedio: number }[] = [];
    for (let h = abre; h + 2 <= cierra; h++) ventanas.push({ desde: h, hasta: h + 2, promedio: Math.round(((porHora.get(h) ?? 0) + (porHora.get(h + 1) ?? 0)) * 10) / 10 });
    // Se evitan ventanas pegadas a la apertura (aún no hay público) y se eligen las más flojas sin solaparse
    const elegidas: typeof ventanas = [];
    for (const v of ventanas.filter((x) => x.desde > abre).sort((a, b) => a.promedio - b.promedio)) {
      if (elegidas.every((e) => v.hasta <= e.desde || v.desde >= e.hasta)) elegidas.push(v);
      if (elegidas.length >= n) break;
    }
    return elegidas.sort((a, b) => a.desde - b.desde);
  }

  /** Indicadores para el Centro de Inteligencia: Gini del flujo y de la exposición, quién está sub o sobre atendido. */
  async indicadores(recintoId: string) {
    const locales = await this.estado(recintoId);
    const serie = await many<{ fecha: string; valores: number[] }>(
      this.db,
      `with dias as (select generate_series(bo(now())::date - 13, bo(now())::date, interval '1 day')::date as fecha),
       mov as (
         select t.local_id, bo(t.creado_en)::date as fecha, count(distinct t.cliente_id)::int as n from transaccion t
         where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '15 days' group by 1, 2
       )
       select d.fecha::text, array_agg(coalesce(m.n, 0) order by l.id) as valores
       from dias d cross join local l left join mov m on m.local_id = l.id and m.fecha = d.fecha
       where l.recinto_id = $1 and l.activo group by d.fecha order by d.fecha`,
      [recintoId],
    );
    const ordenados = [...locales].sort((a, b) => b.deficit - a.deficit);
    const total = locales.reduce((a, l) => a + l.visitas7, 0) || 1;
    const fila = (l: EstadoLocal) => ({
      id: l.id, local: l.nombre, categoria: l.categoria, visitas7: l.visitas7, participacion: Math.round((1000 * l.visitas7) / total) / 10,
      deficit: l.deficit, saturacion: l.saturacion, exposicion7: l.exposicion7, equidad: l.equidad,
    });
    return {
      giniFlujo: gini(locales.map((l) => l.visitas7)),
      giniExposicion: gini(locales.map((l) => l.exposicion7)),
      serie: serie.map((s) => ({ fecha: s.fecha, gini: gini(s.valores.map(Number)) })),
      subatendidos: ordenados.filter((l) => l.deficit > 0.15).slice(0, 8).map(fila),
      sobreatendidos: ordenados.filter((l) => l.deficit < -0.15).reverse().slice(0, 6).map(fila),
      locales: locales.map(fila),
    };
  }
}
