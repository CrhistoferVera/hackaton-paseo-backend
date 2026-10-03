/**
 * Migraciones en orden. Cada una se aplica una sola vez y queda registrada en _migracion.
 * Dueño de cada tabla (módulo) indicado en el comentario; ningún módulo escribe tablas ajenas
 * salvo a través del servicio público del módulo dueño.
 */
export const MIGRACIONES: { id: string; sql: string }[] = [
  {
    id: '001_esquema_base',
    sql: /* sql */ `
-- Hora boliviana (UTC-4, sin horario de verano) para analítica por hora y día
create or replace function bo(ts timestamptz) returns timestamp language sql immutable as
$$ select (ts at time zone 'UTC') - interval '4 hours' $$;

-- recinto ------------------------------------------------------------------
create table recinto (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  lat double precision not null,
  lng double precision not null,
  radio_m int not null default 250
);

-- identidad ----------------------------------------------------------------
create table usuario (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  rol text not null check (rol in ('cliente','cajero','gerente','admin','marketing','analista')),
  nombre text not null,
  correo text unique,
  celular text unique,
  hash text,
  estado text not null default 'activo' check (estado in ('activo','bloqueado','eliminado')),
  intentos_fallidos int not null default 0,
  bloqueado_hasta timestamptz,
  creado_en timestamptz not null default now()
);
create index usuario_rol_idx on usuario (rol);

create table otp (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuario(id) on delete cascade,
  codigo text not null,
  proposito text not null check (proposito in ('login','2fa')),
  expira_en timestamptz not null,
  usado boolean not null default false,
  creado_en timestamptz not null default now()
);

create table cliente_perfil (
  usuario_id uuid primary key references usuario(id) on delete cascade,
  id_seudonimo uuid not null unique default gen_random_uuid(),
  codigo_cliente text not null unique,
  secreto_pase text not null,
  fecha_nacimiento date,
  genero text,
  zona_residencia text,
  intereses text[] not null default '{}',
  codigo_invitacion text not null unique,
  invitado_por uuid references usuario(id),
  referido_premiado boolean not null default false,
  consent_terminos_en timestamptz not null,
  consent_ubicacion boolean not null default false,
  consent_personalizacion boolean not null default false,
  mostrar_nombre_locales boolean not null default false,
  alias text not null
);

-- recinto: categorías, zonas, locales ---------------------------------------
create table categoria (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  ambito text not null check (ambito in ('comida','tiendas')),
  orden int not null default 0
);

create table zona (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  piso text not null check (piso in ('N1','N2','T')),
  sector text not null,
  nombre text not null,
  x numeric not null, y numeric not null, ancho numeric not null, alto numeric not null
);

create table local (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  nombre text not null,
  categoria_id uuid not null references categoria(id),
  piso text not null check (piso in ('N1','N2','T')),
  sector text not null,
  numero_local text not null,
  coord_x numeric not null,
  coord_y numeric not null,
  zona_id uuid references zona(id),
  horario_apertura time not null default '10:00',
  horario_cierre time not null default '22:00',
  activo boolean not null default true,
  descripcion text not null default '',
  palabras_clave text[] not null default '{}',
  nit text unique,
  codigo_puerta text not null unique,
  creado_en timestamptz not null default now()
);

create table empleado_local (
  usuario_id uuid primary key references usuario(id) on delete cascade,
  local_id uuid not null references local(id),
  rol text not null check (rol in ('gerente','cajero')),
  etiqueta text not null default ''
);

-- fidelizacion ---------------------------------------------------------------
create table regla_puntos (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  version int not null,
  vigente boolean not null,
  bs_por_punto numeric not null,
  valor_punto_bs numeric not null,
  multiplicadores_categoria jsonb not null default '{}',
  multiplicadores_horario jsonb not null default '[]',
  dias_vencimiento int not null,
  niveles jsonb not null,
  bono_bienvenida int not null,
  puntos_descubrimiento int not null,
  puntos_visita_diaria int not null,
  puntos_referido int not null,
  puntos_hora_parqueo int not null,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now(),
  unique (recinto_id, version)
);

create table movimiento_puntos (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  cliente_id uuid not null references usuario(id),
  tipo text not null check (tipo in ('compra','canje','transferencia','bono','vencimiento','anulacion','referido','mision','descubrimiento','visita','drop','hito','parqueo','paseoya','factura')),
  puntos int not null,
  restante int not null default 0,
  referencia_id uuid,
  local_id uuid references local(id),
  descripcion text not null,
  vence_en timestamptz,
  regla_version int,
  creado_en timestamptz not null default now()
);
create index mov_cliente_idx on movimiento_puntos (cliente_id, creado_en desc);
create index mov_lotes_idx on movimiento_puntos (cliente_id, vence_en) where restante > 0;

-- comercio --------------------------------------------------------------------
create table transaccion (
  id uuid primary key default gen_random_uuid(),
  clave_idempotencia uuid not null unique,
  recinto_id uuid not null references recinto(id),
  cliente_id uuid not null references usuario(id),
  local_id uuid not null references local(id),
  empleado_id uuid references usuario(id),
  monto_bs numeric(12,2) not null check (monto_bs > 0),
  categoria text,
  nro_factura text,
  nit_emisor text,
  origen text not null check (origen in ('qr','codigo','factura','paseoya')),
  estado text not null default 'valida' check (estado in ('valida','anulada')),
  offline boolean not null default false,
  puntos int not null default 0,
  capturado_en timestamptz not null default now(),
  creado_en timestamptz not null default now()
);
create unique index transaccion_factura_uq on transaccion (nit_emisor, nro_factura) where origen = 'factura';
create index transaccion_local_idx on transaccion (local_id, creado_en);
create index transaccion_cliente_idx on transaccion (cliente_id, creado_en);

-- recompensas -----------------------------------------------------------------
create table recompensa (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  nombre text not null,
  descripcion text not null default '',
  costo_puntos int not null check (costo_puntos > 0),
  local_id uuid references local(id),
  stock int,
  temporada text,
  vigencia_desde date,
  vigencia_hasta date,
  tipo text not null default 'general' check (tipo in ('general','parqueo')),
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table canje (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references usuario(id),
  recompensa_id uuid not null references recompensa(id),
  codigo text not null unique,
  costo_puntos int not null,
  estado text not null check (estado in ('emitido','validado','vencido')),
  emitido_en timestamptz not null default now(),
  expira_en timestamptz not null,
  validado_por uuid references usuario(id),
  validado_local uuid references local(id),
  validado_en timestamptz
);
create index canje_estado_idx on canje (estado, expira_en);

-- participacion -----------------------------------------------------------------
create table segmento (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  nombre text not null,
  descripcion text not null,
  criterios jsonb not null,
  cliente_ids uuid[] not null default '{}',
  tamano int not null,
  ticket_promedio numeric not null,
  horario text not null,
  categorias text[] not null default '{}',
  creado_en timestamptz not null default now()
);

create table promocion (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  local_id uuid references local(id),
  titulo text not null,
  tipo text not null check (tipo in ('puntos_dobles','cupon')),
  multiplicador numeric not null default 2,
  descripcion text not null default '',
  segmento_id uuid references segmento(id),
  dias_semana int[] not null default '{0,1,2,3,4,5,6}',
  hora_inicio time not null default '00:00',
  hora_fin time not null default '23:59',
  inicio date not null,
  fin date not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada')),
  comentario text,
  creado_por uuid references usuario(id),
  revisado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);

create table mision (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  nombre text not null,
  descripcion text not null,
  plantilla text not null check (plantilla in ('locales_distintos','compras_categoria','franja_horaria','primera_visita','local_especifico')),
  regla jsonb not null,
  meta int not null,
  recompensa_puntos int not null,
  segmento_id uuid references segmento(id),
  cliente_id uuid references usuario(id),
  vigencia_desde date not null,
  vigencia_hasta date not null,
  activa boolean not null default true,
  origen text not null default 'admin' check (origen in ('admin','ia')),
  creado_en timestamptz not null default now()
);

create table progreso_mision (
  mision_id uuid not null references mision(id) on delete cascade,
  cliente_id uuid not null references usuario(id),
  avance int not null default 0,
  detalle jsonb not null default '[]',
  completada_en timestamptz,
  primary key (mision_id, cliente_id)
);

create table hito (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  nombre text not null,
  local_id uuid references local(id),
  zona_id uuid references zona(id),
  codigo text not null unique,
  puntos int not null,
  activo boolean not null default true
);

create table reclamo_hito (
  id uuid primary key default gen_random_uuid(),
  hito_id uuid not null references hito(id),
  cliente_id uuid not null references usuario(id),
  fecha date not null,
  creado_en timestamptz not null default now(),
  unique (hito_id, cliente_id, fecha)
);

-- presencia ---------------------------------------------------------------------
create table visita (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  cliente_id uuid not null references usuario(id),
  fuente text not null check (fuente in ('qr_entrada','geocerca','parqueo','paseoya','ar','checkin_local')),
  puerta text,
  entrada_en timestamptz not null default now(),
  salida_en timestamptz,
  puntos int not null default 0,
  avisos int not null default 0
);
create index visita_cliente_idx on visita (cliente_id, entrada_en desc);

create table checkin_local (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references usuario(id),
  local_id uuid not null references local(id),
  entrada_en timestamptz not null default now(),
  salida_en timestamptz,
  con_compra boolean not null default false,
  puntos int not null default 0
);
create index checkin_local_idx on checkin_local (local_id, entrada_en);
create index checkin_cliente_idx on checkin_local (cliente_id, entrada_en desc);

create table parqueo (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references usuario(id),
  ticket text not null,
  entrada_en timestamptz not null default now(),
  salida_en timestamptz,
  minutos int,
  horas_gratis int not null default 0,
  puntos_usados int not null default 0,
  monto_bs numeric not null default 0,
  estado text not null default 'abierto' check (estado in ('abierto','cerrado'))
);

-- telemetria ----------------------------------------------------------------------
create table busqueda (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  id_seudonimo uuid,
  termino text not null,
  origen text not null check (origen in ('app','jarvis','paseoya')),
  resultados int not null,
  creado_en timestamptz not null default now()
);

create table evento (
  id bigserial primary key,
  recinto_id uuid not null references recinto(id),
  id_seudonimo uuid,
  tipo text not null,
  payload jsonb not null default '{}',
  local_id uuid,
  zona_id uuid,
  creado_en timestamptz not null default now()
);
create index evento_tipo_idx on evento (tipo, creado_en);
create index evento_fecha_idx on evento (creado_en);

-- confianza -------------------------------------------------------------------------
create table alerta_fraude (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  transaccion_id uuid references transaccion(id),
  cliente_id uuid references usuario(id),
  local_id uuid references local(id),
  empleado_id uuid references usuario(id),
  regla text not null,
  detalle text not null,
  puntaje numeric not null,
  estado text not null default 'abierta' check (estado in ('abierta','descartada','confirmada')),
  revisado_por uuid references usuario(id),
  revisado_en timestamptz,
  creado_en timestamptz not null default now()
);

create table auditoria (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references usuario(id),
  accion text not null,
  entidad text not null,
  entidad_id text,
  antes jsonb,
  despues jsonb,
  creado_en timestamptz not null default now()
);

create table notificacion (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuario(id) on delete cascade,
  tipo text not null,
  titulo text not null,
  cuerpo text not null,
  datos jsonb not null default '{}',
  leida boolean not null default false,
  creado_en timestamptz not null default now()
);

-- paseoya -----------------------------------------------------------------------------
create table producto (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references local(id),
  nombre text not null,
  descripcion text not null default '',
  precio_bs numeric(12,2) not null check (precio_bs > 0),
  stock int not null default 0 check (stock >= 0),
  categoria_id uuid not null references categoria(id),
  foto_url text,
  activo boolean not null default true,
  destacado_hasta date,
  creado_en timestamptz not null default now()
);

create table favorito (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references usuario(id),
  producto_id uuid references producto(id),
  local_id uuid references local(id),
  creado_en timestamptz not null default now()
);
create unique index favorito_producto_uq on favorito (cliente_id, producto_id) where producto_id is not null;
create unique index favorito_local_uq on favorito (cliente_id, local_id) where local_id is not null;

create table drop_espacial (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  zona_id uuid not null references zona(id),
  producto_id uuid not null references producto(id),
  precio_especial numeric(12,2) not null,
  mensaje text not null,
  codigo text not null unique,
  inicio timestamptz not null default now(),
  fin timestamptz not null,
  max_reclamos int not null default 50,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);

create table reclamo_drop (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references drop_espacial(id),
  cliente_id uuid not null references usuario(id),
  usado boolean not null default false,
  creado_en timestamptz not null default now(),
  unique (drop_id, cliente_id)
);

create table pedido (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  codigo text not null unique,
  cliente_id uuid not null references usuario(id),
  total_bs numeric(12,2) not null,
  franja_inicio timestamptz not null,
  franja_fin timestamptz not null,
  creado_en timestamptz not null default now()
);

create table subpedido (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedido(id) on delete cascade,
  local_id uuid not null references local(id),
  estado text not null default 'recibido' check (estado in ('recibido','confirmado','preparando','listo','cliente_llego','entregado','vencido')),
  total_bs numeric(12,2) not null,
  codigo_retiro text not null unique,
  pin text not null,
  pago text not null default 'en_local' check (pago in ('en_local','qr_anticipado')),
  comprobante_url text,
  confirmado_en timestamptz,
  preparando_en timestamptz,
  listo_en timestamptz,
  llego_en timestamptz,
  entregado_en timestamptz,
  puntos int not null default 0
);
create index subpedido_local_idx on subpedido (local_id, estado);

create table subpedido_item (
  id uuid primary key default gen_random_uuid(),
  subpedido_id uuid not null references subpedido(id) on delete cascade,
  producto_id uuid not null references producto(id),
  nombre text not null,
  cantidad int not null check (cantidad > 0),
  precio_bs numeric(12,2) not null,
  drop_id uuid references drop_espacial(id)
);
`,
  },
  {
    id: '002_vistas_oro',
    sql: /* sql */ `
-- Capa oro: agregados para el Centro de Inteligencia y para "Pregúntale a tus datos".
-- Ninguna vista expone identidad; los grupos de clientes tienen k >= 5.
create schema if not exists oro;

create or replace view oro.ventas_local_dia as
select l.nombre as local, c.nombre as categoria, l.piso, l.sector,
       bo(t.creado_en)::date as fecha,
       count(*)::int as compras,
       sum(t.monto_bs)::numeric(14,2) as ventas_bs,
       count(distinct t.cliente_id)::int as clientes_unicos,
       round(avg(t.monto_bs), 2) as ticket_promedio
from transaccion t
join local l on l.id = t.local_id
join categoria c on c.id = l.categoria_id
where t.estado = 'valida'
group by 1,2,3,4,5
having count(distinct t.cliente_id) >= 5;

create or replace view oro.ventas_hora as
select extract(dow from bo(t.creado_en))::int as dia_semana,
       extract(hour from bo(t.creado_en))::int as hora,
       count(*)::int as compras,
       sum(t.monto_bs)::numeric(14,2) as ventas_bs
from transaccion t where t.estado = 'valida'
group by 1,2;

create or replace view oro.visitas_zona_hora as
select z.nombre as zona, z.piso, bo(c.entrada_en)::date as fecha,
       extract(hour from bo(c.entrada_en))::int as hora,
       count(*)::int as checkins,
       count(distinct c.cliente_id)::int as clientes_unicos
from checkin_local c
join local l on l.id = c.local_id
join zona z on z.id = l.zona_id
group by 1,2,3,4
having count(distinct c.cliente_id) >= 5;

create or replace view oro.afinidad_locales as
with pares as (
  select distinct t.cliente_id, t.local_id from transaccion t where t.estado = 'valida'
)
select la.nombre as local_a, lb.nombre as local_b,
       count(*)::int as clientes_comunes,
       round(100.0 * count(*) / nullif((select count(distinct p.cliente_id) from pares p where p.local_id = a.local_id), 0), 1) as pct_de_a
from pares a
join pares b on a.cliente_id = b.cliente_id and a.local_id <> b.local_id
join local la on la.id = a.local_id
join local lb on lb.id = b.local_id
group by la.nombre, lb.nombre, a.local_id
having count(*) >= 5;

create or replace view oro.afinidad_mismo_dia as
with dia as (
  select distinct t.cliente_id, t.local_id, bo(t.creado_en)::date as fecha from transaccion t where t.estado = 'valida'
)
select la.nombre as local_a, lb.nombre as local_b,
       count(*)::int as visitas_compartidas
from dia a
join dia b on a.cliente_id = b.cliente_id and a.fecha = b.fecha and a.local_id <> b.local_id
join local la on la.id = a.local_id
join local lb on lb.id = b.local_id
group by 1,2
having count(distinct a.cliente_id) >= 5;

create or replace view oro.busquedas_sin_resultado as
select lower(termino) as termino, origen, count(*)::int as veces, max(creado_en) as ultima_vez
from busqueda where resultados = 0
group by 1,2;

create or replace view oro.economia_puntos as
select bo(creado_en)::date as fecha,
       sum(case when puntos > 0 then puntos else 0 end)::int as emitidos,
       sum(case when tipo = 'canje' or tipo = 'parqueo' then -puntos else 0 end)::int as canjeados,
       sum(case when tipo = 'vencimiento' then -puntos else 0 end)::int as vencidos
from movimiento_puntos group by 1;

create or replace view oro.clientes_perfil as
select coalesce(p.zona_residencia, 'sin dato') as zona_residencia,
       case when p.fecha_nacimiento is null then 'sin dato'
            when age(p.fecha_nacimiento) < interval '25 years' then '18-24'
            when age(p.fecha_nacimiento) < interval '35 years' then '25-34'
            when age(p.fecha_nacimiento) < interval '50 years' then '35-49'
            else '50+' end as rango_edad,
       coalesce(p.genero, 'sin dato') as genero,
       count(*)::int as clientes
from cliente_perfil p join usuario u on u.id = p.usuario_id
where u.estado <> 'eliminado'
group by 1,2,3 having count(*) >= 5;

create or replace view oro.pedidos_paseoya as
select l.nombre as local, s.estado, bo(p.creado_en)::date as fecha,
       count(*)::int as subpedidos, sum(s.total_bs)::numeric(14,2) as total_bs
from subpedido s join pedido p on p.id = s.pedido_id join local l on l.id = s.local_id
group by 1,2,3;

create or replace view oro.segmentos as
select nombre, descripcion, tamano, ticket_promedio, horario, categorias from segmento where tamano >= 5;
`,
  },
  {
    id: '003_anomalias_y_llegada',
    sql: /* sql */ `
alter table transaccion add column puntaje_anomalia numeric;
alter table checkin_local add column origen text not null default 'qr';
create index alerta_estado_idx on alerta_fraude (recinto_id, estado, creado_en desc);
create index busqueda_fecha_idx on busqueda (creado_en);
`,
  },
  {
    id: '004_grafo_y_jarvis',
    sql: /* sql */ `
-- orientacion: el edificio como grafo de nodos de ubicación (pasillos, locales, hitos, accesos, escaleras)
create table nodo_ubicacion (
  id text primary key,
  recinto_id uuid not null references recinto(id),
  piso text not null check (piso in ('N1','N2','T')),
  tipo text not null check (tipo in ('pasillo','local','hito','entrada','escalera','ascensor')),
  nombre text not null,
  x numeric not null,
  y numeric not null,
  zona_id uuid references zona(id),
  local_id uuid references local(id) on delete cascade,
  hito_id uuid references hito(id) on delete cascade,
  codigo_qr text
);
create index nodo_local_idx on nodo_ubicacion (local_id);

create table arista_ubicacion (
  desde text not null references nodo_ubicacion(id) on delete cascade,
  hasta text not null references nodo_ubicacion(id) on delete cascade,
  metros numeric not null,
  tipo text not null default 'caminar' check (tipo in ('caminar','escalera','ascensor')),
  primary key (desde, hasta)
);

-- última posición conocida del cliente (prueba de presencia por QR, check-in o compra)
create table posicion_cliente (
  cliente_id uuid primary key references usuario(id) on delete cascade,
  nodo_id text not null references nodo_ubicacion(id) on delete cascade,
  fuente text not null,
  en timestamptz not null default now()
);

-- órdenes de voz que Jarvis envió (auditoría, límite de frecuencia y latencia del motor)
create table orden_jarvis (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  cliente_id uuid not null references usuario(id) on delete cascade,
  disparador text not null,
  texto text not null,
  contexto text not null,
  motor text not null,
  latencia_ms int not null,
  datos jsonb not null default '{}',
  creado_en timestamptz not null default now()
);
create index orden_jarvis_cliente_idx on orden_jarvis (cliente_id, creado_en desc);
`,
  },
  {
    id: '005_comercio_eventos_memoria',
    sql: /* sql */ `
-- identidad: una sola cuenta de comercio por negocio (reemplaza a cajero y gerente)
alter table usuario drop constraint if exists usuario_rol_check;
update usuario set rol = 'comercio' where rol in ('cajero','gerente');
alter table usuario add constraint usuario_rol_check check (rol in ('cliente','comercio','admin','marketing','analista'));
alter table empleado_local drop constraint if exists empleado_local_rol_check;
update empleado_local set rol = 'comercio';
alter table empleado_local alter column rol set default 'comercio';
alter table empleado_local add constraint empleado_local_rol_check check (rol = 'comercio');

-- recinto: datos que Jarvis usa para responder
alter table local add column telefono text;
alter table local add column dias_atencion int[] not null default '{0,1,2,3,4,5,6}';
alter table producto add column tiempo_preparacion_min int;
alter table producto add column etiquetas text[] not null default '{}';

-- servicios del Paseo (baños, cajeros automáticos, wifi, lactancia…): también son nodos del grafo
create table servicio_paseo (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  tipo text not null,
  nombre text not null,
  descripcion text not null default '',
  piso text not null check (piso in ('N1','N2','T')),
  x numeric not null,
  y numeric not null,
  zona_id uuid references zona(id),
  horario text,
  palabras_clave text[] not null default '{}',
  activo boolean not null default true
);
alter table nodo_ubicacion drop constraint if exists nodo_ubicacion_tipo_check;
alter table nodo_ubicacion add constraint nodo_ubicacion_tipo_check check (tipo in ('pasillo','local','hito','entrada','escalera','ascensor','servicio'));
alter table nodo_ubicacion add column servicio_id uuid references servicio_paseo(id) on delete cascade;

-- participacion: eventos del Paseo (conciertos, ferias, talleres…), propuestos por un comercio o creados por el admin
create table actividad (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  titulo text not null,
  descripcion text not null default '',
  tipo text not null,
  inicio timestamptz not null,
  fin timestamptz not null,
  zona_id uuid references zona(id),
  local_id uuid references local(id),
  lugar text not null,
  precio_bs numeric(12,2),
  cupos int,
  puntos int not null default 0,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','cancelada')),
  comentario text,
  creado_por uuid references usuario(id),
  revisado_por uuid references usuario(id),
  creado_en timestamptz not null default now(),
  check (fin > inicio)
);
create index actividad_fecha_idx on actividad (recinto_id, estado, inicio);

-- participacion: un comercio pide un Drop para su producto; el admin lo aprueba y lo lanza
create table solicitud_drop (
  id uuid primary key default gen_random_uuid(),
  recinto_id uuid not null references recinto(id),
  local_id uuid not null references local(id),
  producto_id uuid not null references producto(id) on delete cascade,
  zona_id uuid references zona(id),
  precio_especial numeric(12,2) not null,
  mensaje text not null,
  fecha_deseada timestamptz,
  minutos int not null default 60,
  max_reclamos int not null default 50,
  estado text not null default 'pendiente' check (estado in ('pendiente','lanzada','rechazada','cancelada')),
  comentario text,
  drop_id uuid references drop_espacial(id),
  creado_por uuid references usuario(id),
  revisado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create index solicitud_drop_estado_idx on solicitud_drop (recinto_id, estado, creado_en desc);
alter table drop_espacial add column local_id uuid references local(id);

-- jarvis: memoria de la conversación con cada cliente
create table conversacion_jarvis (
  id bigserial primary key,
  cliente_id uuid not null references usuario(id) on delete cascade,
  rol text not null check (rol in ('cliente','jarvis')),
  texto text not null,
  intencion text,
  entidades jsonb not null default '{}',
  datos jsonb not null default '{}',
  creado_en timestamptz not null default now()
);
create index conversacion_cliente_idx on conversacion_jarvis (cliente_id, creado_en desc);
`,
  },
];

/** Tablas propias del sistema: el reinicio del seed borra solo estas, nunca otras de la misma base. */
export const TABLAS_PROPIAS = [
  ...new Set(MIGRACIONES.flatMap((m) => [...m.sql.matchAll(/create table (?:if not exists )?(\w+)/g)].map((x) => x[1]))),
  '_migracion',
];
