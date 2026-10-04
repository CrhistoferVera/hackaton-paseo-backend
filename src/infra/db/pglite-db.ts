import { PGlite, types } from '@electric-sql/pglite';

import { mkdirSync } from 'node:fs';
import { Db, Queryable, QueryResult, contextoTx } from './db.js';

/**
 * Postgres embebido (WASM) para desarrollo sin instalar nada.
 * Se usa cuando no hay DATABASE_URL. Los datos viven en ./.data/pgdata.
 */
export class PgliteDb extends Db {
  private readonly pg: PGlite;
  /** PGlite es de una sola conexión: serializamos transacciones y consultas sueltas. */
  private cola: Promise<unknown> = Promise.resolve();
  /** Si una consulta se hace dentro de una transacción en curso, se enruta a esa transacción. */
  private readonly enTx = contextoTx;

  constructor(dir: string) {
    super();
    if (!dir.startsWith('memory://')) {
      mkdirSync(dir, { recursive: true });
    }
    this.pg = new PGlite(dir, {
      parsers: {
        [types.NUMERIC]: (v: string) => Number(v),
        [types.INT8]: (v: string) => Number(v),
      },
    });
  }

  private enCola<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.cola.then(fn, fn);
    this.cola = p.catch(() => undefined);
    return p;
  }

  query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const tx = this.enTx.getStore();
    if (tx) return tx.query<T>(sql, params);
    return this.enCola(async () => {
      const r = await this.pg.query<T>(sql, params as any[]);
      return { rows: r.rows };
    });
  }

  exec(sql: string): Promise<void> {
    return this.enCola(async () => {
      await this.pg.exec(sql);
    });
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const actual = this.enTx.getStore();
    if (actual) return fn(actual); // transacción anidada: se une a la externa
    return this.enCola(() =>
      this.pg.transaction(async (t) => {
        const q: Queryable = {
          query: async <R>(sql: string, params: unknown[] = []) => {
            const r = await t.query<R>(sql, params as any[]);
            return { rows: r.rows };
          },
        };
        return this.enTx.run(q, () => fn(q));
      }),
    );
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
