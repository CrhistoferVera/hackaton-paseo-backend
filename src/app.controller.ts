import { Controller, Get } from '@nestjs/common';
import { Publico } from './common/auth/auth.guard.js';
import { Db } from './infra/db/db.js';

@Controller()
export class AppController {
  constructor(private readonly db: Db) {}

  @Publico()
  @Get()
  salud() {
    return { servicio: 'Paseo Points API', estado: 'ok', base: process.env.DATABASE_URL ? 'postgres' : 'pglite' };
  }

  @Publico()
  @Get('salud/db')
  async saludDb() {
    const r = await this.db.query<{ ahora: string }>('select now() as ahora');
    return { ok: true, ahora: r.rows[0].ahora };
  }
}
