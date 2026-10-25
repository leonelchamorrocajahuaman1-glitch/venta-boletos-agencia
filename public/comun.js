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
  const res = await fetch(ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
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
