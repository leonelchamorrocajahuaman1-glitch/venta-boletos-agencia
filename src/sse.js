// Server-Sent Events: un canal por viaje. Cada cambio de asiento o embarque
// se difunde al instante a todos los navegadores que miran ese viaje.
export class CanalSSE {
  constructor({ latidoMs = 20_000 } = {}) {
    this.suscriptores = new Map(); // viajeId (o 'admin') -> Set<res>
    this.latido = setInterval(() => this.#escribirATodos(': ping\n\n'), latidoMs);
    this.latido.unref();
  }

  suscribir(viajeId, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // evita el buffer de nginx
    });
    res.write('retry: 2000\n\n');
    if (!this.suscriptores.has(viajeId)) this.suscriptores.set(viajeId, new Set());
    const grupo = this.suscriptores.get(viajeId);
    grupo.add(res);
    this.emitir(viajeId, 'espectadores', { total: grupo.size });
    req.on('close', () => {
      grupo.delete(res);
      if (grupo.size === 0) this.suscriptores.delete(viajeId);
      else this.emitir(viajeId, 'espectadores', { total: grupo.size });
    });
  }

  emitir(viajeId, evento, datos) {
    const grupo = this.suscriptores.get(viajeId);
    if (!grupo) return;
    const mensaje = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
    for (const res of grupo) res.write(mensaje);
  }

  #escribirATodos(texto) {
    for (const grupo of this.suscriptores.values()) for (const res of grupo) res.write(texto);
  }

  cerrar() {
    clearInterval(this.latido);
    for (const grupo of this.suscriptores.values()) for (const res of grupo) res.end();
    this.suscriptores.clear();
  }
}
