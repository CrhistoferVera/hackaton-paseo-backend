import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { enmascararNombre } from '../identidad/identidad.service.js';
import { LlmService } from '../ia/llm.service.js';
import { kmeans, normalizar } from './domain/kmeans.js';

const HOY = `bo(now())::date`;

/** Centro de Inteligencia: convierte eventos en respuestas a preguntas de negocio. Solo lectura. */
@Injectable()
export class InteligenciaService {
  private readonly log = new Logger('Inteligencia');

  constructor(
    private readonly db: Db,
    private readonly llm: LlmService,
  ) {}

  // ------------------------------------------------------------------ HU-A07 tablero en tiempo real
  async tablero(recintoId: string) {
    const k = await one<any>(
      this.db,
      `select
         (select count(distinct cliente_id) from (
            select cliente_id from visita where recinto_id = $1 and bo(entrada_en)::date = ${HOY}
            union select c.cliente_id from checkin_local c join local l on l.id = c.local_id where l.recinto_id = $1 and bo(c.entrada_en)::date = ${HOY}) v)::int as visitantes_hoy,
         (select count(*) from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date = ${HOY})::int as compras_hoy,
         (select coalesce(sum(monto_bs),0) from transaccion where recinto_id = $1 and estado = 'valida' and bo(creado_en)::date = ${HOY})::float8 as ventas_hoy,
         (select coalesce(sum(puntos),0) from movimiento_puntos where recinto_id = $1 and puntos > 0 and bo(creado_en)::date = ${HOY})::int as puntos_emitidos_hoy,
         (select coalesce(-sum(puntos),0) from movimiento_puntos where recinto_id = $1 and tipo in ('canje','parqueo') and bo(creado_en)::date = ${HOY})::int as puntos_canjeados_hoy,
         (select count(*) from canje c join recompensa r on r.id = c.recompensa_id where r.recinto_id = $1 and c.estado = 'validado' and bo(c.validado_en)::date = ${HOY})::int as canjes_hoy,
         (select coalesce(sum(puntos),0) from movimiento_puntos where recinto_id = $1)::int as saldo_pendiente,
         (select count(distinct id_seudonimo) from evento where recinto_id = $1 and id_seudonimo is not null and creado_en > now() - interval '60 minutes')::int as usuarios_activos,
         (select count(distinct id_seudonimo) from evento where recinto_id = $1 and id_seudonimo is not null and creado_en between now() - interval '120 minutes' and now() - interval '60 minutes')::int as usuarios_activos_previo,
         (select count(*) from evento where recinto_id = $1 and bo(creado_en)::date = ${HOY})::int as eventos_hoy,
         (select count(*) from alerta_fraude where recinto_id = $1 and estado = 'abierta')::int as alertas_abiertas`,
      [recintoId],
    );
    const zonasCalientes = await many(
      this.db,
      `select z.id, z.nombre, z.piso, count(*)::int as eventos, count(distinct e.id_seudonimo)::int as usuarios
       from evento e join zona z on z.id = e.zona_id
       where e.recinto_id = $1 and e.creado_en > now() - interval '60 minutes'
       group by z.id order by usuarios desc, eventos desc limit 5`,
      [recintoId],
    );
    const ultimasAlertas = await many(
      this.db,
      `select a.id, a.regla, a.detalle, a.puntaje, a.creado_en, l.nombre as local, t.monto_bs
       from alerta_fraude a left join local l on l.id = a.local_id left join transaccion t on t.id = a.transaccion_id
       where a.recinto_id = $1 and a.estado = 'abierta' order by a.creado_en desc limit 3`,
      [recintoId],
    );
    return { ...k, zonasCalientes, ultimasAlertas, trafico: await this.traficoInducido(recintoId, 30) };
  }

  /** KPI estrella de PaseoYa: retiros con compra adicional en otro local durante la misma visita. */
  async traficoInducido(recintoId: string, dias: number) {
    const r = await one<any>(
      this.db,
      `with retiros as (
         select s.id, p.cliente_id, s.local_id, bo(s.entregado_en)::date as dia
         from subpedido s join pedido p on p.id = s.pedido_id
         where p.recinto_id = $1 and s.estado = 'entregado' and s.entregado_en > now() - ($2 || ' days')::interval),
       extra as (
         select r.id, coalesce(sum(t.monto_bs),0) as monto, count(t.id) as compras
         from retiros r left join transaccion t on t.cliente_id = r.cliente_id and t.local_id <> r.local_id
           and bo(t.creado_en)::date = r.dia and t.estado = 'valida' and t.origen <> 'paseoya'
         group by r.id)
       select count(*)::int as retiros,
              count(*) filter (where compras > 0)::int as con_compra_adicional,
              coalesce(round(100.0 * count(*) filter (where compras > 0) / nullif(count(*),0), 1), 0)::float8 as porcentaje,
              coalesce(round(avg(monto) filter (where compras > 0), 2), 0)::float8 as monto_adicional_promedio,
              coalesce(sum(compras),0)::int as compras_adicionales
       from extra`,
      [recintoId, dias],
    );
    return r;
  }

  // ------------------------------------------------------------------ HU-A08 mapa de calor
  async calor(recintoId: string, f: { metrica: 'ventas' | 'visitas' | 'checkins' | 'permanencia'; desde?: string; hasta?: string; horaDesde?: number; horaHasta?: number }) {
    const desde = f.desde ?? (await one<{ d: string }>(this.db, `select to_char(${HOY} - 6, 'YYYY-MM-DD') as d`))!.d;
    const hasta = f.hasta ?? (await one<{ d: string }>(this.db, `select to_char(${HOY}, 'YYYY-MM-DD') as d`))!.d;
    const hD = f.horaDesde ?? 0;
    const hH = f.horaHasta ?? 23;
    const p = [recintoId, desde, hasta, hD, hH];
    let porLocal: { local_id: string; valor: number }[];
    switch (f.metrica) {
      case 'ventas':
        porLocal = await many(
          this.db,
          `select t.local_id, sum(t.monto_bs)::float8 as valor from transaccion t
           where t.recinto_id = $1 and t.estado = 'valida' and bo(t.creado_en)::date between $2::date and $3::date
             and extract(hour from bo(t.creado_en)) between $4 and $5 group by 1`,
          p,
        );
        break;
      case 'checkins':
        porLocal = await many(
          this.db,
          `select c.local_id, count(*)::float8 as valor from checkin_local c join local l on l.id = c.local_id
           where l.recinto_id = $1 and bo(c.entrada_en)::date between $2::date and $3::date and extract(hour from bo(c.entrada_en)) between $4 and $5 group by 1`,
          p,
        );
        break;
      case 'permanencia':
        porLocal = await many(
          this.db,
          `select c.local_id, avg(extract(epoch from (c.salida_en - c.entrada_en)) / 60)::float8 as valor from checkin_local c join local l on l.id = c.local_id
           where l.recinto_id = $1 and c.salida_en is not null and c.origen <> 'compra' and bo(c.entrada_en)::date between $2::date and $3::date
             and extract(hour from bo(c.entrada_en)) between $4 and $5 group by 1`,
          p,
        );
        break;
      default:
        // Visitas = check-ins en locales + Drops reclamados + llegadas de PaseoYa (por zona)
        porLocal = await many(
          this.db,
          `select c.local_id, count(*)::float8 as valor from checkin_local c join local l on l.id = c.local_id
           where l.recinto_id = $1 and bo(c.entrada_en)::date between $2::date and $3::date and extract(hour from bo(c.entrada_en)) between $4 and $5 group by 1`,
          p,
        );
    }
    const zonas = await many<{ zona_id: string; valor: number }>(
      this.db,
      f.metrica === 'permanencia'
        ? `select l.zona_id, avg(x.valor)::float8 as valor from local l join (select unnest($6::uuid[]) as local_id, unnest($7::float8[]) as valor) x on x.local_id = l.id
           where l.recinto_id = $1 and $2::text is not null and $3::text is not null and $4::int is not null and $5::int is not null group by 1`
        : `select l.zona_id, sum(x.valor)::float8 as valor from local l join (select unnest($6::uuid[]) as local_id, unnest($7::float8[]) as valor) x on x.local_id = l.id
           where l.recinto_id = $1 and $2::text is not null and $3::text is not null and $4::int is not null and $5::int is not null group by 1`,
      [...p, porLocal.map((x) => x.local_id), porLocal.map((x) => Number(x.valor))],
    );
    if (f.metrica === 'visitas') {
      const extra = await many<{ zona_id: string; n: number }>(
        this.db,
        `select zona_id, count(*)::int as n from evento where recinto_id = $1 and tipo in ('drop.reclamado','subpedido.entregado')
           and zona_id is not null and bo(creado_en)::date between $2::date and $3::date and extract(hour from bo(creado_en)) between $4 and $5 group by 1`,
        p,
      );
      for (const a of extra) {
        const z = zonas.find((x) => x.zona_id === a.zona_id);
        if (z) z.valor = Number(z.valor) + a.n;
        else zonas.push({ zona_id: a.zona_id, valor: a.n });
      }
    }
    const max = Math.max(1, ...zonas.map((z) => Number(z.valor)));
    const maxLocal = Math.max(1, ...porLocal.map((z) => Number(z.valor)));
    return { metrica: f.metrica, desde, hasta, horaDesde: hD, horaHasta: hH, zonas, locales: porLocal, max, maxLocal };
  }

  /** Serie de los últimos 60 minutos de una zona para el tooltip del mapa. */
  serieZona(recintoId: string, zonaId: string) {
    return many(
      this.db,
      `select g.min, coalesce(count(e.id),0)::int as eventos
       from generate_series(0, 55, 5) g(min)
       left join evento e on e.recinto_id = $1 and e.zona_id = $2
         and e.creado_en > now() - make_interval(mins => g.min + 5) and e.creado_en <= now() - make_interval(mins => g.min)
       group by g.min order by g.min desc`,
      [recintoId, zonaId],
    );
  }

  // ------------------------------------------------------------------ HU-A09 días y horas
  horarios(recintoId: string, dias = 90) {
    return many(
      this.db,
      `with v as (select extract(dow from bo(c.entrada_en))::int as dia, extract(hour from bo(c.entrada_en))::int as hora, count(*)::int as visitas
                  from checkin_local c join local l on l.id = c.local_id where l.recinto_id = $1 and c.entrada_en > now() - ($2 || ' days')::interval group by 1,2),
            t as (select extract(dow from bo(creado_en))::int as dia, extract(hour from bo(creado_en))::int as hora, count(*)::int as compras, sum(monto_bs)::float8 as ventas
                  from transaccion where recinto_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval group by 1,2)
       select coalesce(v.dia, t.dia) as dia, coalesce(v.hora, t.hora) as hora, coalesce(v.visitas,0) as visitas, coalesce(t.compras,0) as compras, coalesce(t.ventas,0) as ventas
       from v full outer join t on t.dia = v.dia and t.hora = v.hora order by 1,2`,
      [recintoId, dias],
    );
  }

  // ------------------------------------------------------------------ HU-A10 RFM y segmentos
  async rfm(recintoId: string) {
    const filas = await many<any>(
      this.db,
      `with base as (
         select t.cliente_id, extract(day from now() - max(t.creado_en))::int as recencia, count(*)::int as frecuencia, sum(t.monto_bs)::float8 as monto
         from transaccion t where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '180 days' group by 1),
       s as (select b.*, ntile(5) over (order by recencia desc) as r, ntile(5) over (order by frecuencia) as f, ntile(5) over (order by monto) as m from base b)
       select s.*, p.alias, (select nombre from segmento g where s.cliente_id = any(g.cliente_ids) order by creado_en desc limit 1) as segmento
       from s join cliente_perfil p on p.usuario_id = s.cliente_id order by (r + f + m) desc, monto desc limit 100`,
      [recintoId],
    );
    const distribucion = await many(
      this.db,
      `with base as (
         select t.cliente_id, extract(day from now() - max(t.creado_en))::int as recencia, count(*)::int as frecuencia, sum(t.monto_bs)::float8 as monto
         from transaccion t where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '180 days' group by 1),
       s as (select ntile(5) over (order by recencia desc) as r, ntile(5) over (order by frecuencia) as f, ntile(5) over (order by monto) as m from base)
       select case when r >= 4 and f >= 4 then 'Campeones' when r >= 3 and f >= 3 then 'Leales' when r >= 4 and f <= 2 then 'Nuevos o recientes'
                   when r <= 2 and f >= 3 then 'En riesgo' when r <= 2 then 'Dormidos' else 'Ocasionales' end as grupo, count(*)::int as clientes
       from s group by 1 order by 2 desc`,
      [recintoId],
    );
    return { clientes: filas, distribucion };
  }

  segmentos(recintoId: string) {
    return many(
      this.db,
      `select s.id, s.nombre, s.descripcion, s.tamano, s.ticket_promedio, s.horario, s.categorias, s.criterios, s.creado_en,
              (select count(*)::int from promocion p where p.segmento_id = s.id) as promociones
       from segmento s where s.recinto_id = $1 order by s.tamano desc`,
      [recintoId],
    );
  }

  /** K-Means sobre RFM, horario habitual, fin de semana y categorías. Nombres legibles por reglas o LLM. */
  async recalcularSegmentos(recintoId: string, k = 5) {
    const filas = await many<any>(
      this.db,
      `select t.cliente_id,
              extract(day from now() - max(t.creado_en))::float8 as recencia,
              count(*)::float8 as frecuencia,
              sum(t.monto_bs)::float8 as monto,
              avg(extract(hour from bo(t.creado_en)) + extract(minute from bo(t.creado_en)) / 60)::float8 as hora,
              avg(case when extract(dow from bo(t.creado_en)) in (0,6) then 1 else 0 end)::float8 as finde,
              avg(case when c.ambito = 'comida' then 1 else 0 end)::float8 as comida,
              mode() within group (order by c.nombre) as categoria_top
       from transaccion t join local l on l.id = t.local_id join categoria c on c.id = l.categoria_id
       where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '180 days' group by t.cliente_id`,
      [recintoId],
    );
    if (filas.length < k * 5) throw new BadRequestException('Hacen falta más clientes con compras para segmentar');
    const datos = filas.map((f) => [f.recencia, Math.log1p(f.frecuencia), Math.log1p(f.monto), f.hora, f.finde, f.comida]);
    const { x } = normalizar(datos);
    const { asignacion } = kmeans(x, k);
    const grupos = Array.from({ length: k }, (_, c) => filas.filter((_, i) => asignacion[i] === c));
    const resumen = grupos
      .filter((g) => g.length)
      .map((g) => {
        const media = (campo: string) => g.reduce((a, f) => a + Number(f[campo]), 0) / g.length;
        const cats = new Map<string, number>();
        g.forEach((f) => cats.set(f.categoria_top, (cats.get(f.categoria_top) ?? 0) + 1));
        return {
          clientes: g.map((f) => f.cliente_id),
          tamano: g.length,
          recencia: media('recencia'),
          frecuencia: media('frecuencia'),
          ticket: g.reduce((a, f) => a + f.monto, 0) / g.reduce((a, f) => a + f.frecuencia, 0),
          gasto: media('monto'),
          hora: media('hora'),
          finde: media('finde'),
          comida: media('comida'),
          categorias: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c),
        };
      });
    const maxGasto = Math.max(...resumen.map((r) => r.gasto));
    const usados = new Set<string>();
    for (const r of resumen) {
      let nombre: string;
      if (r.recencia > 45) nombre = 'Cliente dormido';
      else if (r.gasto === maxGasto) nombre = 'Gran comprador';
      else if (r.hora >= 11.5 && r.hora <= 14.5 && r.finde < 0.35) nombre = 'Ejecutivo del mediodía';
      else if (r.finde >= 0.5) nombre = 'Familia de fin de semana';
      else if (r.hora >= 16) nombre = 'Joven de tarde';
      else nombre = 'Visitante ocasional';
      if (usados.has(nombre)) nombre = `${nombre} · ${r.categorias[0] ?? 'variado'}`;
      usados.add(nombre);
      (r as any).nombre = nombre;
      const hh = Math.floor(r.hora);
      (r as any).horario = `${String(hh).padStart(2, '0')}:${String(Math.round((r.hora - hh) * 60)).padStart(2, '0')} promedio, ${Math.round(r.finde * 100)} % fin de semana`;
      (r as any).descripcion = `${r.tamano} clientes, ${r.frecuencia.toFixed(1)} compras en 6 meses, ticket de Bs ${r.ticket.toFixed(0)}, última compra hace ${r.recencia.toFixed(0)} días. Prefieren ${r.categorias.join(', ')}.`;
    }
    if (this.llm.disponible) {
      const texto = await this.llm.completar(
        'Nombras segmentos de clientes de un centro comercial boliviano. Devuelve solo JSON {"nombres":["..."]} con nombres de 2 a 4 palabras en español, únicos, en el mismo orden, estilo "Ejecutivo del mediodía".',
        JSON.stringify(resumen.map((r) => ({ tamano: r.tamano, recencia_dias: Math.round(r.recencia), compras: r.frecuencia.toFixed(1), ticket_bs: Math.round(r.ticket), hora: r.hora.toFixed(1), fin_de_semana: r.finde.toFixed(2), comida: r.comida.toFixed(2), categorias: r.categorias }))),
        { maxTokens: 300 },
      );
      const j = LlmService.json<{ nombres: string[] }>(texto);
      if (j?.nombres?.length === resumen.length && new Set(j.nombres).size === resumen.length) resumen.forEach((r, i) => ((r as any).nombre = j.nombres[i]));
    }
    await this.db.tx(async (q) => {
      const existentes = await many<{ id: string; nombre: string; usado: boolean }>(
        q,
        `select s.id, s.nombre, exists (select 1 from promocion p where p.segmento_id = s.id) or exists (select 1 from mision m where m.segmento_id = s.id) as usado
         from segmento s where s.recinto_id = $1`,
        [recintoId],
      );
      for (const r of resumen as any[]) {
        const e = existentes.find((x) => x.nombre === r.nombre);
        const criterios = { recencia: r.recencia, frecuencia: r.frecuencia, hora: r.hora, finde: r.finde, comida: r.comida, algoritmo: `k-means k=${k}` };
        if (e) {
          await q.query(
            `update segmento set descripcion = $2, criterios = $3, cliente_ids = $4, tamano = $5, ticket_promedio = $6, horario = $7, categorias = $8, creado_en = now() where id = $1`,
            [e.id, r.descripcion, JSON.stringify(criterios), r.clientes, r.tamano, r.ticket, r.horario, r.categorias],
          );
        } else {
          await q.query(
            `insert into segmento (recinto_id, nombre, descripcion, criterios, cliente_ids, tamano, ticket_promedio, horario, categorias) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [recintoId, r.nombre, r.descripcion, JSON.stringify(criterios), r.clientes, r.tamano, r.ticket, r.horario, r.categorias],
          );
        }
      }
      const nuevos = new Set(resumen.map((r: any) => r.nombre));
      for (const e of existentes) {
        if (!nuevos.has(e.nombre)) {
          if (e.usado) await q.query(`update segmento set cliente_ids = '{}', tamano = 0 where id = $1`, [e.id]);
          else await q.query('delete from segmento where id = $1', [e.id]);
        }
      }
    });
    return this.segmentos(recintoId);
  }

  // ------------------------------------------------------------------ HU-A11 matriz de afinidad
  async afinidad(recintoId: string, modo: 'mes' | 'visita', top = 12) {
    const locales = await many<{ id: string; nombre: string; categoria: string }>(
      this.db,
      `select l.id, l.nombre, c.nombre as categoria from transaccion t join local l on l.id = t.local_id join categoria c on c.id = l.categoria_id
       where t.recinto_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '30 days'
       group by l.id, c.nombre order by count(distinct t.cliente_id) desc limit $2`,
      [recintoId, top],
    );
    const ids = locales.map((l) => l.id);
    const clave = modo === 'visita' ? `t.cliente_id::text || bo(t.creado_en)::date::text` : `t.cliente_id::text`;
    const pares = await many<{ a: string; b: string; comunes: number }>(
      this.db,
      `with x as (select distinct ${clave} as k, t.local_id from transaccion t where t.recinto_id = $1 and t.estado = 'valida'
                  and t.creado_en > now() - interval '30 days' and t.local_id = any($2::uuid[]))
       select a.local_id as a, b.local_id as b, count(*)::int as comunes from x a join x b on a.k = b.k group by 1,2`,
      [recintoId, ids],
    );
    const base = new Map(pares.filter((p) => p.a === p.b).map((p) => [p.a, p.comunes]));
    const matriz = locales.map((la) =>
      locales.map((lb) => {
        if (la.id === lb.id) return null;
        const p = pares.find((x) => x.a === la.id && x.b === lb.id);
        if (!p || p.comunes < 5) return null; // k-anonimato
        return Math.round((1000 * p.comunes) / (base.get(la.id) ?? 1)) / 10;
      }),
    );
    return { modo, locales, matriz, descripcion: modo === 'visita' ? '% de las visitas con compra en A que también compraron en B el mismo día' : '% de clientes de A que también compraron en B en los últimos 30 días' };
  }

  // ------------------------------------------------------------------ HU-A12 embudo e imanes
  embudo(recintoId: string, dias = 30) {
    return many(
      this.db,
      `with c as (
         select k.*, row_number() over (partition by k.cliente_id, bo(k.entrada_en)::date order by k.entrada_en) as orden
         from checkin_local k join local l on l.id = k.local_id where l.recinto_id = $1 and k.entrada_en > now() - ($2 || ' days')::interval),
       agg as (
         select local_id,
                count(*) filter (where origen = 'qr')::int as checkins,
                count(*) filter (where origen = 'qr' and con_compra)::int as checkins_con_compra,
                count(*) filter (where orden = 1)::int as primera_parada,
                count(*)::int as visitas
         from c group by local_id),
       compras as (select local_id, count(*)::int as compras, count(distinct cliente_id)::int as clientes, sum(monto_bs)::float8 as ventas
                   from transaccion where recinto_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval group by 1)
       select l.id, l.nombre, l.piso, l.numero_local, cat.nombre as categoria,
              coalesce(a.checkins,0) as checkins, coalesce(a.checkins_con_compra,0) as checkins_con_compra,
              coalesce(co.compras,0) as compras, coalesce(co.clientes,0) as clientes, coalesce(co.ventas,0) as ventas,
              case when coalesce(a.checkins,0) > 0 then round(100.0 * a.checkins_con_compra / a.checkins, 1) end::float8 as conversion,
              case when coalesce(a.visitas,0) > 0 then round(100.0 * a.primera_parada / a.visitas, 1) end::float8 as primera_parada_pct,
              case when coalesce(a.visitas,0) < 10 then 'sin datos'
                   when 1.0 * a.primera_parada / a.visitas >= 0.45 then 'imán'
                   when 1.0 * a.primera_parada / a.visitas <= 0.2 then 'dependiente' else 'mixto' end as rol
       from local l join categoria cat on cat.id = l.categoria_id left join agg a on a.local_id = l.id left join compras co on co.local_id = l.id
       where l.recinto_id = $1 and l.activo order by primera_parada_pct desc nulls last`,
      [recintoId, dias],
    );
  }

  // ------------------------------------------------------------------ HU-A13 demanda insatisfecha
  demanda(recintoId: string, dias = 90) {
    return many(
      this.db,
      `select lower(termino) as termino, count(*)::int as veces,
              count(*) filter (where origen = 'app')::int as app, count(*) filter (where origen = 'jarvis')::int as jarvis,
              count(*) filter (where origen = 'paseoya')::int as paseoya, max(creado_en) as ultima
       from busqueda where recinto_id = $1 and resultados = 0 and creado_en > now() - ($2 || ' days')::interval
       group by 1 order by veces desc limit 40`,
      [recintoId, dias],
    );
  }

  // ------------------------------------------------------------------ HU-A16 retorno de promociones y misiones
  async roi(recintoId: string) {
    const regla = await one<{ bs_por_punto: number; valor_punto_bs: number }>(this.db, 'select bs_por_punto, valor_punto_bs from regla_puntos where recinto_id = $1 and vigente', [recintoId]);
    const promociones = await many<any>(
      this.db,
      `with p as (
         select pr.*, least(pr.fin, ${HOY}) as fin_real, (least(pr.fin, ${HOY}) - pr.inicio + 1) as dias
         from promocion pr where pr.recinto_id = $1 and pr.estado = 'aprobada' and pr.tipo = 'puntos_dobles' and pr.inicio <= ${HOY})
       select p.id, p.titulo, p.multiplicador, p.inicio, p.fin, l.nombre as local, s.nombre as segmento, p.dias,
         (select coalesce(sum(t.puntos - floor(t.monto_bs / $2)),0) from transaccion t where t.local_id = p.local_id and t.estado = 'valida'
            and bo(t.creado_en)::date between p.inicio and p.fin_real and extract(dow from bo(t.creado_en))::int = any(p.dias_semana)
            and bo(t.creado_en)::time between p.hora_inicio and p.hora_fin)::int as puntos_invertidos,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.local_id = p.local_id and t.estado = 'valida' and bo(t.creado_en)::date between p.inicio and p.fin_real)::float8 as ventas,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.local_id = p.local_id and t.estado = 'valida' and bo(t.creado_en)::date between p.inicio - p.dias and p.inicio - 1)::float8 as ventas_previas,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.recinto_id = $1 and t.local_id <> p.local_id and t.estado = 'valida' and bo(t.creado_en)::date between p.inicio and p.fin_real)::float8 as control,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.recinto_id = $1 and t.local_id <> p.local_id and t.estado = 'valida' and bo(t.creado_en)::date between p.inicio - p.dias and p.inicio - 1)::float8 as control_previo,
         (select count(distinct t.cliente_id) from transaccion t where t.local_id = p.local_id and t.estado = 'valida' and bo(t.creado_en)::date between p.inicio and p.fin_real
            and t.puntos > floor(t.monto_bs / $2))::int as clientes_alcanzados
       from p left join local l on l.id = p.local_id left join segmento s on s.id = p.segmento_id
       where p.local_id is not null order by p.inicio desc`,
      [recintoId, regla!.bs_por_punto],
    );
    const misiones = await many<any>(
      this.db,
      `with m as (select case when origen = 'ia' then 'Misiones personalizadas por IA' else nombre end as nombre, id, vigencia_desde, least(vigencia_hasta, ${HOY}) as hasta, origen
                  from mision where recinto_id = $1 and vigencia_desde <= ${HOY}),
       g as (select nombre, min(vigencia_desde) as desde, max(hasta) as hasta, array_agg(id) as ids from m group by nombre),
       comp as (select g.nombre, p.cliente_id from g join progreso_mision p on p.mision_id = any(g.ids) and p.completada_en is not null group by 1,2)
       select g.nombre, g.desde, g.hasta,
         (select coalesce(sum(mp.puntos),0) from movimiento_puntos mp where mp.tipo = 'mision' and mp.referencia_id = any(g.ids))::int as puntos_invertidos,
         (select count(*) from comp where comp.nombre = g.nombre)::int as completaron,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.estado = 'valida' and t.cliente_id in (select cliente_id from comp where comp.nombre = g.nombre)
            and bo(t.creado_en)::date between g.desde and g.hasta)::float8 as ventas_completadores,
         (select coalesce(sum(t.monto_bs),0) from transaccion t where t.estado = 'valida' and t.cliente_id in (select cliente_id from comp where comp.nombre = g.nombre)
            and bo(t.creado_en)::date between g.desde - (g.hasta - g.desde + 1) and g.desde - 1)::float8 as ventas_previas_completadores
       from g order by puntos_invertidos desc`,
      [recintoId],
    );
    const v = Number(regla!.valor_punto_bs);
    const crec = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
    return {
      valorPuntoBs: v,
      promociones: promociones.map((p) => {
        const costo = p.puntos_invertidos * v;
        const lift = (crec(p.ventas, p.ventas_previas) ?? 0) - (crec(p.control, p.control_previo) ?? 0);
        const incremental = p.ventas_previas > 0 ? Math.max(0, p.ventas - p.ventas_previas * (p.control_previo > 0 ? p.control / p.control_previo : 1)) : 0;
        return {
          ...p,
          costoBs: costo,
          crecimientoLocal: crec(p.ventas, p.ventas_previas),
          crecimientoControl: crec(p.control, p.control_previo),
          liftPp: Math.round(lift * 10) / 10,
          ventasIncrementales: Math.round(incremental),
          retorno: costo > 0 ? Math.round((incremental / costo) * 10) / 10 : null,
        };
      }),
      misiones: misiones.map((m) => ({
        ...m,
        costoBs: m.puntos_invertidos * v,
        crecimientoCompletadores: crec(m.ventas_completadores, m.ventas_previas_completadores),
      })),
    };
  }

  // ------------------------------------------------------------------ HU-A19 cohortes
  async cohortes(recintoId: string, meses = 6) {
    const filas = await many<any>(
      this.db,
      `with c as (select u.id, date_trunc('month', bo(u.creado_en))::date as cohorte from usuario u
                  where u.recinto_id = $1 and u.rol = 'cliente' and u.creado_en > date_trunc('month', now()) - ($2 || ' months')::interval),
            act as (select cliente_id, date_trunc('month', bo(creado_en))::date as mes from transaccion where recinto_id = $1 and estado = 'valida'
                    union select cliente_id, date_trunc('month', bo(entrada_en))::date from visita where recinto_id = $1)
       select to_char(c.cohorte, 'YYYY-MM') as cohorte, count(distinct c.id)::int as tamano,
              ((extract(year from a.mes) - extract(year from c.cohorte)) * 12 + extract(month from a.mes) - extract(month from c.cohorte))::int as mes_rel,
              count(distinct a.cliente_id)::int as activos
       from c left join act a on a.cliente_id = c.id and a.mes >= c.cohorte
       group by 1, 3 order by 1, 3`,
      [recintoId, meses - 1],
    );
    const tamanos = await many<any>(
      this.db,
      `select to_char(date_trunc('month', bo(creado_en)), 'YYYY-MM') as cohorte, count(*)::int as tamano from usuario
       where recinto_id = $1 and rol = 'cliente' and creado_en > date_trunc('month', now()) - ($2 || ' months')::interval group by 1 order by 1`,
      [recintoId, meses - 1],
    );
    return tamanos.map((t) => ({
      cohorte: t.cohorte,
      tamano: t.tamano,
      retencion: Array.from({ length: meses }, (_, i) => {
        const f = filas.find((x) => x.cohorte === t.cohorte && x.mes_rel === i);
        return f ? Math.round((1000 * f.activos) / t.tamano) / 10 : null;
      }),
    }));
  }

  // ------------------------------------------------------------------ HU-L08, L09, L12 panel del local
  async panelLocal(localId: string, dias = 30) {
    const k = await one<any>(
      this.db,
      `with t as (select * from transaccion where local_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval),
            primeras as (select cliente_id, min(creado_en) as primera from transaccion where local_id = $1 and estado = 'valida' group by 1)
       select count(distinct t.cliente_id)::int as clientes_unicos,
              count(distinct t.cliente_id) filter (where p.primera > now() - ($2 || ' days')::interval)::int as nuevos,
              count(distinct t.cliente_id) filter (where p.primera <= now() - ($2 || ' days')::interval)::int as recurrentes,
              count(*)::int as compras, coalesce(sum(t.monto_bs),0)::float8 as ventas, coalesce(avg(t.monto_bs),0)::float8 as ticket_promedio,
              coalesce(sum(t.puntos),0)::int as puntos_asignados
       from t left join primeras p on p.cliente_id = t.cliente_id`,
      [localId, dias],
    );
    const horas = await many(
      this.db,
      `select extract(hour from bo(creado_en))::int as hora, count(*)::int as compras, sum(monto_bs)::float8 as ventas
       from transaccion where local_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval group by 1 order by 1`,
      [localId, dias],
    );
    const porDia = await many(
      this.db,
      `select to_char(bo(creado_en)::date, 'YYYY-MM-DD') as fecha, count(*)::int as compras, sum(monto_bs)::float8 as ventas, count(distinct cliente_id)::int as clientes
       from transaccion where local_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval group by 1 order by 1`,
      [localId, dias],
    );
    const conversion = await one(
      this.db,
      `select count(*)::int as checkins, count(*) filter (where con_compra)::int as con_compra from checkin_local
       where local_id = $1 and origen = 'qr' and entrada_en > now() - ($2 || ' days')::interval`,
      [localId, dias],
    );
    return { dias, ...k, horas, porDia, conversion };
  }

  async ranking(localId: string, dias = 90) {
    const filas = await many<any>(
      this.db,
      `select t.cliente_id, u.nombre, p.alias, p.mostrar_nombre_locales, count(*)::int as compras, sum(t.monto_bs)::float8 as gasto, max(t.creado_en) as ultima
       from transaccion t join usuario u on u.id = t.cliente_id join cliente_perfil p on p.usuario_id = t.cliente_id
       where t.local_id = $1 and t.estado = 'valida' and t.creado_en > now() - ($2 || ' days')::interval and u.estado = 'activo'
       group by 1,2,3,4`,
      [localId, dias],
    );
    const vista = (f: any) => ({ cliente: f.mostrar_nombre_locales ? enmascararNombre(f.nombre) : f.alias, autorizado: f.mostrar_nombre_locales, compras: f.compras, gasto: f.gasto, ultima: f.ultima });
    return {
      porGasto: [...filas].sort((a, b) => b.gasto - a.gasto).slice(0, 10).map(vista),
      porFrecuencia: [...filas].sort((a, b) => b.compras - a.compras || b.gasto - a.gasto).slice(0, 10).map(vista),
    };
  }

  categoriasLocal(localId: string, dias = 90) {
    return many(
      this.db,
      `select coalesce(categoria, 'Sin categoría') as categoria, count(*)::int as compras, sum(monto_bs)::float8 as ventas, count(distinct cliente_id)::int as clientes
       from transaccion where local_id = $1 and estado = 'valida' and creado_en > now() - ($2 || ' days')::interval group by 1 order by ventas desc`,
      [localId, dias],
    );
  }

  // ------------------------------------------------------------------ HU-Y18 pedidos y tráfico inducido
  async pedidosAdmin(recintoId: string, dias = 30) {
    const estados = await many(
      this.db,
      `select s.estado, count(*)::int as subpedidos, sum(s.total_bs)::float8 as total from subpedido s join pedido p on p.id = s.pedido_id
       where p.recinto_id = $1 and p.creado_en > now() - ($2 || ' days')::interval group by 1`,
      [recintoId, dias],
    );
    const locales = await many(
      this.db,
      `select l.nombre, count(*)::int as subpedidos, count(*) filter (where s.estado = 'entregado')::int as entregados, sum(s.total_bs) filter (where s.estado = 'entregado')::float8 as ventas
       from subpedido s join pedido p on p.id = s.pedido_id join local l on l.id = s.local_id
       where p.recinto_id = $1 and p.creado_en > now() - ($2 || ' days')::interval group by 1 order by subpedidos desc`,
      [recintoId, dias],
    );
    const recientes = await many(
      this.db,
      `select p.codigo, p.creado_en, p.total_bs, p.franja_inicio, (select string_agg(l.nombre || ': ' || s.estado, ' · ') from subpedido s join local l on l.id = s.local_id where s.pedido_id = p.id) as detalle
       from pedido p where p.recinto_id = $1 order by p.creado_en desc limit 20`,
      [recintoId],
    );
    return { estados, locales, recientes, trafico: await this.traficoInducido(recintoId, dias) };
  }

  // ------------------------------------------------------------------ HU-X03 contador y HU-X06 resumen del día
  async eventosHoy(recintoId: string) {
    return one(this.db, `select count(*)::int as eventos from evento where recinto_id = $1 and bo(creado_en)::date = ${HOY}`, [recintoId]);
  }

  async resumenDelDia(recintoId: string) {
    const zonas = await many<any>(
      this.db,
      `with hoy as (
         select z.id, z.nombre, z.piso, count(*)::float8 as n from checkin_local c join local l on l.id = c.local_id join zona z on z.id = l.zona_id
         where l.recinto_id = $1 and bo(c.entrada_en)::date = ${HOY} and bo(c.entrada_en)::time <= bo(now())::time group by z.id),
       antes as (
         select z.id, count(*)::float8 / 4 as n from checkin_local c join local l on l.id = c.local_id join zona z on z.id = l.zona_id
         where l.recinto_id = $1 and bo(c.entrada_en)::date in (${HOY} - 7, ${HOY} - 14, ${HOY} - 21, ${HOY} - 28)
           and bo(c.entrada_en)::time <= bo(now())::time group by z.id)
       select z.nombre, z.piso, coalesce(h.n,0) as hoy, coalesce(a.n,0) as promedio,
              case when coalesce(a.n,0) > 0 then round((100 * (coalesce(h.n,0) - a.n) / a.n)::numeric, 0)::int end as variacion
       from zona z left join hoy h on h.id = z.id left join antes a on a.id = z.id where z.recinto_id = $1 order by variacion desc nulls last`,
      [recintoId],
    );
    const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(Date.now() - 4 * 3600_000).getUTCDay()];
    const trafico = await this.traficoInducido(recintoId, 1);
    const validas = zonas.filter((z) => z.variacion !== null);
    const sube = validas[0];
    const baja = validas[validas.length - 1];
    const frases: string[] = [];
    if (sube) frases.push(`Hoy ${sube.nombre} (${sube.piso}) ${sube.variacion >= 0 ? 'crece' : 'cae'} ${Math.abs(sube.variacion)} % sobre el ${dia} promedio a esta hora.`);
    if (baja && baja !== sube) frases.push(`${baja.nombre} (${baja.piso}) está ${Math.abs(baja.variacion)} % ${baja.variacion < 0 ? 'por debajo' : 'por encima'} de su media; es candidata para un Drop.`);
    frases.push(
      trafico.retiros
        ? `Los retiros de PaseoYa generaron ${trafico.compras_adicionales} compras adicionales (${trafico.porcentaje} % de los retiros).`
        : 'Todavía no hay retiros de PaseoYa hoy.',
    );
    let texto = frases.join(' ');
    if (this.llm.disponible) {
      const r = await this.llm.completar(
        'Eres el analista del Centro de Inteligencia de Paseo Aranjuez. Reescribe el resumen en exactamente 3 frases en español, concretas, con los mismos números, sin inventar datos ni usar emojis.',
        JSON.stringify({ dia, zonas: validas.slice(0, 6), trafico, borrador: texto }),
        { maxTokens: 220 },
      );
      if (r) texto = r;
    }
    return { texto, generadoPor: this.llm.disponible ? 'llm' : 'plantilla', zonas, trafico };
  }

  // ------------------------------------------------------------------ HU-A15 pregúntale a tus datos
  private readonly esquemaOro = `
Vistas disponibles (esquema oro, solo lectura, agregadas, sin datos personales):
- oro.ventas_local_dia(local text, categoria text, piso text, sector text, fecha date, compras int, ventas_bs numeric, clientes_unicos int, ticket_promedio numeric)
- oro.ventas_hora(dia_semana int 0=domingo, hora int, compras int, ventas_bs numeric)
- oro.visitas_zona_hora(zona text, piso text, fecha date, hora int, checkins int, clientes_unicos int)
- oro.afinidad_locales(local_a text, local_b text, clientes_comunes int, pct_de_a numeric)  -- % de clientes de A que también compran en B
- oro.afinidad_mismo_dia(local_a text, local_b text, visitas_compartidas int)
- oro.busquedas_sin_resultado(termino text, origen text, veces int, ultima_vez timestamptz)
- oro.economia_puntos(fecha date, emitidos int, canjeados int, vencidos int)
- oro.clientes_perfil(zona_residencia text, rango_edad text, genero text, clientes int)
- oro.pedidos_paseoya(local text, estado text, fecha date, subpedidos int, total_bs numeric)
- oro.segmentos(nombre text, descripcion text, tamano int, ticket_promedio numeric, horario text, categorias text[])
La fecha de hoy en Bolivia es bo(now())::date. Los pisos son Planta baja (T) y niveles 1 a 4 (N1 a N4).`;

  private validarSql(sql: string) {
    const s = sql.trim().replace(/;+\s*$/, '');
    const bajo = s.toLowerCase();
    if (!/^(select|with)\b/.test(bajo)) throw new BadRequestException('La consulta generada no es de solo lectura');
    if (s.includes(';')) throw new BadRequestException('La consulta generada tiene varias sentencias');
    if (/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|execute|call|do|vacuum|listen|notify|set|reset)\b/.test(bajo) || /pg_|information_schema/.test(bajo)) {
      throw new BadRequestException('La consulta generada usa operaciones no permitidas');
    }
    const ctes = new Set([...bajo.matchAll(/(\w+)\s+as\s*\(/g)].map((m) => m[1]));
    for (const m of bajo.matchAll(/\b(from|join)\s+([a-z_][\w.]*)/g)) {
      const rel = m[2];
      if (!rel.startsWith('oro.') && !ctes.has(rel) && rel !== 'generate_series' && rel !== 'unnest') {
        throw new BadRequestException(`La consulta generada accede a «${rel}», fuera de las vistas oro`);
      }
    }
    return s;
  }

  private async ejecutarSoloLectura(sql: string) {
    return this.db.tx(async (q) => {
      await q.query('set transaction read only');
      await q.query(`set local statement_timeout = 3000`).catch(() => undefined);
      const r = await q.query(`select * from (${sql}) consulta limit 500`);
      return r.rows;
    });
  }

  private plantillas(pregunta: string): { sql: string; grafico: any; titulo: string } | null {
    const p = pregunta.toLowerCase();
    const conLocal = /(?:con|y)\s+(?:el|la|los|las)?\s*([a-záéíóúñ0-9 ]+?)\??$/i.exec(pregunta.trim());
    if (/compart|afinidad|tambi[eé]n compran|clientes en com[uú]n/.test(p) && conLocal) {
      const nombre = conLocal[1].trim().replace(/'/g, "''");
      return {
        titulo: `Locales que comparten clientes con ${conLocal[1].trim()}`,
        sql: `select local_b as local, clientes_comunes, pct_de_a as porcentaje from oro.afinidad_locales where local_a ilike '%${nombre}%' order by pct_de_a desc limit 8`,
        grafico: { tipo: 'barra', x: 'local', y: 'porcentaje', unidad: '%' },
      };
    }
    if (/sin resultado|no encuentra|no existe|qu[eé] tiendas (traer|faltan)|demanda/.test(p)) {
      return { titulo: 'Búsquedas sin resultado', sql: `select termino, sum(veces)::int as veces from oro.busquedas_sin_resultado group by termino order by veces desc limit 10`, grafico: { tipo: 'barra', x: 'termino', y: 'veces' } };
    }
    if (/hora|pico|concurrid|d[ií]a de la semana/.test(p)) {
      return { titulo: 'Horas con más compras', sql: `select hora || ':00' as hora, sum(compras)::int as compras, round(sum(ventas_bs))::int as ventas_bs from oro.ventas_hora group by 1 order by compras desc limit 12`, grafico: { tipo: 'barra', x: 'hora', y: 'compras' } };
    }
    if (/punto|econom|canje|vencid/.test(p)) {
      return { titulo: 'Puntos de los últimos 30 días', sql: `select fecha, emitidos, canjeados, vencidos from oro.economia_puntos where fecha > bo(now())::date - 30 order by fecha`, grafico: { tipo: 'linea', x: 'fecha', y: 'emitidos' } };
    }
    if (/segment/.test(p)) {
      return { titulo: 'Segmentos de clientes', sql: `select nombre, tamano, round(ticket_promedio)::int as ticket_bs, horario from oro.segmentos order by tamano desc`, grafico: { tipo: 'barra', x: 'nombre', y: 'tamano' } };
    }
    if (/categor/.test(p)) {
      return { titulo: 'Ventas por categoría (30 días)', sql: `select categoria, round(sum(ventas_bs))::int as ventas_bs, sum(compras)::int as compras from oro.ventas_local_dia where fecha > bo(now())::date - 30 group by categoria order by ventas_bs desc`, grafico: { tipo: 'barra', x: 'categoria', y: 'ventas_bs', unidad: 'Bs' } };
    }
    if (/edad|g[eé]nero|zona de residencia|de d[oó]nde|perfil/.test(p)) {
      return { titulo: 'Clientes por zona de residencia', sql: `select zona_residencia, sum(clientes)::int as clientes from oro.clientes_perfil group by zona_residencia order by clientes desc limit 10`, grafico: { tipo: 'barra', x: 'zona_residencia', y: 'clientes' } };
    }
    if (/paseoya|pedido|retiro/.test(p)) {
      return { titulo: 'PaseoYa por local (30 días)', sql: `select local, sum(subpedidos)::int as subpedidos, round(sum(total_bs))::int as total_bs from oro.pedidos_paseoya where fecha > bo(now())::date - 30 and estado = 'entregado' group by local order by total_bs desc limit 10`, grafico: { tipo: 'barra', x: 'local', y: 'total_bs', unidad: 'Bs' } };
    }
    if (/piso|zona|visita/.test(p)) {
      return { titulo: 'Check-ins por zona (7 días)', sql: `select zona || ' · ' || piso as zona, sum(checkins)::int as checkins from oro.visitas_zona_hora where fecha > bo(now())::date - 7 group by 1 order by checkins desc`, grafico: { tipo: 'barra', x: 'zona', y: 'checkins' } };
    }
    if (/vend|ventas|local|tienda|ticket/.test(p)) {
      return { titulo: 'Locales con más ventas (30 días)', sql: `select local, round(sum(ventas_bs))::int as ventas_bs, sum(compras)::int as compras, round(avg(ticket_promedio))::int as ticket_bs from oro.ventas_local_dia where fecha > bo(now())::date - 30 group by local order by ventas_bs desc limit 10`, grafico: { tipo: 'barra', x: 'local', y: 'ventas_bs', unidad: 'Bs' } };
    }
    return null;
  }

  private redactar(titulo: string, filas: any[], grafico: any) {
    if (!filas.length) return `No hay datos suficientes para responder (los grupos con menos de 5 clientes se ocultan).`;
    const x = grafico?.x;
    const y = grafico?.y;
    if (x && y && filas[0][x] !== undefined && filas[0][y] !== undefined) {
      const top = filas.slice(0, 3).map((f) => `${f[x]} (${Number(f[y]).toLocaleString('es-BO')}${grafico.unidad === '%' ? ' %' : grafico.unidad === 'Bs' ? ' Bs' : ''})`);
      return `${titulo}: ${top.join(', ')}${filas.length > 3 ? ` y ${filas.length - 3} más` : ''}.`;
    }
    return `${titulo}: ${filas.length} filas.`;
  }

  async preguntar(recintoId: string, usuarioId: string, pregunta: string) {
    let sql: string;
    let grafico: any;
    let titulo = pregunta;
    let fuente: 'llm' | 'plantilla' = 'plantilla';
    let respuesta: string | null = null;
    const gen = this.llm.disponible
      ? LlmService.json<{ sql: string; grafico: any; titulo: string }>(
          await this.llm.completar(
            `Traduces preguntas de negocio a SQL de PostgreSQL de solo lectura.${this.esquemaOro}
Reglas: usa solo esas vistas; una sola sentencia SELECT; nunca más de 50 filas; nombres de columna en español sin espacios.
Responde solo JSON: {"titulo":"...","sql":"...","grafico":{"tipo":"barra|linea|tabla","x":"columna","y":"columna","unidad":"Bs|%|"}}`,
            pregunta,
            { modelo: this.llm.modeloSql, maxTokens: 700 },
          ),
        )
      : null;
    if (gen?.sql) {
      sql = gen.sql;
      grafico = gen.grafico;
      titulo = gen.titulo ?? pregunta;
      fuente = 'llm';
    } else {
      const t = this.plantillas(pregunta);
      if (!t) {
        return {
          pregunta, titulo: pregunta, sql: null, filas: [], grafico: null, fuente,
          respuesta: 'No supe traducir esa pregunta. Prueba con: ventas por local, horas pico, búsquedas sin resultado, segmentos, puntos o «¿qué locales comparten más clientes con el cine?».',
        };
      }
      ({ sql, grafico, titulo } = t);
    }
    const seguro = this.validarSql(sql);
    let filas: any[];
    try {
      filas = await this.ejecutarSoloLectura(seguro);
    } catch (e: any) {
      throw new BadRequestException(`La consulta falló: ${e.message}`);
    }
    if (fuente === 'llm') {
      respuesta = await this.llm.completar(
        'Respondes en 1 o 2 frases en español a un gerente de centro comercial, con los números del resultado, sin inventar nada.',
        JSON.stringify({ pregunta, filas: filas.slice(0, 20) }),
        { maxTokens: 200 },
      );
    }
    await this.db.query(`insert into auditoria (usuario_id, accion, entidad, despues) values ($1, 'consulta_nl', 'oro', $2)`, [usuarioId, JSON.stringify({ pregunta, sql: seguro, fuente })]);
    return { pregunta, titulo, sql: seguro, filas, grafico, fuente, respuesta: respuesta ?? this.redactar(titulo, filas, grafico) };
  }
}
