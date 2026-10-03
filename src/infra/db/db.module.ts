import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { resolve } from 'node:path';
import { Db } from './db.js';
import { PgDb } from './pg-db.js';
import { PgliteDb } from './pglite-db.js';
import { MIGRACIONES } from './migraciones.js';

export async function migrar(db: Db, log: (m: string) => void = () => undefined): Promise<void> {
  await db.exec(`create table if not exists _migracion (id text primary key, aplicada_en timestamptz not null default now())`);
  const aplicadas = new Set((await db.query<{ id: string }>('select id from _migracion')).rows.map((r) => r.id));
  for (const m of MIGRACIONES) {
    if (aplicadas.has(m.id)) continue;
    await db.exec(m.sql);
    await db.query('insert into _migracion (id) values ($1)', [m.id]);
    log(`migración aplicada: ${m.id}`);
  }
}

export function crearDb(): Db {
  const url = process.env.DATABASE_URL;
  if (url) return new PgDb(url);
  return new PgliteDb(resolve(process.env.PGLITE_DIR ?? '.data/pgdata'));
}

@Global()
@Module({
  providers: [
    {
      provide: Db,
      useFactory: async () => {
        const log = new Logger('Db');
        const db = crearDb();
        log.log(process.env.DATABASE_URL ? 'Conectado a Postgres (DATABASE_URL)' : 'Usando PGlite embebido en .data/pgdata');
        await migrar(db, (m) => log.log(m));
        return db;
      },
    },
  ],
  exports: [Db],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(Db) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.close();
  }
}
