# Paseo Points · API

Backend de Paseo Points para Paseo Aranjuez: programa de puntos, PaseoYa (marketplace con retiro presencial) y Centro de Inteligencia. NestJS 12 + PostgreSQL.

Repositorios hermanos:
- `hackaton-paseo-frontend-web`: portal de locales (cajero, gerente) y Centro de Inteligencia (admin, marketing, analista).
- `hackaton-paseo-frontend-mobile`: app del cliente (Expo).

## Puesta en marcha

Requiere Node.js 22 o superior.

```bash
npm install
cp .env.example .env
npm run seed
npm run start:dev
```

La API queda en `http://localhost:4000`.

### Base de datos

- **Postgres** (Neon, Railway, Supabase o local): define `DATABASE_URL` en `.env`. Las migraciones se aplican solas al arrancar.
- **Sin `DATABASE_URL`**: usa PGlite, un Postgres real que corre dentro de Node, con los datos en `.data/pgdata`. No hay que instalar nada.

PGlite admite un solo proceso a la vez. Detén la API antes de correr `npm run seed`.

### Datos sintéticos

`npm run seed` genera unos 3 meses de actividad: 40 locales ubicados en el plano, 2.000 clientes con perfiles distintos (oficinistas al mediodía, familias de fin de semana, jóvenes de tarde, ocasionales, dormidos), visitas, compras, canjes, pedidos PaseoYa, búsquedas sin resultado y casos de fraude plantados. Al final calcula los segmentos con K-Means y entrena el modelo de anomalías.

`npm run seed -- --reset` borra todo y vuelve a generar.

### Cuentas de prueba (solo desarrollo)

| Rol | Usuario | Contraseña |
| --- | --- | --- |
| Administración | `admin@paseo.bo` | `Admin2026!` |
| Marketing | `marketing@paseo.bo` | `Marketing2026!` |
| Analista | `analista@paseo.bo` | `Analista2026!` |
| Gerente de local | `gerente.<local>@paseo.bo` (por ejemplo `gerente.cafealameda@paseo.bo`) | `Gerente2026!` |
| Cajero | `cajero.<local>@paseo.bo` | `Cajero2026!` |
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
│  ├─ participacion/   promociones, misiones (con IA), hitos AR y Drops espaciales
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
| `PP1:<código>:<totp>` | Pase del cliente | Cajero |
| `PPC:<código>.<firma>` | Cupón de canje (15 min) | Local |
| `PPR:<código>.<firma>` (o PIN de 4 dígitos) | Retiro PaseoYa | Local |
| `PPL:<código>` | Puerta de un local | Cliente (check-in) |
| `PPE:<puerta>` | Entrada del Paseo | Cliente («Llegué») |
| `PPH:<zona>` | Cartel de hito AR | Cliente (moneda o Drop) |
| `PPK:<ticket>` | Ticket de parqueo | Cliente |
| Factura SIAT | URL en línea o formato con código de control | Cliente |

### IA

Sin `ANTHROPIC_API_KEY` todo funciona con plantillas deterministas: misiones personalizadas, nombres de segmentos, resumen del día y un catálogo de preguntas para «Pregúntale a tus datos». Con la clave, Claude Sonnet 5.5 traduce preguntas libres a SQL y Claude Haiku 4.5 redacta textos. El SQL generado se valida y se ejecuta en modo de solo lectura.

### Jarvis por voz (proactivo)

Jarvis no espera a que le pregunten: reacciona a lo que hace el cliente y le manda una orden de voz (`orden_voz_jarvis` por Socket.IO) que el teléfono lee con su sintetizador nativo.

| Lo que pasa | Lo que dice Jarvis |
| --- | --- |
| Compra en PaseoYa | Ruta de recojo; si hay un Drop o una moneda a menos de 50 m de desvío, lo hace pasar por ahí |
| El local pone su comida en «Preparando» | Itinerario para la espera: un cartel con moneda en una zona de poco tráfico, al alcance en esos minutos |
| Pedido listo | Cuántos metros faltan y el primer paso |
| Escanea un QR (puerta, cartel) | Venta cruzada con lo que hay cerca |
| Llega al Paseo | Bienvenida con su pedido listo o la mejor oferta cercana |
| El admin lanza un Drop | Aviso a quienes están a menos de 120 m |

**Cómo decide.** El edificio se guarda como un grafo de nodos de ubicación: pasillos, locales, carteles, accesos, escalera y ascensor (`orientacion/`). La posición del cliente es la última prueba de presencia: QR de puerta, cartel, entrada, compra o retiro. Las rutas salen de Dijkstra sobre ese grafo, con indicaciones para escuchar mientras se camina. Al modelo solo le llega lo que está a pocos metros caminando: el «contexto cercano».

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
