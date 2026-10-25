import { DatabaseSync } from 'node:sqlite';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rutas (
  id INTEGER PRIMARY KEY,
  origen TEXT NOT NULL,
  destino TEXT NOT NULL,
  duracion_min INTEGER NOT NULL,
  precio_base INTEGER NOT NULL,            -- en céntimos
  UNIQUE (origen, destino)
);

CREATE TABLE IF NOT EXISTS buses (
  id INTEGER PRIMARY KEY,
  placa TEXT NOT NULL UNIQUE,
  modelo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asientos (
  id INTEGER PRIMARY KEY,
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  numero INTEGER NOT NULL,
  piso INTEGER NOT NULL,
  fila INTEGER NOT NULL,
  columna INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  recargo INTEGER NOT NULL DEFAULT 0,      -- en céntimos
  UNIQUE (bus_id, numero)
);

CREATE TABLE IF NOT EXISTS viajes (
  id INTEGER PRIMARY KEY,
  ruta_id INTEGER NOT NULL REFERENCES rutas(id),
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  salida INTEGER NOT NULL,                 -- epoch ms
  precio INTEGER NOT NULL,                 -- en céntimos
  estado TEXT NOT NULL DEFAULT 'PROGRAMADO' CHECK (estado IN ('PROGRAMADO', 'CANCELADO')),
  UNIQUE (ruta_id, salida)
);

-- Estado de cada asiento en cada viaje. Es la fila que se "bloquea" en las
-- transacciones: toda transición se hace con un UPDATE condicional atómico.
CREATE TABLE IF NOT EXISTS asiento_viaje (
  viaje_id INTEGER NOT NULL REFERENCES viajes(id),
  asiento_id INTEGER NOT NULL REFERENCES asientos(id),
  estado TEXT NOT NULL DEFAULT 'LIBRE' CHECK (estado IN ('LIBRE', 'RESERVADO', 'VENDIDO')),
  reservado_por TEXT,
  reservado_hasta INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (viaje_id, asiento_id),
  CHECK ((estado = 'RESERVADO') = (reservado_por IS NOT NULL AND reservado_hasta IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_av_expiracion
  ON asiento_viaje (reservado_hasta) WHERE estado = 'RESERVADO';

CREATE TABLE IF NOT EXISTS boletos (
  id INTEGER PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  viaje_id INTEGER NOT NULL,
  asiento_id INTEGER NOT NULL,
  pasajero_nombre TEXT NOT NULL,
  pasajero_doc TEXT NOT NULL,
  precio INTEGER NOT NULL,                 -- en céntimos
  estado TEXT NOT NULL DEFAULT 'EMITIDO' CHECK (estado IN ('EMITIDO', 'EMBARCADO', 'ANULADO')),
  vendido_en INTEGER NOT NULL,
  embarcado_en INTEGER,
  anulado_en INTEGER,
  FOREIGN KEY (viaje_id, asiento_id) REFERENCES asiento_viaje (viaje_id, asiento_id)
);
-- Última línea de defensa contra la doble venta: aunque la lógica de la
-- aplicación fallara, la BD rechaza dos boletos activos para el mismo asiento.
CREATE UNIQUE INDEX IF NOT EXISTS ux_boleto_asiento_activo
  ON boletos (viaje_id, asiento_id) WHERE estado <> 'ANULADO';
-- Un mismo documento no puede tener dos asientos activos en el mismo viaje.
CREATE UNIQUE INDEX IF NOT EXISTS ux_boleto_doc_activo
  ON boletos (viaje_id, pasajero_doc) WHERE estado <> 'ANULADO';
`;

export function abrirDB(ruta) {
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(ESQUEMA);
  return db;
}

// BEGIN IMMEDIATE toma el candado de escritura al inicio de la transacción,
// así dos procesos/hilos nunca leen-y-escriben el mismo estado a la vez:
// el segundo espera (busy_timeout) y luego ve los cambios del primero.
export function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
