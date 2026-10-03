import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { InteligenciaService } from './inteligencia.service.js';

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
