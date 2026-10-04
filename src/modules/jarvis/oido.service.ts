import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { type ChildProcess, fork, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const MODELO = process.env.WHISPER_MODELO ?? 'onnx-community/whisper-small';
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_SEGUNDOS = 30;
const ESPERA_MAX_MS = 60_000;

type Mensaje = { tipo: 'listo'; ms: number } | { tipo: 'fallo'; error: string } | { tipo: 'texto'; id: number; texto?: string; error?: string };

/**
 * Oído de Jarvis: convierte la voz del cliente en texto en el propio servidor, con Whisper
 * (transformers.js sobre ONNX) y ffmpeg para decodificar lo que mande el celular o el navegador
 * (webm, m4a, wav, ogg). Gratis y sin nube: el audio no sale de la máquina y no se guarda.
 * La primera vez descarga el modelo a .data/modelos; después funciona sin internet.
 *
 * Whisper corre en un proceso hijo (oido.worker): la voz de Jarvis usa otra librería ONNX y en el
 * mismo proceso chocan (la que carga segunda falla o se vuelve lenta). Si el hijo se cae, se reinicia.
 */
@Injectable()
export class OidoJarvis implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OidoJarvis');
  private hijo: ChildProcess | null = null;
  private listo = false;
  private esperaListo: Promise<void> | null = null;
  private siguienteId = 1;
  private readonly pendientes = new Map<number, { ok: (t: string) => void; falla: (e: Error) => void; timer: NodeJS.Timeout }>();
  private cerrando = false;
  private arranque?: NodeJS.Timeout;

  onModuleInit() {
    if (process.env.JARVIS_OIDO === 'false') return;
    // Carga en segundo plano: la API arranca de inmediato
    this.arranque = setTimeout(() => void this.arrancar().catch((e) => this.log.warn(`Whisper no disponible: ${e.message}`)), 1500);
  }

  /** Al cerrar la app (o al terminar el seed) no queda un Whisper vivo que impida salir al proceso. */
  onModuleDestroy() {
    this.cerrando = true;
    clearTimeout(this.arranque);
    this.hijo?.kill();
  }

  get estado() {
    return { modelo: MODELO, listo: this.listo, activo: process.env.JARVIS_OIDO !== 'false' };
  }

  /** Lanza (una vez) el proceso de Whisper y espera a que tenga el modelo cargado. */
  private arrancar(): Promise<void> {
    if (this.cerrando) return Promise.reject(new Error('la aplicación se está cerrando'));
    this.esperaListo ??= new Promise<void>((ok, falla) => {
      const archivo = fileURLToPath(new URL('./oido.worker.js', import.meta.url));
      if (!existsSync(archivo)) return falla(new Error(`no se encontró ${archivo}`));
      const t0 = Date.now();
      const hijo = fork(archivo, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.hijo = hijo;
      hijo.on('message', (m: Mensaje) => {
        if (m.tipo === 'listo') {
          this.listo = true;
          this.log.log(`${MODELO} listo en ${Math.round((Date.now() - t0) / 1000)} s (proceso ${hijo.pid})`);
          ok();
        } else if (m.tipo === 'fallo') falla(new Error(m.error));
        else {
          const p = this.pendientes.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pendientes.delete(m.id);
          if (m.error) p.falla(new Error(m.error));
          else p.ok(m.texto ?? '');
        }
      });
      hijo.on('exit', (codigo) => {
        this.listo = false;
        this.hijo = null;
        this.esperaListo = null;
        for (const [, p] of this.pendientes) {
          clearTimeout(p.timer);
          p.falla(new Error('el reconocimiento de voz se reinició'));
        }
        this.pendientes.clear();
        falla(new Error(`Whisper terminó (código ${codigo})`));
        if (!this.cerrando) {
          this.log.warn(`el proceso de Whisper terminó (código ${codigo}); se reinicia en 5 s`);
          setTimeout(() => void this.arrancar().catch(() => undefined), 5000);
        }
      });
    });
    return this.esperaListo;
  }

  private enviar(pcm: Float32Array): Promise<string> {
    return new Promise((ok, falla) => {
      if (!this.hijo) return falla(new Error('Whisper no está corriendo'));
      const id = this.siguienteId++;
      const timer = setTimeout(() => {
        this.pendientes.delete(id);
        falla(new Error('Whisper tardó demasiado'));
      }, ESPERA_MAX_MS);
      this.pendientes.set(id, { ok, falla, timer });
      this.hijo.send({ id, pcm });
    });
  }

  /** Decodifica cualquier formato de audio a PCM mono de 16 kHz (lo que espera Whisper). */
  private decodificar(audio: Buffer): Promise<Float32Array> {
    return new Promise((ok, falla) => {
      if (!ffmpegPath) return falla(new Error('ffmpeg no está disponible'));
      const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SEGUNDOS), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
      const partes: Buffer[] = [];
      let error = '';
      p.stdout.on('data', (d: Buffer) => partes.push(d));
      p.stderr.on('data', (d: Buffer) => (error += d.toString()));
      p.on('error', falla);
      p.on('close', (code) => {
        if (code !== 0) return falla(new Error(error.trim() || `ffmpeg terminó con código ${code}`));
        const b = Buffer.concat(partes);
        ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
      });
      p.stdin.on('error', () => undefined);
      p.stdin.end(audio);
    });
  }

  async transcribir(audio: Buffer | undefined): Promise<{ texto: string; segundos: number; latenciaMs: number }> {
    if (!audio?.length) throw new BadRequestException('No llegó audio');
    if (audio.length > MAX_BYTES) throw new BadRequestException('El audio es demasiado largo');
    if (process.env.JARVIS_OIDO === 'false') throw new ServiceUnavailableException('El reconocimiento de voz está desactivado');
    const t0 = Date.now();
    let pcm: Float32Array;
    try {
      pcm = await this.decodificar(audio);
    } catch (e: any) {
      this.log.warn(`audio ilegible (${audio.length} bytes): ${e.message}`);
      throw new BadRequestException('No pude leer el audio que mandó el teléfono. Intenta de nuevo o escribe tu pregunta.');
    }
    const segundos = pcm.length / 16000;
    const e = energia(pcm);
    // Algunos Android graban muy bajo: solo se descarta lo que es silencio de verdad
    if (segundos < 0.3 || e < 0.0008) {
      this.log.log(`audio sin voz (${audio.length} bytes, ${segundos.toFixed(1)} s, energía ${e.toFixed(4)})`);
      return { texto: '', segundos, latenciaMs: Date.now() - t0 };
    }
    // Si el proceso todavía carga el modelo (arranque de la API), se espera hasta 25 s antes de rendirse
    const preparado = await Promise.race([this.arrancar().then(() => true, () => false), new Promise<boolean>((ok) => setTimeout(() => ok(false), 25_000))]);
    if (!preparado) throw new ServiceUnavailableException('El reconocimiento de voz se está preparando; intenta en un momento o escribe tu pregunta');
    let crudo: string;
    try {
      crudo = await this.enviar(normalizarVolumen(pcm));
    } catch (e: any) {
      this.log.warn(`no se pudo transcribir: ${e.message}`);
      throw new ServiceUnavailableException('No pude procesar el audio en este momento; intenta otra vez o escribe tu pregunta');
    }
    const texto = limpiarTranscripcion(crudo);
    this.log.log(`voz ${segundos.toFixed(1)} s → «${texto.slice(0, 80)}» en ${Date.now() - t0} ms`);
    return { texto, segundos: Math.round(segundos * 10) / 10, latenciaMs: Date.now() - t0 };
  }
}

function energia(pcm: Float32Array) {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / Math.max(1, pcm.length));
}

/** Micrófonos de celular graban bajo: se lleva el pico a 0,9 sin saturar. */
function normalizarVolumen(pcm: Float32Array) {
  let max = 0;
  for (let i = 0; i < pcm.length; i++) max = Math.max(max, Math.abs(pcm[i]));
  if (max <= 0 || max > 0.5) return pcm;
  const k = 0.9 / max;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * k;
  return out;
}

/** Whisper a veces devuelve muletillas de silencio («Gracias por ver el video»): se descartan. */
export function limpiarTranscripcion(t: string) {
  const s = t.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (/^(gracias por ver|suscr[ií]bete|subt[ií]tulos|amara\.org|¡?gracias\.?!?$)/i.test(s)) return '';
  return s;
}
