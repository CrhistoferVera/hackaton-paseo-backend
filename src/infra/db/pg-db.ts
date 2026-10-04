import pg from 'pg';

import { Db, Queryable, QueryResult, contextoTx } from './db.js';

// numeric y bigint como número de JavaScript (los montos caben con holgura en un double)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** Adaptador para un Postgres real (Neon, Railway, Supabase, local). */
export class PgDb extends Db {
  private readonly pool: pg.Pool;
  private readonly enTx = contextoTx;

  constructor(connectionString: string) {
    super();
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      ssl: /sslmode=require|neon\.tech|supabase\.co|render\.com/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const tx = this.enTx.getStore();
    if (tx) return tx.query<T>(sql, params);
    const r = await this.pool.query(sql, params as any[]);
    return { rows: r.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const actual = this.enTx.getStore();
    if (actual) return fn(actual);
    const client = await this.pool.connect();
    const q: Queryable = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params as any[]);
        return { rows: r.rows as R[] };
      },
    };
    try {
      await client.query('BEGIN');
      const result = await this.enTx.run(q, () => fn(q));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
