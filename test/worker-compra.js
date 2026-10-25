// Cada hilo abre SU PROPIA conexión a la BD, como lo harían varios procesos del servidor.
import { workerData, parentPort } from 'node:worker_threads';
import { abrirDB } from '../src/db.js';
import { bloquear, comprar } from '../src/ventas.js';

const { ruta, viajeId, asientoId, indice, senal } = workerData;
const db = abrirDB(ruta);
const clienteId = `cliente-hilo-${indice}`;
const salida = new Int32Array(senal);

parentPort.postMessage({ tipo: 'listo' });
Atomics.wait(salida, 0, 0); // todos arrancan a la vez

let resultado;
try {
  bloquear(db, { viajeId, asientoId, clienteId, ttlMs: 60_000 });
  const { boletos } = comprar(db, {
    viajeId, clienteId, pasajeros: [{ asientoId, nombre: `Pasajero ${indice}`, documento: String(40000000 + indice) }],
  });
  resultado = { ok: true, codigo: boletos[0].codigo };
} catch (err) {
  resultado = { ok: false, error: err.codigo ?? err.message };
}
db.close();
parentPort.postMessage({ tipo: 'fin', ...resultado });
