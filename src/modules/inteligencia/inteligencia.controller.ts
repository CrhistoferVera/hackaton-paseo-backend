import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ArchivoSubido } from '../../common/archivos.js';
import { OidoJarvis } from '../jarvis/oido.service.js';
import { VozNeuralService } from '../jarvis/voz-neural.service.js';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { InteligenciaService } from './inteligencia.service.js';
import { AsistenteAdmin } from './asistente.service.js';

const num = (v: string | undefined, def: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : def);

@Roles('admin', 'marketing', 'analista')
@Controller('admin/inteligencia')
export class InteligenciaController {
  constructor(private readonly svc: InteligenciaService) {}

  @Get('tablero')
  tablero(@SesionActual() s: Sesion) {
    return this.svc.tablero(s.recintoId);
  }

  @Get('calor')
  calor(
    @SesionActual() s: Sesion,
    @Query('metrica') metrica: 'ventas' | 'visitas' | 'checkins' | 'permanencia' = 'visitas',
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('horaDesde') horaDesde?: string,
    @Query('horaHasta') horaHasta?: string,
  ) {
    return this.svc.calor(s.recintoId, { metrica, desde: desde || undefined, hasta: hasta || undefined, horaDesde: num(horaDesde, 0), horaHasta: num(horaHasta, 23) });
  }

  @Get('zonas/:id/serie')
  serie(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.serieZona(s.recintoId, id);
  }

  @Get('horarios')
  horarios(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.horarios(s.recintoId, num(dias, 90));
  }

  @Get('rfm')
  rfm(@SesionActual() s: Sesion) {
    return this.svc.rfm(s.recintoId);
  }

  @Get('segmentos')
  segmentos(@SesionActual() s: Sesion) {
    return this.svc.segmentos(s.recintoId);
  }

  @Roles('admin', 'analista')
  @Post('segmentos/recalcular')
  recalcular(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ k: z.number().int().min(3).max(8).default(5) }))) d: { k: number }) {
    return this.svc.recalcularSegmentos(s.recintoId, d.k);
  }

  @Get('afinidad')
  afinidad(@SesionActual() s: Sesion, @Query('modo') modo: 'mes' | 'visita' = 'mes', @Query('top') top?: string) {
    return this.svc.afinidad(s.recintoId, modo, num(top, 12));
  }

  @Get('embudo')
  embudo(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.embudo(s.recintoId, num(dias, 30));
  }

  @Get('demanda')
  demanda(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.demanda(s.recintoId, num(dias, 90));
  }

  @Get('roi')
  roi(@SesionActual() s: Sesion) {
    return this.svc.roi(s.recintoId);
  }

  @Get('cohortes')
  cohortes(@SesionActual() s: Sesion, @Query('meses') meses?: string) {
    return this.svc.cohortes(s.recintoId, num(meses, 6));
  }

  @Get('paseoya')
  paseoya(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.pedidosAdmin(s.recintoId, num(dias, 30));
  }

  @Get('eventos-hoy')
  eventos(@SesionActual() s: Sesion) {
    return this.svc.eventosHoy(s.recintoId);
  }

  @Get('resumen')
  resumen(@SesionActual() s: Sesion) {
    return this.svc.resumenDelDia(s.recintoId);
  }

  @Post('preguntar')
  preguntar(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ pregunta: z.string().min(4).max(300) }))) d: { pregunta: string }) {
    return this.svc.preguntar(s.recintoId, s.sub, d.pregunta);
  }
}

@Roles('comercio')
@Controller('local/panel')
export class PanelLocalController {
  constructor(private readonly svc: InteligenciaService) {}

  /** HU-L08 */
  @Get()
  panel(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.panelLocal(s.localId!, num(dias, 30));
  }

  /** HU-L09 */
  @Roles('comercio')
  @Get('ranking')
  ranking(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.ranking(s.localId!, num(dias, 90));
  }

  /** HU-L12 */
  @Roles('comercio')
  @Get('categorias')
  categorias(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.categoriasLocal(s.localId!, num(dias, 90));
  }
}

/** Asistente conversacional del Centro de Inteligencia (con memoria y acciones sugeridas). */
@Roles('admin', 'marketing', 'analista')
@Controller('admin/asistente')
export class AsistenteController {
  constructor(
    private readonly asistente: AsistenteAdmin,
    private readonly oido: OidoJarvis,
    private readonly sintetizador: VozNeuralService,
  ) {}

  @Post()
  preguntar(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ pregunta: z.string().min(1).max(400) }))) d: { pregunta: string }) {
    return this.asistente.preguntar(s, d.pregunta);
  }

  /**
   * Preguntar por voz: el navegador manda el audio (campo «audio»), el servidor lo transcribe con
   * Whisper local y el asistente responde en la misma llamada. El audio no se guarda.
   */
  @Post('voz')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 6 * 1024 * 1024 } }))
  async voz(@SesionActual() s: Sesion, @UploadedFile() audio: ArchivoSubido) {
    const r = await this.oido.transcribir(audio?.buffer);
    return { ...r, respuesta: r.texto ? await this.asistente.preguntar(s, r.texto) : null };
  }

  /** La respuesta en voz alta, con la misma voz neuronal en español que usa Jarvis. */
  @Post('hablar')
  async hablar(@Body(new ZodPipe(z.object({ texto: z.string().min(1).max(900), velocidad: z.number().min(0.7).max(1.4).optional() }))) d: { texto: string; velocidad?: number }) {
    const r = await this.sintetizador.sintetizar(d.texto, d.velocidad);
    return { url: `/voz/${r.id}.mp3`, segundos: r.segundos, latenciaMs: r.latenciaMs };
  }

  @Get('historial')
  historial(@SesionActual() s: Sesion) {
    return this.asistente.historial(s.sub);
  }

  @Post('reiniciar')
  reiniciar(@SesionActual() s: Sesion) {
    return this.asistente.reiniciar(s.sub);
  }
}
