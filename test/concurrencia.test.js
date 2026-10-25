import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { bdTemporal } from './helpers.js';
import { bloquear, comprar, liberarVencidos, anular } from '../src/ventas.js';

test('N hilos con conexiones independientes compiten por el mismo asiento: solo uno compra', async () => {
  const { db, ruta, viajeId, asientos, limpiar } = bdTemporal();
  const asientoId = asientos[0];
  const HILOS = 16;
  const senal = new SharedArrayBuffer(4);
  let listos = 0;
  const resultados = await new Promise((resolve, reject) => {
    const fin = [];
    for (let i = 0; i < HILOS; i++) {
      const w = new Worker(new URL('./worker-compra.js', import.meta.url), {
        workerData: { ruta, viajeId, asientoId, indice: i, senal },
      });
      w.on('error', reject);
      w.on('message', (m) => {
        if (m.tipo === 'listo' && ++listos === HILOS) {
          Atomics.store(new Int32Array(senal), 0, 1);
          Atomics.notify(new Int32Array(senal), 0);
        }
        if (m.tipo === 'fin' && fin.push(m) === HILOS) resolve(fin);
      });
    }
  });

  assert.equal(resultados.filter((r) => r.ok).length, 1, 'exactamente un ganador');
  assert.ok(resultados.filter((r) => !r.ok).every((r) => r.error === 'ASIENTO_NO_DISPONIBLE'));
  const vendidos = db.prepare('SELECT COUNT(*) AS n FROM boletos WHERE viaje_id = ? AND asiento_id = ?').get(viajeId, asientoId).n;
  assert.equal(vendidos, 1, 'un solo boleto en la BD');
  limpiar();
});

test('no se puede comprar sin una reserva vigente propia', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const asientoId = asientos[1];
  const pasajeros = [{ asientoId, nombre: 'Ana Quispe', documento: '12345678' }];
  assert.throws(() => comprar(db, { viajeId, clienteId: 'cliente-sin-reserva', pasajeros }), { codigo: 'RESERVA_INVALIDA' });

  bloquear(db, { viajeId, asientoId, clienteId: 'cliente-aaaaaaa', ttlMs: 60_000 });
  assert.throws(() => comprar(db, { viajeId, clienteId: 'cliente-bbbbbbb', pasajeros }), { codigo: 'RESERVA_INVALIDA' });
  limpiar();
});

test('doble clic en "Comprar": la segunda compra falla y no hay boletos duplicados', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const asientoId = asientos[2];
  const clienteId = 'cliente-doble-clic';
  bloquear(db, { viajeId, asientoId, clienteId, ttlMs: 60_000 });
  const pasajeros = [{ asientoId, nombre: 'Luis Mamani', documento: '87654321' }];
  comprar(db, { viajeId, clienteId, pasajeros });
  assert.throws(() => comprar(db, { viajeId, clienteId, pasajeros }), { codigo: 'RESERVA_INVALIDA' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM boletos').get().n, 1);
  limpiar();
});

test('compra de varios asientos es todo-o-nada', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const [a, b] = [asientos[3], asientos[4]];
  bloquear(db, { viajeId, asientoId: a, clienteId: 'cliente-grupo', ttlMs: 60_000 });
  bloquear(db, { viajeId, asientoId: b, clienteId: 'cliente-intruso', ttlMs: 60_000 });
  assert.throws(() => comprar(db, {
    viajeId,
    clienteId: 'cliente-grupo',
    pasajeros: [
      { asientoId: a, nombre: 'Rosa Huamán', documento: '11111111' },
      { asientoId: b, nombre: 'Pedro Huamán', documento: '22222222' },
    ],
  }), { codigo: 'RESERVA_INVALIDA' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM boletos').get().n, 0, 'rollback: ningún boleto');
  const estado = db.prepare('SELECT estado FROM asiento_viaje WHERE viaje_id = ? AND asiento_id = ?').get(viajeId, a).estado;
  assert.equal(estado, 'RESERVADO', 'el asiento propio sigue reservado, no vendido');
  limpiar();
});

test('la reserva vence y otro cliente puede tomar el asiento', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const asientoId = asientos[5];
  const t0 = Date.now();
  bloquear(db, { viajeId, asientoId, clienteId: 'cliente-lento', ttlMs: 1000, ahora: t0 });
  assert.throws(() => bloquear(db, { viajeId, asientoId, clienteId: 'cliente-rapido', ttlMs: 1000, ahora: t0 + 500 }));
  const liberados = liberarVencidos(db, t0 + 1500);
  assert.equal(liberados.length, 1);
  assert.equal(liberados[0].asiento.estado, 'LIBRE');
  const a = bloquear(db, { viajeId, asientoId, clienteId: 'cliente-rapido', ttlMs: 1000, ahora: t0 + 1600 });
  assert.equal(a.estado, 'RESERVADO');
  assert.throws(() => comprar(db, {
    viajeId, clienteId: 'cliente-lento', pasajeros: [{ asientoId, nombre: 'Cliente Lento', documento: '33333333' }], ahora: t0 + 1700,
  }), { codigo: 'RESERVA_INVALIDA' });
  limpiar();
});

test('el índice único parcial impide dos boletos activos para el mismo asiento aunque se salte la lógica', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const insertar = db.prepare(`INSERT INTO boletos (codigo, viaje_id, asiento_id, pasajero_nombre, pasajero_doc, precio, vendido_en)
    VALUES (?, ?, ?, ?, ?, 100, 0)`);
  insertar.run('X1', viajeId, asientos[6], 'Uno', '44444444');
  assert.throws(() => insertar.run('X2', viajeId, asientos[6], 'Dos', '55555555'), /UNIQUE/);
  limpiar();
});

test('al anular, el asiento vuelve a estar libre y se puede revender', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const asientoId = asientos[7];
  bloquear(db, { viajeId, asientoId, clienteId: 'cliente-anula', ttlMs: 60_000 });
  const { boletos } = comprar(db, {
    viajeId, clienteId: 'cliente-anula', pasajeros: [{ asientoId, nombre: 'María Flores', documento: '66666666' }],
  });
  const { asiento } = anular(db, { codigo: boletos[0].codigo });
  assert.equal(asiento.estado, 'LIBRE');
  bloquear(db, { viajeId, asientoId, clienteId: 'cliente-nuevo', ttlMs: 60_000 });
  comprar(db, { viajeId, clienteId: 'cliente-nuevo', pasajeros: [{ asientoId, nombre: 'María Flores', documento: '66666666' }] });
  limpiar();
});

test('límite de asientos por cliente y documento duplicado', () => {
  const { db, viajeId, asientos, limpiar } = bdTemporal();
  const clienteId = 'cliente-acaparador';
  for (let i = 10; i < 16; i++) bloquear(db, { viajeId, asientoId: asientos[i], clienteId, ttlMs: 60_000 });
  assert.throws(() => bloquear(db, { viajeId, asientoId: asientos[16], clienteId, ttlMs: 60_000 }), { codigo: 'LIMITE_ASIENTOS' });

  comprar(db, { viajeId, clienteId, pasajeros: [{ asientoId: asientos[10], nombre: 'Juan Pérez', documento: '77777777' }] });
  assert.throws(() => comprar(db, {
    viajeId, clienteId, pasajeros: [{ asientoId: asientos[11], nombre: 'Juan Pérez', documento: '77777777' }],
  }), { codigo: 'DOCUMENTO_DUPLICADO' });
  limpiar();
});
