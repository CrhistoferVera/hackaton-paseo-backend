/**
 * Isolation Forest mínimo (Liu et al., 2008) para puntuar transacciones atípicas.
 * Puntaje en [0,1]: cerca de 1 = anómala, alrededor de 0,5 o menos = normal.
 */
interface Nodo {
  hoja: boolean;
  tamano: number;
  atributo?: number;
  corte?: number;
  izq?: Nodo;
  der?: Nodo;
}

function c(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

function aleatorio(semilla: { v: number }) {
  semilla.v = (semilla.v * 1664525 + 1013904223) % 4294967296;
  return semilla.v / 4294967296;
}

export class IsolationForest {
  private arboles: Nodo[] = [];
  private muestra = 256;

  constructor(
    private readonly nArboles = 100,
    private readonly semilla = 42,
  ) {}

  get entrenado() {
    return this.arboles.length > 0;
  }

  entrenar(datos: number[][]) {
    if (datos.length < 30) {
      this.arboles = [];
      return;
    }
    const s = { v: this.semilla };
    this.muestra = Math.min(256, datos.length);
    const alturaMax = Math.ceil(Math.log2(this.muestra));
    this.arboles = [];
    for (let t = 0; t < this.nArboles; t++) {
      const sub: number[][] = [];
      for (let i = 0; i < this.muestra; i++) sub.push(datos[Math.floor(aleatorio(s) * datos.length)]);
      this.arboles.push(this.construir(sub, 0, alturaMax, s));
    }
  }

  private construir(x: number[][], altura: number, max: number, s: { v: number }): Nodo {
    if (altura >= max || x.length <= 1) return { hoja: true, tamano: x.length };
    const dims = x[0].length;
    const atributo = Math.floor(aleatorio(s) * dims);
    let min = Infinity;
    let maxV = -Infinity;
    for (const fila of x) {
      min = Math.min(min, fila[atributo]);
      maxV = Math.max(maxV, fila[atributo]);
    }
    if (min === maxV) return { hoja: true, tamano: x.length };
    const corte = min + aleatorio(s) * (maxV - min);
    const izq = x.filter((f) => f[atributo] < corte);
    const der = x.filter((f) => f[atributo] >= corte);
    return { hoja: false, tamano: x.length, atributo, corte, izq: this.construir(izq, altura + 1, max, s), der: this.construir(der, altura + 1, max, s) };
  }

  private longitud(x: number[], n: Nodo, h: number): number {
    if (n.hoja) return h + c(n.tamano);
    return x[n.atributo!] < n.corte! ? this.longitud(x, n.izq!, h + 1) : this.longitud(x, n.der!, h + 1);
  }

  puntaje(x: number[]): number {
    if (!this.entrenado) return 0;
    const media = this.arboles.reduce((a, t) => a + this.longitud(x, t, 0), 0) / this.arboles.length;
    return Math.pow(2, -media / c(this.muestra));
  }
}
