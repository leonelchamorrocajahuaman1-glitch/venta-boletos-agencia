import { api, aviso, soles, hora, fechaHora, hoyLima, duracion, idAleatorio, esc } from './comun.js';

const clienteId = (() => {
  try {
    let id = sessionStorage.getItem('clienteId');
    if (!id) sessionStorage.setItem('clienteId', (id = idAleatorio()));
    return id;
  } catch {
    return idAleatorio();
  }
})();

const $ = (s) => document.querySelector(s);
const estado = {
  viaje: null,
  asientos: new Map(), // id -> asiento
  miTitular: null,
  maxAsientos: 6,
  datos: new Map(), // asientoId -> { nombre, documento } escritos en el formulario
  eventos: null,
  enCurso: new Set(),
};

// ---------- Búsqueda de viajes ----------
async function cargarCiudades() {
  const { origenes, destinos } = await api('GET', '/api/ciudades');
  const f = $('#filtros');
  for (const c of origenes) f.origen.add(new Option(c, c));
  for (const c of destinos) f.destino.add(new Option(c, c));
  f.fecha.value = hoyLima();
  f.fecha.min = hoyLima();
}

async function buscar(e) {
  e?.preventDefault();
  const f = $('#filtros');
  const q = new URLSearchParams({ origen: f.origen.value, destino: f.destino.value, fecha: f.fecha.value });
  const viajes = await api('GET', `/api/viajes?${q}`);
  const cont = $('#viajes');
  cont.innerHTML = viajes.length ? '' : '<p class="vacio">No hay salidas disponibles para esta búsqueda.</p>';
  for (const v of viajes) {
    const b = document.createElement('button');
    b.className = 'viaje';
    b.disabled = v.libres === 0;
    b.innerHTML = `
      <span class="hora">${hora(v.salida)}</span>
      <span><b>${esc(v.origen)} → ${esc(v.destino)}</b></span>
      <span class="meta">${fechaHora(v.salida)} · ${duracion(v.duracionMin)} · ${esc(v.placa)}</span>
      <span class="meta">${v.libres === 0 ? 'Agotado' : `${v.libres} de ${v.total} asientos libres`}</span>
      <span class="precio">desde ${soles(v.precio)}</span>`;
    b.addEventListener('click', () => abrirViaje(v.id));
    cont.append(b);
  }
}

// ---------- Mapa de asientos ----------
async function abrirViaje(id) {
  estado.eventos?.close();
  const d = await api('GET', `/api/viajes/${id}?clienteId=${clienteId}`);
  estado.viaje = d.viaje;
  estado.miTitular = d.miTitular;
  estado.maxAsientos = d.maxAsientos;
  estado.asientos = new Map(d.asientos.map((a) => [a.id, a]));
  $('#venta').classList.remove('oculto');
  $('#titulo-viaje').textContent = `${d.viaje.origen} → ${d.viaje.destino}`;
  $('#meta-viaje').textContent = `${fechaHora(d.viaje.salida)} · ${d.viaje.modelo} · Placa ${d.viaje.placa}`;
  dibujarMapa();
  dibujarResumen();
  conectarTiempoReal(id);
  $('#venta').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function conectarTiempoReal(id) {
  const indicador = $('#envivo');
  const es = new EventSource(`/api/viajes/${id}/eventos`);
  estado.eventos = es;
  es.addEventListener('open', async () => {
    indicador.className = 'envivo conectado';
    indicador.textContent = 'En vivo';
    // Al reconectar puede haberse perdido algún evento: se resincroniza el mapa completo.
    const d = await api('GET', `/api/viajes/${id}?clienteId=${clienteId}`);
    if (estado.viaje?.id !== id) return;
    estado.asientos = new Map(d.asientos.map((a) => [a.id, a]));
    dibujarMapa();
    dibujarResumen();
  });
  es.addEventListener('error', () => {
    indicador.className = 'envivo';
    indicador.textContent = 'Reconectando…';
  });
  es.addEventListener('espectadores', (e) => {
    const { total } = JSON.parse(e.data);
    if (es.readyState === EventSource.OPEN) indicador.textContent = `En vivo · ${total} ${total === 1 ? 'persona' : 'personas'} viendo`;
  });
  es.addEventListener('asiento', (e) => actualizarAsiento(JSON.parse(e.data), true));
}

function actualizarAsiento(a, desdeServidor = false) {
  const anterior = estado.asientos.get(a.id);
  const eraMio = anterior && esMio(anterior);
  estado.asientos.set(a.id, a);
  const btn = document.querySelector(`[data-asiento="${a.id}"]`);
  if (btn) {
    pintarAsiento(btn, a);
    if (desdeServidor && !esMio(a) && anterior?.estado !== a.estado) {
      btn.classList.remove('destello');
      void btn.offsetWidth;
      btn.classList.add('destello');
    }
  }
  if (eraMio && !esMio(a) && a.estado === 'LIBRE' && desdeServidor) {
    aviso(`Tu reserva del asiento ${a.numero} venció y fue liberada`, 'error');
  }
  if (eraMio !== esMio(a)) dibujarResumen();
}

const esMio = (a) => a.estado === 'RESERVADO' && a.titular === estado.miTitular;

function pintarAsiento(btn, a) {
  const clase = a.estado === 'VENDIDO' ? 'vendido' : a.estado === 'RESERVADO' ? (esMio(a) ? 'mio' : 'otro') : 'libre';
  btn.className = `asiento ${clase} ${a.recargo > 0 ? 'vip' : ''}`;
  btn.disabled = clase === 'vendido' || clase === 'otro';
  const texto = { libre: 'libre', mio: 'seleccionado por ti', otro: 'reservado por otro cliente', vendido: 'vendido' }[clase];
  btn.title = `Asiento ${a.numero} · ${a.tipo} · ${soles(estado.viaje.precio + a.recargo)} · ${texto}`;
  btn.setAttribute('aria-label', btn.title);
}

function dibujarMapa() {
  const cont = $('#pisos');
  cont.innerHTML = '';
  const pisos = Map.groupBy([...estado.asientos.values()], (a) => a.piso);
  for (const [piso, asientos] of [...pisos].sort((x, y) => x[0] - y[0])) {
    const columnas = Math.max(...asientos.map((a) => a.columna));
    const div = document.createElement('div');
    div.className = 'piso';
    div.innerHTML = `<h3>Piso ${piso} · ${esc(asientos[0].tipo)}</h3><div class="frente">${piso === 1 ? '🚍 Conductor' : '⬆ Frente'}</div>`;
    const grilla = document.createElement('div');
    grilla.className = 'grilla';
    grilla.style.gridTemplateColumns = `repeat(${columnas}, 42px)`;
    for (const a of asientos) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.numero;
      btn.dataset.asiento = a.id;
      btn.style.gridRow = a.fila;
      btn.style.gridColumn = a.columna;
      pintarAsiento(btn, a);
      btn.addEventListener('click', () => alternarAsiento(a.id));
      grilla.append(btn);
    }
    div.append(grilla);
    cont.append(div);
  }
}

async function alternarAsiento(id) {
  if (estado.enCurso.has(id)) return;
  const a = estado.asientos.get(id);
  const url = `/api/viajes/${estado.viaje.id}/asientos/${id}/bloqueo`;
  estado.enCurso.add(id);
  try {
    if (esMio(a)) {
      await api('DELETE', `${url}?clienteId=${clienteId}`);
      actualizarAsiento({ ...a, estado: 'LIBRE', titular: null, reservadoHasta: null });
    } else {
      actualizarAsiento(await api('POST', url, { clienteId }));
    }
  } catch (err) {
    if (err.datos?.asiento) actualizarAsiento(err.datos.asiento);
    aviso(err.message, 'error');
  } finally {
    estado.enCurso.delete(id);
  }
}

// ---------- Resumen y compra ----------
const misAsientos = () => [...estado.asientos.values()].filter(esMio).sort((a, b) => a.numero - b.numero);

function dibujarResumen() {
  const mios = misAsientos();
  const cont = $('#pasajeros');
  if (!mios.length) {
    cont.innerHTML = `<p class="vacio">Elige tus asientos en el mapa (máx. ${estado.maxAsientos}).</p>`;
  } else {
    cont.innerHTML = '';
    for (const a of mios) {
      const d = estado.datos.get(a.id) ?? { nombre: '', documento: '' };
      const div = document.createElement('div');
      div.className = 'pasajero';
      div.innerHTML = `
        <div class="titulo"><span>Asiento ${a.numero}</span><small>${esc(a.tipo)} · ${soles(estado.viaje.precio + a.recargo)}</small></div>
        <label>Nombre completo <input name="nombre" required minlength="3" maxlength="80" autocomplete="name" value="${esc(d.nombre)}"></label>
        <label>DNI / Pasaporte <input name="documento" required pattern="[A-Za-z0-9]{8,12}" maxlength="12" value="${esc(d.documento)}"></label>`;
      div.addEventListener('input', () => {
        estado.datos.set(a.id, {
          nombre: div.querySelector('[name=nombre]').value,
          documento: div.querySelector('[name=documento]').value,
        });
      });
      cont.append(div);
    }
  }
  $('#total').textContent = soles(mios.reduce((s, a) => s + estado.viaje.precio + a.recargo, 0));
  $('#btn-comprar').disabled = !mios.length;
  actualizarTemporizador();
}

function actualizarTemporizador() {
  const el = $('#temporizador');
  const mios = misAsientos();
  if (!mios.length) return el.classList.add('oculto');
  const restante = Math.max(0, Math.min(...mios.map((a) => a.reservadoHasta)) - Date.now());
  const m = Math.floor(restante / 60000);
  const s = Math.floor((restante % 60000) / 1000);
  el.classList.remove('oculto');
  el.classList.toggle('urgente', restante < 60_000);
  el.textContent = `⏱ Tus asientos están reservados por ${m}:${String(s).padStart(2, '0')}`;
}
setInterval(actualizarTemporizador, 1000);

async function comprarBoletos(e) {
  e.preventDefault();
  const btn = $('#btn-comprar');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Procesando…';
  try {
    const pasajeros = misAsientos().map((a) => ({ asientoId: a.id, ...estado.datos.get(a.id) }));
    const { boletos } = await api('POST', `/api/viajes/${estado.viaje.id}/compras`, { clienteId, pasajeros });
    for (const p of pasajeros) estado.datos.delete(p.asientoId);
    for (const b of boletos) {
      const a = estado.asientos.get(b.asientoId);
      actualizarAsiento({ ...a, estado: 'VENDIDO', titular: null, reservadoHasta: null });
    }
    mostrarBoletos(boletos);
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.textContent = 'Pagar y emitir boletos';
    btn.disabled = !misAsientos().length;
  }
}

function mostrarBoletos(boletos) {
  const lista = $('#lista-boletos');
  lista.innerHTML = boletos.map((b) => `
    <a href="ticket.html?codigo=${b.codigo}" target="_blank" rel="noopener">
      <span>Asiento <b>${b.numero}</b> · ${b.codigo}</span><span>🖨 Imprimir 58 mm</span>
    </a>`).join('');
  $('#dialogo-boletos').showModal();
}

$('#filtros').addEventListener('submit', buscar);
$('#form-compra').addEventListener('submit', comprarBoletos);
$('#cerrar-dialogo').addEventListener('click', () => $('#dialogo-boletos').close());
await cargarCiudades();
await buscar();
