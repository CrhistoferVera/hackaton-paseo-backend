import { Body, Controller, Get, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ArchivoSubido } from '../../common/archivos.js';
import { OidoJarvis } from '../jarvis/oido.service.js';
import { z } from 'zod';
import { ConApiKey, Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { RecompensasService } from '../recompensas/recompensas.service.js';
import { PaseoYaService } from '../paseoya/paseoya.service.js';
import { JarvisService } from './jarvis.service.js';

const ConsultaSchema = z.object({ celular: z.string().regex(/^\d{8}$/).optional(), pregunta: z.string().min(2).max(300) });

/**
 * API pública v1 para Jarvis Paseo y socios. Autenticación por cabecera x-api-key.
 * Ejemplo: POST /api/v1/jarvis/consulta {"celular":"70000001","pregunta":"¿qué puedo canjear?"}
 */
@ConApiKey()
@Controller('api/v1')
export class IntegracionesApiController {
  constructor(
    private readonly jarvis: JarvisService,
    private readonly fidelizacion: FidelizacionService,
    private readonly recompensas: RecompensasService,
    private readonly paseoya: PaseoYaService,
  ) {}

  @Post('jarvis/consulta')
  async consulta(@Body(new ZodPipe(ConsultaSchema)) d: z.infer<typeof ConsultaSchema>) {
    const c = d.celular ? await this.jarvis.clientePorCelular(d.celular) : null;
    const recinto = c?.recinto_id ?? await this.jarvis.recintoPorDefecto();
    return this.jarvis.consultar(recinto, c?.id ?? null, d.pregunta);
  }

  @Get('clientes/saldo')
  async saldo(@Query('celular') celular: string) {
    const c = await this.jarvis.clientePorCelular(celular);
    const r = await this.fidelizacion.resumen(c.id, c.recinto_id);
    return { nombre: c.nombre.split(' ')[0], saldo: r.saldo, disponible: r.disponible, nivel: r.nivel.nivel, porVencer: r.porVencer };
  }

  @Get('clientes/canjeables')
  async canjeables(@Query('celular') celular: string) {
    const c = await this.jarvis.clientePorCelular(celular);
    const cat = await this.recompensas.catalogo(c.recinto_id, c.id);
    return cat.recompensas.map((r: any) => ({ id: r.id, nombre: r.nombre, costo: r.costo_puntos, puedeCanjear: r.puedeCanjear, faltan: r.faltan }));
  }

  @Get('productos/buscar')
  async productos(@Query('q') q = '') {
    const recinto = await this.jarvis.recintoPorDefecto();
    return this.paseoya.buscarDesdeJarvis(recinto, q, null);
  }
}

/** La app del cliente conversa con Jarvis usando su propia sesión. */
@Roles('cliente')
@Controller('cliente/jarvis')
export class JarvisClienteController {
  constructor(
    private readonly jarvis: JarvisService,
    private readonly oido: OidoJarvis,
  ) {}

  @Post()
  preguntar(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ pregunta: z.string().min(1).max(300) }))) d: { pregunta: string }) {
    return this.jarvis.consultar(s.recintoId, s.sub, d.pregunta);
  }

  /** Conversación guardada (memoria), para retomarla al abrir la app. */
  @Get('historial')
  historial(@SesionActual() s: Sesion) {
    return this.jarvis.historial(s.sub);
  }

  @Post('reiniciar')
  reiniciar(@SesionActual() s: Sesion) {
    return this.jarvis.reiniciar(s.sub);
  }

  /**
   * Voz: el celular o el navegador mandan el audio grabado (campo «audio»), el servidor lo
   * transcribe con Whisper local y, si se pide, Jarvis responde en la misma llamada.
   */
  @Post('voz')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 6 * 1024 * 1024 } }))
  async voz(@SesionActual() s: Sesion, @UploadedFile() audio: ArchivoSubido, @Query('responder') responder?: string) {
    const r = await this.oido.transcribir(audio?.buffer);
    if (!r.texto) return { ...r, respuesta: null };
    return { ...r, respuesta: responder === '0' ? null : await this.jarvis.consultar(s.recintoId, s.sub, r.texto) };
  }
}
