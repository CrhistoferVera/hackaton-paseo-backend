import { ahoraBolivia, enRangoHorario } from '../../../common/util.js';

/** Regla del programa tal como la configura el administrador (HU-A03). */
export interface ReglaPuntos {
  id: string;
  version: number;
  bs_por_punto: number;
  valor_punto_bs: number;
  multiplicadores_categoria: Record<string, number>;
  multiplicadores_horario: { dias: number[]; desde: string; hasta: string; mult: number; etiqueta?: string }[];
  dias_vencimiento: number;
  niveles: Nivel[];
  bono_bienvenida: number;
  puntos_descubrimiento: number;
  puntos_visita_diaria: number;
  puntos_referido: number;
  puntos_hora_parqueo: number;
}

export interface Nivel {
  nombre: 'Bronce' | 'Plata' | 'Oro' | 'Platinum';
  minimo: number;
  beneficios: string[];
}

export interface Cotizacion {
  puntos: number;
  base: number;
  multiplicador: number;
  detalle: string[];
  reglaVersion: number;
}

/**
 * Política de puntos (Strategy): convierte un monto en Bs a puntos aplicando
 * multiplicadores por categoría, horario y promoción. Pura y sin I/O.
 */
export function cotizarPuntos(
  regla: ReglaPuntos,
  montoBs: number,
  categoria: string | null,
  en: Date,
  promocion: { multiplicador: number; titulo: string } | null,
): Cotizacion {
  const base = Math.floor(montoBs / Number(regla.bs_por_punto));
  let mult = 1;
  const detalle: string[] = [];
  const mCat = categoria ? Number(regla.multiplicadores_categoria?.[categoria] ?? 1) : 1;
  if (mCat !== 1) {
    mult *= mCat;
    detalle.push(`${categoria} ×${mCat}`);
  }
  const { dia, hhmm } = ahoraBolivia(en);
  for (const h of regla.multiplicadores_horario ?? []) {
    if (h.dias.includes(dia) && enRangoHorario(hhmm, h.desde, h.hasta)) {
      mult *= Number(h.mult);
      detalle.push(`${h.etiqueta ?? 'horario'} ×${h.mult}`);
    }
  }
  if (promocion && promocion.multiplicador > 1) {
    mult *= promocion.multiplicador;
    detalle.push(`${promocion.titulo} ×${promocion.multiplicador}`);
  }
  // Se redondea antes de truncar: 1,2 × 1,5 × 2 en coma flotante da 3,5999…
  const puntos = Math.floor(Math.round(base * mult * 1000) / 1000);
  return { puntos, base, multiplicador: Math.round(mult * 1000) / 1000, detalle, reglaVersion: regla.version };
}

/** El nivel se calcula con puntos ganados en 12 meses, no con el saldo: canjear no baja de nivel. */
export function calcularNivel(niveles: Nivel[], ganados12m: number) {
  const orden = [...niveles].sort((a, b) => a.minimo - b.minimo);
  let actual = orden[0];
  for (const n of orden) if (ganados12m >= n.minimo) actual = n;
  const idx = orden.indexOf(actual);
  const siguiente = orden[idx + 1] ?? null;
  const progreso = siguiente ? (ganados12m - actual.minimo) / (siguiente.minimo - actual.minimo) : 1;
  return {
    nivel: actual.nombre,
    beneficios: actual.beneficios,
    ganados12m,
    siguiente: siguiente?.nombre ?? null,
    faltan: siguiente ? Math.max(0, siguiente.minimo - ganados12m) : 0,
    progreso: Math.max(0, Math.min(1, progreso)),
    niveles: orden,
  };
}
