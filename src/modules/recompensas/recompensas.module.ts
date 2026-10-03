import { Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha, zUuid } from '../../common/zod.pipe.js';
import { FidelizacionModule } from '../fidelizacion/fidelizacion.module.js';
import { ConfianzaModule } from '../confianza/confianza.module.js';
import { RecompensasService } from './recompensas.service.js';

const RecompensaSchema = z.object({
  nombre: z.string().min(2),
  descripcion: z.string().optional(),
  costoPuntos: z.number().int().positive(),
  localId: zUuid.nullable().optional(),
  stock: z.number().int().min(0).nullable().optional(),
  temporada: z.string().nullable().optional(),
  vigenciaDesde: zFecha.nullable().optional(),
  vigenciaHasta: zFecha.nullable().optional(),
  activo: z.boolean().optional(),
});
const CodigoSchema = z.object({ codigo: z.string().min(5) });

@Controller()
export class RecompensasController {
  constructor(private readonly svc: RecompensasService) {}

  @Roles('cliente')
  @Get('cliente/recompensas')
  catalogo(@SesionActual() s: Sesion) {
    return this.svc.catalogo(s.recintoId, s.sub);
  }

  @Roles('cliente')
  @Post('cliente/canjes')
  canjear(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ recompensaId: zUuid }))) d: { recompensaId: string }) {
    return this.svc.canjear(s.recintoId, s.sub, d.recompensaId);
  }

  @Roles('cliente')
  @Get('cliente/canjes')
  misCanjes(@SesionActual() s: Sesion) {
    return this.svc.misCanjes(s.sub);
  }

  @Roles('comercio')
  @Post('local/cupones/consultar')
  consultar(@SesionActual() s: Sesion, @Body(new ZodPipe(CodigoSchema)) d: { codigo: string }) {
    return this.svc.consultarCupon(s, d.codigo);
  }

  @Roles('comercio')
  @Post('local/cupones/entregar')
  entregar(@SesionActual() s: Sesion, @Body(new ZodPipe(CodigoSchema)) d: { codigo: string }) {
    return this.svc.entregarCupon(s, d.codigo);
  }

  @Roles('admin', 'marketing')
  @Get('admin/recompensas')
  listar(@SesionActual() s: Sesion) {
    return this.svc.listarAdmin(s.recintoId);
  }

  @Roles('admin', 'marketing')
  @Post('admin/recompensas')
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(RecompensaSchema)) d: z.infer<typeof RecompensaSchema>) {
    return this.svc.crear(s, d);
  }

  @Roles('admin', 'marketing')
  @Patch('admin/recompensas/:id')
  actualizar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(RecompensaSchema.partial())) d: Partial<z.infer<typeof RecompensaSchema>>) {
    return this.svc.actualizar(s, id, d);
  }
}

@Module({
  imports: [FidelizacionModule, ConfianzaModule],
  controllers: [RecompensasController],
  providers: [RecompensasService],
  exports: [RecompensasService],
})
export class RecompensasModule {}
