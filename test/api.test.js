import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bdTemporal } from './helpers.js';
import { crearApp } from '../src/server.js';
import { contenidoQR } from '../src/qr.js';
import { ticketEscPos } from '../src/escpos.js';
import { obtenerBoleto } from '../src/ventas.js';

const SECRETO = 'secreto-de-prueba';
let ctx, servidor, base, detener;

before(async () => {
  ctx = bdTemporal();
  const r = crearApp({ db: ctx.db, secreto: SECRETO, ttlMs: 60_000 });
  detener = r.detener;
  servidor = http.createServer(r.app);
  await new Promise((ok) => servidor.listen(0, ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  detener();
  servidor.closeAllConnections();
  await new Promise((ok) => servidor.close(ok));
  ctx.limpiar();
});

const api = async (metodo, ruta, cuerpo) => {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: res.status, datos: await res.json() };
};

test('100 peticiones HTTP simultáneas por el mismo asiento: 1 éxito y 99 conflictos', async () => {
  const asientoId = ctx.asientos[20];
  const respuestas = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    api('POST', `/api/viajes/${ctx.viajeId}/asientos/${asientoId}/bloqueo`, { clienteId: `cliente-http-${i}` })));
  assert.equal(respuestas.filter((r) => r.status === 200).length, 1);
  assert.equal(respuestas.filter((r) => r.status === 409).length, 99);
});

test('el mapa se actualiza en tiempo real por SSE', async () => {
  const asientoId = ctx.asientos[21];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/viajes/${ctx.viajeId}/eventos`, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const lector = res.body.getReader();
  const recibido = (async () => {
    let texto = '';
    while (!texto.includes('event: asiento')) texto += new TextDecoder().decode((await lector.read()).value);
    return texto;
  })();
  await api('POST', `/api/viajes/${ctx.viajeId}/asientos/${asientoId}/bloqueo`, { clienteId: 'cliente-sse-01' });
  const texto = await recibido;
  const datos = JSON.parse(texto.split('event: asiento\ndata: ')[1].split('\n')[0]);
  assert.equal(datos.id, asientoId);
  assert.equal(datos.estado, 'RESERVADO');
  assert.ok(!texto.includes('cliente-sse-01'), 'nunca se difunde el clienteId real');
  ac.abort();
});

test('flujo completo: compra → QR → embarque → reintento rechazado', async () => {
  const asientoId = ctx.asientos[22];
  const clienteId = 'cliente-flujo-01';
  await api('POST', `/api/viajes/${ctx.viajeId}/asientos/${asientoId}/bloqueo`, { clienteId });
  const compra = await api('POST', `/api/viajes/${ctx.viajeId}/compras`, {
    clienteId, pasajeros: [{ asientoId, nombre: 'Carla Condori', documento: '45678912' }],
  });
  assert.equal(compra.status, 201);
  const { codigo } = compra.datos.boletos[0];

  const boleto = await api('GET', `/api/boletos/${codigo}`);
  assert.equal(boleto.datos.qr, contenidoQR(codigo, SECRETO));
  assert.match(boleto.datos.qrImagen, /^data:image\/png;base64,/);

  const falso = await api('POST', '/api/embarque', { qr: `LCV1.${codigo}.00000000000000000000`, viajeId: ctx.viajeId });
  assert.equal(falso.datos.error, 'QR_INVALIDO');

  const otroViaje = await api('POST', '/api/embarque', { qr: boleto.datos.qr, viajeId: ctx.viajeId + 1 });
  assert.equal(otroViaje.datos.error, 'OTRO_VIAJE');

  const [e1, e2] = await Promise.all([
    api('POST', '/api/embarque', { qr: boleto.datos.qr, viajeId: ctx.viajeId }),
    api('POST', '/api/embarque', { qr: boleto.datos.qr, viajeId: ctx.viajeId }),
  ]);
  assert.deepEqual([e1.status, e2.status].sort(), [200, 409], 'dos lectores a la vez: solo uno embarca');
  assert.equal([e1, e2].find((e) => e.status === 409).datos.error, 'YA_EMBARCADO');

  const manifiesto = await api('GET', `/api/viajes/${ctx.viajeId}/manifiesto`);
  assert.equal(manifiesto.datos.find((b) => b.codigo === codigo).estado, 'EMBARCADO');
});

test('ticket ESC/POS de 58 mm: inicializa, incluye QR nativo y corta', () => {
  const filas = ctx.db.prepare('SELECT codigo FROM boletos LIMIT 1').get();
  const b = obtenerBoleto(ctx.db, filas.codigo);
  const buf = ticketEscPos(b, contenidoQR(b.codigo, SECRETO));
  assert.deepEqual([...buf.subarray(0, 2)], [0x1b, 0x40]);
  assert.ok(buf.includes(Buffer.from(contenidoQR(b.codigo, SECRETO))));
  assert.ok(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30])), 'imprime el QR');
  assert.deepEqual([...buf.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
  const lineas = buf.toString('latin1').split('\n').filter((l) => /^[\x20-\x7e]+$/.test(l));
  assert.ok(lineas.every((l) => l.length <= 32), 'ninguna línea excede 32 columnas');
});
