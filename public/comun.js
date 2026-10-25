export const soles = (centimos) => `S/ ${(centimos / 100).toFixed(2)}`;

const fmt = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtHora = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false });
export const fechaHora = (ms) => fmt.format(ms);
export const hora = (ms) => fmtHora.format(ms);
export const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(Date.now());
export const duracion = (min) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;

export async function api(metodo, ruta, cuerpo) {
  let res;
  try {
    res = await fetch(ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new Error('Sin conexión con el servidor. Revisa la red e inténtalo de nuevo.');
  }
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401 && location.pathname.startsWith('/admin/') && !location.pathname.endsWith('login.html')) {
    location.href = `/admin/login.html?volver=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }
  if (!res.ok) {
    const err = new Error(datos.mensaje || `Error ${res.status}`);
    Object.assign(err, { status: res.status, datos });
    throw err;
  }
  return datos;
}

let temporizadorAviso;
export function aviso(texto, tipo = '') {
  let el = document.querySelector('.aviso');
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.className = `aviso ${tipo}`;
  el.textContent = texto;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => el.remove(), 3500);
}

// crypto.randomUUID solo existe en contextos seguros (https/localhost); getRandomValues funciona siempre.
export function idAleatorio() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Si el servidor no responde, se explica en pantalla en vez de dejar la página vacía.
export function mostrarErrorConexion(err) {
  const main = document.querySelector('main');
  const caja = document.createElement('section');
  caja.className = 'panel error-conexion';
  caja.innerHTML = `
    <h2>⚠️ No se pudo conectar con el servidor</h2>
    <p>${esc(err?.message ?? err)}</p>
    <ul>
      <li>Verifica que la computadora servidor siga encendida con <code>npm start</code> en ejecución.</li>
      <li>Este dispositivo debe estar en la <b>misma red Wi-Fi</b> que el servidor (sin datos móviles).</li>
      <li>Usa la dirección que muestra el servidor, no <code>localhost</code>.</li>
    </ul>
    <button type="button" onclick="location.reload()">Reintentar</button>`;
  main.prepend(caja);
}
