import { api, aviso, hora, fechaHora, esc } from './comun.js';

const $ = (s) => document.querySelector(s);
let viajeId = null;
let eventos = null;
let camara = null;
let ultimaLectura = { texto: '', t: 0 };
let resaltar = null;

async function cargarViajes() {
  const viajes = await api('GET', '/api/viajes?embarque=1');
  const sel = $('#viaje');
  sel.innerHTML = '';
  for (const v of viajes) sel.add(new Option(`${hora(v.salida)} · ${v.origen} → ${v.destino} · ${v.placa} (${fechaHora(v.salida)})`, v.id));
  if (viajes.length) seleccionar(viajes[0].id);
}

function seleccionar(id) {
  viajeId = Number(id);
  eventos?.close();
  const indicador = $('#envivo');
  eventos = new EventSource(`/api/viajes/${viajeId}/eventos`);
  eventos.addEventListener('open', () => {
    indicador.className = 'envivo conectado';
    indicador.textContent = 'En vivo';
    cargarManifiesto();
  });
  eventos.addEventListener('error', () => {
    indicador.className = 'envivo';
    indicador.textContent = 'Reconectando…';
  });
  // Otro lector embarcó o se vendió/anuló un boleto: el manifiesto se refresca solo.
  eventos.addEventListener('embarque', (e) => {
    resaltar = JSON.parse(e.data).codigo;
    cargarManifiesto();
  });
  eventos.addEventListener('manifiesto', cargarManifiesto);
  $('#entrada-lector').focus();
}

async function cargarManifiesto() {
  if (!viajeId) return;
  const lista = await api('GET', `/api/viajes/${viajeId}/manifiesto`);
  const embarcados = lista.filter((b) => b.estado === 'EMBARCADO').length;
  $('#c-embarcados').textContent = embarcados;
  $('#c-pendientes').textContent = lista.length - embarcados;
  $('#c-vendidos').textContent = lista.length;
  $('#progreso').style.width = lista.length ? `${(embarcados / lista.length) * 100}%` : '0';
  $('#manifiesto').innerHTML = lista.length ? lista.map((b) => `
    <tr class="${b.codigo === resaltar ? 'fila-nueva' : ''}">
      <td><b>${b.asiento}</b></td>
      <td>${esc(b.pasajero)}</td>
      <td>${esc(b.documento)}</td>
      <td><span class="estado ${b.estado}">${b.estado === 'EMBARCADO' ? `Embarcado ${hora(b.embarcadoEn)}` : 'Por embarcar'}</span></td>
      <td class="acciones">
        <a href="ticket.html?codigo=${b.codigo}" target="_blank" rel="noopener">Reimprimir</a>
        ${b.estado === 'EMITIDO' ? `<button class="peligro" data-anular="${b.codigo}">Anular</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="5" class="vacio">Aún no hay boletos vendidos para esta salida.</td></tr>';
  resaltar = null;
}

function sonido(ok) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = ok ? 880 : 220;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.15 : 0.45));
  } catch { /* sin audio */ }
}

function mostrar(ok, titulo, b, detalle = '') {
  const r = $('#resultado');
  r.className = `resultado ${ok ? 'ok' : 'error'}`;
  r.innerHTML = `
    <strong>${ok ? '✔' : '✖'} ${esc(titulo)}</strong>
    ${b ? `<div class="grande">Asiento ${b.asiento}</div><div>${esc(b.pasajero)} · ${esc(b.documento)}</div>` : ''}
    ${detalle ? `<div>${esc(detalle)}</div>` : ''}`;
  sonido(ok);
}

async function validar(cuerpo) {
  try {
    const b = await api('POST', '/api/embarque', { ...cuerpo, viajeId });
    mostrar(true, 'EMBARQUE AUTORIZADO', b, `${b.origen} → ${b.destino}`);
  } catch (err) {
    const b = err.datos?.boleto;
    const detalle = err.datos?.error === 'YA_EMBARCADO' && b?.embarcadoEn ? `Embarcó a las ${hora(b.embarcadoEn)}` : '';
    mostrar(false, err.message, b, detalle);
  }
}

function leido(texto) {
  texto = texto.trim();
  // La cámara entrega el mismo QR muchas veces por segundo: se ignoran repeticiones durante 3 s.
  if (!texto || (texto === ultimaLectura.texto && Date.now() - ultimaLectura.t < 3000)) return;
  ultimaLectura = { texto, t: Date.now() };
  validar({ qr: texto });
}

async function alternarCamara() {
  const btn = $('#btn-camara');
  if (camara) {
    await camara.stop();
    camara = null;
    btn.textContent = '📷 Activar cámara';
    return;
  }
  if (!window.Html5Qrcode) return aviso('No se pudo cargar el lector de QR (¿sin internet?)', 'error');
  if (!window.isSecureContext) return aviso('La cámara requiere HTTPS o localhost. Usa el lector USB.', 'error');
  camara = new Html5Qrcode('lector');
  try {
    await camara.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, leido);
    btn.textContent = '⏹ Detener cámara';
  } catch (err) {
    camara = null;
    aviso(`No se pudo abrir la cámara: ${err}`, 'error');
  }
}

$('#viaje').addEventListener('change', (e) => seleccionar(e.target.value));
$('#btn-camara').addEventListener('click', alternarCamara);
$('#form-lector').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#entrada-lector');
  ultimaLectura = { texto: '', t: 0 };
  leido(input.value);
  input.value = '';
});
$('#form-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  validar({ codigo: f.codigo.value, documento: f.documento.value });
  f.reset();
});
$('#manifiesto').addEventListener('click', async (e) => {
  const codigo = e.target.dataset?.anular;
  if (!codigo || !confirm(`¿Anular el boleto ${codigo}? El asiento volverá a estar disponible.`)) return;
  try {
    await api('POST', `/api/boletos/${codigo}/anular`);
    aviso('Boleto anulado');
  } catch (err) {
    aviso(err.message, 'error');
  }
});

await cargarViajes();
