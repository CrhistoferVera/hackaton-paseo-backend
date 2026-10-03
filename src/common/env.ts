import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Carga variables de un archivo .env (si existe) sin sobrescribir las ya definidas. */
export function cargarEnv(archivo = '.env') {
  const ruta = resolve(archivo);
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m || linea.trim().startsWith('#')) continue;
    const valor = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
  }
}
