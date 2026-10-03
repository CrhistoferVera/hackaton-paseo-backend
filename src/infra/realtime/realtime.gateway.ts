import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { verificarJwt } from '../../common/auth/tokens.js';

/**
 * Canal en tiempo real (Observer). Cada socket se une a salas según su sesión:
 *  usuario:{id} · local:{id} · sala:{recintoId} (administración)
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server: Server;

  handleConnection(socket: Socket) {
    const token = String(socket.handshake.auth?.token ?? socket.handshake.query?.token ?? '');
    const s = verificarJwt(token);
    if (!s) {
      socket.emit('error', 'sesion_invalida');
      socket.disconnect(true);
      return;
    }
    socket.data.sesion = s;
    void socket.join(`usuario:${s.sub}`);
    if (s.localId) void socket.join(`local:${s.localId}`);
    if (['admin', 'marketing', 'analista'].includes(s.rol)) void socket.join(`sala:${s.recintoId}`);
    this.log.debug(`conectado ${s.rol} ${s.sub}`);
  }

  emitir(sala: string, evento: string, datos: unknown) {
    this.server?.to(sala).emit(evento, datos);
  }
}
