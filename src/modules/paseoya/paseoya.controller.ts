import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha, zUuid } from '../../common/zod.pipe.js';
import { guardarImagen, type ArchivoSubido } from '../../common/archivos.js';
import { PaseoYaService } from './paseoya.service.js';

const PedidoSchema = z.object({
  items: z.array(z.object({ productoId: zUuid, cantidad: z.number().int().min(1).max(20), dropId: zUuid.nullable().optional(), varianteId: zUuid.optional(), varianteIds: z.array(zUuid).max(12).optional() })).min(1),
  tipo: z.enum(['comida', 'retail']).optional(),
  fechaEstimadaRetiro: z.string().optional(),
  fecha_estimada_retiro: z.string().optional(),
  pago: z.enum(['en_local', 'qr_anticipado']).default('en_local'),
});
const VariantesSchema = z.array(z.object({
  id: zUuid.optional(), titulo: z.string().trim().min(1).max(80),
  opciones: z.array(z.object({
    id: zUuid.optional(), nombre: z.string().trim().min(1).max(80),
    stock: z.number().int().min(0), precioBs: z.number().nonnegative().nullable().optional(),
    fotoUrl: z.string().nullable().optional(), activo: z.boolean().optional(),
  })).min(1).max(100),
})).max(12);
const ProductoSchema = z.object({
  nombre: z.string().min(2),
  descripcion: z.string().optional(),
  precioBs: z.number().positive(),
  stock: z.number().int().min(0),
  categoriaId: zUuid,
  fotoUrl: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  tiempoPreparacionMin: z.number().int().min(0).max(240).nullable().optional(),
  etiquetas: z.array(z.string().min(2).max(30)).max(12).optional(),
  variantes: VariantesSchema.optional(),
});
const FavoritoSchema = z.object({ productoId: zUuid.optional(), localId: zUuid.optional() });
const CodigoSchema = z.object({ codigo: z.string().min(4) });

/** Catálogo PaseoYa: visible para clientes y personal. */
@Controller('paseoya')
export class PaseoYaCatalogoController {
  constructor(private readonly svc: PaseoYaService) {}

  @Get('categorias')
  categorias(@Query('ambito') ambito?: string) {
    return this.svc.categorias(ambito || undefined);
  }

  @Get('productos')
  productos(@SesionActual() s: Sesion, @Query('categoria') categoriaId?: string, @Query('ambito') ambito?: string, @Query('local') localId?: string) {
    return this.svc.productos(s.recintoId, { categoriaId: categoriaId || undefined, ambito: ambito || undefined, localId: localId || undefined }, s.rol === 'cliente' ? s.sub : null);
  }

  @Get('destacados')
  destacados(@SesionActual() s: Sesion) {
    return this.svc.destacados(s.recintoId);
  }

  @Get('buscar')
  buscar(@SesionActual() s: Sesion, @Query('q') q = '', @Query('orden') orden?: 'precio' | 'nombre') {
    return this.svc.buscar(s.recintoId, q, s.rol === 'cliente' ? s.sub : null, orden ?? 'precio');
  }

  @Get('productos/:id')
  producto(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.producto(s.recintoId, id, s.rol === 'cliente' ? s.sub : null);
  }
}

@Roles('cliente')
@Controller('cliente')
export class PaseoYaClienteController {
  constructor(private readonly svc: PaseoYaService) {}

  @Post('pedidos')
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(PedidoSchema)) d: z.infer<typeof PedidoSchema>) {
    return this.svc.crearPedido(s.recintoId, s.sub, d);
  }

  @Get('pedidos')
  mios(@SesionActual() s: Sesion) {
    return this.svc.misPedidos(s.sub);
  }

  @Get('pedidos/:id')
  pedido(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.pedido(s.sub, id);
  }

  @Post('pedidos/:id/llegue')
  llegue(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.llegue(s.recintoId, s.sub, id);
  }

  @Post('pedidos/:id/repetir')
  repetir(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.repetir(s.sub, id);
  }

  /** HU-Y11: comprobante del pago QR adjunto al pedido. */
  @Post('pedidos/:id/comprobante')
  @UseInterceptors(FileInterceptor('archivo'))
  comprobante(@SesionActual() s: Sesion, @Param('id') id: string, @UploadedFile() archivo: ArchivoSubido) {
    return this.svc.subirComprobante(s.sub, id, guardarImagen(archivo));
  }

  @Get('favoritos')
  favoritos(@SesionActual() s: Sesion) {
    return this.svc.favoritos(s.sub);
  }

  @Post('favoritos')
  alternar(@SesionActual() s: Sesion, @Body(new ZodPipe(FavoritoSchema)) d: z.infer<typeof FavoritoSchema>) {
    return this.svc.alternarFavorito(s.sub, d);
  }
}

@Roles('comercio')
@Controller('local')
export class PaseoYaLocalController {
  constructor(private readonly svc: PaseoYaService) {}

  @Get('productos/:id/variantes')
  variantes(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.variantesDelLocal(s, id);
  }

  @Post('productos/:id/variantes')
  guardarVariantes(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(VariantesSchema)) d: z.infer<typeof VariantesSchema>) {
    return this.svc.guardarVariantes(s, id, d);
  }

  @Get('productos')
  productos(@SesionActual() s: Sesion) {
    return this.svc.productosDelLocal(s.localId!);
  }

  @Roles('comercio')
  @Post('productos')
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(ProductoSchema)) d: z.infer<typeof ProductoSchema>) {
    return this.svc.crearProducto(s, d);
  }

  @Roles('comercio')
  @Patch('productos/:id')
  actualizar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(ProductoSchema.partial())) d: Partial<z.infer<typeof ProductoSchema>>) {
    return this.svc.actualizarProducto(s, id, d);
  }

  @Roles('comercio')
  @Delete('productos/:id')
  eliminar(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.eliminarProducto(s, id);
  }

  @Roles('comercio')
  @Post('productos/foto')
  @UseInterceptors(FileInterceptor('archivo'))
  foto(@UploadedFile() archivo: ArchivoSubido) {
    return { url: guardarImagen(archivo) };
  }

  @Get('pedidos')
  bandeja(@SesionActual() s: Sesion, @Query('estado') estado?: string) {
    return this.svc.bandeja(s.localId!, estado || undefined);
  }

  @Post('pedidos/:id/estado')
  avanzar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(z.object({ estado: z.enum(['confirmado', 'preparando', 'listo']), tiempoPreparacionMin: z.number().int().min(1).max(240).optional() }))) d: { estado: 'confirmado' | 'preparando' | 'listo'; tiempoPreparacionMin?: number }) {
    return this.svc.avanzar(s, id, d.estado, d.tiempoPreparacionMin);
  }

  @Post('retiros/consultar')
  consultar(@SesionActual() s: Sesion, @Body(new ZodPipe(CodigoSchema)) d: { codigo: string }) {
    return this.svc.consultarRetiro(s, d.codigo);
  }

  @Post('retiros/entregar')
  entregar(@SesionActual() s: Sesion, @Body(new ZodPipe(CodigoSchema)) d: { codigo: string }) {
    return this.svc.entregar(s, d.codigo);
  }

  @Get('paseoya/ventas')
  ventas(@SesionActual() s: Sesion, @Query('dias') dias?: string) {
    return this.svc.ventasLocal(s.localId!, Number(dias ?? 30));
  }
}

@Roles('admin', 'marketing')
@Controller('admin/paseoya')
export class PaseoYaAdminController {
  constructor(private readonly svc: PaseoYaService) {}

  @Get('productos')
  productos(@SesionActual() s: Sesion, @Query('q') q?: string) {
    return this.svc.todosLosProductos(s.recintoId, q || undefined);
  }

  @Post('productos/:id/destacar')
  destacar(@SesionActual() s: Sesion, @Param('id') id: string, @Body(new ZodPipe(z.object({ hasta: zFecha.nullable() }))) d: { hasta: string | null }) {
    return this.svc.destacar(s, id, d.hasta);
  }
}
