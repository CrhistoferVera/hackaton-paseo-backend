import { Injectable } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';

export interface PerfilCliente {
  clienteId: string;
  nombre: string;
  /** 0 a 1 por categoría: compras recientes + intereses declarados */
  afinidad: Record<string, number>;
  /** compras por local en 120 días */
  compras: Map<string, number>;
  /** locales donde compró o hizo check-in alguna vez */
  conocidos: Set<string>;
  favoritos: Set<string>;
  /** hora y días en que suele venir (hora boliviana) */
  horaHabitual: number | null;
  diasHabituales: number[];
  ticketPromedio: number;
  visitas90: number;
}

/**
 * Perfil del cliente para personalizar: qué categorías compra, a qué hora viene, qué locales ya
 * conoce y cuáles son sus favoritos. Solo usa datos propios del programa y respeta el consentimiento
 * de personalización (sin consentimiento, el perfil queda neutro).
 */
@Injectable()
export class PerfilService {
  private cache = new Map<string, { en: number; p: PerfilCliente }>();

  constructor(private readonly db: Db) {}

  async perfil(clienteId: string): Promise<PerfilCliente> {
    const c = this.cache.get(clienteId);
    if (c && Date.now() - c.en < 300_000) return c.p;
    const base = await one<any>(
      this.db,
      `select u.nombre, p.intereses, p.consent_personalizacion from usuario u join cliente_perfil p on p.usuario_id = u.id where u.id = $1`,
      [clienteId],
    );
    const personaliza = base?.consent_personalizacion !== false;
    const tx = personaliza
      ? await many<any>(
          this.db,
          `select t.local_id, coalesce(t.categoria, c.nombre) as categoria, count(*)::int as n, avg(t.monto_bs)::float8 as ticket,
                  mode() within group (order by extract(hour from bo(t.creado_en))::int) as hora
           from transaccion t join local l on l.id = t.local_id join categoria c on c.id = l.categoria_id
           where t.cliente_id = $1 and t.estado = 'valida' and t.creado_en > now() - interval '120 days'
           group by t.local_id, 2`,
          [clienteId],
        )
      : [];
    const visitas = personaliza
      ? await one<any>(
          this.db,
          `select count(*)::int as n, mode() within group (order by extract(hour from bo(entrada_en))::int) as hora,
                  array(select d from (select extract(dow from bo(entrada_en))::int as d, count(*) as k from visita where cliente_id = $1 and entrada_en > now() - interval '90 days' group by 1 order by k desc limit 2) x) as dias
           from visita where cliente_id = $1 and entrada_en > now() - interval '90 days'`,
          [clienteId],
        )
      : null;
    const conocidos = personaliza
      ? await many<{ local_id: string }>(this.db, `select distinct local_id from checkin_local where cliente_id = $1 union select distinct local_id from transaccion where cliente_id = $1`, [clienteId])
      : [];
    const favoritos = await many<{ local_id: string }>(this.db, 'select local_id from favorito where cliente_id = $1 and local_id is not null', [clienteId]);

    const porCategoria = new Map<string, number>();
    for (const f of tx) porCategoria.set(f.categoria, (porCategoria.get(f.categoria) ?? 0) + f.n);
    const max = Math.max(1, ...porCategoria.values());
    const afinidad: Record<string, number> = {};
    for (const [cat, n] of porCategoria) afinidad[cat] = Math.round((0.7 * n) / max * 100) / 100;
    for (const i of (personaliza ? base?.intereses : null) ?? []) afinidad[i] = Math.min(1, (afinidad[i] ?? 0) + 0.3);
    const totalTx = tx.reduce((a, f) => a + f.n, 0);
    const p: PerfilCliente = {
      clienteId,
      nombre: (base?.nombre ?? '').split(' ')[0],
      afinidad,
      compras: new Map(tx.map((f) => [f.local_id, f.n])),
      conocidos: new Set(conocidos.map((x) => x.local_id)),
      favoritos: new Set(favoritos.map((x) => x.local_id)),
      horaHabitual: visitas?.hora ?? (tx[0]?.hora ?? null),
      diasHabituales: visitas?.dias ?? [],
      ticketPromedio: totalTx ? Math.round(tx.reduce((a, f) => a + f.ticket * f.n, 0) / totalTx) : 0,
      visitas90: visitas?.n ?? 0,
    };
    this.cache.set(clienteId, { en: Date.now(), p });
    return p;
  }

  /** Categoría que más le gusta (para frases como «como te gusta la comida…»). */
  static favorita(p: PerfilCliente) {
    return Object.entries(p.afinidad).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
}
