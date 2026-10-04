import { Body, Controller, Delete, Get, Module, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import type { Response } from 'express';
import { z } from 'zod';
import { Publico, Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { CerebroJarvis, MotorNube, MotorOllama } from './cerebro.js';
import { ContextoService } from './contexto.service.js';
import { OrquestadorJarvis } from './orquestador.service.js';
import { MemoriaJarvis } from './memoria.service.js';
import { ConocimientoPaseo } from './conocimiento.service.js';
import { OidoJarvis } from './oido.service.js';
import { EquidadService } from './equidad.service.js';
import { PerfilService } from './perfil.service.js';
import { RecomendadorService } from './recomendador.service.js';
import { VozNeuralService } from './voz-neural.service.js';

const DestinoSchema = z.object({ destino: z.string().min(3), via: z.string().optional() });
const InfoSchema = z.object({
  tema: z.string().trim().min(3).max(80),
  palabrasClave: z.array(z.string().trim().min(2).max(40)).min(1).max(30),
  respuesta: z.string().trim().min(10).max(600),
  activo: z.boolean().optional(),
});
type DatosInfo = z.infer<typeof InfoSchema>;

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

  /** Prueba de presencia (QR de la puerta de un local o de una entrada) o «estoy aquí» tocando el mapa. */
  @Post('posicion')
  mover(
    @SesionActual() s: Sesion,
    @Body(new ZodPipe(z.object({ codigo: z.string().min(4).optional(), nodoId: z.string().min(3).optional() }).refine((d) => d.codigo || d.nodoId, 'Indica un código o un lugar')))
    d: { codigo?: string; nodoId?: string },
  ) {
    return d.codigo ? this.orientacion.moverPorCodigo(s.recintoId, s.sub, d.codigo) : this.orientacion.moverManual(s.recintoId, s.sub, d.nodoId!);
  }

  /** Ruta desde la posición actual hasta un nodo (`local:<id>`, `servicio:<id>`) o un local por id. */
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
    private readonly voz: VozNeuralService,
  ) {}

  @Get()
  async resumen(@SesionActual() s: Sesion) {
    return { disponibilidad: await this.cerebro.estado(), oido: this.oido.estado, voz: this.voz.estado, ...(await this.orquestador.ultimas(s.recintoId)) };
  }

  @Roles('admin')
  @Post('grafo/reconstruir')
  reconstruir(@SesionActual() s: Sesion) {
    return this.orientacion.reconstruir(s.recintoId);
  }
}

/** Audio de la voz de Jarvis: el id es aleatorio y de un solo uso práctico (vive 30 minutos). */
@Publico()
@Controller('voz')
export class VozController {
  constructor(private readonly voz: VozNeuralService) {}

  @Get(':archivo')
  audio(@Param('archivo') archivo: string, @Res() res: Response) {
    const mp3 = this.voz.audio(archivo.replace(/\.mp3$/, ''));
    if (!mp3) throw new NotFoundException('Audio vencido');
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'private, max-age=1800');
    res.end(mp3);
  }
}

/**
 * Información para Jarvis: lo que el Paseo quiere que Jarvis diga sobre temas generales (medios de pago,
 * devoluciones, normas). Jarvis la cita tal cual; lo que no está aquí ni en los datos vivos, no lo inventa.
 * También muestra lo que los clientes preguntaron y Jarvis no tenía datos para responder.
 */
@Roles('admin', 'marketing')
@Controller('admin/info-paseo')
export class InfoPaseoController {
  constructor(
    private readonly db: Db,
    private readonly saber: ConocimientoPaseo,
  ) {}

  @Get()
  listar(@SesionActual() s: Sesion) {
    return many(this.db, `select id, tema, palabras_clave, respuesta, activo, actualizado_en from info_paseo where recinto_id = $1 order by activo desc, tema`, [s.recintoId]);
  }

  /** Preguntas de clientes que Jarvis no pudo responder con datos (30 días). */
  @Get('sin-respuesta')
  sinRespuesta(@SesionActual() s: Sesion) {
    return many(
      this.db,
      `select coalesce(j.datos->>'tema', '') as tema, c.texto as pregunta, c.creado_en
       from conversacion_jarvis j join usuario u on u.id = j.cliente_id
       join lateral (select texto, creado_en from conversacion_jarvis x where x.cliente_id = j.cliente_id and x.rol = 'cliente' and x.id < j.id order by x.id desc limit 1) c on true
       where u.recinto_id = $1 and u.rol = 'cliente' and j.rol = 'jarvis' and j.intencion = 'sin_datos' and j.creado_en > now() - interval '30 days'
       order by j.creado_en desc limit 100`,
      [s.recintoId],
    );
  }

  @Post()
  async crear(@SesionActual() s: Sesion, @Body(new ZodPipe(InfoSchema)) d: DatosInfo) {
    const r = await one(
      this.db,
      `insert into info_paseo (recinto_id, tema, palabras_clave, respuesta, activo, actualizado_por) values ($1,$2,$3,$4,$5,$6) returning *`,
      [s.recintoId, d.tema, d.palabrasClave, d.respuesta, d.activo ?? true, s.sub],
    );
    this.saber.olvidar(s.recintoId);
    return r;
  }

  @Put(':id')
  async editar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(InfoSchema)) d: DatosInfo) {
    const r = await one(
      this.db,
      `update info_paseo set tema = $3, palabras_clave = $4, respuesta = $5, activo = $6, actualizado_por = $7, actualizado_en = now() where id = $1 and recinto_id = $2 returning *`,
      [id, s.recintoId, d.tema, d.palabrasClave, d.respuesta, d.activo ?? true, s.sub],
    );
    if (!r) throw new NotFoundException('Tema no encontrado');
    this.saber.olvidar(s.recintoId);
    return r;
  }

  @Delete(':id')
  async borrar(@SesionActual() s: Sesion, @Param('id') id: string) {
    const r = await one(this.db, 'delete from info_paseo where id = $1 and recinto_id = $2 returning id', [id, s.recintoId]);
    if (!r) throw new NotFoundException('Tema no encontrado');
    this.saber.olvidar(s.recintoId);
    return { ok: true };
  }
}

@Module({
  controllers: [OrientacionClienteController, GrafoController, JarvisAdminController, VozController, InfoPaseoController],
  providers: [OrientacionService, MotorOllama, MotorNube, CerebroJarvis, ContextoService, OrquestadorJarvis, MemoriaJarvis, ConocimientoPaseo, OidoJarvis, EquidadService, PerfilService, RecomendadorService, VozNeuralService],
  exports: [OrientacionService, CerebroJarvis, OrquestadorJarvis, ContextoService, MemoriaJarvis, ConocimientoPaseo, OidoJarvis, EquidadService, PerfilService, RecomendadorService, VozNeuralService],
})
export class JarvisModule {}
