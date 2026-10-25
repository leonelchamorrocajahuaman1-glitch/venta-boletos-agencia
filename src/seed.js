import { transaccion } from './db.js';
import { fechaLocal, horaLocal, sumarDias } from './tiempo.js';

const RUTAS = [
  { origen: 'Lima', destino: 'Arequipa', duracion: 960, precio: 9000 },
  { origen: 'Lima', destino: 'Cusco', duracion: 1260, precio: 12000 },
  { origen: 'Lima', destino: 'Trujillo', duracion: 540, precio: 6000 },
  { origen: 'Arequipa', destino: 'Puno', duracion: 330, precio: 4000 },
];

const BUSES = [
  { placa: 'LCV-101', modelo: 'Scania K410 · 2 pisos' },
  { placa: 'LCV-102', modelo: 'Scania K410 · 2 pisos' },
  { placa: 'LCV-201', modelo: 'Marcopolo G8 · 2 pisos' },
  { placa: 'LCV-202', modelo: 'Marcopolo G8 · 2 pisos' },
];

const HORARIOS = ['08:00', '14:30', '21:00'];

// Plano del bus: cada letra es un asiento y "_" es el pasillo.
const PLANO = [
  { piso: 1, filas: 4, patron: 'AB_C', tipo: 'VIP 180°', recargo: 3000 },
  { piso: 2, filas: 10, patron: 'AB_CD', tipo: 'Semicama 160°', recargo: 0 },
];

function sembrarBus(db, busId) {
  const insertar = db.prepare(
    'INSERT INTO asientos (bus_id, numero, piso, fila, columna, tipo, recargo) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let numero = 1;
  for (const nivel of PLANO) {
    for (let fila = 1; fila <= nivel.filas; fila++) {
      [...nivel.patron].forEach((c, i) => {
        if (c !== '_') insertar.run(busId, numero++, nivel.piso, fila, i + 1, nivel.tipo, nivel.recargo);
      });
    }
  }
}

export function sembrarCatalogo(db) {
  transaccion(db, () => {
    const hayRutas = db.prepare('SELECT COUNT(*) AS n FROM rutas').get().n;
    if (hayRutas) return;
    const ruta = db.prepare('INSERT INTO rutas (origen, destino, duracion_min, precio_base) VALUES (?, ?, ?, ?)');
    for (const r of RUTAS) ruta.run(r.origen, r.destino, r.duracion, r.precio);
    const bus = db.prepare('INSERT INTO buses (placa, modelo) VALUES (?, ?)');
    for (const b of BUSES) sembrarBus(db, Number(bus.run(b.placa, b.modelo).lastInsertRowid));
  });
}

// Garantiza que existan salidas programadas para los próximos `dias`. Es idempotente.
export function asegurarProgramacion(db, ahora = Date.now(), dias = 4) {
  transaccion(db, () => {
    const rutas = db.prepare('SELECT id, precio_base FROM rutas ORDER BY id').all();
    const buses = db.prepare('SELECT id FROM buses ORDER BY id').all();
    const viaje = db.prepare('INSERT OR IGNORE INTO viajes (ruta_id, bus_id, salida, precio) VALUES (?, ?, ?, ?)');
    const asientos = db.prepare(
      "INSERT INTO asiento_viaje (viaje_id, asiento_id, estado) SELECT ?, id, 'LIBRE' FROM asientos WHERE bus_id = ?",
    );
    const hoy = fechaLocal(ahora);
    for (let d = 0; d < dias; d++) {
      const fecha = sumarDias(hoy, d);
      rutas.forEach((r, i) => {
        HORARIOS.forEach((hora, j) => {
          const busId = buses[(i + j) % buses.length].id;
          const res = viaje.run(r.id, busId, horaLocal(fecha, hora), r.precio_base);
          if (res.changes === 1) asientos.run(Number(res.lastInsertRowid), busId);
        });
      });
    }
  });
}
