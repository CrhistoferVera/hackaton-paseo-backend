import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { EventBus } from '../nucleo/event-bus.js';
import { Arista, Nodo, Ruta, alcanzables, caminoMasCorto, construirGrafo } from './domain/grafo.js';

interface GrafoCargado {
  nodos: Map<string, Nodo>;
  ady: Map<string, Arista[]>;
}

const VIGENCIA_POSICION_MIN = 60;
export const NODO_ENTRADA = 'N1:entrada:norte';

/**
 * Orientación en interiores. La posición del cliente sale de la prueba de presencia que ya existe
 * (QR de puerta, cartel de hito, entrada, compra o retiro): el nodo del grafo donde ocurrió.
 */
@Injectable()
export class OrientacionService implements OnModuleInit {
  private readonly log = new Logger('Orientacion');
  private readonly cache = new Map<string, GrafoCargado>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.bus.on('recinto.cambiado', (e) => this.reconstruir(e.recintoId).then(() => undefined));
    this.bus.on('checkin.registrado', (e) => this.moverA(e.clienteId, `local:${e.localId}`, 'checkin'));
    this.bus.on('compra.registrada', (e) => this.moverA(e.clienteId, `local:${e.localId}`, e.origen === 'paseoya' ? 'retiro' : 'compra'));
    this.bus.on('hito.reclamado', (e) => this.moverA(e.clienteId, `hito:${e.hitoId}`, 'hito'));
    this.bus.on('visita.iniciada', async (e) => {
      const n = await one<{ id: string }>(this.db, `select id from nodo_ubicacion where tipo = 'entrada' and codigo_qr = $1`, [`PPE:${e.puerta ?? ''}`]);
      if (n) await this.moverA(e.clienteId, n.id, 'entrada');
    });
    setTimeout(() => void this.asegurarGrafos().catch((e) => this.log.warn(e.message)), 1500);
  }

  private async asegurarGrafos() {
    const recintos = await many<{ id: string; n: number }>(
      this.db,
      `select r.id, (select count(*)::int from nodo_ubicacion n where n.recinto_id = r.id) as n from recinto r`,
    );
    // Ids estables: reconstruir al arrancar es barato y mantiene el grafo al día con el plano y el código
    for (const r of recintos) await this.reconstruir(r.id);
  }

  /** Regenera el grafo desde el plano. Los ids son estables, así las posiciones guardadas siguen válidas. */
  async reconstruir(recintoId: string) {
    const zonas = await many(this.db, 'select * from zona where recinto_id = $1', [recintoId]);
    const locales = await many(this.db, 'select id, nombre, piso, numero_local, coord_x, coord_y, zona_id, codigo_puerta, activo from local where recinto_id = $1', [recintoId]);
    const hitos = await many(this.db, 'select id, nombre, zona_id, codigo from hito where recinto_id = $1 and activo', [recintoId]);
    const servicios = await many(this.db, 'select id, nombre, piso, x, y, zona_id from servicio_paseo where recinto_id = $1 and activo', [recintoId]);
    const { nodos, aristas } = construirGrafo({ zonas, locales, hitos, servicios } as any);
    await this.db.tx(async (q) => {
      const ids = nodos.map((n) => n.id);
      await q.query('delete from arista_ubicacion where desde in (select id from nodo_ubicacion where recinto_id = $1)', [recintoId]);
      await q.query('delete from nodo_ubicacion where recinto_id = $1 and not (id = any($2::text[]))', [recintoId, ids]);
      for (const n of nodos) {
        await q.query(
          `insert into nodo_ubicacion (id, recinto_id, piso, tipo, nombre, x, y, zona_id, local_id, hito_id, codigo_qr, servicio_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (id) do update set piso = excluded.piso, tipo = excluded.tipo, nombre = excluded.nombre, x = excluded.x, y = excluded.y,
             zona_id = excluded.zona_id, local_id = excluded.local_id, hito_id = excluded.hito_id, codigo_qr = excluded.codigo_qr, servicio_id = excluded.servicio_id`,
          [n.id, recintoId, n.piso, n.tipo, n.nombre, n.x, n.y, n.zonaId ?? null, n.localId ?? null, n.hitoId ?? null, n.codigoQr ?? null, n.servicioId ?? null],
        );
      }
      for (let i = 0; i < aristas.length; i += 400) {
        const lote = aristas.slice(i, i + 400);
        const p: unknown[] = [];
        const v = lote.map((a, k) => {
          p.push(a.desde, a.hasta, a.metros, a.tipo);
          return `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`;
        });
        await q.query(`insert into arista_ubicacion (desde, hasta, metros, tipo) values ${v.join(',')}`, p);
      }
    });
    this.cache.delete(recintoId);
    this.log.log(`grafo del recinto: ${nodos.length} nodos, ${aristas.length / 2} conexiones`);
    return { nodos: nodos.length, aristas: aristas.length / 2 };
  }

  async grafo(recintoId: string, q: Queryable = this.db): Promise<GrafoCargado> {
    const c = this.cache.get(recintoId);
    if (c) return c;
    const filas = await many<any>(q, 'select * from nodo_ubicacion where recinto_id = $1', [recintoId]);
    const aristas = await many<any>(q, 'select a.* from arista_ubicacion a join nodo_ubicacion n on n.id = a.desde where n.recinto_id = $1', [recintoId]);
    const nodos = new Map<string, Nodo>(
      filas.map((f) => [f.id, { id: f.id, piso: f.piso, tipo: f.tipo, nombre: f.nombre, x: Number(f.x), y: Number(f.y), zonaId: f.zona_id, localId: f.local_id, hitoId: f.hito_id, codigoQr: f.codigo_qr, servicioId: f.servicio_id }]),
    );
    const ady = new Map<string, Arista[]>();
    for (const a of aristas) {
      const l = ady.get(a.desde) ?? [];
      l.push({ desde: a.desde, hasta: a.hasta, metros: Number(a.metros), tipo: a.tipo });
      ady.set(a.desde, l);
    }
    const g = { nodos, ady };
    this.cache.set(recintoId, g);
    return g;
  }

  async moverA(clienteId: string, nodoId: string, fuente: string) {
    await this.db.query(
      `insert into posicion_cliente (cliente_id, nodo_id, fuente, en) select $1, $2, $3, now() where exists (select 1 from nodo_ubicacion where id = $2)
       on conflict (cliente_id) do update set nodo_id = excluded.nodo_id, fuente = excluded.fuente, en = now()`,
      [clienteId, nodoId, fuente],
    );
  }

  /** Posición por código QR escaneado (puerta, hito o entrada). */
  async moverPorCodigo(recintoId: string, clienteId: string, codigo: string) {
    const n = await one<{ id: string; nombre: string }>(this.db, 'select id, nombre from nodo_ubicacion where recinto_id = $1 and codigo_qr = $2', [recintoId, codigo.trim()]);
    if (!n) throw new NotFoundException('Ese código no corresponde a un punto del Paseo');
    await this.moverA(clienteId, n.id, 'qr');
    return n;
  }

  /** El cliente indica dónde está tocando el mapa (menos confiable que un QR, pero útil para rutas). */
  async moverManual(recintoId: string, clienteId: string, nodoId: string) {
    const n = await one<{ id: string; nombre: string; piso: string }>(this.db, 'select id, nombre, piso from nodo_ubicacion where recinto_id = $1 and id = $2', [recintoId, nodoId]);
    if (!n) throw new NotFoundException('Ese lugar no está en el mapa');
    await this.moverA(clienteId, n.id, 'manual');
    return n;
  }

  /** Última posición conocida y vigente; si no hay, se asume la entrada principal. */
  async posicion(clienteId: string): Promise<{ nodoId: string; fuente: string; en: Date | null; conocida: boolean }> {
    const p = await one<{ nodo_id: string; fuente: string; en: Date }>(
      this.db,
      `select nodo_id, fuente, en from posicion_cliente where cliente_id = $1 and en > now() - ($2 || ' minutes')::interval`,
      [clienteId, VIGENCIA_POSICION_MIN],
    );
    if (!p) return { nodoId: NODO_ENTRADA, fuente: 'supuesta', en: null, conocida: false };
    return { nodoId: p.nodo_id, fuente: p.fuente, en: p.en, conocida: true };
  }

  /** ¿El cliente está en el Paseo ahora? (visita abierta hoy o posición reciente) */
  async presente(clienteId: string) {
    const r = await one<{ si: boolean }>(
      this.db,
      `select exists (select 1 from visita where cliente_id = $1 and salida_en is null and entrada_en > now() - interval '6 hours')
           or exists (select 1 from posicion_cliente where cliente_id = $1 and en > now() - interval '45 minutes') as si`,
      [clienteId],
    );
    return !!r?.si;
  }

  async ruta(recintoId: string, origen: string, destino: string, via?: string | null): Promise<Ruta | null> {
    const g = await this.grafo(recintoId);
    if (!via) return caminoMasCorto(g.nodos, g.ady, origen, destino);
    const a = caminoMasCorto(g.nodos, g.ady, origen, via);
    const b = caminoMasCorto(g.nodos, g.ady, via, destino);
    if (!a || !b) return null;
    const metros = a.metros + b.metros;
    // La llegada al punto intermedio se vuelve «pasa por» y se omite la salida del segundo tramo
    const desplazar = a.nodos.length - 1;
    const tramos = [
      ...a.tramos.map((t) => ({ ...t, texto: t.texto.replace(/^Llegas al /, 'Pasa por el ').replace(/^Llegas a /, 'Pasa por ') })),
      ...b.tramos.filter((t) => !t.texto.startsWith('Sal de')).map((t) => ({ ...t, desde: t.desde + desplazar, hasta: t.hasta + desplazar })),
    ];
    return { nodos: [...a.nodos, ...b.nodos.slice(1)], metros, minutos: Math.max(1, Math.round(metros / 1.2 / 60)), pasos: tramos.map((t) => t.texto), tramos };
  }

  async distancias(recintoId: string, origen: string, radioM: number) {
    const g = await this.grafo(recintoId);
    return { g, dist: alcanzables(g.ady, origen, radioM) };
  }

  /** Datos de la ruta para la app: solo lo necesario para dibujarla y leerla. */
  static paraApp(r: Ruta) {
    return {
      metros: r.metros,
      minutos: r.minutos,
      pasos: r.pasos,
      tramos: r.tramos,
      nodos: r.nodos.map((n) => ({ id: n.id, piso: n.piso, x: n.x, y: n.y, tipo: n.tipo, nombre: n.nombre })),
      destino: r.nodos[r.nodos.length - 1]?.nombre,
    };
  }

  async grafoParaDibujo(recintoId: string) {
    const g = await this.grafo(recintoId);
    const aristas: [string, string, number, string][] = [];
    for (const [desde, l] of g.ady) for (const a of l) if (desde < a.hasta) aristas.push([desde, a.hasta, a.metros, a.tipo]);
    return { nodos: [...g.nodos.values()], aristas };
  }
}
