import { PGlite } from '@electric-sql/pglite';
import { MIGRACIONES } from './src/infra/db/migraciones.js';

async function main() {
  const db = new PGlite();
  
  // Ejecutar migraciones
  for (const m of MIGRACIONES) {
    try {
      await db.exec(m.sql);
    } catch(e) {
      console.log('Error en ' + m.id + ': ' + e.message);
    }
  }

  const tablas = ['local', 'zona', 'servicio_paseo', 'categoria', 'producto', 'nodo_ubicacion', 'arista_ubicacion', 'posicion_cliente'];
  
  for (const t of tablas) {
    console.log(`\n--- Tabla: ${t} ---`);
    const cols = await db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${t}'`);
    console.log('Columnas:', cols.rows);
    
    const cons = await db.query(`
      SELECT conname, pg_get_constraintdef(c.oid)
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = '${t}'
    `);
    console.log('Constraints:', cons.rows);
  }
  
  console.log('\n--- Migraciones ---');
  console.log(MIGRACIONES.map(m => m.id).join('\n'));
}

main().catch(console.error);
