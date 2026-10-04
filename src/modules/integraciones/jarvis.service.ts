import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { ahoraBolivia } from '../../common/util.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { RecompensasService } from '../recompensas/recompensas.service.js';
import { PaseoYaService } from '../paseoya/paseoya.service.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { NOMBRE_PISO, conArticulo } from '../orientacion/domain/grafo.js';
import { CerebroJarvis } from '../jarvis/cerebro.js';
import { OrquestadorJarvis } from '../jarvis/orquestador.service.js';
import { ConocimientoPaseo, type Encontrado, normalizar } from '../jarvis/conocimiento.service.js';
import { comoLaDijo, esDeCategoria, normalizar as norm, objetoDe, raicesDe, raiz } from '../jarvis/buscador.js';
import { type Entidades, MemoriaJarvis, type Turno } from '../jarvis/memoria.service.js';
import { RecomendadorService } from '../jarvis/recomendador.service.js';
import { de, diaVoz, dinero, duracionVoz, fechaVoz, hhmmBo, horaVoz, lista, lugar } from '../jarvis/voz.js';

export type Intencion =
  | 'saludo' | 'gracias' | 'ayuda' | 'reinicio' | 'afirmacion'
  | 'saldo' | 'nivel' | 'canjes' | 'vencimiento' | 'movimientos' | 'puntos_ganar' | 'oportunidades'
  | 'promociones' | 'ofertas' | 'eventos' | 'misiones' | 'drops' | 'parqueo'
  | 'horario' | 'local_info' | 'donde' | 'servicio' | 'precio' | 'producto' | 'tiempo' | 'recomendacion'
  | 'pedido_estado' | 'pedido_donde' | 'espera' | 'cerca' | 'buscar' | 'info' | 'zona' | 'conteo' | 'cartelera' | 'fuera_de_tema'
  | 'libre' | 'desconocida';

/**
 * Lo que el modelo local puede elegir cuando las reglas no reconocen la frase. Solo intenciones
 * cuyo manejador consulta datos del propio cliente o del Paseo; nunca genera la respuesta.
 */
const CLASIFICABLES: Intencion[] = [
 'saludo','gracias','ayuda','reinicio','afirmacion','saldo','nivel','canjes','vencimiento','movimientos','puntos_ganar','oportunidades',
 'promociones','ofertas','eventos','misiones','drops','parqueo','horario','local_info','donde','servicio','precio','producto','tiempo','recomendacion',
 'pedido_estado','pedido_donde','espera','cerca','buscar','info','zona','conteo','cartelera','fuera_de_tema','libre'
];

type Ruta = ReturnType<typeof OrientacionService.paraApp>;

/** Lo que Jarvis va a responder: texto correcto con datos reales, más lo que la app puede mostrar. */
interface Borrador {
  texto: string;
  /** nombres que el modelo no puede perder al reescribir */
  claves?: string[];
  /** false = ya suena natural o es una lista larga: no pasa por el modelo */
  reescribir?: boolean;
  entidades?: Entidades;
  /** acción que Jarvis ofreció («¿te llevo?»): si el cliente dice «sí», se ejecuta */
  propuesta?: { intencion: Intencion; entidades: Entidades };
  ruta?: Ruta;
  /** no había datos para responder: tema que se buscó (va al reporte de la administración) */
  sinDatos?: string;
  productos?: { id: string; nombre: string; precioBs: number; local: string; enlace: string }[];
  recompensas?: unknown[];
  promociones?: unknown[];
  eventos?: unknown[];
  acciones?: { etiqueta: string; ruta: string }[];
  sugerencias?: string[];
}

export interface RespuestaJarvis extends Omit<Borrador, 'claves' | 'reescribir' | 'entidades' | 'propuesta' | 'sinDatos'> {
  intencion: Intencion;
  motor: string;
  latenciaMs: number;
}

interface Ctx {
  recintoId: string;
  clienteId: string | null;
  nombre: string | null;
  t: string;
  original: string;
  ent: Encontrado;
  mem: Entidades;
  hilo: Turno[];
}

const NO_ENTIENDO = 'Puedo ayudarte con promociones, eventos, tiendas, precios, tiempos de preparación, tu pedido, tus puntos o cómo llegar a cualquier lugar del Paseo.';
const SUGERENCIAS_BASE = ['¿Qué promociones hay ahora?', '¿Qué eventos hay hoy?', '¿Qué me recomiendas?'];
/** Palabras de promociones: no son lo que se filtra («descuentos para estudiantes» → «estudiantes»). */
const VOCABULARIO_PROMO = new Set(['promo', 'promocion', 'oferta', 'descuento', 'rebaja', 'liquidacion', '2x1', 'especial', 'puntos', 'punto', 'doble', 'dobles'].map(raiz));

/**
 * Jarvis conversacional (HU-C21, HU-Y12). Entiende la frase con reglas y con el índice de nombres
 * del Paseo, recuerda de qué se venía hablando y arma una respuesta correcta con datos consultados
 * en el momento (promociones, eventos, precios, horarios, stock, pedidos, puntos). El modelo local
 * solo la vuelve natural; si cambia un dato, se usa la respuesta original. Las preguntas poco comunes
 * se responden con los datos del Paseo, sin inventar.
 */
@Injectable()
export class JarvisService {
  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly recompensas: RecompensasService,
    private readonly paseoya: PaseoYaService,
    private readonly orientacion: OrientacionService,
    private readonly cerebro: CerebroJarvis,
    private readonly orquestador: OrquestadorJarvis,
    private readonly saber: ConocimientoPaseo,
    private readonly memoria: MemoriaJarvis,
    private readonly recomendador: RecomendadorService,
  ) {}

  async recintoPorDefecto(): Promise<string> {
    const r = await one<{ id: string }>(this.db, 'select id from recinto order by nombre limit 1');
    if (!r) throw new NotFoundException('No hay recinto configurado');
    return r.id;
  }

  async clientePorCelular(celular: string) {
    const u = await one<{ id: string; recinto_id: string; nombre: string }>(
      this.db,
      `select id, recinto_id, nombre from usuario where celular = $1 and rol = 'cliente' and estado = 'activo'`,
      [celular],
    );
    if (!u) throw new NotFoundException('No hay un cliente activo con ese celular');
    return u;
  }

  historial(clienteId: string) {
    return this.memoria.historial(clienteId);
  }

  async reiniciar(clienteId: string) {
    await this.memoria.reiniciar(clienteId);
    return { ok: true };
  }

  // ================================================================== entrada principal

  async consultar(recintoId: string, clienteId: string | null, pregunta: string): Promise<RespuestaJarvis> {
    if (!pregunta.trim() || pregunta.length > 6000) throw new BadRequestException('Envía un mensaje de 1 a 6000 caracteres. No se procesará parcialmente.');
    const t0 = Date.now();
    // Se quita el vocativo («oye Jarvis», «…, Jarvis») pero no el saludo
    const original =
      pregunta
        .trim()
        .replace(/^(oye\s+)?jarvis[\s,:!¡]*/i, '')
        .replace(/^(hola|buenas|hey)[\s,]+jarvis\b[\s,:!]*/i, '$1 ')
        .replace(/[\s,]+jarvis[\s?!.]*$/i, '')
        .trim() || 'hola';
    const t = normalizar(original);
    const hilo = clienteId ? await this.memoria.hilo(clienteId) : [];
    const mem = this.memoria.contexto(hilo);
    const ent = await this.saber.encontrar(recintoId, t);
    const nombre = clienteId ? ((await one<{ nombre: string }>(this.db, 'select nombre from usuario where id = $1', [clienteId]))?.nombre.split(' ')[0] ?? null) : null;
    const ctx: Ctx = { recintoId, clienteId, nombre, t, original, ent, mem, hilo };

    const plan = await this.cerebro.comprender('cliente', pregunta, MemoriaJarvis.paraPrompt(hilo, 10), CLASIFICABLES, await this.saber.catalogoConversacion(recintoId));
    let intencion = (plan?.consultas[0]?.intencion as Intencion | undefined) ?? this.detectar(ctx);
    let entidadesPedidas: Entidades = {};
    let contextoResuelto: Entidades = {};
    let intencionResuelta: Intencion = intencion;
    const consultasResueltas: {intencion:string;pregunta:string}[] = [];
    if (intencion === 'afirmacion') {
      const ultima = [...hilo].reverse().find((x) => x.rol === 'jarvis');
      const p = ultima?.datos?.propuesta as Borrador['propuesta'] | undefined;
      if (p) {
        intencion = p.intencion;
        entidadesPedidas = p.entidades;
        ctx.mem = { ...ctx.mem, ...p.entidades };
      } else intencion = 'gracias';
    }
    if (intencion === 'desconocida') intencion = JarvisService.hayEvidencia(ctx.ent) ? 'buscar' : 'libre';

    let b: Borrador;
    try {
      if (plan?.aclaracion) b = { texto: plan.aclaracion, reescribir: false };
      else if (!plan && (original.length > 120 || /\b(no|sin|excepto|pero|ademas)\b/.test(t) || (original.match(/[?？]/g)?.length ?? 0) > 1)) {
        b = { texto: 'El motor de comprensión no está disponible en este momento. Para no ignorar una condición de tu mensaje, envíame una pregunta concreta a la vez o vuelve a intentarlo.', reescribir: false };
      } else if (plan?.consultas.length && plan.consultas[0].intencion !== 'afirmacion') {
        const respuestas: Borrador[] = [];
        for (const consulta of plan.consultas) {
          const ti = consulta.intencion as Intencion;
          if (ti === 'reinicio' && !/^(?:olvida todo|empecemos de nuevo|nueva conversacion|borra (?:la|esta) conversacion)[.!?]*$/.test(t)) {
            respuestas.push({texto:'Para reiniciar el contexto, usa Nueva conversación.',reescribir:false}); continue;
          }
          const subEnt = await this.saber.encontrar(recintoId, consulta.pregunta);
          try {
            const sub = await this.manejar(ti, {...ctx, mem:{...ctx.mem,...contextoResuelto}, original:consulta.pregunta, t:normalizar(consulta.pregunta), ent:subEnt});
            contextoResuelto = {...contextoResuelto, ...(subEnt.locales.length===1 ? {localId:subEnt.locales[0].id} : {}), ...sub.entidades};
            intencionResuelta = ti;
            consultasResueltas.push(consulta);
            if (sub.sinDatos && plan.consultas.length > 1) await this.saber.registrarSinResultado(recintoId, clienteId, sub.sinDatos);
            respuestas.push(sub);
          } catch { respuestas.push({texto:`No pude consultar «${consulta.pregunta}» en este momento. Vuelve a intentarlo.`,reescribir:false}); }
        }
        if (respuestas.length === 1) b = respuestas[0];
        else {
          b = {texto:respuestas.map(r=>r.texto).join('\n\n'),reescribir:false};
          for (const key of ['productos','recompensas','promociones','eventos','acciones','sugerencias'] as const) {
            (b as any)[key] = respuestas.flatMap(r=>(r as any)[key]??[]);
          }
          // Varias rutas no pueden reducirse silenciosamente a un único destino.
          const rutas = respuestas.filter(r=>r.ruta);
          if (rutas.length===1) b.ruta=rutas[0].ruta;
        }
      } else b = await this.manejar(intencion, ctx);
    } catch {
      b = { texto: 'No pude consultar ese dato en este momento. Vuelve a intentarlo.', reescribir: false };
    }
    if (b.sinDatos) await this.saber.registrarSinResultado(recintoId, clienteId, b.sinDatos);

    // El modelo local solo vuelve natural un borrador que ya tiene los datos; si cambia algo, se usa el borrador
    let texto = b.texto;
    let motor = 'plantilla';
    if (b.reescribir !== false && !b.sinDatos) {
      const r = await this.cerebro.redactar(b.texto, [], b.claves ?? [], { historial: MemoriaJarvis.paraPrompt(hilo), pregunta: original });
      texto = r.texto;
      motor = r.motor;
    }
    const guardada: string = b.sinDatos ? 'sin_datos' : consultasResueltas.length ? intencionResuelta : intencion;

    if (clienteId) {
      const delCliente: Entidades = {
        localId: ent.locales[0]?.id, productoId: ent.productos.length === 1 ? ent.productos[0].id : undefined, actividadId: ent.actividad?.id,
        servicioTipo: ent.servicio?.tipo, categoria: ent.categoria ?? undefined, ...entidadesPedidas,
      };
      await this.memoria.guardar(clienteId, 'cliente', original, guardada, plan ? {} : delCliente);
      await this.memoria.guardar(clienteId, 'jarvis', texto, guardada, {...contextoResuelto,...b.entidades}, {
        consultas:consultasResueltas,
        propuesta: b.propuesta ?? null, ruta: b.ruta ? { metros: b.ruta.metros, destino: b.ruta.destino } : null, motor, tema: b.sinDatos ?? null,
      });
    }
    const { claves: _c, reescribir: _r, entidades: _e, propuesta: _p, sinDatos: _s, ...resto } = b;
    return { intencion, ...resto, texto, motor, latenciaMs: Date.now() - t0 };
  }

  // ================================================================== intención

  /** Reglas (instantáneas) + entidades reconocidas + memoria de la conversación. */
  detectar(c: Pick<Ctx, 't' | 'ent' | 'mem' | 'hilo'>): Intencion {
    const { t, ent, mem } = c;
    const palabras = t.split(' ').length;
    const r = (re: RegExp) => re.test(t);

    if (r(/^(si|sii|claro|dale|ok|okay|bueno|ya|por favor|vamos|perfecto|si por favor|si porfa|porfa|llevame|de una)( jarvis)?$/)) return 'afirmacion';
    if (palabras <= 5 && r(/^(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|que tal|como estas)\b/)) return 'saludo';
    if (palabras <= 6 && r(/^(gracias|muchas gracias|mil gracias|genial|excelente|perfecto gracias|ok gracias|listo|no gracias|nada mas|chau|chao|adios|hasta luego|nos vemos)\b/)) return 'gracias';
    if (r(/(olvida (todo|eso)|empecemos de nuevo|nueva conversacion|borra (la|esta) conversacion)/)) return 'reinicio';
    if (r(/(quien eres|que eres|que puedes hacer|que sabes hacer|en que me (puedes )?ayudar|como funcionas|para que sirves|^ayuda$|que es paseo points|como funciona (paseo points|el programa|los puntos)|como funcionan los puntos)/)) return 'ayuda';
    // Fuera del Paseo: Jarvis no responde de memoria (clima, noticias, cultura general, chistes)
    if (r(/\b(clima|que tiempo hace|va a llover|llovera|temperatura|pronostico|capital de|presidente|quien gano|el partido|noticias|chiste|chistes|receta de|traduce|traduceme|tipo de cambio|cotizacion del dolar|horoscopo|cuanto es \d)/)) return 'fuera_de_tema';
    if (r(/\bcuant[oa]s (locales|tiendas|restaurantes|negocios|marcas|lugares|pisos|niveles)\b/)) return 'conteo';
    if (r(/\b(pelicula|peliculas|cartelera|estrenos?|que dan en el cine|funciones del cine|horarios? del cine)\b/)) return 'cartelera';

    // pedidos PaseoYa
    const habla = (re: RegExp) => r(re);
    if (habla(/(donde|como).*(recojo|retiro|recoger|retirar)/)) return 'pedido_donde';
    if (habla(/(esperando|mientras espero|estoy esperando)/)) return 'espera';
    if (habla(/\b(mi|mis|el) (pedido|pedidos|orden|comida)\b/) || habla(/\bpaseoya\b/)) {
      if (habla(/(espero|esperando)/)) return 'espera';
      return 'pedido_estado';
    }

    // puntos
    if (habla(/(cuantos|cuanto|que) puntos? .*(gano|ganaria|ganare|me dan|me darian|daria|acumulo|sumo|sumaria)|si (compro|gasto|pago|consumo)\b/)) return 'puntos_ganar';
    if (habla(/((donde|como|en que|que puedo hacer para) .*(gano|ganar|sumar|acumular|conseguir) (mas )?puntos|puntos (dobles|extra|triples)|doble de puntos|mas puntos)/)) return 'oportunidades';
    if (habla(/(venc|caduc|expir)/) && habla(/punto/)) return 'vencimiento';
    if (habla(/(ultim[oa]s? (compra|movimiento|canje)|mi historial|cuanto gane|mis movimientos)/)) return 'movimientos';
    if (habla(/(canje|canjear|recompensa|premio|que puedo (sacar|cambiar|pedir|obtener) con|alcanza para)/)) return 'canjes';
    if (habla(/\bnivel\b|platinum|soy (oro|plata|bronce)|beneficios/)) return 'nivel';
    if (habla(/\b(saldo|mis puntos|cuantos puntos)\b/)) return 'saldo';
    if (habla(/\b(mision|misiones|reto|retos|desafio)/)) return 'misiones';
    if (habla(/\bdrops?\b|caja sorpresa|relampago/)) return 'drops';

    if (habla(/(mis ofertas|mi oferta|ofertas (para mi|personales|de hoy|del dia)|oferta personal|que ofertas tengo|tengo (alguna )?oferta|que tengo (hoy|para mi))/)) return 'ofertas';
    if (habla(/(promo|oferta|descuento|2x1|dos por uno|rebaja|liquidacion)/) && !habla(/(cerca de mi|por aqui|aqui cerca)/)) return 'promociones';
    if (ent.actividad || habla(/\b(evento|eventos|concierto|conciertos|feria|ferias|taller|talleres|show|shows|espectaculo|actividad|actividades|que hacer|presentacion)\b/) || habla(/que (hay|hacer|planes)( para)? (hoy|manana|esta noche|esta tarde|(este |el )?fin de semana|el sabado|el domingo)/)) return 'eventos';
    if (habla(/(parqueo|estacionamiento|parking|estacionar|mi auto|mi carro|mi vehiculo)/)) return 'parqueo';
    // Información general del Paseo (medios de pago, devoluciones…) cargada por la administración
    if (ent.ev.infoFuerte || (ent.ev.info.length && !ent.ev.productos.length && !ent.locales.length)) return 'info';
    // Días de atención: «¿abren los domingos?», «¿qué días atiende Napoli?»
    if (habla(/\b(abre|abren|atiende|atienden|abierto|abierta|abiertos|trabajan)\b.*\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado|feriado)s?\b/) || habla(/\b(que dias|dias de atencion)\b/)) return 'horario';
    // Un servicio nombrado («¿cuánto cuesta el casillero?», «¿a qué hora abre la enfermería?») se responde con el servicio
    if (ent.servicio && !ent.locales.length && !ent.ev.productos.length) return 'servicio';
    if (ent.ev.vertical && !ent.locales.length) return 'zona';
    if (habla(/(cuanto (tarda|demora|se tarda|se demora)|tiempo de preparacion|en cuanto tiempo|cuanto tiempo)/)) return 'tiempo';
    if (habla(/(a que hora (abre|abren|cierra|cierran)|horario|esta abiert|estan abiert|sigue abiert|atiende|atienden|hasta que hora|cierra |cierran )/)) return 'horario';
    if (habla(/(cuanto (cuesta|cuestan|vale|valen|sale|salen|esta|estan)|precio|a cuanto|mas barat|mas economic)/)) return 'precio';
    if (ent.servicio && !ent.locales.length) return 'servicio';
    if (habla(/((que hay|algo|ofertas?).*(cerca|por aqui|aqui)|cerca de mi|por aqui cerca)/)) return 'cerca';
    if (ent.ev.zonas.length && !ent.locales.length && !ent.ev.localesNombre.length && !ent.ev.productos.length) return 'zona';
    if (habla(/(donde (esta|estan|queda|quedan|encuentro|hay|puedo|venden)|como llego|como voy|llevame|quiero ir|ir a\b|ruta|camino (a|al|hacia))/)) return 'donde';
    if (habla(/(tengo hambre|que (me )?recomiendas|que como|que puedo comer|quiero comer|ganas de comer|algo (dulce|rico|barato|economico|para comer|de comer)|donde como|recomienda|sugerencia|antojo|regalo para|que le regalo|aburrido|que hago|que me sugieres|tengo sed)/)) return 'recomendacion';
    if (habla(/(que venden|que tiene|que hay en|informacion de|telefono|numero de|de que es|que es)/) && ent.locales.length) return 'local_info';
    // «¿Hay…?», «¿tienen…?», «quiero un café», «necesito pilas»: buscar con evidencia y decir si no existe
    if (habla(/^(hay|habra|tienen|tiene|tendran|venden|vende|existe|existen|busco|buscame|busca|encuentra|necesito|quiero|quisiera|me gustaria|donde (compro|consigo)|en que (tienda|local) (venden|hay|tienen|encuentro|compro))\b/)
      || habla(/\b(hay|tienen|venden) (algun|alguna|un|una|unos|unas)\b/) || habla(/\b(quiero comprar|necesito comprar)\b/)) return 'buscar';

    // «¿Y la óptica?», «¿y en Napoli?»: misma pregunta que la anterior, sobre otra cosa
    const anterior = [...c.hilo].reverse().find((x) => x.rol === 'cliente')?.intencion as Intencion | undefined;
    if (palabras <= 5 && /^(y|e|y en|y el|y la|y los|y las|y para)\b/.test(t) && anterior && ['horario', 'precio', 'tiempo', 'donde', 'local_info', 'promociones', 'servicio'].includes(anterior)) {
      if (ent.locales.length || ent.productos.length || ent.servicio) return ent.servicio && !ent.locales.length ? 'servicio' : anterior === 'servicio' ? 'donde' : anterior;
    }

    // Solo entidades: «Napoli», «salteñas», «el baño», «tiendas de ropa»
    if (ent.productos.length) return 'producto';
    if (ent.locales.length) return 'local_info';
    if (ent.servicio) return 'servicio';
    if (ent.categoria || ent.ev.localesRubro.length) return 'buscar';

    // Seguimiento corto: «¿y ahí?», «¿y cómo llego?», «¿y el otro?»
    if (palabras <= 6 && (mem.localId || mem.productoId || mem.servicioTipo || mem.actividadId)) {
      if (r(/(llego|voy|ir|ruta|camino|lejos|donde)/)) return 'donde';
      if (r(/(hora|abre|cierra|abierto)/)) return 'horario';
      if (r(/(cuesta|precio|vale|cuanto)/)) return 'precio';
      if (r(/(tarda|demora|tiempo)/)) return 'tiempo';
    }
    return 'desconocida';
  }

  /** ¿La frase nombra algo que existe en los datos del Paseo? */
  private static hayEvidencia(e: Encontrado) {
    const v = e.ev;
    return !!(e.locales.length || e.productos.length || e.servicio || e.categoria || v.servicios.length || v.info.length || v.zonas.length || v.vertical
      || v.localesNombre.length || v.localesRubro.length || v.productos.length || v.productosRelacionados.length);
  }

  /**
   * Sin reglas ni evidencia: el modelo local solo elige entre intenciones que consultan datos.
   * Si duda, «libre», que responde con honestidad que no tiene ese dato.
   */
  private async clasificarConModelo(c: Ctx): Promise<Intencion> {
    const j = await this.cerebro.json<{ intencion: Intencion }>(
      `Clasifica lo que dice un cliente de un centro comercial. Responde solo JSON {"intencion":"..."} con una de: ${CLASIFICABLES.join(', ')}.
saldo = cuántos puntos tiene; nivel = su nivel del programa; canjes = qué puede canjear; vencimiento = cuándo vencen sus puntos; movimientos = sus últimas compras o puntos;
oportunidades = dónde ganar más puntos; promociones = ofertas o descuentos del Paseo; ofertas = sus ofertas personales; eventos = actividades o shows;
misiones = sus retos; drops = ofertas relámpago; parqueo = estacionamiento; recomendacion = qué le recomiendas comer, comprar o hacer;
pedido_estado = su pedido de PaseoYa; libre = cualquier otra cosa o si no estás seguro.`,
      `${MemoriaJarvis.paraPrompt(c.hilo, 4)}\nCliente: ${c.original}`,
    );
    return j && CLASIFICABLES.includes(j.intencion) ? j.intencion : 'libre';
  }

  // ================================================================== respuestas

  private manejar(i: Intencion, c: Ctx): Promise<Borrador> {
    const h: Record<Intencion, (c: Ctx) => Promise<Borrador>> = {
      saludo: (c) => this.saludo(c),
      gracias: async (c) => ({
        texto: /(chau|chao|adios|hasta luego|nos vemos)/.test(c.t) ? `¡Que disfrutes el Paseo${c.nombre ? `, ${c.nombre}` : ''}! Aquí estoy cuando me necesites.` : `¡Con gusto${c.nombre ? `, ${c.nombre}` : ''}! Si necesitas algo más, solo pregúntame.`,
        reescribir: false,
      }),
      ayuda: async (c) => {
        if (/paseo points|programa|puntos/.test(c.t)) {
          const r = await this.fidelizacion.reglaVigente(this.db, c.recintoId);
          return {
            texto: `Paseo Points es el programa de puntos del Paseo Aranjuez: ganas 1 punto por cada ${Number(r.bs_por_punto) === 1 ? 'boliviano' : dinero(r.bs_por_punto)} que gastas, ${r.puntos_visita_diaria} puntos por tu primera visita del día y ${r.puntos_descubrimiento} por cada local nuevo que descubres. Los canjeas por comida, entradas, descuentos o parqueo, y vencen a los ${r.dias_vencimiento} días.`,
            reescribir: false,
            sugerencias: ['¿Cuántos puntos tengo?', '¿Qué puedo canjear?', '¿Dónde gano más puntos?'],
          };
        }
        return {
        texto: 'Soy Jarvis, tu guía en el Paseo Aranjuez. Puedo decirte qué promociones y eventos hay, dónde está una tienda, un baño o un cajero automático, cuánto cuesta algo y cuánto tarda, cómo va tu pedido de PaseoYa y cuántos puntos tienes o puedes ganar.',
        reescribir: false,
        sugerencias: ['¿Qué promociones hay ahora?', '¿Qué eventos hay hoy?', '¿Dónde hay un baño?', '¿Cuántos puntos tengo?'],
        };
      },
      reinicio: async (c) => {
        if (c.clienteId) await this.memoria.reiniciar(c.clienteId);
        return { texto: 'Listo, empezamos de nuevo. ¿En qué te ayudo?', reescribir: false };
      },
      afirmacion: (c) => this.saludo(c),
      saldo: (c) => this.saldo(c),
      nivel: (c) => this.nivel(c),
      canjes: (c) => this.canjes(c),
      vencimiento: (c) => this.vencimiento(c),
      movimientos: (c) => this.movimientos(c),
      puntos_ganar: (c) => this.puntosGanar(c),
      oportunidades: (c) => this.oportunidades(c),
      promociones: (c) => this.promociones(c),
      ofertas: (c) => this.ofertas(c),
      eventos: (c) => this.eventos(c),
      misiones: (c) => this.misiones(c),
      drops: (c) => this.drops(c),
      parqueo: (c) => this.parqueo(c),
      horario: (c) => this.horario(c),
      local_info: (c) => this.localInfo(c),
      donde: (c) => this.donde(c),
      servicio: (c) => this.servicio(c),
      precio: (c) => this.precio(c),
      producto: (c) => this.producto(c),
      tiempo: (c) => this.tiempo(c),
      recomendacion: (c) => this.recomendacion(c),
      pedido_estado: (c) => this.pedidoEstado(c),
      pedido_donde: (c) => this.pedidoDonde(c),
      espera: (c) => this.espera(c),
      cerca: (c) => this.cerca(c),
      buscar: (c) => this.buscarTema(c),
      info: (c) => this.info(c),
      zona: (c) => this.zona(c),
      conteo: (c) => this.conteo(c),
      cartelera: (c) => this.cartelera(c),
      fuera_de_tema: async (c) => this.fueraDeTema(c),
      libre: (c) => this.libre(c),
      desconocida: (c) => this.libre(c),
    };
    return h[i](c);
  }

  private sinSesion(): Borrador {
    return { texto: 'Para eso necesito saber quién eres: inicia sesión en la app de Paseo Points.', reescribir: false };
  }

  private async rutaHasta(c: Ctx, destino: string): Promise<{ ruta?: Ruta; conocida: boolean }> {
    const pos = c.clienteId ? await this.orientacion.posicion(c.clienteId) : { nodoId: 'N1:entrada:norte', conocida: false };
    const r = await this.orientacion.ruta(c.recintoId, pos.nodoId, destino);
    return { ruta: r ? OrientacionService.paraApp(r) : undefined, conocida: pos.conocida };
  }

  /** Primer paso útil de la ruta, en minúscula para continuar una oración. */
  private static primerPaso(r: Ruta) {
    const p = r.pasos.find((x) => !x.startsWith('Sal de')) ?? r.pasos[0];
    return p.charAt(0).toLowerCase() + p.slice(1);
  }

  private static ubicacion(l: { piso: string; numero_local: string }) {
    return `${enPiso(l.piso).replace(/^en /, '')}, local ${l.numero_local}`;
  }

  /** «Nivel 1, local 112», «Planta baja, local PB-01» (para listas entre paréntesis). */
  private static ubicacionCorta(l: { piso: string; numero_local: string }) {
    return `${NOMBRE_PISO[l.piso]}, local ${l.numero_local}`;
  }

  // ------------------------------------------------------------------ saludo

  private async saludo(c: Ctx): Promise<Borrador> {
    const ya = c.hilo.some((x) => x.rol === 'cliente');
    const hora = Number(ahoraBolivia().hhmm.slice(0, 2));
    const saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
    const partes = [ya ? `¡Aquí sigo${c.nombre ? `, ${c.nombre}` : ''}!` : `¡${saludo}${c.nombre ? `, ${c.nombre}` : ''}! Soy Jarvis.`];
    let ofertaLocal: string | undefined;
    if (c.clienteId) {
      const pedidos = await this.saber.pedidosAbiertos(c.clienteId);
      const listo = pedidos.find((p) => p.estado === 'listo');
      if (listo) partes.push(`Tu pedido de ${listo.nombre} ya está listo para retirar.`);
      // Lo personal primero: las ofertas que la IA preparó hoy para este cliente
      const ofertas = (await this.saber.ofertasHoy(c.clienteId)).filter((o) => o.estado === 'activa' && !o.paso);
      if (ofertas[0]) {
        const o = ofertas.find((x) => x.ahora) ?? ofertas[0];
        ofertaLocal = o.local_id;
        partes.push(`Hoy tienes ${ofertas.length === 1 ? 'una oferta' : `${ofertas.length} ofertas`} solo para ti, como puntos por ${Number(o.multiplicador)} en ${o.local} ${o.ahora ? `ahora mismo, hasta ${horaVoz(o.hora_fin)}` : `desde ${horaVoz(o.hora_inicio)}`}.`);
      }
    }
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId)).filter((p) => p.ahora);
    const eventos = (await this.saber.eventos(c.recintoId, new Date(), finDelDia())).filter((e) => e.en_curso || new Date(e.inicio) > new Date());
    if (eventos[0]) partes.push(`Hoy hay ${eventos.length === 1 ? 'un evento' : `${eventos.length} eventos`}, como ${eventos[0].titulo} ${eventos[0].en_curso ? 'ahora mismo' : `a ${horaVoz(hhmmBo(eventos[0].inicio))}`}.`);
    else if (promos[0] && !ofertaLocal) partes.push(`Ahora mismo hay ${promos.length === 1 ? 'una promoción activa' : `${promos.length} promociones activas`}, como ${promos[0].titulo}${promos[0].local ? ` en ${promos[0].local}` : ''}.`);
    partes.push('¿En qué te ayudo?');
    return {
      texto: partes.join(' '),
      reescribir: false,
      entidades: { localId: ofertaLocal },
      sugerencias: ['¿Qué ofertas tengo hoy?', '¿Qué me recomiendas?', '¿Qué eventos hay hoy?', '¿Cómo va mi pedido?'],
    };
  }

  // ------------------------------------------------------------------ puntos

  private async saldo(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const r = await this.fidelizacion.resumen(c.clienteId, c.recintoId);
    const vence = r.porVencer[0];
    const reservado = r.reservado > 0 ? ` ${r.reservado} están reservados en cupones sin usar.` : '';
    return {
      texto: `${c.nombre}, tienes ${r.saldo} puntos, que equivalen a ${dinero(r.valorBs)}.${reservado}${vence ? ` Ojo: ${vence.puntos} vencen el ${fechaVoz(vence.fecha)}.` : ''} ¿Quieres ver qué puedes canjear?`,
      propuesta: { intencion: 'canjes', entidades: {} },
      sugerencias: ['¿Qué puedo canjear?', '¿Dónde gano más puntos?', '¿Qué nivel tengo?'],
    };
  }

  private async nivel(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const n = (await this.fidelizacion.resumen(c.clienteId, c.recintoId)).nivel;
    const ben = n.beneficios.slice(0, 2).map((b: string) => b.charAt(0).toLowerCase() + b.slice(1));
    return {
      texto: n.siguiente
        ? `${c.nombre}, eres nivel ${n.nivel}${ben.length ? `, con beneficios como ${lista(ben)}` : ''}. Te faltan ${n.faltan} puntos ganados para llegar a ${n.siguiente}.`
        : `${c.nombre}, ya tienes el nivel más alto, ${n.nivel}${ben.length ? `: disfrutas ${lista(ben)}` : ''}.`,
      claves: [n.nivel],
      sugerencias: ['¿Dónde gano más puntos?', '¿Qué puedo canjear?'],
    };
  }

  private async canjes(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const resumen = await this.fidelizacion.resumen(c.clienteId, c.recintoId);
    const cat = await this.recompensas.catalogo(c.recintoId, c.clienteId);
    const posibles = cat.recompensas.filter((r: any) => r.puedeCanjear).sort((a: any, b: any) => b.costo_puntos - a.costo_puntos).slice(0, 3);
    const proxima = cat.recompensas.filter((r: any) => !r.puedeCanjear).sort((a: any, b: any) => a.faltan - b.faltan)[0];
    const texto = posibles.length
      ? `Con tus ${resumen.disponible} puntos disponibles puedes canjear ${lista(posibles.map((r: any) => `${r.nombre} por ${r.costo_puntos} puntos`))}.${proxima ? ` Y te faltan ${proxima.faltan} para ${proxima.nombre}.` : ''}`
      : `Todavía no te alcanza para un canje: tienes ${resumen.disponible} puntos disponibles${resumen.reservado ? ` (otros ${resumen.reservado} están reservados en un cupón sin usar)` : ''}.${proxima ? ` Te faltan ${proxima.faltan} para ${proxima.nombre}.` : ''}`;
    return { texto, reescribir: false, recompensas: posibles, acciones: [{ etiqueta: 'Ver canjes', ruta: '/canjes' }], sugerencias: ['¿Dónde gano más puntos?'] };
  }

  private async vencimiento(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const r = await this.fidelizacion.resumen(c.clienteId, c.recintoId);
    if (!r.porVencer.length) return { texto: `Buenas noticias${c.nombre ? `, ${c.nombre}` : ''}: no tienes puntos por vencer pronto. Los puntos duran 12 meses desde que los ganas.`, reescribir: false };
    const v = r.porVencer.slice(0, 2).map((p: any) => `${p.puntos} el ${fechaVoz(p.fecha)}`);
    return { texto: `Se te vencen ${lista(v)}. Te conviene canjearlos antes. ¿Vemos qué puedes canjear?`, propuesta: { intencion: 'canjes', entidades: {} } };
  }

  private async movimientos(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const ms = await this.saber.ultimosMovimientos(c.clienteId, 3);
    if (!ms.length) return { texto: 'Todavía no tienes movimientos de puntos.', reescribir: false };
    const f = (m: any) => `${m.puntos > 0 ? `ganaste ${m.puntos}` : `usaste ${-m.puntos}`} puntos ${diaVoz(m.creado_en)} por ${m.descripcion.charAt(0).toLowerCase() + m.descripcion.slice(1)}${m.local ? ` en ${m.local}` : ''}`;
    return { texto: `Lo último: ${lista(ms.map(f))}.`, reescribir: false, acciones: [{ etiqueta: 'Ver movimientos', ruta: '/movimientos' }] };
  }

  private async puntosGanar(c: Ctx): Promise<Borrador> {
    const regla = await this.fidelizacion.reglaVigente(this.db, c.recintoId);
    const monto = Number(/(\d+(?:[.,]\d+)?)/.exec(c.t)?.[1]?.replace(',', '.') ?? NaN);
    const localId = c.ent.locales[0]?.id ?? c.ent.productos[0]?.local_id ?? c.mem.localId;
    const local = localId ? await this.saber.local(localId) : null;
    const promo = local ? await this.saber.mejorPromo(c.recintoId, local.id, c.clienteId) : null;
    if (!Number.isFinite(monto)) {
      const base = `Ganas 1 punto por cada ${Number(regla.bs_por_punto) === 1 ? 'boliviano' : dinero(regla.bs_por_punto)} que gastas${local ? ` en ${local.nombre}` : ''}`;
      const extra = promo ? `, y ahora ${local!.nombre} tiene ${promo.titulo}, así que se multiplican por ${promo.multiplicador}` : '';
      return { texto: `${base}${extra}. Dime un monto y te calculo exacto, por ejemplo «si gasto 100 bolivianos».`, claves: local ? [local.nombre] : [], entidades: { localId: local?.id } };
    }
    const cot = this.fidelizacion.cotizar(regla, monto, local?.categoria ?? null, new Date(), promo);
    const porque = cot.detalle.length ? `, porque aplica ${lista(cot.detalle.map((d) => d.replace(/ ×([\d.]+)$/, ' (por $1)')))}` : '';
    return {
      texto: `Si gastas ${dinero(monto)}${local ? ` en ${local.nombre}` : ''} ahora, ganas ${cot.puntos} puntos${porque}.`,
      claves: local ? [local.nombre] : [],
      reescribir: false,
      entidades: { localId: local?.id },
    };
  }

  private async oportunidades(c: Ctx): Promise<Borrador> {
    const partes: string[] = [];
    if (c.clienteId) {
      const ofertas = (await this.saber.ofertasHoy(c.clienteId)).filter((o) => o.estado === 'activa' && !o.paso);
      if (ofertas.length) partes.push(`Lo mejor para ti: tus ofertas personales de hoy, ${lista(ofertas.map((o) => `por ${Number(o.multiplicador)} en ${o.local} ${o.ahora ? 'ahora' : `desde ${horaVoz(o.hora_inicio)}`}`))}.`);
    }
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId)).filter((p) => p.ahora && p.tipo === 'puntos_dobles');
    if (promos.length) partes.push(`Ahora hay puntos multiplicados en ${lista(promos.slice(0, 3).map((p) => `${p.local ?? 'todo el Paseo'} (por ${Number(p.multiplicador)})`))}.`);
    if (c.clienteId) {
      const mis = await many<any>(
        this.db,
        `select m.nombre, m.meta, m.recompensa_puntos, coalesce(p.avance, 0) as avance from mision m left join progreso_mision p on p.mision_id = m.id and p.cliente_id = $2
         where m.recinto_id = $1 and m.activa and current_date between m.vigencia_desde and m.vigencia_hasta and (m.cliente_id is null or m.cliente_id = $2)
           and p.completada_en is null order by (m.meta - coalesce(p.avance, 0)) limit 1`,
        [c.recintoId, c.clienteId],
      );
      if (mis[0]) partes.push(`Y en la misión ${mis[0].nombre} vas ${mis[0].avance} de ${mis[0].meta}: al completarla ganas ${mis[0].recompensa_puntos} puntos.`);
    }
    const ev = (await this.saber.eventos(c.recintoId, new Date(), finDelDia())).find((e) => e.puntos > 0);
    if (ev) partes.push(`Además, si vas a ${ev.titulo} ${ev.en_curso ? 'ahora' : `a ${horaVoz(hhmmBo(ev.inicio))}`} ganas ${ev.puntos} puntos.`);
    if (!partes.length) partes.push('Ahora no hay promociones de puntos dobles, pero cada compra suma y la primera visita del día te da puntos.');
    return { texto: partes.join(' '), reescribir: false, acciones: [{ etiqueta: 'Ver misiones', ruta: '/misiones' }] };
  }

  // ------------------------------------------------------------------ promociones, eventos, drops, misiones

  private async promociones(c: Ctx): Promise<Borrador> {
    const local = c.ent.locales[0] ?? (/\b(ahi|ese|esa|alli)\b/.test(c.t) && c.mem.localId ? { id: c.mem.localId, nombre: '' } : null);
    const categoria = !local ? c.ent.categoria : null;
    let todas = await this.saber.promociones(c.recintoId, c.clienteId, { localId: local?.id, categoria: categoria ?? undefined });
    // «descuentos para estudiantes», «2x1 en pizza»: lo que pide y no es una palabra de promociones
    const pide = c.ent.ev.faltantes.filter((w) => !VOCABULARIO_PROMO.has(w));
    if (pide.length && !local) {
      const texto = (p: any) => norm(`${p.titulo} ${p.descripcion ?? ''}`).split(' ').map(raiz);
      const conEso = todas.filter((p) => pide.some((w) => texto(p).includes(w)));
      const que = pide.map((w) => comoLaDijo(c.original, w)).join(' ');
      if (!conEso.length) {
        const ahora = todas.filter((p) => p.ahora);
        return {
          texto: `No hay promociones especiales para «${que}» registradas en el Paseo.${ahora.length ? ` Las que hay ahora para todos son ${lista(ahora.slice(0, 3).map((p) => `${p.titulo}${p.local ? ` en ${p.local}` : ''}`))}${ahora.length > 3 ? `, y ${ahora.length - 3} más en la app` : ''}.` : ''}`,
          reescribir: false,
          sinDatos: `promoción: ${que}`,
          promociones: ahora.slice(0, 6),
          sugerencias: ['¿Dónde gano más puntos?', '¿Qué ofertas tengo hoy?'],
        };
      }
      todas = conEso;
    }
    // Primero lo que le interesa y lo que equilibra el flujo, no siempre los mismos locales
    const ahora = await this.recomendador.ordenar(c.recintoId, c.clienteId, todas.filter((p) => p.ahora));
    const luego = todas.filter((p) => p.mas_tarde_hoy);
    const nombreDe = (p: any) => `${p.titulo}${p.local ? ` en ${p.local}` : ''}${p.tipo === 'cupon' && p.descripcion ? ` (${p.descripcion.charAt(0).toLowerCase() + p.descripcion.slice(1)})` : ''}`;
    const filtro = local ? (local.nombre ? ` en ${local.nombre}` : ' ahí') : categoria ? ` de ${categoria.toLowerCase()}` : '';
    let texto: string;
    if (ahora.length) {
      texto = `Ahora mismo hay ${ahora.length === 1 ? 'una promoción' : `${ahora.length} promociones`}${filtro}: ${lista(ahora.slice(0, 3).map(nombreDe))}${ahora.length > 3 ? `, y ${ahora.length - 3} más en la app` : ''}.`;
      if (luego[0]) texto += ` Más tarde empieza ${luego[0].titulo} a ${horaVoz(luego[0].hora_inicio)}.`;
    } else if (luego.length) {
      texto = `En este momento no hay promociones activas${filtro}, pero hoy empieza ${luego[0].titulo}${luego[0].local ? ` en ${luego[0].local}` : ''} a ${horaVoz(luego[0].hora_inicio)}.`;
    } else if (todas.length) {
      const p = todas[0];
      const dias = (p.dias_semana as number[]).map((d) => ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'][d]);
      texto = `Hoy no hay promociones activas${filtro}. La próxima es ${p.titulo}${p.local ? ` en ${p.local}` : ''}, los ${lista(dias)} de ${horaVoz(p.hora_inicio)} a ${horaVoz(p.hora_fin)}.`;
    } else texto = `No hay promociones vigentes${filtro} por ahora. Si quieres, te aviso de los eventos de hoy.`;
    if (c.clienteId && !local) {
      const mia = (await this.saber.ofertasHoy(c.clienteId)).find((o) => o.estado === 'activa' && !o.paso);
      if (mia) texto += ` Y solo para ti: puntos por ${Number(mia.multiplicador)} en ${mia.local} ${mia.ahora ? `hasta ${horaVoz(mia.hora_fin)}` : `desde ${horaVoz(mia.hora_inicio)}`}.`;
    }
    const primera = ahora[0] ?? luego[0];
    return {
      texto,
      reescribir: false,
      promociones: (ahora.length ? ahora : todas).slice(0, 6),
      entidades: { localId: local?.id ?? primera?.local_id },
      propuesta: primera?.local_id ? { intencion: 'donde', entidades: { localId: primera.local_id } } : { intencion: 'eventos', entidades: {} },
      sugerencias: primera?.local_id ? [`¿Cómo llego a ${primera.local}?`, '¿Dónde gano más puntos?'] : ['¿Qué eventos hay hoy?'],
    };
  }

  private rangoEventos(t: string): { desde: Date; hasta: Date; etiqueta: string } {
    const hoy0 = inicioDelDia();
    const dia = 86400_000;
    if (/\bmanana\b/.test(t)) return { desde: new Date(hoy0.getTime() + dia), hasta: new Date(hoy0.getTime() + 2 * dia), etiqueta: 'mañana' };
    if (/fin de semana|sabado|domingo/.test(t)) {
      const dow = new Date(hoy0.getTime() - 4 * 3600_000 + 12 * 3600_000).getUTCDay();
      const hastaSab = (6 - dow + 7) % 7;
      const desde = dow === 0 ? hoy0 : new Date(hoy0.getTime() + hastaSab * dia);
      return { desde: desde < new Date() ? new Date() : desde, hasta: new Date(hoy0.getTime() + (dow === 0 ? 1 : hastaSab + 2) * dia), etiqueta: 'este fin de semana' };
    }
    if (/\bhoy\b|ahora|esta noche|esta tarde/.test(t)) return { desde: new Date(), hasta: finDelDia(), etiqueta: 'hoy' };
    return { desde: new Date(), hasta: new Date(hoy0.getTime() + 8 * dia), etiqueta: 'esta semana' };
  }

  private async eventos(c: Ctx): Promise<Borrador> {
    const id = c.ent.actividad?.id ?? (!/\b(eventos|que hay)\b/.test(c.t) ? c.mem.actividadId : undefined);
    if (id) {
      const a = await this.saber.actividad(id);
      if (a && a.estado === 'aprobada') {
        const precio = a.precio_bs == null || Number(a.precio_bs) === 0 ? 'la entrada es libre' : `la entrada cuesta ${dinero(a.precio_bs)}`;
        const cuando = a.en_curso || (new Date(a.inicio) <= new Date() && new Date(a.fin) > new Date()) ? `está pasando ahora, hasta ${horaVoz(hhmmBo(a.fin))}` : `es ${diaVoz(a.inicio)} de ${horaVoz(hhmmBo(a.inicio))} a ${horaVoz(hhmmBo(a.fin))}`;
        const destino = a.local_id ? `local:${a.local_id}` : null;
        return {
          texto: `${a.titulo} ${cuando} en ${a.lugar}; ${precio}${a.puntos ? ` y ganas ${a.puntos} puntos por asistir` : ''}.${a.cupos ? ` Hay ${a.cupos} cupos.` : ''} ${a.descripcion ? a.descripcion : ''}`.trim(),
          claves: [a.titulo],
          entidades: { actividadId: a.id, localId: a.local_id ?? undefined },
          propuesta: destino ? { intencion: 'donde', entidades: { localId: a.local_id } } : undefined,
          eventos: [a],
          sugerencias: destino ? ['¿Cómo llego?', '¿Qué otros eventos hay?'] : ['¿Qué otros eventos hay?'],
        };
      }
    }
    const r = this.rangoEventos(c.t);
    const lista_ = await this.saber.eventos(c.recintoId, r.desde, r.hasta);
    if (!lista_.length) {
      const prox = (await this.saber.eventos(c.recintoId, new Date(), new Date(Date.now() + 45 * 86400_000)))[0];
      return {
        texto: `No hay eventos ${r.etiqueta}.${prox ? ` El próximo es ${prox.titulo}, ${diaVoz(prox.inicio)} a ${horaVoz(hhmmBo(prox.inicio))} en ${prox.lugar}.` : ''}`,
        reescribir: false,
        eventos: prox ? [prox] : [],
        entidades: { actividadId: prox?.id },
      };
    }
    const f = (e: any) => `${e.titulo} ${e.en_curso ? 'ahora mismo' : `${r.etiqueta === 'hoy' ? '' : `${diaVoz(e.inicio)} `}a ${horaVoz(hhmmBo(e.inicio))}`} en ${e.lugar}`;
    return {
      texto: `${r.etiqueta.charAt(0).toUpperCase() + r.etiqueta.slice(1)} hay ${lista_.length === 1 ? 'un evento' : `${lista_.length} eventos`}: ${lista(lista_.slice(0, 3).map(f))}${lista_.length > 3 ? `, y ${lista_.length - 3} más` : ''}. ¿Quieres detalles de alguno?`,
      reescribir: false,
      eventos: lista_.slice(0, 8),
      entidades: { actividadId: lista_[0].id },
      propuesta: { intencion: 'eventos', entidades: { actividadId: lista_[0].id } },
      sugerencias: lista_.slice(0, 2).map((e) => `Cuéntame de ${e.titulo}`),
    };
  }

  private async drops(c: Ctx): Promise<Borrador> {
    const ds = (await this.saber.dropsActivos(c.recintoId)).filter((d) => d.quedan > 0);
    if (!ds.length) return { texto: 'Ahora no hay Drops activos. Cuando se abra uno, te aviso al instante.', reescribir: false };
    const d = ds[0];
    const { ruta } = await this.rutaHasta(c, `local:${d.local_id}`);
    return {
      texto: `Hay ${ds.length === 1 ? 'un Drop activo' : `${ds.length} Drops activos`}. ${d.producto} de ${d.local} a ${dinero(d.precio_especial)} en vez de ${dinero(d.precio_bs)}; quedan ${d.quedan} y termina ${diaVoz(d.fin) === 'hoy' ? '' : `${diaVoz(d.fin)} `}a ${horaVoz(hhmmBo(d.fin))}. Lo reclamas desde la app, en Drops, estando en el Paseo.${ruta && ruta.metros >= 10 ? ` ${d.local} está a ${ruta.metros} metros.` : ''}`,
      reescribir: false,
      ruta,
      entidades: { localId: d.local_id },
      acciones: [{ etiqueta: 'Ver Drops', ruta: '/drops' }],
    };
  }

  private async misiones(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const ms = await many<any>(
      this.db,
      `select m.nombre, m.descripcion, m.meta, m.recompensa_puntos, m.vigencia_hasta, coalesce(p.avance, 0) as avance, p.completada_en
       from mision m left join progreso_mision p on p.mision_id = m.id and p.cliente_id = $2
       where m.recinto_id = $1 and m.activa and current_date between m.vigencia_desde and m.vigencia_hasta and (m.cliente_id is null or m.cliente_id = $2)
       order by (p.completada_en is not null), (m.meta - coalesce(p.avance, 0))`,
      [c.recintoId, c.clienteId],
    );
    const abiertas = ms.filter((m) => !m.completada_en);
    if (!abiertas.length) return { texto: ms.length ? '¡Completaste todas tus misiones activas! Pronto habrá nuevas.' : 'No tienes misiones activas ahora.', reescribir: false };
    const f = (m: any) => `${m.nombre}: vas ${m.avance} de ${m.meta} y ganas ${m.recompensa_puntos} puntos`;
    return { texto: `Tienes ${abiertas.length === 1 ? 'una misión abierta' : `${abiertas.length} misiones abiertas`}. ${lista(abiertas.slice(0, 2).map(f))}.`, reescribir: false, acciones: [{ etiqueta: 'Ver misiones', ruta: '/misiones' }] };
  }

  // ------------------------------------------------------------------ locales, horarios, servicios, rutas

  /** Local del que se habla: el nombrado, el de un rubro («la farmacia»), el del producto o el de la conversación. */
  private async localObjetivo(c: Ctx) {
    if (c.ent.locales[0]) return c.ent.locales[0].id;
    const rubro = await this.localPorRubro(c);
    return rubro ?? c.ent.productos[0]?.local_id ?? c.mem.localId ?? c.mem.pedidoLocalId;
  }

  /** «la farmacia», «la óptica», «el cine»: si una palabra de la frase es el rubro de un solo local. */
  private async localPorRubro(c: Ctx) {
    for (const w of c.t.split(' ').filter((x) => x.length >= 4)) {
      const ls = await this.saber.localesPorTermino(c.recintoId, w);
      if (ls.length === 1 && ls[0].claves.some((k) => k === w || k === `${w}s` || `${k}s` === w)) return ls[0].id;
    }
    return undefined;
  }

  private async horario(c: Ctx): Promise<Borrador> {
    const id = await this.localObjetivo(c);
    const dia = DIAS_SEMANA.findIndex((d) => new RegExp(`\\b${d}s?\\b`).test(c.t));
    if (id && !/\b(paseo|centro comercial|mall)\b/.test(c.t)) {
      const l = await this.saber.local(id);
      if (l && dia >= 0) {
        const atiende = (l.dias_atencion ?? [0, 1, 2, 3, 4, 5, 6]).includes(dia);
        return {
          texto: atiende ? `Sí, ${l.nombre} atiende los ${DIAS_PLURAL[dia]}, de ${horaVoz(l.apertura)} a ${horaVoz(l.cierre)}.` : `No, ${l.nombre} no atiende los ${DIAS_PLURAL[dia]}.`,
          reescribir: false,
          entidades: { localId: l.id },
        };
      }
      if (l) {
        const estado = !l.activo
          ? 'pero por ahora no está atendiendo'
          : l.abierto
            ? l.minutosParaCerrar! <= 60
              ? `y ojo, cierra en ${duracionVoz(l.minutosParaCerrar!)}`
              : 'y ahora está atendiendo'
            : !l.abiertoHoy
              ? 'pero hoy no atiende'
              : 'y a esta hora no está atendiendo';
        return { texto: `${l.nombre} atiende de ${horaVoz(l.apertura)} a ${horaVoz(l.cierre)}, ${estado}.`, claves: [l.nombre], entidades: { localId: l.id } };
      }
    }
    const h = await one<any>(
      this.db,
      `select min(horario_apertura)::text as abre, max(horario_cierre)::text as cierra,
              min(horario_apertura) filter (where c.ambito = 'tiendas')::text as tiendas_abre, max(horario_cierre) filter (where c.ambito = 'tiendas')::text as tiendas_cierra,
              max(horario_cierre) filter (where c.ambito = 'comida')::text as comida_cierra
       from local l join categoria c on c.id = l.categoria_id where l.recinto_id = $1 and l.activo`,
      [c.recintoId],
    );
    if (dia >= 0) {
      const cerrados = await this.saber.cerradosElDia(c.recintoId, dia);
      return {
        texto: `Sí, el Paseo abre todos los días, también los ${DIAS_PLURAL[dia]}, de ${horaVoz(h.abre)} a ${horaVoz(h.cierra)}.${cerrados.length ? ` Ojo: ${lista(cerrados.map((x) => x.nombre))} no ${cerrados.length === 1 ? 'atiende' : 'atienden'} los ${DIAS_PLURAL[dia]}.` : ''}`,
        reescribir: false,
      };
    }
    return {
      texto: `El Paseo abre todos los días de ${horaVoz(h.abre)} a ${horaVoz(h.cierra)}. Las tiendas atienden de ${horaVoz(h.tiendas_abre)} a ${horaVoz(h.tiendas_cierra)} y el patio de comidas hasta ${horaVoz(h.comida_cierra)}.`,
      reescribir: false,
    };
  }

  private async localInfo(c: Ctx): Promise<Borrador> {
    const id = await this.localObjetivo(c);
    if (!id) return this.libre(c);
    const l = await this.saber.local(id);
    if (!l) return this.libre(c);
    const estado = !l.abierto ? (l.abiertoHoy ? `ahora no está atendiendo; abre a ${horaVoz(l.apertura)}` : 'hoy no atiende') : `ahora atiende hasta ${horaVoz(l.cierre)}`;
    const promo = l.promos.find((p: any) => p.ahora) ?? l.promos[0];
    const prod = l.productos[0];
    const partes = [`${l.nombre} está en ${JarvisService.ubicacion(l)}: ${l.descripcion.charAt(0).toLowerCase() + l.descripcion.slice(1)}. ${estado.charAt(0).toUpperCase() + estado.slice(1)}.`];
    // «¿Hay farmacia de turno?»: lo que pide además del local y no está en los datos
    const condicion = JarvisService.condicionSinDatos(c);
    if (condicion) partes.unshift(`No tengo información sobre «${condicion}».`);
    if (promo) partes.push(`${promo.ahora ? 'Tiene activa' : 'Hoy tiene'} ${promo.titulo}${promo.ahora ? '' : ` desde ${horaVoz(promo.hora_inicio)}`}.`);
    if (prod) partes.push(`Por ejemplo, ${prod.nombre} a ${dinero(prod.precio_bs)}.`);
    if (/telefono|numero|llamar/.test(c.t)) partes.push(l.telefono ? `Su teléfono es ${l.telefono.split('').join(' ')}.` : 'No tengo registrado su teléfono.');
    partes.push('¿Te llevo?');
    return {
      texto: partes.join(' '),
      reescribir: false,
      entidades: { localId: l.id },
      propuesta: { intencion: 'donde', entidades: { localId: l.id } },
      productos: l.productos.slice(0, 3).map((p: any) => ({ id: p.id, nombre: p.nombre, precioBs: Number(p.precio_bs), local: l.nombre, enlace: `paseopoints://paseoya/producto/${p.id}` })),
      sugerencias: [`¿Cómo llego a ${l.nombre}?`, `¿Qué promociones tiene ${l.nombre}?`],
    };
  }

  private async donde(c: Ctx): Promise<Borrador> {
    // Destino: lo que nombró ahora; si no nombró nada, lo último de la conversación
    if (c.ent.servicio && !c.ent.locales.length) return this.servicio(c);
    let localId: string | undefined = c.ent.locales[0]?.id ?? c.ent.productos[0]?.local_id;
    if (!localId && !c.ent.actividad) {
      const termino = c.t.replace(/.*(donde (esta|estan|queda|quedan|encuentro|hay|puedo|venden)|como llego a|como voy a|llevame a|quiero ir a|ir a|ruta a|camino (a|al|hacia))\s*/, '').replace(/^(el|la|los|las|un|una|al|a)\s+/, '');
      const porTermino = termino ? await this.saber.localesPorTermino(c.recintoId, termino) : [];
      if (porTermino.length) localId = porTermino[0].id;
      else if (termino && termino.length > 2 && !c.mem.localId) return this.buscarTema(c);
    }
    if (!localId && c.ent.actividad) {
      const a = await this.saber.actividad(c.ent.actividad.id);
      if (a?.local_id) localId = a.local_id;
    }
    if (!localId && c.mem.servicioTipo && !c.mem.localId) return this.servicio({ ...c, ent: { ...c.ent, servicio: { id: '', tipo: c.mem.servicioTipo, nombre: '', claves: [] } } });
    localId = localId ?? c.mem.localId ?? c.mem.pedidoLocalId;
    if (!localId) return { texto: '¿A qué lugar quieres ir? Dime el nombre de una tienda, un restaurante o un servicio como el baño.', reescribir: false };
    const l = await this.saber.local(localId);
    const { ruta, conocida } = await this.rutaHasta(c, `local:${localId}`);
    if (!l || !ruta) return { texto: 'No encontré un camino hasta ese lugar.', reescribir: false };
    const desde = conocida ? '' : ' desde la Puerta Norte (escanea un QR del Paseo para ubicarte mejor)';
    return {
      texto: ruta.metros < 10
        ? `Ya estás en ${l.nombre}, ${JarvisService.ubicacion(l)}.`
        : `${l.nombre} está en ${JarvisService.ubicacion(l)}, a ${ruta.metros} metros${desde}, ${ruta.minutos === 1 ? 'un minuto' : `unos ${ruta.minutos} minutos`} caminando. Primero ${JarvisService.primerPaso(ruta)}`,
      claves: [l.nombre],
      ruta,
      entidades: { localId },
      acciones: [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }],
      sugerencias: [`¿A qué hora cierra ${l.nombre}?`, `¿Qué promociones tiene ${l.nombre}?`],
    };
  }

  private async servicio(c: Ctx): Promise<Borrador> {
    const tipo = c.ent.servicio?.tipo ?? c.mem.servicioTipo;
    if (!tipo) return this.libre(c);
    let lista_ = await this.saber.servicios(c.recintoId, tipo);
    if (!lista_.length) return this.libre(c);
    // «el cajero del Banco Unión»: si nombró uno en particular, ese y no el más cercano
    const coinciden = (s: any) => raicesDe(s.nombre).filter((r) => c.ent.ev.palabras.includes(r)).length;
    const max = Math.max(...lista_.map(coinciden));
    if (max > Math.min(...lista_.map(coinciden))) lista_ = lista_.filter((s) => coinciden(s) === max);
    // El más cercano caminando
    let mejor: { s: any; ruta?: Ruta } = { s: lista_[0] };
    for (const s of lista_) {
      const { ruta } = await this.rutaHasta(c, `servicio:${s.id}`);
      if (ruta && (!mejor.ruta || ruta.metros < mejor.ruta.metros)) mejor = { s, ruta };
    }
    const s = mejor.s;
    // Preguntas de información, no de lugar: «¿hay wifi?», «¿puedo entrar con mi perro?»
    if (tipo === 'wifi') return { texto: `Sí, hay wifi gratis en todo el Paseo. ${s.descripcion}`, reescribir: false, entidades: { servicioTipo: tipo } };
    if (tipo === 'mascotas') return { texto: `${/(puedo|se puede|dejan|permiten)/.test(c.t) ? 'Sí, con condiciones. ' : ''}${s.descripcion}`, reescribir: false, entidades: { servicioTipo: tipo } };
    const etiqueta = lista_.length > 1 ? (GENERICO[tipo] ?? `${s.nombre} más cercano`) : s.nombre;
    const donde = mejor.ruta
      ? mejor.ruta.metros < 10
        ? 'justo donde estás'
        : `${enPiso(s.piso)}, a ${mejor.ruta.metros} metros: ${JarvisService.primerPaso(mejor.ruta)}`
      : enPiso(s.piso);
    const horario = s.horario ? ` Atiende ${s.horario}.` : '';
    const frase =
      tipo === 'objetos_perdidos'
        ? `Lo siento. ${s.descripcion} Está ${donde}`
        : `${etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1)} ${/^(los|las) /.test(etiqueta) ? 'están' : 'está'} ${donde}${/[.!?]$/.test(donde) ? '' : '.'} ${s.descripcion}`;
    return {
      texto: `${frase.trim()}${horario}`.replace(/\.\./g, '.').replace(/([^.!?])$/, '$1.'),
      reescribir: false,
      ruta: mejor.ruta,
      entidades: { servicioTipo: tipo },
      acciones: mejor.ruta ? [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }] : undefined,
    };
  }

  // ------------------------------------------------------------------ productos, precios, tiempos

  /**
   * Productos de lo que nombró; si no nombró nada, del producto o local del que se venía hablando.
   * Nunca devuelve productos de otra cosa: si nombró algo que no existe, devuelve vacío.
   */
  private async productosObjetivo(c: Ctx) {
    const ev = c.ent.ev;
    // Primero lo que coincide palabra por palabra; si no hay, lo reconocido con tolerancia a errores de voz
    const nombrados = ev.productos.length ? ev.productos.map((p) => p.id) : c.ent.productos.map((p) => p.id);
    if (nombrados.length) {
      const ps = await this.saber.productos(nombrados.slice(0, 12));
      const deLocal = c.ent.locales[0] ? ps.filter((p: any) => p.local_id === c.ent.locales[0].id) : [];
      return deLocal.length ? deLocal : ps;
    }
    const nombroAlgo = ev.faltantes.length > 0 || ev.productosRelacionados.length > 0;
    if (nombroAlgo && !c.ent.locales.length) return [];
    if (c.mem.productoId && !c.ent.locales.length) return this.saber.productos([c.mem.productoId]);
    const localId = c.ent.locales[0]?.id ?? (!nombroAlgo ? c.mem.localId : undefined);
    if (localId) {
      const l = await this.saber.local(localId);
      return l ? this.saber.productos(l.productos.map((p: any) => p.id)) : [];
    }
    return [];
  }

  /** «No encontré «nike» específicamente.»: lo que pidió y no está en los datos. */
  private static nota(c: Ctx) {
    const f = c.ent.ev.faltantes;
    return f.length ? `No encontré «${f.map((w) => comoLaDijo(c.original, w)).join(' ')}» específicamente; lo más parecido: ` : '';
  }

  private static tarjetas(ps: any[]) {
    return ps.slice(0, 4).map((p) => ({ id: p.id, nombre: p.nombre, precioBs: Number(p.precio_bs), local: p.local, enlace: `paseopoints://paseoya/producto/${p.id}` }));
  }

  private async precio(c: Ctx): Promise<Borrador> {
    const ps = await this.productosObjetivo(c);
    if (!ps.length) {
      if (c.ent.ev.palabras.length) return this.buscarTema(c, 'precio');
      return { texto: '¿De qué producto quieres saber el precio? Por ejemplo, «¿cuánto cuesta la pizza familiar?».', reescribir: false };
    }
    const nota = JarvisService.nota(c);
    if (ps.length === 1) {
      const p = ps[0];
      const stock = p.stock === 0 ? ' Ahora está agotado.' : p.stock <= 5 ? ` Quedan solo ${p.stock}.` : '';
      const drop = (await this.saber.dropsActivos(c.recintoId)).find((d) => d.producto_id === p.id && d.quedan > 0);
      const oferta = drop ? ` Pero ahora hay un Drop: lo consigues a ${dinero(drop.precio_especial)} hasta ${horaVoz(hhmmBo(drop.fin))}; reclámalo en la app, en Drops.` : '';
      return {
        texto: `${nota}${p.nombre} cuesta ${dinero(p.precio_bs)}${p.local ? ` en ${p.local}` : ''}.${stock}${oferta} ¿Quieres pedirlo por PaseoYa o que te lleve al local?`,
        claves: p.local ? [p.local] : [],
        reescribir: false,
        entidades: { productoId: p.id, localId: p.local_id },
        propuesta: { intencion: 'donde', entidades: { localId: p.local_id } },
        productos: JarvisService.tarjetas(ps),
        acciones: drop ? [{ etiqueta: 'Ver Drops', ruta: '/drops' }] : undefined,
      };
    }
    const orden = [...ps].sort((a, b) => Number(a.precio_bs) - Number(b.precio_bs));
    const top = orden.slice(0, 3).map((p) => `${p.nombre} a ${dinero(p.precio_bs)}${p.local ? ` en ${p.local}` : ''}`);
    return {
      texto: nota
        ? `${nota}${top[0]}${top.length > 1 ? `; también ${lista(top.slice(1))}` : ''}.`
        : `Encontré ${ps.length} opciones. ${/barat|economic/.test(c.t) ? 'La más barata es' : 'Van desde'} ${top[0]}${top.length > 1 ? `; también ${lista(top.slice(1))}` : ''}.`,
      reescribir: false,
      entidades: { productoId: orden[0].id, localId: orden[0].local_id },
      propuesta: { intencion: 'donde', entidades: { localId: orden[0].local_id } },
      productos: JarvisService.tarjetas(orden),
    };
  }

  private async producto(c: Ctx): Promise<Borrador> {
    const ps = await this.productosObjetivo(c);
    if (!ps.length) return this.buscarTema(c);
    const orden = [...ps].sort((a, b) => Number(a.precio_bs) - Number(b.precio_bs));
    const p = orden[0];
    const locales = [...new Set(orden.map((x) => x.local))];
    const nota = JarvisService.nota(c);
    return {
      texto: nota
        ? `${nota}${p.nombre} en ${p.local}, a ${dinero(p.precio_bs)}, en ${JarvisService.ubicacion(p)}.${orden.length > 1 ? ` También ${lista(orden.slice(1, 3).map((x) => `${x.nombre} en ${x.local} a ${dinero(x.precio_bs)}`))}.` : ''} ¿Te llevo?`
        : `${ps.length === 1 ? `Sí, ${p.local} tiene ${p.nombre}` : `Hay ${ps.length} opciones en ${locales.length === 1 ? locales[0] : `${locales.length} locales`}; la más barata es ${p.nombre} en ${p.local}`} a ${dinero(p.precio_bs)}, en ${JarvisService.ubicacion(p)}. ¿Te llevo o prefieres pedirlo por PaseoYa?`,
      reescribir: false,
      entidades: { productoId: p.id, localId: p.local_id },
      propuesta: { intencion: 'donde', entidades: { localId: p.local_id } },
      productos: JarvisService.tarjetas(orden),
    };
  }

  private async tiempo(c: Ctx): Promise<Borrador> {
    const sinObjeto = !c.ent.productos.length && !c.ent.locales.length && !c.mem.productoId;
    if (/\b(mi|mis) (pedido|orden|comida)\b/.test(c.t) || (sinObjeto && c.clienteId && (await this.saber.pedidosAbiertos(c.clienteId)).length)) return this.pedidoEstado(c);
    const ps = await this.productosObjetivo(c);
    const conTiempo = ps.filter((p: any) => p.tiempo_preparacion_min != null);
    if (!conTiempo.length) {
      if (ps.length) return { texto: `${ps[0].nombre} se entrega al momento en ${ps[0].local}; no necesita preparación.`, reescribir: false, entidades: { productoId: ps[0].id } };
      if (c.ent.ev.palabras.length) return this.buscarTema(c);
      return { texto: '¿De qué producto quieres saber el tiempo de preparación?', reescribir: false };
    }
    const p = conTiempo[0];
    const extra = conTiempo.length > 1 ? ` ${conTiempo[1].nombre} tarda unos ${conTiempo[1].tiempo_preparacion_min} minutos.` : '';
    return {
      texto: `${p.nombre} de ${p.local} tarda unos ${p.tiempo_preparacion_min} minutos en prepararse.${extra} Si lo pides por PaseoYa, te aviso cuando esté listo. ¿Te llevo al local?`,
      reescribir: false,
      entidades: { productoId: p.id, localId: p.local_id },
      propuesta: { intencion: 'donde', entidades: { localId: p.local_id } },
      productos: JarvisService.tarjetas(conTiempo),
    };
  }

  private async recomendacion(c: Ctx): Promise<Borrador> {
    const quiere = /(hambre|comer|comida|almorz|cenar|desayun|antojo|dulce|postre|sed|beber|tomar|donde como|como algo)/.test(c.t) ? 'Comida' : /(regalo|regalar|cumple)/.test(c.t) ? 'Regalos' : /(aburrid|que hago|diversion|divertir|jugar)/.test(c.t) ? 'Entretenimiento' : c.ent.categoria;
    // «comida vegana», «ropa de marca X»: una condición pegada a lo que busca que no está en los datos
    const condicion = JarvisService.condicionSinDatos(c);
    if (condicion) {
      return {
        texto: `No tengo opciones «${condicion}» registradas en el Paseo, así que no te puedo recomendar una con seguridad. Si quieres, te digo qué ${quiere === 'Comida' ? 'restaurantes' : 'locales'} hay o te recomiendo según lo que te gusta.`,
        reescribir: false,
        sinDatos: condicion,
        sugerencias: [quiere === 'Comida' ? '¿Qué restaurantes hay?' : '¿Qué tiendas hay?', '¿Qué me recomiendas?'],
      };
    }
    // «algo barato»: lo más económico del rubro, con datos
    if (/\b(barat[oa]s?|economic[oa]s?)\b/.test(c.t)) {
      const ps = await this.saber.masBaratos(c.recintoId, quiere ?? null, 3);
      if (ps.length) {
        return {
          texto: `Lo más económico ${quiere === 'Comida' ? 'para comer ' : ''}ahora: ${lista(ps.map((p: any) => `${p.nombre} en ${p.local} a ${dinero(p.precio_bs)}`))}. ¿Te llevo a ${ps[0].local}?`,
          reescribir: false,
          entidades: { localId: ps[0].local_id, productoId: ps[0].id },
          propuesta: { intencion: 'donde', entidades: { localId: ps[0].local_id } },
          productos: JarvisService.tarjetas(ps),
        };
      }
    }
    if (quiere === 'Entretenimiento' || (!quiere && /(que hago|aburrid)/.test(c.t))) {
      const ev = (await this.saber.eventos(c.recintoId, new Date(), finDelDia()))[0];
      if (ev) return { texto: `${ev.en_curso ? 'Ahora mismo hay' : `Hoy a ${horaVoz(hhmmBo(ev.inicio))} hay`} ${ev.titulo} en ${ev.lugar}${ev.puntos ? `, y ganas ${ev.puntos} puntos por ir` : ''}. También puedes visitar los locales de entretenimiento del Paseo.`, reescribir: false, entidades: { actividadId: ev.id }, eventos: [ev] };
    }
    const sub = /dulce|postre/.test(c.t) ? '(postre|torta|helado|cupcake|cheesecake|alfajor|brownie|dulce|chocolate|banana)' : /sed|beber|tomar/.test(c.t) ? '(jugo|batido|cafe|capuchino|limonada|te |smoothie|espresso|latte)' : null;
    // Recomendador equitativo: gusto del cliente + reparto justo del flujo entre competidores
    const recs = await this.recomendador.recomendar(c.recintoId, c.clienteId, { categoria: quiere ?? null, productoRegex: sub, limite: 2 });
    if (!recs.length) return this.promociones(c);
    const [r, otra] = recs;
    const l = r.local;
    const motivos = r.motivos.length ? `: ${lista(r.motivos.slice(0, 2))}` : '';
    const producto = r.producto ? ` ${r.producto.nombre} cuesta ${dinero(r.producto.precio_bs)}.` : '';
    const alternativa = otra ? ` Otra buena opción es ${otra.local.nombre}${otra.motivos[0] ? `, ${otra.motivos[0]}` : ''}.` : '';
    return {
      texto: `Te recomiendo ${l.nombre}, en ${JarvisService.ubicacion(l)}${motivos}.${producto}${alternativa} ¿Te llevo?`,
      claves: [l.nombre],
      reescribir: false,
      entidades: { localId: l.id },
      propuesta: { intencion: 'donde', entidades: { localId: l.id } },
      sugerencias: [`¿Cómo llego a ${l.nombre}?`, ...(otra ? [`¿Y ${otra.local.nombre}?`] : []), '¿Qué ofertas tengo hoy?'],
    };
  }

  private async ofertas(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const os = await this.saber.ofertasHoy(c.clienteId);
    if (!os.length) return { texto: 'Hoy no tienes ofertas personales. Cada mañana preparo nuevas según lo que te gusta; mientras tanto, te cuento las promociones del Paseo.', reescribir: false, propuesta: { intencion: 'promociones', entidades: {} } };
    const vigentes = os.filter((o) => o.estado === 'activa' && !o.paso);
    const usadas = os.filter((o) => o.estado === 'usada');
    const f = (o: any) => `puntos por ${Number(o.multiplicador)} en ${o.local} ${o.ahora ? `ahora mismo, hasta ${horaVoz(o.hora_fin)}` : `de ${horaVoz(o.hora_inicio)} a ${horaVoz(o.hora_fin)}`}`;
    const partes = [];
    if (vigentes.length) partes.push(`Hoy tienes ${vigentes.length === 1 ? 'una oferta' : `${vigentes.length} ofertas`} solo para ti: ${lista(vigentes.map(f))}.`);
    if (usadas.length) partes.push(`Ya aprovechaste ${usadas.length === 1 ? 'una' : usadas.length} y ganaste ${usadas.reduce((a, o) => a + o.puntos_bono, 0)} puntos extra.`);
    if (!vigentes.length && !usadas.length) partes.push('Tus ofertas de hoy ya terminaron; mañana tendrás nuevas.');
    if (vigentes[0]) partes.push(vigentes[0].motivo);
    return {
      texto: partes.join(' '),
      reescribir: false,
      entidades: { localId: vigentes[0]?.local_id },
      propuesta: vigentes[0] ? { intencion: 'donde', entidades: { localId: vigentes[0].local_id } } : undefined,
      sugerencias: vigentes[0] ? [`¿Cómo llego a ${vigentes[0].local}?`, '¿Qué más me recomiendas?'] : ['¿Qué promociones hay ahora?'],
    };
  }

  // ------------------------------------------------------------------ pedidos PaseoYa

  private async pedidoEstado(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const subs = await this.saber.pedidosAbiertos(c.clienteId);
    if (!subs.length) return { texto: 'No tienes pedidos de PaseoYa en curso. ¿Quieres que te recomiende algo para pedir?', reescribir: false, propuesta: { intencion: 'recomendacion', entidades: {} } };
    const frases = subs.slice(0, 2).map((s) => {
      const quien = `${s.items} de ${s.nombre}`;
      if (s.estado === 'listo') return `Tu pedido de ${quien} ya está listo: retíralo en ${JarvisService.ubicacion(s)} con el PIN ${s.pin.split('').join(' ')}`;
      if (s.estado === 'cliente_llego') return `${s.nombre} ya sabe que llegaste y te entrega en un momento`;
      if (s.estado === 'preparando') {
        const desde = s.preparando_en ? (Date.now() - new Date(s.preparando_en).getTime()) / 60_000 : 0;
        const faltan = Math.max(1, Math.round(Number(s.preparacion_min) - desde));
        return `${s.nombre} está preparando tu pedido; ${faltan === 1 ? 'falta un minuto' : `faltan unos ${faltan} minutos`}`;
      }
      if (s.estado === 'confirmado') return `${s.nombre} confirmó tu pedido y lo empieza a preparar para tu franja de ${horaVoz(hhmmBo(s.franja_inicio))}`;
      return `Tu pedido en ${s.nombre} fue recibido; falta que el local lo confirme`;
    });
    const listo = subs.find((s) => s.estado === 'listo');
    return {
      texto: `${frases.join('. ')}.${listo ? ' ¿Te llevo hasta allá?' : ''}`,
      reescribir: false,
      entidades: { pedidoLocalId: (listo ?? subs[0]).local_id, localId: (listo ?? subs[0]).local_id },
      propuesta: listo ? { intencion: 'pedido_donde', entidades: { pedidoLocalId: listo.local_id } } : { intencion: 'espera', entidades: {} },
      acciones: [{ etiqueta: 'Ver mis pedidos', ruta: '/pedidos' }],
    };
  }

  private async pedidoDonde(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const subs = await this.saber.pedidosAbiertos(c.clienteId);
    if (!subs.length) return { texto: 'No tienes pedidos pendientes de retiro en PaseoYa.', reescribir: false };
    const palabras = normalizar(c.t).split(' ').filter((w) => w.length > 3).map((w) => w.replace(/s$/, ''));
    const s =
      subs.find((x) => palabras.some((w) => normalizar(x.items).includes(w) || normalizar(x.nombre).includes(w))) ??
      subs.find((x) => x.local_id === c.mem.pedidoLocalId) ??
      subs.find((x) => x.estado === 'listo') ??
      subs[0];
    const { ruta } = await this.rutaHasta(c, `local:${s.local_id}`);
    const estado = s.estado === 'listo' || s.estado === 'cliente_llego' ? 'ya está listo' : 'todavía se está preparando';
    return {
      texto: `Tu pedido de ${s.nombre} ${estado}. Se retira en ${JarvisService.ubicacion(s)}${ruta ? (ruta.metros < 10 ? ', justo donde estás.' : `, a ${ruta.metros} metros: ${JarvisService.primerPaso(ruta)}`) : '.'}`,
      claves: [s.nombre],
      ruta,
      entidades: { pedidoLocalId: s.local_id, localId: s.local_id },
      acciones: [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }],
    };
  }

  private async espera(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const sub = await one<any>(
      this.db,
      `select s.local_id from subpedido s join pedido p on p.id = s.pedido_id where p.cliente_id = $1 and s.estado in ('recibido','confirmado','preparando') order by p.franja_inicio limit 1`,
      [c.clienteId],
    );
    const o = sub ? await this.orquestador.esperaComida(c.recintoId, c.clienteId, sub.local_id, 12, true) : null;
    if (o) return { texto: o.texto, reescribir: false, ruta: o.ruta, acciones: o.acciones };
    return this.cerca(c);
  }

  private async cerca(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const pos = await this.orientacion.posicion(c.clienteId);
    const o = await this.orquestador.ventaCruzada(c.recintoId, c.clienteId, pos.nodoId, true, 120, true);
    return o
      ? { texto: o.texto, reescribir: false, ruta: o.ruta, acciones: o.acciones }
      : { texto: 'Ahora no hay ofertas a pocos metros de ti. Escanea el QR de la puerta de un local para ubicarte mejor, o pregúntame por las promociones de todo el Paseo.', reescribir: false };
  }

  // ------------------------------------------------------------------ parqueo y preguntas libres

  private async parqueo(c: Ctx): Promise<Borrador> {
    const regla = await this.fidelizacion.reglaVigente(this.db, c.recintoId);
    const tarifa = Number(process.env.PARQUEO_TARIFA_HORA_BS ?? 6);
    const base = `El parqueo cuesta ${dinero(tarifa)} la hora, y puedes pagar cada hora con ${regla.puntos_hora_parqueo} puntos desde la app.`;
    // Motos o bicicletas: no hay datos de un parqueo especial; se dice tal cual
    const vehiculo = /\b(moto|motos|motocicleta|bici|bicis|bicicleta|bicicletas)\b/.exec(c.t)?.[0];
    if (vehiculo) {
      // Si la administración cargó información sobre esto, esa es la respuesta
      if (c.ent.ev.info.length) return this.info(c);
      return {
        texto: `No tengo información sobre parqueo para ${/bici/.test(vehiculo) ? 'bicicletas' : 'motos'}: no está registrado en los datos del Paseo. Te conviene consultar en el acceso del parqueo o en el módulo de información. ${base}`,
        reescribir: false,
        sinDatos: `parqueo de ${/bici/.test(vehiculo) ? 'bicicletas' : 'motos'}`,
      };
    }
    // El ticket del cliente solo si pregunta por su parqueo
    const propio = /\b(mi (auto|carro|vehiculo|ticket|parqueo)|cuanto (llevo|debo|pago|tengo que pagar)|pagar (el )?parqueo|cuanto me sale)\b/.test(c.t);
    const p = c.clienteId && propio ? await this.saber.parqueoAbierto(c.clienteId) : null;
    if (!p) return { texto: `${base} El acceso está en el Nivel 1, al este del Paseo.${propio && c.clienteId ? ' No tienes un ticket de parqueo abierto ahora.' : ''}`, reescribir: false, acciones: [{ etiqueta: 'Abrir parqueo', ruta: '/parqueo' }] };
    const min = Math.max(1, Math.round((Date.now() - new Date(p.entrada_en).getTime()) / 60_000));
    const horas = Math.ceil(min / 60);
    return {
      texto: `Llevas ${duracionVoz(min)} en el parqueo con el ticket ${p.ticket}; hasta ahora serían ${dinero(horas * tarifa)}, o ${horas * regla.puntos_hora_parqueo} puntos. ${base}`,
      reescribir: false,
      acciones: [{ etiqueta: 'Pagar parqueo', ruta: '/parqueo' }],
    };
  }

  // ------------------------------------------------------------------ buscar con evidencia y responder con honestidad

  /**
   * «¿Hay gimnasio?», «¿venden celulares?», «quiero un café», «tiendas de ropa»: responde con lo que
   * respalda la pregunta en los datos del Paseo. Si no hay nada, lo dice y avisa a la administración.
   */
  private async buscarTema(c: Ctx, para: 'precio' | 'buscar' = 'buscar'): Promise<Borrador> {
    const ev = c.ent.ev;
    if (c.ent.servicio && !c.ent.locales.length && !ev.productos.length) return this.servicio(c);
    if (ev.vertical) return this.zona(c);
    if (ev.infoFuerte || (ev.info.length && !ev.productos.length && !c.ent.locales.length)) return this.info(c);
    if ((c.ent.locales.length && !c.ent.localPorRubro) || ev.localesNombre.length) {
      const l = (c.ent.localPorRubro ? null : c.ent.locales[0]) ?? ev.localesNombre[0];
      return this.localInfo({ ...c, ent: { ...c.ent, locales: [l as any] } });
    }
    if (ev.zonas.length) return this.zona(c);
    if (ev.productos.length) return para === 'precio' ? this.precio(c) : this.producto(c);
    if (ev.localesRubro.length) return this.localesDeRubro(c);
    return this.sinDatos(c);
  }

  /** Locales por rubro o categoría: «¿hay tiendas de ropa?», «¿venden celulares?», «¿qué restaurantes hay?». */
  private async localesDeRubro(c: Ctx): Promise<Borrador> {
    const ev = c.ent.ev;
    const ids = ev.localesRubro.map((l) => l.id);
    const ls = ev.categoria && !ev.localesRubro.some((l) => l.categoria !== ev.categoria)
      ? await this.saber.localesDeCategoria(c.recintoId, ev.categoria)
      : (await this.saber.localesPorId(ids)).map((l: any) => ({ ...l, abierto: undefined }));
    if (!ls.length) return this.sinDatos(c);
    const raizRubro = ev.palabras.find((w) => !esDeCategoria(w) && ev.localesRubro.some((l) => l.raicesRubro.includes(w)));
    const rubro = raizRubro ? comoLaDijo(c.original, raizRubro) : undefined;
    const partes: string[] = [];
    const condicion = JarvisService.condicionSinDatos(c);
    if (condicion) partes.push(`No tengo opciones «${condicion}» registradas en el Paseo.`);
    if (!raizRubro) {
      const dicha = ev.palabras.find(esDeCategoria);
      const que = ev.categoria === 'Comida' ? 'comer' : dicha ? comoLaDijo(c.original, dicha).toLowerCase() : ev.categoria ? ev.categoria.toLowerCase() : objetoDe(c.original);
      const nombres = ls.slice(0, 5).map((l: any) => `${l.nombre} (${JarvisService.ubicacionCorta(l)})`);
      partes.push(`${ls.length === 1 ? `Para ${que} está` : `Para ${que} hay ${ls.length} locales:`} ${lista(nombres)}${ls.length > 5 ? `, y ${ls.length - 5} más` : ''}.`);
    } else {
      // El rubro está en el nombre o la descripción del local («farmacia») o solo es algo relacionado («gimnasio» → ropa deportiva)
      const directos = ls.filter((l: any) => raicesDe(`${l.nombre} ${l.descripcion ?? ''}`).includes(raizRubro));
      const describe = (l: any) => `${l.nombre} (${l.descripcion ? `${l.descripcion.charAt(0).toLowerCase()}${l.descripcion.slice(1)}, ` : ''}${JarvisService.ubicacionCorta(l)})`;
      if (directos.length) partes.push(`Para ${rubro} ${directos.length === 1 ? 'está' : 'tienes'} ${lista(directos.slice(0, 4).map(describe))}.`);
      else partes.push(`No tengo registrado un local de «${rubro}» como tal en el Paseo. Lo relacionado es ${lista(ls.slice(0, 3).map(describe))}.`);
      // «¿venden celulares?»: si en PaseoYa no hay un producto con ese nombre, se dice
      if (!ev.productos.length && /\b(venden|vende|vendan|comprar|compro|precio|cuesta|cuestan|cuanto)\b/.test(c.t)) {
        const rel = ev.productosRelacionados.filter((p) => ids.includes(p.local_id)).slice(0, 2);
        partes.push(`En PaseoYa no tienen publicado ningún producto llamado «${rubro}»${rel.length ? `; lo relacionado es ${lista(rel.map((p) => `${p.nombre} en ${p.local} a ${dinero(p.precio)}`))}` : ''}. Para modelos y precios, consulta en el local.`);
      }
    }
    return {
      texto: partes.join(' '),
      reescribir: false,
      entidades: { localId: ls[0].id, categoria: ev.categoria ?? undefined },
      propuesta: { intencion: 'donde', entidades: { localId: ls[0].id } },
      sugerencias: ls.slice(0, 2).map((l: any) => `¿Cómo llego a ${l.nombre}?`),
      sinDatos: condicion ?? undefined,
    };
  }

  /** No hay ningún dato que respalde la pregunta: decirlo claro, sin rellenar con otra cosa. */
  private sinDatos(c: Ctx): Borrador {
    const objeto = objetoDe(c.original);
    if (!objeto) return { texto: `No entendí qué buscas. ${NO_ENTIENDO}`, reescribir: false, sugerencias: SUGERENCIAS_BASE };
    return {
      texto: `No encontré «${objeto}» en el Paseo Aranjuez: no aparece como local, producto, servicio ni evento en los datos que tengo. Le avisé a la administración que lo buscaste. ¿Te ayudo con otra cosa?`,
      reescribir: false,
      sinDatos: objeto,
      sugerencias: SUGERENCIAS_BASE,
    };
  }

  /**
   * Una condición pegada a lo que busca y que ningún dato respalda: «comida vegana», «zapatillas nike»,
   * «descuentos para estudiantes». Solo cuenta si va justo después de algo que sí se reconoció.
   */
  private static condicionSinDatos(c: Ctx): string | null {
    const ev = c.ent.ev;
    if (!ev.faltantes.length) return null;
    const ws = norm(c.original).split(' ');
    const reconocidas = new Set(ev.palabras.filter((w) => !ev.faltantes.includes(w)));
    const pegadas = ev.faltantes.filter((f) => {
      const i = ws.findIndex((w) => raiz(w) === f);
      return i > 0 && [ws[i - 1], ws[i - 2]].some((w) => w && reconocidas.has(raiz(w)));
    });
    return pegadas.length ? pegadas.map((w) => comoLaDijo(c.original, w)).join(' ') : null;
  }

  /** Información general del Paseo cargada por la administración (medios de pago, devoluciones…). */
  private async info(c: Ctx): Promise<Borrador> {
    const i = c.ent.ev.info[0];
    if (!i) return this.libre(c);
    return { texto: i.respuesta, reescribir: false, sugerencias: SUGERENCIAS_BASE };
  }

  /** Zonas del Paseo («el patio de comidas») y conexiones verticales («¿hay ascensor?»). */
  private async zona(c: Ctx): Promise<Borrador> {
    const ev = c.ent.ev;
    const g = await this.orientacion.grafo(c.recintoId);
    if (ev.vertical) {
      const nodos = [...g.nodos.values()].filter((n) => n.tipo === ev.vertical);
      if (!nodos.length) return this.sinDatos(c);
      const pisos = [...new Set(nodos.map((n) => n.piso))];
      let mejor: { ruta?: Ruta } = {};
      for (const n of nodos) {
        const { ruta } = await this.rutaHasta(c, n.id);
        if (ruta && (!mejor.ruta || ruta.metros < mejor.ruta.metros)) mejor = { ruta };
      }
      const nombre = ev.vertical === 'ascensor' ? 'un ascensor' : 'una escalera central';
      const cerca = mejor.ruta ? (mejor.ruta.metros < 10 ? ' Estás justo al lado.' : ` El más cercano está a ${mejor.ruta.metros} metros: ${JarvisService.primerPaso(mejor.ruta)}`) : '';
      return {
        texto: `Sí, hay ${nombre} que conecta ${lista(pisos.map((p) => (p === 'T' ? 'la Planta baja' : `el ${NOMBRE_PISO[p]}`)))}.${cerca}`,
        reescribir: false,
        ruta: mejor.ruta,
        acciones: mejor.ruta ? [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }] : undefined,
      };
    }
    const z = ev.zonas[0];
    if (!z) return this.sinDatos(c);
    const nombreZona = `${conArticulo(z.nombre.charAt(0).toLowerCase() + z.nombre.slice(1))}`;
    const ls = await many<any>(this.db, 'select id, nombre from local where zona_id = $1 and activo order by nombre', [z.id]);
    const pasillo = [...g.nodos.values()].filter((n) => n.zonaId === z.id && n.tipo === 'pasillo');
    const destino = pasillo[Math.floor(pasillo.length / 2)];
    const { ruta } = destino ? await this.rutaHasta(c, destino.id) : { ruta: undefined };
    const donde = z.piso === 'T' ? 'en la Planta baja' : `en el ${NOMBRE_PISO[z.piso]}`;
    return {
      texto: `${nombreZona.charAt(0).toUpperCase() + nombreZona.slice(1)} está ${donde}${ruta && ruta.metros >= 10 ? `, a ${ruta.metros} metros de ti` : ''}.${ls.length ? ` Ahí están ${lista(ls.slice(0, 6).map((l) => l.nombre))}${ls.length > 6 ? `, y ${ls.length - 6} más` : ''}.` : ''}`,
      reescribir: false,
      ruta,
      acciones: ruta ? [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }] : undefined,
    };
  }

  /** «¿Cuántos locales hay?»: se cuenta en la base. */
  private async conteo(c: Ctx): Promise<Borrador> {
    if (/\b(pisos|niveles)\b/.test(c.t)) {
      const pisos = await many<{piso:string}>(this.db, 'select piso from local where recinto_id=$1 union select piso from zona where recinto_id=$1 union select piso from servicio_paseo where recinto_id=$1 and activo', [c.recintoId]);
      return {texto: pisos.length ? 'El sistema registra '+pisos.length+' niveles: '+lista(pisos.map(p=>NOMBRE_PISO[p.piso]??p.piso))+'.' : 'No hay niveles registrados en el sistema.',reescribir:false};
    }
    const cs = await this.saber.conteo(c.recintoId);
    const total = cs.reduce((a, x) => a + x.n, 0);
    const comida = cs.filter((x) => x.ambito === 'comida').reduce((a, x) => a + x.n, 0);
    if (/restaurante|comer|comida/.test(c.t)) return { texto: `Hay ${comida} locales de comida en el Paseo. Si quieres, te digo cuáles.`, reescribir: false, sugerencias: ['¿Qué restaurantes hay?'] };
    const detalle = cs.filter((x) => x.ambito !== 'comida').map((x) => `${x.n} de ${x.categoria.toLowerCase()}`);
    return {
      texto: `El Paseo Aranjuez tiene ${total} locales activos: ${comida} de comida y ${total - comida} tiendas y servicios (${lista(detalle)}).`,
      reescribir: false,
      sugerencias: ['¿Qué restaurantes hay?', '¿Hay tiendas de ropa?'],
    };
  }

  /** «¿Qué películas dan?»: la cartelera no está en los datos; se dice y se ofrece lo que sí hay. */
  private async cartelera(c: Ctx): Promise<Borrador> {
    const cine = (await this.saber.evidencia(c.recintoId, 'cine')).localesNombre[0] ?? (await this.saber.evidencia(c.recintoId, 'cine')).localesRubro[0];
    const l = cine ? await this.saber.local(cine.id) : null;
    const evs = (await this.saber.eventos(c.recintoId, new Date(), new Date(Date.now() + 7 * 86400_000))).filter((e) => e.tipo === 'cine').slice(0, 2);
    const partes = ['No tengo la cartelera de películas: los títulos y horarios de las funciones no están cargados en Paseo Points.'];
    if (l) partes.push(`${l.nombre} está en ${JarvisService.ubicacion(l)} y ${l.abierto ? `hoy atiende hasta ${horaVoz(l.cierre)}` : l.abiertoHoy ? `hoy abre a ${horaVoz(l.apertura)}` : 'hoy no atiende'}; ahí te dan la cartelera.`);
    if (evs.length) partes.push(`En eventos del Paseo sí tengo ${lista(evs.map((e) => `${e.titulo}, ${diaVoz(e.inicio)} a ${horaVoz(hhmmBo(e.inicio))}`))}.`);
    return {
      texto: partes.join(' '),
      reescribir: false,
      sinDatos: 'cartelera del cine',
      entidades: { localId: l?.id },
      propuesta: l ? { intencion: 'donde', entidades: { localId: l.id } } : undefined,
      eventos: evs,
      sugerencias: l ? [`¿Cómo llego a ${l.nombre}?`, '¿Qué eventos hay hoy?'] : ['¿Qué eventos hay hoy?'],
    };
  }

  /** Preguntas que no son del Paseo: Jarvis no contesta de memoria. */
  private fueraDeTema(c: Ctx): Borrador {
    const clima = /(clima|tiempo hace|llover|llovera|temperatura|pronostico)/.test(c.t);
    return {
      texto: clima
        ? 'No tengo datos del clima. Puedo ayudarte con lo que hay dentro del Paseo: promociones, eventos, tiendas, precios o cómo llegar a un lugar.'
        : 'Eso no lo sé: solo tengo información del Paseo Aranjuez, como tiendas, precios, promociones, eventos, servicios y tus puntos. ¿Te ayudo con algo de eso?',
      reescribir: false,
      sugerencias: SUGERENCIAS_BASE,
    };
  }

  /**
   * Lo que no encaja en nada: si la administración cargó información del tema, se usa; si no, se
   * dice con honestidad que no se tiene ese dato. Jarvis no genera respuestas de memoria.
   */
  private async libre(c: Ctx): Promise<Borrador> {
    if (c.ent.ev.info.length) return this.info(c);
    const objeto = objetoDe(c.original);
    return {
      texto: objeto
        ? `No tengo información registrada para responder «${c.original.trim()}». Puedes consultar ese dato directamente con el comercio.`
        : '¿Sobre qué negocio o dato del Paseo quieres preguntar? Necesito ese detalle para consultarlo.',
      reescribir: false,
      sinDatos: objeto || undefined,
      sugerencias: SUGERENCIAS_BASE,
    };
  }
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

/** «en el Nivel 1», «en la Planta baja». */
function enPiso(piso: string) {
  return piso === 'T' ? 'en la Planta baja' : `en el ${NOMBRE_PISO[piso]}`;
}

const GENERICO: Record<string, string> = {
  bano: 'el baño más cercano', cajero_automatico: 'el cajero automático más cercano', carga_celular: 'la estación de carga más cercana', informacion: 'el módulo de información más cercano',
};

function inicioDelDia() {
  const bo = new Date(Date.now() - 4 * 3600_000);
  return new Date(Date.UTC(bo.getUTCFullYear(), bo.getUTCMonth(), bo.getUTCDate()) + 4 * 3600_000);
}
function finDelDia() {
  return new Date(inicioDelDia().getTime() + 86400_000);
}
