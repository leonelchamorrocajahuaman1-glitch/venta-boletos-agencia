import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bdTemporal } from './helpers.js';
import { crearApp } from '../src/server.js';
import { crearAdminInicial, crearToken, leerToken } from '../src/auth.js';
import { fechaLocal, DIA_MS } from '../src/tiempo.js';

let ctx, servidor, base, detener, cookie;

before(async () => {
  ctx = bdTemporal();
  crearAdminInicial(ctx.db, 'admin', 'clave-segura');
  const r = crearApp({ db: ctx.db, secreto: 'qr', secretoSesion: 'sesion', ttlMs: 60_000, urlsRed: () => [{ url: 'http://192.168.1.10:3000', interfaz: 'Wi-Fi', virtual: false }] });
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

const api = async (metodo, ruta, cuerpo, extra = {}) => {
  const res = await fetch(base + ruta, {
    method: metodo,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const tipo = res.headers.get('content-type') ?? '';
  return { status: res.status, res, datos: tipo.includes('json') ? await res.json() : await res.text() };
};

test('sin sesión: la API y las páginas del administrador están protegidas', async () => {
  assert.equal((await api('GET', '/api/admin/resumen')).status, 401);
  const pagina = await api('GET', '/admin/');
  assert.equal(pagina.status, 302);
  assert.match(pagina.res.headers.get('location'), /^\/admin\/login\.html/);
  assert.equal((await api('GET', '/admin/login.html')).status, 200, 'el login sí es público');
  assert.equal((await api('GET', '/')).status, 200, 'la página del cliente es pública');
});

test('login: contraseña incorrecta, bloqueo por intentos y sesión válida', async () => {
  const malo = await api('POST', '/api/admin/login', { usuario: 'admin', password: 'x' });
  assert.equal(malo.status, 401);
  const ok = await api('POST', '/api/admin/login', { usuario: 'admin', password: 'clave-segura' });
  assert.equal(ok.status, 200);
  const setCookie = ok.res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  const sesion = await api('GET', '/api/admin/sesion');
  assert.equal(sesion.datos.usuario, 'admin');
  assert.equal(sesion.datos.urlsClientes[0].url, 'http://192.168.1.10:3000');
  assert.match(sesion.datos.urlsClientes[0].qr, /^data:image\/png;base64,/, 'QR para abrir la página desde el celular');
  assert.equal((await api('GET', '/api/ping')).datos.ok, true);
  assert.equal((await api('GET', '/admin/')).status, 200);
});

test('token de sesión: firma y expiración', () => {
  const t = crearToken('admin', 's', 1000);
  assert.equal(leerToken(t, 's', 2000), 'admin');
  assert.equal(leerToken(t, 'otro', 2000), null, 'firma con otro secreto');
  assert.equal(leerToken(t.replace('admin', 'root'), 's', 2000), null, 'usuario alterado');
  assert.equal(leerToken(t, 's', 1000 + 13 * 3_600_000), null, 'vencido');
});

test('crear salida, validar cruce de bus, vender y ver en el panel y reportes', async () => {
  const { rutas, buses } = (await api('GET', '/api/admin/catalogo')).datos;
  const manana = fechaLocal(Date.now() + DIA_MS);
  // Arequipa → Puno (5 h 30 min) a la 01:00 con el bus que hace esa ruta a las 08:00: llega 06:30, no se cruza.
  const ruta = rutas.find((r) => r.origen === 'Arequipa');
  const bus = buses.find((b) => b.placa === 'LCV-110');
  const nueva = await api('POST', '/api/admin/salidas', { rutaId: ruta.id, busId: bus.id, fecha: manana, hora: '01:00', precio: 75.5 });
  assert.equal(nueva.status, 201, JSON.stringify(nueva.datos));
  assert.equal(nueva.datos.precio, 7550);
  assert.equal(nueva.datos.total, 52);

  const cruce = await api('POST', '/api/admin/salidas', { rutaId: rutas[1].id, busId: bus.id, fecha: manana, hora: '04:00', precio: 50 });
  assert.equal(cruce.datos.error, 'BUS_OCUPADO');

  const pasada = await api('POST', '/api/admin/salidas', { rutaId: ruta.id, busId: bus.id, fecha: '2020-01-01', hora: '10:00', precio: 50 });
  assert.equal(pasada.status, 400);

  // Un cliente compra en la salida nueva
  const viajeId = nueva.datos.id;
  const { asientos } = (await api('GET', `/api/viajes/${viajeId}`)).datos;
  const clienteId = 'cliente-admin-test';
  await api('POST', `/api/viajes/${viajeId}/asientos/${asientos[0].id}/bloqueo`, { clienteId });
  const compra = await api('POST', `/api/viajes/${viajeId}/compras`, {
    clienteId, pasajeros: [{ asientoId: asientos[0].id, nombre: 'Elena Torres', documento: '71234567' }],
  });
  assert.equal(compra.status, 201);

  const resumen = (await api('GET', '/api/admin/resumen')).datos;
  assert.equal(resumen.ventasHoy, 1);
  assert.equal(resumen.ingresosHoy, 7550 + asientos[0].recargo);
  assert.equal(resumen.ultimasVentas[0].pasajero, 'Elena Torres');

  const ventas = (await api('GET', '/api/admin/ventas?q=71234567')).datos;
  assert.equal(ventas.length, 1);

  const rep = (await api('GET', '/api/admin/reportes')).datos;
  assert.equal(rep.boletos, 1);
  assert.equal(rep.porDia.length, 7, '7 días, incluidos los días sin ventas');
  assert.equal(rep.porDia.at(-1).boletos, 1);

  const csv = await api('GET', '/api/admin/reportes.csv');
  assert.match(csv.datos, /Elena Torres/);

  // No se puede cancelar con boletos vendidos; al anular sí
  assert.equal((await api('POST', `/api/admin/salidas/${viajeId}/cancelar`)).datos.error, 'TIENE_BOLETOS');
  await api('POST', `/api/boletos/${compra.datos.boletos[0].codigo}/anular`);
  const cancelada = await api('POST', `/api/admin/salidas/${viajeId}/cancelar`);
  assert.equal(cancelada.datos.estado, 'CANCELADO');
  const publicas = (await api('GET', `/api/viajes?fecha=${manana}`)).datos;
  assert.ok(!publicas.some((v) => v.id === viajeId), 'el cliente ya no ve la salida cancelada');
  const reserva = await api('POST', `/api/viajes/${viajeId}/asientos/${asientos[1].id}/bloqueo`, { clienteId });
  assert.equal(reserva.datos.error, 'VIAJE_CERRADO');
});

test('el panel recibe la actividad de los clientes en tiempo real', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/admin/eventos`, { signal: ac.signal, headers: { Cookie: cookie } });
  const lector = res.body.getReader();
  const recibido = (async () => {
    let texto = '';
    while (!texto.includes('event: actividad')) texto += new TextDecoder().decode((await lector.read()).value);
    return texto;
  })();
  await api('POST', `/api/viajes/${ctx.viajeId}/asientos/${ctx.asientos[30]}/bloqueo`, { clienteId: 'cliente-en-vivo' });
  assert.match(await recibido, /"tipo":"reserva"/);
  ac.abort();
});
