// Simula alumnos reales contra una sesión ya creada.
// Uso: node scripts/loadtest.mjs <URL_BACKEND> <SESSION_ID> [alumnos=45] [segundosDeEntrada=30]
// El profesor inicia el examen desde su panel; el script confirma asistencia y luego simula
// bloqueos/desbloqueos y cortes de red breves, como haría un celular real.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/package.json'));
const { io } = require('socket.io-client');

const [apiUrl, sessionId, countArg = '45', rampArg = '30'] = process.argv.slice(2);
if (!apiUrl || !sessionId) {
  console.error('Uso: node scripts/loadtest.mjs <URL_BACKEND> <SESSION_ID> [alumnos] [segundosDeEntrada]');
  process.exit(1);
}
const COUNT = Number(countArg);
const RAMP_MS = Number(rampArg) * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRut(seed) {
  const body = String(20_000_000 + seed * 7919).slice(0, 8);
  let sum = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) { sum += Number(body[i]) * factor; factor = factor === 7 ? 2 : factor + 1; }
  const rest = 11 - (sum % 11);
  return `${body}-${rest === 11 ? '0' : rest === 10 ? 'K' : rest}`;
}

const stats = { registered: 0, registerFailed: 0, joined: 0, ready: 0, started: 0, disconnects: 0, kicked: 0, errors: {}, joinMs: [] };
const countError = (key) => { stats.errors[key] = (stats.errors[key] ?? 0) + 1; };
const sockets = [];

async function runStudent(index) {
  await sleep(Math.random() * RAMP_MS);
  const rut = makeRut(index + 1);
  const t0 = Date.now();
  let token;
  try {
    const response = await fetch(`${apiUrl}/api/sessions/${sessionId}/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Alumno Prueba ${index + 1}`, email: `prueba${index + 1}@test.cl`, rut })
    });
    const data = await response.json();
    if (!response.ok) { stats.registerFailed += 1; countError(`registro ${response.status}: ${data.message}`); return; }
    token = data.token;
    stats.registered += 1;
  } catch (error) { stats.registerFailed += 1; countError(`registro red: ${error.message}`); return; }

  const socket = io(apiUrl, { autoConnect: false, reconnection: true });
  sockets.push(socket);
  let seq = 0;
  const tab = crypto.randomUUID();
  const send = (type, message) => socket.emit('student:event', { sessionId, type, message, eventId: crypto.randomUUID(), tabInstanceId: tab, sequenceNumber: seq++ });
  let counted = false;

  socket.on('connect', () => socket.emit('student:join', { sessionId, guestToken: token, hidden: false, stayedVisible: false }));
  socket.on('session:connected', (data) => {
    if (!counted) { counted = true; stats.joined += 1; stats.joinMs.push(Date.now() - t0); }
    if (!data.ready) { socket.emit('student:ready', { sessionId, ready: true }); stats.ready += 1; }
  });
  socket.on('session:error', ({ message }) => countError(`join: ${message}`));
  socket.on('student:expelled', () => { stats.kicked += 1; });
  socket.on('disconnect', (reason) => { if (counted) stats.disconnects += 1; if (reason === 'io server disconnect') countError('desconectado por el servidor'); });
  socket.on('session:updated', (s) => { if (s.status === 'active' && !socket.started) { socket.started = true; stats.started += 1; } });
  socket.connect();

  // Tras confirmar, el "celular" se bloquea: oculta la página y, de vez en cuando, vuelve y sufre un microcorte.
  await sleep(3000 + Math.random() * 5000);
  send('tab_switch', 'Página oculta (simulación)');
  for (;;) {
    await sleep(20_000 + Math.random() * 40_000);
    if (Math.random() < 0.3) { socket.disconnect(); await sleep(2000 + Math.random() * 6000); socket.connect(); }
  }
}

console.log(`Simulando ${COUNT} alumnos en ${apiUrl} · sesión ${sessionId} · entrada en ${RAMP_MS / 1000}s`);
for (let i = 0; i < COUNT; i += 1) runStudent(i);

const report = () => {
  const times = [...stats.joinMs].sort((a, b) => a - b);
  const p = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : 0);
  console.log(`[${new Date().toLocaleTimeString()}] registrados ${stats.registered}/${COUNT} (fallos ${stats.registerFailed}) · conectados ${stats.joined} · confirmaron ${stats.ready} · vieron inicio ${stats.started} · desconexiones ${stats.disconnects} · expulsados ${stats.kicked} · entrada p50 ${p(0.5)} ms p95 ${p(0.95)} ms`);
  if (Object.keys(stats.errors).length) console.log('  errores:', stats.errors);
};
setInterval(report, 10_000);
process.on('SIGINT', () => { report(); process.exit(0); });
