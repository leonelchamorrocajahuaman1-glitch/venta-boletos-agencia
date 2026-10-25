import { api, aviso, soles, esc } from './comun.js';

const fmt = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const params = new URLSearchParams(location.search);
const codigo = params.get('codigo');

try {
  const b = await api('GET', `/api/boletos/${encodeURIComponent(codigo ?? '')}`);
  const t = document.getElementById('ticket');
  t.innerHTML = `
    <div class="centro">
      <div class="marca">LAS COBRAS</div>
      <div>VIAJES</div>
      <div>Boleto de viaje</div>
      ${b.estado === 'ANULADO' ? '<div class="anulado">*** ANULADO ***</div>' : ''}
    </div>
    <div class="sep"></div>
    <div class="centro">
      <div class="ruta">${esc(b.origen)} → ${esc(b.destino)}</div>
      <div>${fmt.format(b.salida)}</div>
    </div>
    <div class="sep"></div>
    <div class="fila grande"><span>ASIENTO</span><span>${b.asiento} (piso ${b.piso})</span></div>
    <div class="fila"><span>Servicio</span><span>${esc(b.tipo)}</span></div>
    <div class="fila"><span>Bus</span><span>${esc(b.placa)}</span></div>
    <div>Pasajero:</div>
    <div><b>${esc(b.pasajero)}</b></div>
    <div class="fila"><span>Documento</span><span>${esc(b.documento)}</span></div>
    <div class="sep"></div>
    <div class="fila grande"><span>TOTAL</span><span>${soles(b.precio)}</span></div>
    <div class="sep"></div>
    <img class="qr" src="${b.qrImagen}" alt="Código QR del boleto">
    <div class="centro">
      <div class="codigo">${esc(b.codigo)}</div>
      <div>Preséntese 30 min antes</div>
      <div>con su documento de identidad</div>
      <div>Emitido ${fmt.format(b.vendidoEn)}</div>
    </div>`;
  t.hidden = false;
  document.title = `Boleto ${b.codigo}`;

  document.getElementById('btn-imprimir').addEventListener('click', () => print());
  document.getElementById('btn-escpos').href = `/api/boletos/${b.codigo}/escpos`;
  const red = document.getElementById('btn-red');
  red.hidden = !b.impresoraRed;
  red.addEventListener('click', async () => {
    try {
      await api('POST', `/api/boletos/${b.codigo}/imprimir`);
      aviso('Enviado a la impresora');
    } catch (err) {
      aviso(err.message, 'error');
    }
  });
  if (params.get('auto') === '1') t.querySelector('img').decode().then(() => print());
} catch (err) {
  document.getElementById('error').textContent = err.message;
}
