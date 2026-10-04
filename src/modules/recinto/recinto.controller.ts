import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zHora, zUuid } from '../../common/zod.pipe.js';
import { RecintoService } from './recinto.service.js';

const LocalSchema = z.object({
  nombre: z.string().min(2),
  categoriaId: zUuid,
  piso: z.enum(['N1', 'N2', 'T']),
  sector: z.string().min(1),
  numeroLocal: z.string().min(1),
  coordX: z.number().min(0).max(1000),
  coordY: z.number().min(0).max(600),
  horarioApertura: zHora.optional(),
  horarioCierre: zHora.optional(),
  descripcion: z.string().optional(),
  palabrasClave: z.array(z.string()).optional(),
  nit: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  fotoUrl: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
});
const CategoriaSchema = z.object({ nombre: z.string().min(2), ambito: z.enum(['comida', 'tiendas']), orden: z.number().int().optional() });

/** Plano y buscador: visibles para cualquier usuario con sesión. */
@Controller('recinto')
export class RecintoController {
  constructor(private readonly svc: RecintoService) {}

  @Get('plano')
  plano(@SesionActual() s: Sesion) {
    return this.svc.plano(s.recintoId);
  }

  @Get('buscar')
  buscar(@SesionActual() s: Sesion, @Query('q') q = '') {
    return this.svc.buscar(s.recintoId, q, s.rol === 'cliente' ? s.sub : null, 'app');
  }

  @Get('capas')
  capas(@SesionActual() s: Sesion) {
    return this.svc.capas(s.recintoId, s.rol === 'cliente' ? s.sub : null);
  }

  @Get('categorias')
  categorias() {
    return this.svc.categorias();
  }

  @Get('locales/:id')
  local(@Param('id') id: string) {
    return this.svc.local(id);
  }
}

@Roles('admin', 'marketing')
@Controller('admin')
export class AdminRecintoController {
  constructor(private readonly svc: RecintoService) {}

  @Post('locales')
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(LocalSchema)) d: z.infer<typeof LocalSchema>) {
    return this.svc.crearLocal(s, d);
  }

  @Patch('locales/:id')
  actualizar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(LocalSchema.partial())) d: Partial<z.infer<typeof LocalSchema>>) {
    return this.svc.actualizarLocal(s, id, d);
  }

  @Get('locales/:id/qr-puerta.pdf')
  async qrAdmin(@Param('id') id: string, @Res() res: Response) {
    const pdf = await this.svc.qrPuertaPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="qr-puerta-${id}.pdf"`);
    res.end(pdf);
  }

  @Post('categorias')
  crearCategoria(@SesionActual() s: Sesion, @Body(new ZodPipe(CategoriaSchema)) d: z.infer<typeof CategoriaSchema>) {
    return this.svc.crearCategoria(s, d);
  }

  @Patch('categorias/:id')
  actualizarCategoria(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(CategoriaSchema.partial())) d: Partial<z.infer<typeof CategoriaSchema>>) {
    return this.svc.actualizarCategoria(s, id, d);
  }

  @Delete('categorias/:id')
  eliminarCategoria(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.eliminarCategoria(s, id);
  }
}

const ActualizarMiLocalSchema = z.object({
  descripcion: z.string().optional(),
  fotoUrl: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
});

@Roles('comercio')
@Controller('local')
export class LocalRecintoController {
  constructor(private readonly svc: RecintoService) {}

  @Get('mi-local')
  miLocal(@SesionActual() s: Sesion) {
    return this.svc.local(s.localId!);
  }

  @Patch('mi-local')
  actualizarMiLocal(
    @SesionActual() s: Sesion,
    @Body(new ZodPipe(ActualizarMiLocalSchema)) d: { descripcion?: string; fotoUrl?: string | null; bannerUrl?: string | null },
  ) {
    if (!s.localId) throw new ForbiddenException('Tu usuario no está asignado a un local');
    return this.svc.actualizarMiLocal(s.localId, d);
  }

  /** HU-L07: el comercio descarga el QR de su puerta en PDF. */
  @Roles('comercio')
  @Get('qr-puerta.pdf')
  async qr(@SesionActual() s: Sesion, @Res() res: Response) {
    if (!s.localId) throw new ForbiddenException('Tu usuario no está asignado a un local');
    const pdf = await this.svc.qrPuertaPdf(s.localId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="qr-puerta.pdf"');
    res.end(pdf);
  }
}

