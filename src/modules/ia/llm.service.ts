import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Adaptador del modelo de lenguaje (Claude vía API de Anthropic).
 * Sin ANTHROPIC_API_KEY el sistema funciona igual con plantillas deterministas.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger('LLM');
  private readonly clave = process.env.ANTHROPIC_API_KEY;
  readonly modeloSql = process.env.LLM_MODELO_SQL ?? 'claude-sonnet-5-5';
  readonly modeloTextos = process.env.LLM_MODELO_TEXTOS ?? 'claude-haiku-4-5-20251001';

  get disponible() {
    return !!this.clave;
  }

  async completar(sistema: string, usuario: string, opciones: { modelo?: string; maxTokens?: number } = {}): Promise<string | null> {
    if (!this.clave) return null;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.clave,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opciones.modelo ?? this.modeloTextos,
          max_tokens: opciones.maxTokens ?? 800,
          system: sistema,
          messages: [{ role: 'user', content: usuario }],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) {
        this.log.warn(`LLM respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return null;
      }
      const j = (await r.json()) as { content: { type: string; text?: string }[] };
      return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    } catch (e: any) {
      this.log.warn(`LLM no disponible: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Extrae el primer objeto JSON de una respuesta del modelo. */
  static json<T>(texto: string | null): T | null {
    if (!texto) return null;
    const ini = texto.indexOf('{');
    const fin = texto.lastIndexOf('}');
    if (ini < 0 || fin <= ini) return null;
    try {
      return JSON.parse(texto.slice(ini, fin + 1)) as T;
    } catch {
      return null;
    }
  }
}

@Global()
@Module({ providers: [LlmService], exports: [LlmService] })
export class IaModule {}
