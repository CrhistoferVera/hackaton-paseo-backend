import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { ahoraBolivia } from '../../common/util.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { RecompensasService } from '../recompensas/recompensas.service.js';
import { PaseoYaService } from '../paseoya/paseoya.service.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { NOMBRE_PISO } from '../orientacion/domain/grafo.js';
import { CerebroJarvis } from '../jarvis/cerebro.js';
import { OrquestadorJarvis } from '../jarvis/orquestador.service.js';
import { ConocimientoPaseo, type Encontrado, normalizar } from '../jarvis/conocimiento.service.js';
import { type Entidades, MemoriaJarvis, type Turno } from '../jarvis/memoria.service.js';
import { de, diaVoz, dinero, duracionVoz, fechaVoz, hhmmBo, horaVoz, lista, lugar } from '../jarvis/voz.js';

export type Intencion =
  | 'saludo' | 'gracias' | 'ayuda' | 'reinicio' | 'afirmacion'
  | 'saldo' | 'nivel' | 'canjes' | 'vencimiento' | 'movimientos' | 'puntos_ganar' | 'oportunidades'
  | 'promociones' | 'eventos' | 'misiones' | 'drops' | 'parqueo'
  | 'horario' | 'local_info' | 'donde' | 'servicio' | 'precio' | 'producto' | 'tiempo' | 'recomendacion'
  | 'pedido_estado' | 'pedido_donde' | 'espera' | 'cerca' | 'libre' | 'desconocida';

const CLASIFICABLES: Intencion[] = [
  'saldo', 'nivel', 'canjes', 'puntos_ganar', 'oportunidades', 'promociones', 'eventos', 'misiones', 'drops', 'parqueo', 'horario', 'local_info',
  'donde', 'servicio', 'precio', 'producto', 'tiempo', 'recomendacion', 'pedido_estado', 'pedido_donde', 'espera', 'cerca', 'libre',
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
  ar?: { tipo: 'drop' | 'moneda'; codigo: string; lugar: string };
  productos?: { id: string; nombre: string; precioBs: number; local: string; enlace: string }[];
  recompensas?: unknown[];
  promociones?: unknown[];
  eventos?: unknown[];
  acciones?: { etiqueta: string; ruta: string }[];
  sugerencias?: string[];
}

export interface RespuestaJarvis extends Omit<Borrador, 'claves' | 'reescribir' | 'entidades' | 'propuesta'> {
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

    let intencion = this.detectar(ctx);
    let entidadesPedidas: Entidades = {};
    if (intencion === 'afirmacion') {
      const ultima = [...hilo].reverse().find((x) => x.rol === 'jarvis');
      const p = ultima?.datos?.propuesta as Borrador['propuesta'] | undefined;
      if (p) {
        intencion = p.intencion;
        entidadesPedidas = p.entidades;
        ctx.mem = { ...ctx.mem, ...p.entidades };
      } else intencion = 'gracias';
    }
    if (intencion === 'desconocida') intencion = await this.clasificarConModelo(ctx);

    let b: Borrador;
    try {
      b = await this.manejar(intencion, ctx);
    } catch (e: any) {
      b = { texto: `Tuve un problema para consultar eso. ${NO_ENTIENDO}`, reescribir: false };
    }

    // El modelo local vuelve natural el borrador, con el hilo de la conversación
    let texto = b.texto;
    let motor = 'plantilla';
    if (b.reescribir !== false && intencion !== 'libre') {
      const r = await this.cerebro.redactar(b.texto, [], b.claves ?? [], { historial: MemoriaJarvis.paraPrompt(hilo), pregunta: original });
      texto = r.texto;
      motor = r.motor;
    } else if (intencion === 'libre') motor = (b as any).motor ?? 'plantilla';

    if (clienteId) {
      const delCliente: Entidades = {
        localId: ent.locales[0]?.id, productoId: ent.productos.length === 1 ? ent.productos[0].id : undefined, actividadId: ent.actividad?.id,
        servicioTipo: ent.servicio?.tipo, categoria: ent.categoria ?? undefined, ...entidadesPedidas,
      };
      await this.memoria.guardar(clienteId, 'cliente', original, intencion, delCliente);
      await this.memoria.guardar(clienteId, 'jarvis', texto, intencion, b.entidades ?? {}, {
        propuesta: b.propuesta ?? null, ruta: b.ruta ? { metros: b.ruta.metros, destino: b.ruta.destino } : null, motor,
      });
    }
    const { claves: _c, reescribir: _r, entidades: _e, propuesta: _p, ...resto } = b;
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

    if (habla(/(promo|oferta|descuento|2x1|dos por uno|rebaja|liquidacion)/) && !habla(/(cerca de mi|por aqui|aqui cerca)/)) return 'promociones';
    if (ent.actividad || habla(/\b(evento|eventos|concierto|conciertos|feria|ferias|taller|talleres|show|shows|espectaculo|actividad|actividades|que hacer|presentacion)\b/) || habla(/que (hay|hacer|planes)( para)? (hoy|manana|esta noche|esta tarde|(este |el )?fin de semana|el sabado|el domingo)/)) return 'eventos';
    if (habla(/(parqueo|estacionamiento|parking|estacionar|mi auto|mi carro|mi vehiculo)/)) return 'parqueo';
    if (habla(/(cuanto (tarda|demora|se tarda|se demora)|tiempo de preparacion|en cuanto tiempo|cuanto tiempo)/)) return 'tiempo';
    if (habla(/(a que hora (abre|abren|cierra|cierran)|horario|esta abiert|estan abiert|sigue abiert|atiende|atienden|hasta que hora|cierra |cierran )/)) return 'horario';
    if (habla(/(cuanto (cuesta|cuestan|vale|valen|sale|salen|esta|estan)|precio|a cuanto|mas barat|mas economic)/)) return 'precio';
    if (ent.servicio && !ent.locales.length) return 'servicio';
    if (habla(/((que hay|algo|ofertas?).*(cerca|por aqui|aqui)|cerca de mi|por aqui cerca)/)) return 'cerca';
    if (habla(/(donde (esta|estan|queda|quedan|encuentro|hay|puedo|venden)|como llego|como voy|llevame|quiero ir|ir a\b|ruta|camino (a|al|hacia))/)) return 'donde';
    if (habla(/(tengo hambre|que (me )?recomiendas|que como|que puedo comer|algo (dulce|rico|para comer|de comer)|recomienda|sugerencia|antojo|regalo para|que le regalo|aburrido|que hago|que me sugieres|tengo sed)/)) return 'recomendacion';
    if (habla(/(que venden|que tiene|que hay en|informacion de|telefono|numero de|de que es|que es)/) && ent.locales.length) return 'local_info';
    if (habla(/\b(busca|buscame|encuentra|quiero comprar|necesito|venden|tienen|vende)\b/)) return 'producto';

    // «¿Y la óptica?», «¿y en Napoli?»: misma pregunta que la anterior, sobre otra cosa
    const anterior = [...c.hilo].reverse().find((x) => x.rol === 'cliente')?.intencion as Intencion | undefined;
    if (palabras <= 5 && /^(y|e|y en|y el|y la|y los|y las|y para)\b/.test(t) && anterior && ['horario', 'precio', 'tiempo', 'donde', 'local_info', 'promociones', 'servicio'].includes(anterior)) {
      if (ent.locales.length || ent.productos.length || ent.servicio) return ent.servicio && !ent.locales.length ? 'servicio' : anterior === 'servicio' ? 'donde' : anterior;
    }

    // Solo entidades: «Napoli», «salteñas», «el baño»
    if (ent.productos.length) return 'producto';
    if (ent.locales.length) return 'local_info';
    if (ent.servicio) return 'servicio';
    if (ent.categoria) return 'recomendacion';

    // Seguimiento corto: «¿y ahí?», «¿y cómo llego?», «¿y el otro?»
    if (palabras <= 6 && (mem.localId || mem.productoId || mem.servicioTipo || mem.actividadId)) {
      if (r(/(llego|voy|ir|ruta|camino|lejos|donde)/)) return 'donde';
      if (r(/(hora|abre|cierra|abierto)/)) return 'horario';
      if (r(/(cuesta|precio|vale|cuanto)/)) return 'precio';
      if (r(/(tarda|demora|tiempo)/)) return 'tiempo';
    }
    return 'desconocida';
  }

  private async clasificarConModelo(c: Ctx): Promise<Intencion> {
    const j = await this.cerebro.json<{ intencion: Intencion }>(
      `Clasifica lo que dice un cliente de un centro comercial. Responde solo JSON {"intencion":"..."} con una de: ${CLASIFICABLES.join(', ')}.
promociones = ofertas o descuentos; eventos = actividades o shows; precio = cuánto cuesta algo; producto = buscar algo para comprar; donde = cómo llegar a un lugar;
servicio = baños, cajeros automáticos, wifi, lactancia, enfermería, objetos perdidos; horario = a qué hora abre o cierra; tiempo = cuánto tarda la comida;
recomendacion = qué le recomiendas; libre = cualquier otra pregunta sobre el Paseo.`,
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
            texto: `Paseo Points es el programa de puntos del Paseo Aranjuez: ganas 1 punto por cada ${Number(r.bs_por_punto) === 1 ? 'boliviano' : dinero(r.bs_por_punto)} que gastas, ${r.puntos_visita_diaria} puntos por tu primera visita del día y ${r.puntos_descubrimiento} por cada local nuevo que descubres. Los canjeas por comida, entradas, descuentos o parqueo, y duran 12 meses.`,
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

  // ------------------------------------------------------------------ saludo

  private async saludo(c: Ctx): Promise<Borrador> {
    const ya = c.hilo.some((x) => x.rol === 'cliente');
    const partes = [ya ? `¡Aquí sigo${c.nombre ? `, ${c.nombre}` : ''}!` : `¡Hola${c.nombre ? `, ${c.nombre}` : ''}! Soy Jarvis.`];
    if (c.clienteId) {
      const pedidos = await this.saber.pedidosAbiertos(c.clienteId);
      const listo = pedidos.find((p) => p.estado === 'listo');
      if (listo) partes.push(`Tu pedido de ${listo.nombre} ya está listo para retirar.`);
    }
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId)).filter((p) => p.ahora);
    const eventos = (await this.saber.eventos(c.recintoId, new Date(), finDelDia())).filter((e) => e.en_curso || new Date(e.inicio) > new Date());
    if (eventos[0]) partes.push(`Hoy hay ${eventos.length === 1 ? 'un evento' : `${eventos.length} eventos`}, como ${eventos[0].titulo} ${eventos[0].en_curso ? 'ahora mismo' : `a ${horaVoz(hhmmBo(eventos[0].inicio))}`}.`);
    else if (promos[0]) partes.push(`Ahora mismo hay ${promos.length === 1 ? 'una promoción activa' : `${promos.length} promociones activas`}, como ${promos[0].titulo}${promos[0].local ? ` en ${promos[0].local}` : ''}.`);
    partes.push('¿En qué te ayudo?');
    return {
      texto: partes.join(' '),
      reescribir: false,
      sugerencias: ['¿Qué promociones hay ahora?', '¿Qué eventos hay hoy?', '¿Dónde gano más puntos?', '¿Cómo va mi pedido?'],
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
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId)).filter((p) => p.ahora && p.tipo === 'puntos_dobles');
    if (promos.length) partes.push(`Ahora hay puntos multiplicados en ${lista(promos.slice(0, 3).map((p) => `${p.local ?? 'todo el Paseo'} (por ${Number(p.multiplicador)})`))}.`);
    let ar: Borrador['ar'];
    let ruta: Ruta | undefined;
    if (c.clienteId) {
      const monedas = await this.saber.monedasPendientes(c.recintoId, c.clienteId);
      if (monedas.length) {
        partes.push(`Te quedan ${monedas.length} monedas de hoy en los carteles del Paseo, de ${monedas[0].puntos} puntos cada una.`);
        ar = { tipo: 'moneda', codigo: `PPH:${monedas[0].codigo}`, lugar: monedas[0].zona };
        ruta = (await this.rutaHasta(c, `hito:${monedas[0].id}`)).ruta;
      }
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
    return { texto: partes.join(' '), reescribir: false, ar, ruta, acciones: [{ etiqueta: 'Ver misiones', ruta: '/misiones' }] };
  }

  // ------------------------------------------------------------------ promociones, eventos, drops, misiones

  private async promociones(c: Ctx): Promise<Borrador> {
    const local = c.ent.locales[0] ?? (/\b(ahi|ese|esa|alli)\b/.test(c.t) && c.mem.localId ? { id: c.mem.localId, nombre: '' } : null);
    const categoria = !local ? c.ent.categoria : null;
    const todas = await this.saber.promociones(c.recintoId, c.clienteId, { localId: local?.id, categoria: categoria ?? undefined });
    const ahora = todas.filter((p) => p.ahora);
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
    const ds = await this.saber.dropsActivos(c.recintoId);
    if (!ds.length) return { texto: 'Ahora no hay Drops activos. Cuando se abra uno cerca de ti, te aviso al instante.', reescribir: false };
    const d = ds[0];
    const { ruta } = d.hito_id ? await this.rutaHasta(c, `hito:${d.hito_id}`) : { ruta: undefined };
    return {
      texto: `Hay ${ds.length === 1 ? 'un Drop activo' : `${ds.length} Drops activos`}. ${d.producto} de ${d.local} a ${dinero(d.precio_especial)} en vez de ${dinero(d.precio_bs)}, en el cartel ${de(lugar(d.zona))} (${NOMBRE_PISO[d.piso]}); quedan ${d.quedan} y termina a ${horaVoz(hhmmBo(d.fin))}.${ruta ? ` Estás a ${ruta.metros} metros.` : ''}`,
      reescribir: false,
      ruta,
      ar: d.codigo ? { tipo: 'drop', codigo: `PPH:${d.codigo}`, lugar: d.zona } : undefined,
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
    if (id && !/\b(paseo|centro comercial|mall)\b/.test(c.t)) {
      const l = await this.saber.local(id);
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
      else if (termino && termino.length > 2 && !c.mem.localId) return this.producto({ ...c, t: termino });
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
    const lista_ = await this.saber.servicios(c.recintoId, tipo);
    if (!lista_.length) return this.libre(c);
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
        : `${etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1)} está ${donde}${/[.!?]$/.test(donde) ? '' : '.'} ${s.descripcion}`;
    return {
      texto: `${frase.trim()}${horario}`.replace(/\.\./g, '.').replace(/([^.!?])$/, '$1.'),
      reescribir: false,
      ruta: mejor.ruta,
      entidades: { servicioTipo: tipo },
      acciones: mejor.ruta ? [{ etiqueta: 'Ver ruta en el mapa', ruta: '/ruta' }] : undefined,
    };
  }

  // ------------------------------------------------------------------ productos, precios, tiempos

  /** Productos de lo que nombró; si no nombró nada, del local o producto del que se venía hablando. */
  private async productosObjetivo(c: Ctx) {
    if (c.ent.productos.length) {
      const deLocal = c.ent.locales[0] ? c.ent.productos.filter((p) => p.local_id === c.ent.locales[0].id) : [];
      return this.saber.productos((deLocal.length ? deLocal : c.ent.productos).map((p) => p.id));
    }
    if (c.mem.productoId && !c.ent.locales.length) return this.saber.productos([c.mem.productoId]);
    const termino = c.t
      .replace(/.*(cuanto (cuesta|cuestan|vale|valen|sale|salen|esta|estan)|precio de|a cuanto|cuanto (tarda|demora|se tarda)|busca(me)?|encuentra|quiero comprar|necesito|venden|tienen|vende)\s*/, '')
      .replace(/^(el|la|los|las|un|una|unos|unas)\s+/, '')
      .replace(/\b(mas barat[oa]s?|mas economic[oa]s?|aqui|en el paseo)\b/g, '')
      .trim();
    if (termino.length >= 3 && !c.ent.locales.length) {
      const encontrados = await this.paseoya.buscarDesdeJarvis(c.recintoId, termino, c.clienteId);
      if (encontrados.length) return this.saber.productos(encontrados.slice(0, 8).map((p: any) => p.id));
    }
    const localId = c.ent.locales[0]?.id ?? c.mem.localId;
    if (localId) return (await this.saber.local(localId))?.productos.map((p: any) => ({ ...p, local: c.ent.locales[0]?.nombre ?? '' })) ?? [];
    return [];
  }

  private static tarjetas(ps: any[]) {
    return ps.slice(0, 4).map((p) => ({ id: p.id, nombre: p.nombre, precioBs: Number(p.precio_bs), local: p.local, enlace: `paseopoints://paseoya/producto/${p.id}` }));
  }

  private async precio(c: Ctx): Promise<Borrador> {
    const ps = await this.productosObjetivo(c);
    if (!ps.length) return { texto: '¿De qué producto quieres saber el precio? Por ejemplo, «¿cuánto cuesta la pizza familiar?».', reescribir: false };
    if (ps.length === 1) {
      const p = ps[0];
      const stock = p.stock === 0 ? ' Ahora está agotado.' : p.stock <= 5 ? ` Quedan solo ${p.stock}.` : '';
      const drop = (await this.saber.dropsActivos(c.recintoId)).find((d) => d.producto_id === p.id && d.quedan > 0);
      const oferta = drop ? ` Pero ahora hay un Drop: lo consigues a ${dinero(drop.precio_especial)} en el cartel ${de(lugar(drop.zona))} hasta ${horaVoz(hhmmBo(drop.fin))}.` : '';
      return {
        texto: `${p.nombre} cuesta ${dinero(p.precio_bs)}${p.local ? ` en ${p.local}` : ''}.${stock}${oferta} ¿Quieres pedirlo por PaseoYa o que te lleve al local?`,
        ar: drop?.codigo ? { tipo: 'drop', codigo: `PPH:${drop.codigo}`, lugar: drop.zona } : undefined,
        claves: p.local ? [p.local] : [],
        reescribir: false,
        entidades: { productoId: p.id, localId: p.local_id },
        propuesta: { intencion: 'donde', entidades: { localId: p.local_id } },
        productos: JarvisService.tarjetas(ps),
      };
    }
    const orden = [...ps].sort((a, b) => Number(a.precio_bs) - Number(b.precio_bs));
    const top = orden.slice(0, 3).map((p) => `${p.nombre} a ${dinero(p.precio_bs)}${p.local ? ` en ${p.local}` : ''}`);
    return {
      texto: `Encontré ${ps.length} opciones. ${/barat|economic/.test(c.t) ? 'La más barata es' : 'Van desde'} ${top[0]}${top.length > 1 ? `; también ${lista(top.slice(1))}` : ''}.`,
      reescribir: false,
      entidades: { productoId: orden[0].id, localId: orden[0].local_id },
      propuesta: { intencion: 'donde', entidades: { localId: orden[0].local_id } },
      productos: JarvisService.tarjetas(orden),
    };
  }

  private async producto(c: Ctx): Promise<Borrador> {
    const ps = await this.productosObjetivo(c);
    if (!ps.length) {
      const termino = c.t.replace(/^(busca(me)?|encuentra|quiero comprar|necesito|venden|tienen|vende|donde (hay|venden|compro))\s+/, '').trim();
      const locs = termino ? await this.saber.localesPorTermino(c.recintoId, termino) : [];
      if (locs.length) return this.localInfo({ ...c, ent: { ...c.ent, locales: locs } });
      return {
        texto: `No encontré «${termino || c.original}» en el Paseo. Lo anoté para que la administración sepa que hace falta. ¿Te ayudo a buscar algo parecido?`,
        reescribir: false,
      };
    }
    const orden = [...ps].sort((a, b) => Number(a.precio_bs) - Number(b.precio_bs));
    const p = orden[0];
    const locales = [...new Set(orden.map((x) => x.local))];
    return {
      texto: `${ps.length === 1 ? `Sí, ${p.local} tiene ${p.nombre}` : `Hay ${ps.length} opciones en ${locales.length === 1 ? locales[0] : `${locales.length} locales`}; la más barata es ${p.nombre} en ${p.local}`} a ${dinero(p.precio_bs)}, en ${JarvisService.ubicacion(p)}. ¿Te llevo o prefieres pedirlo por PaseoYa?`,
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
      return ps.length
        ? { texto: `${ps[0].nombre} se entrega al momento en ${ps[0].local}; no necesita preparación.`, reescribir: false, entidades: { productoId: ps[0].id } }
        : { texto: '¿De qué producto quieres saber el tiempo de preparación?', reescribir: false };
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
    const { hhmm } = ahoraBolivia();
    const hora = Number(hhmm.slice(0, 2));
    const quiere = /(hambre|comer|comida|almorz|cenar|desayun|antojo|dulce|postre|sed|beber|tomar)/.test(c.t) ? 'Comida' : /(regalo|regalar|cumple)/.test(c.t) ? 'Regalos' : /(aburrid|que hago|diversion|divertir|jugar)/.test(c.t) ? 'Entretenimiento' : c.ent.categoria;
    if (quiere === 'Entretenimiento' || (!quiere && /(que hago|aburrid)/.test(c.t))) {
      const ev = (await this.saber.eventos(c.recintoId, new Date(), finDelDia()))[0];
      if (ev) return { texto: `${ev.en_curso ? 'Ahora mismo hay' : `Hoy a ${horaVoz(hhmmBo(ev.inicio))} hay`} ${ev.titulo} en ${ev.lugar}${ev.puntos ? `, y ganas ${ev.puntos} puntos por ir` : ''}. También están el cine y el boliche en las Terrazas.`, reescribir: false, entidades: { actividadId: ev.id }, eventos: [ev] };
    }
    const favoritos = c.clienteId ? await this.saber.favoritos(c.clienteId) : [];
    const sub = /dulce|postre/.test(c.t) ? '(postre|torta|helado|cupcake|cheesecake|alfajor|dulce|chocolate)' : /sed|beber|tomar/.test(c.t) ? '(jugo|batido|cafe|capuchino|limonada|te |smoothie)' : null;
    const candidatos = await many<any>(
      this.db,
      `select l.id, l.nombre, l.piso, l.numero_local, l.horario_apertura, l.horario_cierre, c.nombre as categoria,
              (select p.nombre from producto p where p.local_id = l.id and p.activo and p.stock > 0 and ($3::text is null or lower(p.nombre) ~ $3) order by p.precio_bs limit 1) as producto,
              (select p.precio_bs from producto p where p.local_id = l.id and p.activo and p.stock > 0 and ($3::text is null or lower(p.nombre) ~ $3) order by p.precio_bs limit 1) as precio
       from local l join categoria c on c.id = l.categoria_id
       where l.recinto_id = $1 and l.activo and ($2::text is null or c.nombre = $2) and $4::time between l.horario_apertura and l.horario_cierre`,
      [c.recintoId, quiere ?? null, sub, hhmm],
    );
    const conProducto = candidatos.filter((x) => x.producto);
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId, { categoria: quiere ?? undefined })).filter((p) => p.ahora && p.local_id);
    const fav = new Set(favoritos.map((f) => f.id));
    const elegido =
      conProducto.find((x) => promos.some((p) => p.local_id === x.id)) ?? conProducto.find((x) => fav.has(x.id)) ?? conProducto[Math.floor((hora * 7) % Math.max(1, conProducto.length))];
    if (!elegido) return this.promociones(c);
    const promo = promos.find((p) => p.local_id === elegido.id);
    const otro = conProducto.find((x) => x.id !== elegido.id && fav.has(x.id));
    return {
      texto: `Te recomiendo ${elegido.nombre}, en ${JarvisService.ubicacion(elegido)}${promo ? `, que ahora tiene ${promo.titulo}` : fav.has(elegido.id) ? ', uno de tus favoritos' : ''}: ${elegido.producto} cuesta ${dinero(elegido.precio)}.${otro ? ` Si prefieres, ${otro.nombre} también está abierto.` : ''} ¿Te llevo?`,
      claves: [elegido.nombre],
      entidades: { localId: elegido.id },
      propuesta: { intencion: 'donde', entidades: { localId: elegido.id } },
      sugerencias: [`¿Cómo llego a ${elegido.nombre}?`, '¿Qué otras promociones hay?'],
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
        return `${s.nombre} está preparando tu pedido; faltan unos ${faltan} minutos`;
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
    if (o) return { texto: o.texto, reescribir: false, ruta: o.ruta, ar: o.ar };
    return this.cerca(c);
  }

  private async cerca(c: Ctx): Promise<Borrador> {
    if (!c.clienteId) return this.sinSesion();
    const pos = await this.orientacion.posicion(c.clienteId);
    const o = await this.orquestador.ventaCruzada(c.recintoId, c.clienteId, pos.nodoId, true, 120, true);
    return o
      ? { texto: o.texto, reescribir: false, ruta: o.ruta, ar: o.ar }
      : { texto: 'Ahora no hay ofertas a pocos metros de ti. Escanea el QR de un local o un cartel para ubicarte mejor, o pregúntame por las promociones de todo el Paseo.', reescribir: false };
  }

  // ------------------------------------------------------------------ parqueo y preguntas libres

  private async parqueo(c: Ctx): Promise<Borrador> {
    const regla = await this.fidelizacion.reglaVigente(this.db, c.recintoId);
    const tarifa = Number(process.env.PARQUEO_TARIFA_HORA_BS ?? 6);
    const p = c.clienteId ? await this.saber.parqueoAbierto(c.clienteId) : null;
    const base = `El parqueo cuesta ${dinero(tarifa)} la hora, y puedes pagar cada hora con ${regla.puntos_hora_parqueo} puntos desde la app.`;
    if (!p) return { texto: `${base} El acceso está en el Nivel 1, al este del Paseo.`, reescribir: false, acciones: [{ etiqueta: 'Abrir parqueo', ruta: '/parqueo' }] };
    const min = Math.max(1, Math.round((Date.now() - new Date(p.entrada_en).getTime()) / 60_000));
    const horas = Math.ceil(min / 60);
    return {
      texto: `Llevas ${duracionVoz(min)} en el parqueo con el ticket ${p.ticket}; hasta ahora serían ${dinero(horas * tarifa)}, o ${horas * regla.puntos_hora_parqueo} puntos. ${base}`,
      reescribir: false,
      acciones: [{ etiqueta: 'Pagar parqueo', ruta: '/parqueo' }],
    };
  }

  /** Preguntas poco comunes: el modelo local responde solo con los datos del Paseo. */
  private async libre(c: Ctx): Promise<Borrador> {
    const { hhmm } = ahoraBolivia();
    const servicios = await many<any>(this.db, 'select nombre, descripcion, piso, horario from servicio_paseo where recinto_id = $1 and activo', [c.recintoId]);
    const vistos = new Set<string>();
    const datos = [
      `Hora actual: ${hhmm}. El Paseo Aranjuez tiene Nivel 1, Nivel 2 y las Terrazas (patio de comidas, cines, boliche y terraza).`,
      ...servicios.filter((s) => (vistos.has(s.nombre) ? false : vistos.add(s.nombre))).map((s) => `${s.nombre} (${NOMBRE_PISO[s.piso]}): ${s.descripcion}${s.horario ? ` Horario: ${s.horario}.` : ''}`),
    ];
    const promos = (await this.saber.promociones(c.recintoId, c.clienteId)).filter((p) => p.ahora).slice(0, 3);
    if (promos.length) datos.push(`Promociones activas ahora: ${promos.map((p) => `${p.titulo}${p.local ? ` en ${p.local}` : ''}`).join('; ')}.`);
    const evs = (await this.saber.eventos(c.recintoId, new Date(), finDelDia())).slice(0, 3);
    if (evs.length) datos.push(`Eventos de hoy: ${evs.map((e) => `${e.titulo} a las ${hhmmBo(e.inicio)} en ${e.lugar}`).join('; ')}.`);
    const r = await this.cerebro.responderLibre(c.original, datos, MemoriaJarvis.paraPrompt(c.hilo, 4));
    if (r) return { texto: r.texto, reescribir: false, motor: r.motor } as Borrador;
    return { texto: `No tengo ese dato, pero sí puedo ayudarte con otras cosas. ${NO_ENTIENDO}`, reescribir: false, sugerencias: ['¿Qué promociones hay ahora?', '¿Qué eventos hay hoy?', '¿Dónde hay un baño?'] };
  }
}

/** «en el Nivel 1», «en las Terrazas». */
function enPiso(piso: string) {
  return piso === 'T' ? 'en las Terrazas' : `en el ${NOMBRE_PISO[piso]}`;
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
