/** Datos de referencia del Paseo para el generador sintético. Nombres de locales ficticios. */
export const CATEGORIAS: { nombre: string; ambito: 'comida' | 'tiendas'; orden: number }[] = [
  { nombre: 'Comida', ambito: 'comida', orden: 1 },
  { nombre: 'Tecnología', ambito: 'tiendas', orden: 2 },
  { nombre: 'Moda', ambito: 'tiendas', orden: 3 },
  { nombre: 'Accesorios', ambito: 'tiendas', orden: 4 },
  { nombre: 'Servicios', ambito: 'tiendas', orden: 5 },
  { nombre: 'Regalos', ambito: 'tiendas', orden: 6 },
  { nombre: 'Hogar', ambito: 'tiendas', orden: 7 },
  { nombre: 'Entretenimiento', ambito: 'tiendas', orden: 8 },
];

/** Plano: cada piso mide 1000 × 600 unidades; el pasillo central va de y = 250 a y = 350. */
export const ZONAS = [
  { piso: 'N1', sector: 'A', nombre: 'Sector A', x: 0, y: 0, ancho: 333, alto: 600 },
  { piso: 'N1', sector: 'B', nombre: 'Sector B', x: 333, y: 0, ancho: 334, alto: 600 },
  { piso: 'N1', sector: 'C', nombre: 'Sector C', x: 667, y: 0, ancho: 333, alto: 600 },
  { piso: 'N2', sector: 'A', nombre: 'Sector A', x: 0, y: 0, ancho: 333, alto: 600 },
  { piso: 'N2', sector: 'B', nombre: 'Sector B', x: 333, y: 0, ancho: 334, alto: 600 },
  { piso: 'N2', sector: 'C', nombre: 'Sector C', x: 667, y: 0, ancho: 333, alto: 600 },
  { piso: 'T', sector: 'P', nombre: 'Patio de comidas', x: 0, y: 0, ancho: 520, alto: 600 },
  { piso: 'T', sector: 'K', nombre: 'Cines', x: 520, y: 0, ancho: 280, alto: 600 },
  { piso: 'T', sector: 'L', nombre: 'Terraza', x: 800, y: 0, ancho: 200, alto: 600 },
];

export interface LocalSeed {
  nombre: string;
  categoria: string;
  piso: 'N1' | 'N2' | 'T';
  sector: string;
  numero: string;
  x: number;
  y: number;
  clave: string[];
  ticket: [number, number];
  descripcion: string;
  horario: [string, string];
  dias: number[];
  telefono: string;
  foto_url?: string | null;
  banner_url?: string | null;
}

const TODOS = [0, 1, 2, 3, 4, 5, 6];
const SIN_DOMINGO = [1, 2, 3, 4, 5, 6];
const SIN_LUNES = [0, 2, 3, 4, 5, 6];

const L = (
  nombre: string, categoria: string, piso: 'N1' | 'N2' | 'T', sector: string, numero: string, x: number, y: number, ticket: [number, number],
  descripcion: string, clave: string[], horario: [string, string] = ['10:00', '22:00'], dias = TODOS, telefono = '',
  foto_url: string | null = null, banner_url: string | null = null,
): LocalSeed => ({ nombre, categoria, piso, sector, numero, x, y, ticket, descripcion, clave, horario, dias, telefono, foto_url, banner_url });

export const LOCALES: LocalSeed[] = [
  // Nivel 1
  L('Café Alameda', 'Comida', 'N1', 'A', '104', 80, 140, [15, 45], 'Café de especialidad y repostería', ['café', 'capuchino', 'desayuno', 'cafetería', 'torta'], ['08:00', '21:30'], TODOS, '2-2794104'),
  L('Farmacia Aranjuez', 'Servicios', 'N1', 'A', '108', 220, 140, [20, 180], 'Farmacia y cuidado personal', ['farmacia', 'medicamentos', 'remedios', 'pastillas', 'botica'], ['08:00', '22:30'], TODOS, '2-2794108'),
  L('Moda Andina', 'Moda', 'N1', 'A', '112', 80, 460, [150, 650], 'Prendas con textiles bolivianos', ['ropa', 'alpaca', 'chompa', 'poncho', 'chalina'], ['10:00', '21:00'], TODOS, '2-2794112'),
  L('Urban Style', 'Moda', 'N1', 'A', '116', 230, 460, [120, 480], 'Moda urbana juvenil', ['ropa', 'jeans', 'zapatillas', 'poleras', 'gorras'], ['10:00', '22:00'], TODOS, '7-1594116'),
  L('Zapatería Illimani', 'Moda', 'N1', 'B', '120', 420, 140, [180, 700], 'Calzado formal y casual', ['zapatos', 'botas', 'calzado', 'sandalias'], ['10:00', '21:00'], SIN_DOMINGO, '2-2794120'),
  L('Joyería Del Sol', 'Accesorios', 'N1', 'B', '124', 580, 140, [200, 2500], 'Joyas de plata y oro', ['joyas', 'anillo', 'plata', 'oro', 'aretes', 'collar'], ['10:00', '20:30'], SIN_DOMINGO, '2-2794124'),
  L('Óptica Visión', 'Servicios', 'N1', 'B', '128', 420, 460, [150, 900], 'Lentes y examen visual', ['lentes', 'óptica', 'anteojos', 'gafas', 'examen de vista'], ['10:00', '20:00'], SIN_DOMINGO, '2-2794128'),
  L('Peluquería Estilo', 'Servicios', 'N1', 'B', '132', 580, 460, [40, 250], 'Corte, color y peinado', ['peluquería', 'corte', 'tinte', 'peinado', 'manicure'], ['09:00', '20:00'], SIN_LUNES, '7-6594132'),
  L('TecnoCentro', 'Tecnología', 'N1', 'C', '136', 750, 140, [100, 2800], 'Electrónica, audio y computación', ['audífonos', 'laptop', 'celular', 'cargador', 'computadora', 'parlante'], ['10:00', '22:00'], TODOS, '2-2794136'),
  L('Celular Express', 'Tecnología', 'N1', 'C', '140', 900, 140, [80, 1900], 'Celulares, accesorios y reparación', ['celular', 'funda', 'audífonos', 'reparación', 'pantalla', 'cargador'], ['10:00', '22:00'], TODOS, '7-7594140'),
  L('Regalos Sorpresa', 'Regalos', 'N1', 'C', '144', 750, 460, [40, 350], 'Detalles y regalos para toda ocasión', ['regalo', 'peluche', 'tarjeta', 'globo', 'detalle'], ['10:00', '22:00'], TODOS, '2-2794144'),
  L('Casa & Deco', 'Hogar', 'N1', 'C', '148', 900, 460, [60, 900], 'Decoración y menaje', ['decoración', 'cojines', 'vajilla', 'velas', 'lámpara'], ['10:00', '21:00'], TODOS, '2-2794148'),
  L('Librería Cervantes', 'Regalos', 'N1', 'B', '152', 500, 300, [40, 300], 'Libros y papelería', ['libros', 'cuadernos', 'novela', 'papelería', 'útiles'], ['10:00', '21:00'], TODOS, '2-2794152'),
  L('Juguetería Mundo Mágico', 'Regalos', 'N1', 'A', '156', 160, 300, [60, 500], 'Juguetes y juegos de mesa', ['juguetes', 'lego', 'muñeca', 'juego de mesa', 'rompecabezas'], ['10:00', '21:30'], TODOS, '2-2794156'),
  // Nivel 2
  L('Sport Center', 'Moda', 'N2', 'A', '204', 80, 140, [150, 900], 'Ropa y calzado deportivo', ['deporte', 'zapatillas', 'pelota', 'deportivo', 'gimnasio'], ['10:00', '22:00'], TODOS, '2-2794204'),
  L('Kids Fashion', 'Moda', 'N2', 'A', '208', 230, 140, [90, 400], 'Moda infantil', ['niños', 'ropa', 'bebé', 'infantil'], ['10:00', '21:00'], TODOS, '2-2794208'),
  L('Bella Piel', 'Accesorios', 'N2', 'A', '212', 80, 460, [60, 420], 'Cosmética y cuidado de la piel', ['maquillaje', 'crema', 'labial', 'protector solar', 'skincare'], ['10:00', '21:00'], TODOS, '7-3594212'),
  L('Perfumería Esencia', 'Accesorios', 'N2', 'A', '216', 230, 460, [120, 900], 'Perfumes importados', ['perfume', 'colonia', 'fragancia'], ['10:00', '21:30'], TODOS, '2-2794216'),
  L('Electro Hogar', 'Tecnología', 'N2', 'B', '220', 420, 140, [200, 3500], 'Electrodomésticos', ['licuadora', 'televisor', 'microondas', 'refrigerador', 'cafetera'], ['10:00', '21:00'], TODOS, '2-2794220'),
  L('Hogar Total', 'Hogar', 'N2', 'B', '224', 580, 140, [80, 1200], 'Muebles y organización', ['muebles', 'organizador', 'repisa', 'silla'], ['10:00', '20:30'], SIN_DOMINGO, '2-2794224'),
  L('Dulce Arte', 'Comida', 'N2', 'B', '230', 420, 460, [25, 220], 'Pastelería artesanal', ['torta', 'postre', 'cupcake', 'pastel', 'dulce'], ['09:00', '21:30'], TODOS, '7-2594230'),
  L('Relojería Tiempo', 'Accesorios', 'N2', 'B', '234', 580, 460, [150, 1800], 'Relojes y reparación', ['reloj', 'pila de reloj', 'correa'], ['10:00', '20:00'], SIN_DOMINGO, '2-2794234'),
  L('Gamer Zone', 'Entretenimiento', 'N2', 'C', '238', 750, 140, [80, 2200], 'Videojuegos y consolas', ['videojuegos', 'consola', 'control', 'playstation', 'nintendo'], ['11:00', '22:00'], TODOS, '7-8594238'),
  L('Musical Andes', 'Entretenimiento', 'N2', 'C', '242', 900, 140, [60, 1500], 'Instrumentos musicales', ['guitarra', 'charango', 'instrumentos', 'cuerdas', 'zampoña'], ['10:00', '20:00'], SIN_DOMINGO, '2-2794242'),
  L('Bolso & Co', 'Accesorios', 'N2', 'C', '246', 750, 460, [90, 600], 'Carteras y mochilas', ['mochila', 'cartera', 'billetera', 'maleta'], ['10:00', '21:00'], TODOS, '2-2794246'),
  L('Barber Club', 'Servicios', 'N2', 'C', '250', 900, 460, [40, 120], 'Barbería', ['barbería', 'corte', 'barba', 'peluquero'], ['10:00', '21:00'], SIN_LUNES, '7-9594250'),
  L('Mascotas Felices', 'Hogar', 'N2', 'B', '254', 500, 300, [40, 300], 'Accesorios y alimento para mascotas', ['mascotas', 'perro', 'gato', 'croquetas', 'collar'], ['10:00', '21:00'], TODOS, '2-2794254'),
  L('Fotostudio', 'Servicios', 'N2', 'C', '258', 830, 300, [30, 250], 'Fotos carnet e impresión', ['fotos', 'impresión', 'foto carnet', 'fotocopias'], ['09:30', '19:30'], SIN_DOMINGO, '2-2794258'),
  // Terrazas
  L('Panchita', 'Comida', 'T', 'P', 'T01', 70, 120, [18, 60], 'Salteñas y comida típica', ['salteña', 'almuerzo', 'api', 'pastel', 'comida típica'], ['08:00', '22:00'], TODOS, '7-1234501', '/uploads/locales/Panchita.jpeg', '/uploads/locales/Panchita.jpeg'),
  L('Guajojó', 'Comida', 'T', 'P', 'T02', 200, 120, [25, 75], 'Comida oriental boliviana', ['majadito', 'almuerzo', 'cuñapé', 'sonso', 'masaco'], ['11:00', '22:00'], TODOS, '7-1234502', '/uploads/locales/Guajojo.jpeg', '/uploads/locales/Guajojo.jpeg'),
  L('Napoli Pizzería', 'Comida', 'T', 'P', 'T03', 330, 120, [30, 140], 'Pizza a la piedra', ['pizza', 'lasaña', 'pasta', 'italiana'], ['11:00', '23:00'], TODOS, '7-1234503'),
  L('Sushi Kai', 'Comida', 'T', 'P', 'T04', 460, 120, [45, 160], 'Sushi y ramen', ['sushi', 'ramen', 'japonesa', 'makis'], ['12:00', '22:30'], TODOS, '7-1234504'),
  L('Pollos Copacabana', 'Comida', 'T', 'P', 'T05', 70, 480, [25, 90], 'Pollo frito y broaster', ['pollo', 'broaster', 'alitas', 'papas fritas'], ['10:30', '23:00'], TODOS, '7-1234505'),
  L('Burger House', 'Comida', 'T', 'P', 'T06', 200, 480, [30, 95], 'Hamburguesas', ['hamburguesa', 'papas fritas', 'malteada'], ['11:00', '23:00'], TODOS, '7-1234506'),
  L('Heladería Frío Frío', 'Comida', 'T', 'P', 'T07', 330, 480, [12, 45], 'Helados artesanales', ['helado', 'copa', 'postre', 'paleta'], ['10:00', '22:30'], TODOS, '7-1234507'),
  L('Jugos Tropicales', 'Comida', 'T', 'P', 'T08', 460, 480, [10, 35], 'Jugos y batidos', ['jugo', 'batido', 'licuado', 'smoothie', 'limonada'], ['08:00', '22:00'], TODOS, '7-1234508'),
  L('Cine Aranjuez', 'Entretenimiento', 'T', 'K', 'T10', 620, 160, [35, 160], 'Cine 2D y 3D', ['cine', 'película', 'pochoclo', 'pipocas', 'entradas'], ['13:00', '23:59'], TODOS, '2-2794310'),
  L('Bowling Strike', 'Entretenimiento', 'T', 'K', 'T12', 700, 470, [40, 200], 'Boliche y juegos', ['bowling', 'boliche', 'billar', 'juegos'], ['14:00', '23:59'], TODOS, '7-1234512'),
  L('Terraza Lounge', 'Comida', 'T', 'L', 'T20', 900, 200, [40, 220], 'Bar y comida de autor', ['bar', 'cena', 'cóctel', 'tragos', 'música en vivo'], ['12:00', '23:59'], TODOS, '7-1234520'),
  L('Café Tostado', 'Comida', 'T', 'L', 'T22', 900, 450, [15, 45], 'Café y sándwiches', ['café', 'sándwich', 'desayuno', 'té'], ['08:30', '21:00'], TODOS, '7-1234522'),
  // --- Locales Reales Paseo Aranjuez ---
  L("Cinnabon", "Comida", "N1", "A", "110", 100, 140, [20, 80], "Comida- postres-bebidas", ["cinnabon","comida","comida-","postres-bebidas"], ['10:00', '22:00'], TODOS, '7-0010000', "/uploads/locales/Cinnabon.jpeg", "/uploads/locales/Cinnabon.jpeg"),
  L("Bold", "Moda", "N1", "B", "111", 170, 200, [80, 500], "Ropa", ["bold","moda","ropa"], ['10:00', '22:00'], TODOS, '7-0010001', "/uploads/locales/Bold.jpeg", "/uploads/locales/Bold.jpeg"),
  L("Fairplay Kids", "Moda", "N1", "C", "112", 240, 260, [80, 500], "Ropa", ["fairplay kids","moda","ropa"], ['10:00', '22:00'], TODOS, '7-0010002', "/uploads/locales/kids.jpeg", "/uploads/locales/kids.jpeg"),
  L("Lili Pink", "Moda", "N1", "A", "113", 310, 320, [80, 500], "Ropa-mujer", ["lili pink","moda","ropa-mujer"], ['10:00', '22:00'], TODOS, '7-0010003', "/uploads/locales/LiliPink.jpeg", "/uploads/locales/LiliPink.jpeg"),
  L("Legend", "Moda", "N1", "B", "114", 380, 380, [80, 500], "Ropa", ["legend","moda","ropa"], ['10:00', '22:00'], TODOS, '7-0010004', "/uploads/locales/Legend.jpeg", "/uploads/locales/Legend1.jpeg"),
  L("TucTuc", "Moda", "N1", "C", "115", 450, 440, [80, 500], "Ropa de ni�os", ["tuctuc","moda","ropa","ni�os"], ['10:00', '22:00'], TODOS, '7-0010005', "/uploads/locales/tuctuc.jpeg", "/uploads/locales/tuctuc.jpeg"),
  L("Puma", "Moda", "N1", "A", "116", 520, 140, [80, 500], "Ropa", ["puma","moda","ropa"], ['10:00', '22:00'], TODOS, '7-0010006', "/uploads/locales/Puma.jpeg", "/uploads/locales/puma1.jpeg"),
  L("Opticas Pauker", "Moda", "N1", "B", "117", 590, 200, [80, 500], "Lentes", ["opticas pauker","moda","lentes"], ['10:00', '22:00'], TODOS, '7-0010007', "/uploads/locales/Opticas_Pauker.jpeg", "/uploads/locales/Opticas_Pauker.jpeg"),
  L("Joyerias Imperio", "Moda", "N1", "C", "118", 660, 260, [80, 500], "Joyas", ["joyerias imperio","moda","joyas"], ['10:00', '22:00'], TODOS, '7-0010008', "/uploads/locales/joyeriaImperio.jpeg", "/uploads/locales/Joyerias.jpeg"),
  L("Banco Ganadero", "Servicios", "N1", "A", "119", 730, 320, [80, 500], "Cajero automatico", ["banco ganadero","servicios","cajero","automatico"], ['10:00', '22:00'], TODOS, '7-0010009', "/uploads/locales/bancoGanadero.jpeg", "/uploads/locales/bancoGanadero.jpeg"),
  L("Mercantil Santa Cruz", "Servicios", "N1", "B", "120", 800, 380, [80, 500], "Cajero automatico", ["mercantil santa cruz","servicios","cajero","automatico"], ['10:00', '22:00'], TODOS, '7-0010010', "/uploads/locales/MercantilSantaCruz.jpeg", "/uploads/locales/MercantilSantaCruz.jpeg"),
  L("BancoSol", "Servicios", "N1", "C", "121", 870, 440, [80, 500], "Cajero automatico", ["bancosol","servicios","cajero","automatico"], ['10:00', '22:00'], TODOS, '7-0010011', "/uploads/locales/BancoSol.jpeg", "/uploads/locales/BancoSol.jpeg"),
  L("Face Phone", "Tecnología", "N1", "A", "122", 140, 140, [80, 500], "Fundas de celular", ["face phone","tecnología","fundas","celular"], ['10:00', '22:00'], TODOS, '7-0010012', "/uploads/locales/FacePhone.jpeg", "/uploads/locales/FacePhone.jpeg"),
  L("ECLAT", "Accesorios", "N1", "B", "123", 210, 200, [80, 500], "Perfumes arabes", ["eclat","accesorios","perfumes","arabes"], ['10:00', '22:00'], TODOS, '7-0010013', "/uploads/locales/Eclat.jpeg", "/uploads/locales/Eclat.jpeg"),
  L("Cosbelle", "Accesorios", "N1", "C", "124", 280, 260, [80, 500], "Perfumes y cosmeticos", ["cosbelle","accesorios","perfumes","cosmeticos"], ['10:00', '22:00'], TODOS, '7-0010014', "/uploads/locales/Cosbelle.jpeg", "/uploads/locales/Cosbelle.jpeg"),
  L("Kosi", "Moda", "N1", "A", "125", 350, 320, [80, 500], "Ropa de mujer", ["kosi","moda","ropa","mujer"], ['10:00', '22:00'], TODOS, '7-0010015', "/uploads/locales/Kosi.jpeg", "/uploads/locales/Kosi.jpeg"),
  L("Status", "Moda", "N1", "B", "126", 420, 380, [80, 500], "Ropa de mujer elegante", ["status","moda","ropa","mujer","elegante"], ['10:00', '22:00'], TODOS, '7-0010016', "/uploads/locales/Status.jpeg", "/uploads/locales/Status.jpeg"),
  L("Burbank", "Moda", "N1", "C", "127", 490, 440, [80, 500], "Ropa juvenil", ["burbank","moda","ropa","juvenil"], ['10:00', '22:00'], TODOS, '7-0010017', null, null),
  L("Moda Online", "Moda", "N1", "A", "128", 560, 140, [80, 500], "Ropa de mujer", ["moda online","moda","ropa","mujer"], ['10:00', '22:00'], TODOS, '7-0010018', "/uploads/locales/ModaOnline.jpeg", "/uploads/locales/ModaOnline.jpeg"),
  L("Impulse", "Moda", "N1", "B", "129", 630, 200, [80, 500], "tenis y ropa", ["impulse","moda","tenis","ropa"], ['10:00', '22:00'], TODOS, '7-0010019', null, null),
  L("Amore", "Moda", "N1", "C", "130", 700, 260, [80, 500], "Carteras, cinturones de cuero", ["amore","moda","carteras","cinturones","cuero"], ['10:00', '22:00'], TODOS, '7-0010020', "/uploads/locales/Amore.jpeg", "/uploads/locales/Amore.jpeg"),
  L("Hermassi", "Moda", "N1", "A", "131", 770, 320, [80, 500], "Ropa Bolsos", ["hermassi","moda","ropa","bolsos"], ['10:00', '22:00'], TODOS, '7-0010021', "/uploads/locales/Hermass.jpeg", "/uploads/locales/Hermass.jpeg"),
  L("Manhattan", "Moda", "N1", "B", "132", 840, 380, [80, 500], "Camisas, Pantalones varon", ["manhattan","moda","camisas","pantalones","varon"], ['10:00', '22:00'], TODOS, '7-0010022', "/uploads/locales/Manhattan.jpeg", "/uploads/locales/Manhattan.jpeg"),
  L("Tuctoys", "Regalos", "N1", "C", "133", 110, 440, [80, 500], "Juguetes", ["tuctoys","regalos","juguetes"], ['10:00', '22:00'], TODOS, '7-0010023', "/uploads/locales/TucToys.jpeg", "/uploads/locales/TucToys.jpeg"),
  L("EuroStyle", "Moda", "N1", "A", "134", 180, 140, [80, 500], "Ropa", ["eurostyle","moda","ropa"], ['10:00', '22:00'], TODOS, '7-0010024', "/uploads/locales/Eurostyle.jpeg", "/uploads/locales/Eurostyle.jpeg"),
  L("Top Coleccion", "Moda", "N2", "B", "235", 250, 200, [80, 500], "Tienda de ropa", ["top coleccion","moda","tienda","ropa"], ['10:00', '22:00'], TODOS, '7-0010025', null, null),
  L("Joyas Diego", "Moda", "N2", "C", "236", 320, 260, [80, 500], "Venta de joyas", ["joyas diego","moda","venta","joyas"], ['10:00', '22:00'], TODOS, '7-0010026', null, null),
  L("Fossil", "Moda", "N2", "A", "237", 390, 320, [80, 500], "Venta de mochilas, carteras", ["fossil","moda","venta","mochilas","carteras"], ['10:00', '22:00'], TODOS, '7-0010027', null, null),
  L("Quiro", "Servicios", "N2", "B", "238", 460, 380, [80, 500], "Negocio de celigrafia", ["quiro","servicios","negocio","celigrafia"], ['10:00', '22:00'], TODOS, '7-0010028', null, null),
  L("Bolivia Fitness", "Servicios", "N2", "C", "239", 530, 440, [80, 500], "de suplementos me", ["bolivia fitness","servicios","suplementos"], ['10:00', '22:00'], TODOS, '7-0010029', null, null),
  L("Crocs", "Moda", "N2", "A", "210", 600, 140, [80, 500], "Venta de cross", ["crocs","moda","venta","cross"], ['10:00', '22:00'], TODOS, '7-0010030', null, null),
  L("Tigo", "Tecnología", "N2", "B", "211", 670, 200, [80, 500], "Telecomunicaciones", ["tigo","tecnología","telecomunicaciones"], ['10:00', '22:00'], TODOS, '7-0010031', null, null),
  L("Lamelin", "Accesorios", "N2", "C", "212", 740, 260, [80, 500], "Skincoreano", ["lamelin","accesorios","skincoreano"], ['10:00', '22:00'], TODOS, '7-0010032', null, null),
  L("Nailon Express", "Moda", "N2", "A", "213", 810, 320, [80, 500], "U�as", ["nailon express","moda","u�as"], ['10:00', '22:00'], TODOS, '7-0010033', null, null),
  L("Apple Land", "Tecnología", "N2", "B", "214", 880, 380, [80, 500], "Apple case", ["apple land","tecnología","apple","case"], ['10:00', '22:00'], TODOS, '7-0010034', null, null),
  L("Alto Cavaliere", "Moda", "N2", "C", "215", 150, 440, [80, 500], "Venta de ropa de cuero", ["alto cavaliere","moda","venta","ropa","cuero"], ['10:00', '22:00'], TODOS, '7-0010035', null, null),
  L("Gool Store", "Moda", "N2", "A", "216", 220, 140, [80, 500], "Venta De medias", ["gool store","moda","venta","medias"], ['10:00', '22:00'], TODOS, '7-0010036', null, null),
  L("Totto", "Moda", "N2", "B", "217", 290, 200, [80, 500], "Mochilas, poleras y accesorios", ["totto","moda","mochilas","poleras","accesorios"], ['10:00', '22:00'], TODOS, '7-0010037', null, null),
  L("Coton Viu", "Moda", "N2", "C", "218", 360, 260, [80, 500], "Venta de ropa para damas", ["coton viu","moda","venta","ropa","para","damas"], ['10:00', '22:00'], TODOS, '7-0010038', null, null),
  L("Baby Corp", "Moda", "N2", "A", "219", 430, 320, [80, 500], "Venta de accesorios para bebes", ["baby corp","moda","venta","accesorios","para","bebes"], ['10:00', '22:00'], TODOS, '7-0010039', null, null),
  L("Deaguayo", "Moda", "N2", "B", "220", 500, 380, [80, 500], "Carteras", ["deaguayo","moda","carteras"], ['10:00', '22:00'], TODOS, '7-0010040', null, null),
  L("Mision Simi", "Moda", "N2", "C", "221", 570, 440, [80, 500], "Venta de ropa para damas", ["mision simi","moda","venta","ropa","para","damas"], ['10:00', '22:00'], TODOS, '7-0010041', null, null),
  L("Avanza Rever", "Accesorios", "N2", "A", "222", 640, 140, [80, 500], "Venta de maquillaje", ["avanza rever","accesorios","venta","maquillaje"], ['10:00', '22:00'], TODOS, '7-0010042', null, null),
  L("Almacen de Pizzas", "Comida", "T", "P", "T23", 710, 200, [20, 80], "Venta de Pizzas", ["almacen de pizzas","comida","venta","pizzas"], ['10:00', '22:00'], TODOS, '7-0010043', "/uploads/locales/AlmacenDePizzas.jpeg", "/uploads/locales/AlmacenDePizzas.jpeg"),
  L("Flavor Burst", "Comida", "T", "P", "T24", 780, 260, [20, 80], "Helado", ["flavor burst","comida","helado"], ['10:00', '22:00'], TODOS, '7-0010044', "/uploads/locales/FlavorBurst.jpeg", "/uploads/locales/FlavorBurst.jpeg"),
  L("Orah", "Accesorios", "T", "P", "T25", 850, 320, [80, 500], "Javones artesanales", ["orah","accesorios","javones","artesanales"], ['10:00', '22:00'], TODOS, '7-0010045', "/uploads/locales/Orah.jpeg", "/uploads/locales/Orah.jpeg"),
  L("Acai Golden", "Comida", "T", "P", "T26", 120, 380, [20, 80], "Variedad de helados de acai", ["acai golden","comida","variedad","helados","acai"], ['10:00', '22:00'], TODOS, '7-0010046', "/uploads/locales/AcaiGolden.jpeg", "/uploads/locales/AcaiGolden.jpeg"),
  L("Parrilleros", "Comida", "T", "P", "T27", 190, 440, [20, 80], "Almuerzo completo con especialidad en platos a la parrilla", ["parrilleros","comida","almuerzo","completo","con","especialidad","platos"], ['10:00', '22:00'], TODOS, '7-0010047', "/uploads/locales/Parrilleros.jpeg", "/uploads/locales/Parrilleros.jpeg"),
  L("Chotto Matte", "Comida", "T", "P", "T28", 260, 140, [20, 80], "Restaurante de ramens", ["chotto matte","comida","restaurante","ramens"], ['10:00', '22:00'], TODOS, '7-0010048', "/uploads/locales/ChottoMatte.jpeg", "/uploads/locales/ChottoMatte.jpeg"),
  L("Hoy Hay Cafe", "Comida", "T", "P", "T29", 330, 200, [20, 80], "Venta de Caf�", ["hoy hay cafe","comida","venta","caf�"], ['10:00', '22:00'], TODOS, '7-0010049', "/uploads/locales/HoyHay.jpeg", "/uploads/locales/HoyHay.jpeg"),
  L("La Quilquina", "Comida", "T", "P", "T30", 400, 260, [20, 80], "Venta de comida Boliviana", ["la quilquina","comida","venta","boliviana"], ['10:00', '22:00'], TODOS, '7-0010050', "/uploads/locales/LaQuilquina.jpeg", "/uploads/locales/LaQuilquina.jpeg"),
  L("La Sangucheria", "Comida", "T", "P", "T31", 470, 320, [20, 80], "Variedad de Sandwich y hamburguesas", ["la sangucheria","comida","variedad","sandwich","hamburguesas"], ['10:00', '22:00'], TODOS, '7-0010051', "/uploads/locales/LaSangucheria.jpeg", "/uploads/locales/LaSangucheria.jpeg"),
  L("Waffle King", "Comida", "T", "P", "T32", 540, 380, [20, 80], "Waffles, postres", ["waffle king","comida","waffles","postres"], ['10:00', '22:00'], TODOS, '7-0010052', "/uploads/locales/WaffleKing.jpeg", "/uploads/locales/WaffleKing.jpeg"),
  L("Deli Stanbul", "Comida", "T", "P", "T34", 680, 140, [20, 80], "Kebab Turco", ["deli stanbul","comida","kebab","turco"], ['10:00', '22:00'], TODOS, '7-0010054', "/uploads/locales/DeliStanbul.jpeg", "/uploads/locales/DeliStanbul.jpeg"),
  L("Solo Pasta", "Comida", "T", "P", "T36", 820, 260, [20, 80], "Pasta y lasa�a", ["solo pasta","comida","pasta","lasa�a"], ['10:00', '22:00'], TODOS, '7-0010056', "/uploads/locales/SoloPastas.jpeg", "/uploads/locales/SoloPastas.jpeg"),
  L("Pawitos", "Comida", "T", "P", "T37", 890, 320, [20, 80], "Refrescos y bobas", ["pawitos","comida","refrescos","bobas"], ['10:00', '22:00'], TODOS, '7-0010057', "/uploads/locales/Pawitos.jpeg", "/uploads/locales/Pawitos.jpeg"),
  L("Sky Games", "Entretenimiento", "T", "K", "T38", 160, 380, [80, 500], "servicio de entretenimiento", ["sky games","entretenimiento","servicio"], ['10:00', '22:00'], TODOS, '7-0010058', "/uploads/locales/SkyGames.jpeg", "/uploads/locales/SkyGames.jpeg"),
  L("Gang Nam", "Comida", "T", "P", "T39", 230, 440, [20, 80], "Comida asiatica", ["gang nam","comida","asiatica"], ['10:00', '22:00'], TODOS, '7-0010059', null, null),
  L("Pata Negra", "Comida", "T", "P", "T10", 300, 140, [20, 80], "Comida espa�ola", ["pata negra","comida","espa�ola"], ['10:00', '22:00'], TODOS, '7-0010060', "/uploads/locales/Patanegra.jpeg", "/uploads/locales/Patanegra.jpeg"),
  L("Sabor Chipotle", "Comida", "T", "P", "T11", 370, 200, [20, 80], "Comida Mexicana", ["sabor chipotle","comida","mexicana"], ['10:00', '22:00'], TODOS, '7-0010061', null, null),
  L("Cayenna", "Comida", "T", "P", "T12", 440, 260, [20, 80], "Comida Boliviana", ["cayenna","comida","boliviana"], ['10:00', '22:00'], TODOS, '7-0010062', null, null),
  L("Churros Calientes", "Comida", "T", "L", "T13", 510, 320, [20, 80], "Cocteleria", ["churros calientes","comida","cocteleria"], ['10:00', '22:00'], TODOS, '7-0010063', null, null),
  L("Rissis", "Comida", "T", "L", "T14", 580, 380, [20, 80], "Bar", ["rissis","comida","bar"], ['10:00', '22:00'], TODOS, '7-0010064', null, null),
  L("Mona Lisa", "Comida", "T", "L", "T15", 650, 440, [20, 80], "Bar", ["mona lisa","comida","bar"], ['10:00', '22:00'], TODOS, '7-0010065', null, null),
];

/** [nombre, precio Bs, stock, descripción, minutos de preparación (solo comida)] */
type P = [string, number, number, string, number?];

export const PRODUCTOS: Record<string, P[]> = {
  'Café Alameda': [
    ['Capuchino grande', 24, 80, 'Doble shot, leche texturizada', 5],
    ['Café americano', 16, 100, 'Grano de los Yungas', 3],
    ['Latte de vainilla', 26, 60, 'Con jarabe artesanal', 5],
    ['Chocolate caliente', 22, 60, 'Cacao del Alto Beni', 5],
    ['Torta de zanahoria (porción)', 25, 20, 'Con frosting de queso', 2],
    ['Croissant de jamón y queso', 22, 30, 'Horneado del día', 6],
    ['Desayuno Alameda', 45, 25, 'Café, jugo, huevos y pan', 12],
    ['Cheesecake de frutos rojos', 28, 18, 'Porción individual', 2],
  ],
  'Farmacia Aranjuez': [
    ['Paracetamol 500 mg (10 tabletas)', 8, 200, 'Analgésico y antipirético'],
    ['Ibuprofeno 400 mg (10 tabletas)', 12, 150, 'Antiinflamatorio'],
    ['Alcohol en gel 250 ml', 18, 120, 'Con aloe vera'],
    ['Protector solar FPS 50', 95, 40, 'Ideal para la altura'],
    ['Suero oral', 10, 90, 'Rehidratante'],
    ['Termómetro digital', 45, 30, 'Lectura en 10 segundos'],
    ['Barbijo KN95 (5 unidades)', 25, 80, 'Protección respiratoria'],
    ['Vitamina C efervescente', 38, 60, 'Tubo de 10'],
  ],
  'Moda Andina': [
    ['Chompa de alpaca', 480, 10, 'Tejido artesanal'],
    ['Chalina de alpaca', 190, 18, 'Colores tierra'],
    ['Poncho moderno', 620, 6, 'Diseño contemporáneo'],
    ['Gorro tejido', 85, 25, 'Con forro polar'],
    ['Guantes de alpaca', 95, 20, 'Suaves y abrigados'],
    ['Cardigan de lana de oveja', 350, 8, 'Hecho en El Alto'],
  ],
  'Urban Style': [
    ['Jeans slim azul', 260, 30, 'Tela elástica'],
    ['Polera oversize', 120, 45, 'Algodón peinado'],
    ['Zapatillas urbanas blancas', 390, 15, 'Suela de goma'],
    ['Gorra plana', 95, 30, 'Ajustable'],
    ['Chamarra rompevientos', 320, 12, 'Impermeable'],
    ['Buzo con capucha', 220, 20, 'Afelpado por dentro'],
  ],
  'Zapatería Illimani': [
    ['Zapatos de cuero formales', 520, 12, 'Cuero nacional'],
    ['Botas de cuero', 680, 8, 'Para el frío paceño'],
    ['Mocasines casuales', 380, 14, 'Livianos'],
    ['Sandalias de mujer', 240, 16, 'Taco bajo'],
    ['Pantuflas', 110, 20, 'Abrigadas'],
  ],
  'Joyería Del Sol': [
    ['Anillo de plata 950', 280, 15, 'Diseño tiwanakota'],
    ['Aretes de plata con piedra', 220, 20, 'Piedra sodalita'],
    ['Collar de oro 18k', 2400, 3, 'Cadena fina'],
    ['Pulsera de plata', 260, 12, 'Eslabones'],
    ['Limpieza de joyas', 30, 99, 'Servicio en el momento'],
  ],
  'Óptica Visión': [
    ['Examen visual computarizado', 60, 99, 'Sin cita previa'],
    ['Lentes de sol polarizados', 350, 15, 'Protección UV400'],
    ['Montura de acetato', 420, 20, 'Varios colores'],
    ['Lentes de contacto mensuales', 180, 25, 'Caja de 6'],
    ['Líquido para lentes 360 ml', 75, 30, 'Multipropósito'],
  ],
  'Peluquería Estilo': [
    ['Corte de dama', 80, 99, 'Incluye lavado'],
    ['Corte de caballero', 50, 99, 'Con lavado'],
    ['Tinte completo', 250, 99, 'Productos profesionales'],
    ['Manicure', 60, 99, 'Esmaltado tradicional'],
    ['Peinado para evento', 150, 99, 'Con reserva'],
  ],
  TecnoCentro: [
    ['Audífonos bluetooth SoundGo', 189, 25, 'Inalámbricos, 20 h de batería'],
    ['Audífonos bluetooth Pro ANC', 459, 10, 'Cancelación activa de ruido'],
    ['Cargador rápido USB-C 30 W', 120, 40, 'Compatible con celulares y tablets'],
    ['Mouse inalámbrico', 95, 30, 'Silencioso, 1600 DPI'],
    ['Parlante portátil', 260, 15, 'Resistente al agua'],
    ['Memoria USB 128 GB', 85, 50, 'USB 3.2'],
    ['Laptop 15" Core i5', 5400, 4, '16 GB de RAM, SSD de 512 GB'],
    ['Teclado mecánico', 340, 12, 'Switches rojos'],
    ['Smartwatch Fit', 420, 9, 'Ritmo cardíaco y GPS'],
  ],
  'Celular Express': [
    ['Audífonos bluetooth Basic', 165, 20, 'Con estuche de carga'],
    ['Funda antigolpes', 60, 80, 'Para modelos populares'],
    ['Vidrio templado', 35, 120, 'Instalación gratis'],
    ['Power bank 10 000 mAh', 150, 25, 'Carga rápida'],
    ['Cable USB-C trenzado', 45, 60, '1,5 m'],
    ['Cambio de pantalla (gama media)', 380, 99, 'Listo en 2 horas'],
    ['Celular Galaxy A35', 2350, 6, '128 GB'],
  ],
  'Regalos Sorpresa': [
    ['Peluche llama', 75, 30, '30 cm'],
    ['Caja de regalo gourmet', 210, 10, 'Chocolates y café boliviano'],
    ['Taza personalizada', 55, 40, 'Lista en 24 h'],
    ['Globo metalizado', 30, 50, 'Con helio'],
    ['Tarjeta de felicitación', 15, 100, 'Varios diseños'],
    ['Ramo de rosas', 120, 12, 'Doce rosas'],
  ],
  'Casa & Deco': [
    ['Juego de 4 cojines', 260, 8, 'Funda lavable'],
    ['Vajilla 16 piezas', 390, 6, 'Cerámica blanca'],
    ['Vela aromática', 45, 40, 'Lavanda'],
    ['Lámpara de mesa', 180, 12, 'Luz cálida'],
    ['Manta tejida', 210, 10, 'Para el sofá'],
  ],
  'Librería Cervantes': [
    ['Novela «Raza de bronce»', 75, 15, 'Alcides Arguedas'],
    ['Cuaderno universitario 100 hojas', 18, 150, 'Tapa dura'],
    ['Agenda 2027', 65, 40, 'Semana a la vista'],
    ['Set de lápices de colores', 48, 50, '24 colores'],
    ['Libro infantil ilustrado', 55, 25, 'Cuentos andinos'],
    ['Diccionario español-inglés', 90, 12, 'Edición escolar'],
  ],
  'Juguetería Mundo Mágico': [
    ['Set de bloques 500 piezas', 260, 10, 'Desde 6 años'],
    ['Muñeca articulada', 140, 18, 'Con accesorios'],
    ['Juego de mesa «Cacho»', 70, 25, 'Clásico boliviano'],
    ['Rompecabezas 1000 piezas', 95, 14, 'Paisaje del Illimani'],
    ['Auto a control remoto', 230, 9, 'Recargable'],
  ],
  'Sport Center': [
    ['Zapatillas running', 520, 12, 'Amortiguación media'],
    ['Pelota de fútbol N.º 5', 140, 20, 'Cosida a máquina'],
    ['Polera dry-fit', 110, 30, 'Secado rápido'],
    ['Botella deportiva 750 ml', 55, 40, 'Libre de BPA'],
    ['Mochila deportiva', 230, 10, '25 litros'],
    ['Camiseta de The Strongest', 280, 15, 'Temporada actual'],
    ['Camiseta de Bolívar', 280, 15, 'Temporada actual'],
  ],
  'Kids Fashion': [
    ['Conjunto de bebé', 120, 20, 'Algodón suave'],
    ['Chamarra infantil', 210, 14, 'Talla 4 a 10'],
    ['Pijama de niño', 95, 25, 'Estampado'],
    ['Zapatillas de niño con luces', 180, 12, 'Talla 24 a 34'],
  ],
  'Bella Piel': [
    ['Protector solar facial FPS 50', 120, 30, 'Toque seco'],
    ['Labial mate', 65, 50, 'Larga duración'],
    ['Crema hidratante', 90, 35, 'Con ácido hialurónico'],
    ['Paleta de sombras', 140, 15, '12 tonos'],
    ['Agua micelar 400 ml', 75, 25, 'Desmaquillante'],
  ],
  'Perfumería Esencia': [
    ['Perfume floral 100 ml', 650, 8, 'Eau de parfum'],
    ['Colonia fresca 100 ml', 420, 10, 'Para hombre'],
    ['Body splash', 120, 30, 'Varios aromas'],
    ['Set de regalo de perfume', 780, 6, 'Perfume y crema'],
  ],
  'Electro Hogar': [
    ['Licuadora 1,5 L', 380, 12, '600 W'],
    ['Microondas 20 L', 790, 8, 'Con grill'],
    ['Televisor 50" 4K', 3400, 5, 'Smart TV'],
    ['Cafetera de goteo', 260, 10, '12 tazas'],
    ['Plancha a vapor', 190, 14, 'Antiadherente'],
    ['Estufa eléctrica', 340, 9, 'Ideal para el invierno'],
  ],
  'Hogar Total': [
    ['Organizador de closet', 160, 15, '6 compartimentos'],
    ['Repisa flotante', 120, 20, '60 cm'],
    ['Silla de escritorio', 680, 6, 'Ergonómica'],
    ['Zapatera de 4 niveles', 210, 9, 'Metálica'],
  ],
  'Dulce Arte': [
    ['Torta de chocolate (8 porciones)', 160, 8, 'Bizcocho húmedo con ganache', 15],
    ['Caja de 6 cupcakes', 72, 15, 'Sabores surtidos', 10],
    ['Cheesecake de maracuyá', 28, 20, 'Porción individual', 3],
    ['Alfajores (docena)', 48, 25, 'Rellenos de dulce de leche', 2],
    ['Torta tres leches', 140, 6, '8 porciones', 15],
    ['Brownie con helado', 32, 20, 'Tibio', 6],
  ],
  'Relojería Tiempo': [
    ['Reloj análogo clásico', 450, 10, 'Correa de cuero'],
    ['Reloj deportivo digital', 280, 12, 'Resistente al agua'],
    ['Cambio de pila', 25, 99, 'En el momento'],
    ['Correa de cuero', 90, 20, 'Varias medidas'],
  ],
  'Gamer Zone': [
    ['Control inalámbrico', 520, 10, 'Compatible con PC y consola'],
    ['Juego de fútbol 2027', 480, 12, 'Edición estándar'],
    ['Audífonos gamer', 310, 14, 'Micrófono desmontable'],
    ['Tarjeta de regalo 100 Bs', 100, 50, 'Para tiendas digitales'],
    ['Consola portátil', 2900, 4, 'Con dos juegos'],
  ],
  'Musical Andes': [
    ['Charango de madera', 850, 5, 'Hecho en Potosí'],
    ['Guitarra acústica', 1100, 6, 'Tapa de cedro'],
    ['Zampoña', 120, 15, 'Afinada en Sol'],
    ['Juego de cuerdas', 60, 40, 'Para guitarra'],
    ['Ukulele', 380, 8, 'Con funda'],
  ],
  'Bolso & Co': [
    ['Mochila urbana', 280, 15, 'Porta laptop'],
    ['Cartera de cuero', 420, 10, 'Tres compartimentos'],
    ['Billetera', 120, 25, 'Cuero sintético'],
    ['Maleta de cabina', 650, 7, 'Ruedas 360°'],
  ],
  'Barber Club': [
    ['Corte clásico', 50, 99, 'Con lavado'],
    ['Perfilado de barba', 35, 99, 'Con toalla caliente'],
    ['Corte y barba', 75, 99, 'Combo completo'],
    ['Cera para cabello', 60, 30, 'Fijación media'],
  ],
  'Mascotas Felices': [
    ['Alimento para perro 3 kg', 140, 20, 'Adulto, raza mediana'],
    ['Alimento para gato 1,5 kg', 95, 20, 'Sabor pescado'],
    ['Collar con placa', 55, 30, 'Grabado gratis'],
    ['Cama para mascota', 210, 8, 'Lavable'],
    ['Juguete mordedor', 35, 40, 'Caucho resistente'],
  ],
  Fotostudio: [
    ['Fotos carnet (6 unidades)', 25, 99, 'Listas en 10 minutos'],
    ['Impresión de fotos 10x15', 3, 999, 'Por unidad'],
    ['Fotocopia', 1, 999, 'Blanco y negro'],
    ['Cuadro de foto 20x30', 85, 20, 'Con marco'],
  ],
  Panchita: [
    ['Salteña de carne', 9, 200, 'Jugosa, recién horneada', 3],
    ['Salteña de pollo', 9, 200, 'Recién horneada', 3],
    ['Salteñas de carne (media docena)', 52, 40, 'Jugosas, recién horneadas', 5],
    ['Salteñas de pollo (media docena)', 52, 40, 'Recién horneadas', 5],
    ['Api con pastel', 18, 30, 'Para dos', 8],
    ['Plato paceño', 45, 15, 'Choclo, haba, papa y queso frito', 15],
    ['Sopa de maní', 25, 20, 'Con papas fritas', 10],
  ],
  'Guajojó': [
    ['Majadito de charque', 42, 25, 'Con huevo y plátano frito', 15],
    ['Cuñapé (3 unidades)', 15, 60, 'Recién salidos del horno', 5],
    ['Sonso de yuca', 20, 30, 'Con queso', 10],
    ['Masaco de plátano', 30, 20, 'Con charque', 12],
    ['Pique macho', 58, 20, 'Para compartir', 18],
    ['Somó', 12, 40, 'Bebida de maíz', 2],
  ],
  'Napoli Pizzería': [
    ['Pizza familiar margarita', 95, 30, 'A la piedra, 8 porciones', 20],
    ['Pizza familiar pepperoni', 115, 30, 'A la piedra, 8 porciones', 20],
    ['Pizza familiar napolitana', 110, 25, 'Tomate, ajo y orégano', 20],
    ['Lasaña', 58, 20, 'De carne', 15],
    ['Combo pizza personal + gaseosa', 45, 40, 'Para uno', 12],
    ['Pan de ajo', 18, 40, '6 piezas', 8],
  ],
  'Sushi Kai': [
    ['Roll California (10 piezas)', 65, 25, 'Cangrejo, palta y pepino', 15],
    ['Ramen de cerdo', 72, 20, 'Caldo de 12 horas', 18],
    ['Gyozas (6 unidades)', 38, 30, 'Al vapor o fritas', 12],
    ['Combo sushi para dos', 140, 12, '30 piezas surtidas', 25],
    ['Té verde', 15, 50, 'Caliente o frío', 2],
  ],
  'Pollos Copacabana': [
    ['Cuarto de pollo broaster', 38, 50, 'Con papas y arroz', 10],
    ['Medio pollo broaster', 68, 30, 'Con papas y ensalada', 12],
    ['Alitas BBQ (8 unidades)', 48, 30, 'Salsa de la casa', 14],
    ['Pollo entero familiar', 125, 15, 'Para 4 personas', 18],
    ['Porción de papas fritas', 15, 60, 'Crocantes', 6],
  ],
  'Burger House': [
    ['Hamburguesa clásica', 38, 40, 'Carne de res, queso y tomate', 12],
    ['Hamburguesa doble con tocino', 58, 30, 'Doble carne', 14],
    ['Hamburguesa de pollo crispy', 42, 30, 'Con mayonesa de ajo', 12],
    ['Combo clásico', 55, 40, 'Hamburguesa, papas y gaseosa', 13],
    ['Malteada de chocolate', 25, 30, '500 ml', 5],
    ['Hamburguesa vegetariana', 40, 15, 'De quinua', 12],
  ],
  'Heladería Frío Frío': [
    ['Cono de dos bolas', 18, 99, 'Sabores artesanales', 2],
    ['Copa de helado con frutas', 32, 50, 'Frutilla y durazno', 5],
    ['Paleta de canela', 8, 99, 'Receta paceña', 1],
    ['Helado de 1 litro', 55, 25, 'Para llevar', 3],
    ['Banana split', 35, 30, 'Tres sabores', 6],
  ],
  'Jugos Tropicales': [
    ['Jugo de naranja 500 ml', 15, 99, 'Recién exprimido', 3],
    ['Batido de frutilla', 20, 99, 'Con leche', 4],
    ['Smoothie verde', 25, 60, 'Espinaca, piña y manzana', 5],
    ['Limonada de coco', 18, 80, 'Refrescante', 4],
    ['Jugo de papaya', 15, 99, 'Con o sin leche', 3],
  ],
  'Cine Aranjuez': [
    ['Entrada 2D', 40, 300, 'Cualquier función'],
    ['Entrada 3D', 55, 200, 'Lentes incluidos'],
    ['Combo pipocas grandes + 2 gaseosas', 60, 150, 'Para compartir', 3],
    ['Nachos con queso', 30, 80, 'Con jalapeños', 3],
  ],
  'Bowling Strike': [
    ['Línea de bowling (1 hora)', 120, 99, 'Hasta 6 jugadores'],
    ['Mesa de billar (1 hora)', 60, 99, 'Con tacos'],
    ['Tarjeta de juegos 50 Bs', 50, 99, 'Para máquinas arcade'],
    ['Combo cumpleaños', 650, 10, '2 horas, comida y bebidas'],
  ],
  'Terraza Lounge': [
    ['Tabla de picadas', 120, 15, 'Quesos y embutidos', 15],
    ['Hamburguesa gourmet', 75, 20, 'Pan brioche', 18],
    ['Cóctel de chuflay', 40, 50, 'Singani y ginger', 4],
    ['Lomo a la plancha', 98, 15, 'Con papas rústicas', 22],
    ['Limonada de menta', 22, 40, 'Sin alcohol', 4],
  ],
  'Café Tostado': [
    ['Espresso doble', 14, 99, 'Grano tostado en casa', 2],
    ['Sándwich de pollo', 32, 30, 'Pan ciabatta', 7],
    ['Sándwich de palta y queso', 30, 30, 'Vegetariano', 7],
    ['Té de coca', 10, 99, 'Ideal para la altura', 3],
    ['Muffin de arándanos', 16, 40, 'Horneado del día', 1],
  ],
};

/**
 * Servicios del Paseo: lugares a los que se puede llegar (baños, cajeros automáticos…) y
 * datos que Jarvis usa para responder preguntas poco comunes (wifi, mascotas, objetos perdidos).
 * Coordenadas junto al pasillo, sin pisar locales.
 */
export const SERVICIOS: { tipo: string; nombre: string; descripcion: string; piso: 'N1' | 'N2' | 'T'; x: number; y: number; horario?: string; claves: string[] }[] = [
  { tipo: 'bano', nombre: 'el baño del Nivel 1 oeste', descripcion: 'Baños de damas, varones y familiar, con cambiador de bebé.', piso: 'N1', x: 330, y: 230, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'servicio higienico', 'wc', 'cambiador'] },
  { tipo: 'bano', nombre: 'el baño del Nivel 1 este', descripcion: 'Baños de damas y varones, y baño accesible.', piso: 'N1', x: 660, y: 370, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'bano', nombre: 'el baño del Nivel 2', descripcion: 'Baños de damas, varones y familiar.', piso: 'N2', x: 340, y: 370, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'bano', nombre: 'el baño de las Terrazas', descripcion: 'Baños junto al patio de comidas, con lavamanos para niños.', piso: 'T', x: 560, y: 360, claves: ['baño', 'baños', 'bano', 'banos', 'sanitario', 'wc'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático del Banco Unión', descripcion: 'Retiros en bolivianos y dólares, las 24 horas dentro del horario del Paseo.', piso: 'N1', x: 40, y: 240, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'retirar dinero', 'banco', 'efectivo'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático del BNB', descripcion: 'Acepta tarjetas Visa y Mastercard de cualquier banco.', piso: 'N1', x: 960, y: 240, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'banco', 'efectivo'] },
  { tipo: 'cajero_automatico', nombre: 'el cajero automático de las Terrazas', descripcion: 'Del Banco Mercantil Santa Cruz.', piso: 'T', x: 40, y: 300, claves: ['cajero automatico', 'cajero', 'atm', 'sacar plata', 'sacar dinero', 'banco', 'efectivo'] },
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
export const EVENTOS_RECURRENTES: { titulo: string; tipo: string; descripcion: string; dias: number[]; desde: number; hasta: number; local?: string; zona: string; puntos: number; precio?: number; cupos?: number }[] = [
  { titulo: 'Música en vivo en la Terraza', tipo: 'concierto', descripcion: 'Bandas paceñas de rock y jazz, entrada libre.', dias: [4, 5, 6], desde: 19.5, hasta: 22.5, local: 'Terraza Lounge', zona: 'T-L', puntos: 30 },
  { titulo: 'Cuentacuentos andinos', tipo: 'infantil', descripcion: 'Leyendas bolivianas para niños de 4 a 9 años.', dias: [0, 6], desde: 11, hasta: 12, local: 'Librería Cervantes', zona: 'N1-B', puntos: 20, cupos: 30 },
  { titulo: 'Clase abierta de zumba', tipo: 'deporte', descripcion: 'Una hora de baile para todas las edades; trae ropa cómoda.', dias: [2, 4], desde: 18.5, hasta: 19.5, zona: 'N1-B', puntos: 25 },
  { titulo: 'Torneo de FIFA en Gamer Zone', tipo: 'deporte', descripcion: 'Eliminatorias uno contra uno; el campeón se lleva un control inalámbrico.', dias: [5], desde: 17, hasta: 21, local: 'Gamer Zone', zona: 'N2-C', puntos: 40, precio: 20, cupos: 32 },
  { titulo: 'Degustación de café de los Yungas', tipo: 'degustacion', descripcion: 'Prueba tres cafés de especialidad con un barista.', dias: [3, 6], desde: 16, hasta: 17, local: 'Café Alameda', zona: 'N1-A', puntos: 20, cupos: 15 },
  { titulo: 'Taller de salteñas', tipo: 'taller', descripcion: 'Aprende a repulgar salteñas con las maestras de Panchita; te llevas las tuyas.', dias: [0], desde: 10, hasta: 11.5, local: 'Panchita', zona: 'T-P', puntos: 30, precio: 35, cupos: 12 },
  { titulo: 'Noche de bowling 2×1', tipo: 'deporte', descripcion: 'Dos líneas por el precio de una.', dias: [3], desde: 19, hasta: 23, local: 'Bowling Strike', zona: 'T-K', puntos: 15 },
  { titulo: 'Karaoke en la Terraza', tipo: 'concierto', descripcion: 'Canta tus canciones favoritas; premio al mejor del mes.', dias: [1, 2], desde: 20, hasta: 22.5, local: 'Terraza Lounge', zona: 'T-L', puntos: 20 },
  { titulo: 'Feria de emprendedores paceños', tipo: 'feria', descripcion: 'Más de 20 emprendimientos de artesanía, ropa y comida.', dias: [6, 0], desde: 10, hasta: 20, zona: 'N1-B', puntos: 25 },
  { titulo: 'Función de cine familiar', tipo: 'cine', descripcion: 'Película animada con entrada a mitad de precio para niños.', dias: [0], desde: 15, hasta: 17, local: 'Cine Aranjuez', zona: 'T-K', puntos: 20, precio: 20 },
];

/** Eventos únicos (días desde hoy). */
export const EVENTOS_ESPECIALES: { titulo: string; tipo: string; descripcion: string; dia: number; desde: number; hasta: number; local?: string; zona: string; puntos: number; precio?: number; cupos?: number }[] = [
  { titulo: 'Desfile de moda Moda Andina', tipo: 'moda', descripcion: 'Colección de alpaca primavera, con descuentos para asistentes.', dia: 3, desde: 18, hasta: 19.5, local: 'Moda Andina', zona: 'N1-A', puntos: 40 },
  { titulo: 'Lanzamiento del Galaxy A55', tipo: 'lanzamiento', descripcion: 'Prueba el nuevo celular y participa en sorteos.', dia: 5, desde: 17, hasta: 20, local: 'Celular Express', zona: 'N1-C', puntos: 30 },
  { titulo: 'Concierto acústico de charango', tipo: 'concierto', descripcion: 'Maestros del charango en un concierto íntimo.', dia: 8, desde: 19, hasta: 21, local: 'Musical Andes', zona: 'N2-C', puntos: 40, precio: 30, cupos: 60 },
  { titulo: 'Noche de Halloween infantil', tipo: 'infantil', descripcion: 'Concurso de disfraces y dulces en todas las tiendas.', dia: 27, desde: 16, hasta: 20, zona: 'N2-A', puntos: 50 },
  { titulo: 'Festival de la salteña', tipo: 'degustacion', descripcion: 'Concurso de las mejores salteñas de La Paz en el patio de comidas.', dia: 12, desde: 9, hasta: 13, local: 'Panchita', zona: 'T-P', puntos: 40 },
  { titulo: 'Taller de skincare para la altura', tipo: 'taller', descripcion: 'Rutina de cuidado de la piel con frío y sol fuerte.', dia: 6, desde: 17, hasta: 18, local: 'Bella Piel', zona: 'N2-A', puntos: 25, cupos: 20 },
  { titulo: 'Maratón de películas de terror', tipo: 'cine', descripcion: 'Tres películas seguidas con combo incluido.', dia: 26, desde: 20, hasta: 23.9, local: 'Cine Aranjuez', zona: 'T-K', puntos: 40, precio: 90, cupos: 120 },
];

export const NOMBRES = ['María', 'José', 'Ana', 'Luis', 'Carla', 'Jorge', 'Lucía', 'Diego', 'Valeria', 'Andrés', 'Camila', 'Marco', 'Daniela', 'Fernando', 'Paola', 'Ricardo', 'Gabriela', 'Sergio', 'Natalia', 'Rodrigo', 'Fabiola', 'Mauricio', 'Verónica', 'Álvaro', 'Silvia', 'Eduardo', 'Rocío', 'Hugo', 'Mariela', 'Iván', 'Patricia', 'Óscar', 'Jimena', 'Javier', 'Claudia', 'Pablo', 'Susana', 'Gustavo', 'Wendy', 'Rubén', 'Leonardo', 'Sofía', 'Mateo', 'Valentina', 'Joaquín', 'Isabel', 'Martín', 'Renata'];
export const APELLIDOS = ['Rojas', 'Mamani', 'Quispe', 'Flores', 'Gutiérrez', 'Vargas', 'Choque', 'Fernández', 'López', 'Torrez', 'Céspedes', 'Arce', 'Morales', 'Pinto', 'Salazar', 'Villca', 'Condori', 'Paz', 'Suárez', 'Ríos', 'Ayala', 'Mendoza', 'Rocha', 'Aguilar', 'Ticona', 'Apaza', 'Calle', 'Zeballos'];
export const ZONAS_RESIDENCIA = ['Calacoto', 'Achumani', 'Obrajes', 'San Miguel', 'Irpavi', 'Sopocachi', 'Miraflores', 'Mallasa', 'Cota Cota', 'Següencoma', 'Centro', 'El Alto', 'Alto Obrajes', 'Los Pinos'];
export const BUSQUEDAS_SIN_RESULTADO = ['zara', 'apple store', 'starbucks', 'h&m', 'farmacia 24 horas', 'cine 4dx', 'decathlon', 'sony', 'tienda de vinos', 'spa', 'kfc', 'tienda naturista', 'ikea', 'gimnasio', 'lavandería', 'cerrajería', 'sastrería', 'tienda de bicicletas'];
