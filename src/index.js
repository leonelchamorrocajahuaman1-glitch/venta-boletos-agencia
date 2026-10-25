import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { abrirDB } from './db.js';
import { sembrarCatalogo, asegurarProgramacion } from './seed.js';
import { crearApp } from './server.js';

try {
  process.loadEnvFile();
} catch {
  // sin archivo .env: se usan variables del entorno o valores por defecto
}

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH || './data/boletos.db';
const TTL_MS = Number(process.env.BLOQUEO_MINUTOS || 5) * 60_000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = abrirDB(DB_PATH);
sembrarCatalogo(db);
asegurarProgramacion(db);
setInterval(() => asegurarProgramacion(db), 3_600_000).unref();

// El secreto de los QR debe ser estable: si no viene por entorno se genera uno y se guarda en la BD.
let secreto = process.env.QR_SECRET;
if (!secreto) {
  db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run('qr_secret', randomBytes(32).toString('hex'));
  secreto = db.prepare("SELECT valor FROM config WHERE clave = 'qr_secret'").get().valor;
}

const impresora = process.env.PRINTER_HOST
  ? { host: process.env.PRINTER_HOST, port: Number(process.env.PRINTER_PORT || 9100) }
  : null;

const { app } = crearApp({ db, secreto, ttlMs: TTL_MS, impresora });
app.listen(PORT, () => {
  console.log(`🐍 Las Cobras Viajes escuchando en http://localhost:${PORT}`);
  console.log(`   Venta:    http://localhost:${PORT}/`);
  console.log(`   Embarque: http://localhost:${PORT}/embarque.html`);
});
