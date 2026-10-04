import { Injectable } from '@nestjs/common';
import { Db, many } from '../../infra/db/db.js';
import { ahoraBolivia } from '../../common/util.js';
import { OrientacionService } from '../orientacion/orientacion.service.js';
import { NOMBRE_PISO } from '../orientacion/domain/grafo.js';
import { dinero } from './voz.js';

export type TipoOferta = 'promocion' | 'drop' | 'pedido_listo' | 'mision';

export interface Oferta {
  tipo: TipoOferta;
  texto: string;
  metros: number;
  nodoId: string;
  lugar: string;
  localId?: string;
  dropId?: string;
  puntos?: number;
  /** Tráfico de la zona en la última hora: sirve para preferir pasillos poco concurridos. */
  trafico?: number;
}

/**
 * Inyección dinámica de contexto: a partir del nodo donde está el cliente, junta solo lo que está
 * a pocos metros caminando (por el grafo, no en línea recta). Ese fragmento es todo lo que ve el modelo.
 */
@Injectable()
export class ContextoService {
  constructor(
    private readonly db: Db,
    private readonly orientacion: OrientacionService,
  ) {}

  async cercanos(recintoId: string, clienteId: string, nodoId: string, radioM: number): Promise<Oferta[]> {
    const { g, dist } = await this.orientacion.distancias(recintoId, nodoId, radioM);
    const locales = new Map<string, { nodo: string; metros: number }>();
    for (const [id, m] of dist) {
      const n = g.nodos.get(id)!;
      if (n.localId) locales.set(n.localId, { nodo: id, metros: m });
    }
    const ofertas: Oferta[] = [];
    const { fecha, dia, hhmm } = ahoraBolivia();
    const idsLocales = [...locales.keys()];

    if (idsLocales.length) {
      const promos = await many<any>(
        this.db,
        `select p.titulo, p.tipo, p.multiplicador, p.hora_fin, l.id as local_id, l.nombre, l.piso, l.numero_local
         from promocion p join local l on l.id = p.local_id left join segmento s on s.id = p.segmento_id
         where p.local_id = any($1::uuid[]) and p.estado = 'aprobada' and $2::date between p.inicio and p.fin
           and $3 = any(p.dias_semana) and $4::time between p.hora_inicio and p.hora_fin
           and (p.segmento_id is null or $5 = any(s.cliente_ids))`,
        [idsLocales, fecha, dia, hhmm, clienteId],
      );
      for (const p of promos) {
        const d = locales.get(p.local_id)!;
        const que = p.tipo === 'puntos_dobles' ? `puntos ×${Number(p.multiplicador)}` : p.titulo;
        ofertas.push({ tipo: 'promocion', texto: `${p.nombre} (${NOMBRE_PISO[p.piso]}, local ${p.numero_local}) tiene ${que} hasta las ${String(p.hora_fin).slice(0, 5)}`, metros: d.metros, nodoId: d.nodo, lugar: p.nombre, localId: p.local_id });
      }
      const listos = await many<any>(
        this.db,
        `select s.local_id, l.nombre, l.numero_local, l.piso from subpedido s join pedido p on p.id = s.pedido_id join local l on l.id = s.local_id
         where p.cliente_id = $1 and s.local_id = any($2::uuid[]) and s.estado in ('listo','cliente_llego')`,
        [clienteId, idsLocales],
      );
      for (const s of listos) {
        const d = locales.get(s.local_id)!;
        ofertas.push({ tipo: 'pedido_listo', texto: `tu pedido de ${s.nombre} (local ${s.numero_local}) ya está listo para retirar`, metros: d.metros, nodoId: d.nodo, lugar: s.nombre, localId: s.local_id });
      }
      const misiones = await many<any>(
        this.db,
        `select m.recompensa_puntos, m.regla->>'localId' as local_id, l.nombre from mision m join local l on l.id = (m.regla->>'localId')::uuid
         left join progreso_mision pm on pm.mision_id = m.id and pm.cliente_id = $1
         where m.cliente_id = $1 and m.activa and pm.completada_en is null and (m.regla->>'localId')::uuid = any($2::uuid[])`,
        [clienteId, idsLocales],
      );
      for (const m of misiones) {
        const d = locales.get(m.local_id)!;
        ofertas.push({ tipo: 'mision', texto: `tu misión en ${m.nombre} da ${m.recompensa_puntos} puntos con la primera compra`, metros: d.metros, nodoId: d.nodo, lugar: m.nombre, localId: m.local_id, puntos: m.recompensa_puntos });
      }
      // Drops abiertos en locales cercanos que el cliente aún no reclamó
      const drops = await many<any>(
        this.db,
        `select d.id, p.nombre as producto, d.precio_especial, l.id as local_id, l.nombre, l.piso, l.numero_local,
                (select count(*)::int from evento e where e.zona_id = l.zona_id and e.creado_en > now() - interval '60 minutes') as trafico
         from drop_espacial d join producto p on p.id = d.producto_id join local l on l.id = coalesce(d.local_id, p.local_id)
         where l.id = any($1::uuid[]) and now() between d.inicio and d.fin
           and d.max_reclamos > (select count(*) from reclamo_drop r where r.drop_id = d.id)
           and not exists (select 1 from reclamo_drop r where r.drop_id = d.id and r.cliente_id = $2)`,
        [idsLocales, clienteId],
      );
      for (const x of drops) {
        const d = locales.get(x.local_id)!;
        ofertas.push({ tipo: 'drop', texto: `${x.nombre} (${NOMBRE_PISO[x.piso]}, local ${x.numero_local}) tiene un Drop: ${x.producto} a ${dinero(x.precio_especial)}`, metros: d.metros, nodoId: d.nodo, lugar: x.nombre, localId: x.local_id, dropId: x.id, trafico: x.trafico });
      }
    }
    return ofertas.sort((a, b) => a.metros - b.metros);
  }
}
