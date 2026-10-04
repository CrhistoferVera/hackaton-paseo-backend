# Pedidos separados y variantes

La migración 008_carritos_variantes se ejecuta al iniciar el backend. Agrega estructuras sin borrar pedidos anteriores. Desplegar primero el backend y luego los clientes. El catálogo mantiene el valor histórico de ámbito tiendas; los pedidos y carritos usan retail.

## Contrato

POST /cliente/pedidos acepta items con productoId, cantidad, varianteIds (una opción por grupo) y dropId opcional, pago, tipo opcional y fechaEstimadaRetiro para retail. También acepta fecha_estimada_retiro y varianteId para una sola opción. No requiere franjas horarias. El tipo siempre se verifica contra el catálogo.

Retail admite hoy, mañana y pasado mañana según America/La_Paz (tres días inclusivos, no hoy más tres). Comida llega inmediatamente en recibido. El comercio confirma, prepara y marca listo; entrega conserva la validación QR/PIN. Retail permite pasar directamente de recibido a listo. Las reservas retail vencen después de su fecha y restituyen inventario una sola vez. Comida ya no vence por una franja inexistente.

POST /local/pedidos/:id/estado acepta tiempoPreparacionMin opcional (1–240). El cliente recibe el evento pedido y vuelve a consultar el detalle; también sincroniza al reconectar.

GET /local/productos/:id/variantes devuelve grupos y opciones. POST al mismo recurso recibe la estructura completa (array de grupos con titulo, id opcional y opciones). Las opciones contienen nombre, stock, precioBs opcional, fotoUrl opcional e id al editar. Las imágenes se suben mediante POST /local/productos/foto, multipart archivo. Los endpoints de creación/edición de producto aceptan variantes para guardar producto y opciones en una misma transacción.

## Precios e inventario

Todos los grupos configurados son obligatorios. Una opción sin precio hereda el precio base. Para múltiples grupos, el precio final es base + suma(precio de opción - base), ignorando precios nulos. Esta regla se muestra en el editor. Un Drop sustituye el precio base y conserva las diferencias de las opciones. Las combinaciones con total negativo se rechazan.

Cada opción seleccionada consume su propio stock; un producto sin opciones consume producto.stock. No se modelan existencias por combinación SKU, sino por opción, según el esquema solicitado. El catálogo muestra el mínimo de las existencias sumadas de cada grupo. Los descuentos condicionales y bloqueos de producto previenen sobreventas y revierten todo ante un error.

Las opciones retiradas se desactivan para preservar referencias. subpedido_item_variante guarda todas las selecciones; variante_id conserva la primera para compatibilidad y variante_detalle registra el texto inmutable.

## Verificación

Backend: npm run build, npm test, npm run lint. test/paseoya.spec.ts aplica todas las migraciones en PGlite y verifica separación, fechas, stock, historia, autorización y estados/eventos.

Móvil: node node_modules/typescript/bin/tsc --noEmit; node --experimental-strip-types --test test/carrito.test.mjs; npm run lint. ESLint fue configurado con Expo; el lint global detecta problemas previos fuera de los archivos de esta funcionalidad.

Web: npm run build; npm run lint. El build necesita acceder a Google Fonts por la configuración existente.
