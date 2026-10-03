import { BadRequestException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const requerir = createRequire(import.meta.url);

const VOZ = process.env.JARVIS_VOZ ?? 'vits-piper-es_MX-claude-high';
const URL_VOCES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';
const MAX_CACHE = 300;
const VIDA_MS = 30 * 60_000;

interface Motor {
  generate(o: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number };
}

/** Lo que se escribe para leer no siempre se dice igual: «×2», «Bs», «%», siglas. */
export function textoParaVoz(t: string) {
  return t
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/×\s?(\d+(?:[.,]\d+)?)/g, ' por $1')
    .replace(/\bBs\.?\s?(\d)/g, '$1')
    .replace(/(\d)\s?%/g, '$1 por ciento')
    .replace(/PaseoYa/g, 'Paseo Ya')
    .replace(/\bQR\b/g, 'cu erre')
    .replace(/\bAR\b/g, 'a erre')
    .replace(/\bATM\b/g, 'cajero')
    .replace(/[«»"“”*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Voz de Jarvis: síntesis neuronal en español nativo (Piper es_MX, vía sherpa-onnx) en el servidor del
 * Paseo. Gratis, sin nube y rápida (≈0,7 s para 10 s de audio en CPU). Devuelve MP3 para que suene igual
 * en Android, iPhone y el navegador, sin depender de las voces instaladas en cada equipo (en muchas
 * computadoras con Windows solo hay voces en inglés). El audio vive 30 minutos en memoria y no se guarda.
 */
@Injectable()
export class VozNeuralService implements OnModuleInit {
  private readonly log = new Logger('VozJarvis');
  private readonly dir = resolve(process.env.MODELOS_DIR ? join(process.env.MODELOS_DIR, '..', 'voces') : '.data/voces');
  private motor: Promise<Motor> | null = null;
  private listo = false;
  private readonly audios = new Map<string, { mp3: Buffer; en: number }>();

  onModuleInit() {
    if (process.env.JARVIS_VOZ_NEURAL === 'false') return;
    setTimeout(() => void this.cargar().catch((e) => this.log.warn(`voz neural no disponible: ${e.message}`)), 4000);
  }

  get estado() {
    return { voz: VOZ, listo: this.listo, activa: process.env.JARVIS_VOZ_NEURAL !== 'false' };
  }

  private async descargar(destino: string) {
    mkdirSync(this.dir, { recursive: true });
    const archivo = join(this.dir, `${VOZ}.tar.bz2`);
    this.log.log(`descargando la voz ${VOZ}…`);
    const r = await fetch(`${URL_VOCES}/${VOZ}.tar.bz2`);
    if (!r.ok) throw new Error(`no se pudo descargar la voz (${r.status})`);
    writeFileSync(archivo, Buffer.from(await r.arrayBuffer()));
    await new Promise<void>((ok, falla) => {
      const p = spawn('tar', ['-xjf', archivo, '-C', this.dir]);
      p.on('error', falla);
      p.on('close', (c) => (c === 0 ? ok() : falla(new Error(`tar terminó con código ${c}`))));
    });
    unlinkSync(archivo);
    if (!existsSync(destino)) throw new Error('el paquete de voz no tiene el modelo esperado');
  }

  private cargar(): Promise<Motor> {
    this.motor ??= (async () => {
      const t0 = Date.now();
      const d = join(this.dir, VOZ);
      const onnx = join(d, `${VOZ.replace('vits-piper-', '')}.onnx`);
      if (!existsSync(onnx)) await this.descargar(onnx);
      const sherpa = requerir('sherpa-onnx-node');
      const tts = new sherpa.OfflineTts({
        model: { vits: { model: onnx, tokens: join(d, 'tokens.txt'), dataDir: join(d, 'espeak-ng-data') }, numThreads: Number(process.env.JARVIS_VOZ_HILOS ?? 4), provider: 'cpu' },
        maxNumSentences: 2,
      }) as Motor;
      tts.generate({ text: 'Hola.', sid: 0, speed: 1 });
      this.listo = true;
      this.log.log(`voz ${VOZ} lista en ${Math.round((Date.now() - t0) / 1000)} s`);
      return tts;
    })();
    this.motor.catch(() => (this.motor = null));
    return this.motor;
  }

  /** PCM float → MP3 (64 kbps mono) con ffmpeg. */
  private aMp3(samples: Float32Array, sampleRate: number): Promise<Buffer> {
    return new Promise((ok, falla) => {
      if (!ffmpegPath) return falla(new Error('ffmpeg no está disponible'));
      const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
      const partes: Buffer[] = [];
      p.stdout.on('data', (d: Buffer) => partes.push(d));
      p.on('error', falla);
      p.on('close', (c) => (c === 0 ? ok(Buffer.concat(partes)) : falla(new Error(`ffmpeg terminó con código ${c}`))));
      p.stdin.on('error', () => undefined);
      p.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    });
  }

  /** Sintetiza y devuelve el id con el que se descarga el MP3 (GET /voz/:id.mp3). */
  async sintetizar(texto: string, velocidad = 1.0): Promise<{ id: string; segundos: number; latenciaMs: number; sintesisMs: number }> {
    const limpio = textoParaVoz(texto).slice(0, 900);
    if (!limpio) throw new BadRequestException('No hay texto para leer');
    if (process.env.JARVIS_VOZ_NEURAL === 'false') throw new ServiceUnavailableException('La voz neural está desactivada');
    const t0 = Date.now();
    const motor = await this.cargar().catch(() => {
      throw new ServiceUnavailableException('La voz de Jarvis se está preparando');
    });
    const a = motor.generate({ text: limpio, sid: 0, speed: velocidad });
    const t1 = Date.now();
    const mp3 = await this.aMp3(a.samples, a.sampleRate);
    this.log.debug(`síntesis ${t1 - t0} ms, mp3 ${Date.now() - t1} ms`);
    const id = randomBytes(16).toString('hex');
    this.audios.set(id, { mp3, en: Date.now() });
    this.limpiar();
    return { id, segundos: Math.round((a.samples.length / a.sampleRate) * 10) / 10, latenciaMs: Date.now() - t0, sintesisMs: t1 - t0 };
  }

  audio(id: string) {
    const a = this.audios.get(id);
    return a && Date.now() - a.en < VIDA_MS ? a.mp3 : null;
  }

  private limpiar() {
    const ahora = Date.now();
    for (const [k, v] of this.audios) if (ahora - v.en > VIDA_MS) this.audios.delete(k);
    while (this.audios.size > MAX_CACHE) this.audios.delete(this.audios.keys().next().value!);
  }
}
