import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Db, Queryable, many, one } from '../../infra/db/db.js';
import type { Sesion } from '../../common/auth/tokens.js';
import { ahoraBolivia, codigoLegible, enRangoHorario } from '../../common/util.js';
import { AuditoriaService, TelemetriaService } from '../nucleo/nucleo.services.js';
import { EventBus } from '../nucleo/event-bus.js';

export interface DatosLocal {
  nombre: string;
  categoriaId: string;
  piso: 'N1' | 'N2' | 'T';
  sector: string;
  numeroLocal: string;
  coordX: number;
  coordY: number;
  horarioApertura?: string;
  horarioCierre?: string;
  descripcion?: string;
  palabrasClave?: string[];
  nit?: string | null;
  activo?: boolean;
  fotoUrl?: string | null;
  bannerUrl?: string | null;
}

/** Plano, locales, categorías y buscador del Paseo (módulo recinto). */
@Injectable()
export class RecintoService {
  constructor(
    private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly telemetria: TelemetriaService,
    private readonly bus: EventBus,
  ) {}

  // -------------------------------------------------------------- plano (HU-C10, HU-A01, HU-A08)
  async plano(recintoId: string) {
    const recinto = await one(this.db, 'select * from recinto where id = $1', [recintoId]);
    const zonas = await many(this.db, 'select * from zona where recinto_id = $1 order by piso, sector', [recintoId]);
    const { dia, hhmm } = ahoraBolivia();
    const locales = await many<any>(
      this.db,
      `select l.id, l.nombre, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y, l.zona_id, l.horario_apertura, l.horario_cierre,
              l.activo, l.descripcion, l.palabras_clave, l.nit, l.codigo_puerta, l.telefono, l.dias_atencion, c.id as categoria_id, c.nombre as categoria, c.ambito
       from local l join categoria c on c.id = l.categoria_id where l.recinto_id = $1 order by l.piso, l.numero_local`,
      [recintoId],
    );
    for (const l of locales) l.abierto_ahora = l.activo && l.dias_atencion.includes(dia) && enRangoHorario(hhmm, String(l.horario_apertura), String(l.horario_cierre));
    const servicios = await many(
      this.db,
      'select id, tipo, nombre, descripcion, piso, x, y, horario, palabras_clave from servicio_paseo where recinto_id = $1 and activo order by piso, tipo',
      [recintoId],
    );
    const entradas = [
      { id: 'N1:entrada:norte', nombre: 'Puerta Norte', piso: 'N1', x: 500, y: 0 },
      { id: 'N1:entrada:sur', nombre: 'Puerta Sur', piso: 'N1', x: 500, y: 600 },
      { id: 'N1:entrada:parqueo', nombre: 'Acceso del parqueo', piso: 'N1', x: 1000, y: 300 },
    ];
    const verticales = ['N1', 'N2', 'T'].flatMap((piso) => [
      { tipo: 'escalera', piso, x: 450, y: 280 },
      { tipo: 'ascensor', piso, x: 850, y: 280 },
    ]);
    return { recinto, pisos: [
      { id: 'N1', nombre: 'Nivel 1' },
      { id: 'N2', nombre: 'Nivel 2' },
      { id: 'T', nombre: 'Terrazas' },
    ], ancho: 1000, alto: 600, zonas, locales, servicios, entradas, verticales };
  }

  /**
   * Capas en vivo del mapa: promociones activas ahora por local, Drops abiertos, monedas del día,
   * eventos en curso o de hoy. Solo lectura sobre tablas de otros módulos.
   */
  async capas(recintoId: string, clienteId: string | null) {
    const { dia, hhmm, fecha } = ahoraBolivia();
    const promociones = await many(
      this.db,
      `select p.id, p.local_id, p.titulo, p.tipo, p.multiplicador, p.hora_inicio, p.hora_fin
       from promocion p left join segmento s on s.id = p.segmento_id
       where p.recinto_id = $1 and p.estado = 'aprobada' and p.local_id is not null and $2::date between p.inicio and p.fin and $3 = any(p.dias_semana)
         and $4::time between p.hora_inicio and p.hora_fin and (p.segmento_id is null or $5::uuid is null or $5::uuid = any(s.cliente_ids))`,
      [recintoId, fecha, dia, hhmm, clienteId],
    );
    const drops = await many(
      this.db,
      `select d.id, d.zona_id, z.piso, z.x + z.ancho / 2 as x, 330 as y, d.precio_especial, d.mensaje, d.fin, p.nombre as producto, l.nombre as local, h.codigo as cartel,
              d.max_reclamos - (select count(*)::int from reclamo_drop r where r.drop_id = d.id) as quedan
       from drop_espacial d join zona z on z.id = d.zona_id join producto p on p.id = d.producto_id join local l on l.id = p.local_id
       left join hito h on h.zona_id = d.zona_id and h.activo
       where d.recinto_id = $1 and now() between d.inicio and d.fin`,
      [recintoId],
    );
    const monedas = await many(
      this.db,
      `select h.id, h.codigo, h.puntos, z.piso, z.x + z.ancho / 2 as x, 330 as y, z.nombre as zona,
              ($2::uuid is not null and exists (select 1 from reclamo_hito r where r.hito_id = h.id and r.cliente_id = $2 and r.fecha = $3::date)) as reclamada
       from hito h join zona z on z.id = h.zona_id where h.recinto_id = $1 and h.activo`,
      [recintoId, clienteId, fecha],
    );
    const eventos = await many(
      this.db,
      `select a.id, a.titulo, a.tipo, a.inicio, a.fin, a.lugar, a.puntos, a.local_id, z.piso,
              coalesce(l.coord_x, z.x + z.ancho / 2) as x, coalesce(l.coord_y, z.y + z.alto / 2) as y, (now() between a.inicio and a.fin) as en_curso
       from actividad a left join zona z on z.id = a.zona_id left join local l on l.id = a.local_id
       where a.recinto_id = $1 and a.estado = 'aprobada' and a.fin > now() and bo(a.inicio)::date <= $2::date`,
      [recintoId, fecha],
    );
    return { promociones, drops, monedas, eventos };
  }

  async zonaPorPunto(q: Queryable, recintoId: string, piso: string, x: number, y: number) {
    const z = await one<{ id: string }>(
      q,
      `select id from zona where recinto_id = $1 and piso = $2 and $3 between x and x + ancho and $4 between y and y + alto limit 1`,
      [recintoId, piso, x, y],
    );
    return z?.id ?? null;
  }

  // -------------------------------------------------------------- buscador (HU-C10, HU-A13)
  async buscar(recintoId: string, termino: string, clienteId: string | null, origen: 'app' | 'jarvis' | 'paseoya' = 'app') {
    const t = termino.trim().toLowerCase();
    if (t.length < 2) return { locales: [], productos: [] };
    const like = `%${t}%`;
    const locales = await many(
      this.db,
      `select distinct l.id, l.nombre, l.piso, l.sector, l.numero_local, l.coord_x, l.coord_y, l.horario_apertura, l.horario_cierre,
              c.nombre as categoria
       from local l join categoria c on c.id = l.categoria_id
       left join producto p on p.local_id = l.id and p.activo
       where l.recinto_id = $1 and l.activo and (
         lower(l.nombre) like $2 or lower(c.nombre) like $2 or lower(l.descripcion) like $2
         or exists (select 1 from unnest(l.palabras_clave) k where lower(k) like $2)
         or lower(p.nombre) like $2)
       limit 30`,
      [recintoId, like],
    );
    const productos = await many(
      this.db,
      `select p.id, p.nombre, p.precio_bs, p.stock, l.id as local_id, l.nombre as local, l.piso, l.numero_local
       from producto p join local l on l.id = p.local_id
       where l.recinto_id = $1 and p.activo and l.activo and lower(p.nombre) like $2 order by p.precio_bs limit 20`,
      [recintoId, like],
    );
    await this.registrarBusqueda(recintoId, t, clienteId, origen, locales.length + productos.length);
    return { locales, productos };
  }

  async registrarBusqueda(recintoId: string, termino: string, clienteId: string | null, origen: 'app' | 'jarvis' | 'paseoya', resultados: number) {
    await this.db.query(
      `insert into busqueda (recinto_id, id_seudonimo, termino, origen, resultados)
       values ($1, (select id_seudonimo from cliente_perfil where usuario_id = $2), $3, $4, $5)`,
      [recintoId, clienteId, termino, origen, resultados],
    );
    await this.telemetria.registrarSuelto({ recintoId, clienteId, tipo: 'busqueda.realizada', payload: { termino, origen, resultados } });
  }

  // -------------------------------------------------------------- categorías (HU-Y17)
  categorias() {
    return many(
      this.db,
      `select c.*, (select count(*)::int from local l where l.categoria_id = c.id) as locales,
              (select count(*)::int from producto p where p.categoria_id = c.id and p.activo) as productos
       from categoria c order by c.orden, c.nombre`,
    );
  }

  async crearCategoria(s: Sesion, d: { nombre: string; ambito: 'comida' | 'tiendas'; orden?: number }) {
    return this.db.tx(async (q) => {
      const c = await one(q, 'insert into categoria (nombre, ambito, orden) values ($1,$2,$3) returning *', [d.nombre, d.ambito, d.orden ?? 99]);
      await this.auditoria.registrar(q, s.sub, 'crear_categoria', 'categoria', c.id, null, c);
      return c;
    });
  }

  async actualizarCategoria(s: Sesion, id: string, d: { nombre?: string; ambito?: 'comida' | 'tiendas'; orden?: number }) {
    return this.db.tx(async (q) => {
      const antes = await one(q, 'select * from categoria where id = $1', [id]);
      if (!antes) throw new NotFoundException('Categoría no encontrada');
      const c = await one(
        q,
        'update categoria set nombre = coalesce($2,nombre), ambito = coalesce($3,ambito), orden = coalesce($4,orden) where id = $1 returning *',
        [id, d.nombre ?? null, d.ambito ?? null, d.orden ?? null],
      );
      await this.auditoria.registrar(q, s.sub, 'actualizar_categoria', 'categoria', id, antes, c);
      return c;
    });
  }

  async eliminarCategoria(s: Sesion, id: string) {
    const uso = await one<{ n: number }>(
      this.db,
      'select ((select count(*) from local where categoria_id = $1) + (select count(*) from producto where categoria_id = $1))::int as n',
      [id],
    );
    if (uso && uso.n > 0) throw new BadRequestException('La categoría tiene locales o productos asignados; reasígnalos primero');
    await this.db.tx(async (q) => {
      await q.query('delete from categoria where id = $1', [id]);
      await this.auditoria.registrar(q, s.sub, 'eliminar_categoria', 'categoria', id, null, null);
    });
    return { eliminado: true };
  }

  // -------------------------------------------------------------- locales (HU-A01)
  async crearLocal(s: Sesion, d: DatosLocal) {
    return this.db.tx(async (q) => {
      const zona = await this.zonaPorPunto(q, s.recintoId, d.piso, d.coordX, d.coordY);
      const l = await one(
        q,
        `insert into local (recinto_id, nombre, categoria_id, piso, sector, numero_local, coord_x, coord_y, zona_id,
           horario_apertura, horario_cierre, descripcion, palabras_clave, nit, codigo_puerta, activo, foto_url, banner_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
        [
          s.recintoId, d.nombre, d.categoriaId, d.piso, d.sector, d.numeroLocal, d.coordX, d.coordY, zona,
          d.horarioApertura ?? '10:00', d.horarioCierre ?? '22:00', d.descripcion ?? '', d.palabrasClave ?? [],
          d.nit ?? null, `L-${codigoLegible(8)}`, d.activo ?? true, d.fotoUrl ?? null, d.bannerUrl ?? null,
        ],
      );
      await this.auditoria.registrar(q, s.sub, 'crear_local', 'local', l.id, null, l);
      return l;
    }).then((l) => {
      this.bus.publicar('recinto.cambiado', { recintoId: s.recintoId });
      return l;
    });
  }

  async actualizarLocal(s: Sesion, id: string, d: Partial<DatosLocal>) {
    return this.db.tx(async (q) => {
      const antes = await one<any>(q, 'select * from local where id = $1 and recinto_id = $2', [id, s.recintoId]);
      if (!antes) throw new NotFoundException('Local no encontrado');
      const piso = d.piso ?? antes.piso;
      const x = d.coordX ?? Number(antes.coord_x);
      const y = d.coordY ?? Number(antes.coord_y);
      const zona = await this.zonaPorPunto(q, s.recintoId, piso, x, y);
      const l = await one(
        q,
        `update local set nombre = coalesce($2,nombre), categoria_id = coalesce($3,categoria_id), piso = $4, sector = coalesce($5,sector),
           numero_local = coalesce($6,numero_local), coord_x = $7, coord_y = $8, zona_id = $9,
           horario_apertura = coalesce($10,horario_apertura), horario_cierre = coalesce($11,horario_cierre),
           descripcion = coalesce($12,descripcion), palabras_clave = coalesce($13,palabras_clave), nit = coalesce($14,nit),
           activo = coalesce($15,activo),
           foto_url = case when $16::boolean then $17 else foto_url end,
           banner_url = case when $18::boolean then $19 else banner_url end
         where id = $1 returning *`,
        [
          id, d.nombre ?? null, d.categoriaId ?? null, piso, d.sector ?? null, d.numeroLocal ?? null, x, y, zona,
          d.horarioApertura ?? null, d.horarioCierre ?? null, d.descripcion ?? null, d.palabrasClave ?? null, d.nit ?? null, d.activo ?? null,
          d.fotoUrl !== undefined, d.fotoUrl ?? null, d.bannerUrl !== undefined, d.bannerUrl ?? null,
        ],
      );
      await this.auditoria.registrar(q, s.sub, 'actualizar_local', 'local', id, antes, l);
      return l;
    }).then((l) => {
      this.bus.publicar('recinto.cambiado', { recintoId: s.recintoId });
      return l;
    });
  }

  local(id: string) {
    return one(
      this.db,
      `select l.*, c.nombre as categoria, z.nombre as zona from local l join categoria c on c.id = l.categoria_id
       left join zona z on z.id = l.zona_id where l.id = $1`,
      [id],
    );
  }

  async actualizarMiLocal(localId: string, d: { descripcion?: string; fotoUrl?: string | null; bannerUrl?: string | null }) {
    const l = await one<any>(
      this.db,
      `update local set
         descripcion = coalesce($2, descripcion),
         foto_url = case when $3::boolean then $4 else foto_url end,
         banner_url = case when $5::boolean then $6 else banner_url end
       where id = $1 returning *`,
      [localId, d.descripcion ?? null, d.fotoUrl !== undefined, d.fotoUrl ?? null, d.bannerUrl !== undefined, d.bannerUrl ?? null],
    );
    if (!l) throw new NotFoundException('Local no encontrado');
    return l;
  }

  // -------------------------------------------------------------- HU-L07 QR de puerta en PDF
  async qrPuertaPdf(localId: string): Promise<Buffer> {
    const l = await one<any>(this.db, 'select * from local where id = $1', [localId]);
    if (!l) throw new NotFoundException('Local no encontrado');
    const contenido = `PPL:${l.codigo_puerta}`;
    const png = await QRCode.toBuffer(contenido, { errorCorrectionLevel: 'M', width: 900, margin: 1, color: { dark: '#16140F', light: '#FFFFFF' } });
    return new Promise((resolve) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const partes: Buffer[] = [];
      doc.on('data', (b: Buffer) => partes.push(b));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      const ancho = doc.page.width;
      doc.rect(0, 0, ancho, 8).fill('#C99A3A');
      doc.fillColor('#8E6A1E').font('Helvetica-Bold').fontSize(9).text('PASEO POINTS', 40, 36, { characterSpacing: 2 });
      doc.fillColor('#16140F').font('Times-Roman').fontSize(26).text(l.nombre, 40, 56);
      doc.fillColor('#5F594F').font('Helvetica').fontSize(10)
        .text(`${l.piso} · Sector ${l.sector} · Local ${l.numero_local}`, 40, 92, { characterSpacing: 1 });
      const lado = ancho - 120;
      doc.image(png, 60, 130, { width: lado, height: lado });
      doc.fillColor('#16140F').font('Helvetica-Bold').fontSize(13).text('Escanea al entrar y suma puntos', 40, 150 + lado, { align: 'center', width: ancho - 80 });
      doc.fillColor('#5F594F').font('Helvetica').fontSize(9)
        .text('Primera visita: puntos de descubrimiento. Abre la app Paseo Points y toca «Escanear».', 40, 172 + lado, { align: 'center', width: ancho - 80 });
      doc.fillColor('#9A9182').fontSize(7).text(contenido, 40, doc.page.height - 50, { align: 'center', width: ancho - 80 });
      doc.end();
    });
  }
}
