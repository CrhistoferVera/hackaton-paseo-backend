import { Injectable } from '@nestjs/common';
import { Db, many } from '../../infra/db/db.js';

/** Lo último de lo que se habló: permite «¿y cuánto cuesta?» o «¿cómo llego?» sin repetir el nombre. */
export interface Entidades {
  ambito?: 'paseo' | 'local';
  localId?: string;
  productoId?: string;
  actividadId?: string;
  servicioTipo?: string;
  categoria?: string;
  termino?: string;
  pedidoLocalId?: string;
  recompensaId?: string;
  /** asistente del admin: período del que se viene hablando (hoy, semana, mes…) */
  periodo?: string;
  localId2?: string;
}

export interface Turno {
  rol: 'cliente' | 'jarvis';
  texto: string;
  intencion: string | null;
  entidades: Entidades;
  datos?: Record<string, any>;
  creado_en: Date;
}

/** Una conversación sigue viva mientras no pasen estos minutos sin hablar. */
const VIGENCIA_MIN = 45;

/**
 * Memoria de la conversación de Jarvis con cada cliente (tabla conversacion_jarvis).
 * Guarda los turnos y las entidades mencionadas; el hilo se corta tras 45 minutos de silencio
 * o cuando el cliente pide empezar de nuevo.
 */
@Injectable()
export class MemoriaJarvis {
  constructor(private readonly db: Db) {}

  async guardar(clienteId: string, rol: 'cliente' | 'jarvis', texto: string, intencion: string | null = null, entidades: Entidades = {}, datos: Record<string, unknown> = {}) {
    const limpias = Object.fromEntries(Object.entries(entidades).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    await this.db.query('insert into conversacion_jarvis (cliente_id, rol, texto, intencion, entidades, datos) values ($1,$2,$3,$4,$5,$6)', [
      clienteId, rol, texto, intencion, JSON.stringify(limpias), JSON.stringify(datos),
    ]);
  }

  /** Turnos de la conversación vigente, del más antiguo al más reciente. */
  async hilo(clienteId: string, maximo = 10): Promise<Turno[]> {
    const filas = await many<Turno & { id: number }>(
      this.db,
      'select id, rol, texto, intencion, entidades, datos, creado_en from conversacion_jarvis where cliente_id = $1 order by creado_en desc, id desc limit 60',
      [clienteId],
    );
    const vivos: Turno[] = [];
    let anterior = Date.now();
    for (const f of filas) {
      const t = new Date(f.creado_en).getTime();
      if (anterior - t > VIGENCIA_MIN * 60_000) break;
      if (f.intencion === 'reinicio') break;
      vivos.push(f);
      anterior = t;
      if (vivos.length >= maximo) break;
    }
    return vivos.reverse();
  }

  /** Lo más reciente de cada tipo de entidad en la conversación vigente. */
  contexto(hilo: Turno[]): Entidades {
    const e: Entidades = {};
    for (const t of hilo) {
      if (t.entidades?.ambito === 'paseo') { delete e.localId; delete e.localId2; }
      Object.assign(e, t.entidades ?? {});
    }
    return e;
  }

  /** Historial para la app (incluye conversaciones anteriores), del más antiguo al más reciente. */
  async historial(clienteId: string, limite = 40) {
    const filas = await many(
      this.db,
      `select id, rol, texto, intencion, datos, creado_en from conversacion_jarvis
       where cliente_id = $1 and intencion is distinct from 'reinicio'
         and id > coalesce((select max(id) from conversacion_jarvis where cliente_id = $1 and intencion = 'reinicio'), 0)
       order by creado_en desc limit $2`,
      [clienteId, limite],
    );
    return filas.reverse();
  }

  async reiniciar(clienteId: string) {
    await this.guardar(clienteId, 'jarvis', 'Conversación nueva', 'reinicio');
  }

  /** Texto compacto del hilo para darle continuidad al modelo local. */
  static paraPrompt(hilo: Turno[], turnos = 6) {
    return hilo
      .slice(-turnos)
      .map((t) => `${t.rol === 'cliente' ? 'Usuario' : 'Jarvis'}: ${t.texto}${t.rol === 'jarvis' && t.datos?.consultas ? `\nConsultas resueltas: ${JSON.stringify(t.datos.consultas)}` : ''}`)
      .join('\n');
  }
}
