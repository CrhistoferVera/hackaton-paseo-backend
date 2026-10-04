import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import { EventBus } from '../nucleo/event-bus.js';
import { NODO_ENTRADA, OrientacionService } from '../orientacion/orientacion.service.js';
import { NOMBRE_PISO, alcanzables } from '../orientacion/domain/grafo.js';
import type { Ruta } from '../orientacion/domain/grafo.js';
import { CerebroJarvis } from './cerebro.js';
import { ContextoService, type Oferta } from './contexto.service.js';
import { MemoriaJarvis } from './memoria.service.js';
import { dinero } from './voz.js';

const INTERVALO_PROACTIVO_MS = Number(process.env.JARVIS_INTERVALO_S ?? 45) * 1000;
// Radio caminando por el grafo: cada puerta queda a ~21 m del pasillo central, así que 60 m alcanza los locales vecinos
const RADIO_CONTEXTO_M = Number(process.env.JARVIS_RADIO_M ?? 60);
const DESVIO_MAXIMO_M = 50;
const PRIORIDAD: Record<Oferta['tipo'], number> = { pedido_listo: 0, drop: 1, promocion: 2, mision: 3 };
const VER_DROPS = { etiqueta: 'Ver Drop', ruta: '/drops' };

export type Disparador = 'ruta_recojo' | 'espera_comida' | 'pedido_listo' | 'venta_cruzada' | 'bienvenida' | 'drop_cercano';

export interface OrdenVoz {
  id: string;
  disparador: Disparador;
  texto: string;
  motor: string;
  latenciaMs: number;
  ruta?: ReturnType<typeof OrientacionService.paraApp>;
  acciones?: { etiqueta: string; ruta: string }[];
}

/**
 * Jarvis no espera a que le pregunten: reacciona a lo que hace el cliente (compra en PaseoYa,
 * espera de comida, pedido listo, escaneo de QR, llegada, Drop lanzado) y decide qué decirle.
 * El texto sale de datos reales (borrador) y el modelo local solo lo vuelve natural.
 */
@Injectable()
export class OrquestadorJarvis implements OnModuleInit {
  private readonly log = new Logger('Jarvis');
  private readonly ultimoProactivo = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly rt: RealtimeService,
    private readonly orientacion: OrientacionService,
    private readonly contexto: ContextoService,
    private readonly cerebro: CerebroJarvis,
    private readonly memoria: MemoriaJarvis,
  ) {}

  onModuleInit() {
    const seguro = (fn: () => Promise<unknown>) => async (): Promise<void> => {
      try {
        await fn();
      } catch (e: any) {
        this.log.warn(e.message);
      }
    };
    this.bus.on('pedido.creado', (e) => seguro(() => this.rutaDeRecojo(e.recintoId, e.clienteId, e.pedidoId))());
    this.bus.on('subpedido.estado', (e) =>
      seguro(async () => {
        if (e.estado === 'preparando') await this.esperaComida(e.recintoId, e.clienteId, e.localId, null);
        if (e.estado === 'listo' || e.estado === 'cliente_llego') await this.pedidoListo(e.recintoId, e.clienteId, e.localId);
      })(),
    );
    this.bus.on('checkin.registrado', (e) => seguro(() => this.ventaCruzada(e.recintoId, e.clienteId, `local:${e.localId}`, false))());
    this.bus.on('visita.iniciada', (e) => seguro(() => this.bienvenida(e.recintoId, e.clienteId, e.puerta ?? null))());
    this.bus.on('drop.lanzado', (e) => seguro(() => this.avisarDrop(e.recintoId, e.dropId, e.localId))());
  }

  private perfil(clienteId: string) {
    return one<{ nombre: string; consent_ubicacion: boolean; consent_personalizacion: boolean }>(
      this.db,
      `select u.nombre, p.consent_ubicacion, p.consent_personalizacion from usuario u join cliente_perfil p on p.usuario_id = u.id where u.id = $1 and u.estado = 'activo'`,
      [clienteId],
    );
  }

  private async emitir(
    recintoId: string,
    clienteId: string,
    disparador: Disparador,
    borrador: string,
    contexto: string[],
    claves: string[],
    extras: Partial<Pick<OrdenVoz, 'acciones'>> & { ruta?: Ruta | null } = {},
    proactivo = false,
    silencioso = false,
  ): Promise<OrdenVoz | null> {
    if (proactivo) {
      const ultimo = this.ultimoProactivo.get(clienteId) ?? 0;
      if (Date.now() - ultimo < INTERVALO_PROACTIVO_MS) return null;
      this.ultimoProactivo.set(clienteId, Date.now());
    }
    const r = await this.cerebro.redactar(borrador, contexto, claves);
    const fila = await one<{ id: string }>(
      this.db,
      `insert into orden_jarvis (recinto_id, cliente_id, disparador, texto, contexto, motor, latencia_ms, datos) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [recintoId, clienteId, disparador, r.texto, [borrador, ...contexto].join(' | '), r.motor, r.latenciaMs, JSON.stringify({ metros: extras.ruta?.metros ?? null })],
    );
    const orden: OrdenVoz = {
      id: fila!.id,
      disparador,
      texto: r.texto,
      motor: r.motor,
      latenciaMs: r.latenciaMs,
      ruta: extras.ruta ? OrientacionService.paraApp(extras.ruta) : undefined,
      acciones: extras.acciones,
    };
    if (!silencioso) {
      this.rt.aUsuario(clienteId, 'orden_voz_jarvis', orden);
      // Lo que Jarvis dijo por iniciativa propia entra al hilo: «¿y cómo llego?» se entiende después
      const destino = extras.ruta?.nodos[extras.ruta.nodos.length - 1];
      await this.memoria
        .guardar(clienteId, 'jarvis', r.texto, disparador, { localId: destino?.localId ?? undefined, pedidoLocalId: ['ruta_recojo', 'pedido_listo'].includes(disparador) ? (destino?.localId ?? undefined) : undefined })
        .catch(() => undefined);
    }
    this.rt.aSala(recintoId, 'jarvis', { disparador, motor: r.motor, latenciaMs: r.latenciaMs });
    return orden;
  }

  private local(localId: string) {
    return one<{ id: string; nombre: string; piso: string; numero_local: string; categoria: string }>(
      this.db,
      `select l.id, l.nombre, l.piso, l.numero_local, c.nombre as categoria from local l join categoria c on c.id = l.categoria_id where l.id = $1`,
      [localId],
    );
  }

  /** Busca un desvío corto (máximo 50 m extra) por un local con Drop, priorizando pasillos con poco tráfico. */
  private async desvio(recintoId: string, clienteId: string, origen: string, destino: string) {
    const candidatos = (await this.contexto.cercanos(recintoId, clienteId, origen, 400)).filter((o) => o.tipo === 'drop' && o.nodoId !== destino);
    if (!candidatos.length) return null;
    const { g } = await this.orientacion.distancias(recintoId, origen, 0);
    const desdeDestino = alcanzables(g.ady, destino, 400);
    const directo = desdeDestino.get(origen);
    if (directo === undefined) return null;
    const viables = candidatos
      .map((c) => ({ ...c, extra: c.metros + (desdeDestino.get(c.nodoId) ?? Infinity) - directo }))
      .filter((c) => c.extra <= DESVIO_MAXIMO_M)
      .sort((a, b) => (a.trafico ?? 0) - (b.trafico ?? 0) || a.extra - b.extra);
    return viables[0] ?? null;
  }

  // ------------------------------------------------------------------ compra en PaseoYa → ruta de recojo
  async rutaDeRecojo(recintoId: string, clienteId: string, pedidoId: string) {
    const subs = await many<{ local_id: string; franja_inicio: Date }>(
      this.db,
      `select s.local_id, p.franja_inicio from subpedido s join pedido p on p.id = s.pedido_id where p.id = $1 and p.cliente_id = $2`,
      [pedidoId, clienteId],
    );
    if (!subs.length) return null;
    const pos = await this.orientacion.posicion(clienteId);
    const presente = await this.orientacion.presente(clienteId);
    const origen = presente ? pos.nodoId : NODO_ENTRADA;
    const l = (await this.local(subs[0].local_id))!;
    const destino = `local:${l.id}`;
    const perfil = await this.perfil(clienteId);
    const via = perfil?.consent_ubicacion ? await this.desvio(recintoId, clienteId, origen, destino) : null;
    const ruta = await this.orientacion.ruta(recintoId, origen, destino, via?.nodoId);
    const hora = new Date(subs[0].franja_inicio).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/La_Paz' });
    const otros = subs.length > 1 ? ` y ${subs.length - 1} local${subs.length > 2 ? 'es' : ''} más` : '';
    const distancia = ruta && ruta.metros >= 10 ? `, a ${ruta.metros} metros de ti` : ', justo donde estás';
    let borrador = presente
      ? `Tu pedido de ${l.nombre}${otros} se retira en ${NOMBRE_PISO[l.piso]}, local ${l.numero_local}${distancia}.`
      : `Cuando llegues al Paseo, tu pedido de ${l.nombre}${otros} se retira en ${NOMBRE_PISO[l.piso]}, local ${l.numero_local}, desde las ${hora}.`;
    if (via) borrador += ` De paso, ${via.texto}.`;
    return this.emitir(recintoId, clienteId, 'ruta_recojo', borrador, via ? [via.texto] : [], [l.nombre, l.numero_local], {
      ruta,
      acciones: [{ etiqueta: 'Ver pedido', ruta: `/pedido/${pedidoId}` }, ...(via ? [VER_DROPS] : [])],
    });
  }

  // ------------------------------------------------------------------ espera de comida → itinerario flash
  async esperaComida(recintoId: string, clienteId: string, localId: string, minutosPedidos: number | null, silencioso = false) {
    const l = await this.local(localId);
    if (!l || (l.categoria !== 'Comida' && minutosPedidos === null)) return null;
    if (!(await this.orientacion.presente(clienteId)) && minutosPedidos === null) return null;
    const est = await one<{ m: number | null }>(
      this.db,
      `select round(avg(extract(epoch from (listo_en - preparando_en)) / 60))::int as m from subpedido where local_id = $1 and listo_en is not null and preparando_en is not null`,
      [localId],
    );
    const minutos = minutosPedidos ?? Math.max(5, Math.min(30, est?.m ?? 12));
    const perfil = await this.perfil(clienteId);
    const pos = await this.orientacion.posicion(clienteId);
    const origen = pos.conocida ? pos.nodoId : `local:${localId}`;
    let borrador = `Tu pedido en ${l.nombre} estará listo en unos ${minutos} minutos.`;
    let ruta: Ruta | null = null;
    let destino: Oferta | undefined;
    if (perfil?.consent_ubicacion) {
      const presupuestoIda = Math.min(150, ((minutos - 3) * 60 * 1.2) / 2);
      const ofertas = await this.contexto.cercanos(recintoId, clienteId, origen, presupuestoIda);
      destino = ofertas
        .filter((o) => o.tipo === 'drop' && o.localId !== localId)
        .sort((a, b) => (a.trafico ?? 0) - (b.trafico ?? 0) || a.metros - b.metros)[0] ?? ofertas.find((o) => o.tipo === 'promocion' && o.localId !== localId);
      if (destino) {
        ruta = await this.orientacion.ruta(recintoId, origen, destino.nodoId);
        borrador += ` Mientras esperas, a ${ruta?.metros ?? Math.round(destino.metros)} metros ${destino.texto}; te aviso cuando esté listo.`;
      } else borrador += ' Te aviso cuando esté listo.';
    } else borrador += ' Te aviso cuando esté listo.';
    return this.emitir(recintoId, clienteId, 'espera_comida', borrador, destino ? [destino.texto] : [], [l.nombre, String(minutos)], {
      ruta,
      acciones: destino?.tipo === 'drop' ? [VER_DROPS] : undefined,
    }, false, silencioso);
  }

  // ------------------------------------------------------------------ pedido listo → cómo llegar
  async pedidoListo(recintoId: string, clienteId: string, localId: string) {
    if (!(await this.orientacion.presente(clienteId))) return null;
    const l = (await this.local(localId))!;
    const pos = await this.orientacion.posicion(clienteId);
    const ruta = await this.orientacion.ruta(recintoId, pos.nodoId, `local:${localId}`);
    const borrador = ruta && ruta.metros > 5
      ? `Tu pedido de ${l.nombre} está listo, a ${ruta.metros} metros de ti. ${ruta.pasos[0]}`
      : `Tu pedido de ${l.nombre} está listo para retirar.`;
    return this.emitir(recintoId, clienteId, 'pedido_listo', borrador, [], [l.nombre], { ruta });
  }

  // ------------------------------------------------------------------ escaneo de QR → venta cruzada
  async ventaCruzada(recintoId: string, clienteId: string, nodoId: string, forzar: boolean, radioM = RADIO_CONTEXTO_M, silencioso = false) {
    const perfil = await this.perfil(clienteId);
    if (!perfil?.consent_personalizacion || !perfil.consent_ubicacion) return null;
    const { g } = await this.orientacion.distancias(recintoId, nodoId, 0);
    const aqui = g.nodos.get(nodoId);
    const ofertas = (await this.contexto.cercanos(recintoId, clienteId, nodoId, radioM)).filter(
      (o) => o.nodoId !== nodoId && (!aqui?.localId || o.localId !== aqui.localId),
    );
    if (!ofertas.length) return null;
    const mejor = ofertas.sort((a, b) => PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo] || a.metros - b.metros)[0];
    const ruta = await this.orientacion.ruta(recintoId, nodoId, mejor.nodoId);
    const metros = ruta?.metros ?? Math.round(mejor.metros);
    const borrador = `A ${metros} metros, ${mejor.texto}.`;
    return this.emitir(
      recintoId, clienteId, 'venta_cruzada', borrador, ofertas.slice(0, 3).map((o) => o.texto), [mejor.lugar.split(' (')[0]],
      { ruta, acciones: mejor.tipo === 'drop' ? [VER_DROPS] : undefined },
      !forzar,
      silencioso,
    );
  }

  // ------------------------------------------------------------------ llegada al Paseo
  async bienvenida(recintoId: string, clienteId: string, puerta: string | null) {
    const perfil = await this.perfil(clienteId);
    if (!perfil?.consent_personalizacion) return null;
    const nodo = puerta ? (await one<{ id: string }>(this.db, `select id from nodo_ubicacion where codigo_qr = $1`, [`PPE:${puerta}`]))?.id ?? NODO_ENTRADA : NODO_ENTRADA;
    const listo = await one<{ local_id: string; nombre: string }>(
      this.db,
      `select s.local_id, l.nombre from subpedido s join pedido p on p.id = s.pedido_id join local l on l.id = s.local_id
       where p.cliente_id = $1 and s.estado in ('listo','cliente_llego') limit 1`,
      [clienteId],
    );
    const nombre = perfil.nombre.split(' ')[0];
    if (listo) {
      const ruta = await this.orientacion.ruta(recintoId, nodo, `local:${listo.local_id}`);
      return this.emitir(recintoId, clienteId, 'bienvenida', `Hola, ${nombre}. Tu pedido de ${listo.nombre} ya está listo, a ${ruta?.metros ?? 0} metros.`, [], [listo.nombre], { ruta }, true);
    }
    const ofertas = await this.contexto.cercanos(recintoId, clienteId, nodo, 60);
    const mejor = ofertas.sort((a, b) => PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo] || a.metros - b.metros)[0];
    if (!mejor) return null;
    const ruta = await this.orientacion.ruta(recintoId, nodo, mejor.nodoId);
    return this.emitir(recintoId, clienteId, 'bienvenida', `Hola, ${nombre}, te damos la bienvenida al Paseo. A ${ruta?.metros ?? Math.round(mejor.metros)} metros, ${mejor.texto}.`, [], [mejor.lugar.split(' (')[0]], { ruta }, true);
  }

  // ------------------------------------------------------------------ Drop lanzado → avisar a quienes están cerca
  async avisarDrop(recintoId: string, dropId: string, localId: string) {
    const nodoId = `local:${localId}`;
    const drop = await one<{ mensaje: string; producto: string; precio_especial: number; local: string }>(
      this.db,
      `select d.mensaje, p.nombre as producto, d.precio_especial, l.nombre as local from drop_espacial d join producto p on p.id = d.producto_id join local l on l.id = $2 where d.id = $1`,
      [dropId, localId],
    );
    const { g } = await this.orientacion.distancias(recintoId, nodoId, 0);
    if (!drop || !g.nodos.has(nodoId)) return 0;
    const cerca = alcanzables(g.ady, nodoId, 120);
    const clientes = await many<{ cliente_id: string; nodo_id: string }>(
      this.db,
      `select pc.cliente_id, pc.nodo_id from posicion_cliente pc join cliente_perfil p on p.usuario_id = pc.cliente_id
       where pc.en > now() - interval '45 minutes' and p.consent_ubicacion and pc.nodo_id = any($1::text[])`,
      [[...cerca.keys()]],
    );
    for (const c of clientes) {
      const ruta = await this.orientacion.ruta(recintoId, c.nodo_id, nodoId);
      await this.emitir(
        recintoId, c.cliente_id, 'drop_cercano',
        `Hay un Drop en ${drop.local}, a ${ruta?.metros ?? Math.round(cerca.get(c.nodo_id) ?? 0)} metros de ti: ${drop.producto} a ${dinero(drop.precio_especial)}.`,
        [drop.mensaje], [drop.producto, drop.local], { ruta, acciones: [VER_DROPS] }, false,
      );
    }
    return clientes.length;
  }

  ultimas(recintoId: string) {
    return Promise.all([
      many(
        this.db,
        `select o.id, o.disparador, o.texto, o.motor, o.latencia_ms, o.creado_en, p.alias as cliente from orden_jarvis o join cliente_perfil p on p.usuario_id = o.cliente_id
         where o.recinto_id = $1 order by o.creado_en desc limit 50`,
        [recintoId],
      ),
      many(
        this.db,
        `select motor, count(*)::int as ordenes, round(avg(latencia_ms))::int as latencia_promedio,
                percentile_cont(0.5) within group (order by latencia_ms)::int as latencia_mediana
         from orden_jarvis where recinto_id = $1 and creado_en > now() - interval '7 days' group by motor order by ordenes desc`,
        [recintoId],
      ),
      many(
        this.db,
        `select disparador, count(*)::int as ordenes from orden_jarvis where recinto_id = $1 and creado_en > now() - interval '7 days' group by 1 order by 2 desc`,
        [recintoId],
      ),
    ]).then(([ordenes, motores, disparadores]) => ({ ordenes, motores, disparadores }));
  }
}
