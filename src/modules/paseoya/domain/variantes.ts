import { BadRequestException } from '@nestjs/common';

export interface GrupoVariante {
  id?: string;
  titulo: string;
  opciones: { id?: string; nombre: string; stock: number; precioBs?: number | null; fotoUrl?: string | null; activo?: boolean }[];
}

/** Tres días calendario inclusivos, siempre en la zona del centro comercial. */
export function fechaRetail(fecha: string | undefined, ahora = new Date()): string {
  const hoy = new Date(ahora.getTime() - 4 * 3600_000).toISOString().slice(0, 10);
  const limite = new Date(Date.parse(hoy) + 2 * 86400_000).toISOString().slice(0, 10);
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(Date.parse(fecha)) || new Date(fecha).toISOString().slice(0, 10) !== fecha || fecha < hoy || fecha > limite) {
    throw new BadRequestException('La fecha estimada de llegada debe ser hoy, mañana o pasado mañana');
  }
  return fecha;
}

/** Cada precio de opción sustituye al base: las diferencias se suman por dimensión. */
export function precioVariantes(base: number, opciones: { precio_bs: number | string | null }[]): number {
  return Math.round((base + opciones.reduce((s, v) => s + (v.precio_bs == null ? 0 : Number(v.precio_bs) - base), 0)) * 100) / 100;
}
