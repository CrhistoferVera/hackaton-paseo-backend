import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pwd: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Rol = 'cliente' | 'comercio' | 'admin' | 'marketing' | 'analista';
export const ROLES_INTERNOS: Rol[] = ['admin', 'marketing', 'analista'];
export const ROLES_LOCAL: Rol[] = ['comercio'];

export interface Sesion {
  sub: string;
  rol: Rol;
  recintoId: string;
  nombre: string;
  localId?: string;
  exp: number;
}

function secreto(): string {
  return process.env.JWT_SECRET ?? 'paseo-points-dev-secret-cambiar-en-produccion';
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT HS256 firmado con el secreto del servidor. */
export function firmarJwt(payload: Omit<Sesion, 'exp'>, segundos: number): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + segundos }));
  const firma = createHmac('sha256', secreto()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${firma}`;
}

export function verificarJwt(token: string): Sesion | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [header, body, firma] = partes;
  const esperada = createHmac('sha256', secreto()).update(`${header}.${body}`).digest();
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Sesion;
    if (s.exp < Math.floor(Date.now() / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}

export async function hashPassword(pwd: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pwd, salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export async function verificarPassword(pwd: string, guardado: string | null): Promise<boolean> {
  if (!guardado) return false;
  const [, saltHex, hashHex] = guardado.split('$');
  const h = await scrypt(pwd, Buffer.from(saltHex, 'hex'), 32);
  const esperado = Buffer.from(hashHex, 'hex');
  return esperado.length === h.length && timingSafeEqual(esperado, h);
}

/** Firma corta para códigos de un solo uso (cupones, retiros). */
export function firmaCorta(valor: string): string {
  return createHmac('sha256', secreto()).update(valor).digest('base64url').slice(0, 10);
}
