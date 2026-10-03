import { Injectable, Logger } from '@nestjs/common';
import { fueraDeTransaccion } from '../../infra/db/db.js';

/** Catálogo de eventos de dominio que cruzan módulos. */
export interface EventosDominio {
  'compra.registrada': { recintoId: string; transaccionId: string; clienteId: string; localId: string; montoBs: number; categoria: string | null; puntos: number; origen: string };
  'checkin.registrado': { recintoId: string; clienteId: string; localId: string; primeraVez: boolean };
  'subpedido.entregado': { recintoId: string; clienteId: string; localId: string; subpedidoId: string; totalBs: number };
  'alerta.confirmada': { recintoId: string; transaccionId: string; adminId: string };
  'visita.iniciada': { recintoId: string; clienteId: string; visitaId: string; fuente: string; puerta?: string | null };
  'pedido.creado': { recintoId: string; clienteId: string; pedidoId: string };
  'subpedido.estado': { recintoId: string; clienteId: string; subpedidoId: string; localId: string; estado: string };
  'hito.reclamado': { recintoId: string; clienteId: string; hitoId: string };
  'drop.lanzado': { recintoId: string; dropId: string; zonaId: string; hitoCodigo: string };
  'recinto.cambiado': { recintoId: string };
}

type Manejador<K extends keyof EventosDominio> = (e: EventosDominio[K]) => Promise<void> | void;

/**
 * Bus de eventos en proceso. Los manejadores corren después de que la transacción
 * que publicó el evento terminó, así un fallo en un consumidor no revierte la operación.
 */
@Injectable()
export class EventBus {
  private readonly log = new Logger('EventBus');
  private readonly manejadores = new Map<string, Manejador<any>[]>();

  on<K extends keyof EventosDominio>(evento: K, fn: Manejador<K>) {
    const lista = this.manejadores.get(evento) ?? [];
    lista.push(fn);
    this.manejadores.set(evento, lista);
  }

  publicar<K extends keyof EventosDominio>(evento: K, datos: EventosDominio[K]) {
    fueraDeTransaccion(() => setImmediate(() => {
      for (const fn of this.manejadores.get(evento) ?? []) {
        Promise.resolve().then(() => fn(datos)).catch((e) => this.log.error(`${evento}: ${e?.message ?? e}`));
      }
    }));
  }
}
