/** Máquina de estados del sub-pedido PaseoYa (pliego, sección del reto 3, más «vencido»). */
export type EstadoSubpedido = 'recibido' | 'confirmado' | 'preparando' | 'listo' | 'cliente_llego' | 'entregado' | 'vencido';

export const ORDEN_ESTADOS: EstadoSubpedido[] = ['recibido', 'confirmado', 'preparando', 'listo', 'cliente_llego', 'entregado'];

const TRANSICIONES: Record<EstadoSubpedido, EstadoSubpedido[]> = {
  recibido: ['confirmado', 'vencido'],
  confirmado: ['preparando', 'vencido'],
  preparando: ['listo', 'vencido'],
  listo: ['cliente_llego', 'entregado', 'vencido'],
  cliente_llego: ['entregado', 'vencido'],
  entregado: [],
  vencido: [],
};

export function puedeTransicionar(de: EstadoSubpedido, a: EstadoSubpedido): boolean {
  return TRANSICIONES[de].includes(a);
}

export const ETIQUETA_ESTADO: Record<EstadoSubpedido, string> = {
  recibido: 'Pedido recibido',
  confirmado: 'Confirmado por el local',
  preparando: 'Preparando',
  listo: 'Listo para recoger',
  cliente_llego: 'Cliente llegó',
  entregado: 'Entregado',
  vencido: 'Vencido',
};
