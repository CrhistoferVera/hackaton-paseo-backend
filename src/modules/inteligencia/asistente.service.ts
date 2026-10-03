import { Injectable } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia } from '../../common/util.js';
import { CerebroJarvis, SISTEMA_ANALISTA } from '../jarvis/cerebro.js';
import { ConocimientoPaseo, normalizar } from '../jarvis/conocimiento.service.js';
import { EquidadService } from '../jarvis/equidad.service.js';
import { type Entidades, MemoriaJarvis } from '../jarvis/memoria.service.js';
import { InteligenciaService } from './inteligencia.service.js';

const PERIODO_EXPLICITO = /(\bhoy\b|\bayer\b|semana|\bmes\b|ultim[oa]s? \d+ dias|30 dias)/;

type IntencionAdmin =
  | 'resumen' | 'ranking' | 'local' | 'comparar' | 'horas' | 'equidad' | 'acciones' | 'ofertas' | 'pendientes'
  | 'clientes' | 'demanda' | 'fraude' | 'eventos' | 'drops' | 'promociones' | 'jarvis' | 'ayuda' | 'reinicio' | 'libre';

const CLASIFICABLES: IntencionAdmin[] = ['resumen', 'ranking', 'local', 'comparar', 'horas', 'equidad', 'acciones', 'ofertas', 'pendientes', 'clientes', 'demanda', 'fraude', 'eventos', 'drops', 'promociones', 'jarvis'];

interface Periodo {
  clave: string;
  desde: string;
  hasta: string;
  etiqueta: string;
  /** período anterior del mismo largo, para comparar */
  antesDesde: string;
  antesHasta: string;
}

export interface Columna {
  clave: string;
  titulo: string;
  tipo?: 'texto' | 'bs' | 'entero' | 'pct' | 'porcentaje' | 'decimal';
}

/** Acción que el admin puede ejecutar con un clic desde la respuesta. */
export interface AccionAdmin {
  tipo: 'crear_promocion' | 'generar_ofertas' | 'ir';
  etiqueta: string;
  datos?: Record<string, unknown>;
  ruta?: string;
}

export interface RespuestaAdmin {
  intencion: IntencionAdmin;
  texto: string;
  tabla?: { columnas: Columna[]; filas: Record<string, unknown>[] };
  grafico?: { tipo: 'barra' | 'linea'; x: string; y: string; unidad?: string };
  /** datos del gráfico cuando no son los de la tabla */
  serie?: Record<string, unknown>[];
  acciones?: AccionAdmin[];
  sugerencias?: string[];
  periodo?: string;
  motor: string;
  latenciaMs: number;
}

type Borrador = Omit<RespuestaAdmin, 'intencion' | 'motor' | 'latenciaMs'> & { reescribir?: boolean; entidades?: Entidades };

const fmt = (n: number, dec = 0) => Number(n ?? 0).toLocaleString('es-BO', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const bs = (n: number) => `Bs ${fmt(n)}`;
const variacion = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const conSigno = (v: number | null) => (v === null ? 'sin referencia' : `${v >= 0 ? '+' : ''}${fmt(v, 1)} %`);
/** «hoy», «ayer», «esta semana», «en los últimos 7 días»: para continuar una oración. */
const cuando = (p: { clave: string; etiqueta: string }) => (/^(hoy|ayer|semana|semana_pasada|mes|mes_pasado)$/.test(p.clave) ? p.etiqueta : `en ${p.etiqueta}`);
const Cuando = (p: { clave: string; etiqueta: string }) => cuando(p).charAt(0).toUpperCase() + cuando(p).slice(1);
const dias = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Asistente del Centro de Inteligencia: conversa con administración y marketing sobre el Paseo con
 * datos reales (ventas, visitas, equidad del flujo, promociones, ofertas de la IA, eventos, Drops,
 * clientes, demanda, fraude). Recuerda el período y el local de la conversación («¿y la semana pasada?»,
 * «¿y Napoli?») y propone acciones ejecutables (crear una promoción en las horas flojas de un local
 * sub-atendido, generar las ofertas del día). Los números salen de consultas; el modelo local solo redacta.
 */
@Injectable()
export class AsistenteAdmin {
  constructor(
    private readonly db: Db,
    private readonly cerebro: CerebroJarvis,
    private readonly saber: ConocimientoPaseo,
    private readonly memoria: MemoriaJarvis,
    private readonly equidad: EquidadService,
    private readonly inteligencia: InteligenciaService,
  ) {}

  historial(adminId: string) {
    return this.memoria.historial(adminId, 30);
  }

  reiniciar(adminId: string) {
    return this.memoria.reiniciar(adminId).then(() => ({ ok: true }));
  }

  // ================================================================== entrada

  async preguntar(s: Sesion, pregunta: string): Promise<RespuestaAdmin> {
    const t0 = Date.now();
    const t = normalizar(pregunta);
    const hilo = await this.memoria.hilo(s.sub, 8);
    const mem = this.memoria.contexto(hilo);
    const ent = await this.saber.encontrar(s.recintoId, t);
    const periodo = this.periodo(t, mem.periodo);
    let intencion = this.detectar(t, ent.locales.length, mem);
    if (intencion === 'libre') {
      const j = await this.cerebro.json<{ intencion: IntencionAdmin }>(
        `Clasifica la pregunta de un administrador de centro comercial. Responde solo JSON {"intencion":"..."} con una de: ${CLASIFICABLES.join(', ')}.
resumen = ventas o visitas totales; ranking = mejores o peores locales; local = datos de un local; equidad = reparto del flujo de personas entre locales;
acciones = qué hacer o recomendaciones; ofertas = ofertas personales de la IA; pendientes = lo que espera aprobación.`,
        `${MemoriaJarvis.paraPrompt(hilo, 4)}\nAdmin: ${pregunta}`,
      );
      if (j && CLASIFICABLES.includes(j.intencion)) intencion = j.intencion;
    }
    const localId = ent.locales[0]?.id ?? (intencion === 'local' || intencion === 'horas' || /\b(ahi|ese|esa|el mismo)\b/.test(t) ? mem.localId : undefined);
    const ctx = { s, t, pregunta, periodo, localId, local2: ent.locales[1]?.id ?? (intencion === 'comparar' ? mem.localId : undefined), categoria: ent.categoria };

    let b: Borrador;
    try {
      b = await this.manejar(intencion, ctx);
    } catch (e: any) {
      b = { texto: `No pude completar esa consulta (${e.message}). Prueba con «resumen de la semana», «equidad del flujo» o «qué debería hacer hoy».`, reescribir: false };
    }

    let texto = b.texto;
    let motor = 'datos';
    if (b.reescribir !== false && texto.length < 600) {
      const r = await this.cerebro.redactar(texto, [], [], { historial: MemoriaJarvis.paraPrompt(hilo, 4), pregunta, sistema: SISTEMA_ANALISTA });
      texto = r.texto;
      motor = r.motor === 'plantilla' ? 'datos' : r.motor;
    }
    // El período se recuerda solo si se mencionó (o se heredó); «¿qué hago hoy?» no fija «hoy» para lo que sigue
    const recordar = PERIODO_EXPLICITO.test(t) || (!!mem.periodo && ['resumen', 'ranking', 'local', 'comparar', 'horas', 'ofertas', 'clientes', 'demanda', 'drops'].includes(intencion)) ? periodo.clave : undefined;
    await this.memoria.guardar(s.sub, 'cliente', pregunta, intencion, { periodo: recordar, localId: ctx.localId });
    await this.memoria.guardar(s.sub, 'jarvis', texto, intencion, { periodo: recordar, localId: b.entidades?.localId ?? ctx.localId }, { tabla: !!b.tabla });
    const { reescribir: _r, entidades: _e, ...resto } = b;
    return { intencion, ...resto, texto, periodo: periodo.etiqueta, motor, latenciaMs: Date.now() - t0 };
  }

  // ================================================================== comprensión

  detectar(t: string, conLocal: number, mem: Entidades): IntencionAdmin {
    const r = (re: RegExp) => re.test(t);
    if (r(/(nueva conversacion|empecemos de nuevo|olvida (todo|eso))/)) return 'reinicio';
    if (r(/^(ayuda|que puedes hacer|que sabes hacer|como funcionas)/)) return 'ayuda';
    if (r(/(pendiente|por aprobar|que (tengo|hay) que (revisar|aprobar)|esperan aprobacion)/)) return 'pendientes';
    if (r(/(que (deberia|debo|podemos|puedo|conviene) hacer|recomiend|sugier|sugerencia|plan de accion|como (mejoro|mejoramos|equilibr|aumento|aumentamos|reparto)|ideas para|acciones)/)) return 'acciones';
    if (r(/(equidad|equitativ|gini|reparto|distribu|flujo de (personas|gente|clientes)|sub ?atendid|sobre ?atendid|desequilibr|concentra|menos (gente|trafico|visitas|clientes)|mas (gente|publico|clientes|trafico) de la que|saturad|mas vacio|vacios)/)) return 'equidad';
    if (r(/(ofertas? (personal|personales|de la ia|ia|diarias|del dia|generadas)|ofertas para cada|ofertas que genero)/)) return 'ofertas';
    if (conLocal >= 2 || r(/(compar|versus|\bvs\b|frente a|contra )/)) return 'comparar';
    if (r(/(hora pico|horas? (pico|flojas|muertas|tranquilas|de mas|de menos)|a que hora|que horario|franja)/)) return 'horas';
    if (r(/(mejores|peores|top|ranking|que locales? (vende|venden|vendio|vendieron|crece|crecen|cae|caen)|mas vend|menos vend|cuales venden)/)) return 'ranking';
    if (r(/(fraude|alerta|sospech|anomal)/)) return 'fraude';
    if (r(/(no encuentran|sin resultado|demanda|buscan|que tiendas faltan|que falta)/)) return 'demanda';
    if (r(/(jarvis|que preguntan|asistente de los clientes)/)) return 'jarvis';
    if (r(/(cliente|segmento|retencion|dormid|nuevos registros|registr)/)) return 'clientes';
    if (r(/\bdrops?\b/)) return 'drops';
    if (r(/(evento|asistencia|concierto|feria|taller)/)) return 'eventos';
    if (r(/(promocion|promo|campana|roi|retorno)/)) return 'promociones';
    if (conLocal) return 'local';
    if (r(/(resumen|como (vamos|va|estuvo|fue|estamos)|ventas|vendimos|vendio|ingres|factur|visitas|compras|ticket|cuanto)/)) return 'resumen';
    // Seguimiento corto: «¿y ayer?», «¿y el mes pasado?» repite la última intención con otro período
    if (t.split(' ').length <= 5 && /^(y|e)\b/.test(t) && mem.periodo) return 'resumen';
    return 'libre';
  }

  periodo(t: string, anterior?: string): Periodo {
    const hoy = ahoraBolivia().fecha;
    const dow = new Date(`${hoy}T12:00:00Z`).getUTCDay();
    const crear = (clave: string, desde: string, hasta: string, etiqueta: string): Periodo => {
      const largo = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400_000) + 1;
      return { clave, desde, hasta, etiqueta, antesDesde: dias(desde, -largo), antesHasta: dias(desde, -1) };
    };
    const n = /ultim[oa]s (\d+) dias/.exec(t);
    if (n) return crear(`d${n[1]}`, dias(hoy, -(Number(n[1]) - 1)), hoy, `los últimos ${n[1]} días`);
    if (/\bhoy\b/.test(t)) return crear('hoy', hoy, hoy, 'hoy');
    if (/\bayer\b/.test(t)) return crear('ayer', dias(hoy, -1), dias(hoy, -1), 'ayer');
    if (/semana pasada/.test(t)) {
      const lunes = dias(hoy, -((dow + 6) % 7) - 7);
      return crear('semana_pasada', lunes, dias(lunes, 6), 'la semana pasada');
    }
    if (/(esta semana|semana actual)/.test(t)) return crear('semana', dias(hoy, -((dow + 6) % 7)), hoy, 'esta semana');
    if (/mes pasado/.test(t)) {
      const ini = new Date(`${hoy.slice(0, 7)}-01T12:00:00Z`);
      ini.setUTCMonth(ini.getUTCMonth() - 1);
      const desde = ini.toISOString().slice(0, 10);
      return crear('mes_pasado', desde, dias(`${hoy.slice(0, 7)}-01`, -1), 'el mes pasado');
    }
    if (/(este mes|mes actual|en el mes)/.test(t)) return crear('mes', `${hoy.slice(0, 7)}-01`, hoy, 'este mes');
    if (/(ultimo mes|30 dias)/.test(t)) return crear('d30', dias(hoy, -29), hoy, 'los últimos 30 días');
    if (anterior && !/(semana|mes|dia|hoy|ayer)/.test(t)) return this.periodo(anterior === 'semana' ? 'esta semana' : anterior === 'mes' ? 'este mes' : anterior === 'mes_pasado' ? 'mes pasado' : anterior === 'semana_pasada' ? 'semana pasada' : anterior.startsWith('d') ? `ultimos ${anterior.slice(1)} dias` : anterior);
    return crear('d7', dias(hoy, -6), hoy, 'los últimos 7 días');
  }

  // ================================================================== respuestas

  private manejar(i: IntencionAdmin, c: { s: Sesion; t: string; pregunta: string; periodo: Periodo; localId?: string; local2?: string; categoria: string | null }): Promise<Borrador> {
    const r = c.s.recintoId;
    switch (i) {
      case 'resumen': return this.resumen(r, c.periodo);
      case 'ranking': return this.ranking(r, c.periodo, /(peores|menos|caen|cae|bajo)/.test(c.t), c.categoria, /(visita|trafico|gente|clientes)/.test(c.t) ? 'visitas' : 'ventas');
      case 'local': return c.localId ? this.local(r, c.localId, c.periodo) : this.ranking(r, c.periodo, false, c.categoria, 'ventas');
      case 'comparar': return c.localId && c.local2 ? this.comparar(c.localId, c.local2, c.periodo) : Promise.resolve({ texto: 'Dime los dos locales que quieres comparar, por ejemplo «compara Napoli con Burger House esta semana».', reescribir: false });
      case 'horas': return this.horas(r, c.periodo, c.localId);
      case 'equidad': return this.equidadFlujo(r, /(mas (gente|publico|clientes|trafico) de la que|sobre ?atendid|saturad|llenos|demasiad)/.test(c.t));
      case 'acciones': return this.acciones(r);
      case 'ofertas': return this.ofertas(r, c.periodo);
      case 'pendientes': return this.pendientes(r);
      case 'clientes': return this.clientes(r, c.periodo);
      case 'demanda': return this.demanda(r, c.periodo);
      case 'fraude': return this.fraude(r);
      case 'eventos': return this.eventos(r);
      case 'drops': return this.drops(r, c.periodo);
      case 'promociones': return this.promociones(r);
      case 'jarvis': return this.jarvis(r);
      case 'reinicio': return this.memoria.reiniciar(c.s.sub).then(() => ({ texto: 'Listo, empezamos una conversación nueva.', reescribir: false }));
      case 'ayuda': return Promise.resolve(this.ayuda());
      default: return this.libre(c.s, c.pregunta);
    }
  }

  private ayuda(): Borrador {
    return {
      texto: 'Puedo darte el resumen de ventas y visitas de cualquier período, el ranking de locales, el detalle o la comparación de locales, las horas pico y flojas, la equidad del flujo de personas, el rendimiento de promociones, ofertas de la IA, eventos y Drops, los clientes nuevos y dormidos, lo que buscan y no encuentran, las alertas de fraude y lo pendiente de aprobar. También te sugiero acciones concretas.',
      reescribir: false,
      sugerencias: ['Resumen de esta semana', '¿Cómo está la equidad del flujo?', '¿Qué debería hacer hoy?', '¿Qué está pendiente de aprobar?'],
    };
  }

  private async metricas(recintoId: string, desde: string, hasta: string, localId: string | null = null) {
    return one<any>(
      this.db,
      `select count(*)::int as compras, coalesce(sum(monto_bs), 0)::float8 as ventas, count(distinct cliente_id)::int as clientes,
              coalesce(avg(monto_bs), 0)::float8 as ticket,
              (select count(*)::int from visita v where v.recinto_id = $1 and bo(v.entrada_en)::date between $2::date and $3::date and $4::uuid is null) as visitas,
              (select coalesce(sum(puntos), 0)::int from movimiento_puntos m where m.recinto_id = $1 and m.puntos > 0 and bo(m.creado_en)::date between $2::date and $3::date and ($4::uuid is null or m.local_id = $4)) as emitidos,
              (select coalesce(-sum(puntos), 0)::int from movimiento_puntos m where m.recinto_id = $1 and m.tipo = 'canje' and bo(m.creado_en)::date between $2::date and $3::date and ($4::uuid is null or m.local_id = $4)) as canjeados
       from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $2::date and $3::date and ($4::uuid is null or local_id = $4)`,
      [recintoId, desde, hasta, localId],
    );
  }

  private async resumen(recintoId: string, p: Periodo): Promise<Borrador> {
    const a = await this.metricas(recintoId, p.desde, p.hasta);
    const b = await this.metricas(recintoId, p.antesDesde, p.antesHasta);
    const serie = await many<any>(
      this.db,
      `select bo(creado_en)::date::text as fecha, round(sum(monto_bs))::int as ventas, count(*)::int as compras
       from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $2::date and $3::date group by 1 order by 1`,
      [recintoId, p.desde, p.hasta],
    );
    const mov = await many<any>(
      this.db,
      `with a as (select local_id, sum(monto_bs) as v from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $2::date and $3::date group by 1),
            b as (select local_id, sum(monto_bs) as v from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $4::date and $5::date group by 1)
       select l.nombre, coalesce(a.v, 0)::float8 as ahora, coalesce(b.v, 0)::float8 as antes from local l left join a on a.local_id = l.id left join b on b.local_id = l.id
       where l.recinto_id = $1 and coalesce(b.v, 0) > 300 order by (coalesce(a.v, 0) - coalesce(b.v, 0)) / nullif(b.v, 0) desc`,
      [recintoId, p.desde, p.hasta, p.antesDesde, p.antesHasta],
    );
    const sube = mov[0];
    const cae = mov[mov.length - 1];
    const v = variacion(a.ventas, b.ventas);
    const partes = [
      `${p.etiqueta.charAt(0).toUpperCase() + p.etiqueta.slice(1)} el Paseo vendió ${bs(a.ventas)} en ${fmt(a.compras)} compras (${conSigno(v)} frente al período anterior), con ${fmt(a.clientes)} clientes distintos y un ticket promedio de ${bs(a.ticket)}.`,
      `Hubo ${fmt(a.visitas)} visitas registradas (${conSigno(variacion(a.visitas, b.visitas))}); se emitieron ${fmt(a.emitidos)} puntos y se canjearon ${fmt(a.canjeados)}.`,
    ];
    if (sube && cae && sube !== cae) partes.push(`El que más creció fue ${sube.nombre} (${conSigno(variacion(sube.ahora, sube.antes))}) y el que más cayó, ${cae.nombre} (${conSigno(variacion(cae.ahora, cae.antes))}).`);
    return {
      texto: partes.join(' '),
      reescribir: false,
      tabla: serie.length > 1 ? { columnas: [{ clave: 'fecha', titulo: 'Día' }, { clave: 'ventas', titulo: 'Ventas', tipo: 'bs' }, { clave: 'compras', titulo: 'Compras', tipo: 'entero' }], filas: serie } : undefined,
      grafico: serie.length > 1 ? { tipo: 'linea', x: 'fecha', y: 'ventas', unidad: 'Bs' } : undefined,
      sugerencias: ['¿Qué locales vendieron más?', '¿Y el período anterior?', '¿Cómo está la equidad del flujo?', '¿Qué debería hacer hoy?'],
    };
  }

  private async ranking(recintoId: string, p: Periodo, peores: boolean, categoria: string | null, metrica: 'ventas' | 'visitas'): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `with a as (select local_id, sum(monto_bs) as ventas, count(*) as compras, count(distinct cliente_id) as clientes from transaccion
                  where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $2::date and $3::date group by 1),
            b as (select local_id, sum(monto_bs) as ventas from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $4::date and $5::date group by 1)
       select l.id, l.nombre as local, c.nombre as categoria, coalesce(a.ventas, 0)::float8 as ventas, coalesce(a.compras, 0)::int as compras, coalesce(a.clientes, 0)::int as clientes,
              case when coalesce(b.ventas, 0) > 0 then round((100 * (coalesce(a.ventas, 0) - b.ventas) / b.ventas)::numeric, 1)::float8 end as variacion
       from local l join categoria c on c.id = l.categoria_id left join a on a.local_id = l.id left join b on b.local_id = l.id
       where l.recinto_id = $1 and l.activo and ($6::text is null or c.nombre = $6)
       order by ${metrica === 'ventas' ? 'coalesce(a.ventas, 0)' : 'coalesce(a.clientes, 0)'} ${peores ? 'asc' : 'desc'} limit 10`,
      [recintoId, p.desde, p.hasta, p.antesDesde, p.antesHasta, categoria],
    );
    if (!filas.length) return { texto: 'No hay ventas en ese período.', reescribir: false };
    const top = filas.slice(0, 3).map((f) => `${f.local} (${metrica === 'ventas' ? bs(f.ventas) : `${fmt(f.clientes)} clientes`})`);
    return {
      texto: `${peores ? 'Los locales con menos' : 'Los locales con más'} ${metrica === 'ventas' ? 'ventas' : 'clientes'}${categoria ? ` de ${categoria.toLowerCase()}` : ''} ${cuando(p)} son ${top.join(', ')}.${peores ? ' Son buenos candidatos para ofertas de la IA o un Drop en sus horas flojas.' : ''}`,
      reescribir: false,
      entidades: { localId: filas[0].id },
      tabla: {
        columnas: [{ clave: 'local', titulo: 'Local' }, { clave: 'categoria', titulo: 'Categoría' }, { clave: 'ventas', titulo: 'Ventas', tipo: 'bs' }, { clave: 'compras', titulo: 'Compras', tipo: 'entero' }, { clave: 'clientes', titulo: 'Clientes', tipo: 'entero' }, { clave: 'variacion', titulo: 'Variación', tipo: 'pct' }],
        filas,
      },
      grafico: { tipo: 'barra', x: 'local', y: metrica === 'ventas' ? 'ventas' : 'clientes', unidad: metrica === 'ventas' ? 'Bs' : '' },
      sugerencias: [peores ? '¿Qué debería hacer con ellos?' : '¿Y los que menos venden?', `Detalle de ${filas[0].local}`, '¿Cómo está la equidad del flujo?'],
    };
  }

  private async local(recintoId: string, localId: string, p: Periodo): Promise<Borrador> {
    const l = await one<any>(this.db, `select l.id, l.nombre, c.nombre as categoria from local l join categoria c on c.id = l.categoria_id where l.id = $1`, [localId]);
    const a = await this.metricas(recintoId, p.desde, p.hasta, localId);
    const b = await this.metricas(recintoId, p.antesDesde, p.antesHasta, localId);
    const est = (await this.equidad.estado(recintoId)).find((x) => x.id === localId);
    const flojas = await this.equidad.horasFlojas(localId, 2);
    const ofertas = await one<any>(this.db, `select count(*)::int as n, count(*) filter (where estado = 'usada')::int as usadas from oferta_personal where local_id = $1 and fecha between $2::date and $3::date`, [localId, p.desde, p.hasta]);
    const partes = [
      `${l.nombre} vendió ${bs(a.ventas)} ${cuando(p)} (${conSigno(variacion(a.ventas, b.ventas))}), con ${fmt(a.compras)} compras de ${fmt(a.clientes)} clientes y un ticket de ${bs(a.ticket)}.`,
    ];
    if (est) {
      const frente = est.deficit > 0.15 ? `recibe ${fmt(est.deficit * 100)} % menos gente que la mediana de ${l.categoria.toLowerCase()}` : est.deficit < -0.15 ? `recibe ${fmt(-est.deficit * 100)} % más gente que la mediana de ${l.categoria.toLowerCase()}` : `está en la media de ${l.categoria.toLowerCase()}`;
      partes.push(`En equidad del flujo ${frente}; su puntaje de equidad es ${fmt(est.equidad, 2)}.`);
    }
    if (flojas.length) partes.push(`Sus horas más flojas son ${flojas.map((f) => `de ${f.desde}:00 a ${f.hasta}:00`).join(' y ')}.`);
    if (ofertas?.n) partes.push(`La IA le envió ${fmt(ofertas.n)} ofertas personales y se usaron ${fmt(ofertas.usadas)}.`);
    const acciones: AccionAdmin[] = flojas[0]
      ? [{ tipo: 'crear_promocion', etiqueta: `Crear puntos ×2 en ${l.nombre} de ${flojas[0].desde}:00 a ${flojas[0].hasta}:00`, datos: this.promocion(l.id, `Hora feliz en ${l.nombre}`, flojas[0]) }]
      : [];
    return { texto: partes.join(' '), reescribir: false, entidades: { localId }, acciones, sugerencias: [`Horas pico de ${l.nombre}`, `Compara ${l.nombre} con otro local`, '¿Qué debería hacer hoy?'] };
  }

  private async comparar(a: string, b: string, p: Periodo): Promise<Borrador> {
    const ls = await many<any>(this.db, 'select id, nombre from local where id = any($1::uuid[])', [[a, b]]);
    const nombre = (id: string) => ls.find((x) => x.id === id)?.nombre ?? '';
    const r = await one<any>(this.db, 'select recinto_id from local where id = $1', [a]);
    const ma = await this.metricas(r.recinto_id, p.desde, p.hasta, a);
    const mb = await this.metricas(r.recinto_id, p.desde, p.hasta, b);
    const filas = [
      { metrica: 'Ventas', a: bs(ma.ventas), b: bs(mb.ventas) },
      { metrica: 'Compras', a: fmt(ma.compras), b: fmt(mb.compras) },
      { metrica: 'Clientes distintos', a: fmt(ma.clientes), b: fmt(mb.clientes) },
      { metrica: 'Ticket promedio', a: bs(ma.ticket), b: bs(mb.ticket) },
      { metrica: 'Puntos emitidos', a: fmt(ma.emitidos), b: fmt(mb.emitidos) },
    ];
    const gana = ma.ventas >= mb.ventas ? nombre(a) : nombre(b);
    const dif = Math.abs(variacion(Math.max(ma.ventas, mb.ventas), Math.min(ma.ventas, mb.ventas)) ?? 0);
    return {
      texto: `${Cuando(p)}, ${gana} vendió ${fmt(dif, 1)} % más: ${nombre(a)} ${bs(ma.ventas)} con ticket de ${bs(ma.ticket)}, y ${nombre(b)} ${bs(mb.ventas)} con ticket de ${bs(mb.ticket)}.`,
      reescribir: false,
      entidades: { localId: a, localId2: b },
      tabla: { columnas: [{ clave: 'metrica', titulo: 'Métrica' }, { clave: 'a', titulo: nombre(a) }, { clave: 'b', titulo: nombre(b) }], filas },
    };
  }

  private async horas(recintoId: string, p: Periodo, localId?: string): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `select extract(hour from bo(creado_en))::int as hora, count(*)::int as compras, round(sum(monto_bs))::int as ventas from transaccion
       where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date between $2::date and $3::date and ($4::uuid is null or local_id = $4) group by 1 order by 1`,
      [recintoId, p.desde, p.hasta, localId ?? null],
    );
    if (!filas.length) return { texto: 'No hay compras en ese período.', reescribir: false };
    const nombre = localId ? (await one<any>(this.db, 'select nombre from local where id = $1', [localId]))?.nombre : 'el Paseo';
    const orden = [...filas].sort((x, y) => y.compras - x.compras);
    const abiertas = filas.filter((f) => f.hora >= 10 && f.hora <= 21).sort((x, y) => x.compras - y.compras);
    return {
      texto: `En ${nombre}, ${cuando(p)}, la hora pico es de ${orden[0].hora}:00 a ${orden[0].hora + 1}:00 con ${fmt(orden[0].compras)} compras${orden[1] ? `, seguida de las ${orden[1].hora}:00` : ''}. La más floja es de ${abiertas[0]?.hora ?? orden[orden.length - 1].hora}:00 a ${(abiertas[0]?.hora ?? orden[orden.length - 1].hora) + 1}:00${abiertas[1] ? ` y luego las ${abiertas[1].hora}:00` : ''}: ahí conviene concentrar promociones y ofertas.`,
      reescribir: false,
      entidades: { localId },
      tabla: { columnas: [{ clave: 'hora', titulo: 'Hora', tipo: 'entero' }, { clave: 'compras', titulo: 'Compras', tipo: 'entero' }, { clave: 'ventas', titulo: 'Ventas', tipo: 'bs' }], filas: filas.map((f) => ({ ...f, hora: `${f.hora}:00` })) },
      grafico: { tipo: 'barra', x: 'hora', y: 'compras' },
    };
  }

  private async equidadFlujo(recintoId: string, sobre = false): Promise<Borrador> {
    const ind = await this.equidad.indicadores(recintoId);
    const lectura = ind.giniFlujo < 0.3 ? 'bastante parejo' : ind.giniFlujo < 0.45 ? 'moderadamente concentrado' : 'muy concentrado en pocos locales';
    const ini = ind.serie[0]?.gini ?? ind.giniFlujo;
    const fin = ind.serie[ind.serie.length - 1]?.gini ?? ind.giniFlujo;
    const tendencia = fin < ini - 0.02 ? 'mejoró' : fin > ini + 0.02 ? 'empeoró' : 'se mantuvo estable';
    const sub = ind.subatendidos.slice(0, 3);
    const partes = [
      `El flujo de los últimos 7 días está ${lectura}: el índice de Gini entre locales es ${fmt(ind.giniFlujo, 2)} (0 sería que todos reciben lo mismo) y en dos semanas ${tendencia}.`,
      `La exposición que da Jarvis tiene un Gini de ${fmt(ind.giniExposicion, 2)}.`,
    ];
    if (sobre) {
      const so = ind.sobreatendidos.slice(0, 3);
      partes.splice(1, 1, so.length ? `Los que reciben más público que su categoría son ${so.map((x) => `${x.local} (${fmt(-x.deficit * 100)} % sobre la mediana de ${x.categoria.toLowerCase()})`).join(', ')}: no hace falta impulsarlos y la IA les da menos ofertas.` : 'Ningún local está muy por encima de su categoría.');
    } else if (sub.length) partes.push(`Los más sub-atendidos frente a sus competidores son ${sub.map((s) => `${s.local} (${fmt(s.deficit * 100)} % por debajo de la mediana de ${s.categoria.toLowerCase()})`).join(', ')}.`);
    const acciones: AccionAdmin[] = [];
    for (const s of sub.slice(0, 2)) {
      const f = (await this.equidad.horasFlojas(s.id, 1))[0];
      if (f) acciones.push({ tipo: 'crear_promocion', etiqueta: `Puntos ×2 en ${s.local} de ${f.desde}:00 a ${f.hasta}:00`, datos: this.promocion(s.id, `Hora feliz en ${s.local}`, f) });
    }
    acciones.push({ tipo: 'generar_ofertas', etiqueta: 'Regenerar las ofertas personales de hoy' }, { tipo: 'ir', etiqueta: 'Ver el tablero de equidad', ruta: '/admin/ofertas' });
    return {
      texto: partes.join(' '),
      reescribir: false,
      tabla: {
        columnas: [{ clave: 'local', titulo: 'Local' }, { clave: 'categoria', titulo: 'Categoría' }, { clave: 'visitas7', titulo: 'Visitas 7 días', tipo: 'entero' }, { clave: 'participacion', titulo: 'Participación', tipo: 'porcentaje' }, { clave: 'deficit', titulo: 'Déficit', tipo: 'decimal' }, { clave: 'exposicion7', titulo: 'Recomendaciones', tipo: 'entero' }],
        filas: sobre ? ind.sobreatendidos : ind.subatendidos,
      },
      grafico: ind.serie.length > 1 ? { tipo: 'linea', x: 'fecha', y: 'gini' } : undefined,
      serie: ind.serie,
      acciones,
      sugerencias: ['¿Qué debería hacer hoy?', '¿Cómo van las ofertas de la IA?', '¿Qué locales tienen más gente de la que les toca?'],
    };
  }

  private promocion(localId: string, titulo: string, f: { desde: number; hasta: number }) {
    const hoy = ahoraBolivia().fecha;
    return {
      localId, titulo, tipo: 'puntos_dobles', multiplicador: 2, descripcion: 'Puntos dobles en el horario con menos gente para repartir mejor el flujo del Paseo',
      diasSemana: [0, 1, 2, 3, 4, 5, 6], horaInicio: `${String(f.desde).padStart(2, '0')}:00`, horaFin: `${String(f.hasta).padStart(2, '0')}:00`, inicio: hoy, fin: dias(hoy, 13),
    };
  }

  private async acciones(recintoId: string): Promise<Borrador> {
    const ind = await this.equidad.indicadores(recintoId);
    const pend = await this.contarPendientes(recintoId);
    const demanda = await many<any>(this.db, `select lower(termino) as termino, count(*)::int as veces from busqueda where recinto_id = $1 and resultados = 0 and creado_en > now() - interval '30 days' group by 1 order by 2 desc limit 3`, [recintoId]);
    const ofertas = await one<any>(this.db, `select count(*)::int as n, count(*) filter (where estado = 'usada')::int as usadas from oferta_personal where recinto_id = $1 and fecha > current_date - 7`, [recintoId]);
    const pasos: string[] = [];
    const acciones: AccionAdmin[] = [];
    for (const s of ind.subatendidos.slice(0, 3)) {
      const f = (await this.equidad.horasFlojas(s.id, 1))[0];
      if (!f) continue;
      pasos.push(`impulsar a ${s.local}, que recibe ${fmt(s.deficit * 100)} % menos gente que sus competidores, con puntos dobles de ${f.desde}:00 a ${f.hasta}:00`);
      acciones.push({ tipo: 'crear_promocion', etiqueta: `Puntos ×2 en ${s.local} (${f.desde}:00–${f.hasta}:00)`, datos: this.promocion(s.id, `Hora feliz en ${s.local}`, f) });
    }
    if (pend.total) {
      pasos.push(`revisar ${pend.total} pendientes de aprobación (${pend.detalle})`);
      acciones.push({ tipo: 'ir', etiqueta: 'Ver promociones pendientes', ruta: '/admin/promociones' });
    }
    if (demanda.length) pasos.push(`considerar traer lo que más buscan y no encuentran: ${demanda.map((d) => `«${d.termino}» (${d.veces} búsquedas)`).join(', ')}`);
    if (ofertas?.n) pasos.push(`las ofertas de la IA se usaron ${fmt((100 * ofertas.usadas) / ofertas.n, 1)} % de las veces esta semana; si quieres más impacto en los locales vacíos, sube el peso de equidad`);
    acciones.push({ tipo: 'generar_ofertas', etiqueta: 'Regenerar ofertas de hoy' });
    return {
      texto: pasos.length ? `Te propongo ${pasos.length} acciones: ${pasos.map((p, i) => `${i + 1}) ${p}`).join('; ')}.` : 'Todo está equilibrado y no hay pendientes: es un buen día para planear un evento.',
      reescribir: false,
      acciones,
      sugerencias: ['¿Cómo está la equidad del flujo?', '¿Qué está pendiente de aprobar?', '¿Qué promociones rinden mejor?'],
    };
  }

  private async ofertas(recintoId: string, p: Periodo): Promise<Borrador> {
    const r = await one<any>(
      this.db,
      `select count(*)::int as n, count(distinct o.cliente_id)::int as clientes, count(*) filter (where o.estado = 'usada')::int as usadas,
              coalesce(sum(o.puntos_bono), 0)::int as puntos, coalesce(sum(t.monto_bs), 0)::float8 as ventas
       from oferta_personal o left join transaccion t on t.id = o.transaccion_id where o.recinto_id = $1 and o.fecha between $2::date and $3::date`,
      [recintoId, p.desde, p.hasta],
    );
    const porLocal = await many<any>(
      this.db,
      `select l.nombre as local, count(*)::int as ofertas, count(*) filter (where o.estado = 'usada')::int as usadas, round(avg(o.equidad)::numeric, 2)::float8 as equidad
       from oferta_personal o join local l on l.id = o.local_id where o.recinto_id = $1 and o.fecha between $2::date and $3::date group by l.nombre order by usadas desc limit 10`,
      [recintoId, p.desde, p.hasta],
    );
    if (!r.n) return { texto: `No hubo ofertas personales ${cuando(p)}.`, reescribir: false, acciones: [{ tipo: 'generar_ofertas', etiqueta: 'Generar las ofertas de hoy' }] };
    return {
      texto: `${Cuando(p)} la IA generó ${fmt(r.n)} ofertas personales para ${fmt(r.clientes)} clientes. Se usaron ${fmt(r.usadas)} (${fmt((100 * r.usadas) / r.n, 1)} %)${r.ventas > 0 ? `, con ${bs(r.ventas)} en compras,` : ","} y entregaron ${fmt(r.puntos)} puntos extra. Los locales que más visitas recibieron por ofertas fueron ${porLocal.slice(0, 3).map((x) => `${x.local} (${x.usadas})`).join(', ')}.`,
      reescribir: false,
      tabla: { columnas: [{ clave: 'local', titulo: 'Local' }, { clave: 'ofertas', titulo: 'Ofertas', tipo: 'entero' }, { clave: 'usadas', titulo: 'Usadas', tipo: 'entero' }, { clave: 'equidad', titulo: 'Equidad', tipo: 'decimal' }], filas: porLocal },
      grafico: { tipo: 'barra', x: 'local', y: 'usadas' },
      acciones: [{ tipo: 'ir', etiqueta: 'Abrir ofertas y equidad', ruta: '/admin/ofertas' }],
    };
  }

  private async contarPendientes(recintoId: string) {
    const r = await one<any>(
      this.db,
      `select (select count(*)::int from promocion where recinto_id = $1 and estado = 'pendiente') as promociones,
              (select count(*)::int from solicitud_drop where recinto_id = $1 and estado = 'pendiente') as drops,
              (select count(*)::int from actividad where recinto_id = $1 and estado = 'pendiente') as eventos,
              (select count(*)::int from alerta_fraude where recinto_id = $1 and estado = 'abierta') as alertas`,
      [recintoId],
    );
    const det = [r.promociones && `${r.promociones} promociones`, r.drops && `${r.drops} Drops`, r.eventos && `${r.eventos} eventos`].filter(Boolean) as string[];
    return { ...r, total: r.promociones + r.drops + r.eventos, detalle: det.join(', ') };
  }

  private async pendientes(recintoId: string): Promise<Borrador> {
    const p = await this.contarPendientes(recintoId);
    const acciones: AccionAdmin[] = [];
    if (p.promociones) acciones.push({ tipo: 'ir', etiqueta: `Revisar ${p.promociones} promociones`, ruta: '/admin/promociones' });
    if (p.drops) acciones.push({ tipo: 'ir', etiqueta: `Revisar ${p.drops} Drops`, ruta: '/admin/drops' });
    if (p.eventos) acciones.push({ tipo: 'ir', etiqueta: `Revisar ${p.eventos} eventos`, ruta: '/admin/eventos' });
    if (p.alertas) acciones.push({ tipo: 'ir', etiqueta: `Ver ${p.alertas} alertas de fraude`, ruta: '/admin/fraude' });
    return {
      texto: p.total || p.alertas
        ? `Tienes pendientes ${p.detalle || 'ninguna aprobación'}${p.alertas ? `, y ${p.alertas} alertas de fraude abiertas` : ''}.`
        : 'No hay nada pendiente de aprobar ni alertas abiertas.',
      reescribir: false,
      acciones,
    };
  }

  private async clientes(recintoId: string, p: Periodo): Promise<Borrador> {
    const r = await one<any>(
      this.db,
      `select (select count(*)::int from usuario where recinto_id = $1 and rol = 'cliente' and bo(creado_en)::date between $2::date and $3::date) as nuevos,
              (select count(distinct cliente_id)::int from visita where recinto_id = $1 and bo(entrada_en)::date between $2::date and $3::date) as activos,
              (select count(*)::int from usuario u where u.recinto_id = $1 and u.rol = 'cliente' and u.estado = 'activo'
                 and exists (select 1 from visita v where v.cliente_id = u.id) and not exists (select 1 from visita v where v.cliente_id = u.id and v.entrada_en > now() - interval '45 days')) as dormidos,
              (select count(*)::int from usuario where recinto_id = $1 and rol = 'cliente' and estado = 'activo') as total`,
      [recintoId, p.desde, p.hasta],
    );
    const segs = await many<any>(this.db, `select nombre, tamano, round(ticket_promedio)::int as ticket, horario from segmento where recinto_id = $1 order by tamano desc`, [recintoId]);
    return {
      texto: `De ${fmt(r.total)} clientes, ${fmt(r.activos)} vinieron ${cuando(p)} y ${fmt(r.nuevos)} se registraron. Hay ${fmt(r.dormidos)} dormidos (más de 45 días sin venir): las ofertas de la IA les dan prioridad a locales que no conocen.${segs[0] ? ` El segmento más grande es ${segs[0].nombre} con ${fmt(segs[0].tamano)} clientes.` : ''}`,
      reescribir: false,
      tabla: segs.length ? { columnas: [{ clave: 'nombre', titulo: 'Segmento' }, { clave: 'tamano', titulo: 'Clientes', tipo: 'entero' }, { clave: 'ticket', titulo: 'Ticket', tipo: 'bs' }, { clave: 'horario', titulo: 'Horario' }], filas: segs } : undefined,
      grafico: segs.length ? { tipo: 'barra', x: 'nombre', y: 'tamano' } : undefined,
    };
  }

  private async demanda(recintoId: string, p: Periodo): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `select lower(termino) as termino, count(*)::int as veces from busqueda where recinto_id = $1 and resultados = 0 and bo(creado_en)::date between $2::date and $3::date group by 1 order by 2 desc limit 10`,
      [recintoId, p.desde, p.hasta],
    );
    if (!filas.length) return { texto: `${Cuando(p)} no hubo búsquedas sin resultado.`, reescribir: false };
    return {
      texto: `Lo que más buscaron sin encontrar ${cuando(p)}: ${filas.slice(0, 4).map((f) => `«${f.termino}» (${f.veces})`).join(', ')}. Son señales para atraer nuevos locales o productos.`,
      reescribir: false,
      tabla: { columnas: [{ clave: 'termino', titulo: 'Búsqueda' }, { clave: 'veces', titulo: 'Veces', tipo: 'entero' }], filas },
      grafico: { tipo: 'barra', x: 'termino', y: 'veces' },
    };
  }

  private async fraude(recintoId: string): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `select a.regla, a.detalle, round(a.puntaje::numeric, 2)::float8 as puntaje, l.nombre as local, bo(a.creado_en)::date::text as fecha
       from alerta_fraude a left join local l on l.id = a.local_id where a.recinto_id = $1 and a.estado = 'abierta' order by a.puntaje desc limit 10`,
      [recintoId],
    );
    return {
      texto: filas.length ? `Hay ${filas.length} alertas de fraude abiertas; la más grave es en ${filas[0].local}: ${filas[0].detalle}.` : 'No hay alertas de fraude abiertas.',
      reescribir: false,
      tabla: filas.length ? { columnas: [{ clave: 'local', titulo: 'Local' }, { clave: 'regla', titulo: 'Regla' }, { clave: 'detalle', titulo: 'Detalle' }, { clave: 'puntaje', titulo: 'Puntaje', tipo: 'decimal' }, { clave: 'fecha', titulo: 'Fecha' }], filas } : undefined,
      acciones: filas.length ? [{ tipo: 'ir', etiqueta: 'Revisar alertas', ruta: '/admin/fraude' }] : undefined,
    };
  }

  private async eventos(recintoId: string): Promise<Borrador> {
    const prox = await many<any>(this.db, `select titulo, lugar, bo(inicio)::text as inicio, puntos from actividad where recinto_id = $1 and estado = 'aprobada' and inicio between now() and now() + interval '7 days' order by inicio limit 8`, [recintoId]);
    const asist = await many<any>(
      this.db,
      `select a.titulo, count(x.*)::int as asistentes from actividad a join asistencia_actividad x on x.actividad_id = a.id where a.recinto_id = $1 and a.inicio > now() - interval '30 days' group by a.titulo order by 2 desc limit 5`,
      [recintoId],
    );
    return {
      texto: `En los próximos 7 días hay ${prox.length} eventos${prox[0] ? `, empezando por ${prox[0].titulo} en ${prox[0].lugar}` : ''}.${asist[0] ? ` El más concurrido del último mes fue ${asist[0].titulo} con ${asist[0].asistentes} asistentes registrados.` : ' Aún no hay asistencias registradas por QR en el último mes.'}`,
      reescribir: false,
      tabla: prox.length ? { columnas: [{ clave: 'titulo', titulo: 'Evento' }, { clave: 'lugar', titulo: 'Lugar' }, { clave: 'inicio', titulo: 'Inicio' }, { clave: 'puntos', titulo: 'Puntos', tipo: 'entero' }], filas: prox } : undefined,
      acciones: [{ tipo: 'ir', etiqueta: 'Abrir eventos', ruta: '/admin/eventos' }],
    };
  }

  private async drops(recintoId: string, p: Periodo): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `select pr.nombre as producto, l.nombre as local, d.precio_especial::float8 as precio, (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as reclamos, d.max_reclamos,
              (now() between d.inicio and d.fin) as activo
       from drop_espacial d join producto pr on pr.id = d.producto_id join local l on l.id = pr.local_id
       where d.recinto_id = $1 and bo(d.inicio)::date between $2::date and $3::date order by d.inicio desc limit 10`,
      [recintoId, p.desde, p.hasta],
    );
    const pend = await one<any>(this.db, `select count(*)::int as n from solicitud_drop where recinto_id = $1 and estado = 'pendiente'`, [recintoId]);
    const activos = filas.filter((f) => f.activo).length;
    return {
      texto: `${Cuando(p)} se lanzaron ${filas.length} Drops (${activos} activos ahora) con ${fmt(filas.reduce((a, f) => a + f.reclamos, 0))} cajas abiertas.${pend.n ? ` Hay ${pend.n} solicitudes de comercios esperando aprobación.` : ''}`,
      reescribir: false,
      tabla: filas.length ? { columnas: [{ clave: 'producto', titulo: 'Producto' }, { clave: 'local', titulo: 'Local' }, { clave: 'precio', titulo: 'Precio', tipo: 'bs' }, { clave: 'reclamos', titulo: 'Cajas abiertas', tipo: 'entero' }], filas } : undefined,
      acciones: [{ tipo: 'ir', etiqueta: 'Abrir Drops', ruta: '/admin/drops' }],
    };
  }

  private async promociones(recintoId: string): Promise<Borrador> {
    const roi = await this.inteligencia.roi(recintoId);
    const filas = roi.promociones
      .filter((x: any) => x.retorno !== null)
      .sort((a: any, b: any) => (b.retorno ?? 0) - (a.retorno ?? 0))
      .slice(0, 8)
      .map((x: any) => ({ promocion: x.titulo, local: x.local, lift: x.liftPp, incrementales: x.ventasIncrementales, costo: Math.round(x.costoBs), retorno: x.retorno }));
    if (!filas.length) return { texto: 'Todavía no hay promociones con datos suficientes para medir su retorno.', reescribir: false };
    const mejor = filas[0];
    const peor = filas[filas.length - 1];
    return {
      texto: `La promoción con mejor retorno es ${mejor.promocion} en ${mejor.local}: ${bs(mejor.incrementales)} de ventas incrementales por ${bs(mejor.costo)} en puntos, unas ${fmt(mejor.retorno, 1)} veces lo invertido.${peor !== mejor ? ` La de menor retorno es ${peor.promocion} (${fmt(peor.retorno, 1)} veces).` : ''}`,
      reescribir: false,
      tabla: { columnas: [{ clave: 'promocion', titulo: 'Promoción' }, { clave: 'local', titulo: 'Local' }, { clave: 'lift', titulo: 'Lift (pp)', tipo: 'decimal' }, { clave: 'incrementales', titulo: 'Ventas incrementales', tipo: 'bs' }, { clave: 'costo', titulo: 'Costo', tipo: 'bs' }, { clave: 'retorno', titulo: 'Retorno', tipo: 'decimal' }], filas },
      grafico: { tipo: 'barra', x: 'promocion', y: 'retorno' },
    };
  }

  private async jarvis(recintoId: string): Promise<Borrador> {
    const filas = await many<any>(
      this.db,
      `select coalesce(c.intencion, 'otra') as intencion, count(*)::int as preguntas from conversacion_jarvis c join usuario u on u.id = c.cliente_id
       where u.recinto_id = $1 and u.rol = 'cliente' and c.rol = 'cliente' and c.creado_en > now() - interval '7 days' and c.intencion is distinct from 'reinicio'
       group by 1 order by 2 desc limit 12`,
      [recintoId],
    );
    const total = filas.reduce((a, f) => a + f.preguntas, 0);
    const sinRespuesta = filas.filter((f) => ['libre', 'desconocida'].includes(f.intencion)).reduce((a, f) => a + f.preguntas, 0);
    return {
      texto: total
        ? `En 7 días los clientes le hicieron ${fmt(total)} preguntas a Jarvis; lo más consultado es ${filas.slice(0, 3).map((f) => `${f.intencion.replace('_', ' ')} (${f.preguntas})`).join(', ')}. ${fmt((100 * sinRespuesta) / total, 1)} % fueron preguntas abiertas respondidas con los datos generales del Paseo.`
        : 'Jarvis todavía no recibió preguntas esta semana.',
      reescribir: false,
      tabla: filas.length ? { columnas: [{ clave: 'intencion', titulo: 'Tema' }, { clave: 'preguntas', titulo: 'Preguntas', tipo: 'entero' }], filas } : undefined,
      grafico: filas.length ? { tipo: 'barra', x: 'intencion', y: 'preguntas' } : undefined,
      acciones: [{ tipo: 'ir', etiqueta: 'Abrir Jarvis y grafo', ruta: '/admin/jarvis' }],
    };
  }

  /** Lo que no encaja: «Pregúntale a tus datos» sobre las vistas oro (plantillas o Claude si está configurado). */
  private async libre(s: Sesion, pregunta: string): Promise<Borrador> {
    const r: any = await this.inteligencia.preguntar(s.recintoId, s.sub, pregunta);
    if (!r.sql) return { ...this.ayuda(), texto: `No entendí esa pregunta todavía. ${this.ayuda().texto}` };
    const columnas = r.filas[0] ? Object.keys(r.filas[0]).map((k) => ({ clave: k, titulo: k.replace(/_/g, ' ') })) : [];
    return { texto: r.respuesta, reescribir: false, tabla: r.filas.length ? { columnas, filas: r.filas.slice(0, 50) } : undefined, grafico: r.grafico?.tipo === 'barra' || r.grafico?.tipo === 'linea' ? r.grafico : undefined };
  }
}
