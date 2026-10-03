import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DIR_UPLOADS = resolve(process.env.UPLOADS_DIR ?? 'uploads');
const TIPOS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface ArchivoSubido {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Guarda una imagen subida (fotos de producto, comprobantes) y devuelve su URL pública relativa. */
export function guardarImagen(archivo: ArchivoSubido | undefined): string {
  if (!archivo) throw new BadRequestException('Adjunta una imagen');
  const ext = TIPOS[archivo.mimetype];
  if (!ext) throw new BadRequestException('Formato no admitido: usa JPG, PNG o WebP');
  if (archivo.size > 5 * 1024 * 1024) throw new BadRequestException('La imagen supera 5 MB');
  mkdirSync(DIR_UPLOADS, { recursive: true });
  const nombre = `${randomUUID()}.${ext}`;
  writeFileSync(join(DIR_UPLOADS, nombre), archivo.buffer);
  return `/uploads/${nombre}`;
}
