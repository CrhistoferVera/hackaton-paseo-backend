import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { Sesion } from '../../common/auth/tokens.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { OrquestadorJarvis } from '../jarvis/orquestador.service.js';
import { JarvisService } from './jarvis.service.js';

const EventoSchema = z.discriminatedUnion('tipoEvento', [
  z.object({ tipoEvento: z.literal('escaneo_qr'), detalles: z.object({ codigo: z.string().min(4) }) }),
  z.object({ tipoEvento: z.literal('espera_comida'), detalles: z.object({ localId: z.string().uuid(), minutos: z.number().int().min(1).max(90).optional() }) }),
  z.object({ tipoEvento: z.literal('pregunta'), detalles: z.object({ texto: z.string().min(2).max(6000) }) }),
]);

/**
 * Canal de voz de Jarvis por WebSocket. El celular manda lo que pasa (escaneó un QR, está esperando
 * su comida, dijo una frase) y Jarvis responde con `orden_voz_jarvis` o `respuesta_jarvis`.
 * La identidad sale siempre de la sesión del socket, nunca del cuerpo del mensaje.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class JarvisGateway {
  private readonly log = new Logger('JarvisGateway');

  constructor(
    private readonly orientacion: OrientacionService,
    private readonly orquestador: OrquestadorJarvis,
    private readonly jarvis: JarvisService,
  ) {}

  @SubscribeMessage('evento_usuario')
  async evento(@MessageBody() cuerpo: unknown, @ConnectedSocket() socket: Socket) {
    const s = socket.data?.sesion as Sesion | undefined;
    if (!s || s.rol !== 'cliente') return { ok: false, error: 'Solo clientes con sesión' };
    const r = EventoSchema.safeParse(cuerpo);
    if (!r.success) return { ok: false, error: 'Evento inválido' };
    const e = r.data;
    try {
      if (e.tipoEvento === 'escaneo_qr') {
        const n = await this.orientacion.moverPorCodigo(s.recintoId, s.sub, e.detalles.codigo);
        const orden = await this.orquestador.ventaCruzada(s.recintoId, s.sub, n.id, true);
        return { ok: true, ubicacion: n.nombre, orden: orden?.id ?? null };
      }
      if (e.tipoEvento === 'espera_comida') {
        const orden = await this.orquestador.esperaComida(s.recintoId, s.sub, e.detalles.localId, e.detalles.minutos ?? 12);
        return { ok: true, orden: orden?.id ?? null };
      }
      const respuesta = await this.jarvis.consultar(s.recintoId, s.sub, e.detalles.texto);
      socket.emit('respuesta_jarvis', respuesta);
      return { ok: true };
    } catch (err: any) {
      this.log.warn(err.message);
      return { ok: false, error: err.message };
    }
  }
}
