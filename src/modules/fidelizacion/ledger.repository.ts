import { Injectable } from '@nestjs/common';
import { Queryable, many, one } from '../../infra/db/db.js';

export type TipoMovimiento =
  | 'compra' | 'canje' | 'transferencia' | 'bono' | 'vencimiento' | 'anulacion' | 'referido'
  | 'mision' | 'descubrimiento' | 'visita' | 'drop' | 'hito' | 'parqueo' | 'paseoya' | 'factura';

export interface NuevoMovimiento {
  recintoId: string;
  clienteId: string;
  tipo: TipoMovimiento;
  puntos: number;
  referenciaId?: string | null;
  localId?: string | null;
  descripcion: string;
  venceEn?: Date | null;
  reglaVersion?: number | null;
}

/**
 * Repositorio del libro mayor. Solo inserta movimientos: el saldo es la suma de puntos
 * y los lotes positivos llevan `restante` para consumir en orden FIFO y vencer.
 */
@Injectable()
export class LedgerRepository {
  /** Bloquea al cliente para serializar débitos concurrentes (RNF-02). */
  async bloquearCliente(q: Queryable, clienteId: string) {
    await q.query('select id from usuario where id = $1 for update', [clienteId]);
  }

  async insertar(q: Queryable, m: NuevoMovimiento) {
    return one(
      q,
      `insert into movimiento_puntos (recinto_id, cliente_id, tipo, puntos, restante, referencia_id, local_id, descripcion, vence_en, regla_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        m.recintoId, m.clienteId, m.tipo, m.puntos, m.puntos > 0 ? m.puntos : 0,
        m.referenciaId ?? null, m.localId ?? null, m.descripcion, m.venceEn ?? null, m.reglaVersion ?? null,
      ],
    );
  }

  async saldo(q: Queryable, clienteId: string): Promise<number> {
    const r = await one<{ s: number }>(q, 'select coalesce(sum(puntos),0)::int as s from movimiento_puntos where cliente_id = $1', [clienteId]);
    return Number(r?.s ?? 0);
  }

  /** Puntos reservados por cupones emitidos que aún no se validan ni vencen. */
  async reservado(q: Queryable, clienteId: string): Promise<number> {
    const r = await one<{ s: number }>(
      q,
      `select coalesce(sum(costo_puntos),0)::int as s from canje where cliente_id = $1 and estado = 'emitido' and expira_en > now()`,
      [clienteId],
    );
    return Number(r?.s ?? 0);
  }

  /** Consume lotes del más antiguo al más nuevo (FIFO por vencimiento). */
  async consumirLotes(q: Queryable, clienteId: string, puntos: number) {
    let pendiente = puntos;
    const lotes = await many<{ id: string; restante: number }>(
      q,
      `select id, restante from movimiento_puntos where cliente_id = $1 and restante > 0 order by vence_en nulls last, creado_en for update`,
      [clienteId],
    );
    for (const l of lotes) {
      if (pendiente <= 0) break;
      const usar = Math.min(l.restante, pendiente);
      await q.query('update movimiento_puntos set restante = restante - $2 where id = $1', [l.id, usar]);
      pendiente -= usar;
    }
  }

  ganados12m(q: Queryable, clienteId: string) {
    return one<{ s: number }>(
      q,
      `select coalesce(sum(puntos),0)::int as s from movimiento_puntos
       where cliente_id = $1 and puntos > 0 and creado_en > now() - interval '12 months'`,
      [clienteId],
    ).then((r) => Number(r?.s ?? 0));
  }

  porVencer(q: Queryable, clienteId: string) {
    return many<{ fecha: string; puntos: number }>(
      q,
      `select to_char(bo(vence_en), 'YYYY-MM-DD') as fecha, sum(restante)::int as puntos
       from movimiento_puntos where cliente_id = $1 and restante > 0 and vence_en is not null and vence_en > now()
       group by 1 order by 1 limit 3`,
      [clienteId],
    );
  }

  listar(q: Queryable, clienteId: string, f: { tipo?: string; desde?: string; hasta?: string; limite?: number }) {
    const cond = ['m.cliente_id = $1'];
    const p: unknown[] = [clienteId];
    if (f.tipo) {
      p.push(f.tipo);
      cond.push(`m.tipo = $${p.length}`);
    }
    if (f.desde) {
      p.push(f.desde);
      cond.push(`bo(m.creado_en)::date >= $${p.length}::date`);
    }
    if (f.hasta) {
      p.push(f.hasta);
      cond.push(`bo(m.creado_en)::date <= $${p.length}::date`);
    }
    p.push(f.limite ?? 200);
    return many(
      q,
      `select m.id, m.tipo, m.puntos, m.descripcion, m.creado_en, m.vence_en, l.nombre as local, l.piso, l.numero_local,
              t.monto_bs
       from movimiento_puntos m
       left join local l on l.id = m.local_id
       left join transaccion t on t.id = m.referencia_id and m.tipo = 'compra'
       where ${cond.join(' and ')} order by m.creado_en desc limit $${p.length}`,
      p,
    );
  }

  lotesVencidos(q: Queryable) {
    return many<{ id: string; cliente_id: string; recinto_id: string; restante: number }>(
      q,
      `select id, cliente_id, recinto_id, restante from movimiento_puntos
       where restante > 0 and vence_en is not null and vence_en <= now() limit 500 for update`,
    );
  }
}
