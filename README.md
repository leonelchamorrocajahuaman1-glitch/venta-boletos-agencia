# 🚌 Las Cobras Viajes — Sistema de venta de boletos

Sistema de venta de pasajes de bus para una agencia de viajes con:

- **Concurrencia estricta**: es imposible vender dos veces el mismo asiento, aunque cientos de clientes lo intenten en el mismo milisegundo.
- **Tiempo real**: el mapa interactivo del bus (2 pisos) se actualiza al instante en todos los navegadores mediante **Server-Sent Events (SSE)**.
- **Embarque con QR**: cada boleto lleva un QR **firmado con HMAC-SHA256**; el módulo de embarque lo lee con la cámara o con un lector USB y rechaza QR falsos, boletos anulados, de otra salida o ya usados.
- **Impresión térmica de 58 mm**: vista HTML optimizada para rollo de 58 mm y generación de comandos **ESC/POS** nativos (QR impreso por la propia impresora, corte de papel) con envío directo a impresoras de red por el puerto 9100.

![Stack](https://img.shields.io/badge/Node.js-22.13+-339933) ![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57) ![Tests](https://img.shields.io/badge/tests-12%20pasando-brightgreen)

---

## Inicio rápido

Requisitos: **Node.js 22.13 o superior** (usa el módulo integrado `node:sqlite`; no necesita instalar ninguna base de datos).

```bash
git clone https://github.com/leonelchamorrocajahuaman1-glitch/venta-boletos-agencia.git
cd venta-boletos-agencia
npm install
npm start
```

| Módulo | URL |
|---|---|
| Venta (mapa de asientos) | http://localhost:3000/ |
| Embarque (lector QR + manifiesto) | http://localhost:3000/embarque.html |
| Boleto imprimible 58 mm | http://localhost:3000/ticket.html?codigo=XXXX |

Al primer arranque se crean las rutas (Lima–Arequipa, Lima–Cusco, Lima–Trujillo, Arequipa–Puno), 4 buses de 2 pisos (12 asientos VIP 180° + 40 semicama 160°) y salidas programadas para los próximos 4 días (se renuevan solas cada hora).

**Para ver el tiempo real**: abre la página de venta en dos navegadores (o una ventana normal y una de incógnito), elige la misma salida y reserva un asiento en una: se pinta de naranja en la otra al instante.

### Configuración (`.env`, opcional)

Copia `.env.example` a `.env`:

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `DB_PATH` | `./data/boletos.db` | Archivo SQLite |
| `QR_SECRET` | se genera y guarda en la BD | Secreto para firmar los QR |
| `BLOQUEO_MINUTOS` | `5` | Tiempo que un asiento queda reservado mientras el cliente paga |
| `PRINTER_HOST` / `PRINTER_PORT` | — / `9100` | Impresora térmica de red ESC/POS (opcional) |

---

## Arquitectura

```
venta-boletos-agencia/
├── src/
│   ├── index.js      # Arranque: configuración, BD, semilla, servidor
│   ├── server.js     # API REST + canal SSE + barrido de reservas vencidas
│   ├── ventas.js     # ⭐ Lógica de negocio: reservar, comprar, anular, embarcar
│   ├── db.js         # Esquema SQLite (restricciones e índices) + transacciones
│   ├── sse.js        # Server-Sent Events: un canal por viaje
│   ├── qr.js         # Firma y verificación HMAC del contenido del QR
│   ├── escpos.js     # Ticket ESC/POS 58 mm + envío a impresora de red
│   ├── seed.js       # Rutas, buses, plano de asientos y programación
│   └── tiempo.js     # Zona horaria America/Lima
├── public/           # Frontend sin dependencias de compilación
│   ├── index.html / venta.js       # Venta con mapa en vivo
│   ├── embarque.html / embarque.js # Lector QR, manifiesto en vivo, anulación
│   └── ticket.html / ticket.js     # Boleto 58 mm
├── test/             # Pruebas de concurrencia, API, SSE, QR y ESC/POS
└── scripts/simular-concurrencia.js # Demostración en vivo de la carrera
```

### Ciclo de vida de un asiento

```
            reservar (UPDATE condicional)          comprar (transacción)
  LIBRE ───────────────────────────────▶ RESERVADO ──────────────────────▶ VENDIDO
    ▲                                      │  (dueño + vence en 5 min)        │
    │      liberar / la reserva vence      │                                  │
    └──────────────────────────────────────┘                                  │
    └──────────────────────────── anular boleto ──────────────────────────────┘

  Boleto:  EMITIDO ──(QR válido en embarque)──▶ EMBARCADO        EMITIDO ──▶ ANULADO
```

---

## 1. Concurrencia estricta: cómo se evita la doble venta

El problema clásico es la **condición de carrera** *leer-y-luego-escribir*: dos clientes leen "asiento 14 libre", ambos deciden comprarlo y ambos escriben. La solución usa **cuatro capas de defensa**:

**a) Transición atómica con `UPDATE` condicional (bloqueo optimista a nivel de fila).** Nunca se hace "SELECT y después UPDATE". La comprobación y el cambio van en la *misma* sentencia, y solo cuenta si afectó exactamente una fila:

```sql
UPDATE asiento_viaje
SET estado = 'RESERVADO', reservado_por = :cliente, reservado_hasta = :ahora + :ttl, version = version + 1
WHERE viaje_id = :viaje AND asiento_id = :asiento
  AND (estado = 'LIBRE' OR (estado = 'RESERVADO' AND (reservado_hasta < :ahora OR reservado_por = :cliente)))
-- changes = 1 → el asiento es tuyo;  changes = 0 → otro llegó primero → HTTP 409
```

**b) Transacciones `BEGIN IMMEDIATE`.** Reservar y comprar se ejecutan dentro de una transacción que toma el candado de escritura **desde el inicio**. Si dos procesos/hilos con conexiones distintas llegan a la vez, el segundo espera (`busy_timeout`) y al continuar ve el cambio del primero. Una compra de varios asientos es **todo o nada**: si uno falla, `ROLLBACK` y no se emite ningún boleto.

**c) Reserva temporal con vencimiento.** Al elegir un asiento queda `RESERVADO` 5 minutos a tu nombre (se muestra una cuenta regresiva). La compra solo procede si la reserva sigue siendo tuya y vigente (`reservado_por = :cliente AND reservado_hasta >= :ahora`). Un barrido cada 2 s libera las reservas vencidas y lo difunde por SSE. Límite de 6 asientos por cliente para evitar acaparamiento.

**d) Restricciones en la base de datos (última línea de defensa).** Aunque hubiera un error en la aplicación, SQLite rechaza el dato inválido:

```sql
CREATE UNIQUE INDEX ux_boleto_asiento_activo ON boletos (viaje_id, asiento_id) WHERE estado <> 'ANULADO';
CREATE UNIQUE INDEX ux_boleto_doc_activo     ON boletos (viaje_id, pasajero_doc) WHERE estado <> 'ANULADO';
CHECK ((estado = 'RESERVADO') = (reservado_por IS NOT NULL AND reservado_hasta IS NOT NULL))
```

El índice es **parcial**: un boleto anulado libera el asiento para revenderlo sin violar la unicidad.

El embarque usa el mismo patrón (`UPDATE … WHERE estado = 'EMITIDO'`), así que dos lectores escaneando el mismo QR a la vez no pueden embarcar dos veces al pasajero.

> **Nota sobre PostgreSQL/MySQL:** el diseño se traslada tal cual. El `UPDATE` condicional es idéntico; `BEGIN IMMEDIATE` equivale a `SELECT … FOR UPDATE` sobre la fila de `asiento_viaje` dentro de una transacción, y los índices únicos parciales existen en PostgreSQL con la misma sintaxis.

### Pruébalo

```bash
npm test                    # 12 pruebas automatizadas
npm start                   # en otra terminal:
npm run simular -- 200      # 200 clientes por el mismo asiento + doble clic en "Comprar"
```

Salida real de la simulación:

```
1) 200 clientes reservan el asiento 1 al mismo tiempo…
   ✔ 1 reserva concedida · ✖ 199 rechazadas (409) · 280 ms
2) El ganador pulsa "Comprar" 10 veces a la vez (doble clic / reintentos de red)…
   ✔ 1 boleto emitido · ✖ 9 rechazadas · 10 ms
3) Un perdedor intenta comprar sin tener la reserva…
   ✖ 409 RESERVA_INVALIDA: El asiento 1 ya no está reservado a tu nombre
Resultado: cero dobles ventas. ✅
```

La prueba más fuerte (`test/concurrencia.test.js`) lanza **16 hilos (`worker_threads`), cada uno con su propia conexión a la base de datos** —como varios procesos del servidor—, los sincroniza con `Atomics.wait` para que arranquen en el mismo instante y verifica que exactamente uno compra y que en la BD existe un único boleto.

| Prueba | Qué demuestra |
|---|---|
| 16 hilos con conexiones independientes | Una sola venta entre procesos concurrentes |
| 100 peticiones HTTP simultáneas | 1 × 200 OK y 99 × 409 Conflict |
| Comprar sin reserva / con reserva ajena | Rechazo `RESERVA_INVALIDA` |
| Doble clic en "Comprar" | Un solo boleto |
| Compra de 2 asientos con 1 inválido | Rollback total (todo o nada) |
| Reserva vencida | Se libera y otro cliente puede tomarla |
| Insertar boletos saltándose la lógica | El índice único lo impide |
| Anular y revender | El asiento vuelve a LIBRE |
| Límite de 6 asientos / DNI repetido | Reglas de negocio |
| SSE | El evento llega y nunca expone el `clienteId` real |
| Embarque | QR adulterado, otra salida y doble embarque simultáneo rechazados |
| ESC/POS | Inicializa, QR nativo, corte y ≤ 32 columnas por línea |

---

## 2. Tiempo real con Server-Sent Events

`GET /api/viajes/:id/eventos` abre un flujo `text/event-stream` por viaje. Cada cambio se difunde al instante:

| Evento | Cuándo |
|---|---|
| `asiento` | Reserva, liberación, vencimiento, venta o anulación de un asiento |
| `embarque` | Un pasajero embarcó (actualiza el manifiesto en todos los lectores) |
| `manifiesto` | Se vendió o anuló un boleto |
| `espectadores` | Cuántas personas están viendo ese bus |

¿Por qué SSE y no WebSockets? El flujo es **servidor → cliente** (las acciones van por REST con sus códigos HTTP 200/409), SSE funciona sobre HTTP normal sin librerías, atraviesa proxies y **reconecta solo** (`retry: 2000`). Al reconectar, el cliente vuelve a descargar el mapa completo para no perder eventos. Un latido cada 20 s mantiene viva la conexión.

**Privacidad:** el `clienteId` permite comprar los asientos reservados, por eso nunca se difunde; los navegadores reciben solo un `titular` (hash SHA-256 truncado) para pintar "mío" (azul) u "otro" (naranja).

---

## 3. Embarque: QR firmado

Contenido del QR: `LCV1.<código>.<firma>` donde `firma = HMAC-SHA256(secreto, "LCV1.<código>")` (20 caracteres hex).

- No se pueden **fabricar** boletos sin conocer el secreto del servidor; la comparación es en tiempo constante (`timingSafeEqual`).
- Solo usa `[A-Z0-9.]`, así los **lectores USB** (que funcionan como teclado) no alteran caracteres con distribuciones de teclado latinas.
- Validaciones: firma, boleto existente, salida correcta, no anulado, no embarcado antes (muestra la hora del primer embarque).
- Tres formas de lectura: **cámara** (librería `html5-qrcode`; requiere HTTPS o `localhost`), **lector USB** (campo con foco automático, valida al recibir Enter) e **ingreso manual** (código impreso + DNI del pasajero).
- Señal visual grande verde/roja y sonido distinto para aceptación o rechazo; manifiesto con contadores y barra de progreso que se actualiza en vivo entre varios lectores.

---

## 4. Impresión térmica de 58 mm

Dos caminos:

1. **Desde el navegador** (`ticket.html`): diseño de 58 mm de ancho en fuente monoespaciada y `@page { margin: 0 }`. En el diálogo de impresión elige la térmica, papel **58 mm (rollo)** y márgenes *ninguno*. Con `?auto=1` imprime solo al abrir.
2. **ESC/POS directo** (`escpos.js`): genera los bytes que entiende cualquier térmica compatible (Epson, Xprinter, Bixolon…):
   - 32 columnas (fuente A en 384 puntos), texto ASCII sin tildes para no depender de la página de códigos.
   - Doble tamaño para la ruta y el asiento, negritas, alineación.
   - **QR nativo** (`GS ( k`, modelo 2, módulo 6, corrección M): la impresora lo dibuja nítido.
   - Avance y **corte parcial** (`GS V B`).
   - `GET /api/boletos/:codigo/escpos` descarga el `.bin` (p. ej. `copy /b boleto.bin \\PC\Termica` en Windows o `cat boleto.bin > /dev/usb/lp0` en Linux).
   - `POST /api/boletos/:codigo/imprimir` lo envía por TCP a `PRINTER_HOST:9100`.

---

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/ciudades` | Orígenes y destinos |
| GET | `/api/viajes?origen&destino&fecha` | Salidas con asientos libres |
| GET | `/api/viajes/:id?clienteId=` | Viaje + mapa de asientos |
| GET | `/api/viajes/:id/eventos` | Flujo SSE |
| POST | `/api/viajes/:id/asientos/:asientoId/bloqueo` | Reservar `{clienteId}` → 200 / 409 |
| DELETE | `/api/viajes/:id/asientos/:asientoId/bloqueo?clienteId=` | Liberar |
| POST | `/api/viajes/:id/compras` | Comprar `{clienteId, pasajeros:[{asientoId,nombre,documento}]}` → 201 / 409 |
| GET | `/api/viajes/:id/manifiesto` | Lista de pasajeros |
| GET | `/api/boletos/:codigo` | Boleto + contenido e imagen del QR |
| GET | `/api/boletos/:codigo/escpos` | Ticket ESC/POS 58 mm |
| POST | `/api/boletos/:codigo/imprimir` | Enviar a la térmica de red |
| POST | `/api/boletos/:codigo/anular` | Anular (libera el asiento) |
| POST | `/api/embarque` | `{qr, viajeId}` o `{codigo, documento, viajeId}` |

Errores con formato `{ "error": "ASIENTO_NO_DISPONIBLE", "mensaje": "…" }` y códigos HTTP 400/404/409.

## Limitaciones y siguientes pasos

- El pago está simulado (el botón "Pagar" emite directamente); integrar una pasarela solo cambia el paso entre reserva y compra.
- El módulo de embarque no tiene autenticación de personal: en producción irían detrás de un login con roles (vendedor / embarque / administrador).
- Los eventos SSE se difunden desde el proceso que hizo el cambio; con varias instancias del servidor se añadiría Redis Pub/Sub o `LISTEN/NOTIFY` de PostgreSQL. La garantía de no doble venta **sí** funciona entre procesos porque vive en la base de datos.
