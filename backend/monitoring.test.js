import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStartGrace, classifySignal, isDuplicateEvent, markAbsent } from './monitoring.js';

const fresh = () => ({ visible: true, hiddenAt: null });

test('bloquear antes de iniciar y volver antes del inicio no genera incidencia', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'waiting', now: 1000 });
  const result = classifySignal(student, 'returned', { sessionStatus: 'waiting', now: 5000 });
  assert.equal(result.incident, null);
  assert.equal(student.visible, true);
});

test('ocultarse durante la evaluación no genera incidencia por sí solo', () => {
  const student = fresh();
  assert.equal(classifySignal(student, 'window_blur', { sessionStatus: 'active', now: 1000 }).incident, null);
});

test('retorno tras bloqueo previo al inicio, ya en evaluación, genera una incidencia', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'waiting', now: 1000 });
  const result = classifySignal(student, 'returned', { sessionStatus: 'active', now: 61_000 });
  assert.equal(result.incident.type, 'unverified_return');
  assert.equal(result.incident.backgroundMs, 60_000);
});

test('visible + focus de un mismo retorno generan una sola incidencia', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'active', now: 1000 });
  classifySignal(student, 'window_blur', { sessionStatus: 'active', now: 1010 });
  assert.ok(classifySignal(student, 'returned', { sessionStatus: 'active', now: 9000 }).incident);
  assert.equal(classifySignal(student, 'returned', { sessionStatus: 'active', now: 9005 }).incident, null);
});

test('retornos dentro de la ventana de agrupación se consolidan', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'active', now: 1000 });
  classifySignal(student, 'returned', { sessionStatus: 'active', now: 5000 });
  classifySignal(student, 'tab_switch', { sessionStatus: 'active', now: 5200 });
  const result = classifySignal(student, 'returned', { sessionStatus: 'active', now: 6000 });
  assert.equal(result.incident, null);
  assert.equal(result.grouped, true);
});

test('recarga tras ocultarse se marca como page_reload y una recarga con la página visible no genera nada', () => {
  const hidden = fresh();
  classifySignal(hidden, 'page_closed', { sessionStatus: 'active', now: 1000 });
  assert.equal(classifySignal(hidden, 'returned', { sessionStatus: 'active', now: 3000, reload: true }).incident.type, 'page_reload');
  assert.equal(classifySignal(fresh(), 'returned', { sessionStatus: 'active', now: 3000, reload: true }).incident, null);
});

test('no se crean incidencias con la evaluación finalizada', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'active', now: 1000 });
  assert.equal(classifySignal(student, 'returned', { sessionStatus: 'ended', now: 9000 }).incident, null);
});

test('un eventId repetido o una secuencia atrasada se descartan', () => {
  const state = {};
  assert.equal(isDuplicateEvent(state, { eventId: 'a', tabInstanceId: 't', sequenceNumber: 1 }), false);
  assert.equal(isDuplicateEvent(state, { eventId: 'a', tabInstanceId: 't', sequenceNumber: 2 }), true);
  assert.equal(isDuplicateEvent(state, { eventId: 'b', tabInstanceId: 't', sequenceNumber: 1 }), true);
  assert.equal(isDuplicateEvent(state, { eventId: 'c', tabInstanceId: 't', sequenceNumber: 3 }), false);
});

test('una desconexión cuenta como ausencia: al reconectar con la página visible tras el inicio hay incidencia', () => {
  const student = fresh();
  markAbsent(student, 1000);
  const result = classifySignal(student, 'returned', { sessionStatus: 'active', now: 90_000, reload: true });
  assert.equal(result.incident.type, 'page_reload');
});

test('ocultar la página antes del inicio marca al alumno como listo', () => {
  const student = fresh();
  classifySignal(student, 'tab_switch', { sessionStatus: 'waiting', now: 1000 });
  assert.equal(student.ready, true);
});

test('el margen de gracia al iniciar solo cubre a quien tenía la pantalla visible', () => {
  const visible = fresh();
  applyStartGrace(visible, 10_000);
  classifySignal(visible, 'tab_switch', { sessionStatus: 'active', now: 15_000 });
  assert.equal(classifySignal(visible, 'returned', { sessionStatus: 'active', now: 20_000 }).incident, null);
  classifySignal(visible, 'tab_switch', { sessionStatus: 'active', now: 50_000 });
  assert.ok(classifySignal(visible, 'returned', { sessionStatus: 'active', now: 60_000 }).incident);

  const locked = { visible: false, hiddenSinceMs: 1000, hiddenAt: 'x' };
  applyStartGrace(locked, 10_000);
  assert.ok(classifySignal(locked, 'returned', { sessionStatus: 'active', now: 12_000 }).incident);
});