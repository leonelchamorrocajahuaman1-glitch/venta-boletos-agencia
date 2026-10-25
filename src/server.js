import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CanalSSE } from './sse.js';
import { contenidoQR } from './qr.js';
import { ticketEscPos, enviarAImpresora } from './escpos.js';
import * as ventas from './ventas.js';
import * as admin from './admin.js';
import * as auth from './auth.js';

const PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const { ErrorNegocio } = ventas;

export function crearApp({
  db, secreto, secretoSesion, ttlMs = 5 * 60_000, impresora = null, barridoMs = 2000, urlsRed = () => [],
}) {
  const app = express();
  const sse = new CanalSSE();
  const intentos = new auth.LimiteIntentos();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  const usuarioAdmin = (req) => auth.leerToken(auth.leerCookie(req), secretoSesion);
  const soloAdmin = (req, res, next) => {
    req.admin = usuarioAdmin(req);
    if (!req.admin) throw new ErrorNegocio(401, 'NO_AUTORIZADO', 'Inicia sesión como administrador');
    next();
  };

  // Las páginas del administrador solo se entregan con sesión iniciada.
  app.use('/admin', (req, res, next) => {
    const esPagina = req.path === '/' || req.path.endsWith('.html');
    if (!esPagina || req.path === '/login.html' || usuarioAdmin(req)) return next();
    res.redirect(`/admin/login.html?volver=${encodeURIComponent(req.originalUrl)}`);
  });
  app.use(express.static(PUBLICO));

  const emitirAsiento = (viajeId, asiento) => asiento && sse.emitir(viajeId, 'asiento', asiento);
  const actividad = (tipo, texto, datos = {}) => sse.emitir('admin', 'actividad', { tipo, texto, t: Date.now(), ...datos });

  // Prueba de conexión: abrir /api/ping desde el celular confirma que la red y el firewall están bien.
  app.get('/api/ping', (req, res) => res.json({ ok: true, sistema: 'Las Cobras Viajes', tuIp: req.socket.remoteAddress }));

  // ─────────────── Cliente (Computadora 2): consulta y compra ───────────────
  app.get('/api/ciudades', (req, res) => res.json(ventas.listarCiudades(db)));

  app.get('/api/viajes', (req, res) => {
    const { origen, destino, fecha, embarque } = req.query;
    res.json(ventas.listarViajes(db, { origen, destino, fecha, embarque: embarque === '1' }));
  });

  app.get('/api/viajes/:id', (req, res) => {
    res.json(ventas.detalleViaje(db, req.params.id, req.query.clienteId));
  });

  app.get('/api/viajes/:id/eventos', (req, res) => {
    const { viaje } = ventas.detalleViaje(db, req.params.id);
    sse.suscribir(viaje.id, req, res);
  });

  app.post('/api/viajes/:id/asientos/:asientoId/bloqueo', (req, res) => {
    const asiento = ventas.bloquear(db, {
      viajeId: req.params.id, asientoId: req.params.asientoId, clienteId: req.body?.clienteId, ttlMs,
    });
    emitirAsiento(Number(req.params.id), asiento);
    actividad('reserva', `Asiento ${asiento.numero} reservado`, { viajeId: Number(req.params.id) });
    res.json(asiento);
  });

  app.delete('/api/viajes/:id/asientos/:asientoId/bloqueo', (req, res) => {
    const asiento = ventas.liberar(db, {
      viajeId: req.params.id, asientoId: req.params.asientoId, clienteId: req.query.clienteId,
    });
    emitirAsiento(Number(req.params.id), asiento);
    if (asiento) actividad('liberacion', `Asiento ${asiento.numero} liberado`, { viajeId: Number(req.params.id) });
    res.json({ liberado: Boolean(asiento) });
  });

  app.post('/api/viajes/:id/compras', (req, res) => {
    const viajeId = Number(req.params.id);
    const { clienteId, pasajeros } = req.body ?? {};
    const { boletos, asientos } = ventas.comprar(db, { viajeId, clienteId, pasajeros });
    for (const a of asientos) emitirAsiento(viajeId, a);
    sse.emitir(viajeId, 'manifiesto', { motivo: 'venta' });
    const b = ventas.obtenerBoleto(db, boletos[0].codigo);
    const total = boletos.reduce((s, x) => s + ventas.obtenerBoleto(db, x.codigo).precio, 0);
    actividad('venta', `${boletos.length} boleto(s) ${b.origen} → ${b.destino} · asiento(s) ${boletos.map((x) => x.numero).join(', ')}`,
      { viajeId, total });
    res.status(201).json({ boletos });
  });

  app.get('/api/boletos/:codigo', async (req, res) => {
    const boleto = ventas.obtenerBoleto(db, req.params.codigo);
    const qr = contenidoQR(boleto.codigo, secreto);
    const qrImagen = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
    res.json({ ...boleto, qr, qrImagen, impresoraRed: Boolean(impresora) });
  });

  app.get('/api/boletos/:codigo/escpos', (req, res) => {
    const boleto = ventas.obtenerBoleto(db, req.params.codigo);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="boleto-${boleto.codigo}.bin"`);
    res.send(ticketEscPos(boleto, contenidoQR(boleto.codigo, secreto)));
  });

  // ─────────────── Administrador (Computadora 1): sesión ───────────────
  app.post('/api/admin/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (intentos.bloqueado(ip)) {
      throw new ErrorNegocio(429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos. Espera un minuto.');
    }
    const { usuario, password } = req.body ?? {};
    const fila = db.prepare('SELECT usuario, nombre, password_hash FROM usuarios WHERE usuario = ?').get(String(usuario ?? ''));
    if (!fila || !auth.verificarPassword(password ?? '', fila.password_hash)) {
      intentos.fallo(ip);
      throw new ErrorNegocio(401, 'CREDENCIALES', 'Usuario o contraseña incorrectos');
    }
    intentos.exito(ip);
    res.set('Set-Cookie', auth.cookieSesion(auth.crearToken(fila.usuario, secretoSesion)));
    res.json({ usuario: fila.usuario, nombre: fila.nombre });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.set('Set-Cookie', auth.cookieCerrada);
    res.json({ ok: true });
  });

  // ─────────────── Administrador: todo lo demás requiere sesión ───────────────
  app.use('/api/admin', soloAdmin);

  app.get('/api/admin/sesion', async (req, res) => {
    const u = db.prepare('SELECT usuario, nombre FROM usuarios WHERE usuario = ?').get(req.admin);
    const urlsClientes = await Promise.all(urlsRed().map(async (r) => ({
      ...r, qr: await QRCode.toDataURL(`${r.url}/`, { margin: 1, width: 280 }),
    })));
    res.json({ ...u, urlsClientes });
  });
  app.get('/api/admin/eventos', (req, res) => sse.suscribir('admin', req, res));
  app.get('/api/admin/resumen', (req, res) => res.json(admin.resumen(db)));
  app.get('/api/admin/catalogo', (req, res) => res.json(admin.catalogo(db)));
  app.get('/api/admin/salidas', (req, res) => res.json(admin.listarSalidas(db, { fecha: req.query.fecha })));

  app.post('/api/admin/salidas', (req, res) => {
    const s = admin.crearSalida(db, req.body ?? {});
    actividad('salida', `Nueva salida ${s.origen} → ${s.destino} (${s.placa})`);
    res.status(201).json(s);
  });

  app.post('/api/admin/salidas/:id/cancelar', (req, res) => {
    const s = admin.cancelarSalida(db, req.params.id);
    sse.emitir(s.id, 'cancelado', { mensaje: 'Esta salida fue cancelada por la agencia' });
    actividad('cancelacion', `Salida cancelada ${s.origen} → ${s.destino}`);
    res.json(s);
  });

  app.get('/api/admin/ventas', (req, res) => res.json(admin.listarVentas(db, req.query)));
  app.get('/api/admin/reportes', (req, res) => res.json(admin.reportes(db, req.query)));
  app.get('/api/admin/reportes.csv', (req, res) => {
    const { nombre, contenido } = admin.ventasCSV(db, req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(contenido);
  });

  app.get('/api/viajes/:id/manifiesto', soloAdmin, (req, res) => res.json(ventas.manifiesto(db, req.params.id)));

  app.post('/api/boletos/:codigo/anular', soloAdmin, (req, res) => {
    const { boleto, asiento } = ventas.anular(db, { codigo: req.params.codigo });
    emitirAsiento(boleto.viajeId, asiento);
    sse.emitir(boleto.viajeId, 'manifiesto', { motivo: 'anulacion' });
    actividad('anulacion', `Boleto ${boleto.codigo} anulado · asiento ${boleto.asiento}`, { viajeId: boleto.viajeId });
    res.json(boleto);
  });

  app.post('/api/boletos/:codigo/imprimir', soloAdmin, async (req, res) => {
    if (!impresora) throw new ErrorNegocio(400, 'SIN_IMPRESORA', 'No hay impresora de red configurada (PRINTER_HOST)');
    const boleto = ventas.obtenerBoleto(db, req.params.codigo);
    try {
      await enviarAImpresora(ticketEscPos(boleto, contenidoQR(boleto.codigo, secreto)), impresora.host, impresora.port);
    } catch (err) {
      throw new ErrorNegocio(502, 'IMPRESORA_ERROR', `No se pudo imprimir: ${err.message}`);
    }
    res.json({ impreso: true });
  });

  app.post('/api/embarque', soloAdmin, (req, res) => {
    const { qr, codigo, documento, viajeId } = req.body ?? {};
    const boleto = ventas.embarcar(db, { qr, codigo, documento, viajeId, secreto });
    sse.emitir(boleto.viajeId, 'embarque', { codigo: boleto.codigo, asiento: boleto.asiento, pasajero: boleto.pasajero });
    actividad('embarque', `Embarcó ${boleto.pasajero} · asiento ${boleto.asiento} (${boleto.origen} → ${boleto.destino})`,
      { viajeId: boleto.viajeId });
    res.json(boleto);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Ruta no encontrada' }));

  app.use((err, req, res, _next) => {
    if (err instanceof ErrorNegocio) {
      return res.status(err.status).json({ error: err.codigo, mensaje: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON_INVALIDO', mensaje: 'Cuerpo JSON inválido' });
    }
    console.error(err);
    res.status(500).json({ error: 'ERROR_INTERNO', mensaje: 'Error interno del servidor' });
  });

  const barrido = setInterval(() => {
    const liberados = ventas.liberarVencidos(db);
    for (const { viajeId, asiento } of liberados) emitirAsiento(viajeId, asiento);
    if (liberados.length) actividad('vencimiento', `${liberados.length} reserva(s) vencida(s) liberada(s)`);
  }, barridoMs);
  barrido.unref();

  return {
    app,
    sse,
    detener() {
      clearInterval(barrido);
      sse.cerrar();
    },
  };
}
