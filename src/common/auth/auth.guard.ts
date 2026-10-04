import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { Db, one } from '../../infra/db/db.js';
import { Rol, Sesion, verificarJwt } from './tokens.js';

const PUBLICO = 'publico';
const ROLES = 'roles';
const API_KEY = 'apiKey';

/** Ruta accesible sin sesión. */
export const Publico = () => SetMetadata(PUBLICO, true);
/** Restringe la ruta a los roles indicados. */
export const Roles = (...roles: Rol[]) => SetMetadata(ROLES, roles);
/** Ruta para integraciones (Jarvis, PaseoYa externos) autenticadas con x-api-key. */
export const ConApiKey = () => SetMetadata(API_KEY, true);

export const SesionActual = createParamDecorator((_: unknown, ctx: ExecutionContext): Sesion => {
  return ctx.switchToHttp().getRequest().sesion;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Los mensajes por WebSocket se autentican al conectar (RealtimeGateway) y cada gateway valida la sesión del socket
    if (ctx.getType() === 'ws') return true;
    const objetivo = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLICO, objetivo)) return true;
    const req = ctx.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>(API_KEY, objetivo)) {
      const esperada = Buffer.from(process.env.JARVIS_API_KEY ?? 'jarvis-dev-key');
      const recibida = Buffer.from(String(req.headers['x-api-key'] ?? ''));
      if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
        throw new UnauthorizedException('Clave de integración inválida');
      }
      return true;
    }

    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query?.token ?? '');
    const sesion = token ? verificarJwt(token) : null;
    if (!sesion) throw new UnauthorizedException('Inicia sesión para continuar');
    const usuario = await one<{ recinto_id: string }>(
      this.db,
      `select recinto_id from usuario where id = $1 and estado = 'activo'`,
      [sesion.sub],
    );
    if (!usuario) throw new UnauthorizedException('La sesión ya no es válida. Inicia sesión nuevamente');
    req.sesion = { ...sesion, recintoId: usuario.recinto_id };

    const roles = this.reflector.getAllAndOverride<Rol[]>(ROLES, objetivo);
    if (roles?.length && !roles.includes(sesion.rol)) {
      throw new ForbiddenException('Tu rol no tiene acceso a esta sección');
    }
    return true;
  }
}
