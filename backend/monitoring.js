// Clasificación de señales de visibilidad. Una web solo observa que la página se ocultó o volvió: no puede saber
// si el alumno desbloqueó el teléfono ni qué app usó. Por eso un retorno durante la evaluación genera una
// incidencia "a revisar" y solo el profesor puede confirmarla como falta.

export const HIDE_SIGNALS = new Set(['tab_switch', 'window_blur', 'screen_lock', 'page_closed']);
export const RETURN_SIGNAL = 'returned';
export const GROUP_WINDOW_MS = 2000;
// Al iniciar, quien sigue con la pantalla visible tiene este margen para bloquear el teléfono sin incidencia.
export const START_GRACE_SECONDS = 30;
export const INCIDENT_PENDING = 'PENDING_REVIEW';
export const INCIDENT_CONFIRMED = 'CONFIRMED';
export const INCIDENT_DISMISSED = 'DISMISSED';

// Actualiza el estado de visibilidad del alumno (visible / hiddenAt / hiddenSinceMs) y devuelve:
//   { incident: null | { type, backgroundMs }, grouped: boolean }
// - Ocultarse nunca genera incidencia, tampoco el bloqueo previo al inicio.
// - Un retorno cuenta una sola vez: si ya estaba visible (p. ej. "focus" tras "visible"), se ignora.
// - Retornos dentro de la ventana de agrupación se consolidan en la incidencia anterior.
export function classifySignal(student, signal, { sessionStatus, now = Date.now(), reload = false } = {}) {
  if (HIDE_SIGNALS.has(signal)) {
    if (student.visible !== false) student.hiddenSinceMs = now;
    student.visible = false;
    student.hiddenAt ??= new Date(now).toISOString();
    // Ocultar la página antes del inicio equivale a decir "ya guardé mi teléfono".
    if (sessionStatus === 'waiting') student.ready = true;
    return { incident: null, grouped: false };
  }
  if (signal !== RETURN_SIGNAL) return { incident: null, grouped: false };

  const wasHidden = student.visible === false;
  const backgroundMs = wasHidden && student.hiddenSinceMs ? Math.max(0, now - student.hiddenSinceMs) : null;
  student.visible = true;
  student.hiddenAt = null;
  student.hiddenSinceMs = null;
  if (!wasHidden || sessionStatus !== 'active') return { incident: null, grouped: false };
  if (student.graceUntilMs && now < student.graceUntilMs) return { incident: null, grouped: false, inGrace: true };
  if (student.lastIncidentAtMs && now - student.lastIncidentAtMs < GROUP_WINDOW_MS) {
    student.lastIncidentAtMs = now;
    return { incident: null, grouped: true };
  }
  student.lastIncidentAtMs = now;
  return { incident: { type: reload ? 'page_reload' : 'unverified_return', backgroundMs }, grouped: false };
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