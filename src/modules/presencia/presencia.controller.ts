import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { PresenciaService } from './presencia.service.js';

const LlegueSchema = z.object({
  fuente: z.enum(['qr_entrada', 'geocerca']),
  codigo: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
const UbicacionSchema = z.object({ lat: z.number(), lng: z.number() });

@Roles('cliente')
@Controller('cliente')
export class PresenciaController {
  constructor(private readonly svc: PresenciaService) {}

  /** HU-X01 */
  @Post('llegue')
  llegue(@SesionActual() s: Sesion, @Body(new ZodPipe(LlegueSchema)) d: z.infer<typeof LlegueSchema>) {
    return this.svc.llegue(s.recintoId, s.sub, d);
  }

  @Post('salida')
  salida(@SesionActual() s: Sesion) {
    return this.svc.salida(s.recintoId, s.sub);
  }

  /** HU-C12 */
  @Post('checkin')
  checkin(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ codigo: z.string() }))) d: { codigo: string }) {
    return this.svc.checkin(s.recintoId, s.sub, d.codigo);
  }

  /** HU-C20 */
  @Post('ubicacion')
  ubicacion(@SesionActual() s: Sesion, @Body(new ZodPipe(UbicacionSchema)) d: z.infer<typeof UbicacionSchema>) {
    return this.svc.ubicacion(s.recintoId, s.sub, d.lat, d.lng);
  }

  @Get('visitas')
  visitas(@SesionActual() s: Sesion) {
    return this.svc.historialVisitas(s.sub);
  }

  /** HU-X02 */
  @Get('parqueo')
  parqueo(@SesionActual() s: Sesion) {
    return this.svc.parqueoActual(s.sub, s.recintoId);
  }

  @Post('parqueo/entrada')
  entrada(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ ticket: z.string().min(3) }))) d: { ticket: string }) {
    return this.svc.parqueoEntrada(s.recintoId, s.sub, d.ticket.replace(/^PPK:/, ''));
  }

  @Post('parqueo/salida')
  salidaParqueo(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ horasConPuntos: z.number().int().min(0).max(24) }))) d: { horasConPuntos: number }) {
    return this.svc.parqueoSalida(s.recintoId, s.sub, d.horasConPuntos);
  }
}
