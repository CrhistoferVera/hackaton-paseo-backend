/**
 * Generador de datos sintéticos (≈3 meses): 40 locales en el plano, 2.000 clientes con perfiles
 * distintos, visitas, compras con montos realistas por categoría, canjes, PaseoYa, búsquedas y
 * casos de fraude plantados. Uso:  npm run seed            (solo si la base está vacía)
 *                                  npm run seed -- --reset (borra todo y vuelve a generar)
 */
import '../cargar-env.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Db, Queryable } from '../infra/db/db.js';
import { crearDb, migrar } from '../infra/db/db.module.js';
import { hashPassword } from '../common/auth/tokens.js';
import { codigoLegible, secretoAleatorio } from '../common/util.js';
import { APELLIDOS, BUSQUEDAS_SIN_RESULTADO, CATEGORIAS, LOCALES, NOMBRES, PRODUCTOS, ZONAS, ZONAS_RESIDENCIA } from './catalogo.js';

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
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const MS_HORA = 3600_000;
const DIAS = 90;
const ahora = new Date();
/** Fecha y hora boliviana (UTC-4) → instante UTC. */
function instante(diaOffset: number, horaDecimal: number): Date {
  const hoyBo = new Date(ahora.getTime() - 4 * MS_HORA);
  const base = Date.UTC(hoyBo.getUTCFullYear(), hoyBo.getUTCMonth(), hoyBo.getUTCDate());
  return new Date(base - diaOffset * 86400_000 + horaDecimal * MS_HORA + 4 * MS_HORA);
}
function diaSemanaBo(diaOffset: number) {
  return new Date(instante(diaOffset, 12).getTime() - 4 * MS_HORA).getUTCDay();
}

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
    gerente: await hashPassword('Gerente2026!'),
    cajero: await hashPassword('Cajero2026!'),
    cliente: await hashPassword('Cliente2026!'),
    maria: await hashPassword('Maria2026!'),
  };

  await db.tx(async (q) => {
    await q.query('insert into recinto (id, nombre, lat, lng, radio_m) values ($1,$2,$3,$4,$5)', [recintoId, 'Paseo Aranjuez', lat, lng, 300]);

    // -------------------------------------------------------------- catálogo físico
    const catId = new Map<string, string>();
    for (const c of CATEGORIAS) {
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
    const locales = LOCALES.map((l, i) => ({ ...l, id: randomUUID(), zona: zonaId.get(`${l.piso}-${l.sector}`)!, nit: String(1020300000 + i * 17), cajeros: [] as string[], gerente: '' }));
    await insertarLote(
      q, 'local',
      ['id', 'recinto_id', 'nombre', 'categoria_id', 'piso', 'sector', 'numero_local', 'coord_x', 'coord_y', 'zona_id', 'descripcion', 'palabras_clave', 'nit', 'codigo_puerta',
        'horario_apertura', 'horario_cierre'],
      locales.map((l) => [l.id, recintoId, l.nombre, catId.get(l.categoria), l.piso, l.sector, l.numero, l.x, l.y, l.zona, l.descripcion, l.clave, l.nit,
        `L-${slug(l.nombre).toUpperCase().padEnd(8, 'X').slice(0, 8)}`, l.categoria === 'Comida' ? '09:00' : '10:00', l.piso === 'T' ? '23:00' : '22:00']),
    );

    // -------------------------------------------------------------- personal
    const usuarios: unknown[][] = [];
    const empleados: unknown[][] = [];
    const internos = [
      ['admin', 'Administración Paseo', 'admin@paseo.bo', hashes.admin],
      ['marketing', 'Marketing Paseo', 'marketing@paseo.bo', hashes.marketing],
      ['analista', 'Analista de datos', 'analista@paseo.bo', hashes.analista],
    ];
    for (const [rol, nombre, correo, h] of internos) usuarios.push([randomUUID(), recintoId, rol, nombre, correo, null, h, instante(DIAS + 5, 9)]);
    for (const l of locales) {
      const s = slug(l.nombre);
      const g = randomUUID();
      l.gerente = g;
      usuarios.push([g, recintoId, 'gerente', `Gerente ${l.nombre}`, `gerente.${s}@paseo.bo`, null, hashes.gerente, instante(DIAS + 5, 9)]);
      empleados.push([g, l.id, 'gerente', 'Gerencia']);
      for (let c = 1; c <= 2; c++) {
        const id = randomUUID();
        l.cajeros.push(id);
        usuarios.push([id, recintoId, 'cajero', `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`, c === 1 ? `cajero.${s}@paseo.bo` : `cajero2.${s}@paseo.bo`, null, hashes.cajero, instante(DIAS + 5, 9)]);
        empleados.push([id, l.id, 'cajero', `caja ${c}`]);
      }
    }
    await insertarLote(q, 'usuario', ['id', 'recinto_id', 'rol', 'nombre', 'correo', 'celular', 'hash', 'creado_en'], usuarios);
    await insertarLote(q, 'empleado_local', ['usuario_id', 'local_id', 'rol', 'etiqueta'], empleados);
    const adminId = usuarios[0][0] as string;

    // -------------------------------------------------------------- reglas, recompensas, hitos
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
    const loc = (n: string) => locales.find((l) => l.nombre === n)!;
    const recompensas = [
      ['Café de bienvenida', 'Un café americano o capuchino', 250, loc('Café Alameda').id, null],
      ['Salteña de cortesía', 'Una salteña de carne o pollo', 200, loc('Panchita').id, null],
      ['Helado doble', 'Dos bolas a elección', 300, loc('Heladería Frío Frío').id, null],
      ['Entrada 2×1 al cine', 'Válido de lunes a jueves', 900, loc('Cine Aranjuez').id, 200],
      ['Una línea de bowling', 'Hasta 6 jugadores', 700, loc('Bowling Strike').id, 100],
      ['Combo hamburguesa', 'Hamburguesa, papas y gaseosa', 600, loc('Burger House').id, null],
      ['Bs 20 de descuento en TecnoCentro', 'En compras desde Bs 200', 1000, loc('TecnoCentro').id, 150],
      ['Pack regalo Paseo Aranjuez', 'Taza, termo y bolsa de tela', 1500, null, 40],
      ['Corte de cabello', 'En Barber Club', 1200, loc('Barber Club').id, 60],
    ];
    const recompensaIds: { id: string; costo: number; local: string | null }[] = [];
    for (const [nombre, desc, costo, localId, stock] of recompensas) {
      const id = randomUUID();
      recompensaIds.push({ id, costo: costo as number, local: localId as string | null });
      await q.query(`insert into recompensa (id, recinto_id, nombre, descripcion, costo_puntos, local_id, stock) values ($1,$2,$3,$4,$5,$6,$7)`, [id, recintoId, nombre, desc, costo, localId, stock]);
    }
    for (const z of ZONAS) {
      await q.query(`insert into hito (recinto_id, nombre, zona_id, codigo, puntos) values ($1,$2,$3,$4,15)`, [
        recintoId, `Cartel ${z.nombre} · ${z.piso}`, zonaId.get(`${z.piso}-${z.sector}`), `${z.piso}-${z.sector}`,
      ]);
    }

    // -------------------------------------------------------------- productos PaseoYa
    const productos: { id: string; local: string; precio: number }[] = [];
    const filasProd: unknown[][] = [];
    for (const [nombreLocal, lista] of Object.entries(PRODUCTOS)) {
      const l = loc(nombreLocal);
      for (const p of lista) {
        const id = randomUUID();
        productos.push({ id, local: l.id, precio: p.precio });
        filasProd.push([id, l.id, p.nombre, p.descripcion, p.precio, p.stock, catId.get(l.categoria), null]);
      }
    }
    await insertarLote(q, 'producto', ['id', 'local_id', 'nombre', 'descripcion', 'precio_bs', 'stock', 'categoria_id', 'destacado_hasta'], filasProd);
    await q.query(`update producto set destacado_hasta = current_date + 14 where nombre in ('Audífonos bluetooth SoundGo','Torta de chocolate (8 porciones)','Pizza familiar pepperoni')`);

    // -------------------------------------------------------------- promociones y misiones
    const hoy = new Date(ahora.getTime() - 4 * MS_HORA).toISOString().slice(0, 10);
    const dia = (n: number) => new Date(ahora.getTime() - 4 * MS_HORA + n * 86400_000).toISOString().slice(0, 10);
    await q.query(
      `insert into promocion (recinto_id, local_id, titulo, tipo, multiplicador, descripcion, dias_semana, hora_inicio, hora_fin, inicio, fin, estado, creado_por, revisado_por) values
       ($1,$2,'Tarde de pizza ×2','puntos_dobles',2,'Puntos dobles de lunes a jueves en la tarde','{1,2,3,4}','15:00','18:00',$4,$5,'aprobada',$6,$3),
       ($1,$7,'Fin de semana dulce','puntos_dobles',2,'Puntos dobles en tortas y postres','{0,6}','10:00','22:00',$8,$5,'aprobada',$9,$3),
       ($1,$10,'Torneo gamer','puntos_dobles',2,'Puntos dobles en consolas los viernes','{5}','16:00','21:00',$11,$12,'pendiente',$13,null),
       ($1,$14,'2×1 en jugos','cupon',1,'Muestra la app y lleva dos jugos por uno','{1,2,3,4,5}','10:00','12:00',$4,$5,'aprobada',$15,$3)`,
      [
        recintoId, loc('Napoli Pizzería').id, adminId, dia(-40), dia(30), loc('Napoli Pizzería').gerente,
        loc('Dulce Arte').id, dia(-25), loc('Dulce Arte').gerente, loc('Gamer Zone').id, dia(1), dia(30), loc('Gamer Zone').gerente,
        loc('Jugos Tropicales').id, loc('Jugos Tropicales').gerente,
      ],
    );
    const inicioMes = hoy.slice(0, 8) + '01';
    await q.query(
      `insert into mision (recinto_id, nombre, descripcion, plantilla, regla, meta, recompensa_puntos, vigencia_desde, vigencia_hasta) values
       ($1,'Explorador gastronómico','Compra en 3 restaurantes distintos este mes','locales_distintos','{"categoria":"Comida","n":3}',3,300,$2,$3),
       ($1,'Tu primera compra','Haz tu primera compra con Paseo Points','compras_categoria','{"n":1}',1,50,$4,$5),
       ($1,'Tarde de compras','Dos compras entre las 15:00 y las 18:00','franja_horaria','{"desde":"15:00","hasta":"18:00","n":2}',2,120,$2,$3),
       ($1,'Descubre 5 locales','Visita o compra en 5 locales nuevos','primera_visita','{"n":5}',5,250,$4,$5)`,
      [recintoId, inicioMes, dia(31), dia(-90), dia(60)],
    );

    // -------------------------------------------------------------- clientes y actividad
    const N = Number(process.env.SEED_CLIENTES ?? 2000);
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
    type Lote = { id: string; restante: number };
    const lotes = new Map<string, Lote[]>();
    const saldo = new Map<string, number>();
    const zonaDeLocal = new Map<string, string>(locales.map((l) => [l.id, l.zona]));

    const mov = (clienteId: string, tipo: string, puntos: number, en: Date, descripcion: string, localId: string | null = null, ref: string | null = null) => {
      const id = randomUUID();
      const venc = puntos > 0 ? new Date(en.getTime() + 365 * 86400_000) : null;
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
      const regOff = esMaria ? 85 : DIAS - 1 - Math.floor(Math.pow(rnd(), 1.8) * (DIAS - 1));
      const nombre = esMaria ? 'María Rojas' : `${elegir(NOMBRES)} ${elegir(APELLIDOS)}`;
      const celular = esMaria ? '70000001' : String(60000000 + i * 7919 % 9999999).padStart(8, '7').slice(0, 8);
      const regEn = instante(regOff, entre(perfil.horas[0], perfil.horas[1]));
      const prefer = perfil.categorias;
      const candidatos = locales.filter((l) => prefer.includes(l.categoria));
      const favoritos = esMaria ? [loc('Panchita'), loc('Guajojó'), loc('Café Alameda'), loc('Moda Andina')] : [elegir(candidatos), elegir(candidatos), elegir(candidatos)];
      clientes.push({ id, seud, perfil, favoritos, registro: regOff, celular });
      filasUsuario.push([id, recintoId, 'cliente', nombre, esMaria ? 'maria@demo.bo' : null, celular, esMaria ? hashes.maria : hashes.cliente, regEn]);
      const intereses = esMaria ? ['Comida', 'Moda', 'Tecnología'] : [...new Set([...prefer, 'Comida', 'Moda', 'Regalos'])].slice(0, 3);
      const nacimiento = `${entero(perfil.tipo === 'joven' ? 1998 : 1965, perfil.tipo === 'joven' ? 2007 : 1996)}-${String(entero(1, 12)).padStart(2, '0')}-${String(entero(1, 28)).padStart(2, '0')}`;
      filasPerfil.push([
        id, seud, codigoLegible(8), secretoAleatorio(), nacimiento, elegir(['F', 'M', null]), esMaria ? 'Calacoto' : elegir(ZONAS_RESIDENCIA), intereses,
        codigoLegible(6), regEn, prob(0.7) || esMaria, prob(0.75) || esMaria, prob(0.4), `Cliente ${codigoLegible(4)}`,
      ]);
      mov(id, 'bono', 100, regEn, 'Bono de bienvenida');
      evento(seud, 'cliente.registrado', regEn, { perfil: perfil.tipo });
    }
    const maria = clientes[0];

    const visitados = new Map<string, Set<string>>();
    const visitaDia = new Set<string>();
    let compras = 0;
    for (let off = DIAS - 1; off >= 0; off--) {
      const dow = diaSemanaBo(off);
      const limiteHora = off === 0 ? (ahora.getTime() - instante(0, 0).getTime()) / MS_HORA : 24;
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
        evento(c.seud, 'visita.iniciada', llegada, { fuente: 'qr_entrada' });
        for (let s = 0; s < paradas; s++) {
          let local = prob(0.6) ? elegir(c.favoritos) : elegir(locales.filter((l) => c.perfil.categorias.includes(l.categoria)));
          if (c === maria) {
            const r = rnd();
            local = r < 0.45 ? loc('Panchita') : r < 0.7 ? loc('Guajojó') : r < 0.85 ? loc('Café Alameda') : loc('Moda Andina');
          }
          const entrada = new Date(t + entre(3, 15) * 60_000);
          const dur = entre(10, local.categoria === 'Comida' ? 45 : 35);
          const salida = new Date(entrada.getTime() + dur * 60_000);
          if (salida.getTime() > ahora.getTime()) break;
          t = salida.getTime();
          const conCheckin = prob(0.4);
          const compra = prob(local.categoria === 'Comida' ? 0.85 : 0.55);
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
            let mult = local.categoria === 'Entretenimiento' ? 1.2 : 1;
            if (dow >= 1 && dow <= 4 && hd >= 15 && hd <= 17) mult *= 1.5;
            if (local.nombre === 'Napoli Pizzería' && dow >= 1 && dow <= 4 && hd >= 15 && hd <= 18 && off <= 40) mult *= 2;
            if (local.nombre === 'Dulce Arte' && (dow === 0 || dow === 6) && off <= 25) mult *= 2;
            const puntos = Math.floor(Math.floor(monto) * mult);
            const txId = randomUUID();
            filasTx.push([txId, randomUUID(), recintoId, c.id, local.id, elegir(local.cajeros), monto, local.categoria, null, null, 'qr', 'valida', false, puntos, salida, salida]);
            mov(c.id, 'compra', puntos, salida, `Compra de Bs ${monto.toFixed(2)}`, local.id, txId);
            evento(c.seud, 'compra.registrada', salida, { monto_bs: monto, categoria: local.categoria, puntos }, local.id);
            compras++;
          }
        }
        filasVisita.push([visitaId, recintoId, c.id, 'qr_entrada', 'Puerta Norte', llegada, off === 0 && prob(0.5) ? null : new Date(t + 5 * 60_000), puntosVisita]);
        // canje ocasional
        const s = saldo.get(c.id) ?? 0;
        if (s >= 250 && prob(0.12)) {
          const op = recompensaIds.filter((r) => r.costo <= s);
          if (op.length) {
            const r = elegir(op);
            const en = new Date(t + 2 * 60_000);
            if (en.getTime() < ahora.getTime()) {
              const localVal = r.local ?? elegir(locales).id;
              const canjeId = randomUUID();
              const base = codigoLegible(10);
              filasCanje.push([canjeId, c.id, r.id, `${base}.SEED${codigoLegible(4)}`, r.costo, 'validado', new Date(en.getTime() - 5 * 60_000), new Date(en.getTime() + 10 * 60_000), locales.find((l) => l.id === localVal)!.cajeros[0], localVal, en]);
              mov(c.id, 'canje', -r.costo, en, 'Canje de recompensa', localVal, canjeId);
              evento(c.seud, 'cupon.validado', en, { costo: r.costo }, localVal);
            }
          }
        }
        // búsquedas en la app
        if (prob(0.25)) {
          const sin = prob(0.3);
          const termino = sin ? elegir(BUSQUEDAS_SIN_RESULTADO) : elegir(elegir(locales).clave.length ? elegir(locales).clave.concat(['café']) : ['café']);
          filasBusqueda.push([recintoId, c.seud, termino, prob(0.15) ? 'jarvis' : prob(0.3) ? 'paseoya' : 'app', sin ? 0 : entero(1, 6), llegada]);
          evento(c.seud, 'busqueda.realizada', llegada, { termino, resultados: sin ? 0 : 1 });
        }
      }
    }
    console.log(`  ${N} clientes, ${compras} compras, ${filasVisita.length} visitas`);

    // -------------------------------------------------------------- PaseoYa (últimos 60 días)
    const filasPedido: unknown[][] = [];
    const filasSub: unknown[][] = [];
    const filasItem: unknown[][] = [];
    const localesProd = [...new Set(productos.map((p) => p.local))];
    for (let i = 0; i < 380; i++) {
      const c = elegir(clientes.filter((x) => x.registro >= 5));
      const off = entero(0, 59);
      if (off > c.registro) continue;
      const hora = entre(11, 20);
      const creado = instante(off, hora - 1.5);
      if (creado.getTime() > ahora.getTime()) continue;
      const franjaIni = instante(off, hora);
      const franjaFin = new Date(franjaIni.getTime() + 30 * 60_000);
      const pedidoId = randomUUID();
      const nLocales = prob(0.25) ? 2 : 1;
      const elegidos = [...new Set([elegir(localesProd), elegir(localesProd)])].slice(0, nLocales);
      let total = 0;
      const futuro = franjaFin.getTime() > ahora.getTime();
      for (const lid of elegidos) {
        const subId = randomUUID();
        const lista = productos.filter((p) => p.local === lid);
        const items = [elegir(lista), ...(prob(0.4) ? [elegir(lista)] : [])];
        let sub = 0;
        for (const it of items) {
          const cant = entero(1, 2);
          sub += it.precio * cant;
          filasItem.push([randomUUID(), subId, it.id, (await q.query('select nombre from producto where id = $1', [it.id])).rows[0].nombre, cant, it.precio]);
        }
        total += sub;
        const estado = futuro ? elegir(['recibido', 'confirmado', 'preparando', 'listo']) : prob(0.88) ? 'entregado' : 'vencido';
        const entregado = estado === 'entregado' ? new Date(franjaIni.getTime() + entre(0, 25) * 60_000) : null;
        const lc = locales.find((l) => l.id === lid)!;
        const base = codigoLegible(8);
        filasSub.push([subId, pedidoId, lid, estado, sub, `${base}.SEED${codigoLegible(4)}`, String(entero(0, 9999)).padStart(4, '0'), 'en_local',
          new Date(creado.getTime() + 5 * 60_000), ['recibido'].includes(estado) ? null : new Date(creado.getTime() + 20 * 60_000), entregado, entregado ? Math.floor(sub) : 0]);
        if (entregado) {
          const txId = randomUUID();
          filasTx.push([txId, randomUUID(), recintoId, c.id, lid, lc.cajeros[0], sub, lc.categoria, null, null, 'paseoya', 'valida', false, Math.floor(sub), entregado, entregado]);
          mov(c.id, 'paseoya', Math.floor(sub), entregado, 'Retiro PaseoYa', lid, txId);
          evento(c.seud, 'subpedido.entregado', entregado, { monto_bs: sub }, lid);
          // Tráfico inducido: compra adicional en otro local durante la misma visita
          if (prob(0.42)) {
            const otro = elegir(locales.filter((l) => l.id !== lid && l.categoria === 'Comida'));
            const monto = Math.round(entre(otro.ticket[0], otro.ticket[1] * 0.6));
            const en = new Date(entregado.getTime() + entre(10, 50) * 60_000);
            if (en.getTime() < ahora.getTime()) {
              const tx2 = randomUUID();
              filasTx.push([tx2, randomUUID(), recintoId, c.id, otro.id, otro.cajeros[0], monto, otro.categoria, null, null, 'qr', 'valida', false, monto, en, en]);
              mov(c.id, 'compra', monto, en, `Compra de Bs ${monto.toFixed(2)}`, otro.id, tx2);
              filasCheckin.push([randomUUID(), c.id, otro.id, new Date(en.getTime() - 15 * 60_000), en, true, 0, 'compra']);
              evento(c.seud, 'compra.registrada', en, { monto_bs: monto }, otro.id);
            }
          }
        }
      }
      filasPedido.push([pedidoId, recintoId, `P-${codigoLegible(6)}`, c.id, total, franjaIni, franjaFin, creado]);
    }

    // -------------------------------------------------------------- fraude plantado
    const plantar = (localNombre: string, clienteIdx: number, monto: number, offDia: number, hora: number, regla: string, detalle: string, puntaje: number, cajero = 0) => {
      const l = loc(localNombre);
      const c = clientes[clienteIdx];
      const en = instante(offDia, hora);
      const txId = randomUUID();
      filasTx.push([txId, randomUUID(), recintoId, c.id, l.id, l.cajeros[cajero], monto, l.categoria, null, null, 'qr', 'valida', false, Math.floor(monto), en, en]);
      mov(c.id, 'compra', Math.floor(monto), en, `Compra de Bs ${monto.toFixed(2)}`, l.id, txId);
      filasAlerta.push([recintoId, txId, c.id, l.id, l.cajeros[cajero], regla, detalle, puntaje, offDia > 3 ? elegir(['descartada', 'confirmada']) : 'abierta', en]);
    };
    plantar('Café Alameda', 37, 8400, 12, 16.2, 'monto_atipico', 'Bs 8.400,00 es 180σ sobre el ticket promedio del local (Bs 28,40)', 0.98);
    plantar('Heladería Frío Frío', 51, 2600, 2, 18.1, 'monto_atipico', 'Bs 2.600,00 es 95σ sobre el ticket promedio del local (Bs 24,10)', 0.95);
    for (let k = 0; k < 4; k++) plantar('Jugos Tropicales', 64, 18 + k, 1, 11 + k * 0.004, 'rafaga_compras', `${k + 1} compras del mismo cliente en este local en menos de 60 s`, 0.8);
    for (let k = 0; k < 9; k++) plantar('Gamer Zone', 88, entre(300, 900), entero(1, 12), entre(16, 20), 'par_cliente_cajero', `${k + 3} de las últimas 20 compras de este cajero son del mismo cliente`, 0.7, 1);
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
    await insertarLote(q, 'pedido', ['id', 'recinto_id', 'codigo', 'cliente_id', 'total_bs', 'franja_inicio', 'franja_fin', 'creado_en'], filasPedido);
    await insertarLote(q, 'subpedido', ['id', 'pedido_id', 'local_id', 'estado', 'total_bs', 'codigo_retiro', 'pin', 'pago', 'confirmado_en', 'listo_en', 'entregado_en', 'puntos'], filasSub);
    await insertarLote(q, 'subpedido_item', ['id', 'subpedido_id', 'producto_id', 'nombre', 'cantidad', 'precio_bs'], filasItem);
    await insertarLote(q, 'alerta_fraude', ['recinto_id', 'transaccion_id', 'cliente_id', 'local_id', 'empleado_id', 'regla', 'detalle', 'puntaje', 'estado', 'creado_en'], filasAlerta);
    await insertarLote(q, 'evento', ['recinto_id', 'id_seudonimo', 'tipo', 'payload', 'local_id', 'zona_id', 'creado_en'], filasEvento);
    console.log(`  ${filasTx.length} transacciones, ${filasMov.length} movimientos, ${filasEvento.length} eventos, ${filasPedido.length} pedidos PaseoYa`);
  });
  await db.close();

  // -------------------------------------------------------------- pasos derivados con los servicios del sistema
  console.log('Calculando segmentos (K-Means) y entrenando el modelo de anomalías…');
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
  const g = await app.get(OrientacionService).reconstruir(recinto);
  console.log(`  grafo del edificio: ${g.nodos} nodos, ${g.aristas} conexiones`);
  await app.close();
  console.log(`Listo en ${Math.round((Date.now() - t0) / 1000)} s.`);
  console.log(`
Cuentas de prueba (solo desarrollo):
  Administración  admin@paseo.bo / Admin2026!   (el código 2FA se muestra en la respuesta de login en desarrollo)
  Marketing       marketing@paseo.bo / Marketing2026!
  Analista        analista@paseo.bo / Analista2026!
  Gerente         gerente.cafealameda@paseo.bo / Gerente2026!   (gerente.<local>@paseo.bo)
  Cajero          cajero.cafealameda@paseo.bo / Cajero2026!     (cajero.<local>@paseo.bo)
  Cliente demo    70000001 / Maria2026!  (María Rojas)
  Clientes        cualquier celular sintético / Cliente2026!`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
