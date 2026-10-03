/** K-Means con inicialización k-means++ determinista (semilla fija) sobre datos normalizados. */
export function normalizar(datos: number[][]): { x: number[][]; medias: number[]; desvios: number[] } {
  const d = datos[0]?.length ?? 0;
  const medias = Array(d).fill(0);
  const desvios = Array(d).fill(0);
  for (const f of datos) f.forEach((v, j) => (medias[j] += v / datos.length));
  for (const f of datos) f.forEach((v, j) => (desvios[j] += (v - medias[j]) ** 2 / datos.length));
  for (let j = 0; j < d; j++) desvios[j] = Math.sqrt(desvios[j]) || 1;
  return { x: datos.map((f) => f.map((v, j) => (v - medias[j]) / desvios[j])), medias, desvios };
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

export function kmeans(x: number[][], k: number, iteraciones = 60, semilla = 7): { asignacion: number[]; centroides: number[][] } {
  let s = semilla;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const centroides: number[][] = [x[Math.floor(rnd() * x.length)]];
  while (centroides.length < k) {
    const d = x.map((p) => Math.min(...centroides.map((c) => dist2(p, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    let idx = 0;
    for (; idx < d.length - 1 && r > d[idx]; idx++) r -= d[idx];
    centroides.push([...x[idx]]);
  }
  let asignacion = Array(x.length).fill(0);
  for (let it = 0; it < iteraciones; it++) {
    const nueva = x.map((p) => {
      let mejor = 0;
      let md = Infinity;
      centroides.forEach((c, i) => {
        const dd = dist2(p, c);
        if (dd < md) {
          md = dd;
          mejor = i;
        }
      });
      return mejor;
    });
    const cambio = nueva.some((a, i) => a !== asignacion[i]);
    asignacion = nueva;
    for (let c = 0; c < k; c++) {
      const miembros = x.filter((_, i) => asignacion[i] === c);
      if (miembros.length) centroides[c] = miembros[0].map((_, j) => miembros.reduce((a, m) => a + m[j], 0) / miembros.length);
    }
    if (!cambio) break;
  }
  return { asignacion, centroides };
}
