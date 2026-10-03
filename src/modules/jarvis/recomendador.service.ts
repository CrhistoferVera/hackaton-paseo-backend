import { Injectable } from '@nestjs/common';
import { Db, many, one } from '../../infra/db/db.js';
import { ahoraBolivia, enRangoHorario } from '../../common/util.js';
import { EquidadService, type EstadoLocal } from './equidad.service.js';
import { type PerfilCliente, PerfilService } from './perfil.service.js';

export interface Recomendacion {
  local: EstadoLocal;
  puntaje: number;
  motivos: string[];
  producto?: { id: string; nombre: string; precio_bs: number } | null;
  oferta?: { titulo: string; multiplicador: number; hora_fin: string } | null;
  promo?: { titulo: string } | null;
}

const NOMBRE_CATEGORIA: Record<string, string> = {
  Comida: 'la comida', Tecnología: 'la tecnología', Moda: 'la moda', Accesorios: 'los accesorios', Servicios: 'los servicios',
  Regalos: 'los regalos', Hogar: 'las cosas para el hogar', Entretenimiento: 'el entretenimiento',
};

/**
 * Recomendador equitativo. Para cada local candidato combina:
 *  - lo que le gusta al cliente (afinidad por categoría, favoritos, compras previas),
 *  - la equidad del flujo (locales que hoy reciben menos gente que sus competidores),
 *  - novedad (locales que el cliente aún no conoce),
 *  - y resta exposición (no recomendar siempre a los mismos ni repetirle al mismo cliente).
 * El peso de la equidad lo configura administración (ajuste_ia.peso_equidad).
 * Cada recomendación trae sus motivos en lenguaje natural para que Jarvis los diga.
 */
@Injectable()
export class RecomendadorService {
  constructor(
    private readonly db: Db,
    private readonly equidad: EquidadService,
    private readonly perfiles: PerfilService,
  ) {}

  async pesoEquidad(recintoId: string) {
    const a = await one<{ peso_equidad: number }>(this.db, 'select peso_equidad from ajuste_ia where recinto_id = $1', [recintoId]);
    return a ? Number(a.peso_equidad) : 0.4;
  }

  /**
   * Ordena una lista de cosas con local (promociones, productos) por interés del cliente y equidad:
   * así las primeras que escucha no son siempre las de los locales más concurridos.
   */
  async ordenar<T extends { local_id?: string | null; categoria?: string | null }>(recintoId: string, clienteId: string | null, items: T[]): Promise<T[]> {
    if (items.length < 2) return items;
    const estado = new Map((await this.equidad.estado(recintoId)).map((l) => [l.id, l]));
    const perfil = clienteId ? await this.perfiles.perfil(clienteId) : null;
    const w = await this.pesoEquidad(recintoId);
    const puntaje = (x: T) => {
      const l = x.local_id ? estado.get(x.local_id) : undefined;
      const cat = x.categoria ?? l?.categoria ?? '';
      return (1 - w) * (perfil ? perfil.afinidad[cat] ?? 0 : 0.5) + w * (l?.equidad ?? 0.5);
    };
    return [...items].sort((a, b) => puntaje(b) - puntaje(a));
  }

  async recomendar(
    recintoId: string,
    clienteId: string | null,
    op: { categoria?: string | null; productoRegex?: string | null; abiertos?: boolean; limite?: number; excluir?: string[]; registrar?: boolean } = {},
  ): Promise<Recomendacion[]> {
    const { dia, hhmm, fecha } = ahoraBolivia();
    const perfil: PerfilCliente | null = clienteId ? await this.perfiles.perfil(clienteId) : null;
    const w = await this.pesoEquidad(recintoId);
    let locales = (await this.equidad.estado(recintoId)).filter((l) => !op.excluir?.includes(l.id));
    if (op.categoria) locales = locales.filter((l) => l.categoria === op.categoria);
    if (op.abiertos !== false) locales = locales.filter((l) => l.dias_atencion.includes(dia) && enRangoHorario(hhmm, l.horario_apertura, l.horario_cierre));
    if (!locales.length) return [];

    const ids = locales.map((l) => l.id);
    const productos = await many<any>(
      this.db,
      `select distinct on (local_id) local_id, id, nombre, precio_bs from producto
       where local_id = any($1::uuid[]) and activo and stock > 0 and ($2::text is null or lower(nombre) ~ $2)
       order by local_id, (destacado_hasta >= current_date) desc nulls last, precio_bs`,
      [ids, op.productoRegex ?? null],
    );
    const prod = new Map(productos.map((p) => [p.local_id, p]));
    if (op.productoRegex) locales = locales.filter((l) => prod.has(l.id));
    const ofertas = clienteId
      ? await many<any>(
          this.db,
          `select local_id, titulo, multiplicador, hora_fin::text from oferta_personal
           where cliente_id = $1 and fecha = $2::date and estado = 'activa' and $3::time <= hora_fin`,
          [clienteId, fecha, hhmm],
        )
      : [];
    const oferta = new Map(ofertas.map((o) => [o.local_id, o]));
    const promos = await many<any>(
      this.db,
      `select distinct on (local_id) local_id, titulo from promocion
       where recinto_id = $1 and estado = 'aprobada' and local_id is not null and segmento_id is null and $2::date between inicio and fin
         and $3 = any(dias_semana) and $4::time between hora_inicio and hora_fin order by local_id, multiplicador desc`,
      [recintoId, fecha, dia, hhmm],
    );
    const promo = new Map(promos.map((p) => [p.local_id, p]));
    const recientes = clienteId
      ? new Set((await many<{ local_id: string }>(this.db, `select distinct local_id from exposicion_local where cliente_id = $1 and creado_en > now() - interval '24 hours'`, [clienteId])).map((x) => x.local_id))
      : new Set<string>();
    const expoMedia = Math.max(1, locales.reduce((a, l) => a + l.exposicion7, 0) / locales.length);

    const resultado = locales.map((l): Recomendacion => {
      const afin = perfil ? perfil.afinidad[l.categoria] ?? 0 : 0.5;
      const conocido = perfil?.conocidos.has(l.id) ?? false;
      const favorito = perfil?.favoritos.has(l.id) ?? false;
      const frecuente = Math.min(1, (perfil?.compras.get(l.id) ?? 0) / 5);
      const novedad = perfil ? (conocido ? 0.2 : 1) : 0.5;
      const exposicion = Math.min(1, l.exposicion7 / (2 * expoMedia));
      const gusto = 0.55 * afin + 0.25 * Math.max(favorito ? 1 : 0, frecuente) + 0.2 * novedad;
      let puntaje = (1 - w) * gusto + w * l.equidad - 0.15 * exposicion - (recientes.has(l.id) ? 0.2 : 0);
      if (oferta.has(l.id)) puntaje += 0.2;
      if (promo.has(l.id)) puntaje += 0.08;

      const motivos: string[] = [];
      const o = oferta.get(l.id);
      if (o) motivos.push(`tienes una oferta personal de puntos por ${Number(o.multiplicador)} ahí hasta las ${o.hora_fin.slice(0, 5)}`);
      if (promo.has(l.id)) motivos.push(`tiene la promoción ${promo.get(l.id).titulo}`);
      if (favorito) motivos.push('es uno de tus favoritos');
      else if (frecuente >= 0.4) motivos.push('es de los que más visitas');
      else if (perfil && !conocido && afin >= 0.4) motivos.push(`es nuevo para ti, perfecto para tu gusto por ${NOMBRE_CATEGORIA[l.categoria] ?? l.categoria.toLowerCase()}`);
      else if (perfil && !conocido) motivos.push('todavía no lo conoces');
      if (l.saturacion < 0.8 && l.equidad >= 0.55) motivos.push('ahora tiene poca gente, así que te atienden rápido');
      return { local: l, puntaje: Math.round(puntaje * 1000) / 1000, motivos, producto: prod.get(l.id) ?? null, oferta: o ?? null, promo: promo.get(l.id) ?? null };
    });

    resultado.sort((a, b) => b.puntaje - a.puntaje);
    // Competencia sana: entre los mejores, no más de dos de la misma categoría seguidos
    const elegidos: Recomendacion[] = [];
    for (const r of resultado) {
      if (elegidos.filter((e) => e.local.categoria === r.local.categoria).length >= 2 && !op.categoria) continue;
      elegidos.push(r);
      if (elegidos.length >= (op.limite ?? 3)) break;
    }
    if (op.registrar !== false && elegidos.length) await this.equidad.registrarExposicion(recintoId, [elegidos[0].local.id], clienteId, 'jarvis');
    return elegidos;
  }
}
