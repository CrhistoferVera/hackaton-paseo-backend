import { Injectable } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';

export interface EventoTelemetria {
  recintoId: string;
  clienteId?: string | null;
  tipo: string;
  payload?: Record<string, unknown>;
  localId?: string | null;
  zonaId?: string | null;
}

/**
 * Telemetría (capa bronce): cada interacción produce un evento con identificador seudónimo.
 * El evento también se publica en la sala del administrador para el contador y el mapa en vivo.
 */
@Injectable()
export class TelemetriaService {
  constructor(
    private readonly db: Db,
    private readonly rt: RealtimeService,
  ) {}

  async registrar(q: Queryable, e: EventoTelemetria): Promise<void> {
    const zona =
      e.zonaId ?? (e.localId ? (await one<{ zona_id: string }>(q, 'select zona_id from local where id = $1', [e.localId]))?.zona_id : null);
    const registrado = await q.query(
      `insert into evento (recinto_id, id_seudonimo, tipo, payload, local_id, zona_id)
       select $1, (select id_seudonimo from cliente_perfil where usuario_id = $2), $3, $4, $5, $6
       where exists (select 1 from recinto where id = $1)
         and ($5::uuid is null or exists (select 1 from local where id = $5 and recinto_id = $1))
         and ($6::uuid is null or exists (select 1 from zona where id = $6 and recinto_id = $1))
       returning recinto_id`,
      [e.recintoId, e.clienteId ?? null, e.tipo, JSON.stringify(e.payload ?? {}), e.localId ?? null, zona ?? null],
    );
    if (!registrado.rows.length) return;
    setImmediate(() =>
      this.rt.aSala(e.recintoId, 'evento', {
        tipo: e.tipo,
        localId: e.localId ?? null,
        zonaId: zona ?? null,
        monto: (e.payload as any)?.monto_bs ?? null,
        en: new Date().toISOString(),
      }),
    );
  }

  /** Para eventos de pantalla que no dependen de una transacción (búsquedas, vistas, clics). */
  registrarSuelto(e: EventoTelemetria) {
    return this.registrar(this.db, e);
  }
}

@Injectable()
export class AuditoriaService {
  async registrar(
    q: Queryable,
    usuarioId: string | null,
    accion: string,
    entidad: string,
    entidadId: string | null,
    antes: unknown,
    despues: unknown,
  ) {
    await q.query(
      `insert into auditoria (usuario_id, accion, entidad, entidad_id, antes, despues) values ($1,$2,$3,$4,$5,$6)`,
      [usuarioId, accion, entidad, entidadId, antes === undefined ? null : JSON.stringify(antes), despues === undefined ? null : JSON.stringify(despues)],
    );
  }
}

@Injectable()
export class NotificacionesService {
  constructor(
    private readonly db: Db,
    private readonly rt: RealtimeService,
  ) {}

  async crear(q: Queryable, usuarioId: string, tipo: string, titulo: string, cuerpo: string, datos: Record<string, unknown> = {}) {
    const n = await one(
      q,
      `insert into notificacion (usuario_id, tipo, titulo, cuerpo, datos) values ($1,$2,$3,$4,$5) returning *`,
      [usuarioId, tipo, titulo, cuerpo, JSON.stringify(datos)],
    );
    setImmediate(() => this.rt.aUsuario(usuarioId, 'notificacion', n));
    return n;
  }

  listar(usuarioId: string) {
    return many(this.db, `select * from notificacion where usuario_id = $1 order by creado_en desc limit 50`, [usuarioId]);
  }

  async marcarLeidas(usuarioId: string) {
    await this.db.query(`update notificacion set leida = true where usuario_id = $1 and not leida`, [usuarioId]);
  }
}
