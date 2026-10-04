import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { migrar } from '../src/infra/db/db.module.js';
import { Db, many, one } from '../src/infra/db/db.js';
import { MIGRACIONES } from '../src/infra/db/migraciones.js';
import { PgliteDb } from '../src/infra/db/pglite-db.js';

describe('Migraciones (datos reales estructura)', () => {
  let db: Db;

  beforeAll(() => {
    db = new PgliteDb('memory://');
  });

  afterAll(async () => {
    await db.close();
  });

  it('La cadena completa migra', async () => {
    await migrar(db, () => {});
    const r = await many(db, "select id from _migracion");
    expect(r.length).toBeGreaterThan(0);
  });

  it('migrar dos veces no falla', async () => {
    await migrar(db, () => {});
    expect(true).toBe(true);
  });

  it('Se puede insertar un local con piso N3 y con sector, coordenadas y horario en NULL', async () => {
    const recinto = await one(db, "insert into recinto (nombre, lat, lng) values ('R_TEST', 0, 0) returning id");
    const cat = await one(db, "insert into categoria (nombre, ambito) values ('C_TEST', 'tiendas') returning id");
    const loc = await one(db, `
      insert into local (recinto_id, nombre, categoria_id, piso, descripcion, palabras_clave, codigo_puerta)
      values ($1, 'Local Test', $2, 'N3', '', '{}', 'TEST-01') returning *
    `, [recinto!.id, cat!.id]);
    expect(loc!.piso).toBe('N3');
    expect(loc!.sector).toBeNull();
    expect(loc!.coord_x).toBeNull();
    expect(loc!.horario_apertura).toBeNull();
  });

  it('Los CHECK de piso ya no existen; el de tipo acepta escalera_mecanica', async () => {
    const rec = await one(db, "select id from recinto limit 1");
    const n = await one(db, `
      insert into nodo_ubicacion (id, recinto_id, piso, tipo, nombre, x, y)
      values ('N-TEST-1', $1, 'N3', 'escalera_mecanica', 'EM', null, null) returning *
    `, [rec!.id]);
    expect(n!.tipo).toBe('escalera_mecanica');
    
    const a = await one(db, `
      insert into arista_ubicacion (desde, hasta, metros, tipo, estimado)
      values ('N-TEST-1', 'N-TEST-1', 10, 'escalera_mecanica', true) returning *
    `);
    expect(a!.tipo).toBe('escalera_mecanica');
    expect(a!.estimado).toBe(true);
  });
});

describe('Migración de datos previos', () => {
  it('Simula una BD con una fila previa y aplica la migración nueva sobre ella', async () => {
    const tempDb = new PgliteDb('memory://');
    
    await tempDb.query("create table if not exists _migracion (id text primary key, aplicada_en timestamptz not null default now())");
    
    // Aplicamos hasta la migración 011
    for (const m of MIGRACIONES) {
      if (m.id === '012_datos_reales_estructura') break;
      await tempDb.exec(m.sql);
      await tempDb.query("insert into _migracion (id) values ($1)", [m.id]);
    }

    // Insertamos un local en la versión vieja
    const rec = await one(tempDb, "insert into recinto (nombre, lat, lng) values ('R2', 0, 0) returning id");
    const cat = await one(tempDb, "insert into categoria (nombre, ambito) values ('C2', 'tiendas') returning id");
    
    await tempDb.query(`
      insert into local (recinto_id, nombre, categoria_id, piso, sector, numero_local, coord_x, coord_y, descripcion, palabras_clave, codigo_puerta)
      values ($1, 'Local Viejo', $2, 'N1', 'A', '1', 0, 0, '', '{}', 'OLD-1')
    `, [rec!.id, cat!.id]);

    // Aplicamos la migración nueva (como lo haría el módulo db.module.ts)
    await migrar(tempDb, () => {});

    // Verificamos que se puede leer y que los datos viejos persisten
    const local = await one(tempDb, "select nombre, piso, coord_origen from local where codigo_puerta = 'OLD-1'");
    expect(local!.nombre).toBe('Local Viejo');
    expect(local!.piso).toBe('N1');
    expect(local!.coord_origen).toBeNull(); // la nueva columna se llenó de null
    
    await tempDb.close();
  });
});
