import { api, aviso, soles, hora, fechaHora, hoyLima, esc } from '../comun.js';

const $ = (s) => document.querySelector(s);
const VISTAS = ['panel', 'salidas', 'ventas', 'reportes'];
const cargadores = {};

// ───────── Navegación por pestañas (#panel, #salidas, …) ─────────
function mostrarVista() {
  const vista = VISTAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'panel';
  for (const v of VISTAS) $(`#vista-${v}`).classList.toggle('activa', v === vista);
  for (const a of document.querySelectorAll('#pestanas a')) a.classList.toggle('activo', a.hash === `#${vista}`);
  cargadores[vista]?.();
}
window.addEventListener('hashchange', mostrarVista);

function ocupacion(s) {
  const pv = (s.vendidos / s.total) * 100;
  const pr = (s.reservados / s.total) * 100;
  return `<div class="ocupacion" title="${s.vendidos} vendidos · ${s.reservados} reservados ahora · ${s.total - s.vendidos - s.reservados} libres">
    <div class="pista"><span class="vend" style="width:${pv}%"></span>${s.reservados ? `<span class="res" style="width:${pr}%"></span>` : ''}</div>
    <small>${s.vendidos}/${s.total}</small></div>`;
}

// ───────── Panel ─────────
async function cargarPanel() {
  const r = await api('GET', '/api/admin/resumen');
  $('#k-ventas').textContent = r.ventasHoy;
  $('#k-ingresos').textContent = soles(r.ingresosHoy);
  $('#k-embarcados').textContent = r.embarcadosHoy;
  $('#k-comprando').textContent = r.comprandoAhora;
  $('#k-salidas').textContent = r.salidasHoy;
  $('#k-anulados').textContent = r.anuladosHoy ? `${r.anuladosHoy} boleto(s) anulado(s) hoy` : '';
  $('#proximas').innerHTML = r.proximas.map((s) => `
    <tr>
      <td>${fechaHora(s.salida)}</td>
      <td>${esc(s.origen)} → ${esc(s.destino)}</td>
      <td>${esc(s.placa)}</td>
      <td>${ocupacion(s)}</td>
      <td class="num">${soles(s.ingresos)}</td>
      <td class="acciones"><a href="embarque.html?viaje=${s.id}" title="Manifiesto y embarque">Ver</a></td>
    </tr>`).join('') || '<tr><td colspan="6" class="vacio">No hay salidas próximas.</td></tr>';
  if (!$('#actividad').children.length) {
    $('#actividad').innerHTML = r.ultimasVentas.map((v) => `
      <li><time>${hora(v.vendidoEn)}</time><span>${v.estado === 'ANULADO' ? '✖ Anulado' : '🎫 Venta'} · ${esc(v.pasajero)} ·
        ${esc(v.origen)} → ${esc(v.destino)} · asiento ${v.asiento} · ${soles(v.precio)}</span></li>`).join('')
      || '<li class="vacio"><time></time><span>Sin actividad todavía. Las compras de los clientes aparecerán aquí al instante.</span></li>';
  }
}
cargadores.panel = cargarPanel;

const ICONOS = { venta: '🎫', reserva: '🪑', liberacion: '↩', vencimiento: '⏱', embarque: '✅', anulacion: '✖', salida: '🚌', cancelacion: '⛔' };

function conectarActividad() {
  const indicador = $('#envivo');
  const es = new EventSource('/api/admin/eventos');
  let pendiente;
  es.addEventListener('open', () => { indicador.className = 'envivo conectado'; indicador.textContent = 'En vivo'; });
  es.addEventListener('error', () => { indicador.className = 'envivo'; indicador.textContent = 'Reconectando…'; });
  es.addEventListener('actividad', (e) => {
    const a = JSON.parse(e.data);
    const lista = $('#actividad');
    lista.querySelector('.vacio')?.remove();
    const li = document.createElement('li');
    li.className = 'nuevo';
    li.innerHTML = `<time>${hora(a.t)}</time><span class="act-${a.tipo}">${ICONOS[a.tipo] ?? '•'} ${esc(a.texto)}${a.total ? ` · ${soles(a.total)}` : ''}</span>`;
    lista.prepend(li);
    while (lista.children.length > 60) lista.lastElementChild.remove();
    if (a.tipo === 'venta') aviso(`Nueva venta: ${a.texto}`);
    // Se agrupan ráfagas de eventos para no recargar los datos en cada uno.
    clearTimeout(pendiente);
    pendiente = setTimeout(() => {
      const vista = location.hash.slice(1) || 'panel';
      if (vista === 'panel' || vista === 'salidas') cargadores[vista]();
    }, 400);
  });
}

// ───────── Salidas ─────────
let catalogo;
async function cargarCatalogo() {
  catalogo = await api('GET', '/api/admin/catalogo');
  const f = $('#form-salida');
  f.rutaId.innerHTML = catalogo.rutas.map((r) => `<option value="${r.id}">${esc(r.origen)} → ${esc(r.destino)}</option>`).join('');
  f.busId.innerHTML = catalogo.buses.map((b) => `<option value="${b.id}">${esc(b.placa)} · ${esc(b.modelo)} (${b.asientos})</option>`).join('');
  const precioDeRuta = () => {
    const r = catalogo.rutas.find((x) => x.id === Number(f.rutaId.value));
    f.precio.value = (r.precioBase / 100).toFixed(2);
  };
  f.rutaId.addEventListener('change', precioDeRuta);
  precioDeRuta();
  f.fecha.value = f.fecha.min = hoyLima();
}

async function cargarSalidas() {
  const fecha = $('#fecha-salidas').value || hoyLima();
  const lista = await api('GET', `/api/admin/salidas?fecha=${fecha}`);
  $('#salidas').innerHTML = lista.map((s) => `
    <tr>
      <td><b>${hora(s.salida)}</b></td>
      <td>${esc(s.origen)} → ${esc(s.destino)}</td>
      <td>${esc(s.placa)}</td>
      <td class="num">${soles(s.precio)}</td>
      <td>${ocupacion(s)}</td>
      <td class="num">${s.embarcados}</td>
      <td class="num">${soles(s.ingresos)}</td>
      <td>${s.estado === 'CANCELADO' ? '<span class="estado CANCELADO">Cancelada</span>'
        : s.salida < Date.now() ? '<span class="estado PARTIO">Partió</span>' : '<span class="estado PROGRAMADO">Programada</span>'}</td>
      <td class="acciones">
        <a href="embarque.html?viaje=${s.id}">Manifiesto</a>
        ${s.estado === 'PROGRAMADO' && s.salida > Date.now() ? `<button class="peligro" data-cancelar="${s.id}">Cancelar</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="9" class="vacio">No hay salidas este día.</td></tr>';
}
cargadores.salidas = cargarSalidas;

$('#fecha-salidas').value = hoyLima();
$('#fecha-salidas').addEventListener('change', cargarSalidas);
$('#form-salida').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const s = await api('POST', '/api/admin/salidas', {
      rutaId: f.rutaId.value, busId: f.busId.value, fecha: f.fecha.value, hora: f.hora.value, precio: f.precio.value,
    });
    aviso(`Salida creada: ${s.origen} → ${s.destino}, ${fechaHora(s.salida)}`);
    $('#fecha-salidas').value = f.fecha.value;
    cargarSalidas();
  } catch (err) {
    aviso(err.message, 'error');
  }
});
$('#salidas').addEventListener('click', async (e) => {
  const id = e.target.dataset?.cancelar;
  if (!id || !confirm('¿Cancelar esta salida? Dejará de mostrarse a los clientes.')) return;
  try {
    await api('POST', `/api/admin/salidas/${id}/cancelar`);
    aviso('Salida cancelada');
    cargarSalidas();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

// ───────── Ventas ─────────
async function cargarVentas() {
  const f = $('#form-ventas');
  const q = new URLSearchParams({ fecha: f.fecha.value, q: f.q.value });
  const lista = await api('GET', `/api/admin/ventas?${q}`);
  const activos = lista.filter((b) => b.estado !== 'ANULADO');
  $('#titulo-ventas').textContent = `${lista.length} boleto(s) · ${soles(activos.reduce((s, b) => s + b.precio, 0))} en boletos activos`;
  $('#ventas').innerHTML = lista.map((b) => `
    <tr>
      <td><code>${b.codigo}</code></td>
      <td>${fechaHora(b.vendidoEn)}</td>
      <td>${esc(b.pasajero)}</td>
      <td>${esc(b.documento)}</td>
      <td>${esc(b.origen)} → ${esc(b.destino)}</td>
      <td>${fechaHora(b.salida)}</td>
      <td class="num">${b.asiento}</td>
      <td class="num">${soles(b.precio)}</td>
      <td><span class="estado ${b.estado}">${b.estado.toLowerCase()}</span></td>
      <td class="acciones">
        <a href="../ticket.html?codigo=${b.codigo}" target="_blank" rel="noopener">Imprimir</a>
        ${b.estado === 'EMITIDO' ? `<button class="peligro" data-anular="${b.codigo}">Anular</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="10" class="vacio">No se encontraron boletos.</td></tr>';
}
cargadores.ventas = cargarVentas;

$('#form-ventas').fecha.value = hoyLima();
$('#form-ventas').addEventListener('submit', (e) => { e.preventDefault(); cargarVentas(); });
$('#ventas').addEventListener('click', async (e) => {
  const codigo = e.target.dataset?.anular;
  if (!codigo || !confirm(`¿Anular el boleto ${codigo}? El asiento quedará libre para la venta.`)) return;
  try {
    await api('POST', `/api/boletos/${codigo}/anular`);
    aviso('Boleto anulado');
    cargarVentas();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

// ───────── Reportes ─────────
const corta = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' });

function barras(cont, filas, etiqueta) {
  const max = Math.max(1, ...filas.map((f) => f.ingresos));
  cont.innerHTML = filas.map((f) => `
    <div class="barra-fila" title="${esc(etiqueta(f))}: ${f.boletos} boleto(s), ${soles(f.ingresos)}">
      <span>${esc(etiqueta(f))}</span>
      <div class="pista">${f.ingresos ? `<span style="width:${(f.ingresos / max) * 100}%"></span>` : ''}</div>
      <span class="num">${soles(f.ingresos)} <small class="vacio">(${f.boletos})</small></span>
    </div>`).join('') || '<p class="vacio">Sin ventas en el periodo.</p>';
}

async function cargarReportes() {
  const f = $('#form-reportes');
  const q = new URLSearchParams({ desde: f.desde.value, hasta: f.hasta.value });
  const r = await api('GET', `/api/admin/reportes?${q}`);
  f.desde.value = r.desde;
  f.hasta.value = r.hasta;
  $('#csv').dataset.url = `/api/admin/reportes.csv?desde=${r.desde}&hasta=${r.hasta}`;
  $('#r-boletos').textContent = r.boletos;
  $('#r-ingresos').textContent = soles(r.ingresos);
  $('#r-promedio').textContent = r.boletos ? soles(Math.round(r.ingresos / r.boletos)) : '–';
  $('#r-anulados').textContent = r.anulados;
  barras($('#r-dias'), r.porDia, (d) => corta.format(Date.parse(`${d.fecha}T12:00:00Z`)));
  barras($('#r-rutas'), r.porRuta, (x) => `${x.origen} → ${x.destino}`);
}
cargadores.reportes = cargarReportes;
$('#form-reportes').addEventListener('submit', (e) => { e.preventDefault(); cargarReportes(); });
$('#csv').addEventListener('click', (e) => { location.href = e.currentTarget.dataset.url; });

// ───────── Sesión ─────────
$('#salir').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  location.href = 'login.html';
});

const sesion = await api('GET', '/api/admin/sesion');
$('#usuario').textContent = `👤 ${sesion.nombre}`;
$('#urls').innerHTML = sesion.urlsClientes.length
  ? `<p>En las computadoras de los clientes (misma red Wi-Fi o cable), abre en el navegador:</p>
     <p>${sesion.urlsClientes.map((u) => `<code>${esc(u)}/</code>`).join(' &nbsp;o&nbsp; ')}</p>
     <p class="vacio">La base de datos vive solo en esta computadora (servidor); los clientes no la necesitan.</p>`
  : '<p>No se detectó una red local. Conecta esta computadora a la red para que los clientes puedan entrar.</p>';
await cargarCatalogo();
conectarActividad();
mostrarVista();
