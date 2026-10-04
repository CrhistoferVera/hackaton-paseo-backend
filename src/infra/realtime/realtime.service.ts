import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';

/** Fachada de publicación en tiempo real usada por los módulos de aplicación. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gw: RealtimeGateway) {}

  aUsuario(usuarioId: string, evento: string, datos: unknown = {}) {
    this.gw.emitir(`usuario:${usuarioId}`, evento, datos);
  }

  aLocal(localId: string, evento: string, datos: unknown = {}) {
    this.gw.emitir(`local:${localId}`, evento, datos);
  }

  catalogo(recintoId: string) {
    this.gw.emitir(`catalogo:${recintoId}`, 'catalogo', {});
  }

  aSala(recintoId: string, evento: string, datos: unknown = {}) {
    this.gw.emitir(`sala:${recintoId}`, evento, datos);
  }
}
