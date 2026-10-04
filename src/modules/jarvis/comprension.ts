import { z } from 'zod';

export const MAX_MENSAJE = 6000;
const PlanSchema = z.object({
  consultas: z.array(z.object({ intencion: z.string(), pregunta: z.string().min(1).max(MAX_MENSAJE) })).max(6),
  aclaracion: z.string().max(600).nullable(),
});
export type PlanConversacion = z.infer<typeof PlanSchema>;
/** Menús pequeños para que el modelo local no confunda funciones de ámbitos distintos. */
export function gruposConsulta(rol: 'cliente' | 'admin', permitidas: readonly string[]) {
  const grupos: Record<string,string[]> = rol === 'admin' ? {
    negocios_y_pisos: ['inventario'],
    ventas_visitas_y_puntos: ['resumen','ranking','local','comparar','horas','metrica'],
    decisiones_del_programa: ['equidad','acciones','ofertas','clientes','demanda'],
    solicitudes_y_actividad: ['pendientes','fraude','eventos','promociones','jarvis','jarvis_sin_datos'],
    conversacion_y_datos_no_registrados: ['sin_datos','fuera_de_tema','ayuda','libre'],
  } : {
    mis_puntos_y_recompensas: ['saldo','nivel','canjes','vencimiento','movimientos','puntos_ganar','oportunidades'],
    tiendas_productos_y_ubicaciones: ['horario','local_info','donde','servicio','precio','producto','cerca','buscar','info','zona','conteo','cartelera'],
    actividades_y_beneficios: ['promociones','ofertas','eventos','misiones','drops','parqueo'],
    comida_y_mis_pedidos: ['tiempo','recomendacion','pedido_estado','pedido_donde','espera'],
    conversacion_y_datos_no_registrados: ['saludo','gracias','ayuda','reinicio','afirmacion','fuera_de_tema','libre'],
  };
  return Object.fromEntries(Object.entries(grupos).map(([g,is])=>[g,is.filter(i=>permitidas.includes(i))] as const).filter(([,is])=>is.length));
}
export function validarPlan(valor: unknown, intenciones: readonly string[]): PlanConversacion | null {
  const r = PlanSchema.safeParse(valor);
  if (!r.success || r.data.consultas.some(c => !intenciones.includes(c.intencion))) return null;
  if (!r.data.consultas.length && !r.data.aclaracion?.trim()) return null;
  return r.data;
}
const DESCRIPCIONES: Record<string,string> = {
  saludo:'solo saludar', gracias:'agradecer o despedirse', ayuda:'qué puedes hacer o cómo funciona el programa, NO consultar mi saldo', reinicio:'borrar el contexto explícitamente', afirmacion:'aceptar la propuesta anterior', canjes:'recompensas disponibles por puntos', oportunidades:'dónde ganar más puntos', promociones:'promociones publicadas', ofertas:'ofertas personales de IA', eventos:'agenda de eventos', misiones:'misiones disponibles', drops:'activaciones de premios', parqueo:'información de parqueo', servicio:'baños, cajeros u otros servicios', producto:'detalle de producto', tiempo:'tiempo de preparación', recomendacion:'recomendar qué comprar o comer', pedido_estado:'estado de mi pedido', pedido_donde:'dónde retiro mi pedido', espera:'actividad mientras espero', cerca:'negocios cercanos', buscar:'buscar negocios o productos', info:'información general publicada del Paseo', zona:'información de una zona', cartelera:'películas del cine', fuera_de_tema:'temas ajenos al Paseo', ranking:'diez negocios con mayores o menores ventas', equidad:'distribución del flujo', acciones:'recomendaciones de gestión', pendientes:'solicitudes pendientes de aprobar', clientes:'estadísticas de clientes', demanda:'búsquedas sin resultados', fraude:'alertas de fraude', jarvis:'uso del asistente de clientes', jarvis_sin_datos:'preguntas de clientes sin respuesta',
  inventario:'número de negocios y distribución por pisos', resumen:'total vendido o cantidad de compras de todo el Paseo', local:'total vendido y detalle de un negocio', comparar:'comparar dos negocios', metrica:'visitas, ticket promedio, puntos o recompra', horas:'actividad por hora', sin_datos:'datos no registrados: utilidades, aforo por cámaras, costos, encuestas',
  saldo:'mis puntos disponibles', vencimiento:'cuándo vencen mis puntos', nivel:'nivel de fidelidad, no piso del edificio', conteo:'cantidad de negocios o pisos', donde:'ubicación o ruta', precio:'precio de un producto concreto', local_info:'información publicada del negocio', movimientos:'historial de puntos', puntos_ganar:'cálculo de puntos por compra', horario:'horarios de atención', libre:'pregunta que no encaja; mantenerla completa',
};
export function instruccionesPlan(rol: 'cliente' | 'admin', intenciones: readonly string[]) {
  const ejemplos = rol === 'admin' ? 'Ticket promedio de ventas de Tienda B ayer => metrica. Lista de negocios por piso => inventario. Ventas de esta semana => resumen.' : 'Cuántos puntos tengo => saldo. Cuándo vencen mis puntos => vencimiento. Qué puedes hacer => ayuda.';
  return 'Elige la intención de UNA pregunta de un '+rol+'. Devuelve solo {"intencion":"..."}.\n'+'\nIntenciones disponibles:\n'+intenciones.map(i=>i+': '+(DESCRIPCIONES[i]??i)).join('\n')+'.\nPara datos no registrados (ingredientes, calorías, alergias, garantías), usa '+(rol==='admin'?'sin_datos':'libre')+'. Si ninguna intención cumple todos los filtros de la pregunta, usa libre. No respondas la pregunta ni cambies las intenciones.\nEjemplos correctos: '+ejemplos;
}
