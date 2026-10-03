import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Publico, Roles, SesionActual } from '../../common/auth/auth.guard.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ZodPipe, zFecha, zUuid } from '../../common/zod.pipe.js';
import { NotificacionesService } from '../nucleo/nucleo.services.js';
import { IdentidadService } from './identidad.service.js';

const RegistroSchema = z.object({
  nombre: z.string().min(2).max(80),
  celular: z.string().regex(/^\d{8}$/, 'el celular boliviano tiene 8 dígitos').optional(),
  correo: z.string().email().optional(),
  password: z.string().min(6, 'mínimo 6 caracteres'),
  fechaNacimiento: zFecha,
  zonaResidencia: z.string().min(2),
  intereses: z.array(z.string()).length(3, 'elige exactamente 3 intereses'),
  genero: z.string().optional(),
  aceptaTerminos: z.boolean(),
  consentUbicacion: z.boolean().default(false),
  consentPersonalizacion: z.boolean().default(false),
  codigoInvitacion: z.string().optional(),
});

const LoginSchema = z.object({ identificador: z.string().min(3), password: z.string().min(1) });
const OtpSolicitudSchema = z.object({ identificador: z.string().min(3) });
const OtpVerificarSchema = z.object({ identificador: z.string().min(3), codigo: z.string().length(6) });
const SegundoFactorSchema = z.object({ desafio: z.string(), codigo: z.string().length(6) });

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: IdentidadService) {}

  @Publico()
  @Post('registro')
  registro(@Body(new ZodPipe(RegistroSchema)) d: z.infer<typeof RegistroSchema>) {
    return this.svc.registrar(d);
  }

  @Publico()
  @Post('login')
  login(@Body(new ZodPipe(LoginSchema)) d: z.infer<typeof LoginSchema>) {
    return this.svc.login(d.identificador, d.password);
  }

  @Publico()
  @Post('2fa')
  segundoFactor(@Body(new ZodPipe(SegundoFactorSchema)) d: z.infer<typeof SegundoFactorSchema>) {
    return this.svc.segundoFactor(d.desafio, d.codigo);
  }

  @Publico()
  @Post('otp/solicitar')
  otp(@Body(new ZodPipe(OtpSolicitudSchema)) d: z.infer<typeof OtpSolicitudSchema>) {
    return this.svc.solicitarOtp(d.identificador);
  }

  @Publico()
  @Post('otp/verificar')
  otpVerificar(@Body(new ZodPipe(OtpVerificarSchema)) d: z.infer<typeof OtpVerificarSchema>) {
    return this.svc.verificarOtp(d.identificador, d.codigo);
  }

  @Get('yo')
  yo(@SesionActual() s: Sesion) {
    return this.svc.yo(s);
  }
}

const PrivacidadSchema = z.object({
  consentUbicacion: z.boolean().optional(),
  consentPersonalizacion: z.boolean().optional(),
  mostrarNombreLocales: z.boolean().optional(),
});
const PerfilSchema = z.object({
  nombre: z.string().min(2).optional(),
  zonaResidencia: z.string().optional(),
  intereses: z.array(z.string()).length(3).optional(),
});

@Roles('cliente')
@Controller('cliente')
export class ClienteCuentaController {
  constructor(
    private readonly svc: IdentidadService,
    private readonly notif: NotificacionesService,
  ) {}

  @Get('pase')
  pase(@SesionActual() s: Sesion) {
    return this.svc.pase(s.sub);
  }

  @Post('pase/rotar')
  rotar(@SesionActual() s: Sesion) {
    return this.svc.rotarPase(s.sub);
  }

  @Get('privacidad')
  privacidad(@SesionActual() s: Sesion) {
    return this.svc.privacidad(s.sub);
  }

  @Put('privacidad')
  actualizarPrivacidad(@SesionActual() s: Sesion, @Body(new ZodPipe(PrivacidadSchema)) d: z.infer<typeof PrivacidadSchema>) {
    return this.svc.actualizarPrivacidad(s.sub, s.recintoId, d);
  }

  @Patch('perfil')
  perfil(@SesionActual() s: Sesion, @Body(new ZodPipe(PerfilSchema)) d: z.infer<typeof PerfilSchema>) {
    return this.svc.actualizarPerfil(s.sub, d);
  }

  @Delete('cuenta')
  eliminar(@SesionActual() s: Sesion) {
    return this.svc.eliminarCuenta(s.sub);
  }

  @Get('notificaciones')
  notificaciones(@SesionActual() s: Sesion) {
    return this.notif.listar(s.sub);
  }

  @Post('notificaciones/leidas')
  leidas(@SesionActual() s: Sesion) {
    return this.notif.marcarLeidas(s.sub);
  }
}

const UsuarioInternoSchema = z.object({
  nombre: z.string().min(2),
  correo: z.string().email(),
  celular: z.string().optional(),
  password: z.string().min(8, 'mínimo 8 caracteres'),
  rol: z.enum(['comercio', 'admin', 'marketing', 'analista']),
  localId: zUuid.optional(),
  etiqueta: z.string().optional(),
});

@Roles('admin')
@Controller('admin/usuarios')
export class AdminUsuariosController {
  constructor(private readonly svc: IdentidadService) {}

  @Get()
  listar(@SesionActual() s: Sesion, @Query('rol') rol?: string, @Query('q') q?: string) {
    return this.svc.listarUsuarios(s.recintoId, { rol, q });
  }

  @Post()
  crear(@SesionActual() s: Sesion, @Body(new ZodPipe(UsuarioInternoSchema)) d: z.infer<typeof UsuarioInternoSchema>) {
    return this.svc.crearUsuarioInterno(s, d);
  }

  @Post(':id/bloquear')
  bloquear(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.cambiarEstado(s, id, 'bloqueado');
  }

  @Post(':id/desbloquear')
  desbloquear(@SesionActual() s: Sesion, @Param('id') id: string) {
    return this.svc.cambiarEstado(s, id, 'activo');
  }
}

/** Notificaciones para empleados y administradores. */
@Controller('notificaciones')
export class NotificacionesController {
  constructor(private readonly notif: NotificacionesService) {}

  @Get()
  listar(@SesionActual() s: Sesion) {
    return this.notif.listar(s.sub);
  }
}
