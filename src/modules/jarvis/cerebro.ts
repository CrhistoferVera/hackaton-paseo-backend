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
Ejemplo. Mensaje: «Tu pedido se retira en {piso}, local {número}, a 40 metros de ti.» Respuesta: «Tu pedido te espera en {piso}, local {número}, a solo 40 metros.»`;

export const SISTEMA_CHAT = `Eres Jarvis, el asistente de voz del Paseo Aranjuez, un centro comercial en La Paz, Bolivia.
Conversas con un cliente: cálido, natural y breve, con tuteo, como un buen anfitrión.
Te dan la respuesta correcta ya armada con datos reales del Paseo. Reescríbela para que suene natural y siga el hilo de la conversación.
Reglas: conserva exactamente nombres, números, precios, horas, metros y puntos; no agregues lugares, precios ni datos que no estén en la respuesta;
máximo 3 oraciones; sin emojis, sin listas, sin comillas; si la conversación ya empezó, no vuelvas a saludar.`;

export const SISTEMA_ANALISTA = `Eres el analista de datos del Centro de Inteligencia del Paseo Aranjuez (La Paz, Bolivia). Hablas con el equipo de administración y marketing.
Te dan la respuesta correcta ya armada con datos reales. Reescríbela clara y profesional, en español, como un analista que explica a su jefa.
Reglas: conserva exactamente todos los números, porcentajes, nombres de locales y fechas; no agregues datos; máximo 4 oraciones; sin emojis ni listas.`;

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
    opciones: { historial?: string; pregunta?: string; sistema?: string } = {},
  ): Promise<{ texto: string; motor: string; latenciaMs: number }> {
    const t0 = Date.now();
    const chat = opciones.pregunta !== undefined;
    const prompt = chat
      ? `${opciones.historial ? `Conversación hasta ahora:\n${opciones.historial}\n\n` : ''}El cliente dijo: ${opciones.pregunta}\nRespuesta correcta: ${borrador}\nReescribe la respuesta correcta para decirla en voz alta.`
      : `Mensaje: ${borrador}\n${contexto.length ? `Contexto cercano:\n- ${contexto.join('\n- ')}\n` : ''}Reescríbelo para decirlo en voz alta.`;
    for (const m of this.motores) {
      if (!(await m.disponible())) continue;
      const r = await m.generar(opciones.sistema ?? (chat ? SISTEMA_CHAT : SISTEMA_JARVIS), prompt, { maxTokens: chat ? 130 : 90, timeoutMs: this.timeoutMs });
      const texto = r ? CerebroJarvis.limpiar(r, chat ? 3 : 2) : null;
      if (texto && claves.every((c) => CerebroJarvis.normalizar(texto).includes(CerebroJarvis.normalizar(c))) && CerebroJarvis.mismosNumeros(borrador, texto) && !CerebroJarvis.primeraPersonaNueva(borrador, texto) && !CerebroJarvis.agregaSaludo(borrador, texto) && !CerebroJarvis.cambiaSentido(borrador, texto, opciones.pregunta ?? '') && texto.length <= borrador.length * 1.5 + 30) {
        return { texto, motor: m.nombre, latenciaMs: Date.now() - t0 };
      }
    }
    return { texto: borrador, motor: 'plantilla', latenciaMs: Date.now() - t0 };
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

  /**
   * El modelo puede cambiar el orden y las palabras de enlace, pero no el sentido: no puede quitar ni
   * poner una negación («no atiende» ↔ «atiende») ni agregar nombres o palabras de contenido que no
   * estaban en el borrador ni en la pregunta (así no inventa lugares, productos ni condiciones).
   */
  static cambiaSentido(borrador: string, texto: string, pregunta = '') {
    const n = (x: string) => CerebroJarvis.normalizar(x).replace(/[^a-z0-9ñ\s]/g, ' ');
    const negaciones = (s: string) => (n(s).match(/\b(no|nunca|ningun|ninguna|ninguno|sin|agotad[oa]s?|cerrad[oa]s?)\b/g) ?? []).length;
    if ((negaciones(borrador) > 0) !== (negaciones(texto) > 0)) return true;
    const raiz = (w: string) => w.replace(/(es|s)$/, '').replace(/[aoe]$/, '');
    const base = new Set([...n(borrador).split(/\s+/), ...n(pregunta).split(/\s+/)].map(raiz));
    const enlace = /^(ahora|mismo|tambien|ademas|aqui|alli|justo|solo|puedes|quieres|tienes|tiene|esta|estan|hay|para|desde|hasta|cerca|camina|caminando|llegar|llevo|ruta|minuto|metro|aproximadamente|unos|unas|cuesta|precio|ofrece|ofrecen|encuentras|disfruta|disfrutar|aprovecha|aprovechar|claro|perfecto|genial|listo|mira|recuerda|ojo|gusto|ayudo|ayudar|algo|mas|otro|otra|pedir|pedirlo|retirar|retiralo|local|piso|nivel)$/;
    // Un nombre propio nuevo (no al inicio de una oración) es un dato inventado: «Nike», «Starbucks»
    const propios = texto
      .split(/[.!?]\s+/)
      .flatMap((o) => o.trim().split(/\s+/).slice(1))
      .filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w))
      .map((w) => raiz(n(w).trim()))
      .filter((w) => w && !base.has(w));
    if (propios.length) return true;
    const nuevas = n(texto).split(/\s+/).filter((w) => w.length >= 5 && !enlace.test(w) && !base.has(raiz(w)));
    return nuevas.length > 1;
  }

  /** «¡Hola, cliente!» a mitad de la conversación suena robótico: se descarta. */
  static agregaSaludo(borrador: string, texto: string) {
    const n = (x: string) => CerebroJarvis.normalizar(x);
    const saludo = /\b(hola|bienvenid[oa]|buenas)\b/;
    const cliente = /\bcliente\b/;
    return (saludo.test(n(texto)) && !saludo.test(n(borrador))) || (cliente.test(n(texto)) && !cliente.test(n(borrador)));
  }

  static normalizar(s: string) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Quita adornos y corta a pocas oraciones (se escucha mientras se camina). */
  static limpiar(s: string, maxOraciones = 2) {
    const t = s.replace(/^\s*(jarvis|respuesta|asistente)\s*:\s*/i, '').replace(/[*_#>"“”]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
    const oraciones = t.match(/[^.!?]+[.!?]+/g) ?? [t];
    return oraciones.slice(0, maxOraciones).map((o) => o.trim()).join(' ');
  }
}
