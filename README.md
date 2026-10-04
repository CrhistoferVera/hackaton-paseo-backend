# Paseo Points · API

Backend de Paseo Points para Paseo Aranjuez: programa de puntos, PaseoYa (marketplace con retiro presencial) y Centro de Inteligencia. NestJS 12 + PostgreSQL.

Repositorios hermanos:
- `hackaton-paseo-frontend-web`: panel de comercio (una cuenta por negocio) y Centro de Inteligencia (admin, marketing, analista).
- `hackaton-paseo-frontend-mobile`: app del cliente (Expo).

## Puesta en marcha

Requiere Node.js 22 o superior y PostgreSQL 14 o superior. La guía completa para levantar los tres repositorios está en `../COMO-CORRER.md`.

```bash
npm install
cp .env.example .env          # pon tu DATABASE_URL
npm run seed -- --reset
npm run start:dev
```

La API queda en `http://localhost:4000`.

### Base de datos

- **Postgres** (local, Laragon, Neon, Supabase, Railway): define `DATABASE_URL` en `.env`, por ejemplo `postgres://postgres@localhost:5432/paseo_points`. Las migraciones se aplican solas al arrancar o al sembrar.
- **Sin `DATABASE_URL`**: usa PGlite (Postgres embebido en `.data/pgdata`), solo para pruebas rápidas; admite un proceso a la vez.

`npm run seed -- --reset` borra **solo las tablas del sistema** (la base puede compartirse con otras aplicaciones) y vuelve a generar.

### Datos sintéticos

`npm run seed` genera unos 4 meses de actividad para probar el sistema y a Jarvis:
- 40 locales con horario, días de atención y teléfono; 216 productos con precio, stock y tiempo de preparación.
- Una cuenta de comercio por local.
- 21 servicios del Paseo (baños, cajeros automáticos, wifi, lactancia, enfermería, objetos perdidos, mascotas…), que también son destinos de ruta.
- 19 promociones repartidas para que a toda hora haya alguna activa, y unos 195 eventos (recurrentes y especiales) entre 30 días atrás y 45 adelante, con uno siempre en curso.
- 2.500 clientes con perfiles distintos (oficinistas al mediodía, familias de fin de semana, jóvenes de tarde, ocasionales, dormidos): visitas, compras, canjes, PaseoYa, parqueo, Drops, búsquedas sin resultado y fraude plantado.
- Información general del Paseo para Jarvis (medios de pago, devoluciones, facturas, fumar, seguridad). Son textos de ejemplo: revísalos en `/admin/informacion` antes de usarlos en serio.
- Solicitudes de Drop y propuestas de eventos pendientes.
- María (la clienta demo) con un pedido listo, otro en preparación, el parqueo abierto y un cupón vigente.

Al final calcula los segmentos con K-Means, entrena el modelo de anomalías y arma el grafo del edificio.

### Cuentas de prueba (solo desarrollo)

| Rol | Usuario | Contraseña |
| --- | --- | --- |
| Administración | `admin@paseo.bo` | `Admin2026!` |
| Marketing | `marketing@paseo.bo` | `Marketing2026!` |
| Analista | `analista@paseo.bo` | `Analista2026!` |
| Comercio (una cuenta por local) | `comercio.<local>@paseo.bo` (por ejemplo `comercio.napolipizzeria@paseo.bo`) | `Comercio2026!` |
| Cliente demo (María Rojas) | `70000001` | `Maria2026!` |

Los roles internos ingresan con doble factor. En desarrollo (`OTP_EN_RESPUESTA=true`) el código viene en la respuesta del login porque no hay proveedor de SMS ni de correo.

## Arquitectura

Monolito modular en capas. Cada módulo tiene su dominio puro, sus casos de uso (servicios), su acceso a datos y sus controladores. Ningún módulo escribe tablas de otro: llama a su servicio público o reacciona a sus eventos.

```
src/
├─ infra/db/           puerto Db + adaptadores Postgres (pg) y PGlite, migraciones, vistas «oro»
├─ infra/realtime/     Socket.IO: salas usuario:{id}, local:{id}, sala:{recinto}
├─ common/             JWT, guardia de roles, validación Zod, utilidades (TOTP, CSV)
├─ modules/
│  ├─ nucleo/          telemetría (eventos), auditoría, notificaciones, bus de eventos
│  ├─ identidad/       registro, login, OTP, 2FA, pase TOTP, privacidad, usuarios y roles
│  ├─ fidelizacion/    libro mayor, reglas versionadas, niveles, vencimientos, economía
│  ├─ comercio/        compras en caja, factura SIAT, movimientos del local, CSV
│  ├─ recompensas/     catálogo, cupones de un solo uso, validación en el local
│  ├─ participacion/   promociones, misiones (con IA), Drops y eventos (con QR de asistencia)
│  ├─ presencia/       visitas, check-ins, parqueo, geocerca
│  ├─ recinto/         plano, locales, categorías, buscador, QR de puerta en PDF
│  ├─ paseoya/         catálogo, pedidos multi-local, máquina de estados, retiro
│  ├─ confianza/       reglas antifraude + Isolation Forest, alertas
│  ├─ inteligencia/    tablero, mapa de calor, RFM y K-Means, afinidad, embudo, ROI, cohortes, NL→SQL
│  ├─ integraciones/   API v1 para Jarvis Paseo (x-api-key)
│  └─ ia/              adaptador del modelo de lenguaje (Claude), opcional
└─ seed/               generador sintético
```

Decisiones que sostienen los requisitos no funcionales:

- **Unidad de trabajo.** Registrar una compra escribe venta, libro mayor, check-in, reglas antifraude y evento en una sola transacción (RNF-02).
- **Idempotencia.** Cada compra lleva una clave generada en la caja; un reintento devuelve el mismo resultado (RNF-03).
- **Libro mayor de solo inserción.** El saldo es la suma de movimientos. Los lotes se consumen del más antiguo al más nuevo y vencen a los 12 meses. Los cupones reservan puntos y los descuentan al validarse.
- **Pase TOTP.** El QR del cliente (`PP1:<código>:<totp>`) rota cada 60 s y se genera sin conexión en el celular (RNF-05).
- **Lectura separada.** «Pregúntale a tus datos» solo consulta las vistas del esquema `oro`, que nunca exponen identidad y ocultan grupos de menos de 5 clientes. La consulta corre en una transacción de solo lectura.
- **Privacidad.** La telemetría usa un identificador seudónimo; al eliminar la cuenta se rompe el vínculo.

### Formatos de QR

| Prefijo | Qué es | Quién lo escanea |
| --- | --- | --- |
| `PP1:<código>:<totp>` | Pase del cliente | Comercio |
| `PPC:<código>.<firma>` | Cupón de canje (15 min) | Local |
| `PPR:<código>.<firma>` (o PIN de 4 dígitos) | Retiro PaseoYa | Local |
| `PPL:<código>` | Puerta de un local | Cliente (check-in) |
| `PPE:<puerta>` | Entrada del Paseo | Cliente («Llegué») |
| `PPA:<id del evento>` | QR de asistencia de un evento (PDF desde el panel) | Cliente (suma los puntos del evento) |
| `PPK:<ticket>` | Ticket de parqueo | Cliente |
| Factura SIAT | URL en línea o formato con código de control | Cliente |

### IA

Sin `ANTHROPIC_API_KEY` todo funciona con plantillas deterministas: misiones personalizadas, nombres de segmentos, resumen del día y un catálogo de preguntas para «Pregúntale a tus datos». Con la clave, Claude Sonnet 5.5 traduce preguntas libres a SQL y Claude Haiku 4.5 redacta textos. El SQL generado se valida y se ejecuta en modo de solo lectura.

### Jarvis por voz (proactivo)

Jarvis no espera a que le pregunten: reacciona a lo que hace el cliente y le manda una orden de voz (`orden_voz_jarvis` por Socket.IO) que el teléfono lee con su sintetizador nativo.

| Lo que pasa | Lo que dice Jarvis |
| --- | --- |
| Compra en PaseoYa | Ruta de recojo; si hay un local con Drop a menos de 50 m de desvío, lo hace pasar por ahí |
| El local pone su comida en «Preparando» | Itinerario para la espera: un Drop o una promoción en un pasillo con poco tráfico, al alcance en esos minutos |
| Pedido listo | Cuántos metros faltan y el primer paso |
| Escanea un QR (puerta de un local) | Venta cruzada con lo que hay cerca |
| Llega al Paseo | Bienvenida con su pedido listo o la mejor oferta cercana |
| El admin lanza un Drop | Aviso a quienes están a menos de 120 m |

**Cómo decide.** El edificio se guarda como un grafo de nodos de ubicación: pasillos, locales, servicios, accesos, escalera y ascensor (`orientacion/`). La posición del cliente es la última prueba de presencia: QR de puerta, entrada, compra o retiro (o «Estoy en…» tocando el mapa). Las rutas salen de Dijkstra sobre ese grafo, con indicaciones para escuchar mientras se camina. Al modelo solo le llega lo que está a pocos metros caminando: el «contexto cercano».

**Quién redacta.** Un modelo local en Ollama (`qwen2.5:1.5b` por defecto) reescribe un borrador armado con datos reales. Medido en esta máquina, la mediana es de unos 0,7 s con el modelo cargado. La respuesta se descarta y se usa el borrador si:
- tarda más de `JARVIS_TIMEOUT_MS`,
- cambia o agrega una cifra,
- pierde el nombre del local,
- o habla en primera persona.

Así siempre hay una respuesta correcta.

```bash
winget install Ollama.Ollama
ollama pull qwen2.5:1.5b
```

La API calienta el modelo al arrancar y lo mantiene en memoria 30 minutos. Sin Ollama, Jarvis funciona igual con las plantillas.

El celular también puede mandar eventos por el socket: `evento_usuario` con `escaneo_qr`, `espera_comida` o `pregunta`. La identidad se toma de la sesión del socket. Para ver qué está diciendo Jarvis, el motor y la latencia de cada orden, abre `/admin/jarvis` en el portal web.

### Jarvis conversacional (con memoria y datos en tiempo real)

`POST /cliente/jarvis` responde preguntas con datos consultados en el momento: promociones activas o de más tarde, eventos (hoy, mañana, fin de semana), precios y stock, tiempos de preparación, horarios y si un local está abierto, puntos que ganarías con un monto, dónde ganar más puntos, misiones, Drops, parqueo, pedidos PaseoYa, servicios (baños, cajeros automáticos, wifi, lactancia, enfermería, objetos perdidos, mascotas) y rutas.

- **Memoria** (`conversacion_jarvis`): entiende seguimientos como «¿y cuánto tarda?», «¿y la óptica?» o «sí, llévame». La conversación vive 45 minutos sin hablar; `GET /cliente/jarvis/historial` la retoma y `POST /cliente/jarvis/reiniciar` empieza otra.
- **Cómo entiende:** reglas, un índice de nombres del Paseo que tolera errores del reconocedor («napoly» → Napoli) y un buscador de evidencia (`jarvis/buscador.ts`). El buscador marca qué palabras de la pregunta respaldan los datos (locales, productos, servicios, zonas, ascensor, información general) y cuáles no («zapatillas **nike**», «comida **vegana**», «**gimnasio**»).
- **No inventa:** si algo no está en los datos, Jarvis lo dice («No encontré «spa» en el Paseo…», «No tengo la cartelera de películas…») y la pregunta queda en `/admin/informacion` para que la administración la complete. Preguntas ajenas al Paseo (clima, noticias, cultura general) no se responden de memoria. El modelo local nunca genera respuestas: solo elige una intención entre las que consultan datos.
- **Cómo responde:** cada respuesta se arma con datos reales y el modelo local solo la vuelve natural. Se usa la respuesta original si la versión del modelo cambia una cifra, quita o pone una negación, agrega un nombre propio o palabras de contenido nuevas, agrega un saludo o se alarga.
- **Información general** (`info_paseo`): medios de pago, devoluciones, normas. La administra el equipo en `/admin/info-paseo` (web: «Información para Jarvis») y Jarvis la cita tal cual.

### Jarvis escucha (voz a texto local)

`POST /cliente/jarvis/voz` (multipart, campo `audio`) recibe lo que grabó el celular o el navegador (webm, m4a, ogg, wav). ffmpeg lo decodifica y Whisper (`onnx-community/whisper-small` sobre ONNX, en el propio servidor) lo transcribe en unos 2,5 segundos con 4 hilos (`WHISPER_HILOS`). Si se pide, Jarvis responde en la misma llamada. El asistente del admin usa lo mismo en `POST /admin/asistente/voz` y responde en voz alta con `POST /admin/asistente/hablar`.

Whisper corre en un proceso hijo (`jarvis/oido.worker.ts`): la voz de Jarvis (sherpa-onnx) trae otra librería ONNX y, en el mismo proceso de Windows, la que cargaba segunda fallaba («se está preparando» para siempre). Si el proceso se cae, se reinicia solo.

El audio no se guarda ni sale de la máquina. El modelo se descarga una vez a `.data/modelos`. Se reemplazó el reconocedor del navegador, que enviaba el audio a Google y fallaba con «Network».

### Equidad del flujo y ofertas personales de la IA

Uno de los retos es que el público se reparta entre todos los locales, incluso entre competidores (competencia sana).

- **Equidad** (`jarvis/equidad.service.ts`): para cada local compara sus visitas de 7 días con la mediana de su categoría, cuán lleno está ahora frente a lo normal a esta hora, y cuántas veces lo recomendamos (exposición). Con eso calcula un puntaje de equidad y el índice de Gini del flujo y de las recomendaciones.
- **Perfil del cliente** (`jarvis/perfil.service.ts`): qué categorías compra, a qué hora viene, favoritos y locales que no conoce. Solo si aceptó la personalización.
- **Recomendador** (`jarvis/recomendador.service.ts`): Jarvis mezcla el gusto del cliente con la equidad (peso configurable), resta exposición y no repite al mismo local. Explica el motivo («es nuevo para ti…», «ahora tiene poca gente…», «tienes una oferta personal ahí…»).
- **Ofertas diarias** (`ofertas/`): cada mañana (`ajuste_ia.hora_generacion`) la IA genera 1 a 5 ofertas por cliente activo.
  - Puntos ×2 o ×3 en locales que van con su gusto, con cupo por local: los sub-atendidos reciben más.
  - La franja son las horas flojas del local, cerca de la hora en que el cliente suele venir.
  - Al comprar en esa franja, los puntos extra se acreditan solos.
  - Endpoints: `GET /cliente/ofertas`, `GET /local/ofertas`, `GET /admin/ofertas`, `POST /admin/ofertas/generar`, `PUT /admin/ofertas/ajustes`, `GET /admin/equidad`.

### Asistente del Centro de Inteligencia

`POST /admin/asistente` conversa con administración con memoria del período y del local («¿y la semana pasada?», «¿y Napoli?»). Cubre:
- resumen con comparación, ranking, detalle y comparación de locales, horas pico y flojas;
- equidad del flujo, plan de acciones, ofertas de la IA, pendientes de aprobar;
- clientes, demanda insatisfecha, fraude, eventos, Drops, retorno de promociones y lo que preguntan a Jarvis.

Devuelve texto, tabla, gráfico y **acciones ejecutables** (crear la promoción sugerida en las horas flojas de un local sub-atendido, regenerar ofertas). Lo que no reconoce pasa a «Pregúntale a tus datos» sobre las vistas oro.

### Voz nativa en español

`POST /cliente/jarvis/hablar` sintetiza el texto con Piper `es_MX-claude` (sherpa-onnx, en el servidor, sin nube) y devuelve la URL de un MP3 (`GET /voz/:id.mp3`, vive 30 minutos). La app pide la primera frase sola y prepara las siguientes mientras suena. Si el servidor no responde, usa una voz en español del teléfono.

### Panel de comercio

Una cuenta `comercio` por negocio, que reemplaza a cajero y gerente:
- Caja, cupones y pedidos.
- Productos PaseoYa (crear, editar, eliminar, stock, tiempo de preparación, etiquetas).
- Promociones (crear, retirar, terminar).
- **Solicitudes de Drop:** `/local/drops`; el admin las aprueba y lanza en `/admin/drops/solicitudes`.
- **Eventos propuestos:** `/local/eventos`; el admin los aprueba en `/admin/eventos`.

Quien escanea un QR del lugar mientras un evento está en curso suma sus puntos de asistencia una sola vez.

### Jarvis Paseo (API para integraciones)

```bash
curl -X POST http://localhost:4000/api/v1/jarvis/consulta \
  -H "x-api-key: jarvis-dev-key" -H "content-type: application/json" \
  -d '{"celular":"70000001","pregunta":"¿qué puedo canjear?"}'
```

También: `GET /api/v1/clientes/saldo?celular=`, `GET /api/v1/clientes/canjeables?celular=`, `GET /api/v1/productos/buscar?q=`.

## Pruebas

```bash
npm test            # dominio: política de puntos, niveles, estados de pedido, TOTP, SIAT, Isolation Forest, K-Means
npm run test:e2e    # arranque de la API con una base PGlite temporal
npm run lint
```
