import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/** Valida y transforma el cuerpo o la consulta con un esquema Zod (contrato de entrada). */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      const detalle = r.error.issues.map((i) => `${i.path.join('.') || 'dato'}: ${i.message}`).join('; ');
      throw new BadRequestException(`Datos inválidos. ${detalle}`);
    }
    return r.data;
  }
}

export const zUuid = z.string().uuid();
export const zFecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'usa el formato AAAA-MM-DD');
export const zHora = z.string().regex(/^\d{2}:\d{2}$/, 'usa el formato HH:MM');
