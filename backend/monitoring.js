// Clasificación de señales de visibilidad. Una web solo observa que la página se ocultó o volvió: no puede saber
// si el alumno desbloqueó el teléfono ni qué app usó. Por eso un retorno durante la evaluación genera una
// incidencia "a revisar" y solo el profesor puede confirmarla como falta.

export const HIDE_SIGNALS = new Set(['tab_switch', 'window_blur', 'screen_lock', 'page_closed']);
export const RETURN_SIGNAL = 'returned';
export const GROUP_WINDOW_MS = 2000;
// Al iniciar, quien sigue con la pantalla visible tiene este margen para bloquear el teléfono sin incidencia.
export const START_GRACE_SECONDS = 30;
export const CYCLE_WINDOW_MS = 5 * 60_000;
export const INCIDENT_PENDING = 'PENDING_REVIEW';
export const INCIDENT_CONFIRMED = 'CONFIRMED';
export const INCIDENT_DISMISSED = 'DISMISSED';

// Actualiza el estado de visibilidad del alumno (visible / hiddenAt / hiddenSinceMs) y devuelve:
//   { incident: null | { type, backgroundMs }, grouped: boolean }
// - Ocultarse nunca genera incidencia, tampoco el bloqueo previo al inicio.
// - Un retorno cuenta una sola vez: si ya estaba visible (p. ej. "focus" tras "visible"), se ignora.
// - Retornos dentro de la ventana de agrupación se consolidan en la incidencia anterior.
export function classifySignal(student, signal, { sessionStatus, now = Date.now(), reload = false, sinceInteractionMs = null } = {}) {
  if (HIDE_SIGNALS.has(signal)) {
    if (student.visible !== false) {
      student.hiddenSinceMs = now;
      student.hideContext = { sinceInteractionMs: Number.isFinite(sinceInteractionMs) ? Math.max(0, sinceInteractionMs) : null };
      student.hideTimes = [...(student.hideTimes ?? []).filter((time) => now - time < CYCLE_WINDOW_MS), now];
    }
    student.visible = false;
    student.hiddenAt ??= new Date(now).toISOString();
    return { incident: null, grouped: false };
  }
  if (signal !== RETURN_SIGNAL) return { incident: null, grouped: false };

  const wasHidden = student.visible === false;
  const backgroundMs = wasHidden && student.hiddenSinceMs ? Math.max(0, now - student.hiddenSinceMs) : null;
  student.visible = true;
  student.hiddenAt = null;
  student.hiddenSinceMs = null;
  // Volver a la pantalla antes del inicio deshace el "listo": el alumno debe confirmarlo de nuevo.
  if (sessionStatus === 'waiting') { student.ready = false; student.readyAt = null; }
  if (!wasHidden || sessionStatus !== 'active') return { incident: null, grouped: false };
  if (student.graceUntilMs && now < student.graceUntilMs) return { incident: null, grouped: false, inGrace: true };
  if (student.lastIncidentAtMs && now - student.lastIncidentAtMs < GROUP_WINDOW_MS) {
    student.lastIncidentAtMs = now;
    return { incident: null, grouped: true };
  }
  student.lastIncidentAtMs = now;
  const hint = buildHint({ sinceInteractionMs: student.hideContext?.sinceInteractionMs ?? null, backgroundMs, hideCount: (student.hideTimes ?? []).filter((time) => now - time < CYCLE_WINDOW_MS).length });
  return { incident: { type: reload ? 'page_reload' : 'unverified_return', backgroundMs, hint }, grouped: false };
}

// Descarta reenvíos (mismo eventId) y eventos que llegan desordenados dentro de una misma pestaña.
export function isDuplicateEvent(state, { eventId, tabInstanceId, sequenceNumber }, limit = 500) {
  state.seen ??= new Set();
  state.lastSeq ??= new Map();
  if (typeof eventId === 'string' && eventId) {
    if (state.seen.has(eventId)) return true;
    state.seen.add(eventId);
    if (state.seen.size > limit) state.seen.delete(state.seen.values().next().value);
  }
  if (typeof tabInstanceId === 'string' && Number.isInteger(sequenceNumber)) {
    const last = state.lastSeq.get(tabInstanceId) ?? -1;
    if (sequenceNumber <= last) return true;
    state.lastSeq.set(tabInstanceId, sequenceNumber);
  }
  return false;
}

// Una desconexión equivale a "no está mirando la pantalla": si el teléfono se bloquea, el navegador puede
// suspenderse antes de avisar. Al reconectar con la página visible se evalúa como retorno.
export function markAbsent(student, now = Date.now()) {
  if (student.visible !== false) student.hiddenSinceMs = now;
  student.visible = false;
  student.hiddenAt ??= new Date(now).toISOString();
}

// Al iniciar la evaluación: quien tiene la pantalla visible recibe el margen de gracia.
export function applyStartGrace(student, now = Date.now()) {
  student.graceUntilMs = student.visible === false ? 0 : now + START_GRACE_SECONDS * 1000;
}
// Pista de contexto para el profesor. Son heurísticas débiles y fáciles de engañar: nunca confirman ni
// descartan nada, solo orientan qué verificar al pasar por el puesto del alumno.
//  - Sin toques antes de ocultarse apunta a bloqueo con el botón lateral; un toque reciente, a cambio de app.
//  - Una sola ocultación larga apunta a bloqueo; varias cortas seguidas, a cambio de app.
export function buildHint({ sinceInteractionMs, backgroundMs, hideCount }) {
  let lock = 0;
  let app = 0;
  const reasons = [];
  if (sinceInteractionMs != null) {
    if (sinceInteractionMs < 2000) { app += 1; reasons.push('tocó la pantalla justo antes de ocultarse'); }
    else if (sinceInteractionMs >= 5000) { lock += 1; reasons.push('sin tocar la pantalla antes de ocultarse'); }
  }
  if (backgroundMs != null) {
    if (backgroundMs < 15_000) { app += 1; reasons.push('ocultación corta'); }
    else if (backgroundMs >= 120_000) { lock += 1; reasons.push('ocultación larga'); }
  }
  if (hideCount >= 3) { app += 1; reasons.push(`${hideCount} ocultaciones en los últimos 5 min`); }
  const kind = lock > app ? 'probable_lock' : app > lock ? 'probable_app' : 'unclear';
  return { kind, reasons };
}