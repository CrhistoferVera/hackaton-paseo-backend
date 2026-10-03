import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import { Rol, Sesion, firmarJwt, hashPassword, verificarJwt, verificarPassword } from '../../common/auth/tokens.js';
import { codigoLegible, pinNumerico, secretoAleatorio, totpValido } from '../../common/util.js';
import { AuditoriaService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { FidelizacionService } from '../fidelizacion/fidelizacion.service.js';

const DURACION: Record<Rol, number> = {
  cliente: 30 * 86400,
  comercio: 12 * 3600,
  admin: 8 * 3600,
  marketing: 8 * 3600,
  analista: 8 * 3600,
};
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;
/** En desarrollo se devuelve el código OTP en la respuesta porque no hay proveedor de SMS. */
const MOSTRAR_OTP = process.env.OTP_EN_RESPUESTA !== 'false';

export interface DatosRegistro {
  nombre: string;
  celular?: string;
  correo?: string;
  password: string;
  fechaNacimiento: string;
  zonaResidencia: string;
  intereses: string[];
  genero?: string;
  aceptaTerminos: boolean;
  consentUbicacion: boolean;
  consentPersonalizacion: boolean;
  codigoInvitacion?: string;
}

interface FilaUsuario {
  id: string;
  recinto_id: string;
  rol: Rol;
  nombre: string;
  correo: string | null;
  celular: string | null;
  hash: string | null;
  estado: string;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
}

@Injectable()
export class IdentidadService {
  constructor(
    private readonly db: Db,
    private readonly fidelizacion: FidelizacionService,
    private readonly telemetria: TelemetriaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async recintoPrincipal(q: Queryable = this.db): Promise<string> {
    const r = await one<{ id: string }>(q, 'select id from recinto order by nombre limit 1');
    if (!r) throw new BadRequestException('El sistema no tiene un recinto configurado. Ejecuta el seed.');
    return r.id;
  }

  private async sesionPara(q: Queryable, u: FilaUsuario) {
    const emp = await one<{ local_id: string; etiqueta: string }>(q, 'select local_id, etiqueta from empleado_local where usuario_id = $1', [u.id]);
    const payload: Omit<Sesion, 'exp'> = { sub: u.id, rol: u.rol, recintoId: u.recinto_id, nombre: u.nombre, localId: emp?.local_id };
    return {
      token: firmarJwt(payload, DURACION[u.rol]),
      usuario: { id: u.id, rol: u.rol, nombre: u.nombre, correo: u.correo, celular: u.celular, localId: emp?.local_id ?? null, caja: emp?.etiqueta ?? null },
    };
  }

  // ------------------------------------------------------------------ HU-C01 registro
  async registrar(d: DatosRegistro) {
    if (!d.celular && !d.correo) throw new BadRequestException('Ingresa tu celular o tu correo');
    if (!d.aceptaTerminos) throw new BadRequestException('Debes aceptar los términos de uso');
    const hash = await hashPassword(d.password);
    return this.db.tx(async (q) => {
      const recintoId = await this.recintoPrincipal(q);
      const existe = await one(q, 'select id from usuario where ($1::text is not null and celular = $1) or ($2::text is not null and correo = $2)', [
        d.celular ?? null,
        d.correo?.toLowerCase() ?? null,
      ]);
      if (existe) throw new ConflictException('Ya existe una cuenta con ese celular o correo');

      const u = await one<FilaUsuario>(
        q,
        `insert into usuario (recinto_id, rol, nombre, correo, celular, hash) values ($1,'cliente',$2,$3,$4,$5) returning *`,
        [recintoId, d.nombre.trim(), d.correo?.toLowerCase() ?? null, d.celular ?? null, hash],
      );
      let invitadoPor: string | null = null;
      if (d.codigoInvitacion) {
        const inv = await one<{ usuario_id: string }>(q, 'select usuario_id from cliente_perfil where codigo_invitacion = $1', [d.codigoInvitacion.toUpperCase()]);
        if (!inv) throw new BadRequestException('El código de invitación no existe');
        invitadoPor = inv.usuario_id;
      }
      await q.query(
        `insert into cliente_perfil (usuario_id, codigo_cliente, secreto_pase, fecha_nacimiento, genero, zona_residencia, intereses,
           codigo_invitacion, invitado_por, consent_terminos_en, consent_ubicacion, consent_personalizacion, alias)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12)`,
        [
          u!.id, codigoLegible(8), secretoAleatorio(), d.fechaNacimiento, d.genero ?? null, d.zonaResidencia,
          d.intereses, codigoLegible(6), invitadoPor, d.consentUbicacion, d.consentPersonalizacion, `Cliente ${codigoLegible(4)}`,
        ],
      );
      const regla = await this.fidelizacion.reglaVigente(q, recintoId);
      await this.fidelizacion.acreditar(q, {
        recintoId, clienteId: u!.id, tipo: 'bono', puntos: regla.bono_bienvenida, descripcion: 'Bono de bienvenida',
      });
      await this.telemetria.registrar(q, {
        recintoId, clienteId: u!.id, tipo: 'cliente.registrado',
        payload: { zona_residencia: d.zonaResidencia, intereses: d.intereses, invitado: !!invitadoPor },
      });
      return { ...(await this.sesionPara(q, u!)), bonoBienvenida: regla.bono_bienvenida };
    });
  }

  // ------------------------------------------------------------------ HU-C02 inicio de sesión
  private async buscarPorIdentificador(q: Queryable, identificador: string) {
    const id = identificador.trim().toLowerCase();
    return one<FilaUsuario>(q, 'select * from usuario where correo = $1 or celular = $1', [id]);
  }

  async login(identificador: string, password: string) {
    const u = await this.buscarPorIdentificador(this.db, identificador);
    if (!u || u.estado === 'eliminado') throw new UnauthorizedException('Usuario o contraseña incorrectos');
    if (u.estado === 'bloqueado') throw new ForbiddenException('Tu cuenta está bloqueada. Contacta a Paseo Aranjuez.');
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
      const min = Math.ceil((new Date(u.bloqueado_hasta).getTime() - Date.now()) / 60000);
      throw new ForbiddenException(`Demasiados intentos fallidos. Intenta de nuevo en ${min} min.`);
    }
    if (!(await verificarPassword(password, u.hash))) {
      const intentos = u.intentos_fallidos + 1;
      if (intentos >= MAX_INTENTOS) {
        await this.db.query(`update usuario set intentos_fallidos = 0, bloqueado_hasta = now() + interval '${MINUTOS_BLOQUEO} minutes' where id = $1`, [u.id]);
        throw new ForbiddenException(`Bloqueamos el acceso por ${MINUTOS_BLOQUEO} minutos tras ${MAX_INTENTOS} intentos fallidos.`);
      }
      await this.db.query('update usuario set intentos_fallidos = $2 where id = $1', [u.id, intentos]);
      throw new UnauthorizedException(`Usuario o contraseña incorrectos. Te quedan ${MAX_INTENTOS - intentos} intentos.`);
    }
    await this.db.query('update usuario set intentos_fallidos = 0, bloqueado_hasta = null where id = $1', [u.id]);

    // HU-A02: doble factor para roles internos
    if (['admin', 'marketing', 'analista'].includes(u.rol)) {
      const codigo = await this.crearOtp(u.id, '2fa');
      const desafio = firmarJwt({ sub: u.id, rol: u.rol, recintoId: u.recinto_id, nombre: '2fa' }, 300);
      return { requiere2fa: true, desafio, ...(MOSTRAR_OTP ? { codigoDev: codigo } : {}) };
    }
    return this.sesionPara(this.db, u);
  }

  private async crearOtp(usuarioId: string, proposito: 'login' | '2fa') {
    const codigo = pinNumerico(6);
    await this.db.query(`update otp set usado = true where usuario_id = $1 and proposito = $2 and not usado`, [usuarioId, proposito]);
    await this.db.query(`insert into otp (usuario_id, codigo, proposito, expira_en) values ($1,$2,$3, now() + interval '5 minutes')`, [usuarioId, codigo, proposito]);
    return codigo;
  }

  private async consumirOtp(usuarioId: string, proposito: 'login' | '2fa', codigo: string) {
    const r = await one(
      this.db,
      `update otp set usado = true where id = (
         select id from otp where usuario_id = $1 and proposito = $2 and codigo = $3 and not usado and expira_en > now()
         order by creado_en desc limit 1) returning id`,
      [usuarioId, proposito, codigo],
    );
    if (!r) throw new UnauthorizedException('El código es incorrecto o ya venció');
  }

  async segundoFactor(desafio: string, codigo: string) {
    const s = verificarJwt(desafio);
    if (!s || s.nombre !== '2fa') throw new UnauthorizedException('La verificación venció. Inicia sesión de nuevo.');
    await this.consumirOtp(s.sub, '2fa', codigo);
    const u = await one<FilaUsuario>(this.db, 'select * from usuario where id = $1', [s.sub]);
    return this.sesionPara(this.db, u!);
  }

  /** HU-C02: acceso con código OTP (SMS o correo). */
  async solicitarOtp(identificador: string) {
    const u = await this.buscarPorIdentificador(this.db, identificador);
    if (!u || u.rol !== 'cliente' || u.estado !== 'activo') {
      return { enviado: true }; // no revelamos si la cuenta existe
    }
    const codigo = await this.crearOtp(u.id, 'login');
    return { enviado: true, ...(MOSTRAR_OTP ? { codigoDev: codigo } : {}) };
  }

  async verificarOtp(identificador: string, codigo: string) {
    const u = await this.buscarPorIdentificador(this.db, identificador);
    if (!u || u.estado !== 'activo') throw new UnauthorizedException('El código es incorrecto o ya venció');
    await this.consumirOtp(u.id, 'login', codigo);
    return this.sesionPara(this.db, u);
  }

  async yo(s: Sesion) {
    const u = await one(
      this.db,
      `select u.id, u.rol, u.nombre, u.correo, u.celular, u.creado_en, p.codigo_cliente, p.codigo_invitacion, p.intereses,
              p.zona_residencia, p.fecha_nacimiento, p.genero, p.alias, e.local_id, e.etiqueta as caja, l.nombre as local_nombre
       from usuario u
       left join cliente_perfil p on p.usuario_id = u.id
       left join empleado_local e on e.usuario_id = u.id
       left join local l on l.id = e.local_id
       where u.id = $1`,
      [s.sub],
    );
    if (!u) throw new NotFoundException('Usuario no encontrado');
    return u;
  }

  // ------------------------------------------------------------------ HU-C03 pase dinámico
  async pase(clienteId: string) {
    const p = await one<{ codigo_cliente: string; secreto_pase: string; nombre: string }>(
      this.db,
      `select p.codigo_cliente, p.secreto_pase, u.nombre from cliente_perfil p join usuario u on u.id = p.usuario_id where p.usuario_id = $1`,
      [clienteId],
    );
    if (!p) throw new NotFoundException('Perfil no encontrado');
    return { codigoCliente: p.codigo_cliente, secreto: p.secreto_pase, pasoSegundos: 60, digitos: 6, formato: 'PP1:{codigoCliente}:{totp}' };
  }

  async rotarPase(clienteId: string) {
    await this.db.query('update cliente_perfil set secreto_pase = $2 where usuario_id = $1', [clienteId, secretoAleatorio()]);
    return this.pase(clienteId);
  }

  /**
   * Verifica el QR del pase. Con `offline` se acepta una ventana mayor alrededor de la hora
   * de captura (la compra se registró sin red en la caja) y la operación queda marcada.
   */
  async verificarPase(q: Queryable, contenido: string, capturadoEn: Date, offline = false) {
    const m = /^PP1:([A-Z0-9]{8}):(\d{6})$/.exec(contenido.trim());
    if (!m) throw new BadRequestException('El código escaneado no es un pase de Paseo Points');
    const c = await one<{ usuario_id: string; secreto_pase: string; estado: string; nombre: string }>(
      q,
      `select p.usuario_id, p.secreto_pase, u.estado, u.nombre from cliente_perfil p join usuario u on u.id = p.usuario_id where p.codigo_cliente = $1`,
      [m[1]],
    );
    if (!c) throw new NotFoundException('Cliente no encontrado');
    if (c.estado !== 'activo') throw new ForbiddenException('La cuenta de este cliente está bloqueada');
    if (!totpValido(c.secreto_pase, m[2], capturadoEn.getTime(), offline ? 10 : 1)) {
      throw new BadRequestException('El pase venció. Pide al cliente que lo muestre de nuevo.');
    }
    return { clienteId: c.usuario_id, nombre: c.nombre };
  }

  /** HU-L03: búsqueda por últimos dígitos del celular; el cliente confirma con el código de 6 dígitos de su pase. */
  async buscarPorCelular(ultimos: string) {
    if (!/^\d{4}$/.test(ultimos)) throw new BadRequestException('Ingresa los últimos 4 dígitos del celular');
    const filas = await many<{ id: string; nombre: string; celular: string }>(
      this.db,
      `select u.id, u.nombre, u.celular from usuario u where u.rol = 'cliente' and u.estado = 'activo' and u.celular like $1 limit 10`,
      [`%${ultimos}`],
    );
    return filas.map((f) => ({ id: f.id, nombre: enmascararNombre(f.nombre), celular: `•••• ${f.celular.slice(-4)}` }));
  }

  async verificarCodigoCliente(q: Queryable, clienteId: string, codigo6: string, capturadoEn: Date) {
    const c = await one<{ secreto_pase: string; nombre: string; estado: string }>(
      q,
      `select p.secreto_pase, u.nombre, u.estado from cliente_perfil p join usuario u on u.id = p.usuario_id where p.usuario_id = $1`,
      [clienteId],
    );
    if (!c || c.estado !== 'activo') throw new NotFoundException('Cliente no encontrado');
    if (!totpValido(c.secreto_pase, codigo6, capturadoEn.getTime(), 1)) {
      throw new BadRequestException('El código no coincide con el que muestra el cliente en su app');
    }
    return { clienteId, nombre: c.nombre };
  }

  // ------------------------------------------------------------------ HU-C22 privacidad
  async privacidad(clienteId: string) {
    return one(
      this.db,
      `select consent_terminos_en, consent_ubicacion, consent_personalizacion, mostrar_nombre_locales, zona_residencia, intereses
       from cliente_perfil where usuario_id = $1`,
      [clienteId],
    );
  }

  async actualizarPrivacidad(clienteId: string, recintoId: string, c: { consentUbicacion?: boolean; consentPersonalizacion?: boolean; mostrarNombreLocales?: boolean }) {
    return this.db.tx(async (q) => {
      const antes = await one(q, 'select consent_ubicacion, consent_personalizacion, mostrar_nombre_locales from cliente_perfil where usuario_id = $1', [clienteId]);
      const despues = await one(
        q,
        `update cliente_perfil set
           consent_ubicacion = coalesce($2, consent_ubicacion),
           consent_personalizacion = coalesce($3, consent_personalizacion),
           mostrar_nombre_locales = coalesce($4, mostrar_nombre_locales)
         where usuario_id = $1 returning consent_ubicacion, consent_personalizacion, mostrar_nombre_locales`,
        [clienteId, c.consentUbicacion ?? null, c.consentPersonalizacion ?? null, c.mostrarNombreLocales ?? null],
      );
      await this.auditoria.registrar(q, clienteId, 'cambiar_consentimiento', 'cliente_perfil', clienteId, antes, despues);
      await this.telemetria.registrar(q, { recintoId, clienteId, tipo: 'consentimiento.cambiado', payload: despues as any });
      return despues;
    });
  }

  async actualizarPerfil(clienteId: string, d: { nombre?: string; zonaResidencia?: string; intereses?: string[] }) {
    await this.db.tx(async (q) => {
      if (d.nombre) await q.query('update usuario set nombre = $2 where id = $1', [clienteId, d.nombre]);
      await q.query(
        `update cliente_perfil set zona_residencia = coalesce($2, zona_residencia), intereses = coalesce($3, intereses) where usuario_id = $1`,
        [clienteId, d.zonaResidencia ?? null, d.intereses ?? null],
      );
    });
    return { ok: true };
  }

  /** Derecho a salir: se borra la identidad y se rompe el vínculo con los eventos (nuevo seudónimo). */
  async eliminarCuenta(clienteId: string) {
    await this.db.tx(async (q) => {
      await q.query(
        `update usuario set nombre = 'Cliente eliminado', correo = null, celular = null, hash = null, estado = 'eliminado' where id = $1`,
        [clienteId],
      );
      await q.query(
        `update cliente_perfil set id_seudonimo = gen_random_uuid(), fecha_nacimiento = null, genero = null, zona_residencia = null,
           intereses = '{}', consent_ubicacion = false, consent_personalizacion = false, mostrar_nombre_locales = false,
           secreto_pase = $2
         where usuario_id = $1`,
        [clienteId, secretoAleatorio()],
      );
      await q.query('delete from notificacion where usuario_id = $1', [clienteId]);
      await this.auditoria.registrar(q, clienteId, 'eliminar_cuenta', 'usuario', clienteId, null, null);
    });
    return { eliminado: true };
  }

  // ------------------------------------------------------------------ HU-A02 usuarios y roles
  listarUsuarios(recintoId: string, f: { rol?: string; q?: string }) {
    const cond = ['u.recinto_id = $1', "u.estado <> 'eliminado'"];
    const p: unknown[] = [recintoId];
    if (f.rol) {
      p.push(f.rol);
      cond.push(`u.rol = $${p.length}`);
    }
    if (f.q) {
      p.push(`%${f.q.toLowerCase()}%`);
      cond.push(`(lower(u.nombre) like $${p.length} or u.correo like $${p.length} or u.celular like $${p.length})`);
    }
    return many(
      this.db,
      `select u.id, u.rol, u.nombre, u.correo, u.celular, u.estado, u.creado_en, e.local_id, l.nombre as local, e.etiqueta
       from usuario u left join empleado_local e on e.usuario_id = u.id left join local l on l.id = e.local_id
       where ${cond.join(' and ')} order by u.creado_en desc limit 200`,
      p,
    );
  }

  async crearUsuarioInterno(
    admin: Sesion,
    d: { nombre: string; correo: string; celular?: string; password: string; rol: Rol; localId?: string; etiqueta?: string },
  ) {
    if (d.rol === 'cliente') throw new BadRequestException('Los clientes se registran desde la app');
    if (d.rol === 'comercio' && !d.localId) throw new BadRequestException('Elige el comercio de la cuenta');
    const hash = await hashPassword(d.password);
    return this.db.tx(async (q) => {
      const existe = await one(q, 'select id from usuario where correo = $1', [d.correo.toLowerCase()]);
      if (existe) throw new ConflictException('Ya existe un usuario con ese correo');
      const u = await one(
        q,
        `insert into usuario (recinto_id, rol, nombre, correo, celular, hash) values ($1,$2,$3,$4,$5,$6) returning id, rol, nombre, correo`,
        [admin.recintoId, d.rol, d.nombre, d.correo.toLowerCase(), d.celular ?? null, hash],
      );
      if (d.localId) {
        await q.query('insert into empleado_local (usuario_id, local_id, rol, etiqueta) values ($1,$2,$3,$4)', [
          u.id, d.localId, d.rol, d.etiqueta ?? '',
        ]);
      }
      await this.auditoria.registrar(q, admin.sub, 'crear_usuario', 'usuario', u.id, null, { ...u, localId: d.localId });
      return u;
    });
  }

  async cambiarEstado(admin: Sesion, usuarioId: string, estado: 'activo' | 'bloqueado') {
    return this.db.tx(async (q) => {
      const antes = await one(q, 'select id, estado, rol from usuario where id = $1 and recinto_id = $2', [usuarioId, admin.recintoId]);
      if (!antes) throw new NotFoundException('Usuario no encontrado');
      if (usuarioId === admin.sub) throw new BadRequestException('No puedes bloquear tu propia cuenta');
      await q.query('update usuario set estado = $2, intentos_fallidos = 0, bloqueado_hasta = null where id = $1', [usuarioId, estado]);
      await this.auditoria.registrar(q, admin.sub, estado === 'bloqueado' ? 'bloquear_usuario' : 'desbloquear_usuario', 'usuario', usuarioId, antes, { estado });
      return { id: usuarioId, estado };
    });
  }

  nuevaClaveIdempotencia() {
    return randomUUID();
  }
}

export function enmascararNombre(nombre: string) {
  const [n, a] = nombre.split(' ');
  return a ? `${n} ${a[0]}.` : n;
}
