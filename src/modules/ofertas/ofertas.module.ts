import { Body, Controller, Get, Module, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha } from '../../common/zod.pipe.js';
import { ahoraBolivia } from '../../common/util.js';
import { FidelizacionModule } from '../fidelizacion/fidelizacion.module.js';
import { JarvisModule } from '../jarvis/jarvis.module.js';
import { EquidadService } from '../jarvis/equidad.service.js';
import { OfertasService } from './ofertas.service.js';

@Roles('cliente')
@Controller('cliente/ofertas')
export class OfertasClienteController {
  constructor(private readonly svc: OfertasService) {}

  @Get()
  hoy(@SesionActual() s: Sesion) {
    return this.svc.delCliente(s.sub);
  }
}

@Roles('comercio')
@Controller('local/ofertas')
export class OfertasComercioController {
  constructor(private readonly svc: OfertasService) {}

  @Get()
  resumen(@SesionActual() s: Sesion) {
    return this.svc.delLocal(s.localId!);
  }
}

const AjustesSchema = z.object({
  ofertas_activas: z.boolean().optional(),
  ofertas_por_cliente: z.number().int().min(1).max(5).optional(),
  multiplicador_max: z.number().min(1.5).max(5).optional(),
  peso_equidad: z.number().min(0).max(1).optional(),
  hora_generacion: z.number().int().min(0).max(23).optional(),
});

@Roles('admin', 'marketing', 'analista')
@Controller('admin')
export class OfertasAdminController {
  constructor(
    private readonly svc: OfertasService,
    private readonly equidad: EquidadService,
  ) {}

  @Get('ofertas')
  resumen(@SesionActual() s: Sesion) {
    return this.svc.resumen(s.recintoId);
  }

  @Roles('admin', 'marketing')
  @Post('ofertas/generar')
  generar(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ fecha: zFecha.optional(), forzar: z.boolean().optional() }))) d: { fecha?: string; forzar?: boolean }) {
    return this.svc.generarDia(s.recintoId, d.fecha ?? ahoraBolivia().fecha, { forzar: d.forzar ?? true });
  }

  @Roles('admin', 'marketing')
  @Put('ofertas/ajustes')
  ajustes(@SesionActual() s: Sesion, @Body(new ZodPipe(AjustesSchema)) d: z.infer<typeof AjustesSchema>) {
    return this.svc.guardarAjustes(s, d);
  }

  /** Equidad del flujo: Gini de visitas y de exposición, locales sub y sobre atendidos. */
  @Get('equidad')
  indicadores(@SesionActual() s: Sesion) {
    return this.equidad.indicadores(s.recintoId);
  }
}

@Module({
  imports: [FidelizacionModule, JarvisModule],
  controllers: [OfertasClienteController, OfertasComercioController, OfertasAdminController],
  providers: [OfertasService],
  exports: [OfertasService],
})
export class OfertasModule {}
