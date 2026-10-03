import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import { AuditoriaService } from '../nucleo/nucleo.services.js';
import { Cotizacion, ReglaPuntos, calcularNivel, cotizarPuntos } from './domain/politica-puntos.js';
import { LedgerRepository, NuevoMovimiento } from './ledger.repository.js';

/** Servicio público del módulo de fidelización: el único que escribe el libro mayor. */
@Injectable()
export class FidelizacionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Fidelizacion');
  private cacheRegla = new Map<string, ReglaPuntos>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerRepository,
    private readonly rt: RealtimeService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.vencerPuntos().catch((e) => this.log.error(e)), 60 * 60_000);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- reglas
  async reglaVigente(q: Queryable, recintoId: string): Promise<ReglaPuntos> {
    const c = this.cacheRegla.get(recintoId);
    if (c) return c;
    const r = await one<ReglaPuntos>(q, 'select * from regla_puntos where recinto_id = $1 and vigente', [recintoId]);
    if (!r) throw new BadRequestException('No hay una regla de puntos vigente');
    this.cacheRegla.set(recintoId, r);
    return r;
  }

  obtenerRegla(recintoId: string) {
    return this.reglaVigente(this.db, recintoId);
  }

  historialReglas(recintoId: string) {
    return many(
      this.db,
      `select r.*, u.nombre as creado_por_nombre from regla_puntos r left join usuario u on u.id = r.creado_por
       where r.recinto_id = $1 order by version desc`,
      [recintoId],
    );
  }

  /** HU-A03: cada cambio crea una versión nueva y queda auditado con el valor anterior. */
  async actualizarRegla(recintoId: string, usuarioId: string, cambios: Partial<ReglaPuntos>) {
    const r = await this.db.tx(async (q) => {
      const actual = await one<ReglaPuntos>(q, 'select * from regla_puntos where recinto_id = $1 and vigente for update', [recintoId]);
      if (!actual) throw new BadRequestException('No hay regla vigente');
      const nueva = { ...actual, ...cambios };
      await q.query('update regla_puntos set vigente = false where id = $1', [actual.id]);
      const creada = await one<ReglaPuntos>(
        q,
        `insert into regla_puntos (recinto_id, version, vigente, bs_por_punto, valor_punto_bs, multiplicadores_categoria,
           multiplicadores_horario, dias_vencimiento, niveles, bono_bienvenida, puntos_descubrimiento, puntos_visita_diaria,
           puntos_referido, puntos_hora_parqueo, creado_por)
         values ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [
          recintoId, actual.version + 1, nueva.bs_por_punto, nueva.valor_punto_bs,
          JSON.stringify(nueva.multiplicadores_categoria), JSON.stringify(nueva.multiplicadores_horario),
          nueva.dias_vencimiento, JSON.stringify(nueva.niveles), nueva.bono_bienvenida, nueva.puntos_descubrimiento,
          nueva.puntos_visita_diaria, nueva.puntos_referido, nueva.puntos_hora_parqueo, usuarioId,
        ],
      );
      await this.auditoria.registrar(q, usuarioId, 'actualizar_regla', 'regla_puntos', creada!.id, actual, creada);
      return creada!;
    });
    this.cacheRegla.delete(recintoId);
    return r;
  }

  cotizar(regla: ReglaPuntos, montoBs: number, categoria: string | null, en: Date, promo: { multiplicador: number; titulo: string } | null): Cotizacion {
    return cotizarPuntos(regla, montoBs, categoria, en, promo);
  }

  // ---------------------------------------------------------------- ledger
  /** Acredita puntos dentro de la transacción del llamador. */
  async acreditar(q: Queryable, m: Omit<NuevoMovimiento, 'venceEn'>, opciones: { verificarVersion?: number } = {}) {
    if (m.puntos <= 0) return null;
    const regla = await this.reglaVigente(q, m.recintoId);
    if (opciones.verificarVersion !== undefined && opciones.verificarVersion !== regla.version) {
      throw new BadRequestException('La regla de puntos cambió; vuelve a intentar');
    }
    const vence = new Date(Date.now() + regla.dias_vencimiento * 86400_000);
    const mov = await this.ledger.insertar(q, { ...m, venceEn: vence, reglaVersion: m.reglaVersion ?? regla.version });
    this.notificarSaldo(m.clienteId, { tipo: m.tipo, puntos: m.puntos, descripcion: m.descripcion });
    return mov;
  }

  /** Debita puntos verificando saldo disponible, con bloqueo por cliente. */
  async debitar(q: Queryable, m: NuevoMovimiento, opciones: { ignorarReservaDe?: number } = {}) {
    if (m.puntos <= 0) throw new BadRequestException('Cantidad de puntos inválida');
    await this.ledger.bloquearCliente(q, m.clienteId);
    const saldo = await this.ledger.saldo(q, m.clienteId);
    const reservado = (await this.ledger.reservado(q, m.clienteId)) - (opciones.ignorarReservaDe ?? 0);
    if (saldo - reservado < m.puntos) {
      throw new BadRequestException(`Saldo insuficiente: tienes ${saldo - reservado} puntos disponibles`);
    }
    await this.ledger.consumirLotes(q, m.clienteId, m.puntos);
    const mov = await this.ledger.insertar(q, { ...m, puntos: -m.puntos });
    this.notificarSaldo(m.clienteId, { tipo: m.tipo, puntos: -m.puntos, descripcion: m.descripcion });
    return mov;
  }

  /** Revierte puntos de una operación anulada sin exigir saldo (puede quedar en negativo). */
  async anular(q: Queryable, m: NuevoMovimiento) {
    await this.ledger.bloquearCliente(q, m.clienteId);
    await this.ledger.consumirLotes(q, m.clienteId, m.puntos);
    await this.ledger.insertar(q, { ...m, tipo: 'anulacion', puntos: -m.puntos });
    this.notificarSaldo(m.clienteId, { tipo: 'anulacion', puntos: -m.puntos, descripcion: m.descripcion });
  }

  async disponible(q: Queryable, clienteId: string) {
    const saldo = await this.ledger.saldo(q, clienteId);
    const reservado = await this.ledger.reservado(q, clienteId);
    return { saldo, reservado, disponible: saldo - reservado };
  }

  private notificarSaldo(clienteId: string, datos: Record<string, unknown>) {
    setTimeout(() => this.rt.aUsuario(clienteId, 'puntos', datos), 30);
  }

  // ---------------------------------------------------------------- consultas del cliente
  /** HU-C04 y HU-C05: saldo, puntos por vencer y nivel. */
  async resumen(clienteId: string, recintoId: string) {
    const regla = await this.reglaVigente(this.db, recintoId);
    const { saldo, reservado, disponible } = await this.disponible(this.db, clienteId);
    const porVencer = await this.ledger.porVencer(this.db, clienteId);
    const ganados = await this.ledger.ganados12m(this.db, clienteId);
    return {
      saldo,
      reservado,
      disponible,
      valorBs: Math.round(saldo * Number(regla.valor_punto_bs) * 100) / 100,
      valorPuntoBs: Number(regla.valor_punto_bs),
      bsPorPunto: Number(regla.bs_por_punto),
      porVencer,
      nivel: calcularNivel(regla.niveles, ganados),
    };
  }

  movimientos(clienteId: string, f: { tipo?: string; desde?: string; hasta?: string }) {
    return this.ledger.listar(this.db, clienteId, f);
  }

  async nivelDe(q: Queryable, clienteId: string, recintoId: string) {
    const regla = await this.reglaVigente(q, recintoId);
    return calcularNivel(regla.niveles, await this.ledger.ganados12m(q, clienteId));
  }

  // ---------------------------------------------------------------- tareas
  /** Vence lotes cuyo plazo terminó y deja el movimiento de vencimiento. */
  async vencerPuntos() {
    const n = await this.db.tx(async (q) => {
      const lotes = await this.ledger.lotesVencidos(q);
      for (const l of lotes) {
        await q.query('update movimiento_puntos set restante = 0 where id = $1', [l.id]);
        await this.ledger.insertar(q, {
          recintoId: l.recinto_id, clienteId: l.cliente_id, tipo: 'vencimiento', puntos: -l.restante,
          referenciaId: l.id, descripcion: 'Puntos vencidos',
        });
      }
      return lotes.length;
    });
    if (n) this.log.log(`lotes vencidos: ${n}`);
  }

  // ---------------------------------------------------------------- HU-A20 economía del programa
  async economia(recintoId: string) {
    const regla = await this.reglaVigente(this.db, recintoId);
    const t = await one<any>(
      this.db,
      `select coalesce(sum(case when puntos > 0 then puntos end),0)::int as emitidos,
              coalesce(-sum(case when tipo in ('canje','parqueo') then puntos end),0)::int as canjeados,
              coalesce(-sum(case when tipo = 'vencimiento' then puntos end),0)::int as vencidos,
              coalesce(-sum(case when tipo = 'anulacion' then puntos end),0)::int as anulados,
              coalesce(sum(puntos),0)::int as pendientes
       from movimiento_puntos where recinto_id = $1`,
      [recintoId],
    );
    const porTipo = await many(
      this.db,
      `select tipo, sum(puntos)::int as puntos, count(*)::int as movimientos from movimiento_puntos where recinto_id = $1 group by tipo order by 2 desc`,
      [recintoId],
    );
    const mensual = await many(
      this.db,
      `select to_char(bo(creado_en), 'YYYY-MM') as mes,
              coalesce(sum(case when puntos > 0 then puntos end),0)::int as emitidos,
              coalesce(-sum(case when tipo in ('canje','parqueo') then puntos end),0)::int as canjeados,
              coalesce(-sum(case when tipo = 'vencimiento' then puntos end),0)::int as vencidos
       from movimiento_puntos where recinto_id = $1 group by 1 order by 1`,
      [recintoId],
    );
    const v = Number(regla.valor_punto_bs);
    return {
      valorPuntoBs: v,
      ...t,
      enBs: {
        emitidos: t.emitidos * v,
        canjeados: t.canjeados * v,
        vencidos: t.vencidos * v,
        pendientes: t.pendientes * v,
      },
      porTipo,
      mensual,
    };
  }
}
