import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { abrirDB } from './db.js';
import { sembrarCatalogo, asegurarProgramacion } from './seed.js';
import { crearAdminInicial } from './auth.js';
import { crearApp } from './server.js';

try {
  process.loadEnvFile();
} catch {
  // sin archivo .env: se usan variables del entorno o valores por defecto
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = acepta conexiones de otras computadoras de la LAN
const DB_PATH = process.env.DB_PATH || './data/boletos.db';
const TTL_MS = Number(process.env.BLOQUEO_MINUTOS || 5) * 60_000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = abrirDB(DB_PATH);
sembrarCatalogo(db);
asegurarProgramacion(db);
setInterval(() => asegurarProgramacion(db), 3_600_000).unref();

// Los secretos deben ser estables entre reinicios: si no vienen por entorno se generan y se guardan en la BD.
function secretoPersistente(clave, valorEntorno) {
  if (valorEntorno) return valorEntorno;
  db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run(clave, randomBytes(32).toString('hex'));
  return db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave).valor;
}
const secreto = secretoPersistente('qr_secret', process.env.QR_SECRET);
const secretoSesion = secretoPersistente('sesion_secret', process.env.SESION_SECRET);

const usuarioAdmin = process.env.ADMIN_USUARIO || 'admin';
const passwordAdmin = process.env.ADMIN_PASSWORD || 'admin123';
if (crearAdminInicial(db, usuarioAdmin, passwordAdmin) && !process.env.ADMIN_PASSWORD) {
  console.warn(`⚠️  Se creó el usuario "${usuarioAdmin}" con la contraseña por defecto "admin123". Cámbiala con ADMIN_PASSWORD.`);
}

const impresora = process.env.PRINTER_HOST
  ? { host: process.env.PRINTER_HOST, port: Number(process.env.PRINTER_PORT || 9100) }
  : null;

// Direcciones IPv4 de esta computadora en la red local: son las que deben abrir los clientes.
// Los adaptadores virtuales (VirtualBox, WSL, Hyper-V, Docker, VPN) no sirven para el celular:
// se marcan y se listan al final para no confundirlos con el Wi-Fi o el cable real.
const VIRTUAL = /vethernet|virtualbox|vbox|vmware|wsl|hyper-v|docker|br-|veth|tailscale|zerotier|hamachi|vpn|tun|tap/i;
function urlsRed() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([interfaz, ips]) => (ips ?? []).map((i) => ({ ...i, interfaz })))
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => ({ url: `http://${i.address}:${PORT}`, interfaz: i.interfaz, virtual: VIRTUAL.test(i.interfaz) }))
    .sort((a, b) => a.virtual - b.virtual);
}

const { app } = crearApp({ db, secreto, secretoSesion, ttlMs: TTL_MS, impresora, urlsRed });
app.listen(PORT, HOST, () => {
  console.log('🐍 Las Cobras Viajes — servidor iniciado (Computadora 1)\n');
  console.log('   ADMINISTRADOR (en esta computadora):');
  console.log(`     http://localhost:${PORT}/admin/\n`);
  console.log('   CLIENTES (desde otras computadoras de la red local):');
  for (const r of urlsRed()) {
    console.log(`     ${`${r.url}/`.padEnd(28)} (${r.interfaz})${r.virtual ? '  ← adaptador virtual, probablemente NO es tu Wi-Fi' : ''}`);
  }
  if (!urlsRed().length) console.log('     (sin red local detectada)');
  console.log('\n   ¿El celular no abre la página? Debe estar en el mismo Wi-Fi y el Firewall debe permitir el puerto');
  console.log(`   ${PORT}. Desde el celular, prueba primero: <dirección>/api/ping\n`);
});
