/**
 * Generador de datos sintéticos (≈4 meses) para probar el sistema y a Jarvis con datos realistas:
 * los locales del CSV con horarios, teléfonos y productos generados (con tiempos de preparación), una cuenta de
 * comercio por local, servicios del Paseo (baños, cajeros automáticos, lactancia…), eventos que se
 * repiten durante dos meses, promociones a toda hora, misiones, Drops activos y pasados, solicitudes
 * de Drop, clientes con perfiles distintos, visitas, compras, canjes, PaseoYa, parqueo, información
 * general del Paseo para Jarvis, búsquedas sin resultado y casos de fraude plantados.
 *
 * Uso:  npm run seed            (solo si la base está vacía)
 *       npm run seed -- --reset (borra las tablas del sistema y vuelve a generar)
 */
import '../cargar-env.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Db, Queryable } from '../infra/db/db.js';
import { crearDb, migrar } from '../infra/db/db.module.js';
import { TABLAS_PROPIAS } from '../infra/db/migraciones.js';
import { DIR_UPLOADS } from '../common/archivos.js';
import { firmaCorta, hashPassword } from '../common/auth/tokens.js';
import { codigoLegible, pinNumerico, secretoAleatorio } from '../common/util.js';
import {
  APELLIDOS, BUSQUEDAS_SIN_RESULTADO, EVENTOS_ESPECIALES, EVENTOS_RECURRENTES, INFO_PASEO, NOMBRES, SERVICIOS, ZONAS, ZONAS_RESIDENCIA,
} from './catalogo.js';
import { LOCALES_CSV } from './locales-csv.js';

// ---------------------------------------------------------------- utilidades deterministas
let semilla = 20261003;
const rnd = () => {
  semilla = (semilla * 1664525 + 1013904223) % 4294967296;
  return semilla / 4294967296;
};
const entre = (a: number, b: number) => a + rnd() * (b - a);
const entero = (a: number, b: number) => Math.floor(entre(a, b + 1));
const elegir = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const prob = (p: number) => rnd() < p;
const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PISO_CSV: Record<(typeof LOCALES_CSV)[number]['piso'], 'T' | 'N1' | 'N2' | 'N3' | 'N4'> = {
  'Planta baja': 'T',
  '1': 'N1',
  '2': 'N2',
  '3': 'N3',
  '4': 'N4',
};
const CATEGORIAS_COMIDA = new Set(['comida', 'bar', 'restobar']);

function grupoCategoria(categoria: string) {
  const n = categoria.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (CATEGORIAS_COMIDA.has(n)) return 'Comida';
  if (n === 'moda') return 'Moda';
  if (n === 'tecnologia') return 'Tecnología';
  if (n === 'jugueteria') return 'Regalos';
  if (n === 'entretenimiento') return 'Entretenimiento';
  if (n === 'perfumeria' || n === 'cosmeticos') return 'Accesorios';
  return 'Servicios';
}

function fotosLocales(nombreLocal: string): string[] {
  const raiz = join(DIR_UPLOADS, 'locales');
  if (!existsSync(raiz)) return [];
  const slugLocal = slug(nombreLocal);
  const validas = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const archivos: string[] = [];
  for (const entrada of readdirSync(raiz, { withFileTypes: true })) {
    const extension = entrada.name.slice(entrada.name.lastIndexOf('.')).toLowerCase();
    if (entrada.isFile() && slug(entrada.name.slice(0, -extension.length)) === slugLocal && validas.has(extension)) {
      archivos.push(join(raiz, entrada.name));
    } else if (entrada.isDirectory() && slug(entrada.name) === slugLocal) {
      for (const foto of readdirSync(join(raiz, entrada.name), { withFileTypes: true })) {
        const ext = foto.name.slice(foto.name.lastIndexOf('.')).toLowerCase();
        if (foto.isFile() && validas.has(ext)) archivos.push(join(raiz, entrada.name, foto.name));
      }
    }
  }
  return archivos.sort((a, b) => a.localeCompare(b)).map((archivo) =>
    `/uploads/${relative(DIR_UPLOADS, archivo).split(sep).map(encodeURIComponent).join('/')}`,
  );
}
const MS_HORA = 3600_000;
const MS_DIA = 86400_000;
const DIAS = Number(process.env.SEED_DIAS ?? 120);
const ahora = new Date();
/** Fecha y hora boliviana (UTC-4) → instante UTC. diaOffset > 0 = días atrás; < 0 = días adelante. */
function instante(diaOffset: number, horaDecimal: number): Date {
  const hoyBo = new Date(ahora.getTime() - 4 * MS_HORA);
  const base = Date.UTC(hoyBo.getUTCFullYear(), hoyBo.getUTCMonth(), hoyBo.getUTCDate());
  return new Date(base - diaOffset * MS_DIA + horaDecimal * MS_HORA + 4 * MS_HORA);
}
function diaSemanaBo(diaOffset: number) {
  return new Date(instante(diaOffset, 12).getTime() - 4 * MS_HORA).getUTCDay();
}
const horaDecimal = (hhmm: string) => Number(hhmm.slice(0, 2)) + Number(hhmm.slice(3, 5)) / 60;
/** Fecha boliviana (UTC-4) de un instante, como «AAAA-MM-DD». */
const fechaBo = (d: Date) => new Date(d.getTime() - 4 * MS_HORA).toISOString().slice(0, 10);
const horaAhoraBo = () => {
  const bo = new Date(ahora.getTime() - 4 * MS_HORA);
  return bo.getUTCHours() + bo.getUTCMinutes() / 60;
};

async function insertarLote(q: Queryable, tabla: string, columnas: string[], filas: unknown[][]) {
  const porLote = Math.max(1, Math.floor(30000 / columnas.length));
  for (let i = 0; i < filas.length; i += porLote) {
    const lote = filas.slice(i, i + porLote);
    const valores: unknown[] = [];
    const tuplas = lote.map((f, r) => `(${f.map((v, c) => {
      valores.push(v);
      return `$${r * columnas.length + c + 1}`;
    }).join(',')})`);
    await q.query(`insert into ${tabla} (${columnas.join(',')}) values ${tuplas.join(',')}`, valores);
  }
}

// ---------------------------------------------------------------- perfiles de cliente
type Perfil = 'oficinista' | 'familia' | 'joven' | 'ocasional' | 'dormido';
const PERFILES: { tipo: Perfil; peso: number; categorias: string[]; horas: [number, number]; pDia: (dow: number, diaOffset: number) => number }[] = [
  { tipo: 'oficinista', peso: 0.25, categorias: ['Comida', 'Comida', 'Comida', 'Servicios', 'Tecnología'], horas: [12, 14.5], pDia: (d) => (d >= 1 && d <= 5 ? 0.22 : 0.02) },
  { tipo: 'familia', peso: 0.25, categorias: ['Comida', 'Moda', 'Regalos', 'Entretenimiento', 'Hogar', 'Comida'], horas: [11, 19.5], pDia: (d) => (d === 0 || d === 6 ? 0.3 : 0.025) },
  { tipo: 'joven', peso: 0.2, categorias: ['Entretenimiento', 'Tecnología', 'Comida', 'Moda', 'Accesorios'], horas: [16, 21.5], pDia: (d) => (d === 5 || d === 6 ? 0.18 : 0.09) },
  { tipo: 'ocasional', peso: 0.2, categorias: ['Comida', 'Moda', 'Tecnología', 'Accesorios', 'Hogar', 'Servicios', 'Regalos'], horas: [10.5, 21], pDia: () => 0.035 },
  { tipo: 'dormido', peso: 0.1, categorias: ['Comida', 'Moda', 'Tecnología'], horas: [11, 20], pDia: (_d, off) => (off > 60 ? 0.12 : 0.004) },
];
function elegirPerfil() {
  let r = rnd();
  for (const p of PERFILES) {
    if ((r -= p.peso) <= 0) return p;
  }
  return PERFILES[0];
}

async function main() {
  const reset = process.argv.includes('--reset');
  const db: Db = crearDb();
  console.log(process.env.DATABASE_URL ? `Base: Postgres (${process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')})` : 'Base: PGlite embebido (.data/pgdata)');
  if (reset) {
    console.log('Borrando datos anteriores…');
    // Solo las tablas del sistema: la base puede compartirse con otras aplicaciones
    await db.exec(`drop schema if exists oro cascade; drop table if exists ${TABLAS_PROPIAS.join(', ')} cascade; drop function if exists bo(timestamptz);`);
  }
  await migrar(db, (m) => console.log(m));
  const ya = await db.query('select id from recinto limit 1');
  if (ya.rows.length) {
    console.log('La base ya tiene datos. Usa  npm run seed -- --reset  para regenerarla.');
    await db.close();
    return;
  }
  const t0 = Date.now();
  console.log('Generando Paseo Aranjuez sintético…');

  const lat = Number(process.env.RECINTO_LAT ?? -16.5378);
  const lng = Number(process.env.RECINTO_LNG ?? -68.0786);
  const recintoId = randomUUID();
  const hashes = {
    admin: await hashPassword('Admin2026!'),
    marketing: await hashPassword('Marketing2026!'),
    analista: await hashPassword('Analista2026!'),
    comercio: await hashPassword('Comercio2026!'),
    cliente: await hashPassword('Cliente2026!'),
    maria: await hashPassword('Maria2026!'),
  };

  let mariaId = '';
  await db.tx(async (q) => {
    await q.query('insert into recinto (id, nombre, lat, lng, radio_m) values ($1,$2,$3,$4,$5)', [recintoId, 'Paseo Aranjuez', lat, lng, 300]);

    // -------------------------------------------------------------- catálogo físico
    const categorias = [...new Set(LOCALES_CSV.map((l) => l.categoria))].map((nombre, orden) => ({
      nombre,
      ambito: CATEGORIAS_COMIDA.has(nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()) ? 'comida' : 'tiendas',
      orden: orden + 1,
    }));
    const catId = new Map<string, string>();
    for (const c of categorias) {
      const id = randomUUID();
      catId.set(c.nombre, id);
      await q.query('insert into categoria (id, nombre, ambito, orden) values ($1,$2,$3,$4)', [id, c.nombre, c.ambito, c.orden]);
    }
    const zonaId = new Map<string, string>();
    for (const z of ZONAS) {
      const id = randomUUID();
      zonaId.set(`${z.piso}-${z.sector}`, id);
      await q.query('insert into zona (id, recinto_id, piso, sector, nombre, x, y, ancho, alto) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        id, recintoId, z.piso, z.sector, z.nombre, z.x, z.y, z.ancho, z.alto,
      ]);
    }
    const ocupacionPiso = new Map<string, number>();
    const locales = LOCALES_CSV.map((csv, i) => {
      const piso = PISO_CSV[csv.piso];
      const posicion = ocupacionPiso.get(piso) ?? 0;
      ocupacionPiso.set(piso, posicion + 1);
      const sectorIdx = posicion % 3;
      const sector = ['A', 'B', 'C'][sectorIdx];
      const categoria = csv.categoria;
      const categoriaNormalizada = categoria.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const ambito = CATEGORIAS_COMIDA.has(categoriaNormalizada) ? 'comida' : 'tiendas';
      const grupo = grupoCategoria(categoria);
      const palabras = `${csv.nombre} ${categoria} ${csv.descripcion}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const fotos = fotosLocales(csv.nombre);
      const numeroPiso = piso === 'T' ? 'PB' : piso.slice(1);
      const numero = `${numeroPiso}-${String(posicion + 1).padStart(2, '0')}`;
      const inicioX = [40, 373, 707][sectorIdx];
      const altoTicket: [number, number] = categoriaNormalizada === 'finanzas' ? [5, 100] : ambito === 'comida' ? [18, 180] : grupo === 'Entretenimiento' ? [20, 250] : [30, 1200];
      return {
        id: randomUUID(),
        nombre: csv.nombre,
        categoria,
        grupo,
        ambito,
        piso,
        sector,
        numero,
        x: inicioX + 100,
        y: 45 + Math.floor(posicion / 3) * 95,
        clave: [...new Set(palabras)].filter((p) => p.length > 2),
        ticket: altoTicket,
        descripcion: csv.descripcion,
        horario: ambito === 'comida' ? ['10:00', '23:00'] as [string, string] : ['10:00', '22:00'] as [string, string],
        dias: [0, 1, 2, 3, 4, 5, 6],
        telefono: '',
        fotos,
        fotoUrl: fotos[0] ?? null,
        zona: zonaId.get(`${piso}-${sector}`)!,
        nit: String(1020300000 + i * 17),
        cuenta: '',
      };
    });
    await insertarLote(
      q, 'local',
      ['id', 'recinto_id', 'nombre', 'categoria_id', 'piso', 'sector', 'numero_local', 'coord_x', 'coord_y', 'zona_id', 'descripcion', 'palabras_clave', 'nit', 'codigo_puerta',
        'horario_apertura', 'horario_cierre', 'dias_atencion', 'telefono', 'foto_url', 'fotos'],
      locales.map((l, i) => [l.id, recintoId, l.nombre, catId.get(l.categoria), l.piso, l.sector, l.numero, l.x, l.y, l.zona, l.descripcion, l.clave, l.nit,
        `L-${slug(l.nombre).toUpperCase().slice(0, 6)}-${String(i + 1).padStart(3, '0')}`, l.horario[0], l.horario[1], l.dias, l.telefono || null, l.fotoUrl, l.fotos]),
    );
    const loc = (n: string) => {
      const local = locales.find((l) => l.nombre === n);
      if (!local) throw new Error(`El seeder referencia un local fuera del CSV: ${n}`);
      return local;
    };
    const abiertoEn = (l: (typeof locales)[number], dow: number, h: number) => l.dias.includes(dow) && h >= horaDecimal(l.horario[0]) && h <= horaDecimal(l.horario[1]);

    // -------------------------------------------------------------- personal: administración y una cuenta por comercio
    const usuarios: unknown[][] = [];
    const empleados: unknown[][] = [];
    const internos = [
      ['admin', 'Administración Paseo', 'admin@paseo.bo', hashes.admin],
      ['marketing', 'Marketing Paseo', 'marketing@paseo.bo', hashes.marketing],
      ['analista', 'Analista de datos', 'analista@paseo.bo', hashes.analista],
    ];
    for (const [rol, nombre, correo, h] of internos) usuarios.push([randomUUID(), recintoId, rol, nombre, correo, null, h, instante(DIAS + 5, 9)]);
    for (const l of locales) {
      const id = randomUUID();
      l.cuenta = id;
      usuarios.push([id, recintoId, 'comercio', l.nombre, `comercio.${slug(l.nombre)}@paseo.bo`, null, hashes.comercio, instante(DIAS + 5, 9)]);
      empleados.push([id, l.id, 'comercio', 'Cuenta del comercio']);
    }
    await insertarLote(q, 'usuario', ['id', 'recinto_id', 'rol', 'nombre', 'correo', 'celular', 'hash', 'creado_en'], usuarios);
    await insertarLote(q, 'empleado_local', ['usuario_id', 'local_id', 'rol', 'etiqueta'], empleados);
    const adminId = usuarios[0][0] as string;
    const marketingId = usuarios[1][0] as string;

    // -------------------------------------------------------------- reglas, recompensas, servicios, información del Paseo
    await q.query(
      `insert into regla_puntos (recinto_id, version, vigente, bs_por_punto, valor_punto_bs, multiplicadores_categoria, multiplicadores_horario, dias_vencimiento,
         niveles, bono_bienvenida, puntos_descubrimiento, puntos_visita_diaria, puntos_referido, puntos_hora_parqueo, creado_por)
       values ($1,1,true,1,0.02,$2,$3,365,$4,100,20,10,150,300,$5)`,
      [
        recintoId,
        JSON.stringify({ Entretenimiento: 1.2 }),
        JSON.stringify([{ dias: [1, 2, 3, 4], desde: '15:00', hasta: '17:00', mult: 1.5, etiqueta: 'Tarde tranquila' }]),
        JSON.stringify([
          { nombre: 'Bronce', minimo: 0, beneficios: ['Bono de bienvenida', 'Misiones mensuales'] },
          { nombre: 'Plata', minimo: 1000, beneficios: ['Puntos ×1,1 en tu cumpleaños', 'Preventa de cine'] },
          { nombre: 'Oro', minimo: 2000, beneficios: ['1 hora de parqueo gratis al mes', 'Promociones exclusivas'] },
          { nombre: 'Platinum', minimo: 3000, beneficios: ['Parqueo preferencial', 'Café de cortesía semanal', 'Atención prioritaria'] },
        ]),
        adminId,
      ],
    );
    const localesComidaBase = locales.filter((l) => l.ambito === 'comida');
    const localComida1 = localesComidaBase[0];
    const localComida2 = localesComidaBase[1] ?? localComida1;
    const localModa = locales.find((l) => l.grupo === 'Moda') ?? locales[0];
    const localTecnologia = locales.find((l) => l.grupo === 'Tecnología') ?? locales[1];
    const localBelleza = locales.find((l) => ['Perfumeria', 'Cosmeticos'].includes(l.categoria)) ?? locales[2];
    const localDiversion = locales.find((l) => l.grupo === 'Entretenimiento') ?? locales[3];
    const recompensas: [string, string, number, string | null, number | null, string][] = [
      [`Descuento en ${localComida1.nombre}`, 'Beneficio para disfrutar una especialidad del local.', 250, localComida1.id, null, 'general'],
      [`Especialidad de ${localComida2.nombre}`, 'Canjea puntos por una especialidad gastronómica.', 200, localComida2.id, null, 'general'],
      [`Beneficio de temporada en ${localModa.nombre}`, 'Descuento de temporada en productos seleccionados.', 900, localModa.id, 200, 'general'],
      [`Novedad de ${localTecnologia.nombre}`, 'Descuento en productos seleccionados del local.', 1000, localTecnologia.id, 150, 'general'],
      [`Beneficio de ${localBelleza.nombre}`, 'Canjea puntos en productos seleccionados.', 500, localBelleza.id, 80, 'general'],
      [`Experiencia en ${localDiversion.nombre}`, 'Acceso especial para disfrutar en el Paseo.', 700, localDiversion.id, 100, 'general'],
      ['Pack de bienvenida Paseo Aranjuez', 'Beneficio general para clientes del Paseo.', 1500, null, 40, 'general'],
      ['Una hora de parqueo', 'Se aplica al pagar el parqueo.', 300, null, null, 'parqueo'],
    ];
    const recompensaIds: { id: string; costo: number; local: string | null }[] = [];
    for (const [nombre, desc, costo, localId, stock, tipo] of recompensas) {
      const id = randomUUID();
      recompensaIds.push({ id, costo, local: localId });
      await q.query(`insert into recompensa (id, recinto_id, nombre, descripcion, costo_puntos, local_id, stock, tipo) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        id, recintoId, nombre, desc, costo, localId, stock, tipo,
      ]);
    }
    await insertarLote(q, 'info_paseo', ['recinto_id', 'tema', 'palabras_clave', 'respuesta', 'actualizado_por'], INFO_PASEO.map((i) => [recintoId, i.tema, i.claves, i.respuesta, adminId]));
    const zonaDePunto = (piso: string, x: number, y: number) =>
      ZONAS.find((z) => z.piso === piso && x >= z.x && x <= z.x + z.ancho && y >= z.y && y <= z.y + z.alto);
    await insertarLote(
      q, 'servicio_paseo', ['recinto_id', 'tipo', 'nombre', 'descripcion', 'piso', 'x', 'y', 'zona_id', 'horario', 'palabras_clave'],
      SERVICIOS.map((s) => {
        const z = zonaDePunto(s.piso, s.x, s.y);
        return [recintoId, s.tipo, s.nombre, s.descripcion, s.piso, s.x, s.y, z ? zonaId.get(`${z.piso}-${z.sector}`) : null, s.horario ?? null, s.claves];
      }),
    );

    // -------------------------------------------------------------- productos PaseoYa
    const productos: { id: string; local: string; precio: number; nombre: string; comida: boolean }[] = [];
    const filasProd: unknown[][] = [];
    for (const l of locales) {
      if (l.categoria === 'Finanzas') continue;
      const precios = l.ticket;
      const nombres = l.ambito === 'comida'
        ? [`Especialidad de ${l.nombre}`, `Combo del día de ${l.nombre}`, `Favorito de ${l.nombre}`]
        : [`Novedad de ${l.nombre}`, `Producto destacado de ${l.nombre}`, `Favorito de ${l.nombre}`];
      for (let i = 0; i < nombres.length; i++) {
        const nombre = nombres[i];
        const precio = Math.max(5, Math.round(precios[0] + (precios[1] - precios[0]) * (0.25 + i * 0.3)));
        const stock = entero(12, 80);
        const descripcion = l.descripcion;
        const prep = l.ambito === 'comida' ? [4, 8, 12][i] : null;
        const id = randomUUID();
        productos.push({ id, local: l.id, precio, nombre, comida: l.ambito === 'comida' });
        filasProd.push([id, l.id, nombre, descripcion, precio, stock, catId.get(l.categoria), null, prep ?? null]);
      }
    }
    await insertarLote(q, 'producto', ['id', 'local_id', 'nombre', 'descripcion', 'precio_bs', 'stock', 'categoria_id', 'destacado_hasta', 'tiempo_preparacion_min'], filasProd);
    await q.query('update producto set destacado_hasta = current_date + 14 where id = any($1::uuid[])', [productos.slice(0, 6).map((p) => p.id)]);
    const productoDelLocal = (localId: string, indice = 0) => {
      const lista = productos.filter((p) => p.local === localId);
      if (!lista.length) throw new Error(`El local ${localId} no tiene productos de PaseoYa`);
      return lista[indice % lista.length];
    };

    // -------------------------------------------------------------- promociones (a toda hora hay alguna activa)
    const dia = (n: number) => new Date(ahora.getTime() - 4 * MS_HORA + n * MS_DIA).toISOString().slice(0, 10);
    const T = [0, 1, 2, 3, 4, 5, 6];
    const promos: [string, string | null, string, 'puntos_dobles' | 'cupon', number, string, number[], string, string, number, number, string, string | null][] = [
      [`${localComida1.nombre}: puntos dobles`, localComida1.nombre, '', 'puntos_dobles', 2, 'Puntos dobles en especialidades seleccionadas.', [1, 2, 3, 4], '15:00', '18:00', -40, 30, 'aprobada', null],
      [`Temporada en ${localModa.nombre}`, localModa.nombre, '', 'puntos_dobles', 2, 'Puntos dobles en productos de temporada.', [0, 6], '10:00', '21:30', -25, 30, 'aprobada', null],
      [`Novedades de ${localTecnologia.nombre}`, localTecnologia.nombre, '', 'cupon', 1, 'Beneficio especial en productos seleccionados.', [1, 2, 3, 4, 5], '10:00', '22:00', -40, 30, 'aprobada', null],
      [`Puntos dobles en ${localComida2.nombre}`, localComida2.nombre, '', 'puntos_dobles', 2, 'Puntos dobles en el horario de almuerzo.', T, '11:00', '15:00', -20, 40, 'aprobada', null],
      [`Beneficio de ${localBelleza.nombre}`, localBelleza.nombre, '', 'cupon', 1, 'Descuento para clientes Paseo Points.', T, '10:00', '21:00', -30, 30, 'aprobada', null],
      [`Experiencia en ${localDiversion.nombre}`, localDiversion.nombre, '', 'cupon', 1, 'Beneficio para disfrutar una experiencia del Paseo.', T, '16:00', '22:00', -15, 30, 'aprobada', null],
      ['Paseo de noche ×1,5', null, '', 'puntos_dobles', 1.5, 'Puntos ×1,5 en todo el Paseo después de las 20:00.', T, '20:00', '23:59', -7, 21, 'aprobada', null],
      [`Campaña pendiente de ${localComida1.nombre}`, localComida1.nombre, '', 'cupon', 1, 'Propuesta pendiente de revisión.', T, '10:00', '21:00', 1, 30, 'pendiente', null],
      [`Campaña rechazada de ${localModa.nombre}`, localModa.nombre, '', 'cupon', 1, 'Descuento superior al permitido por el reglamento.', T, '10:00', '21:30', 1, 60, 'rechazada', 'El descuento supera lo permitido por el reglamento del Paseo'],
    ];
    await insertarLote(
      q, 'promocion',
      ['recinto_id', 'local_id', 'titulo', 'tipo', 'multiplicador', 'descripcion', 'dias_semana', 'hora_inicio', 'hora_fin', 'inicio', 'fin', 'estado', 'comentario', 'creado_por', 'revisado_por'],
      promos.map(([titulo, local, , tipo, mult, desc, dias, desde, hasta, ini, fin, estado, comentario]) => [
        recintoId, local ? loc(local).id : null, titulo, tipo, mult, desc, dias, desde, hasta, dia(ini), dia(fin), estado, comentario,
        local ? loc(local).cuenta : marketingId, estado === 'pendiente' ? null : adminId,
      ]),
    );
    const hoy = dia(0);
    const inicioMes = hoy.slice(0, 8) + '01';
    await q.query(
      `insert into mision (recinto_id, nombre, descripcion, plantilla, regla, meta, recompensa_puntos, vigencia_desde, vigencia_hasta) values
       ($1,'Explorador gastronómico','Compra en 3 restaurantes distintos este mes','locales_distintos','{"categoria":"Comida","n":3}',3,300,$2,$3),
       ($1,'Tu primera compra','Haz tu primera compra con Paseo Points','compras_categoria','{"n":1}',1,50,$4,$5),
       ($1,'Tarde de compras','Dos compras entre las 15:00 y las 18:00','franja_horaria','{"desde":"15:00","hasta":"18:00","n":2}',2,120,$2,$3),
       ($1,'Descubre 5 locales','Visita o compra en 5 locales nuevos','primera_visita','{"n":5}',5,250,$4,$5),
       ($1,'Fan de la tecnología','Dos compras en tiendas de tecnología','compras_categoria','{"categoria":"Tecnología","n":2}',2,200,$2,$3),
       ($1,'Moda paceña','Tres compras de moda este mes','compras_categoria','{"categoria":"Moda","n":3}',3,250,$2,$3),
       ($1,'Tu local gastronómico','Compra 3 veces en un local gastronómico','local_especifico',$6,3,150,$2,$3),
       ($1,'Una experiencia del Paseo','Visita 2 veces un local de entretenimiento','local_especifico',$7,2,180,$2,$3)`,
      [recintoId, inicioMes, dia(31), dia(-DIAS), dia(60), JSON.stringify({ localId: localComida1.id, n: 3 }), JSON.stringify({ localId: localDiversion.id, n: 2 })],
    );

    // -------------------------------------------------------------- eventos del Paseo (30 días atrás a 45 adelante)
    const filasActividad: unknown[][] = [];
    for (let off = 30; off >= -45; off--) {
      const dow = diaSemanaBo(off);
      for (const e of EVENTOS_RECURRENTES) {
        if (!e.dias.includes(dow)) continue;
        const lugar = e.local ? `${e.local}, local ${loc(e.local).numero}` : e.zona.startsWith('N1-B') ? 'la plaza central del Nivel 1' : ZONAS.find((z) => `${z.piso}-${z.sector}` === e.zona)!.nombre;
        filasActividad.push([recintoId, e.titulo, e.descripcion, e.tipo, instante(off, e.desde), instante(off, e.hasta), zonaId.get(e.zona), e.local ? loc(e.local).id : null, lugar,
          e.precio ?? null, e.cupos ?? null, e.puntos, 'aprobada', e.local ? loc(e.local).cuenta : marketingId, adminId]);
      }
    }
    for (const e of EVENTOS_ESPECIALES) {
      const lugar = e.local ? `${e.local}, local ${loc(e.local).numero}` : ZONAS.find((z) => `${z.piso}-${z.sector}` === e.zona)!.nombre;
      filasActividad.push([recintoId, e.titulo, e.descripcion, e.tipo, instante(-e.dia, e.desde), instante(-e.dia, e.hasta), zonaId.get(e.zona), e.local ? loc(e.local).id : null, lugar,
        e.precio ?? null, e.cupos ?? null, e.puntos, 'aprobada', e.local ? loc(e.local).cuenta : marketingId, adminId]);
    }
    // Un evento que está pasando ahora mismo (para probar «¿qué hay ahora?») y propuestas de comercios
    filasActividad.push([recintoId, 'Exhibición de autos clásicos', 'Autos de colección de los años 50 a 80; fotos gratis.', 'cultural', new Date(ahora.getTime() - 1.5 * MS_HORA), new Date(ahora.getTime() + 4 * MS_HORA),
      zonaId.get('N1-B'), null, 'la plaza central del Nivel 1', null, null, 30, 'aprobada', marketingId, adminId]);
    filasActividad.push([recintoId, `Actividad gastronómica en ${localComida1.nombre}`, 'Demostración de productos y especialidades del local.', 'taller', instante(-4, 17), instante(-4, 18), zonaId.get(`${localComida1.piso}-${localComida1.sector}`), localComida1.id, `${localComida1.nombre}, local ${localComida1.numero}`,
      null, 20, 0, 'pendiente', localComida1.cuenta, null]);
    filasActividad.push([recintoId, `Presentación de temporada en ${localModa.nombre}`, 'Presentación de novedades para clientes del Paseo.', 'cultural', instante(-9, 18), instante(-9, 20), zonaId.get(`${localModa.piso}-${localModa.sector}`), localModa.id, `${localModa.nombre}, local ${localModa.numero}`,
      null, null, 0, 'pendiente', localModa.cuenta, null]);
    await insertarLote(
      q, 'actividad',
      ['recinto_id', 'titulo', 'descripcion', 'tipo', 'inicio', 'fin', 'zona_id', 'local_id', 'lugar', 'precio_bs', 'cupos', 'puntos', 'estado', 'creado_por', 'revisado_por'],
      filasActividad,
    );

    // -------------------------------------------------------------- clientes y actividad
    const N = Number(process.env.SEED_CLIENTES ?? 2500);
    const filasUsuario: unknown[][] = [];
    const filasPerfil: unknown[][] = [];
    const filasTx: unknown[][] = [];
    const filasMov: unknown[][] = [];
    const filasVisita: unknown[][] = [];
    const filasCheckin: unknown[][] = [];
    const filasEvento: unknown[][] = [];
    const filasCanje: unknown[][] = [];
    const filasBusqueda: unknown[][] = [];
    const filasAlerta: unknown[][] = [];
    const filasParqueo: unknown[][] = [];
    const filasFavorito: unknown[][] = [];
    type Lote = { id: string; restante: number };
    const lotes = new Map<string, Lote[]>();
    const saldo = new Map<string, number>();
    const zonaDeLocal = new Map<string, string>(locales.map((l) => [l.id, l.zona]));

    const mov = (clienteId: string, tipo: string, puntos: number, en: Date, descripcion: string, localId: string | null = null, ref: string | null = null) => {
      const id = randomUUID();
      const venc = puntos > 0 ? new Date(en.getTime() + 365 * MS_DIA) : null;
      filasMov.push([id, recintoId, clienteId, tipo, puntos, puntos > 0 ? puntos : 0, ref, localId, descripcion, venc, 1, en]);
      saldo.set(clienteId, (saldo.get(clienteId) ?? 0) + puntos);
      if (puntos > 0) {
        const l = lotes.get(clienteId) ?? [];
        l.push({ id, restante: puntos });
        lotes.set(clienteId, l);
      } else {
        let pend = -puntos;
        for (const l of lotes.get(clienteId) ?? []) {
          if (pend <= 0) break;
          const u = Math.min(pend, l.restante);
          l.restante -= u;
          pend -= u;
        }
      }
    };
    const evento = (seud: string | null, tipo: string, en: Date, payload: object, localId: string | null = null, zona: string | null = null) => {
      filasEvento.push([recintoId, seud, tipo, JSON.stringify(payload), localId, zona ?? (localId ? zonaDeLocal.get(localId) : null), en]);
    };

    const clientes: { id: string; seud: string; perfil: (typeof PERFILES)[number]; favoritos: typeof locales; registro: number; celular: string }[] = [];
    for (let i = 0; i < N; i++) {
      const perfil = elegirPerfil();
      const esMaria = i === 0;
      const id = randomUUID();
      const seud = randomUUID();
      // Días desde el registro: la mayoría se registró al inicio del período (más historia)
      const regOff = esMaria ? DIAS - 5 : DIAS - 1 - Math.floor(Math.pow(rnd(), 1.8) * (DIAS - 1));
      const nombre = esMaria ? 'María Rojas' : `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`;
      const celular = esMaria ? '70000001' : String(60000000 + ((i * 7919) % 9999999)).padStart(8, '7').slice(0, 8);
      const regEn = instante(regOff, entre(perfil.horas[0], perfil.horas[1]));
      const prefer = perfil.categorias;
      const candidatos = locales.filter((l) => prefer.includes(l.grupo));
      const favoritos = esMaria
        ? [...new Set([localesComidaBase[0], localesComidaBase[1], localModa, localTecnologia, localDiversion])]
        : [...new Set([elegir(candidatos), elegir(candidatos), elegir(candidatos)])];
      clientes.push({ id, seud, perfil, favoritos, registro: regOff, celular });
      if (esMaria) mariaId = id;
      filasUsuario.push([id, recintoId, 'cliente', nombre, esMaria ? 'maria@demo.bo' : null, celular, esMaria ? hashes.maria : hashes.cliente, regEn]);
      const intereses = esMaria ? ['Comida', 'Moda', 'Tecnología'] : [...new Set([...prefer, 'Comida', 'Moda', 'Regalos'])].slice(0, 3);
      const nacimiento = `${entero(perfil.tipo === 'joven' ? 1998 : 1965, perfil.tipo === 'joven' ? 2007 : 1996)}-${String(entero(1, 12)).padStart(2, '0')}-${String(entero(1, 28)).padStart(2, '0')}`;
      filasPerfil.push([
        id, seud, codigoLegible(8), secretoAleatorio(), nacimiento, esMaria ? 'F' : elegir(['F', 'M', null]), esMaria ? 'Calacoto' : elegir(ZONAS_RESIDENCIA), intereses,
        codigoLegible(6), regEn, prob(0.7) || esMaria, prob(0.75) || esMaria, prob(0.4) || esMaria, `Cliente ${codigoLegible(4)}`,
      ]);
      if (esMaria || prob(0.45)) for (const f of favoritos) filasFavorito.push([id, null, f.id, regEn]);
      mov(id, 'bono', 100, regEn, 'Bono de bienvenida');
      evento(seud, 'cliente.registrado', regEn, { perfil: perfil.tipo });
    }
    const maria = clientes[0];

    const visitados = new Map<string, Set<string>>();
    const visitaDia = new Set<string>();
    let compras = 0;
    for (let off = DIAS - 1; off >= 0; off--) {
      const dow = diaSemanaBo(off);
      const limiteHora = off === 0 ? horaAhoraBo() : 24;
      for (const c of clientes) {
        if (off > c.registro) continue;
        let p = c.perfil.pDia(dow, off);
        if (c === maria) p = dow === 0 || dow === 6 ? 0.45 : 0.18;
        if (!prob(p)) continue;
        let hora = entre(c.perfil.horas[0], c.perfil.horas[1]);
        if (hora >= limiteHora - 0.2) {
          if (off !== 0 || limiteHora < 10.5) continue;
          hora = entre(10, Math.max(10.1, limiteHora - 0.1));
        }
        const llegada = instante(off, hora);
        const visitaId = randomUUID();
        const paradas = entero(1, c.perfil.tipo === 'familia' ? 3 : 2);
        let t = llegada.getTime();
        let puntosVisita = 0;
        const claveDia = `${c.id}-${off}`;
        if (!visitaDia.has(claveDia)) {
          visitaDia.add(claveDia);
          puntosVisita = 10;
          mov(c.id, 'visita', 10, llegada, 'Llegaste al Paseo', null, visitaId);
        }
        const puerta = prob(0.25) ? 'Parqueo' : prob(0.5) ? 'Puerta Norte' : 'Puerta Sur';
        evento(c.seud, 'visita.iniciada', llegada, { fuente: 'qr_entrada', puerta });
        // Parqueo: quienes entran por el parqueo dejan un ticket
        if (puerta === 'Parqueo') {
          const min = entero(40, 200);
          const salida = new Date(llegada.getTime() + min * 60_000);
          if (salida < ahora) {
            const horas = Math.ceil(min / 60);
            const gratis = prob(0.15) ? 1 : 0;
            filasParqueo.push([c.id, `T-${codigoLegible(6)}`, llegada, salida, min, gratis, gratis * 300, (horas - gratis) * 6, 'cerrado']);
            if (gratis) mov(c.id, 'parqueo', -300, salida, 'Hora de parqueo con puntos');
          }
        }
        for (let s = 0; s < paradas; s++) {
          let local = prob(0.6) ? elegir(c.favoritos) : elegir(locales.filter((l) => c.perfil.categorias.includes(l.grupo)));
          const entrada = new Date(t + entre(3, 15) * 60_000);
          const dur = entre(10, local.ambito === 'comida' ? 45 : 35);
          const salida = new Date(entrada.getTime() + dur * 60_000);
          if (salida.getTime() > ahora.getTime()) break;
          const hBo = (entrada.getTime() - instante(off, 0).getTime()) / MS_HORA;
          if (!abiertoEn(local, dow, hBo)) continue;
          t = salida.getTime();
          const conCheckin = prob(0.4);
          const compra = prob(local.ambito === 'comida' ? 0.85 : 0.55);
          const vistos = visitados.get(c.id) ?? new Set<string>();
          const primera = !vistos.has(local.id);
          vistos.add(local.id);
          visitados.set(c.id, vistos);
          if (conCheckin || compra) {
            filasCheckin.push([randomUUID(), c.id, local.id, entrada, salida, compra, conCheckin && primera ? 20 : 0, conCheckin ? 'qr' : 'compra']);
            if (conCheckin) {
              evento(c.seud, 'checkin.registrado', entrada, { primera_vez: primera }, local.id);
              if (primera) mov(c.id, 'descubrimiento', 20, entrada, `Descubriste ${local.nombre}`, local.id);
            }
          }
          if (compra) {
            const monto = Math.round(entre(local.ticket[0], local.ticket[0] + (local.ticket[1] - local.ticket[0]) * Math.pow(rnd(), 2.2)) * 10) / 10;
            const horaBo = new Date(salida.getTime() - 4 * MS_HORA);
            const hd = horaBo.getUTCHours() + horaBo.getUTCMinutes() / 60;
            let mult = local.grupo === 'Entretenimiento' ? 1.2 : 1;
            if (dow >= 1 && dow <= 4 && hd >= 15 && hd <= 17) mult *= 1.5;
            if (local.id === localComida1.id && dow >= 1 && dow <= 4 && hd >= 15 && hd <= 18 && off <= 40) mult *= 2;
            if (local.id === localComida2.id && (dow === 0 || dow === 6) && off <= 25) mult *= 2;
            if (local.ambito === 'comida' && hd < 11.5 && off <= 20) mult *= 2;
            const puntos = Math.floor(Math.floor(monto) * mult);
            const txId = randomUUID();
            filasTx.push([txId, randomUUID(), recintoId, c.id, local.id, local.cuenta, monto, local.grupo, null, null, prob(0.85) ? 'qr' : 'codigo', 'valida', false, puntos, salida, salida]);
            mov(c.id, 'compra', puntos, salida, `Compra de Bs ${monto.toFixed(2)}`, local.id, txId);
            evento(c.seud, 'compra.registrada', salida, { monto_bs: monto, categoria: local.grupo, puntos }, local.id);
            compras++;
          }
        }
        filasVisita.push([visitaId, recintoId, c.id, puerta === 'Parqueo' ? 'parqueo' : 'qr_entrada', puerta, llegada, off === 0 && prob(0.5) ? null : new Date(t + 5 * 60_000), puntosVisita]);
        // canje ocasional
        const s = saldo.get(c.id) ?? 0;
        if (s >= 250 && prob(0.12)) {
          const op = recompensaIds.filter((r) => r.costo <= s && r.local);
          if (op.length) {
            const r = elegir(op);
            const en = new Date(t + 2 * 60_000);
            if (en.getTime() < ahora.getTime()) {
              const localVal = r.local!;
              const canjeId = randomUUID();
              filasCanje.push([canjeId, c.id, r.id, `${codigoLegible(10)}.SEED${codigoLegible(4)}`, r.costo, 'validado', new Date(en.getTime() - 5 * 60_000), new Date(en.getTime() + 10 * 60_000),
                locales.find((l) => l.id === localVal)!.cuenta, localVal, en]);
              mov(c.id, 'canje', -r.costo, en, 'Canje de recompensa', localVal, canjeId);
              evento(c.seud, 'cupon.validado', en, { costo: r.costo }, localVal);
            }
          }
        }
        // búsquedas en la app
        if (prob(0.25)) {
          const sin = prob(0.3);
          const termino = sin ? elegir(BUSQUEDAS_SIN_RESULTADO) : elegir(elegir(locales).clave);
          filasBusqueda.push([recintoId, c.seud, termino, prob(0.15) ? 'jarvis' : prob(0.3) ? 'paseoya' : 'app', sin ? 0 : entero(1, 6), llegada]);
          evento(c.seud, 'busqueda.realizada', llegada, { termino, resultados: sin ? 0 : 1 });
        }
      }
    }
    console.log(`  ${N} clientes, ${compras} compras, ${filasVisita.length} visitas`);

    // -------------------------------------------------------------- Drops: pasados con reclamos, uno activo, solicitudes de comercios
    const filasDrop: unknown[][] = [];
    const filasReclamoDrop: unknown[][] = [];
    const productosDrop = [
      productoDelLocal(localComida1.id, 0),
      productoDelLocal(localComida2.id, 1),
      productoDelLocal(localTecnologia.id, 0),
      productoDelLocal(localModa.id, 1),
      productoDelLocal(localDiversion.id, 0),
    ];
    const drops = productosDrop.map((producto, i) => ({
      producto,
      precio: Math.max(5, Math.round(producto.precio * 0.75)),
      mensaje: [`Especial del día en ${localComida1.nombre}`, `Una oportunidad en ${localComida2.nombre}`, `Novedad de ${localTecnologia.nombre}`, `Temporada en ${localModa.nombre}`, `Experiencia en ${localDiversion.nombre}`][i],
      diasAtras: [0, 6, 12, 20, 33][i],
      minutos: [480, 90, 60, 120, 90][i],
    }));
    let dropActivo = '';
    for (const { producto, precio, mensaje, diasAtras, minutos } of drops) {
      const l = locales.find((x) => x.id === producto.local)!;
      const id = randomUUID();
      const inicio = diasAtras === 0 ? new Date(ahora.getTime() - 30 * 60_000) : instante(diasAtras, 17);
      if (diasAtras === 0) dropActivo = id;
      filasDrop.push([id, recintoId, zonaId.get(`${l.piso}-${l.sector}`), producto.id, precio, mensaje, `D-${codigoLegible(6)}`, inicio, new Date(inicio.getTime() + minutos * 60_000), 50, adminId, l.id]);
      const n = diasAtras === 0 ? 7 : entero(18, 45);
      const usados = new Set<string>();
      for (let k = 0; k < n; k++) {
        const c = elegir(clientes.slice(1));
        if (usados.has(c.id)) continue;
        usados.add(c.id);
        filasReclamoDrop.push([id, c.id, diasAtras > 0 && prob(0.8), new Date(inicio.getTime() + entre(1, Math.min(minutos, 30)) * 60_000)]);
      }
    }
    await insertarLote(q, 'drop_espacial', ['id', 'recinto_id', 'zona_id', 'producto_id', 'precio_especial', 'mensaje', 'codigo', 'inicio', 'fin', 'max_reclamos', 'creado_por', 'local_id'], filasDrop);
    const solicitudes = [
      { producto: productosDrop[0], estado: 'pendiente', fecha: -1, comentario: null, mensaje: 'Propuesta especial para este local.' },
      { producto: productosDrop[1], estado: 'pendiente', fecha: -2, comentario: null, mensaje: 'Precio especial por tiempo limitado.' },
      { producto: productosDrop[2], estado: 'pendiente', fecha: null, comentario: null, mensaje: 'Novedad del local con descuento.' },
      { producto: productosDrop[1], estado: 'lanzada', fecha: null, comentario: null, mensaje: 'Drop disponible para clientes.' },
      { producto: productosDrop[3], estado: 'rechazada', fecha: null, comentario: 'El descuento supera el límite permitido; propón uno menor al 30 %.', mensaje: 'Propuesta de descuento.' },
    ];
    await insertarLote(
      q, 'solicitud_drop',
      ['recinto_id', 'local_id', 'producto_id', 'zona_id', 'precio_especial', 'mensaje', 'fecha_deseada', 'minutos', 'max_reclamos', 'estado', 'comentario', 'drop_id', 'creado_por', 'revisado_por', 'creado_en'],
      solicitudes.map(({ producto, mensaje, fecha, estado, comentario }) => {
        const l = locales.find((x) => x.id === producto.local)!;
        return [recintoId, l.id, producto.id, zonaId.get(`${l.piso}-${l.sector}`), Math.max(5, Math.round(producto.precio * 0.75)), mensaje,
          fecha === null ? null : instante(fecha, 18), 60, 40, estado, comentario,
          estado === 'lanzada' ? filasDrop[1][0] : null, l.cuenta, estado === 'pendiente' ? null : adminId, instante(estado === 'pendiente' ? 0 : 7, 9)];
      }),
    );

    // -------------------------------------------------------------- PaseoYa (últimos 60 días)
    const filasPedido: unknown[][] = [];
    const filasSub: unknown[][] = [];
    const filasItem: unknown[][] = [];
    const localesComida = [...new Set(productos.filter((p) => p.comida).map((p) => p.local))];
    const localesProd = [...new Set(productos.map((p) => p.local))];
    for (let i = 0; i < 900; i++) {
      const c = elegir(clientes.filter((x) => x.registro >= 5));
      const off = entero(0, 59);
      if (off > c.registro) continue;
      const hora = entre(11, 20.5);
      const creado = instante(off, hora - 1.5);
      if (creado.getTime() > ahora.getTime()) continue;
      const franjaIni = instante(off, hora);
      const franjaFin = new Date(franjaIni.getTime() + 30 * 60_000);
      const pedidoId = randomUUID();
      const nLocales = prob(0.25) ? 2 : 1;
      const elegidos = [...new Set([elegir(prob(0.7) ? localesComida : localesProd), elegir(localesProd)])].slice(0, nLocales);
      let total = 0;
      let hayComida = false;
      const futuro = franjaFin.getTime() > ahora.getTime();
      for (const lid of elegidos) {
        const subId = randomUUID();
        const lista = productos.filter((p) => p.local === lid);
        const items = [...new Set([elegir(lista), ...(prob(0.4) ? [elegir(lista)] : [])])];
        if (items.some((it) => it.comida)) hayComida = true;
        let sub = 0;
        for (const it of items) {
          const cant = entero(1, 2);
          sub += it.precio * cant;
          filasItem.push([randomUUID(), subId, it.id, it.nombre, cant, it.precio]);
        }
        total += sub;
        const estado = futuro ? elegir(['recibido', 'confirmado', 'preparando', 'listo']) : prob(0.88) ? 'entregado' : 'vencido';
        const entregado = estado === 'entregado' ? new Date(franjaIni.getTime() + entre(0, 25) * 60_000) : null;
        const lc = locales.find((l) => l.id === lid)!;
        filasSub.push([subId, pedidoId, lid, estado, sub, `${codigoLegible(8)}.SEED${codigoLegible(4)}`, String(entero(0, 9999)).padStart(4, '0'), 'en_local',
          new Date(creado.getTime() + 5 * 60_000), ['recibido', 'confirmado'].includes(estado) ? null : new Date(creado.getTime() + 15 * 60_000),
          ['recibido', 'confirmado', 'preparando'].includes(estado) ? null : new Date(creado.getTime() + 20 * 60_000), entregado, entregado ? Math.floor(sub) : 0]);
        if (entregado) {
          const txId = randomUUID();
          filasTx.push([txId, randomUUID(), recintoId, c.id, lid, lc.cuenta, sub, lc.grupo, null, null, 'paseoya', 'valida', false, Math.floor(sub), entregado, entregado]);
          mov(c.id, 'paseoya', Math.floor(sub), entregado, 'Retiro PaseoYa', lid, txId);
          evento(c.seud, 'subpedido.entregado', entregado, { monto_bs: sub }, lid);
          // Tráfico inducido: compra adicional en otro local durante la misma visita
          if (prob(0.42)) {
            const otro = elegir(locales.filter((l) => l.id !== lid && l.ambito === 'comida'));
            const monto = Math.round(entre(otro.ticket[0], otro.ticket[1] * 0.6));
            const en = new Date(entregado.getTime() + entre(10, 50) * 60_000);
            if (en.getTime() < ahora.getTime()) {
              const tx2 = randomUUID();
              filasTx.push([tx2, randomUUID(), recintoId, c.id, otro.id, otro.cuenta, monto, otro.grupo, null, null, 'qr', 'valida', false, monto, en, en]);
              mov(c.id, 'compra', monto, en, `Compra de Bs ${monto.toFixed(2)}`, otro.id, tx2);
              filasCheckin.push([randomUUID(), c.id, otro.id, new Date(en.getTime() - 15 * 60_000), en, true, 0, 'compra']);
              evento(c.seud, 'compra.registrada', en, { monto_bs: monto }, otro.id);
            }
          }
        }
      }
      // Tipo de pedido (migración 008): comida si lleva algo de comida; si es de tienda, con fecha estimada de retiro
      filasPedido.push([pedidoId, recintoId, `P-${codigoLegible(6)}`, c.id, total, franjaIni, franjaFin, creado, hayComida ? 'comida' : 'retail', hayComida ? null : fechaBo(franjaIni)]);
    }

    // -------------------------------------------------------------- María: estado vivo para probar la app y a Jarvis
    {
      const pedidoId = randomUUID();
      const franjaIni = new Date(ahora.getTime() + 20 * 60_000);
      let total = 0;
      const productosMaria: [typeof productos[number], number, string, number][] = [
        [productoDelLocal(localComida1.id, 0), 1, 'listo', 25],
        [productoDelLocal(localComida2.id, 1), 1, 'preparando', 8],
      ];
      for (const [p, cant, estado, haceMin] of productosMaria) {
        const subId = randomUUID();
        const base = codigoLegible(8);
        const sub = p.precio * cant;
        total += sub;
        filasSub.push([subId, pedidoId, p.local, estado, sub, `${base}.${firmaCorta(base)}`, pinNumerico(4), 'en_local',
          new Date(ahora.getTime() - (haceMin + 5) * 60_000), new Date(ahora.getTime() - haceMin * 60_000), estado === 'listo' ? new Date(ahora.getTime() - 3 * 60_000) : null, null, 0]);
        filasItem.push([randomUUID(), subId, p.id, p.nombre, cant, p.precio]);
      }
      filasPedido.push([pedidoId, recintoId, `P-${codigoLegible(6)}`, maria.id, total, franjaIni, new Date(franjaIni.getTime() + 30 * 60_000), new Date(ahora.getTime() - 40 * 60_000), 'comida', null]);
      // Visita abierta y parqueo en curso
      filasVisita.push([randomUUID(), recintoId, maria.id, 'parqueo', 'Parqueo', new Date(ahora.getTime() - 50 * 60_000), null, 0]);
      filasParqueo.push([maria.id, `T-${codigoLegible(6)}`, new Date(ahora.getTime() - 55 * 60_000), null, null, 0, 0, 0, 'abierto']);
      // Un Drop reclamado (sin usar) y un cupón vigente
      filasReclamoDrop.push([dropActivo, maria.id, false, new Date(ahora.getTime() - 10 * 60_000)]);
      const r = recompensaIds.find((x) => x.costo === 250)!;
      const base = codigoLegible(10);
      const canjeId = randomUUID();
      filasCanje.push([canjeId, maria.id, r.id, `${base}.${firmaCorta(base)}`, r.costo, 'emitido', new Date(ahora.getTime() - 2 * 60_000), new Date(ahora.getTime() + 13 * 60_000), null, null, null]);
    }

    // -------------------------------------------------------------- fraude plantado
    const plantar = (l: (typeof locales)[number], clienteIdx: number, monto: number, offDia: number, hora: number, regla: string, detalle: string, puntaje: number) => {
      const c = clientes[clienteIdx];
      const en = instante(offDia, hora);
      const txId = randomUUID();
      filasTx.push([txId, randomUUID(), recintoId, c.id, l.id, l.cuenta, monto, l.grupo, null, null, 'qr', 'valida', false, Math.floor(monto), en, en]);
      mov(c.id, 'compra', Math.floor(monto), en, `Compra de Bs ${monto.toFixed(2)}`, l.id, txId);
      filasAlerta.push([recintoId, txId, c.id, l.id, l.cuenta, regla, detalle, puntaje, offDia > 3 ? elegir(['descartada', 'confirmada']) : 'abierta', en]);
    };
    plantar(localComida1, 37, 8400, 12, 16.2, 'monto_atipico', `Monto muy superior al ticket promedio de ${localComida1.nombre}.`, 0.98);
    plantar(localComida2, 51, 2600, 2, 18.1, 'monto_atipico', `Monto muy superior al ticket promedio de ${localComida2.nombre}.`, 0.95);
    for (let k = 0; k < 4; k++) plantar(localComida1, 64, 18 + k, 1, 11 + k * 0.004, 'rafaga_compras', `${k + 1} compras del mismo cliente en menos de 60 s`, 0.8);
    for (let k = 0; k < 9; k++) plantar(localDiversion, 88, entre(300, 900), entero(1, 12), entre(16, 20), 'cliente_concentrado', `${k + 3} de las últimas 20 compras de este comercio son del mismo cliente`, 0.7);
    filasAlerta.splice(filasAlerta.length - 9, 8);

    // -------------------------------------------------------------- escritura masiva
    console.log('  escribiendo en la base…');
    await insertarLote(q, 'usuario', ['id', 'recinto_id', 'rol', 'nombre', 'correo', 'celular', 'hash', 'creado_en'], filasUsuario);
    await insertarLote(
      q, 'cliente_perfil',
      ['usuario_id', 'id_seudonimo', 'codigo_cliente', 'secreto_pase', 'fecha_nacimiento', 'genero', 'zona_residencia', 'intereses', 'codigo_invitacion',
        'consent_terminos_en', 'consent_ubicacion', 'consent_personalizacion', 'mostrar_nombre_locales', 'alias'],
      filasPerfil,
    );
    await insertarLote(q, 'favorito', ['cliente_id', 'producto_id', 'local_id', 'creado_en'], filasFavorito);
    await insertarLote(q, 'transaccion', ['id', 'clave_idempotencia', 'recinto_id', 'cliente_id', 'local_id', 'empleado_id', 'monto_bs', 'categoria', 'nro_factura', 'nit_emisor', 'origen', 'estado', 'offline', 'puntos', 'capturado_en', 'creado_en'], filasTx);
    // restante final de cada lote según el consumo FIFO simulado
    const restante = new Map<string, number>();
    for (const ls of lotes.values()) for (const l of ls) restante.set(l.id, l.restante);
    for (const f of filasMov) if ((f[4] as number) > 0) f[5] = restante.get(f[0] as string) ?? f[5];
    await insertarLote(q, 'movimiento_puntos', ['id', 'recinto_id', 'cliente_id', 'tipo', 'puntos', 'restante', 'referencia_id', 'local_id', 'descripcion', 'vence_en', 'regla_version', 'creado_en'], filasMov);
    await insertarLote(q, 'visita', ['id', 'recinto_id', 'cliente_id', 'fuente', 'puerta', 'entrada_en', 'salida_en', 'puntos'], filasVisita);
    await insertarLote(q, 'checkin_local', ['id', 'cliente_id', 'local_id', 'entrada_en', 'salida_en', 'con_compra', 'puntos', 'origen'], filasCheckin);
    await insertarLote(q, 'canje', ['id', 'cliente_id', 'recompensa_id', 'codigo', 'costo_puntos', 'estado', 'emitido_en', 'expira_en', 'validado_por', 'validado_local', 'validado_en'], filasCanje);
    await insertarLote(q, 'busqueda', ['recinto_id', 'id_seudonimo', 'termino', 'origen', 'resultados', 'creado_en'], filasBusqueda);
    await insertarLote(q, 'pedido', ['id', 'recinto_id', 'codigo', 'cliente_id', 'total_bs', 'franja_inicio', 'franja_fin', 'creado_en', 'tipo', 'fecha_estimada_retiro'], filasPedido);
    await insertarLote(q, 'subpedido', ['id', 'pedido_id', 'local_id', 'estado', 'total_bs', 'codigo_retiro', 'pin', 'pago', 'confirmado_en', 'preparando_en', 'listo_en', 'entregado_en', 'puntos'], filasSub);
    await insertarLote(q, 'subpedido_item', ['id', 'subpedido_id', 'producto_id', 'nombre', 'cantidad', 'precio_bs'], filasItem);
    await insertarLote(q, 'reclamo_drop', ['drop_id', 'cliente_id', 'usado', 'creado_en'], filasReclamoDrop);
    await insertarLote(q, 'parqueo', ['cliente_id', 'ticket', 'entrada_en', 'salida_en', 'minutos', 'horas_gratis', 'puntos_usados', 'monto_bs', 'estado'], filasParqueo);
    await insertarLote(q, 'alerta_fraude', ['recinto_id', 'transaccion_id', 'cliente_id', 'local_id', 'empleado_id', 'regla', 'detalle', 'puntaje', 'estado', 'creado_en'], filasAlerta);
    await insertarLote(q, 'evento', ['recinto_id', 'id_seudonimo', 'tipo', 'payload', 'local_id', 'zona_id', 'creado_en'], filasEvento);
    await insertarLote(q, 'notificacion', ['usuario_id', 'tipo', 'titulo', 'cuerpo', 'datos'], [
      [maria.id, 'pedido', 'Tu pedido está listo', `${productoDelLocal(localComida1.id).nombre} te espera en ${localComida1.nombre}, local ${localComida1.numero}`, '{}'],
      [maria.id, 'drop', `Drop de ${localComida2.nombre}`, `Hay una oferta de ${productoDelLocal(localComida2.id, 1).nombre}`, '{}'],
      [maria.id, 'promocion', `Puntos dobles en ${localModa.nombre}`, `Descubre las novedades de ${localModa.nombre}`, '{}'],
      [adminId, 'drop_solicitado', 'Drops por aprobar', '3 comercios pidieron un Drop', '{}'],
      [adminId, 'evento_pendiente', 'Eventos por aprobar', `${localComida1.nombre} y ${localModa.nombre} proponen actividades`, '{}'],
    ]);
    console.log(`  ${filasTx.length} transacciones, ${filasMov.length} movimientos, ${filasEvento.length} eventos de telemetría, ${filasPedido.length} pedidos PaseoYa`);
    console.log(`  ${productos.length} productos, ${filasActividad.length} eventos del Paseo, ${SERVICIOS.length} servicios, ${promos.length} promociones, ${filasDrop.length} Drops`);
  });
  await db.close();

  // -------------------------------------------------------------- pasos derivados con los servicios del sistema
  console.log('Calculando segmentos (K-Means), entrenando el modelo de anomalías y armando el grafo…');
  const { AppModule } = await import('../app.module.js');
  const { InteligenciaService } = await import('../modules/inteligencia/inteligencia.service.js');
  const { FraudeService } = await import('../modules/confianza/fraude.service.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db2 = app.get(Db);
  const recinto = (await db2.query<{ id: string }>('select id from recinto limit 1')).rows[0].id;
  const segs = await app.get(InteligenciaService).recalcularSegmentos(recinto, 5);
  console.log(`  segmentos: ${segs.map((s: any) => `${s.nombre} (${s.tamano})`).join(', ')}`);
  await app.get(FraudeService).entrenar();
  const { OrientacionService } = await import('../modules/orientacion/orientacion.service.js');
  const orientacion = app.get(OrientacionService);
  const g = await orientacion.reconstruir(recinto);
  // María está en el Paseo: llegó por el parqueo
  await orientacion.moverA(mariaId, 'N1:entrada:parqueo', 'entrada');
  console.log(`  grafo del edificio: ${g.nodos} nodos, ${g.aristas} conexiones`);

  // Ofertas personales de la IA: 14 días de historia (con canjes simulados) y las de hoy
  console.log('Generando ofertas personales de la IA (14 días de historia + hoy)…');
  const { OfertasService } = await import('../modules/ofertas/ofertas.service.js');
  const ofertas = app.get(OfertasService);
  const hoyBo = new Date(Date.now() - 4 * MS_HORA).toISOString().slice(0, 10);
  for (let k = 14; k >= 1; k--) {
    const fecha = new Date(Date.parse(`${hoyBo}T12:00:00Z`) - k * MS_DIA).toISOString().slice(0, 10);
    await ofertas.generarDia(recinto, fecha, { forzar: true, notificar: false });
    // Los locales con más déficit (más equidad) convierten un poco mejor: el incentivo pesa más donde hay menos gente
    await db2.query(
      `update oferta_personal set estado = 'usada', puntos_bono = (15 + random() * 90)::int,
         usada_en = (fecha + hora_inicio + interval '35 minutes') + interval '4 hours'
       where recinto_id = $1 and fecha = $2::date and random() < 0.1 + 0.2 * equidad`,
      [recinto, fecha],
    );
  }
  const r = await ofertas.generarDia(recinto, hoyBo, { forzar: true, notificar: true });
  console.log(`  hoy: ${r.generadas} ofertas para ${r.clientes} clientes en ${(r as any).locales ?? 0} locales`);
  await app.close();
  console.log(`Listo en ${Math.round((Date.now() - t0) / 1000)} s.`);
  console.log(`
Cuentas de prueba (solo desarrollo):
  Administración  admin@paseo.bo / Admin2026!   (el código 2FA se muestra en la respuesta de login en desarrollo)
  Marketing       marketing@paseo.bo / Marketing2026!
  Analista        analista@paseo.bo / Analista2026!
  Comercio ${LOCALES_CSV[0].nombre}  comercio.${slug(LOCALES_CSV[0].nombre)}@paseo.bo / Comercio2026!
  Cliente demo    70000001 / Maria2026!  (María Rojas: pedido listo, otro en preparación, parqueo abierto, cupón vigente)
  Clientes        cualquier celular sintético / Cliente2026!`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
