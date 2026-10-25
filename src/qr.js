import { createHmac, timingSafeEqual } from 'node:crypto';

// Formato del contenido del QR: LCV1.<codigo>.<firma>
// La firma (HMAC-SHA256 truncado, en hexadecimal) impide fabricar boletos
// válidos aunque alguien adivine el formato del código. Solo usa [A-Z0-9.]
// para que los lectores USB con distribución de teclado latina no lo alteren.
const PREFIJO = 'LCV1';

export function firmar(codigo, secreto) {
  return createHmac('sha256', secreto).update(`${PREFIJO}.${codigo}`).digest('hex').slice(0, 20).toUpperCase();
}

export function contenidoQR(codigo, secreto) {
  return `${PREFIJO}.${codigo}.${firmar(codigo, secreto)}`;
}

export function verificarQR(texto, secreto) {
  const partes = String(texto ?? '').trim().toUpperCase().split('.');
  if (partes.length !== 3 || partes[0] !== PREFIJO) return null;
  const [, codigo, firma] = partes;
  const esperada = Buffer.from(firmar(codigo, secreto));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  return codigo;
}
