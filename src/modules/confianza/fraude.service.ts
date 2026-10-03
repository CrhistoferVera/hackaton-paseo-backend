import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { AuditoriaService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';
import { IsolationForest } from './domain/isolation-forest.js';

interface Hallazgo {
  regla: string;
  detalle: string;
  puntaje: number;
}

/**
 * Antifraude (HU-A14): reglas duras evaluadas dentro de la misma transacción que registra la compra,
 * más un puntaje de Isolation Forest entrenado cada 10 minutos con el historial del recinto.
 */
@Injectable()
export class FraudeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Fraude');
  private modelo = new IsolationForest(100);
  private entrenadoEn: Date | null = null;
  private muestras = 0;
  private timer?: NodeJS.Timeout;
  private inicial?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly rt: RealtimeService,
    private readonly auditoria: AuditoriaService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.inicial = setTimeout(() => void this.entrenar().catch((e) => this.log.warn(e.message)), 3000);
    this.timer = setInterval(() => void this.entrenar().catch((e) => this.log.warn(e.message)), 10 * 60_000);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.inicial);
  }

  /** Vector de rasgos de una transacción, calculado con SQL sobre el historial. */
  private async rasgos(q: Queryable, transaccionId: string): Promise<number[] | null> {
    const r = await one<any>(
      q,
      `select t.monto_bs,
              coalesce((select avg(x.monto_bs) from transaccion x where x.local_id = t.local_id and x.estado = 'valida' and x.id <> t.id), t.monto_bs) as ticket_local,
              (select count(*) from transaccion x where x.cliente_id = t.cliente_id and x.creado_en > t.creado_en - interval '24 hours' and x.creado_en <= t.creado_en)::int as compras_24h,
              extract(hour from bo(t.creado_en))::int as hora,
              (select count(*) from transaccion x where x.empleado_id = t.empleado_id and x.cliente_id = t.cliente_id and x.creado_en > t.creado_en - interval '30 days')::int as par
       from transaccion t where t.id = $1`,
      [transaccionId],
    );
    if (!r) return null;
    return [Math.log1p(Number(r.monto_bs)), Number(r.monto_bs) / Math.max(1, Number(r.ticket_local)), r.compras_24h, r.hora, r.par];
  }

  async entrenar() {
    const filas = await many<any>(
      this.db,
      `select t.monto_bs, l.ticket, extract(hour from bo(t.creado_en))::int as hora,
              (select count(*) from transaccion x where x.cliente_id = t.cliente_id and x.creado_en > t.creado_en - interval '24 hours' and x.creado_en <= t.creado_en)::int as compras_24h,
              (select count(*) from transaccion x where x.empleado_id = t.empleado_id and x.cliente_id = t.cliente_id and x.creado_en > t.creado_en - interval '30 days' and x.creado_en <= t.creado_en)::int as par
       from (select * from transaccion where estado = 'valida' order by creado_en desc limit 3000) t
       join (select local_id, avg(monto_bs) as ticket from transaccion where estado = 'valida' group by local_id) l on l.local_id = t.local_id`,
    );
    const datos = filas.map((r) => [Math.log1p(Number(r.monto_bs)), Number(r.monto_bs) / Math.max(1, Number(r.ticket)), r.compras_24h, r.hora, r.par]);
    this.modelo = new IsolationForest(100);
    this.modelo.entrenar(datos);
    this.muestras = datos.length;
    this.entrenadoEn = new Date();
    this.log.log(`modelo de anomalías entrenado con ${datos.length} transacciones`);
  }

  estadoModelo() {
    return { entrenado: this.modelo.entrenado, entrenadoEn: this.entrenadoEn, muestras: this.muestras, algoritmo: 'Isolation Forest (100 árboles, muestra 256)' };
  }

  /** Evalúa una compra recién insertada. Se llama dentro de la transacción de registro. */
  async evaluarCompra(q: Queryable, transaccionId: string): Promise<Hallazgo[]> {
    const t = await one<any>(q, 'select * from transaccion where id = $1', [transaccionId]);
    if (!t) return [];
    const hallazgos: Hallazgo[] = [];

    // Regla 1: más de 2 compras del mismo cliente en el mismo local en menos de 60 s
    const rafaga = await one<{ n: number }>(
      q,
      `select count(*)::int as n from transaccion where cliente_id = $1 and local_id = $2 and creado_en > $3::timestamptz - interval '60 seconds' and estado = 'valida'`,
      [t.cliente_id, t.local_id, t.creado_en],
    );
    if (rafaga && rafaga.n > 2) {
      hallazgos.push({ regla: 'rafaga_compras', detalle: `${rafaga.n} compras del mismo cliente en este local en menos de 60 s`, puntaje: 0.8 });
    }

    // Regla 2: monto mayor a 3 desviaciones estándar del ticket del local
    const est = await one<{ media: number; desv: number; n: number }>(
      q,
      `select avg(monto_bs)::float8 as media, coalesce(stddev_samp(monto_bs),0)::float8 as desv, count(*)::int as n
       from transaccion where local_id = $1 and estado = 'valida' and id <> $2 and creado_en > now() - interval '90 days'`,
      [t.local_id, t.id],
    );
    if (est && est.n >= 10 && est.desv > 0) {
      const z = (Number(t.monto_bs) - est.media) / est.desv;
      if (z > 3) {
        hallazgos.push({
          regla: 'monto_atipico',
          detalle: `Bs ${Number(t.monto_bs).toFixed(2)} es ${z.toFixed(0)}σ sobre el ticket promedio del local (Bs ${est.media.toFixed(2)})`,
          puntaje: Math.min(1, 0.6 + z / 50),
        });
      }
    }

    // Regla 3: un mismo cliente concentra una parte anómala de las últimas compras del comercio
    {
      const par = await one<{ total: number; delpar: number }>(
        q,
        `select count(*)::int as total, count(*) filter (where cliente_id = $2)::int as delpar
         from (select cliente_id from transaccion where local_id = $1 and estado = 'valida' order by creado_en desc limit 50) x`,
        [t.local_id, t.cliente_id],
      );
      if (par && par.total >= 10 && par.delpar >= 5 && par.delpar / par.total > 0.3) {
        hallazgos.push({
          regla: 'cliente_concentrado',
          detalle: `${par.delpar} de las últimas ${par.total} compras de este comercio son del mismo cliente`,
          puntaje: 0.7,
        });
      }
    }

    // Puntaje del modelo de anomalías
    const x = await this.rasgos(q, t.id);
    const anomalia = x ? this.modelo.puntaje(x) : 0;
    await q.query('update transaccion set puntaje_anomalia = $2 where id = $1', [t.id, anomalia]);
    if (!hallazgos.length && anomalia >= 0.72) {
      hallazgos.push({ regla: 'modelo_anomalias', detalle: `Puntaje de anomalía ${anomalia.toFixed(2)} (Isolation Forest)`, puntaje: anomalia });
    }
    if (t.offline && hallazgos.length) {
      hallazgos.forEach((h) => (h.detalle += ' · registrada sin conexión'));
    }

    for (const h of hallazgos) {
      const puntaje = Math.max(h.puntaje, anomalia);
      const a = await one(
        q,
        `insert into alerta_fraude (recinto_id, transaccion_id, cliente_id, local_id, empleado_id, regla, detalle, puntaje)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [t.recinto_id, t.id, t.cliente_id, t.local_id, t.empleado_id, h.regla, h.detalle, puntaje],
      );
      setTimeout(() => this.rt.aSala(t.recinto_id, 'alerta', a), 50);
    }
    return hallazgos;
  }

  /** Regla 5: canje inmediatamente después de acumular en operaciones con alerta abierta. */
  async evaluarCanje(q: Queryable, recintoId: string, clienteId: string, canjeId: string, costo: number) {
    const abierta = await one<{ n: number }>(
      q,
      `select count(*)::int as n from alerta_fraude where cliente_id = $1 and estado = 'abierta' and creado_en > now() - interval '24 hours'`,
      [clienteId],
    );
    if (abierta && abierta.n > 0) {
      const a = await one(
        q,
        `insert into alerta_fraude (recinto_id, cliente_id, regla, detalle, puntaje) values ($1,$2,'canje_tras_sospecha',$3,0.75) returning *`,
        [recintoId, clienteId, `Canje de ${costo} pts (cupón ${canjeId.slice(0, 8)}) con ${abierta.n} alerta(s) abierta(s) en las últimas 24 h`],
      );
      setTimeout(() => this.rt.aSala(recintoId, 'alerta', a), 50);
    }
  }

  listar(recintoId: string, estado?: string) {
    return many(
      this.db,
      `select a.*, l.nombre as local, u.nombre as cliente, e.nombre as cuenta, t.monto_bs, t.creado_en as compra_en, t.offline
       from alerta_fraude a
       left join local l on l.id = a.local_id
       left join usuario u on u.id = a.cliente_id
       left join usuario e on e.id = a.empleado_id
       left join transaccion t on t.id = a.transaccion_id
       where a.recinto_id = $1 and ($2::text is null or a.estado = $2)
       order by (a.estado = 'abierta') desc, a.puntaje desc, a.creado_en desc limit 200`,
      [recintoId, estado ?? null],
    );
  }

  async resolver(s: Sesion, id: string, estado: 'descartada' | 'confirmada') {
    const r = await this.db.tx(async (q) => {
      const antes = await one<any>(q, 'select * from alerta_fraude where id = $1 and recinto_id = $2 for update', [id, s.recintoId]);
      if (!antes) throw new NotFoundException('Alerta no encontrada');
      if (antes.estado !== 'abierta') throw new BadRequestException('La alerta ya fue revisada');
      const a = await one(q, `update alerta_fraude set estado = $2, revisado_por = $3, revisado_en = now() where id = $1 returning *`, [id, estado, s.sub]);
      await this.auditoria.registrar(q, s.sub, `alerta_${estado}`, 'alerta_fraude', id, antes, a);
      return a;
    });
    if (estado === 'confirmada' && r.transaccion_id) {
      this.bus.publicar('alerta.confirmada', { recintoId: s.recintoId, transaccionId: r.transaccion_id, adminId: s.sub });
    }
    return r;
  }

  auditoriaReciente(limite = 100) {
    return many(
      this.db,
      `select a.*, u.nombre as usuario, u.rol from auditoria a left join usuario u on u.id = a.usuario_id order by a.creado_en desc limit $1`,
      [limite],
    );
  }
}
