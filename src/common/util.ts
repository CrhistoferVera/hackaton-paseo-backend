import { createHmac, randomBytes, randomInt } from 'node:crypto';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código legible sin caracteres ambiguos (0/O, 1/I). */
export function codigoLegible(largo = 8): string {
  let s = '';
  for (let i = 0; i < largo; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

export function pinNumerico(digitos = 4): string {
  return String(randomInt(10 ** digitos)).padStart(digitos, '0');
}

export function secretoAleatorio(): string {
  return randomBytes(20).toString('hex');
}

/**
 * TOTP (RFC 6238) con HMAC-SHA1, paso de 60 s y 6 dígitos.
 * La app del cliente calcula el mismo valor sin conexión con el secreto del pase.
 */
export function totp(secretoHex: string, epochMs: number, paso = 60): string {
  const contador = Math.floor(epochMs / 1000 / paso);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(contador / 2 ** 32), 0);
  buf.writeUInt32BE(contador >>> 0, 4);
  const h = createHmac('sha1', Buffer.from(secretoHex, 'hex')).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Verifica un TOTP aceptando ±`ventana` pasos alrededor del instante de captura. */
export function totpValido(secretoHex: string, codigo: string, epochMs: number, ventana = 1): boolean {
  for (let d = -ventana; d <= ventana; d++) {
    if (totp(secretoHex, epochMs + d * 60_000) === codigo) return true;
  }
  return false;
}

/** Fecha/hora en Bolivia (UTC-4) para reglas por horario. */
export function ahoraBolivia(d = new Date()): { dia: number; hhmm: string; fecha: string } {
  const bo = new Date(d.getTime() - 4 * 3600_000);
  const hh = String(bo.getUTCHours()).padStart(2, '0');
  const mm = String(bo.getUTCMinutes()).padStart(2, '0');
  return { dia: bo.getUTCDay(), hhmm: `${hh}:${mm}`, fecha: bo.toISOString().slice(0, 10) };
}

export function enRangoHorario(hhmm: string, desde: string, hasta: string): boolean {
  const a = desde.slice(0, 5);
  const b = hasta.slice(0, 5);
  return a <= b ? hhmm >= a && hhmm <= b : hhmm >= a || hhmm <= b;
}

export function aCsv(filas: Record<string, unknown>[]): string {
  if (!filas.length) return '';
  const cols = Object.keys(filas[0]);
  const esc = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...filas.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n');
}

export function redondear(n: number, dec = 2): number {
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}

/** Distancia en metros entre dos coordenadas (haversine). */
export function distanciaM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
