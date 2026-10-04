/**
 * Proceso aparte para Whisper. Whisper (onnxruntime-node) y la voz de Jarvis (sherpa-onnx) traen cada
 * uno su propia librería ONNX; en el mismo proceso de Windows la que carga primero gana y la otra falla
 * o se vuelve lenta. Aquí Whisper tiene su propio proceso: el de la API le manda el audio ya decodificado
 * (PCM mono de 16 kHz) y recibe el texto.
 */
import { resolve } from 'node:path';

type Transcriptor = (audio: Float32Array, opciones: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const MODELO = process.env.WHISPER_MODELO ?? 'onnx-community/whisper-small';

async function cargar(): Promise<Transcriptor> {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = resolve(process.env.MODELOS_DIR ?? '.data/modelos');
  // Pocos hilos rinden más: con los que ONNX elige por defecto (todos los núcleos) tarda el triple
  const hilos = Number(process.env.WHISPER_HILOS ?? 4);
  const asr = (await tf.pipeline('automatic-speech-recognition', MODELO, {
    dtype: (process.env.WHISPER_DTYPE ?? 'q8') as any,
    session_options: hilos > 0 ? { intraOpNumThreads: hilos } : undefined,
  } as any)) as unknown as Transcriptor;
  // Una pasada en silencio deja el modelo listo para la primera pregunta real
  await asr(new Float32Array(16000), { language: 'spanish', task: 'transcribe' });
  return asr;
}

const enviar = (m: unknown) => process.send?.(m);

const t0 = Date.now();
const listo = cargar();
listo.then(
  () => enviar({ tipo: 'listo', ms: Date.now() - t0 }),
  (e) => {
    enviar({ tipo: 'fallo', error: String(e?.message ?? e) });
    process.exit(1);
  },
);

process.on('message', async (m: { id: number; pcm: Float32Array }) => {
  try {
    const asr = await listo;
    const r = await asr(m.pcm, { language: 'spanish', task: 'transcribe', chunk_length_s: 30 });
    enviar({ tipo: 'texto', id: m.id, texto: (Array.isArray(r) ? r[0] : r).text });
  } catch (e: any) {
    enviar({ tipo: 'texto', id: m.id, error: String(e?.message ?? e) });
  }
});

// Si la API se cierra, este proceso también
process.on('disconnect', () => process.exit(0));
