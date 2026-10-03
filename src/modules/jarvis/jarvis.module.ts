import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { CerebroJarvis, MotorNube, MotorOllama } from './cerebro.js';
import { ContextoService } from './contexto.service.js';
import { OrquestadorJarvis } from './orquestador.service.js';
import { MemoriaJarvis } from './memoria.service.js';
import { ConocimientoPaseo } from './conocimiento.service.js';
import { OidoJarvis } from './oido.service.js';

const DestinoSchema = z.object({ destino: z.string().min(3), via: z.string().optional() });

/** Rutas y posición del cliente dentro del Paseo. */
@Roles('cliente')
@Controller('cliente')
export class OrientacionClienteController {
  constructor(private readonly orientacion: OrientacionService) {}

  @Get('posicion')
  async posicion(@SesionActual() s: Sesion) {
    const p = await this.orientacion.posicion(s.sub);
    const n = (await this.orientacion.grafo(s.recintoId)).nodos.get(p.nodoId);
    return { ...p, nodo: n ? { id: n.id, nombre: n.nombre, piso: n.piso, x: n.x, y: n.y, tipo: n.tipo } : null };
  }

  /** Prueba de presencia (QR de una puerta, cartel o entrada) o «estoy aquí» tocando el mapa. */
  @Post('posicion')
  mover(
    @SesionActual() s: Sesion,
    @Body(new ZodPipe(z.object({ codigo: z.string().min(4).optional(), nodoId: z.string().min(3).optional() }).refine((d) => d.codigo || d.nodoId, 'Indica un código o un lugar')))
    d: { codigo?: string; nodoId?: string },
  ) {
    return d.codigo ? this.orientacion.moverPorCodigo(s.recintoId, s.sub, d.codigo) : this.orientacion.moverManual(s.recintoId, s.sub, d.nodoId!);
  }

  /** Ruta desde la posición actual hasta un nodo (`local:<id>`, `hito:<id>`) o un local por id. */
  @Get('ruta')
  async ruta(@SesionActual() s: Sesion, @Query(new ZodPipe(DestinoSchema)) q: z.infer<typeof DestinoSchema>) {
    const pos = await this.orientacion.posicion(s.sub);
    const destino = q.destino.includes(':') ? q.destino : `local:${q.destino}`;
    const r = await this.orientacion.ruta(s.recintoId, pos.nodoId, destino, q.via ?? null);
    return r ? { ...OrientacionService.paraApp(r), posicionConocida: pos.conocida } : null;
  }
}

@Controller('recinto')
export class GrafoController {
  constructor(private readonly orientacion: OrientacionService) {}

  @Get('grafo')
  grafo(@SesionActual() s: Sesion) {
    return this.orientacion.grafoParaDibujo(s.recintoId);
  }
}

@Roles('admin', 'marketing', 'analista')
@Controller('admin/jarvis')
export class JarvisAdminController {
  constructor(
    private readonly orquestador: OrquestadorJarvis,
    private readonly cerebro: CerebroJarvis,
    private readonly orientacion: OrientacionService,
    private readonly oido: OidoJarvis,
  ) {}

  @Get()
  async resumen(@SesionActual() s: Sesion) {
    return { disponibilidad: await this.cerebro.estado(), oido: this.oido.estado, ...(await this.orquestador.ultimas(s.recintoId)) };
  }

  @Roles('admin')
  @Post('grafo/reconstruir')
  reconstruir(@SesionActual() s: Sesion) {
    return this.orientacion.reconstruir(s.recintoId);
  }
}

@Module({
  controllers: [OrientacionClienteController, GrafoController, JarvisAdminController],
  providers: [OrientacionService, MotorOllama, MotorNube, CerebroJarvis, ContextoService, OrquestadorJarvis, MemoriaJarvis, ConocimientoPaseo, OidoJarvis],
  exports: [OrientacionService, CerebroJarvis, OrquestadorJarvis, ContextoService, MemoriaJarvis, ConocimientoPaseo, OidoJarvis],
})
export class JarvisModule {}
