const fs = require('fs');
const file = 'src/seed/seed_real/catalogo_real.json';
const data = JSON.parse(fs.readFileSync(file));
const niveles = data.niveles.map(n => n.codigo);
const tieneBano = new Set(data.servicios.filter(s => s.tipo === 'baños').map(s => s.piso));
const nuevos = niveles.filter(n => !tieneBano.has(n)).map(n => ({
  id: 'bano-' + n.toLowerCase(),
  tipo: 'baños',
  nombre: 'Baños - ' + n,
  piso: n,
  x: null,
  y: null
}));
if (nuevos.length) {
  data.servicios.push(...nuevos);
  data.meta.conteo.servicios += nuevos.length;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('Baños añadidos:', nuevos.length);
} else {
  console.log('Todos los niveles ya tienen baños.');
}
