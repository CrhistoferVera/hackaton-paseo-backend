import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha, zUuid } from '../../common/zod.pipe.js';
import { ComprasService } from './compras.service.js';

const CompraSchema = z
  .object({
    pase: z.string().optional(),
    clienteId: zUuid.optional(),
    codigoCliente: z.string().regex(/^[A-Z0-9]{8}:\d{6}$/).optional(),
    montoBs: z.number().positive().max(1_000_000),
    categoria: z.string().nullable().optional(),
    nroFactura: z.string().max(40).nullable().optional(),
    claveIdempotencia: zUuid,
    capturadoEn: z.string().datetime().optional(),
    offline: z.boolean().optional(),
  })
  .refine((d) => !!d.pase !== !!d.codigoCliente, { message: 'Ingresa solo el QR o el código único del cliente' });

const FacturaSchema = z.object({ contenido: z.string().min(5), montoBs: z.number().positive().optional(), fecha: zFecha.optional() });

@Roles('comercio')
@Controller('local')
export class CajaController {
  constructor(
    private readonly compras: ComprasService,
  ) {}

  /** Tras escanear el pase, la caja muestra a quién va a acreditar. */
  @Post('clientes/pase')
  previsualizar(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ pase: z.string() }))) d: { pase: string }) {
    return this.compras.previsualizar(s, d.pase);
  }

  @Post('clientes/codigo')
  previsualizarCodigo(@SesionActual() s: Sesion, @Body(new ZodPipe(z.object({ codigo: z.string().regex(/^[A-Z0-9]{8}:\d{6}$/) }))) d: { codigo: string }) {
    return this.compras.previsualizar(s, 'PP1:' + d.codigo);
  }

  @Post('compras')
  registrar(@SesionActual() s: Sesion, @Body(new ZodPipe(CompraSchema)) d: z.infer<typeof CompraSchema>) {
    return this.compras.registrar(s, d);
  }

  @Get('compras/recientes')
  recientes(@SesionActual() s: Sesion) {
    return this.compras.ultimasDelLocal(s.localId!);
  }

  /** HU-L06: compras, puntos emitidos y canjes por fecha. */
  @Get('movimientos')
  movimientos(@SesionActual() s: Sesion, @Query('desde') desde?: string, @Query('hasta') hasta?: string, @Query('empleado') empleadoId?: string) {
    return this.compras.movimientosLocal(s.localId!, { desde, hasta, empleadoId: empleadoId || undefined });
  }

  @Get('movimientos.csv')
  async csv(@SesionActual() s: Sesion, @Res() res: Response, @Query('desde') desde?: string, @Query('hasta') hasta?: string, @Query('empleado') empleadoId?: string) {
    const csv = await this.compras.movimientosCsv(s.localId!, { desde, hasta, empleadoId: empleadoId || undefined });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="movimientos-${desde ?? 'hoy'}.csv"`);
    res.end('﻿' + csv);
  }
}

@Roles('cliente')
@Controller('cliente')
export class ClienteFacturaController {
  constructor(private readonly compras: ComprasService) {}

  /** HU-C16: el cliente escanea el QR de su factura SIAT. */
  @Post('facturas')
  factura(@SesionActual() s: Sesion, @Body(new ZodPipe(FacturaSchema)) d: z.infer<typeof FacturaSchema>) {
    return this.compras.registrarFactura(s.recintoId, s.sub, d.contenido, d.montoBs, d.fecha);
  }
}
