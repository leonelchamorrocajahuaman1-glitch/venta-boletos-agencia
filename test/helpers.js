import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abrirDB } from '../src/db.js';
import { sembrarCatalogo, asegurarProgramacion } from '../src/seed.js';

export function bdTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boletos-test-'));
  const ruta = path.join(dir, 'test.db');
  const db = abrirDB(ruta);
  sembrarCatalogo(db);
  asegurarProgramacion(db, Date.now(), 2);
  const viaje = db.prepare('SELECT id FROM viajes WHERE salida > ? ORDER BY salida LIMIT 1').get(Date.now() + 3_600_000);
  const asientos = db.prepare('SELECT asiento_id AS id FROM asiento_viaje WHERE viaje_id = ? ORDER BY asiento_id')
    .all(viaje.id).map((a) => a.id);
  return { db, ruta, viajeId: viaje.id, asientos, limpiar: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
