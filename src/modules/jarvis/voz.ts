import { conArticulo } from '../orientacion/domain/grafo.js';

/** Formatos para escuchar, no para leer: «30 bolivianos», «8 de agosto», «del patio de comidas». */
export const dinero = (n: number | string) => {
  const v = Number(n);
  return Number.isInteger(v) ? `${v} bolivianos` : `${v.toFixed(2).replace('.', ',')} bolivianos`;
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** «12 de septiembre» (con el año si no es el actual). Acepta «2027-09-12» o una fecha. */
export const fechaVoz = (f: string | Date) => {
  const iso = f instanceof Date ? new Date(f.getTime() - 4 * 3600_000).toISOString() : String(f);
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} de ${MESES[m - 1]}${a !== new Date().getFullYear() ? ` de ${a}` : ''}`;
};

/** «el patio de comidas» */
export const lugar = (nombre: string) => conArticulo(nombre);
/** «del patio de comidas», «de la terraza» */
export const de = (conArt: string) => `de ${conArt}`.replace(/^de el /, 'del ');

/** «09:30» → «las 9:30 de la mañana»; «13:00» → «la 1 de la tarde»; «12:00» → «el mediodía». */
export function horaVoz(hhmm: string) {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  if (h === 12 && m === 0) return 'el mediodía';
  if (h === 0 && m === 0) return 'la medianoche';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const franja = h < 12 ? 'de la mañana' : h < 19 ? 'de la tarde' : 'de la noche';
  return `${h12 === 1 ? 'la' : 'las'} ${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${franja}`;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Hora boliviana (UTC-4) de un instante, como «HH:MM». */
export function hhmmBo(d: Date | string) {
  const bo = new Date(new Date(d).getTime() - 4 * 3600_000);
  return `${String(bo.getUTCHours()).padStart(2, '0')}:${String(bo.getUTCMinutes()).padStart(2, '0')}`;
}

/** «hoy», «mañana», «el sábado 11 de octubre». */
export function diaVoz(d: Date | string) {
  const bo = new Date(new Date(d).getTime() - 4 * 3600_000);
  const hoy = new Date(Date.now() - 4 * 3600_000);
  const dias = Math.round((Date.UTC(bo.getUTCFullYear(), bo.getUTCMonth(), bo.getUTCDate()) - Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate())) / 86400_000);
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'mañana';
  if (dias === -1) return 'ayer';
  return `el ${DIAS[bo.getUTCDay()]} ${bo.getUTCDate()} de ${MESES[bo.getUTCMonth()]}`;
}

/** «2 horas y 15 minutos», «40 minutos». */
export function duracionVoz(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} minutos`;
  return `${h} ${h === 1 ? 'hora' : 'horas'}${m ? ` y ${m} minutos` : ''}`;
}

/** Une con comas y «y» final: «A, B y C». */
export function lista(xs: string[]) {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}
