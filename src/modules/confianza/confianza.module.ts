import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { FraudeService } from './fraude.service.js';

const ResolverSchema = z.object({ estado: z.enum(['descartada', 'confirmada']) });

@Roles('admin', 'analista')
@Controller('admin')
export class ConfianzaController {
  constructor(private readonly svc: FraudeService) {}

  @Get('fraude/alertas')
  alertas(@SesionActual() s: Sesion, @Query('estado') estado?: string) {
    return this.svc.listar(s.recintoId, estado || undefined);
  }

  @Get('fraude/modelo')
  modelo() {
    return this.svc.estadoModelo();
  }

  @Post('fraude/modelo/entrenar')
  async entrenar() {
    await this.svc.entrenar();
    return this.svc.estadoModelo();
  }

  @Roles('admin')
  @Post('fraude/alertas/:id')
  resolver(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(ResolverSchema)) d: z.infer<typeof ResolverSchema>) {
    return this.svc.resolver(s, id, d.estado);
  }

  @Roles('admin')
  @Get('auditoria')
  auditoria() {
    return this.svc.auditoriaReciente(200);
  }
}

@Module({
  controllers: [ConfianzaController],
  providers: [FraudeService],
  exports: [FraudeService],
})
export class ConfianzaModule {}
