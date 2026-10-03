import { BadRequestException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

type Transcriptor = (audio: Float32Array, opciones: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const MODELO = process.env.WHISPER_MODELO ?? 'onnx-community/whisper-small';
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_SEGUNDOS = 30;

/**
 * Oído de Jarvis: convierte la voz del cliente en texto en el propio servidor, con Whisper
 * (transformers.js sobre ONNX) y ffmpeg para decodificar lo que mande el celular o el navegador
 * (webm, m4a, wav, ogg). Gratis y sin nube: el audio no sale de la máquina y no se guarda.
 * La primera vez descarga el modelo a .data/modelos; después funciona sin internet.
 */
@Injectable()
export class OidoJarvis implements OnModuleInit {
  private readonly log = new Logger('OidoJarvis');
  private cargando: Promise<Transcriptor> | null = null;
  private listo = false;

  onModuleInit() {
    if (process.env.JARVIS_OIDO === 'false') return;
    // Carga en segundo plano: la API arranca de inmediato
    setTimeout(() => void this.transcriptor().catch((e) => this.log.warn(`Whisper no disponible: ${e.message}`)), 3000);
  }

  get estado() {
    return { modelo: MODELO, listo: this.listo, activo: process.env.JARVIS_OIDO !== 'false' };
  }

  private transcriptor(): Promise<Transcriptor> {
    this.cargando ??= (async () => {
      const t0 = Date.now();
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = resolve(process.env.MODELOS_DIR ?? '.data/modelos');
      const asr = (await tf.pipeline('automatic-speech-recognition', MODELO, { dtype: (process.env.WHISPER_DTYPE ?? 'q8') as any })) as unknown as Transcriptor;
      // Una pasada en silencio deja el modelo listo para la primera pregunta real
      await asr(new Float32Array(16000), { language: 'spanish', task: 'transcribe' });
      this.listo = true;
      this.log.log(`${MODELO} listo en ${Math.round((Date.now() - t0) / 1000)} s`);
      return asr;
    })();
    this.cargando.catch(() => (this.cargando = null));
    return this.cargando;
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
      throw new BadRequestException(`No pude leer el audio: ${e.message}`);
    }
    const segundos = pcm.length / 16000;
    if (segundos < 0.3 || energia(pcm) < 0.003) return { texto: '', segundos, latenciaMs: Date.now() - t0 };
    const asr = await this.transcriptor().catch(() => {
      throw new ServiceUnavailableException('El reconocimiento de voz se está preparando; intenta en un momento o escribe tu pregunta');
    });
    const r = await asr(normalizarVolumen(pcm), { language: 'spanish', task: 'transcribe', chunk_length_s: 30 });
    const texto = limpiarTranscripcion((Array.isArray(r) ? r[0] : r).text);
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
