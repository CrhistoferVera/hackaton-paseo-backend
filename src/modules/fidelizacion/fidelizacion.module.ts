import { Body, Controller, Get, Module, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zHora } from '../../common/zod.pipe.js';
import { FidelizacionService } from './fidelizacion.service.js';
import { LedgerRepository } from './ledger.repository.js';

const NivelSchema = z.object({
  nombre: z.enum(['Bronce', 'Plata', 'Oro', 'Platinum']),
  minimo: z.number().int().min(0),
  beneficios: z.array(z.string()),
});
const ReglaSchema = z.object({
  bs_por_punto: z.number().positive(),
  valor_punto_bs: z.number().positive(),
  multiplicadores_categoria: z.record(z.string(), z.number().positive()),
  multiplicadores_horario: z.array(
    z.object({ dias: z.array(z.number().int().min(0).max(6)), desde: zHora, hasta: zHora, mult: z.number().positive(), etiqueta: z.string().optional() }),
  ),
  dias_vencimiento: z.number().int().min(30),
  niveles: z.array(NivelSchema).length(4),
  bono_bienvenida: z.number().int().min(0),
  puntos_descubrimiento: z.number().int().min(0),
  puntos_visita_diaria: z.number().int().min(0),
  puntos_referido: z.number().int().min(0),
  puntos_hora_parqueo: z.number().int().min(1),
});

@Controller()
export class FidelizacionController {
  constructor(private readonly svc: FidelizacionService) {}

  /** HU-C04 y HU-C05 */
  @Roles('cliente')
  @Get('cliente/resumen')
  resumen(@SesionActual() s: Sesion) {
    return this.svc.resumen(s.sub, s.recintoId);
  }

  /** HU-C06 */
  @Roles('cliente')
  @Get('cliente/movimientos')
  movimientos(@SesionActual() s: Sesion, @Query('tipo') tipo?: string, @Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.movimientos(s.sub, { tipo: tipo || undefined, desde: desde || undefined, hasta: hasta || undefined });
  }

  /** HU-A03 */
  @Roles('admin', 'marketing', 'analista')
  @Get('admin/reglas')
  async reglas(@SesionActual() s: Sesion) {
    return { vigente: await this.svc.obtenerRegla(s.recintoId), historial: await this.svc.historialReglas(s.recintoId) };
  }

  @Roles('admin')
  @Put('admin/reglas')
  actualizar(@SesionActual() s: Sesion, @Body(new ZodPipe(ReglaSchema)) d: z.infer<typeof ReglaSchema>) {
    return this.svc.actualizarRegla(s.recintoId, s.sub, d as any);
  }

  /** HU-A20 */
  @Roles('admin', 'analista', 'marketing')
  @Get('admin/economia')
  economia(@SesionActual() s: Sesion) {
    return this.svc.economia(s.recintoId);
  }
}

@Module({
  controllers: [FidelizacionController],
  providers: [FidelizacionService, LedgerRepository],
  exports: [FidelizacionService],
})
export class FidelizacionModule {}
