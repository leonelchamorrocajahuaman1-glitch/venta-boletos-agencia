import { createHash, randomBytes } from 'node:crypto';
import { transaccion } from './db.js';
import { verificarQR } from './qr.js';
import { inicioDelDia, DIA_MS } from './tiempo.js';

export const MAX_ASIENTOS_POR_CLIENTE = 6;

export class ErrorNegocio extends Error {
  constructor(status, codigo, mensaje, extra = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

// Identificador público del dueño de una reserva. Se difunde a todos los
// navegadores para pintar "mío / de otro" sin revelar el clienteId real
// (quien conoce el clienteId puede comprar los asientos reservados).
export function titularDe(clienteId) {
  return createHash('sha256').update(String(clienteId)).digest('hex').slice(0, 16);
}

function validarCliente(clienteId) {
  if (typeof clienteId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clienteId)) {
    throw new ErrorNegocio(400, 'CLIENTE_INVALIDO', 'Identificador de cliente inválido');
  }
}

function aEntero(valor, nombre) {
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', `${nombre} inválido`);
  return n;
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  return [...randomBytes(10)].map((b) => ALFABETO[b % ALFABETO.length]).join('');
}

function viajeAbierto(db, viajeId, ahora) {
  const v = db.prepare('SELECT id, salida, estado, precio FROM viajes WHERE id = ?').get(viajeId);
  if (!v) throw new ErrorNegocio(404, 'VIAJE_NO_EXISTE', 'El viaje no existe');
  if (v.estado !== 'PROGRAMADO' || v.salida <= ahora) {
    throw new ErrorNegocio(409, 'VIAJE_CERRADO', 'Las ventas para este viaje están cerradas');
  }
  return v;
}

const SQL_ASIENTOS = `
  SELECT a.id, a.numero, a.piso, a.fila, a.columna, a.tipo, a.recargo,
         av.estado, av.reservado_por, av.reservado_hasta
  FROM asiento_viaje av JOIN asientos a ON a.id = av.asiento_id
  WHERE av.viaje_id = ?`;

export function vistaAsiento(f, ahora) {
  // Una reserva vencida se considera libre aunque el barrido aún no la haya limpiado.
  const estado = f.estado === 'RESERVADO' && f.reservado_hasta < ahora ? 'LIBRE' : f.estado;
  const reservado = estado === 'RESERVADO';
  return {
    id: f.id,
    numero: f.numero,
    piso: f.piso,
    fila: f.fila,
    columna: f.columna,
    tipo: f.tipo,
    recargo: f.recargo,
    estado,
    titular: reservado ? titularDe(f.reservado_por) : null,
    reservadoHasta: reservado ? f.reservado_hasta : null,
  };
}

function leerAsiento(db, viajeId, asientoId, ahora) {
  const f = db.prepare(`${SQL_ASIENTOS} AND a.id = ?`).get(viajeId, asientoId);
  return f ? vistaAsiento(f, ahora) : null;
}

const SQL_VIAJES = `
  SELECT v.id, v.salida, v.precio, v.estado, r.origen, r.destino, r.duracion_min AS duracionMin,
         b.placa, b.modelo,
         (SELECT COUNT(*) FROM asiento_viaje av WHERE av.viaje_id = v.id
            AND (av.estado = 'LIBRE' OR (av.estado = 'RESERVADO' AND av.reservado_hasta < :ahora))) AS libres,
         (SELECT COUNT(*) FROM asiento_viaje av WHERE av.viaje_id = v.id) AS total
  FROM viajes v
  JOIN rutas r ON r.id = v.ruta_id
  JOIN buses b ON b.id = v.bus_id`;

export function listarViajes(db, { origen, destino, fecha, embarque } = {}, ahora = Date.now()) {
  const inicio = fecha ? inicioDelDia(fecha) : null;
  if (fecha && inicio === null) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'Fecha inválida');
  // Para embarque se muestran también los buses que salieron hace poco.
  const desde = embarque ? ahora - 6 * 3_600_000 : ahora;
  return db.prepare(`${SQL_VIAJES}
    WHERE v.salida > :desde
      AND v.estado = 'PROGRAMADO'
      AND (:origen IS NULL OR r.origen = :origen)
      AND (:destino IS NULL OR r.destino = :destino)
      AND (:inicio IS NULL OR (v.salida >= :inicio AND v.salida < :fin))
    ORDER BY v.salida LIMIT 100`).all({
    ahora,
    desde,
    origen: origen || null,
    destino: destino || null,
    inicio,
    fin: inicio === null ? null : inicio + DIA_MS,
  });
}

export function listarCiudades(db) {
  return {
    origenes: db.prepare('SELECT DISTINCT origen AS c FROM rutas ORDER BY 1').all().map((r) => r.c),
    destinos: db.prepare('SELECT DISTINCT destino AS c FROM rutas ORDER BY 1').all().map((r) => r.c),
  };
}

export function detalleViaje(db, viajeId, clienteId, ahora = Date.now()) {
  viajeId = aEntero(viajeId, 'Viaje');
  const viaje = db.prepare(`${SQL_VIAJES} WHERE v.id = :id`).get({ ahora, id: viajeId });
  if (!viaje) throw new ErrorNegocio(404, 'VIAJE_NO_EXISTE', 'El viaje no existe');
  const asientos = db.prepare(`${SQL_ASIENTOS} ORDER BY a.numero`).all(viajeId).map((f) => vistaAsiento(f, ahora));
  return {
    viaje,
    asientos,
    miTitular: clienteId ? titularDe(clienteId) : null,
    maxAsientos: MAX_ASIENTOS_POR_CLIENTE,
  };
}

/**
 * Bloqueo temporal de un asiento (mientras el cliente llena datos y paga).
 * La transición LIBRE -> RESERVADO es un único UPDATE condicional: si dos
 * clientes lo intentan a la vez, el motor serializa las escrituras y solo uno
 * obtiene `changes === 1`; el otro recibe 409.
 */
export function bloquear(db, { viajeId, asientoId, clienteId, ahora = Date.now(), ttlMs }) {
  validarCliente(clienteId);
  viajeId = aEntero(viajeId, 'Viaje');
  asientoId = aEntero(asientoId, 'Asiento');
  return transaccion(db, () => {
    viajeAbierto(db, viajeId, ahora);
    const propios = db.prepare(`
      SELECT COUNT(*) AS n FROM asiento_viaje
      WHERE viaje_id = ? AND estado = 'RESERVADO' AND reservado_por = ? AND reservado_hasta >= ? AND asiento_id <> ?`,
    ).get(viajeId, clienteId, ahora, asientoId).n;
    if (propios >= MAX_ASIENTOS_POR_CLIENTE) {
      throw new ErrorNegocio(409, 'LIMITE_ASIENTOS', `Máximo ${MAX_ASIENTOS_POR_CLIENTE} asientos por compra`);
    }
    const r = db.prepare(`
      UPDATE asiento_viaje
      SET estado = 'RESERVADO', reservado_por = ?, reservado_hasta = ?, version = version + 1
      WHERE viaje_id = ? AND asiento_id = ?
        AND (estado = 'LIBRE'
             OR (estado = 'RESERVADO' AND (reservado_hasta < ? OR reservado_por = ?)))`,
    ).run(clienteId, ahora + ttlMs, viajeId, asientoId, ahora, clienteId);
    if (r.changes !== 1) {
      const actual = leerAsiento(db, viajeId, asientoId, ahora);
      if (!actual) throw new ErrorNegocio(404, 'ASIENTO_NO_EXISTE', 'El asiento no existe en este viaje');
      throw new ErrorNegocio(409, 'ASIENTO_NO_DISPONIBLE', `El asiento ${actual.numero} ya no está disponible`, {
        asiento: actual,
      });
    }
    return leerAsiento(db, viajeId, asientoId, ahora);
  });
}

export function liberar(db, { viajeId, asientoId, clienteId, ahora = Date.now() }) {
  validarCliente(clienteId);
  viajeId = aEntero(viajeId, 'Viaje');
  asientoId = aEntero(asientoId, 'Asiento');
  const r = db.prepare(`
    UPDATE asiento_viaje
    SET estado = 'LIBRE', reservado_por = NULL, reservado_hasta = NULL, version = version + 1
    WHERE viaje_id = ? AND asiento_id = ? AND estado = 'RESERVADO' AND reservado_por = ?`,
  ).run(viajeId, asientoId, clienteId);
  return r.changes === 1 ? leerAsiento(db, viajeId, asientoId, ahora) : null;
}

// Barrido periódico: devuelve a LIBRE las reservas vencidas.
export function liberarVencidos(db, ahora = Date.now()) {
  return db.prepare(`
    UPDATE asiento_viaje
    SET estado = 'LIBRE', reservado_por = NULL, reservado_hasta = NULL, version = version + 1
    WHERE estado = 'RESERVADO' AND reservado_hasta < ?
    RETURNING viaje_id AS viajeId, asiento_id AS asientoId`,
  ).all(ahora).map(({ viajeId, asientoId }) => ({ viajeId, asiento: leerAsiento(db, viajeId, asientoId, ahora) }));
}

function validarPasajero(p) {
  const nombre = String(p?.nombre ?? '').trim().replace(/\s+/g, ' ');
  const documento = String(p?.documento ?? '').trim().toUpperCase();
  if (nombre.length < 3 || nombre.length > 80) {
    throw new ErrorNegocio(400, 'PASAJERO_INVALIDO', 'Ingresa el nombre completo de cada pasajero');
  }
  if (!/^[A-Z0-9]{8,12}$/.test(documento)) {
    throw new ErrorNegocio(400, 'PASAJERO_INVALIDO', `Documento inválido: "${documento}" (8 a 12 letras/dígitos)`);
  }
  return { asientoId: aEntero(p.asientoId, 'Asiento'), nombre, documento };
}

/**
 * Compra atómica de uno o varios asientos. Todo ocurre en una transacción
 * BEGIN IMMEDIATE: o se emiten todos los boletos o ninguno. Cada asiento solo
 * pasa a VENDIDO si sigue RESERVADO por este cliente y la reserva no venció.
 * El índice único parcial `ux_boleto_asiento_activo` es la garantía final.
 */
export function comprar(db, { viajeId, clienteId, pasajeros, ahora = Date.now() }) {
  validarCliente(clienteId);
  viajeId = aEntero(viajeId, 'Viaje');
  if (!Array.isArray(pasajeros) || pasajeros.length === 0 || pasajeros.length > MAX_ASIENTOS_POR_CLIENTE) {
    throw new ErrorNegocio(400, 'PASAJERO_INVALIDO', 'Selecciona entre 1 y 6 asientos');
  }
  const lista = pasajeros.map(validarPasajero);
  if (new Set(lista.map((p) => p.asientoId)).size !== lista.length) {
    throw new ErrorNegocio(400, 'PASAJERO_INVALIDO', 'Hay asientos repetidos en la compra');
  }
  if (new Set(lista.map((p) => p.documento)).size !== lista.length) {
    throw new ErrorNegocio(400, 'PASAJERO_INVALIDO', 'Cada pasajero debe tener un documento distinto');
  }

  return transaccion(db, () => {
    const viaje = viajeAbierto(db, viajeId, ahora);
    const vender = db.prepare(`
      UPDATE asiento_viaje
      SET estado = 'VENDIDO', reservado_por = NULL, reservado_hasta = NULL, version = version + 1
      WHERE viaje_id = ? AND asiento_id = ? AND estado = 'RESERVADO' AND reservado_por = ? AND reservado_hasta >= ?`);
    const emitir = db.prepare(`
      INSERT INTO boletos (codigo, viaje_id, asiento_id, pasajero_nombre, pasajero_doc, precio, vendido_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const recargo = db.prepare('SELECT numero, recargo FROM asientos WHERE id = ?');

    const boletos = [];
    for (const p of lista) {
      const asiento = recargo.get(p.asientoId);
      if (vender.run(viajeId, p.asientoId, clienteId, ahora).changes !== 1) {
        throw new ErrorNegocio(409, 'RESERVA_INVALIDA',
          `El asiento ${asiento?.numero ?? p.asientoId} ya no está reservado a tu nombre (¿venció el tiempo?)`);
      }
      const codigo = nuevoCodigo();
      try {
        emitir.run(codigo, viajeId, p.asientoId, p.nombre, p.documento, viaje.precio + asiento.recargo, ahora);
      } catch (err) {
        if (/pasajero_doc/.test(err.message)) {
          throw new ErrorNegocio(409, 'DOCUMENTO_DUPLICADO', `El documento ${p.documento} ya tiene un boleto en este viaje`);
        }
        throw err;
      }
      boletos.push({ codigo, asientoId: p.asientoId, numero: asiento.numero });
    }
    return {
      boletos,
      asientos: lista.map((p) => leerAsiento(db, viajeId, p.asientoId, ahora)),
    };
  });
}

const SQL_BOLETO = `
  SELECT bo.codigo, bo.estado, bo.pasajero_nombre AS pasajero, bo.pasajero_doc AS documento,
         bo.precio, bo.vendido_en AS vendidoEn, bo.embarcado_en AS embarcadoEn, bo.anulado_en AS anuladoEn,
         bo.viaje_id AS viajeId, bo.asiento_id AS asientoId,
         a.numero AS asiento, a.piso, a.tipo,
         v.salida, r.origen, r.destino, b.placa, b.modelo
  FROM boletos bo
  JOIN asientos a ON a.id = bo.asiento_id
  JOIN viajes v ON v.id = bo.viaje_id
  JOIN rutas r ON r.id = v.ruta_id
  JOIN buses b ON b.id = v.bus_id`;

export function obtenerBoleto(db, codigo) {
  const b = db.prepare(`${SQL_BOLETO} WHERE bo.codigo = ?`).get(String(codigo ?? '').toUpperCase());
  if (!b) throw new ErrorNegocio(404, 'BOLETO_NO_EXISTE', 'Boleto no encontrado');
  return b;
}

export function manifiesto(db, viajeId) {
  viajeId = aEntero(viajeId, 'Viaje');
  return db.prepare(`${SQL_BOLETO} WHERE bo.viaje_id = ? AND bo.estado <> 'ANULADO' ORDER BY a.numero`).all(viajeId);
}

export function anular(db, { codigo, ahora = Date.now() }) {
  return transaccion(db, () => {
    const b = obtenerBoleto(db, codigo);
    const r = db.prepare("UPDATE boletos SET estado = 'ANULADO', anulado_en = ? WHERE codigo = ? AND estado = 'EMITIDO'")
      .run(ahora, b.codigo);
    if (r.changes !== 1) {
      throw new ErrorNegocio(409, 'NO_ANULABLE', `No se puede anular un boleto ${b.estado.toLowerCase()}`);
    }
    db.prepare(`
      UPDATE asiento_viaje SET estado = 'LIBRE', version = version + 1
      WHERE viaje_id = ? AND asiento_id = ? AND estado = 'VENDIDO'`).run(b.viajeId, b.asientoId);
    return { boleto: obtenerBoleto(db, b.codigo), asiento: leerAsiento(db, b.viajeId, b.asientoId, ahora) };
  });
}

/**
 * Validación de embarque. Acepta el contenido del QR (firma HMAC verificada)
 * o, para ingreso manual, el código impreso + documento del pasajero.
 * El paso EMITIDO -> EMBARCADO también es un UPDATE condicional, así que dos
 * lectores escaneando el mismo boleto a la vez no pueden embarcarlo dos veces.
 */
export function embarcar(db, { qr, codigo, documento, viajeId, secreto, ahora = Date.now() }) {
  let cod;
  if (qr) {
    cod = verificarQR(qr, secreto);
    if (!cod) throw new ErrorNegocio(400, 'QR_INVALIDO', 'QR inválido o adulterado');
  } else {
    cod = String(codigo ?? '').trim().toUpperCase();
    if (!cod || !documento) throw new ErrorNegocio(400, 'PARAMETRO_INVALIDO', 'Ingresa el código y el documento');
  }
  return transaccion(db, () => {
    const b = obtenerBoleto(db, cod);
    if (!qr && b.documento !== String(documento).trim().toUpperCase()) {
      throw new ErrorNegocio(409, 'DOCUMENTO_NO_COINCIDE', 'El documento no coincide con el boleto');
    }
    if (viajeId && b.viajeId !== Number(viajeId)) {
      throw new ErrorNegocio(409, 'OTRO_VIAJE', `Este boleto es para ${b.origen} → ${b.destino} de otra salida`, { boleto: b });
    }
    if (b.estado === 'ANULADO') throw new ErrorNegocio(409, 'BOLETO_ANULADO', 'El boleto fue anulado', { boleto: b });
    const r = db.prepare("UPDATE boletos SET estado = 'EMBARCADO', embarcado_en = ? WHERE codigo = ? AND estado = 'EMITIDO'")
      .run(ahora, b.codigo);
    if (r.changes !== 1) {
      throw new ErrorNegocio(409, 'YA_EMBARCADO', 'Este boleto ya fue usado para embarcar', { boleto: b });
    }
    return obtenerBoleto(db, b.codigo);
  });
}
