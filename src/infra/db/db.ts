/**
 * Puerto de acceso a datos. Los repositorios dependen de esta abstracción,
 * nunca de un driver concreto (pg o PGlite).
 */
export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export abstract class Db implements Queryable {
  abstract query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Ejecuta varias sentencias SQL sin parámetros (migraciones). */
  abstract exec(sql: string): Promise<void>;
  /** Unidad de trabajo: todo lo que se haga con `q` se confirma o se revierte junto. */
  abstract tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;
}

/** Devuelve la primera fila o undefined. */
export async function one<T = any>(q: Queryable, sql: string, params?: unknown[]): Promise<T | undefined> {
  const r = await q.query<T>(sql, params);
  return r.rows[0];
}

export async function many<T = any>(q: Queryable, sql: string, params?: unknown[]): Promise<T[]> {
  const r = await q.query<T>(sql, params);
  return r.rows;
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Transacción en curso del contexto asíncrono actual. Los adaptadores enrutan ahí las consultas
 * hechas con `db` dentro de `db.tx(...)`. Los trabajos diferidos (eventos de dominio) deben salir
 * de este contexto con `fueraDeTransaccion` para no usar una transacción ya terminada.
 */
export const contextoTx = new AsyncLocalStorage<Queryable>();

export function fueraDeTransaccion<T>(fn: () => T): T {
  return contextoTx.exit(fn);
}
