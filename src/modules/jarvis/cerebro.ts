import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LlmService } from '../ia/llm.service.js';

/** Puerto: un motor que redacta el mensaje de voz a partir del borrador y el contexto. */
export interface MotorTexto {
  readonly nombre: string;
  disponible(): Promise<boolean>;
  generar(sistema: string, prompt: string, opciones: { maxTokens: number; timeoutMs: number }): Promise<string | null>;
}

/**
 * Ollama local (por defecto qwen2.5:1.5b). Sin costo por cliente y sin depender de la nube;
 * se mantiene el modelo cargado en memoria (keep_alive) para responder en tiempo real.
 */
@Injectable()
export class MotorOllama implements MotorTexto {
  readonly nombre: string;
  private readonly url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  private readonly modelo = process.env.OLLAMA_MODELO ?? 'qwen2.5:1.5b';
  private estado: { ok: boolean; en: number } = { ok: false, en: 0 };

  constructor() {
    this.nombre = `ollama:${this.modelo}`;
  }

  async disponible() {
    if (process.env.JARVIS_OLLAMA === 'false') return false;
    if (Date.now() - this.estado.en < 30_000) return this.estado.ok;
    try {
      const r = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(800) });
      const j = (await r.json()) as { models?: { name: string }[] };
      const ok = !!j.models?.some((m) => m.name === this.modelo || m.name.startsWith(`${this.modelo}`));
      this.estado = { ok, en: Date.now() };
    } catch {
      this.estado = { ok: false, en: Date.now() };
    }
    return this.estado.ok;
  }

  async generar(sistema: string, prompt: string, op: { maxTokens: number; timeoutMs: number }) {
    try {
      const r = await fetch(`${this.url}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.modelo, system: sistema, prompt, stream: false, keep_alive: '30m', options: { temperature: 0.2, num_predict: op.maxTokens } }),
        signal: AbortSignal.timeout(op.timeoutMs),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { response?: string };
      return j.response?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Carga el modelo en memoria para que la primera orden no pague el arranque. */
  async calentar() {
    if (await this.disponible()) await this.generar('Responde OK.', 'OK', { maxTokens: 2, timeoutMs: 180_000 });
  }
}

/** Claude en la nube: solo si se habilita JARVIS_PERMITIR_NUBE (agrega latencia y costo por mensaje). */
@Injectable()
export class MotorNube implements MotorTexto {
  readonly nombre = 'claude';
  constructor(private readonly llm: LlmService) {}
  async disponible() {
    return process.env.JARVIS_PERMITIR_NUBE === 'true' && this.llm.disponible;
  }
  generar(sistema: string, prompt: string, op: { maxTokens: number; timeoutMs: number }) {
    return Promise.race([
      this.llm.completar(sistema, prompt, { maxTokens: op.maxTokens }),
      new Promise<null>((r) => setTimeout(() => r(null), op.timeoutMs)),
    ]);
  }
}

export const SISTEMA_JARVIS = `Eres Jarvis, el guía de voz del centro comercial Paseo Aranjuez en Bolivia.
Hablas en español neutro, con tuteo, cálido y directo.
Reescribe el mensaje que te dan para decirlo en voz alta mientras la persona camina.
Reglas: máximo 2 oraciones; conserva exactamente los nombres de locales, pisos, números de local, metros, minutos y puntos;
no inventes lugares, precios ni ofertas que no estén en el mensaje o el contexto; sin emojis, sin comillas, sin listas.
Habla siempre en segunda persona (tú): Jarvis no camina ni recoge nada.
Ejemplo. Mensaje: «Tu pedido de Napoli se retira en las Terrazas, local T03, a 40 metros de ti.» Respuesta: «Tu pedido de Napoli te espera en las Terrazas, local T03, a solo 40 metros.»`;

export const SISTEMA_CHAT = `Eres Jarvis, el asistente de voz del Paseo Aranjuez, un centro comercial en La Paz, Bolivia.
Conversas con un cliente: cálido, natural y breve, con tuteo, como un buen anfitrión.
Te dan la respuesta correcta ya armada con datos reales del Paseo. Reescríbela para que suene natural y siga el hilo de la conversación.
Reglas: conserva exactamente nombres, números, precios, horas, metros y puntos; no agregues lugares, precios ni datos que no estén en la respuesta;
máximo 3 oraciones; sin emojis, sin listas, sin comillas; si la conversación ya empezó, no vuelvas a saludar.`;

export const SISTEMA_LIBRE = `Eres Jarvis, el asistente de voz del Paseo Aranjuez, un centro comercial en La Paz, Bolivia. Hablas con tuteo, cálido y breve.
Responde la pregunta del cliente usando solo los datos del Paseo que te doy. No inventes horarios, precios, lugares ni políticas.
Si los datos no alcanzan, dilo con honestidad en una frase y ofrece algo que sí puedes hacer: buscar un producto, ver promociones, eventos o cómo llegar a un lugar.
Máximo 2 oraciones, sin emojis ni listas.`;

/**
 * Cerebro de Jarvis (Strategy con respaldo): prueba los motores en orden y, si ninguno responde
 * a tiempo o la respuesta pierde datos clave, usa el borrador determinista. Siempre hay respuesta.
 */
@Injectable()
export class CerebroJarvis implements OnModuleInit {
  private readonly log = new Logger('Jarvis');
  private readonly motores: MotorTexto[];
  private readonly timeoutMs = Number(process.env.JARVIS_TIMEOUT_MS ?? 4000);

  constructor(
    private readonly ollama: MotorOllama,
    nube: MotorNube,
  ) {
    this.motores = [ollama, nube];
  }

  onModuleInit() {
    setTimeout(() => {
      void this.ollama.calentar().then(async () => this.log.log((await this.ollama.disponible()) ? `${this.ollama.nombre} listo` : 'Ollama no disponible: Jarvis usa plantillas'));
    }, 2000);
  }

  async estado() {
    return Promise.all(this.motores.map(async (m) => ({ motor: m.nombre, disponible: await m.disponible() })));
  }

  /**
   * @param borrador mensaje correcto ya armado con datos reales
   * @param contexto datos cercanos (solo lo que el modelo puede usar)
   * @param claves textos que la respuesta debe conservar (nombres, números)
   */
  async redactar(
    borrador: string,
    contexto: string[],
    claves: string[],
    opciones: { historial?: string; pregunta?: string } = {},
  ): Promise<{ texto: string; motor: string; latenciaMs: number }> {
    const t0 = Date.now();
    const chat = opciones.pregunta !== undefined;
    const prompt = chat
      ? `${opciones.historial ? `Conversación hasta ahora:\n${opciones.historial}\n\n` : ''}El cliente dijo: ${opciones.pregunta}\nRespuesta correcta: ${borrador}\nReescribe la respuesta correcta para decirla en voz alta.`
      : `Mensaje: ${borrador}\n${contexto.length ? `Contexto cercano:\n- ${contexto.join('\n- ')}\n` : ''}Reescríbelo para decirlo en voz alta.`;
    for (const m of this.motores) {
      if (!(await m.disponible())) continue;
      const r = await m.generar(chat ? SISTEMA_CHAT : SISTEMA_JARVIS, prompt, { maxTokens: chat ? 130 : 90, timeoutMs: this.timeoutMs });
      const texto = r ? CerebroJarvis.limpiar(r, chat ? 3 : 2) : null;
      if (texto && claves.every((c) => CerebroJarvis.normalizar(texto).includes(CerebroJarvis.normalizar(c))) && CerebroJarvis.mismosNumeros(borrador, texto) && !CerebroJarvis.primeraPersonaNueva(borrador, texto)) {
        return { texto, motor: m.nombre, latenciaMs: Date.now() - t0 };
      }
    }
    return { texto: borrador, motor: 'plantilla', latenciaMs: Date.now() - t0 };
  }

  /**
   * Respuesta libre para preguntas poco comunes, solo con los datos dados. Se descarta si menciona
   * una cifra que no está en los datos (el modelo no puede inventar horarios ni precios).
   */
  async responderLibre(pregunta: string, datos: string[], historial: string): Promise<{ texto: string; motor: string; latenciaMs: number } | null> {
    const t0 = Date.now();
    const prompt = `Datos del Paseo ahora:\n- ${datos.join('\n- ')}\n\n${historial ? `Conversación:\n${historial}\n\n` : ''}Pregunta del cliente: ${pregunta}`;
    const permitidos = new Set(CerebroJarvis.numeros(datos.join(' ') + ' ' + pregunta));
    for (const m of this.motores) {
      if (!(await m.disponible())) continue;
      const r = await m.generar(SISTEMA_LIBRE, prompt, { maxTokens: 110, timeoutMs: this.timeoutMs + 2000 });
      const texto = r ? CerebroJarvis.limpiar(r) : null;
      if (texto && texto.length > 8 && CerebroJarvis.numeros(texto).every((n) => permitidos.has(n))) return { texto, motor: m.nombre, latenciaMs: Date.now() - t0 };
    }
    return null;
  }

  static numeros(s: string) {
    return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(',', '.'))));
  }

  /** Clasificación breve en JSON con el primer motor disponible (sin respaldo: devuelve null). */
  async json<T>(sistema: string, prompt: string): Promise<T | null> {
    for (const m of this.motores) {
      if (!(await m.disponible())) continue;
      const j = LlmService.json<T>(await m.generar(sistema, prompt, { maxTokens: 60, timeoutMs: this.timeoutMs }));
      if (j) return j;
    }
    return null;
  }

  /** El modelo no puede agregar, quitar ni cambiar cifras (metros, minutos, puntos, precios). */
  static mismosNumeros(borrador: string, texto: string) {
    const nums = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(',', '.')))).sort().join('|');
    return nums(borrador) === nums(texto);
  }

  /** Un modelo chico tiende a hablar como si él caminara («paso por», «vengo»): se descarta esa respuesta. */
  static primeraPersonaNueva(borrador: string, texto: string) {
    const verbos = /\b(paso|vengo|voy|llego|camino|recojo|estoy|tengo|encuentro)\b/g;
    const limpio = (s: string) => CerebroJarvis.normalizar(s).replace(/\bde paso\b/g, '');
    const enBorrador = new Set(limpio(borrador).match(verbos) ?? []);
    return (limpio(texto).match(verbos) ?? []).some((v) => !enBorrador.has(v));
  }

  static normalizar(s: string) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Quita adornos y corta a pocas oraciones (se escucha mientras se camina). */
  static limpiar(s: string, maxOraciones = 2) {
    const t = s.replace(/[*_#>"“”]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
    const oraciones = t.match(/[^.!?]+[.!?]+/g) ?? [t];
    return oraciones.slice(0, maxOraciones).map((o) => o.trim()).join(' ');
  }
}
