import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { RealtimeService } from '../../infra/realtime/realtime.service.js';
import { ahoraBolivia, distanciaM } from '../../common/util.js';
import { NotificacionesService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';
import { PromocionesService } from '../participacion/promociones.service.js';

const TARIFA_HORA_BS = Number(process.env.PARQUEO_TARIFA_HORA_BS ?? 6);
const MAX_AVISOS_POR_VISITA = 2;

type Fuente = 'qr_entrada' | 'geocerca' | 'parqueo' | 'paseoya' | 'ar' | 'checkin_local';

/**
 * Presencia: visitas al Paseo, check-ins en locales y parqueo. Con estas tres marcas de tiempo
 * se estima la permanencia sin hardware (sección "captura de datos" del documento).
 */
@Injectable()
export class PresenciaService {
  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly telemetria: TelemetriaService,
    private readonly notif: NotificacionesService,
    private readonly promociones: PromocionesService,
    private readonly rt: RealtimeService,
    private readonly bus: EventBus,
  ) {}

  /** Comprueba la geocerca del Paseo. Sin coordenadas solo se acepta si la geocerca no es estricta. */
  async verificarGeocerca(q: Queryable, recintoId: string, lat?: number, lng?: number) {
    if (lat === undefined || lng === undefined) {
      if (process.env.GEOCERCA_ESTRICTA === 'true') throw new ForbiddenException('Activa tu ubicación para continuar');
      return { dentro: true, distancia: null as number | null };
    }
    const r = await one<{ lat: number; lng: number; radio_m: number }>(q, 'select lat, lng, radio_m from recinto where id = $1', [recintoId]);
    const d = distanciaM(lat, lng, r!.lat, r!.lng);
    return { dentro: d <= r!.radio_m, distancia: Math.round(d) };
  }

  /** Visita abierta de hoy o una nueva. Devuelve si es la primera del día. */
  async asegurarVisita(q: Queryable, recintoId: string, clienteId: string, fuente: Fuente, puerta: string | null = null) {
    const { fecha } = ahoraBolivia();
    const abierta = await one<{ id: string; puntos: number }>(
      q,
      `select id, puntos from visita where cliente_id = $1 and bo(entrada_en)::date = $2::date and salida_en is null order by entrada_en desc limit 1`,
      [clienteId, fecha],
    );
    if (abierta) return { visitaId: abierta.id, nueva: false, puntos: 0 };
    const hoy = await one<{ n: number }>(q, `select count(*)::int as n from visita where cliente_id = $1 and bo(entrada_en)::date = $2::date and puntos > 0`, [clienteId, fecha]);
    const v = await one<{ id: string }>(q, 'insert into visita (recinto_id, cliente_id, fuente, puerta) values ($1,$2,$3,$4) returning id', [recintoId, clienteId, fuente, puerta]);
    let puntos = 0;
    if (!hoy?.n) {
      const regla = await this.fidelizacion.reglaVigente(q, recintoId);
      puntos = regla.puntos_visita_diaria;
      await this.fidelizacion.acreditar(q, { recintoId, clienteId, tipo: 'visita', puntos, referenciaId: v!.id, descripcion: 'Llegaste al Paseo' });
      await q.query('update visita set puntos = $2 where id = $1', [v!.id, puntos]);
    }
    await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'visita.iniciada', payload: { fuente, puerta } });
    this.bus.publicar('visita.iniciada', { recintoId, clienteId, visitaId: v!.id, fuente, puerta });
    return { visitaId: v!.id, nueva: true, puntos };
  }

  /** HU-X01 «Llegué al Paseo»: QR de la entrada o geocerca GPS. */
  async llegue(recintoId: string, clienteId: string, d: { fuente: 'qr_entrada' | 'geocerca'; codigo?: string; lat?: number; lng?: number }) {
    return this.db.tx(async (q) => {
      let puerta: string | null = null;
      if (d.fuente === 'qr_entrada') {
        const m = /^PPE:(.+)$/.exec(d.codigo ?? '');
        if (!m) throw new BadRequestException('Escanea el QR de una entrada del Paseo');
        puerta = m[1];
      } else {
        const g = await this.verificarGeocerca(q, recintoId, d.lat, d.lng);
        if (!g.dentro) throw new BadRequestException(`Estás a ${g.distancia} m del Paseo. Acércate para registrar tu llegada.`);
      }
      return this.asegurarVisita(q, recintoId, clienteId, d.fuente, puerta);
    });
  }

  async salida(recintoId: string, clienteId: string) {
    return this.db.tx(async (q) => {
      await q.query('update checkin_local set salida_en = now() where cliente_id = $1 and salida_en is null', [clienteId]);
      const v = await one(q, 'update visita set salida_en = now() where cliente_id = $1 and salida_en is null returning *', [clienteId]);
      if (v) await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'visita.cerrada', payload: {} });
      return { cerrada: !!v };
    });
  }

  /** HU-C12: check-in en la puerta del local. Puntos solo en la primera visita a cada local. */
  async checkin(recintoId: string, clienteId: string, codigo: string) {
    const m = /^PPL:(L-[A-Z0-9]{8})$/.exec(codigo.trim());
    if (!m) throw new BadRequestException('Este no es el QR de la puerta de un local');
    const r = await this.db.tx(async (q) => {
      const local = await one<{ id: string; nombre: string; activo: boolean }>(q, 'select id, nombre, activo from local where codigo_puerta = $1 and recinto_id = $2', [m[1], recintoId]);
      if (!local || !local.activo) throw new NotFoundException('Local no encontrado');
      await q.query('update checkin_local set salida_en = now() where cliente_id = $1 and salida_en is null', [clienteId]);
      const previo = await one(q, 'select id from checkin_local where cliente_id = $1 and local_id = $2 limit 1', [clienteId, local.id]);
      const visita = await this.asegurarVisita(q, recintoId, clienteId, 'checkin_local');
      const c = await one<{ id: string }>(q, 'insert into checkin_local (cliente_id, local_id) values ($1,$2) returning id', [clienteId, local.id]);
      let puntos = 0;
      if (!previo) {
        const regla = await this.fidelizacion.reglaVigente(q, recintoId);
        puntos = regla.puntos_descubrimiento;
        await this.fidelizacion.acreditar(q, {
          recintoId, clienteId, tipo: 'descubrimiento', puntos, referenciaId: c!.id, localId: local.id, descripcion: `Descubriste ${local.nombre}`,
        });
        await q.query('update checkin_local set puntos = $2 where id = $1', [c!.id, puntos]);
      }
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'checkin.registrado', localId: local.id, payload: { primera_vez: !previo } });
      return { local: local.nombre, localId: local.id, primeraVez: !previo, puntos, puntosVisita: visita.puntos };
    });
    this.bus.publicar('checkin.registrado', { recintoId, clienteId, localId: r.localId, primeraVez: r.primeraVez });
    return r;
  }

  /** Llamado por comercio al registrar una compra: cierra el check-in abierto en ese local como «con compra». */
  async marcarCompra(q: Queryable, recintoId: string, clienteId: string, localId: string) {
    const c = await one(
      q,
      `update checkin_local set con_compra = true, salida_en = coalesce(salida_en, now())
       where id = (select id from checkin_local where cliente_id = $1 and local_id = $2 and entrada_en > now() - interval '4 hours' order by entrada_en desc limit 1)
       returning id`,
      [clienteId, localId],
    );
    if (!c) {
      // Compra sin check-in previo: igual cuenta como visita al local con compra
      await q.query('insert into checkin_local (cliente_id, local_id, salida_en, con_compra, origen) values ($1,$2,now(),true,$3)', [clienteId, localId, 'compra']);
    }
    await this.asegurarVisita(q, recintoId, clienteId, 'checkin_local');
  }

  /** HU-C20: con permiso de ubicación, avisa de puntos dobles cerca (máximo 2 avisos por visita). */
  async ubicacion(recintoId: string, clienteId: string, lat: number, lng: number) {
    const perfil = await one<{ consent_ubicacion: boolean }>(this.db, 'select consent_ubicacion from cliente_perfil where usuario_id = $1', [clienteId]);
    if (!perfil?.consent_ubicacion) return { dentro: false, avisos: [], motivo: 'sin_permiso' };
    // Se consulta fuera de la transacción: PGlite usa una sola conexión.
    const promos = (await this.promociones.vigentes(recintoId, clienteId)).filter((p: any) => p.activa_ahora && p.tipo === 'puntos_dobles' && p.local_id);
    return this.db.tx(async (q) => {
      const g = await this.verificarGeocerca(q, recintoId, lat, lng);
      if (!g.dentro) return { dentro: false, distancia: g.distancia, avisos: [] };
      const v = await this.asegurarVisita(q, recintoId, clienteId, 'geocerca');
      const visita = await one<{ avisos: number }>(q, 'select avisos from visita where id = $1', [v.visitaId]);
      const avisos: any[] = [];
      if ((visita?.avisos ?? 0) < MAX_AVISOS_POR_VISITA) {
        const yaAvisadas = await many<{ promo: string }>(
          q,
          `select datos->>'promocionId' as promo from notificacion where usuario_id = $1 and tipo = 'puntos_cerca' and creado_en > now() - interval '12 hours'`,
          [clienteId],
        );
        const avisadas = new Set(yaAvisadas.map((a) => a.promo));
        const nueva = promos.find((p: any) => !avisadas.has(p.id));
        if (nueva) {
          const n = await this.notif.crear(
            q, clienteId, 'puntos_cerca', `Puntos ×${Number(nueva.multiplicador)} cerca de ti`,
            `${nueva.local} (${nueva.piso} · Local ${nueva.numero_local}): ${nueva.titulo}`, { promocionId: nueva.id, localId: nueva.local_id },
          );
          await q.query('update visita set avisos = avisos + 1 where id = $1', [v.visitaId]);
          await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'notificacion.enviada', localId: nueva.local_id, payload: { promocion: nueva.id } });
          avisos.push(n);
        }
      }
      return { dentro: true, distancia: g.distancia, visitaNueva: v.nueva, puntosVisita: v.puntos, avisos };
    });
  }

  // ------------------------------------------------------------------ HU-X02 parqueo (simulado)
  async parqueoEntrada(recintoId: string, clienteId: string, ticket: string) {
    return this.db.tx(async (q) => {
      const abierto = await one(q, `select id from parqueo where cliente_id = $1 and estado = 'abierto'`, [clienteId]);
      if (abierto) throw new BadRequestException('Ya tienes un ticket de parqueo abierto');
      const p = await one(q, 'insert into parqueo (cliente_id, ticket) values ($1,$2) returning *', [clienteId, ticket]);
      await this.asegurarVisita(q, recintoId, clienteId, 'parqueo', 'Parqueo');
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'parqueo.entrada', payload: { ticket } });
      return p;
    });
  }

  async parqueoActual(clienteId: string, recintoId: string) {
    const p = await one<any>(this.db, `select * from parqueo where cliente_id = $1 and estado = 'abierto'`, [clienteId]);
    if (!p) return null;
    const regla = await this.fidelizacion.reglaVigente(this.db, recintoId);
    const minutos = Math.max(1, Math.round((Date.now() - new Date(p.entrada_en).getTime()) / 60000));
    const horas = Math.ceil(minutos / 60);
    return { ...p, minutos, horas, tarifaHoraBs: TARIFA_HORA_BS, montoBs: horas * TARIFA_HORA_BS, puntosPorHora: regla.puntos_hora_parqueo };
  }

  /** Salida: el cliente puede pagar horas con puntos (parqueo gratis con puntos). */
  async parqueoSalida(recintoId: string, clienteId: string, horasConPuntos: number) {
    return this.db.tx(async (q) => {
      const p = await one<any>(q, `select * from parqueo where cliente_id = $1 and estado = 'abierto' for update`, [clienteId]);
      if (!p) throw new NotFoundException('No tienes un ticket de parqueo abierto');
      const regla = await this.fidelizacion.reglaVigente(q, recintoId);
      const minutos = Math.max(1, Math.round((Date.now() - new Date(p.entrada_en).getTime()) / 60000));
      const horas = Math.ceil(minutos / 60);
      const gratis = Math.min(horas, Math.max(0, Math.floor(horasConPuntos)));
      const puntos = gratis * regla.puntos_hora_parqueo;
      if (puntos > 0) {
        await this.fidelizacion.debitar(q, { recintoId, clienteId, tipo: 'parqueo', puntos, referenciaId: p.id, descripcion: `Parqueo: ${gratis} h pagadas con puntos` });
      }
      const monto = (horas - gratis) * TARIFA_HORA_BS;
      const r = await one(
        q,
        `update parqueo set salida_en = now(), minutos = $2, horas_gratis = $3, puntos_usados = $4, monto_bs = $5, estado = 'cerrado' where id = $1 returning *`,
        [p.id, minutos, gratis, puntos, monto],
      );
      await q.query('update visita set salida_en = now() where cliente_id = $1 and salida_en is null', [clienteId]);
      await q.query('update checkin_local set salida_en = now() where cliente_id = $1 and salida_en is null', [clienteId]);
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'parqueo.salida', payload: { minutos, horas, horas_gratis: gratis, monto_bs: monto } });
      return r;
    });
  }

  historialVisitas(clienteId: string) {
    return many(
      this.db,
      `select v.*, extract(epoch from (coalesce(v.salida_en, now()) - v.entrada_en))::int / 60 as minutos from visita v where cliente_id = $1 order by entrada_en desc limit 30`,
      [clienteId],
    );
  }

  publicarSala(recintoId: string, evento: string, datos: unknown) {
    this.rt.aSala(recintoId, evento, datos);
  }
}
