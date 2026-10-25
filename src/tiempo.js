// Todas las fechas se guardan como epoch ms; la zona horaria del negocio es Lima (UTC-5, sin horario de verano).
export const ZONA = 'America/Lima';
const OFFSET = '-05:00';
const DIA_MS = 86_400_000;

export function fechaLocal(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(ms); // YYYY-MM-DD
}

export function inicioDelDia(fecha) {
  const ms = Date.parse(`${fecha}T00:00:00${OFFSET}`);
  return Number.isNaN(ms) ? null : ms;
}

export function horaLocal(fecha, hhmm) {
  return Date.parse(`${fecha}T${hhmm}:00${OFFSET}`);
}

export function sumarDias(fecha, dias) {
  return fechaLocal(inicioDelDia(fecha) + dias * DIA_MS + 12 * 3_600_000);
}

export function formatear(ms) {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ms);
}

export { DIA_MS };
