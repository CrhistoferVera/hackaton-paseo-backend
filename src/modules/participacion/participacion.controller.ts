import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha, zHora, zUuid } from '../../common/zod.pipe.js';
import { EventosService } from './eventos.service.js';
import { ExperienciasService } from './experiencias.service.js';
import { MisionesService } from './misiones.service.js';
import { PromocionesService } from './promociones.service.js';

const PromocionSchema = z.object({
  titulo: z.string().min(3),
  tipo: z.enum(['puntos_dobles', 'cupon']),
  costoPuntos: z.number().int().positive().optional(),
  multiplicador: z.number().min(1).max(5).optional(),
  descripcion: z.string().optional(),
  segmentoId: zUuid.nullable().optional(),
  diasSemana: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  horaInicio: zHora.optional(),
  horaFin: zHora.optional(),
  inicio: zFecha,
  fin: zFecha,
  localId: zUuid.nullable().optional(),
});
const RevisionSchema = z.object({ estado: z.enum(['aprobada', 'rechazada']), comentario: z.string().optional(), costoPuntos: z.number().int().positive().optional() });
const MisionSchema = z.object({
  nombre: z.string().min(3),
  descripcion: z.string().min(3),
  plantilla: z.enum(['locales_distintos', 'compras_categoria', 'franja_horaria', 'primera_visita', 'local_especifico']),
  regla: z.object({
    n: z.number().int().min(1).max(20).optional(),
    categoria: z.string().nullable().optional(),
    desde: zHora.optional(),
    hasta: zHora.optional(),
    localId: zUuid.optional(),
    montoMin: z.number().min(0).optional(),
  }),
  recompensaPuntos: z.number().int().positive(),
  segmentoId: zUuid.nullable().optional(),
  vigenciaDesde: zFecha,
  vigenciaHasta: zFecha,
});
const HitoSchema = z.object({ codigo: z.string().min(4), lat: z.number().optional(), lng: z.number().optional() });
const DropSchema = z.object({
  zonaId: zUuid,
  productoId: zUuid,
  precioEspecial: z.number().positive(),
  mensaje: z.string().min(3).max(140),
  minutos: z.number().int().min(5).max(24 * 60).default(60),
  maxReclamos: z.number().int().min(1).max(1000).default(50),
});

@Roles('cliente')
@Controller('cliente')
export class ParticipacionClienteController {
  constructor(
    private readonly misiones: MisionesService,
    private readonly promociones: PromocionesService,
    private readonly exp: ExperienciasService,
  ) {}

  /** HU-C13 */
  @Get('misiones')
  misionesCliente(@SesionActual() s: Sesion) {
    return this.misiones.delCliente(s.recintoId, s.sub);
  }

  @Get('promociones')
  promocionesCliente(@SesionActual() s: Sesion) {
    return this.promociones.vigentes(s.recintoId, s.sub);
  }

  /** HU-X04: reconocer el cartel del hito y ver qué ofrece. */
  @Post('hitos/inspeccionar')
  inspeccionar(@SesionActual() s: Sesion, @Body(new ZodPipe(HitoSchema)) d: z.infer<typeof HitoSchema>) {
    return this.exp.inspeccionar(s.recintoId, s.sub, d.codigo);
  }

  @Post('hitos/reclamar')
  reclamar(@SesionActual() s: Sesion, @Body(new ZodPipe(HitoSchema)) d: z.infer<typeof HitoSchema>) {
    return this.exp.reclamarHito(s.recintoId, s.sub, d.codigo, d.lat, d.lng);
  }

  /** HU-X05 */
  @Post('drops/reclamar')
  reclamarDrop(@SesionActual() s: Sesion, @Body(new ZodPipe(HitoSchema)) d: z.infer<typeof HitoSchema>) {
    return this.exp.reclamarDrop(s.recintoId, s.sub, d.codigo, d.lat, d.lng);
  }

  @Get('drops')
  misDrops(@SesionActual() s: Sesion) {
    return this.exp.misDrops(s.sub);
  }
}

@Roles('comercio')
@Controller('local/promociones')
export class PromocionesLocalController {
  constructor(private readonly svc: PromocionesService) {}

  /** HU-L11 */
  @Post()
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(PromocionSchema)) d: z.infer<typeof PromocionSchema>) {
    return this.svc.crearDeLocal(s, d);
  }

  @Get()
  listar(@SesionActual() s: Sesion) {
    return this.svc.delLocal(s.localId!);
  }
}

@Roles('admin', 'marketing')
@Controller('admin')
export class ParticipacionAdminController {
  constructor(
    private readonly misiones: MisionesService,
    private readonly promociones: PromocionesService,
    private readonly exp: ExperienciasService,
  ) {}

  @Get('promociones')
  promocionesTodas(@SesionActual() s: Sesion, @Query('estado') estado?: string) {
    return this.promociones.todas(s.recintoId, estado || undefined);
  }

  @Post('promociones')
  crearPromocion(@SesionActual() s: Sesion, @Body(new ZodPipe(PromocionSchema)) d: z.infer<typeof PromocionSchema>) {
    return this.promociones.crearDeAdmin(s, d);
  }

  /** HU-A06 */
  @Post('promociones/:id/revision')
  revisar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(RevisionSchema)) d: z.infer<typeof RevisionSchema>) {
    return this.promociones.revisar(s, id, d.estado, d.comentario, d.costoPuntos);
  }

  /** HU-A05 */
  @Get('misiones')
  misionesTodas(@SesionActual() s: Sesion) {
    return this.misiones.listar(s.recintoId);
  }

  @Get('misiones/ia')
  misionesIA(@SesionActual() s: Sesion) {
    return this.misiones.resumenIA(s.recintoId);
  }

  @Post('misiones')
  crearMision(@SesionActual() s: Sesion, @Body(new ZodPipe(MisionSchema)) d: z.infer<typeof MisionSchema>) {
    return this.misiones.crear(s, d);
  }

  @Post('misiones/:id/activa')
  activar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(z.object({ activa: z.boolean() }))) d: { activa: boolean }) {
    return this.misiones.activar(s, id, d.activa);
  }

  @Get('hitos')
  hitos(@SesionActual() s: Sesion) {
    return this.exp.hitos(s.recintoId);
  }

  @Get('drops')
  drops(@SesionActual() s: Sesion) {
    return this.exp.drops(s.recintoId);
  }

  @Post('drops')
  lanzar(@SesionActual() s: Sesion, @Body(new ZodPipe(DropSchema)) d: z.infer<typeof DropSchema>) {
    return this.exp.lanzarDrop(s, d);
  }
}

const ActividadSchema = z.object({
  titulo: z.string().min(3).max(120),
  descripcion: z.string().max(600).optional(),
  tipo: z.enum(['concierto', 'feria', 'taller', 'infantil', 'cine', 'deporte', 'lanzamiento', 'degustacion', 'moda', 'cultural', 'otro']),
  inicio: z.string().datetime({ offset: true }),
  fin: z.string().datetime({ offset: true }),
  zonaId: zUuid.nullable().optional(),
  lugar: z.string().max(120).optional(),
  precioBs: z.number().min(0).nullable().optional(),
  cupos: z.number().int().positive().nullable().optional(),
  puntos: z.number().int().min(0).max(1000).optional(),
});
const SolicitudDropSchema = z.object({
  productoId: zUuid,
  precioEspecial: z.number().positive(),
  mensaje: z.string().min(3).max(140),
  zonaId: zUuid.nullable().optional(),
  fechaDeseada: z.string().datetime({ offset: true }).nullable().optional(),
  minutos: z.number().int().min(15).max(24 * 60).optional(),
  maxReclamos: z.number().int().min(1).max(1000).optional(),
});

/** Panel de comercio: promociones, Drops y eventos propios. */
@Roles('comercio')
@Controller('local')
export class ComercioParticipacionController {
  constructor(
    private readonly promociones: PromocionesService,
    private readonly eventos: EventosService,
  ) {}

  @Delete('promociones/:id')
  finalizarPromocion(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.promociones.finalizarDeLocal(s, id);
  }

  @Get('drops')
  drops(@SesionActual() s: Sesion) {
    return this.eventos.solicitudesDelLocal(s.localId!);
  }

  @Post('drops')
  solicitar(@SesionActual() s: Sesion, @Body(new ZodPipe(SolicitudDropSchema)) d: z.infer<typeof SolicitudDropSchema>) {
    return this.eventos.solicitarDrop(s, d);
  }

  @Delete('drops/:id')
  cancelarDrop(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.eventos.cancelarSolicitud(s, id);
  }

  @Get('eventos')
  misEventos(@SesionActual() s: Sesion) {
    return this.eventos.delLocal(s.localId!);
  }

  @Post('eventos')
  proponer(@SesionActual() s: Sesion, @Body(new ZodPipe(ActividadSchema)) d: z.infer<typeof ActividadSchema>) {
    return this.eventos.proponer(s, d);
  }

  @Delete('eventos/:id')
  cancelarEvento(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.eventos.cancelarDeLocal(s, id);
  }
}

@Roles('admin', 'marketing')
@Controller('admin')
export class EventosAdminController {
  constructor(private readonly eventos: EventosService) {}

  @Get('eventos')
  todos(@SesionActual() s: Sesion, @Query('estado') estado?: string) {
    return this.eventos.todos(s.recintoId, estado || undefined);
  }

  @Post('eventos')
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(ActividadSchema.extend({ localId: zUuid.nullable().optional() }))) d: z.infer<typeof ActividadSchema> & { localId?: string | null }) {
    return this.eventos.crearDeAdmin(s, d);
  }

  @Post('eventos/:id/revision')
  revisar(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
    @Body(new ZodPipe(z.object({ estado: z.enum(['aprobada', 'rechazada', 'cancelada']), comentario: z.string().optional(), puntos: z.number().int().min(0).max(1000).optional() })))
    d: { estado: 'aprobada' | 'rechazada' | 'cancelada'; comentario?: string; puntos?: number },
  ) {
    return this.eventos.revisarActividad(s, id, d.estado, d.comentario, d.puntos);
  }

  @Get('drops/solicitudes')
  solicitudes(@SesionActual() s: Sesion, @Query('estado') estado?: string) {
    return this.eventos.solicitudes(s.recintoId, estado || undefined);
  }

  @Post('drops/solicitudes/:id/lanzar')
  lanzar(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
    @Body(new ZodPipe(z.object({ zonaId: zUuid.optional(), minutos: z.number().int().min(5).max(24 * 60).optional(), maxReclamos: z.number().int().min(1).max(1000).optional() })))
    d: { zonaId?: string; minutos?: number; maxReclamos?: number },
  ) {
    return this.eventos.lanzarSolicitud(s, id, d);
  }

  @Post('drops/solicitudes/:id/rechazar')
  rechazar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(z.object({ comentario: z.string().min(3) }))) d: { comentario: string }) {
    return this.eventos.rechazarSolicitud(s, id, d.comentario);
  }
}

/** Eventos para la app del cliente. */
@Roles('cliente')
@Controller('cliente/eventos')
export class EventosClienteController {
  constructor(private readonly eventos: EventosService) {}

  @Get()
  proximos(@SesionActual() s: Sesion) {
    return this.eventos.proximos(s.recintoId);
  }
}
