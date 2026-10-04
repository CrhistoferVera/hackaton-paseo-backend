/** Plano base de los cinco niveles indicados por el inventario del Paseo. */
const PISOS = ['T', 'N1', 'N2', 'N3', 'N4'] as const;
const SECTORES = [
  { sector: 'A', nombre: 'Sector A', x: 0, ancho: 333 },
  { sector: 'B', nombre: 'Sector B', x: 333, ancho: 334 },
  { sector: 'C', nombre: 'Sector C', x: 667, ancho: 333 },
];
export const ZONAS = PISOS.flatMap((piso) =>
  SECTORES.map((s) => ({ piso, sector: s.sector, nombre: s.nombre, x: s.x, y: 0, ancho: s.ancho, alto: 600 })),
);

/** Los locales y sus productos se generan desde el inventario Hackaton.csv. */

export const SERVICIOS: { tipo: string; nombre: string; descripcion: string; piso: 'N1' | 'N2' | 'N3' | 'N4' | 'T'; x: number; y: number; horario?: string; claves: string[] }[] = [
  { tipo: 'bano', nombre: 'el baño del Nivel 1 oeste', descripcion: 'Baños de damas, varones y familiar, con cambiador de bebé.', piso: 'N1', x: 330, y: 230, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'servicio higienico', 'wc', 'cambiador'] },
  { tipo: 'bano', nombre: 'el baño del Nivel 1 este', descripcion: 'Baños de damas y varones, y baño accesible.', piso: 'N1', x: 660, y: 370, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'bano', nombre: 'el baño del Nivel 2', descripcion: 'Baños de damas, varones y familiar.', piso: 'N2', x: 340, y: 370, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'bano', nombre: 'el baño de la Planta baja', descripcion: 'Baños junto al acceso de Planta baja, con lavamanos para niños.', piso: 'T', x: 560, y: 360, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático del Banco Unión', descripcion: 'Retiros en bolivianos y dólares, las 24 horas dentro del horario del Paseo.', piso: 'N1', x: 40, y: 240, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'retirar dinero', 'banco', 'efectivo'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático del BNB', descripcion: 'Acepta tarjetas Visa y Mastercard de cualquier banco.', piso: 'N1', x: 960, y: 240, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'banco', 'efectivo'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático de Planta baja', descripcion: 'Del Banco Mercantil Santa Cruz.', piso: 'T', x: 40, y: 300, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'banco', 'efectivo'] },
  { tipo: 'informacion', nombre: 'el módulo de información', descripcion: 'Atención al cliente, objetos perdidos, préstamo de sillas de ruedas y coches de bebé, y canje de dudas sobre Paseo Points.', piso: 'N1', x: 560, y: 60, horario: 'de 9 de la mañana a 10 de la noche', claves: ['informacion', 'atencion al cliente', 'modulo de informacion', 'reclamo', 'queja', 'ayuda presencial'] },
  { tipo: 'objetos_perdidos', nombre: 'objetos perdidos, en el módulo de información', descripcion: 'Si perdiste algo, acércate al módulo de información junto a la Puerta Norte; guardan los objetos 30 días.', piso: 'N1', x: 560, y: 60, claves: ['objetos perdidos', 'perdi', 'se me perdio', 'olvide', 'deje olvidado', 'encontre'] },
  { tipo: 'silla_ruedas', nombre: 'el préstamo de sillas de ruedas', descripcion: 'Préstamo gratuito de sillas de ruedas y coches de bebé con tu carnet, en el módulo de información. Hay ascensor a todos los pisos.', piso: 'N1', x: 560, y: 60, claves: ['silla de ruedas', 'accesibilidad', 'discapacidad', 'coche de bebe', 'carrito de bebe', 'movilidad reducida'] },
  { tipo: 'wifi', nombre: 'el wifi gratuito', descripcion: 'La red se llama PaseoAranjuez-Libre; conéctate y acepta los términos, sin contraseña.', piso: 'N1', x: 560, y: 60, claves: ['wifi', 'wi fi', 'internet', 'red', 'contrasena del wifi', 'clave del wifi'] },
  { tipo: 'lactancia', nombre: 'la sala de lactancia', descripcion: 'Sala privada con sillón, cambiador y microondas para calentar biberones.', piso: 'N2', x: 660, y: 230, claves: ['lactancia', 'amamantar', 'dar de lactar', 'dar pecho', 'cambiador', 'cambiar al bebe', 'mudar al bebe'] },
  { tipo: 'enfermeria', nombre: 'la enfermería', descripcion: 'Primeros auxilios con personal de salud; en una emergencia avisa a cualquier guardia.', piso: 'N1', x: 330, y: 370, horario: 'de 9 de la mañana a 11 de la noche', claves: ['enfermeria', 'primeros auxilios', 'me siento mal', 'medico', 'doctor', 'emergencia', 'me lastime', 'mareo', 'soroche'] },
  { tipo: 'zona_infantil', nombre: 'la zona infantil', descripcion: 'Juegos para niños de 2 a 8 años; deben estar con un adulto. Es gratuita.', piso: 'N2', x: 160, y: 370, horario: 'de 10 de la mañana a 9 de la noche', claves: ['zona infantil', 'juegos para ninos', 'parque infantil', 'area de ninos', 'ninos jugar', 'pelotero'] },
  { tipo: 'carga_celular', nombre: 'la estación de carga de celulares', descripcion: 'Casilleros con cargadores USB-C, Lightning y micro USB; es gratis.', piso: 'T', x: 300, y: 240, claves: ['cargar celular', 'cargar el celular', 'cargador', 'bateria', 'se me descargo', 'estacion de carga', 'enchufe'] },
  { tipo: 'carga_celular', nombre: 'la estación de carga del Nivel 2', descripcion: 'Casilleros con cargadores para celular; es gratis.', piso: 'N2', x: 660, y: 370, claves: ['cargar celular', 'cargar el celular', 'cargador', 'bateria', 'se me descargo', 'estacion de carga'] },
  { tipo: 'casilleros', nombre: 'los casilleros', descripcion: 'Casilleros para guardar bolsas y mochilas mientras paseas; cuestan 5 bolivianos por día.', piso: 'N1', x: 40, y: 370, claves: ['casillero', 'casilleros', 'guardar mis bolsas', 'guardarropa', 'lockers', 'guardar mochila'] },
  { tipo: 'taxi', nombre: 'la parada de taxis y radiomóviles', descripcion: 'Taxis seguros afuera de la Puerta Sur; también puedes pedir uno en el módulo de información.', piso: 'N1', x: 480, y: 580, claves: ['taxi', 'radio movil', 'radiomovil', 'uber', 'transporte', 'como me voy', 'trufi', 'minibus'] },
  { tipo: 'mascotas', nombre: 'la política de mascotas', descripcion: 'Las mascotas pequeñas y medianas pueden entrar con correa o en brazos; no pueden ingresar al patio de comidas ni al cine.', piso: 'N1', x: 560, y: 60, claves: ['mascota', 'mascotas', 'perro', 'perrito', 'gato', 'puedo entrar con mi perro', 'pet friendly'] },
  { tipo: 'oracion', nombre: 'la sala de oración', descripcion: 'Espacio de silencio abierto a todas las creencias.', piso: 'N2', x: 960, y: 240, claves: ['sala de oracion', 'capilla', 'rezar', 'orar', 'meditar'] },
  { tipo: 'agua', nombre: 'el bebedero de agua', descripcion: 'Agua purificada gratis; trae tu botella.', piso: 'T', x: 800, y: 300, claves: ['agua', 'bebedero', 'tengo sed', 'agua gratis', 'llenar mi botella'] },
];

/** Eventos que se repiten: días de la semana (0 = domingo), hora de inicio y fin. */
/** Eventos de ejemplo distribuidos en los niveles del inventario. */
export const EVENTOS_RECURRENTES: { titulo: string; tipo: string; descripcion: string; dias: number[]; desde: number; hasta: number; local?: string; zona: string; puntos: number; precio?: number; cupos?: number }[] = [
  { titulo: 'Música en vivo', tipo: 'concierto', descripcion: 'Bandas paceñas de rock y jazz, entrada libre.', dias: [4, 5, 6], desde: 19.5, hasta: 22.5, zona: 'N4-B', puntos: 30 },
  { titulo: 'Cuentacuentos andinos', tipo: 'infantil', descripcion: 'Leyendas bolivianas para niñas y niños de 4 a 9 años.', dias: [0, 6], desde: 11, hasta: 12, zona: 'N1-B', puntos: 20, cupos: 30 },
  { titulo: 'Clase abierta de zumba', tipo: 'deporte', descripcion: 'Una hora de baile para todas las edades; trae ropa cómoda.', dias: [2, 4], desde: 18.5, hasta: 19.5, zona: 'N1-B', puntos: 25 },
  { titulo: 'Torneo de videojuegos', tipo: 'deporte', descripcion: 'Eliminatorias uno contra uno con premios para quienes participen.', dias: [5], desde: 17, hasta: 21, zona: 'N4-A', puntos: 40, precio: 20, cupos: 32 },
  { titulo: 'Degustación de productos locales', tipo: 'degustacion', descripcion: 'Prueba especialidades de los locales gastronómicos del Paseo.', dias: [3, 6], desde: 16, hasta: 17, zona: 'N3-A', puntos: 20, cupos: 15 },
  { titulo: 'Taller de cocina boliviana', tipo: 'taller', descripcion: 'Aprende técnicas tradicionales con ingredientes locales.', dias: [0], desde: 10, hasta: 11.5, zona: 'N3-B', puntos: 30, precio: 35, cupos: 12 },
  { titulo: 'Noche de juegos', tipo: 'deporte', descripcion: 'Una noche para jugar y compartir en familia.', dias: [3], desde: 19, hasta: 23, zona: 'N4-A', puntos: 15 },
  { titulo: 'Karaoke', tipo: 'concierto', descripcion: 'Canta tus canciones favoritas; premio al mejor del mes.', dias: [1, 2], desde: 20, hasta: 22.5, zona: 'N4-C', puntos: 20 },
  { titulo: 'Feria de emprendimientos paceños', tipo: 'feria', descripcion: 'Emprendimientos de artesanía, ropa y comida.', dias: [6, 0], desde: 10, hasta: 20, zona: 'N1-B', puntos: 25 },
  { titulo: 'Función de cine familiar', tipo: 'cine', descripcion: 'Película animada para compartir en familia.', dias: [0], desde: 15, hasta: 17, zona: 'N4-A', puntos: 20, precio: 20 },
];

/** Eventos únicos (días desde hoy), asociados a zonas existentes. */
export const EVENTOS_ESPECIALES: { titulo: string; tipo: string; descripcion: string; dia: number; desde: number; hasta: number; local?: string; zona: string; puntos: number; precio?: number; cupos?: number }[] = [
  { titulo: 'Desfile de moda', tipo: 'moda', descripcion: 'Colecciones de temporada de los locales del Paseo.', dia: 3, desde: 18, hasta: 19.5, zona: 'N1-A', puntos: 40 },
  { titulo: 'Feria de tecnología', tipo: 'lanzamiento', descripcion: 'Exhibición de novedades y sorteos para visitantes.', dia: 5, desde: 17, hasta: 20, zona: 'N2-C', puntos: 30 },
  { titulo: 'Concierto acústico', tipo: 'concierto', descripcion: 'Música en vivo en un formato íntimo.', dia: 8, desde: 19, hasta: 21, zona: 'N2-C', puntos: 40, precio: 30, cupos: 60 },
  { titulo: 'Noche infantil de disfraces', tipo: 'infantil', descripcion: 'Concurso de disfraces y dulces para toda la familia.', dia: 27, desde: 16, hasta: 20, zona: 'N1-A', puntos: 50 },
  { titulo: 'Festival gastronómico', tipo: 'degustacion', descripcion: 'Degustación de las especialidades gastronómicas del Paseo.', dia: 12, desde: 9, hasta: 13, zona: 'N3-A', puntos: 40 },
  { titulo: 'Taller de cuidado de la piel', tipo: 'taller', descripcion: 'Rutina de cuidado de la piel para el clima de altura.', dia: 6, desde: 17, hasta: 18, zona: 'N2-A', puntos: 25, cupos: 20 },
  { titulo: 'Maratón de películas de terror', tipo: 'cine', descripcion: 'Tres películas seguidas con combo incluido.', dia: 26, desde: 20, hasta: 23.9, zona: 'N4-A', puntos: 40, precio: 90, cupos: 120 },
];
export const NOMBRES = ['María', 'José', 'Ana', 'Luis', 'Carla', 'Jorge', 'Lucía', 'Diego', 'Valeria', 'Andrés', 'Camila', 'Marco', 'Daniela', 'Fernando', 'Paola', 'Ricardo', 'Gabriela', 'Sergio', 'Natalia', 'Rodrigo', 'Fabiola', 'Mauricio', 'Verónica', 'Álvaro', 'Silvia', 'Eduardo', 'Rocío', 'Hugo', 'Mariela', 'Iván', 'Patricia', 'Óscar', 'Jimena', 'Javier', 'Claudia', 'Pablo', 'Susana', 'Gustavo', 'Wendy', 'Rubén', 'Leonardo', 'Sofía', 'Mateo', 'Valentina', 'Joaquín', 'Isabel', 'Martín', 'Renata'];
export const APELLIDOS = ['Rojas', 'Mamani', 'Quispe', 'Flores', 'Gutiérrez', 'Vargas', 'Choque', 'Fernández', 'López', 'Torrez', 'Céspedes', 'Arce', 'Morales', 'Pinto', 'Salazar', 'Villca', 'Condori', 'Paz', 'Suárez', 'Ríos', 'Ayala', 'Mendoza', 'Rocha', 'Aguilar', 'Ticona', 'Apaza', 'Calle', 'Zeballos'];
export const ZONAS_RESIDENCIA = ['Calacoto', 'Achumani', 'Obrajes', 'San Miguel', 'Irpavi', 'Sopocachi', 'Miraflores', 'Mallasa', 'Cota Cota', 'Següencoma', 'Centro', 'El Alto', 'Alto Obrajes', 'Los Pinos'];
export const BUSQUEDAS_SIN_RESULTADO = ['zara', 'apple store', 'starbucks', 'h&m', 'farmacia 24 horas', 'cine 4dx', 'decathlon', 'sony', 'tienda de vinos', 'spa', 'kfc', 'tienda naturista', 'ikea', 'gimnasio', 'lavandería', 'cerrajería', 'sastrería', 'tienda de bicicletas'];

/**
 * Información general del Paseo que Jarvis puede citar tal cual. La administra el equipo del Paseo
 * en «Información para Jarvis»; estos textos son de ejemplo y deben revisarse antes de producción.
 */
export const INFO_PASEO: { tema: string; claves: string[]; respuesta: string }[] = [
  {
    tema: 'Medios de pago',
    claves: ['tarjeta', 'tarjetas', 'tarjeta de credito', 'tarjeta de debito', 'credito', 'debito', 'efectivo', 'pago con qr', 'pagar con qr', 'visa', 'mastercard', 'medios de pago', 'formas de pago', 'como pago', 'aceptan'],
    respuesta: 'Cada local define sus medios de pago; la mayoría acepta efectivo, tarjetas de débito y crédito y pago con QR. En PaseoYa pagas con QR desde la app. Si quieres estar seguro, pregunta en la caja del local.',
  },
  {
    tema: 'Cambios y devoluciones',
    claves: ['devolver', 'devolucion', 'devoluciones', 'cambio de producto', 'cambiar un producto', 'garantia', 'reembolso', 'reclamo', 'reclamar una compra'],
    respuesta: 'Los cambios y devoluciones los define cada local; normalmente piden la factura y el producto sin uso. Si tienes un problema con una compra, el módulo de información del Nivel 1, junto a la Puerta Norte, te ayuda.',
  },
  {
    tema: 'Facturas y puntos',
    claves: ['factura', 'facturas', 'siat', 'registrar factura', 'escanear factura', 'compre sin la app', 'olvide sumar puntos'],
    respuesta: 'Si compraste en un local del Paseo y no sumaste puntos en caja, escanea el QR de tu factura en la app, en Facturas, el mismo día de la compra. Cada factura suma puntos una sola vez.',
  },
  {
    tema: 'Fumar',
    claves: ['fumar', 'cigarro', 'cigarrillo', 'vapear', 'vape', 'zona de fumadores'],
    respuesta: 'No se permite fumar ni vapear dentro del Paseo. Puedes hacerlo afuera, en los accesos al aire libre.',
  },
  {
    tema: 'Seguridad',
    claves: ['seguridad', 'guardia', 'guardias', 'emergencia', 'robo', 'me robaron', 'policia'],
    respuesta: 'Hay guardias de seguridad en todos los niveles. Ante una emergencia avisa a cualquier guardia o acércate al módulo de información del Nivel 1, junto a la Puerta Norte.',
  },
];
