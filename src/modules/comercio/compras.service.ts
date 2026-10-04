import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { aCsv, ahoraBolivia } from '../../common/util.js';
import { EventBus } from '../nucleo/event-bus.js';
import { NotificacionesService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { IdentidadService, enmascararNombre } from '../identidad/identidad.service.js';
import { PromocionesService } from '../participacion/promociones.service.js';
import { PresenciaService } from '../presencia/presencia.service.js';
import { FraudeService } from '../confianza/fraude.service.js';

export interface RegistrarCompraCmd {
  pase?: string;
  clienteId?: string;
  codigoCliente?: string;
  montoBs: number;
  categoria?: string | null;
  nroFactura?: string | null;
  claveIdempotencia: string;
  capturadoEn?: string;
  offline?: boolean;
}

/**
 * Caso de uso central del sistema: convierte una venta anónima en una venta identificada.
 * Venta, libro mayor, check-in, antifraude y evento se escriben en una sola transacción.
 */
@Injectable()
export class ComprasService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly identidad: IdentidadService,
    private readonly fidelizacion: FidelizacionService,
    private readonly promociones: PromocionesService,
    private readonly presencia: PresenciaService,
    private readonly fraude: FraudeService,
    private readonly telemetria: TelemetriaService,
    private readonly notif: NotificacionesService,
    private readonly rt: RealtimeService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.bus.on('alerta.confirmada', (e) => this.anular(e.recintoId, e.transaccionId, e.adminId, 'Fraude confirmado'));
  }

  private async resultado(q: Queryable, transaccionId: string) {
    const t = await one<any>(
      q,
      `select t.id, t.monto_bs, t.puntos, t.categoria, t.creado_en, t.origen, t.offline, u.nombre, u.id as cliente_id, l.nombre as local
       from transaccion t join usuario u on u.id = t.cliente_id join local l on l.id = t.local_id where t.id = $1`,
      [transaccionId],
    );
    return {
      transaccionId: t.id,
      montoBs: Number(t.monto_bs),
      puntos: t.puntos,
      categoria: t.categoria,
      creadoEn: t.creado_en,
      offline: t.offline,
      cliente: { nombre: enmascararNombre(t.nombre) },
      local: t.local,
    };
  }

  /** Vista previa para el comercio tras escanear el pase: quién es y qué promoción aplica. */
  async previsualizar(s: Sesion, pase: string) {
    const c = await this.identidad.verificarPase(this.db, pase, new Date());
    return this.datosCliente(s, c.clienteId);
  }

  async datosCliente(s: Sesion, clienteId: string) {
    const nivel = await this.fidelizacion.nivelDe(this.db, clienteId, s.recintoId);
    const u = await one<{ nombre: string; creado_en: string }>(this.db, 'select nombre, creado_en from usuario where id = $1', [clienteId]);
    const visitas = await one<{ n: number }>(this.db, 'select count(*)::int as n from transaccion where cliente_id = $1 and local_id = $2 and estado = $3', [
      clienteId, s.localId, 'valida',
    ]);
    const promo = await this.promociones.mejorPara(this.db, s.recintoId, s.localId!, clienteId, new Date());
    const regla = await this.fidelizacion.reglaVigente(this.db, s.recintoId);
    return {
      clienteId,
      nombre: enmascararNombre(u!.nombre),
      nivel: nivel.nivel,
      clienteDesde: u!.creado_en,
      comprasEnEsteLocal: visitas?.n ?? 0,
      promocion: promo,
      bsPorPunto: Number(regla.bs_por_punto),
    };
  }

  /** HU-L02 / HU-L03: registra una compra e acredita puntos. Idempotente por clave. */
  async registrar(s: Sesion, cmd: RegistrarCompraCmd) {
    if (!s.localId) throw new ForbiddenException('Tu usuario no está asignado a un local');
    const existente = await one<{ id: string }>(this.db, 'select id from transaccion where clave_idempotencia = $1', [cmd.claveIdempotencia]);
    if (existente) return { ...(await this.resultado(this.db, existente.id)), repetida: true };

    const capturadoEn = cmd.capturadoEn ? new Date(cmd.capturadoEn) : new Date();
    if (capturadoEn.getTime() > Date.now() + 120_000) throw new BadRequestException('La hora de captura está en el futuro');

    const r = await this.db.tx(async (q) => {
      let cliente: { clienteId: string; nombre: string };
      let origen: 'qr' | 'codigo';
      if (cmd.pase) {
        cliente = await this.identidad.verificarPase(q, cmd.pase, capturadoEn, !!cmd.offline);
        origen = 'qr';
      } else if (cmd.codigoCliente) {
        cliente = await this.identidad.verificarPase(q, 'PP1:' + cmd.codigoCliente, capturadoEn, !!cmd.offline);
        origen = 'codigo';
      } else {
        throw new BadRequestException('Escanea el pase del cliente o ingresa su código único');
      }

      const local = await one<{ id: string; categoria: string }>(
        q,
        'select l.id, c.nombre as categoria from local l join categoria c on c.id = l.categoria_id where l.id = $1',
        [s.localId],
      );
      const categoria = cmd.categoria || local!.categoria;
      const regla = await this.fidelizacion.reglaVigente(q, s.recintoId);
      const promo = await this.promociones.mejorPara(q, s.recintoId, s.localId!, cliente.clienteId, capturadoEn);
      const cot = this.fidelizacion.cotizar(regla, cmd.montoBs, local!.categoria, capturadoEn, promo);

      const t = await one<{ id: string }>(
        q,
        `insert into transaccion (clave_idempotencia, recinto_id, cliente_id, local_id, empleado_id, monto_bs, categoria, nro_factura, origen, offline, puntos, capturado_en)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (clave_idempotencia) do nothing returning id`,
        [cmd.claveIdempotencia, s.recintoId, cliente.clienteId, s.localId, s.sub, cmd.montoBs, categoria, cmd.nroFactura ?? null, origen, !!cmd.offline, cot.puntos, capturadoEn],
      );
      if (!t) {
        const e = await one<{ id: string }>(q, 'select id from transaccion where clave_idempotencia = $1', [cmd.claveIdempotencia]);
        return { id: e!.id, repetida: true, cot, clienteId: cliente.clienteId };
      }
      await this.fidelizacion.acreditar(
        q,
        {
          recintoId: s.recintoId, clienteId: cliente.clienteId, tipo: 'compra', puntos: cot.puntos, referenciaId: t.id, localId: s.localId,
          descripcion: `Compra de Bs ${cmd.montoBs.toFixed(2)}${cot.detalle.length ? ` (${cot.detalle.join(', ')})` : ''}`,
        },
        { verificarVersion: cot.reglaVersion },
      );
      await this.presencia.marcarCompra(q, s.recintoId, cliente.clienteId, s.localId!);
      await this.premiarReferido(q, s.recintoId, cliente.clienteId);
      await this.fraude.evaluarCompra(q, t.id);
      await this.telemetria.registrar(q, {
        recintoId: s.recintoId, clienteId: cliente.clienteId, tipo: 'compra.registrada', localId: s.localId,
        payload: { monto_bs: cmd.montoBs, categoria, puntos: cot.puntos, origen, offline: !!cmd.offline },
      });
      return { id: t.id, repetida: false, cot, clienteId: cliente.clienteId, categoria };
    });

    const res = await this.resultado(this.db, r.id);
    if (!r.repetida) {
      this.bus.publicar('compra.registrada', {
        recintoId: s.recintoId, transaccionId: r.id, clienteId: r.clienteId, localId: s.localId, montoBs: cmd.montoBs,
        categoria: (r as any).categoria ?? null, puntos: r.cot.puntos, origen: res.offline ? 'offline' : 'qr',
      });
      this.rt.aLocal(s.localId, 'compra', res);
      this.rt.aUsuario(r.clienteId, 'compra', { ...res, detalle: r.cot.detalle });
    }
    return { ...res, detalle: r.cot.detalle, multiplicador: r.cot.multiplicador, repetida: r.repetida };
  }

  /** HU-C18: ambos reciben puntos cuando el invitado hace su primera compra. */
  private async premiarReferido(q: Queryable, recintoId: string, clienteId: string) {
    const p = await one<{ invitado_por: string | null; referido_premiado: boolean }>(
      q,
      'select invitado_por, referido_premiado from cliente_perfil where usuario_id = $1 for update',
      [clienteId],
    );
    if (!p?.invitado_por || p.referido_premiado) return;
    const regla = await this.fidelizacion.reglaVigente(q, recintoId);
    await q.query('update cliente_perfil set referido_premiado = true where usuario_id = $1', [clienteId]);
    const nombre = (await one<{ nombre: string }>(q, 'select nombre from usuario where id = $1', [clienteId]))!.nombre;
    await this.fidelizacion.acreditar(q, { recintoId, clienteId, tipo: 'referido', puntos: regla.puntos_referido, descripcion: 'Bono por unirte con invitación' });
    await this.fidelizacion.acreditar(q, {
      recintoId, clienteId: p.invitado_por, tipo: 'referido', puntos: regla.puntos_referido, referenciaId: clienteId,
      descripcion: `${enmascararNombre(nombre)} hizo su primera compra con tu invitación`,
    });
    await this.notif.crear(q, p.invitado_por, 'referido', 'Tu invitación sumó puntos', `+${regla.puntos_referido} pts: ${enmascararNombre(nombre)} hizo su primera compra`);
    await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'referido.premiado', payload: {} });
  }

  /** Revierte una compra (fraude confirmado). Los puntos se descuentan aunque el saldo quede negativo. */
  async anular(recintoId: string, transaccionId: string, usuarioId: string, motivo: string) {
    await this.db.tx(async (q) => {
      const t = await one<any>(q, `select * from transaccion where id = $1 for update`, [transaccionId]);
      if (!t || t.estado === 'anulada') return;
      await q.query(`update transaccion set estado = 'anulada' where id = $1`, [transaccionId]);
      if (t.puntos > 0) {
        await this.fidelizacion.anular(q, {
          recintoId, clienteId: t.cliente_id, tipo: 'anulacion', puntos: t.puntos, referenciaId: t.id, localId: t.local_id,
          descripcion: `Compra anulada: ${motivo}`,
        });
      }
      await q.query(
        `insert into auditoria (usuario_id, accion, entidad, entidad_id, antes, despues) values ($1,'anular_compra','transaccion',$2,$3,$4)`,
        [usuarioId, transaccionId, JSON.stringify({ estado: t.estado }), JSON.stringify({ estado: 'anulada', motivo })],
      );
    });
  }

  // ------------------------------------------------------------------ HU-C16 factura SIAT
  /**
   * Acepta dos formatos de QR de factura boliviana:
   *  - URL SIAT en línea: https://siat.impuestos.gob.bo/consulta/QR?nit=..&cuf=..&numero=..  (monto y fecha los ingresa el cliente)
   *  - Formato con código de control: NIT|N°factura|N°autorización|dd/mm/aaaa|total|...
   */
  static leerQrFactura(contenido: string, montoManual?: number, fechaManual?: string) {
    const c = contenido.trim();
    if (/^https?:\/\//i.test(c)) {
      const u = new URL(c);
      const nit = u.searchParams.get('nit');
      const numero = u.searchParams.get('numero');
      const cuf = u.searchParams.get('cuf');
      if (!nit || !numero) throw new BadRequestException('El QR no tiene NIT ni número de factura');
      if (!montoManual || !fechaManual) throw new BadRequestException('Ingresa el monto y la fecha que figuran en la factura');
      return { nit, numero, cuf, monto: montoManual, fecha: fechaManual };
    }
    const p = c.split('|');
    if (p.length >= 5) {
      const [nit, numero, , fechaTxt, total] = p;
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fechaTxt);
      if (!m) throw new BadRequestException('No pudimos leer la fecha de la factura');
      return { nit, numero, cuf: null, monto: Number(total.replace(',', '.')), fecha: `${m[3]}-${m[2]}-${m[1]}` };
    }
    throw new BadRequestException('El QR no corresponde a una factura boliviana');
  }

  async registrarFactura(recintoId: string, clienteId: string, contenido: string, montoManual?: number, fechaManual?: string) {
    const f = ComprasService.leerQrFactura(contenido, montoManual, fechaManual);
    if (!(f.monto > 0)) throw new BadRequestException('El monto de la factura no es válido');
    const { fecha } = ahoraBolivia();
    if (f.fecha !== fecha) throw new BadRequestException('Solo se aceptan facturas emitidas hoy');
    const r = await this.db.tx(async (q) => {
      const local = await one<{ id: string; nombre: string; categoria: string }>(
        q,
        'select l.id, l.nombre, c.nombre as categoria from local l join categoria c on c.id = l.categoria_id where l.nit = $1 and l.recinto_id = $2',
        [f.nit, recintoId],
      );
      if (!local) throw new BadRequestException('El emisor de esta factura no es un local de Paseo Aranjuez');
      const usada = await one(q, `select id from transaccion where origen = 'factura' and nit_emisor = $1 and nro_factura = $2`, [f.nit, f.numero]);
      if (usada) throw new BadRequestException('Esta factura ya sumó puntos');
      const regla = await this.fidelizacion.reglaVigente(q, recintoId);
      const cot = this.fidelizacion.cotizar(regla, f.monto, local.categoria, new Date(), null);
      const t = await one<{ id: string }>(
        q,
        `insert into transaccion (clave_idempotencia, recinto_id, cliente_id, local_id, monto_bs, categoria, nro_factura, nit_emisor, origen, puntos)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'factura',$9) returning id`,
        [randomUUID(), recintoId, clienteId, local.id, f.monto, local.categoria, f.numero, f.nit, cot.puntos],
      );
      await this.fidelizacion.acreditar(q, {
        recintoId, clienteId, tipo: 'factura', puntos: cot.puntos, referenciaId: t!.id, localId: local.id,
        descripcion: `Factura ${f.numero} de ${local.nombre}`,
      });
      await this.presencia.marcarCompra(q, recintoId, clienteId, local.id);
      await this.fraude.evaluarCompra(q, t!.id);
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'compra.registrada', localId: local.id, payload: { monto_bs: f.monto, origen: 'factura' } });
      return { transaccionId: t!.id, local: local.nombre, montoBs: f.monto, puntos: cot.puntos, localId: local.id, categoria: local.categoria };
    });
    this.bus.publicar('compra.registrada', {
      recintoId, transaccionId: r.transaccionId, clienteId, localId: r.localId, montoBs: r.montoBs, categoria: r.categoria, puntos: r.puntos, origen: 'factura',
    });
    return r;
  }

  // ------------------------------------------------------------------ HU-L06 movimientos del local
  async movimientosLocal(localId: string, f: { desde?: string; hasta?: string; empleadoId?: string }) {
    const { fecha } = ahoraBolivia();
    const desde = f.desde ?? fecha;
    const hasta = f.hasta ?? fecha;
    const compras = await many(
      this.db,
      `select t.id, t.creado_en, t.monto_bs, t.puntos, t.categoria, t.nro_factura, t.origen, t.estado, t.offline,
              e.nombre as cuenta, e.id as empleado_id, u.nombre as cliente
       from transaccion t left join usuario e on e.id = t.empleado_id join usuario u on u.id = t.cliente_id
       where t.local_id = $1 and bo(t.creado_en)::date between $2::date and $3::date and ($4::uuid is null or t.empleado_id = $4)
       order by t.creado_en desc`,
      [localId, desde, hasta, f.empleadoId ?? null],
    );
    const canjes = await many(
      this.db,
      `select c.id, c.validado_en as creado_en, c.costo_puntos, r.nombre as recompensa, e.nombre as cuenta, e.id as empleado_id
       from canje c join recompensa r on r.id = c.recompensa_id left join usuario e on e.id = c.validado_por
       where c.validado_local = $1 and c.estado = 'validado' and bo(c.validado_en)::date between $2::date and $3::date
         and ($4::uuid is null or c.validado_por = $4)
       order by c.validado_en desc`,
      [localId, desde, hasta, f.empleadoId ?? null],
    );
    const cuentas = await many(this.db, `select u.id, u.nombre, e.etiqueta from empleado_local e join usuario u on u.id = e.usuario_id where e.local_id = $1`, [localId]);
    const validas = compras.filter((c: any) => c.estado === 'valida');
    return {
      desde,
      hasta,
      cuentas,
      totales: {
        compras: validas.length,
        ventasBs: validas.reduce((a: number, c: any) => a + Number(c.monto_bs), 0),
        puntosEmitidos: validas.reduce((a: number, c: any) => a + c.puntos, 0),
        canjes: canjes.length,
        puntosCanjeados: canjes.reduce((a: number, c: any) => a + c.costo_puntos, 0),
      },
      compras: compras.map((c: any) => ({ ...c, cliente: enmascararNombre(c.cliente) })),
      canjes,
    };
  }

  async movimientosCsv(localId: string, f: { desde?: string; hasta?: string; empleadoId?: string }) {
    const m = await this.movimientosLocal(localId, f);
    const filas = [
      ...m.compras.map((c: any) => ({
        tipo: 'venta', fecha: new Date(c.creado_en).toISOString(), monto_bs: Number(c.monto_bs).toFixed(2), puntos: c.puntos,
        categoria: c.categoria, factura: c.nro_factura ?? '', cuenta: c.cuenta ?? '', cliente: c.cliente, estado: c.estado,
      })),
      ...m.canjes.map((c: any) => ({
        tipo: 'canje', fecha: new Date(c.creado_en).toISOString(), monto_bs: '', puntos: -c.costo_puntos, categoria: c.recompensa,
        factura: '', cuenta: c.cuenta ?? '', cliente: '', estado: 'validado',
      })),
    ];
    return aCsv(filas);
  }

  ultimasDelLocal(localId: string) {
    return many(
      this.db,
      `select t.id, t.creado_en, t.monto_bs, t.puntos, t.estado, u.nombre as cliente from transaccion t join usuario u on u.id = t.cliente_id
       where t.local_id = $1 order by t.creado_en desc limit 10`,
      [localId],
    ).then((f) => f.map((x: any) => ({ ...x, cliente: enmascararNombre(x.cliente) })));
  }

  async existe(id: string) {
    const t = await one(this.db, 'select id from transaccion where id = $1', [id]);
    if (!t) throw new NotFoundException('Compra no encontrada');
    return t;
  }
}
