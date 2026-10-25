import net from 'node:net';
import { formatear } from './tiempo.js';

// Comandos ESC/POS para impresoras térmicas de 58 mm (384 puntos, 32 columnas en fuente A).
const ESC = 0x1b;
const GS = 0x1d;
export const COLUMNAS = 32;

// Las térmicas usan páginas de códigos (CP437/CP850); se envía ASCII puro
// quitando tildes para que se lea igual en cualquier modelo.
export function ascii(texto) {
  return String(texto ?? '')
    .replace(/°/g, 'o')
    .replace(/→/g, '>')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

const soles = (c) => `S/ ${(c / 100).toFixed(2)}`;

export function ticketEscPos(b, contenidoQR) {
  const partes = [];
  const cmd = (...bytes) => partes.push(Buffer.from(bytes));
  const linea = (s = '') => partes.push(Buffer.from(`${ascii(s).slice(0, COLUMNAS)}\n`, 'ascii'));
  const par = (izq, der) => {
    der = ascii(der);
    izq = ascii(izq).slice(0, Math.max(0, COLUMNAS - der.length - 1));
    linea(izq + ' '.repeat(COLUMNAS - izq.length - der.length) + der);
  };
  const separador = () => linea('-'.repeat(COLUMNAS));
  const alinear = (n) => cmd(ESC, 0x61, n); // 0 izq, 1 centro
  const negrita = (on) => cmd(ESC, 0x45, on ? 1 : 0);
  const tamano = (n) => cmd(GS, 0x21, n); // 0x00 normal, 0x11 doble ancho y alto

  cmd(ESC, 0x40); // reiniciar
  alinear(1);
  tamano(0x11); negrita(true); linea('LAS COBRAS'); tamano(0); linea('VIAJES'); negrita(false);
  linea('Boleto de viaje');
  separador();
  tamano(0x11); negrita(true); linea(`${b.origen} > ${b.destino}`); tamano(0); negrita(false);
  linea(formatear(b.salida));
  separador();
  alinear(0);
  negrita(true); par('ASIENTO', `${b.asiento} (piso ${b.piso})`); negrita(false);
  par('Servicio', b.tipo);
  par('Bus', b.placa);
  linea('Pasajero:');
  linea(b.pasajero);
  par('Documento', b.documento);
  separador();
  negrita(true); par('TOTAL', soles(b.precio)); negrita(false);
  separador();
  alinear(1);

  // QR nativo de la impresora (GS ( k): modelo 2, módulo 6, corrección M.
  const datos = Buffer.from(contenidoQR, 'ascii');
  const n = datos.length + 3;
  cmd(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00);
  cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6);
  cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);
  cmd(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30);
  partes.push(datos);
  cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);

  negrita(true); linea(b.codigo); negrita(false);
  linea('Presentese 30 min antes');
  linea('con su documento de identidad');
  linea(`Emitido ${formatear(b.vendidoEn)}`);
  cmd(ESC, 0x64, 4); // avanzar 4 líneas
  cmd(GS, 0x56, 0x42, 0x00); // corte parcial
  return Buffer.concat(partes);
}

// Envío directo a una térmica de red por el puerto RAW (normalmente 9100).
export function enviarAImpresora(buffer, host, port = 9100, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => socket.end(buffer));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('La impresora no respondió a tiempo')));
    socket.on('error', reject);
    socket.on('close', (conError) => { if (!conError) resolve(); });
  });
}
