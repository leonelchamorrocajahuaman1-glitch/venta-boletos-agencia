import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const COOKIE = 'lcv_admin';
export const DURACION_SESION_MS = 12 * 3_600_000;

export function hashPassword(password) {
  const sal = randomBytes(16);
  return `${sal.toString('hex')}:${scryptSync(password, sal, 32).toString('hex')}`;
}

export function verificarPassword(password, guardado) {
  const [sal, hash] = String(guardado).split(':');
  if (!sal || !hash) return false;
  const calculado = scryptSync(String(password), Buffer.from(sal, 'hex'), 32);
  return timingSafeEqual(calculado, Buffer.from(hash, 'hex'));
}

// Token de sesión sin estado: usuario.expiracion.firma (HMAC). Sobrevive a reinicios del servidor.
const firmar = (datos, secreto) => createHmac('sha256', secreto).update(datos).digest('hex');

export function crearToken(usuario, secreto, ahora = Date.now()) {
  const datos = `${usuario}.${ahora + DURACION_SESION_MS}`;
  return `${datos}.${firmar(datos, secreto)}`;
}

export function leerToken(token, secreto, ahora = Date.now()) {
  const partes = String(token ?? '').split('.');
  if (partes.length !== 3) return null;
  const [usuario, exp, firma] = partes;
  const esperada = Buffer.from(firmar(`${usuario}.${exp}`, secreto));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  return Number(exp) > ahora ? usuario : null;
}

export function leerCookie(req) {
  for (const par of String(req.headers.cookie ?? '').split(';')) {
    const [nombre, ...resto] = par.trim().split('=');
    if (nombre === COOKIE) return decodeURIComponent(resto.join('='));
  }
  return null;
}

export function cookieSesion(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACION_SESION_MS / 1000}`;
}

export const cookieCerrada = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function crearAdminInicial(db, usuario, password) {
  const hay = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
  if (hay) return false;
  db.prepare("INSERT INTO usuarios (usuario, nombre, password_hash, rol) VALUES (?, ?, ?, 'ADMIN')")
    .run(usuario, 'Administrador', hashPassword(password));
  return true;
}

// Freno simple contra fuerza bruta: 5 intentos fallidos por IP bloquean 1 minuto.
export class LimiteIntentos {
  constructor({ maximo = 5, ventanaMs = 60_000 } = {}) {
    this.maximo = maximo;
    this.ventanaMs = ventanaMs;
    this.fallos = new Map();
  }
  bloqueado(ip, ahora = Date.now()) {
    const f = this.fallos.get(ip);
    if (f && ahora - f.desde > this.ventanaMs) this.fallos.delete(ip);
    return (this.fallos.get(ip)?.n ?? 0) >= this.maximo;
  }
  fallo(ip, ahora = Date.now()) {
    const f = this.fallos.get(ip) ?? { n: 0, desde: ahora };
    f.n++;
    this.fallos.set(ip, f);
  }
  exito(ip) {
    this.fallos.delete(ip);
  }
}
