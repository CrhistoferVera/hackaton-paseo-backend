import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { verificarJwt } from '../../common/auth/tokens.js';

/**
 * Canal en tiempo real (Observer). Cada socket se une a salas según su sesión:
 *  usuario:{id} · local:{id} · sala:{recintoId} (administración)
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server: Server;

  handleConnection(socket: Socket) {
    const authHeader = socket.handshake.headers?.authorization;
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const token = String(socket.handshake.auth?.token ?? socket.handshake.query?.token ?? bearer ?? '');
    const s = verificarJwt(token);
    if (!s) {
      socket.emit('error', 'sesion_invalida');
      socket.disconnect(true);
      return;
    }
    socket.data.sesion = s;
    void socket.join(`usuario:${s.sub}`);
    void socket.join(`catalogo:${s.recintoId}`);
    if (s.localId) void socket.join(`local:${s.localId}`);
    if (['admin', 'marketing', 'analista'].includes(s.rol)) void socket.join(`sala:${s.recintoId}`);
    this.log.log(`Socket conectado: ${s.rol} (${s.sub})${s.localId ? ` en local:${s.localId}` : ''}`);
  }

  private avisadoSinServidor = false;

  emitir(sala: string, evento: string, datos: unknown) {
    if (this.server) {
      this.server.to(sala).emit(evento, datos);
    } else if (!this.avisadoSinServidor) {
      // Sin servidor HTTP (seed, scripts) no hay a quién emitir: se avisa una sola vez
      this.avisadoSinServidor = true;
      this.log.warn(`Server Socket.IO no disponible: no se emiten eventos en tiempo real (primero: ${evento} a ${sala})`);
    }
  }
}

