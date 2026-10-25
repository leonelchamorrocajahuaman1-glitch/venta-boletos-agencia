import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CanalSSE } from './sse.js';
import { contenidoQR } from './qr.js';
import { ticketEscPos, enviarAImpresora } from './escpos.js';
import * as ventas from './ventas.js';

const PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function crearApp({ db, secreto, ttlMs = 5 * 60_000, impresora = null, barridoMs = 2000 }) {
  const app = express();
  const sse = new CanalSSE();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(PUBLICO));

  const emitirAsiento = (viajeId, asiento) => asiento && sse.emitir(viajeId, 'asiento', asiento);

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
    res.json(asiento);
  });

  app.delete('/api/viajes/:id/asientos/:asientoId/bloqueo', (req, res) => {
    const asiento = ventas.liberar(db, {
      viajeId: req.params.id, asientoId: req.params.asientoId, clienteId: req.query.clienteId,
    });
    emitirAsiento(Number(req.params.id), asiento);
    res.json({ liberado: Boolean(asiento) });
  });

  app.post('/api/viajes/:id/compras', (req, res) => {
    const { clienteId, pasajeros } = req.body ?? {};
    const { boletos, asientos } = ventas.comprar(db, { viajeId: req.params.id, clienteId, pasajeros });
    for (const a of asientos) emitirAsiento(Number(req.params.id), a);
    sse.emitir(Number(req.params.id), 'manifiesto', { motivo: 'venta' });
    res.status(201).json({ boletos });
  });

  app.get('/api/viajes/:id/manifiesto', (req, res) => res.json(ventas.manifiesto(db, req.params.id)));

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

  app.post('/api/boletos/:codigo/imprimir', async (req, res) => {
    if (!impresora) {
      throw new ventas.ErrorNegocio(400, 'SIN_IMPRESORA', 'No hay impresora de red configurada (PRINTER_HOST)');
    }
    const boleto = ventas.obtenerBoleto(db, req.params.codigo);
    try {
      await enviarAImpresora(ticketEscPos(boleto, contenidoQR(boleto.codigo, secreto)), impresora.host, impresora.port);
    } catch (err) {
      throw new ventas.ErrorNegocio(502, 'IMPRESORA_ERROR', `No se pudo imprimir: ${err.message}`);
    }
    res.json({ impreso: true });
  });

  app.post('/api/boletos/:codigo/anular', (req, res) => {
    const { boleto, asiento } = ventas.anular(db, { codigo: req.params.codigo });
    emitirAsiento(boleto.viajeId, asiento);
    sse.emitir(boleto.viajeId, 'manifiesto', { motivo: 'anulacion' });
    res.json(boleto);
  });

  app.post('/api/embarque', (req, res) => {
    const { qr, codigo, documento, viajeId } = req.body ?? {};
    const boleto = ventas.embarcar(db, { qr, codigo, documento, viajeId, secreto });
    sse.emitir(boleto.viajeId, 'embarque', { codigo: boleto.codigo, asiento: boleto.asiento, pasajero: boleto.pasajero });
    res.json(boleto);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Ruta no encontrada' }));

  app.use((err, req, res, _next) => {
    if (err instanceof ventas.ErrorNegocio) {
      return res.status(err.status).json({ error: err.codigo, mensaje: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON_INVALIDO', mensaje: 'Cuerpo JSON inválido' });
    }
    console.error(err);
    res.status(500).json({ error: 'ERROR_INTERNO', mensaje: 'Error interno del servidor' });
  });

  const barrido = setInterval(() => {
    for (const { viajeId, asiento } of ventas.liberarVencidos(db)) emitirAsiento(viajeId, asiento);
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
