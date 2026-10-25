import { transaccion } from './db.js';
import { ErrorNegocio } from './ventas.js';
import { fechaLocal, inicioDelDia, horaLocal, DIA_MS } from './tiempo.js';

const rangoDelDia = (fecha) => {
  const inicio = inicioDelDia(fecha);
  if (inicio === null) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'Fecha inválida');
  return { inicio, fin: inicio + DIA_MS };
};

const SQL_SALIDAS = `
  SELECT v.id, v.salida, v.precio, v.estado, r.id AS rutaId, r.origen, r.destino, r.duracion_min AS duracionMin,
         b.id AS busId, b.placa, b.modelo,
         (SELECT COUNT(*) FROM asiento_viaje av WHERE av.viaje_id = v.id) AS total,
         (SELECT COUNT(*) FROM asiento_viaje av WHERE av.viaje_id = v.id
            AND av.estado = 'RESERVADO' AND av.reservado_hasta >= :ahora) AS reservados,
         (SELECT COUNT(*) FROM boletos bo WHERE bo.viaje_id = v.id AND bo.estado <> 'ANULADO') AS vendidos,
         (SELECT COUNT(*) FROM boletos bo WHERE bo.viaje_id = v.id AND bo.estado = 'EMBARCADO') AS embarcados,
         (SELECT COALESCE(SUM(bo.precio), 0) FROM boletos bo WHERE bo.viaje_id = v.id AND bo.estado <> 'ANULADO') AS ingresos
  FROM viajes v JOIN rutas r ON r.id = v.ruta_id JOIN buses b ON b.id = v.bus_id`;

export function listarSalidas(db, { fecha }, ahora = Date.now()) {
  const { inicio, fin } = rangoDelDia(fecha || fechaLocal(ahora));
  return db.prepare(`${SQL_SALIDAS} WHERE v.salida >= :inicio AND v.salida < :fin ORDER BY v.salida, r.origen`)
    .all({ ahora, inicio, fin });
}

export function resumen(db, ahora = Date.now()) {
  const { inicio, fin } = rangoDelDia(fechaLocal(ahora));
  const uno = (sql, ...p) => db.prepare(sql).get(...p);
  const ventas = uno(`SELECT COUNT(*) AS n, COALESCE(SUM(precio), 0) AS total FROM boletos
                      WHERE estado <> 'ANULADO' AND vendido_en >= ? AND vendido_en < ?`, inicio, fin);
  return {
    ventasHoy: ventas.n,
    ingresosHoy: ventas.total,
    embarcadosHoy: uno("SELECT COUNT(*) AS n FROM boletos WHERE estado = 'EMBARCADO' AND embarcado_en >= ? AND embarcado_en < ?", inicio, fin).n,
    anuladosHoy: uno("SELECT COUNT(*) AS n FROM boletos WHERE estado = 'ANULADO' AND anulado_en >= ? AND anulado_en < ?", inicio, fin).n,
    comprandoAhora: uno("SELECT COUNT(*) AS n FROM asiento_viaje WHERE estado = 'RESERVADO' AND reservado_hasta >= ?", ahora).n,
    salidasHoy: uno("SELECT COUNT(*) AS n FROM viajes WHERE estado = 'PROGRAMADO' AND salida >= ? AND salida < ?", inicio, fin).n,
    proximas: db.prepare(`${SQL_SALIDAS} WHERE v.estado = 'PROGRAMADO' AND v.salida > :ahora ORDER BY v.salida LIMIT 8`).all({ ahora }),
    ultimasVentas: db.prepare(`
      SELECT bo.codigo, bo.pasajero_nombre AS pasajero, bo.precio, bo.vendido_en AS vendidoEn, bo.estado,
             a.numero AS asiento, r.origen, r.destino, v.salida
      FROM boletos bo JOIN asientos a ON a.id = bo.asiento_id JOIN viajes v ON v.id = bo.viaje_id JOIN rutas r ON r.id = v.ruta_id
      ORDER BY bo.vendido_en DESC LIMIT 8`).all(),
  };
}

export function catalogo(db) {
  return {
    rutas: db.prepare('SELECT id, origen, destino, duracion_min AS duracionMin, precio_base AS precioBase FROM rutas ORDER BY origen, destino').all(),
    buses: db.prepare(`SELECT b.id, b.placa, b.modelo, COUNT(a.id) AS asientos
                       FROM buses b JOIN asientos a ON a.bus_id = b.id GROUP BY b.id ORDER BY b.placa`).all(),
  };
}

export function crearSalida(db, { rutaId, busId, fecha, hora, precio }, ahora = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora))) {
    throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'Fecha u hora inválida');
  }
  const salida = horaLocal(fecha, hora);
  const centimos = Math.round(Number(precio) * 100);
  if (!Number.isFinite(salida) || salida <= ahora) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'La salida debe ser en el futuro');
  if (!Number.isSafeInteger(centimos) || centimos <= 0) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'Precio inválido');

  return transaccion(db, () => {
    const ruta = db.prepare('SELECT id, duracion_min FROM rutas WHERE id = ?').get(Number(rutaId));
    const bus = db.prepare('SELECT id, placa FROM buses WHERE id = ?').get(Number(busId));
    if (!ruta || !bus) throw new ErrorNegocio(404, 'NO_ENCONTRADO', 'Ruta o bus inexistente');
    // El bus no puede estar en otro viaje que se cruce en el tiempo.
    const llegada = salida + ruta.duracion_min * 60_000;
    const cruce = db.prepare(`
      SELECT v.salida, r.origen, r.destino FROM viajes v JOIN rutas r ON r.id = v.ruta_id
      WHERE v.bus_id = ? AND v.estado = 'PROGRAMADO'
        AND v.salida < ? AND v.salida + r.duracion_min * 60000 > ?`).get(bus.id, llegada, salida);
    if (cruce) {
      throw new ErrorNegocio(409, 'BUS_OCUPADO', `El bus ${bus.placa} ya está asignado al viaje ${cruce.origen} → ${cruce.destino} en ese horario`);
    }
    if (db.prepare('SELECT 1 FROM viajes WHERE ruta_id = ? AND salida = ?').get(ruta.id, salida)) {
      throw new ErrorNegocio(409, 'SALIDA_DUPLICADA', 'Ya existe una salida de esa ruta a esa hora');
    }
    const id = Number(db.prepare('INSERT INTO viajes (ruta_id, bus_id, salida, precio) VALUES (?, ?, ?, ?)')
      .run(ruta.id, bus.id, salida, centimos).lastInsertRowid);
    db.prepare("INSERT INTO asiento_viaje (viaje_id, asiento_id, estado) SELECT ?, id, 'LIBRE' FROM asientos WHERE bus_id = ?")
      .run(id, bus.id);
    return db.prepare(`${SQL_SALIDAS} WHERE v.id = :id`).get({ ahora, id });
  });
}

export function cancelarSalida(db, viajeId, ahora = Date.now()) {
  return transaccion(db, () => {
    const v = db.prepare('SELECT id, estado FROM viajes WHERE id = ?').get(Number(viajeId));
    if (!v) throw new ErrorNegocio(404, 'VIAJE_NO_EXISTE', 'El viaje no existe');
    if (v.estado === 'CANCELADO') throw new ErrorNegocio(409, 'YA_CANCELADO', 'La salida ya estaba cancelada');
    const activos = db.prepare("SELECT COUNT(*) AS n FROM boletos WHERE viaje_id = ? AND estado <> 'ANULADO'").get(v.id).n;
    if (activos) {
      throw new ErrorNegocio(409, 'TIENE_BOLETOS', `La salida tiene ${activos} boleto(s) vendido(s). Anúlalos antes de cancelarla.`);
    }
    db.prepare("UPDATE viajes SET estado = 'CANCELADO' WHERE id = ?").run(v.id);
    db.prepare(`UPDATE asiento_viaje SET estado = 'LIBRE', reservado_por = NULL, reservado_hasta = NULL, version = version + 1
                WHERE viaje_id = ? AND estado = 'RESERVADO'`).run(v.id);
    return db.prepare(`${SQL_SALIDAS} WHERE v.id = :id`).get({ ahora, id: v.id });
  });
}

export function listarVentas(db, { fecha, q } = {}) {
  const texto = String(q ?? '').trim();
  const rango = fecha ? rangoDelDia(fecha) : null;
  return db.prepare(`
    SELECT bo.codigo, bo.estado, bo.pasajero_nombre AS pasajero, bo.pasajero_doc AS documento, bo.precio,
           bo.vendido_en AS vendidoEn, bo.embarcado_en AS embarcadoEn, bo.anulado_en AS anuladoEn,
           a.numero AS asiento, v.id AS viajeId, v.salida, r.origen, r.destino, b.placa
    FROM boletos bo
    JOIN asientos a ON a.id = bo.asiento_id
    JOIN viajes v ON v.id = bo.viaje_id
    JOIN rutas r ON r.id = v.ruta_id
    JOIN buses b ON b.id = v.bus_id
    WHERE (:inicio IS NULL OR (bo.vendido_en >= :inicio AND bo.vendido_en < :fin))
      AND (:q = '' OR bo.codigo = UPPER(:q) OR bo.pasajero_doc = UPPER(:q) OR bo.pasajero_nombre LIKE '%' || :q || '%')
    ORDER BY bo.vendido_en DESC LIMIT 300`).all({ inicio: rango?.inicio ?? null, fin: rango?.fin ?? null, q: texto });
}

// Día contable en hora de Lima (UTC-5) calculado dentro de SQLite.
const DIA_LIMA = "date((bo.vendido_en / 1000) - 18000, 'unixepoch')";

export function reportes(db, { desde, hasta }, ahora = Date.now()) {
  const hoy = fechaLocal(ahora);
  desde = desde || fechaLocal(ahora - 6 * DIA_MS);
  hasta = hasta || hoy;
  const inicio = rangoDelDia(desde).inicio;
  const fin = rangoDelDia(hasta).fin;
  if (fin <= inicio) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'El rango de fechas es inválido');
  const p = { inicio, fin };
  const filtro = "bo.estado <> 'ANULADO' AND bo.vendido_en >= :inicio AND bo.vendido_en < :fin";
  const totales = db.prepare(`SELECT COUNT(*) AS boletos, COALESCE(SUM(bo.precio), 0) AS ingresos FROM boletos bo WHERE ${filtro}`).get(p);
  const anulados = db.prepare(`SELECT COUNT(*) AS n FROM boletos bo
    WHERE bo.estado = 'ANULADO' AND bo.vendido_en >= :inicio AND bo.vendido_en < :fin`).get(p).n;
  const porRuta = db.prepare(`
    SELECT r.origen, r.destino, COUNT(*) AS boletos, SUM(bo.precio) AS ingresos
    FROM boletos bo JOIN viajes v ON v.id = bo.viaje_id JOIN rutas r ON r.id = v.ruta_id
    WHERE ${filtro} GROUP BY r.id ORDER BY ingresos DESC`).all(p);
  const porDiaBD = new Map(db.prepare(`
    SELECT ${DIA_LIMA} AS fecha, COUNT(*) AS boletos, SUM(bo.precio) AS ingresos
    FROM boletos bo WHERE ${filtro} GROUP BY 1`).all(p).map((d) => [d.fecha, d]));
  // Se incluyen los días sin ventas para que la serie no tenga huecos engañosos.
  const porDia = [];
  for (let t = inicio; t < fin && porDia.length < 92; t += DIA_MS) {
    const f = fechaLocal(t + 12 * 3_600_000);
    porDia.push(porDiaBD.get(f) ?? { fecha: f, boletos: 0, ingresos: 0 });
  }
  return { desde, hasta, ...totales, anulados, porRuta, porDia };
}

export function ventasCSV(db, { desde, hasta }, ahora = Date.now()) {
  const { desde: d, hasta: h } = reportes(db, { desde, hasta }, ahora);
  const filas = db.prepare(`
    SELECT bo.codigo, bo.estado, bo.pasajero_nombre, bo.pasajero_doc, bo.precio, bo.vendido_en,
           a.numero AS asiento, r.origen, r.destino, v.salida, b.placa
    FROM boletos bo JOIN asientos a ON a.id = bo.asiento_id JOIN viajes v ON v.id = bo.viaje_id
    JOIN rutas r ON r.id = v.ruta_id JOIN buses b ON b.id = v.bus_id
    WHERE bo.vendido_en >= ? AND bo.vendido_en < ? ORDER BY bo.vendido_en`).all(rangoDelDia(d).inicio, rangoDelDia(h).fin);
  const iso = (ms) => new Date(ms - 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  const celda = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const cabecera = ['codigo', 'estado', 'pasajero', 'documento', 'precio_soles', 'vendido', 'origen', 'destino', 'salida', 'bus', 'asiento'];
  const lineas = filas.map((f) => [f.codigo, f.estado, f.pasajero_nombre, f.pasajero_doc, (f.precio / 100).toFixed(2),
    iso(f.vendido_en), f.origen, f.destino, iso(f.salida), f.placa, f.asiento].map(celda).join(','));
  return { nombre: `ventas_${d}_a_${h}.csv`, contenido: `﻿${[cabecera.join(','), ...lineas].join('\r\n')}\r\n` };
}
