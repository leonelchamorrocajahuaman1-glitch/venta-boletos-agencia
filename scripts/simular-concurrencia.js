// Demostración en vivo: N clientes intentan reservar el MISMO asiento al mismo
// tiempo contra el servidor en ejecución y luego el ganador hace "doble clic"
// en Comprar. Abre el mapa de ese viaje en el navegador para verlo en tiempo real.
//
//   npm start                 (en otra terminal)
//   npm run simular -- 200
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const N = Number(process.argv[2] ?? 100);
const DOBLE_CLIC = 10;

let cookie = '';
const api = async (metodo, ruta, cuerpo) => {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: res.status, datos: await res.json() };
};
const contar = (lista, status) => lista.filter((r) => r.status === status).length;

const [viaje] = (await api('GET', '/api/viajes')).datos.filter((v) => v.libres > 0);
if (!viaje) throw new Error('No hay viajes con asientos libres');
const { asientos } = (await api('GET', `/api/viajes/${viaje.id}`)).datos;
const asiento = asientos.find((a) => a.estado === 'LIBRE');
console.log(`Viaje ${viaje.id}: ${viaje.origen} → ${viaje.destino}. Asiento en disputa: N° ${asiento.numero}`);

console.log(`\n1) ${N} clientes reservan el asiento ${asiento.numero} al mismo tiempo…`);
const clientes = Array.from({ length: N }, (_, i) => `simulador-${Date.now()}-${i}`);
let t0 = performance.now();
const reservas = await Promise.all(clientes.map((clienteId) =>
  api('POST', `/api/viajes/${viaje.id}/asientos/${asiento.id}/bloqueo`, { clienteId })));
console.log(`   ✔ ${contar(reservas, 200)} reserva concedida · ✖ ${contar(reservas, 409)} rechazadas (409) · ${(performance.now() - t0).toFixed(0)} ms`);
const indice = reservas.findIndex((r) => r.status === 200);
if (contar(reservas, 200) !== 1) throw new Error('¡DOBLE RESERVA DETECTADA!');
const ganador = clientes[indice];

console.log(`\n2) El ganador pulsa "Comprar" ${DOBLE_CLIC} veces a la vez (doble clic / reintentos de red)…`);
const pasajeros = [{ asientoId: asiento.id, nombre: 'Pasajero Simulación', documento: String(Date.now()).slice(-8) }];
t0 = performance.now();
const compras = await Promise.all(Array.from({ length: DOBLE_CLIC }, () =>
  api('POST', `/api/viajes/${viaje.id}/compras`, { clienteId: ganador, pasajeros })));
console.log(`   ✔ ${contar(compras, 201)} boleto emitido · ✖ ${contar(compras, 409)} rechazadas · ${(performance.now() - t0).toFixed(0)} ms`);
if (contar(compras, 201) !== 1) throw new Error('¡DOBLE VENTA DETECTADA!');

console.log('\n3) Un perdedor intenta comprar sin tener la reserva…');
const intruso = await api('POST', `/api/viajes/${viaje.id}/compras`, { clienteId: clientes[(indice + 1) % N], pasajeros });
console.log(`   ✖ ${intruso.status} ${intruso.datos.error}: ${intruso.datos.mensaje}`);

// Limpieza: el administrador anula el boleto de prueba.
const { codigo } = compras.find((r) => r.status === 201).datos.boletos[0];
const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usuario: process.env.ADMIN_USUARIO ?? 'admin', password: process.env.ADMIN_PASSWORD ?? 'admin123' }),
});
cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const anulado = await api('POST', `/api/boletos/${codigo}/anular`);
console.log(anulado.status === 200
  ? `\nBoleto de prueba ${codigo} anulado; el asiento ${asiento.numero} vuelve a estar libre.`
  : `\nNo se pudo anular el boleto de prueba ${codigo} (${anulado.datos.mensaje}); anúlalo desde el panel.`);
console.log('Resultado: cero dobles ventas. ✅');
