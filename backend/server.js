import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { authFromToken, getUserProfile, registerAccountRoutes, requireAuth } from './accounts.js';
import { registerCatalogRoutes, resolveCourse } from './catalog.js';
import { logEvent, persistSession, registerRecordRoutes } from './records.js';
import { limitGuestRegistrations, normalizeRut, signGuestToken, verifyGuestToken } from './guest.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 10_000,
  pingTimeout: 8_000
});

const sessions = new Map();
const PORT = Number(process.env.PORT ?? 3001);
const corsOptions = { origin: true };

app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.use(express.json());

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const profRoom = (session) => `${session.sessionId}:prof`;
const stuRoom = (session) => `${session.sessionId}:stu`;

// Lo que ve el profesor: alumnos con sus datos, alertas y pedidos de ayuda.
function publicSession(session) {
  return {
    sessionId: session.sessionId,
    professorName: session.professorName,
    examName: session.examName,
    courseName: session.courseName ?? null,
    description: session.description ?? '',
    duration: session.duration,
    createdAt: session.createdAt,
    status: session.status,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    students: [...session.students.values()].map(({ socketId, ...student }) => student),
    alerts: session.alerts,
    helpRequests: session.helpRequests
  };
}

// Lo que ve un alumno: nunca los datos, correos ni alertas de sus compañeros.
function studentView(session) {
  return {
    sessionId: session.sessionId,
    professorName: session.professorName,
    examName: session.examName,
    courseName: session.courseName ?? null,
    description: session.description ?? '',
    duration: session.duration,
    status: session.status,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    students: [...session.students.values()].map(({ studentId, status }) => ({ studentId, status }))
  };
}

// Gravedad de cada tipo de alerta; lo que el cliente envíe fuera de esta lista se registra como "other".
const ALERT_SEVERITY = {
  tab_switch: 'warning', window_blur: 'warning', screen_lock: 'warning', context_menu: 'warning', shortcut: 'warning',
  copy: 'critical', cut: 'critical', paste: 'critical', print: 'critical', screenshot_key: 'critical',
  disconnected: 'critical', second_device: 'critical',
  returned: 'info', reconnected: 'info', orientation_change: 'info', idle: 'info', other: 'info'
};

const PRESENCE_ALERTS = new Set(['disconnected', 'reconnected', 'second_device']);

function recordAlert(session, student, type, message) {
  const alert = { alertId: randomUUID(), studentId: student.studentId, studentName: student.name, type, severity: ALERT_SEVERITY[type] ?? 'info', timestamp: new Date().toISOString(), message };
  session.alerts.unshift(alert);
  io.to(profRoom(session)).emit('alert:triggered', alert);
  // Desconexión, reconexión y segundo dispositivo ya quedan como eventos de presencia.
  if (!PRESENCE_ALERTS.has(type)) logEvent(session.sessionId, 'alert', { student, data: { alertType: type, message } });
  return alert;
}

function formatAway(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function emitSession(session) {
  io.to(profRoom(session)).emit('session:updated', publicSession(session));
  io.to(stuRoom(session)).emit('session:updated', studentView(session));
}

const LOGS_DIR = path.join(process.cwd(), 'logs');

async function saveSessionLog(session) {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const filePath = path.join(LOGS_DIR, `${session.sessionId}.json`);
    await writeFile(filePath, JSON.stringify(publicSession(session), null, 2), 'utf8');
  } catch (err) {
    console.error(`No se pudo guardar el registro de ${session.sessionId}:`, err);
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

registerAccountRoutes(app);
registerRecordRoutes(app, sessions);
registerCatalogRoutes(app);

app.post('/api/sessions', requireAuth('profesor', 'admin'), async (req, res) => {
  const { examName, duration = 60, courseId, customCourseName } = req.body;
  if (!examName?.trim()) return res.status(400).json({ message: 'El nombre del examen es obligatorio.' });

  // El nombre sale del perfil de quien inició sesión y el ramo debe pertenecer a sus áreas de profesorado.
  const profile = (await getUserProfile(req.auth.uid)) ?? {};
  const professorName = profile.name?.trim() || req.auth.name || req.auth.email;
  const resolved = await resolveCourse({ courseId, customCourseName, professorSpecialtyIds: profile.specialtyIds ?? [], isAdmin: req.auth.role === 'admin' });
  if (resolved.error) return res.status(400).json({ message: resolved.error });
  const { course, specialties } = resolved;

  const sessionId = `sess_${randomUUID().slice(0, 8)}`;
  const qrData = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/student/${sessionId}`;
  const qrCode = await QRCode.toDataURL(qrData, { margin: 2, width: 320 });
  const session = {
    sessionId,
    professorUid: req.auth.uid,
    professorEmail: req.auth.email,
    professorName,
    examName: examName.trim(),
    description: String(req.body.description ?? '').trim().slice(0, 500),
    courseId: course?.id ?? null,
    courseCustom: course?.custom === true,
    courseName: course?.name ?? null,
    courseCode: course?.code ?? null,
    career: course?.career ?? null,
    courseSemester: course?.semester ?? null,
    courseCategory: course?.category ?? null,
    specialtyIds: specialties.map((item) => item.id),
    specialtyNames: specialties.map((item) => item.name),
    duration: Math.max(5, Number(duration) || 60),
    createdAt: new Date().toISOString(),
    status: 'waiting',
    startedAt: null,
    endsAt: null,
    endedAt: null,
    students: new Map(),
    alerts: [],
    helpRequests: [],
    helpTotal: 0,
    helpResolvedTotal: 0,
    qrCode,
    qrData
  };
  sessions.set(sessionId, session);
  persistSession(session);
  logEvent(sessionId, 'session_created', { actor: req.auth, data: { examName: session.examName, duration: session.duration, courseName: session.courseName, description: session.description } });
  res.status(201).json({ ...publicSession(session), qrCode, qrData });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  res.json(studentView(session));
});

// Ingreso de un alumno por el QR, sin cuenta: nombre, correo y RUT que el profesor validará después.
app.post('/api/sessions/:sessionId/guest', limitGuestRegistrations, async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'La sesión no existe o ya terminó.' });
  if (!['waiting', 'active'].includes(session.status)) return res.status(409).json({ message: 'Esta sesión ya finalizó.' });

  const name = String(req.body.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const rut = normalizeRut(req.body.rut);
  if (name.length < 3 || name.length > 80) return res.status(400).json({ message: 'Ingresa tu nombre completo.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Ingresa un correo válido.' });
  if (!rut) return res.status(400).json({ message: 'El RUT no es válido. Revisa el número y el dígito verificador.' });

  const existing = [...session.students.values()].find((item) => item.identityKey === `rut:${rut}`);
  if (existing?.status === 'expelled') return res.status(403).json({ message: 'Fuiste expulsado de esta sesión y no puedes volver a entrar.' });
  if (existing && existing.email !== email) return res.status(409).json({ message: 'Ese RUT ya está registrado en esta sesión con otro correo.' });

  // Si además tiene una cuenta activa, el examen queda ligado a ella y aparece en su historial.
  const header = req.get('authorization') || '';
  const account = header.startsWith('Bearer ') ? await authFromToken(header.slice(7)) : null;
  const uid = account?.role === 'estudiante' ? account.uid : null;

  const fullName = existing?.name ?? name;
  res.json({ token: signGuestToken({ sid: session.sessionId, rut, name: fullName, email, uid }), student: { name: fullName, email, rut }, session: studentView(session) });
});

app.delete('/api/sessions/:sessionId', requireAuth('profesor', 'admin'), async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  if (session.professorEmail !== req.auth.email) return res.status(403).json({ message: 'No puedes finalizar una sesión que no creaste.' });
  session.status = 'ended';
  session.endedAt = new Date().toISOString();
  io.to(profRoom(session)).to(stuRoom(session)).emit('session:ended', { reason: 'manual_close' });
  emitSession(session);
  logEvent(session.sessionId, 'session_ended', { actor: req.auth, data: { reason: 'manual_close' } });
  await saveSessionLog(session);
  await persistSession(session);
  res.json({ success: true });
});

app.post('/api/sessions/:sessionId/expel/:studentId', requireAuth('profesor', 'admin'), (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  if (session.professorEmail !== req.auth.email) return res.status(403).json({ message: 'No autorizado.' });
  const student = session.students.get(req.params.studentId);
  if (!student) return res.status(404).json({ message: 'Estudiante no encontrado.' });
  student.status = 'expelled';
  session.helpRequests = session.helpRequests.filter((request) => request.studentId !== student.studentId);
  io.to(student.socketId).emit('student:expelled', { reason: 'expelled_by_professor' });
  emitSession(session);
  persistSession(session);
  logEvent(session.sessionId, 'student_expelled', { actor: req.auth, student });
  res.json({ success: true });
});

function startSession(session, actor) {
  if (session.status !== 'waiting') return false;
  const startedAt = new Date();
  session.status = 'active';
  session.startedAt = startedAt.toISOString();
  session.endsAt = new Date(startedAt.getTime() + session.duration * 60_000).toISOString();
  emitSession(session);
  persistSession(session);
  logEvent(session.sessionId, 'session_started', { actor, data: { endsAt: session.endsAt } });
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.status === 'active' && session.endsAt && Date.parse(session.endsAt) <= now) {
      session.status = 'ended';
      session.endedAt = new Date().toISOString();
      io.to(profRoom(session)).to(stuRoom(session)).emit('session:ended', { reason: 'time_expired' });
      emitSession(session);
      logEvent(session.sessionId, 'session_ended', { data: { reason: 'time_expired' } });
      saveSessionLog(session);
      persistSession(session);
    }
  }
}, 1000);

// Respaldo periódico de los exámenes en curso, por si el servidor se reinicia.
setInterval(() => {
  for (const session of sessions.values()) if (session.status === 'active') persistSession(session);
}, 30_000);

io.on('connection', (socket) => {
  socket.on('professor:join', async ({ sessionId, token }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    const auth = await authFromToken(token);
    if (!auth || !['profesor', 'admin'].includes(auth.role) || auth.email !== session.professorEmail) {
      return socket.emit('session:error', { message: 'No autorizado.' });
    }
    socket.join(profRoom(session));
    socket.emit('session:updated', publicSession(session));
  });

  socket.on('professor:start', async ({ sessionId, token }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    const auth = await authFromToken(token);
    if (!auth || !['profesor', 'admin'].includes(auth.role) || auth.email !== session.professorEmail) {
      return socket.emit('session:error', { message: 'No autorizado.' });
    }
    if (!startSession(session, auth)) return socket.emit('session:error', { message: 'La sesión ya fue iniciada o finalizada.' });
  });

  socket.on('student:join', async ({ sessionId, guestToken }) => {
    const guest = verifyGuestToken(guestToken);
    if (!guest || guest.sid !== sessionId) return socket.emit('session:error', { message: 'Tu pase de ingreso no es válido. Vuelve a escanear el QR para registrarte.' });
    const session = sessions.get(sessionId);
    if (!session || !['waiting', 'active'].includes(session.status)) {
      return socket.emit('session:error', { message: 'Esta sesión ya no está disponible.' });
    }

    // Al alumno se le identifica por su RUT: reconectar o reabrir el enlace retoma su mismo registro.
    const identityKey = `rut:${guest.rut}`;
    let student = [...session.students.values()].find((item) => item.identityKey === identityKey);
    if (student?.status === 'expelled') return socket.emit('session:error', { message: 'Fuiste expulsado de esta sesión y no puedes volver a entrar.' });
    if (student && student.email !== guest.email) return socket.emit('session:error', { message: 'Ese RUT ya está registrado en esta sesión con otro correo.' });

    if (student) {
      const previous = io.sockets.sockets.get(student.socketId);
      if (previous && previous.id !== socket.id) {
        previous.data.replaced = true;
        previous.emit('student:replaced');
        previous.disconnect(true);
        if (session.status === 'active') recordAlert(session, student, 'second_device', 'Abrió la sesión en otro dispositivo o pestaña');
        logEvent(sessionId, 'student_replaced', { student, data: { sessionStatus: session.status } });
      } else if (student.status === 'offline') {
        const away = Math.max(0, Math.round((Date.now() - Date.parse(student.leftAt ?? student.joinedAt)) / 1000));
        if (session.status === 'active') recordAlert(session, student, 'reconnected', `Volvió a la sesión tras ${formatAway(away)} desconectado`);
        logEvent(sessionId, 'student_reconnected', { student, data: { awaySeconds: away, sessionStatus: session.status } });
      }
      student.socketId = socket.id;
      student.status = 'active';
      student.leftAt = null;
    } else {
      const studentId = `student_${randomUUID().slice(0, 8)}`;
      student = { studentId, identityKey, guest: true, uid: guest.uid ?? null, rut: guest.rut, socketId: socket.id, name: guest.name, email: guest.email, joinedAt: new Date().toISOString(), leftAt: null, status: 'active' };
      session.students.set(studentId, student);
      logEvent(sessionId, 'student_joined', { student, data: { sessionStatus: session.status, rut: student.rut } });
    }

    socket.data = { sessionId, studentId: student.studentId };
    socket.join(stuRoom(session));
    socket.emit('session:connected', { sessionId, studentId: student.studentId, students: studentView(session).students });
    io.to(profRoom(session)).emit('student:joined', { ...student, socketId: undefined });
    emitSession(session);
    persistSession(session);
  });

  socket.on('student:event', ({ sessionId, type, message }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data.studentId);
    if (!session || !student || student.socketId !== socket.id || session.status !== 'active') return;

    // Tope por conexión para que una ráfaga de eventos no sature el panel del profesor.
    const now = Date.now();
    const recent = (socket.data.eventTimes ?? []).filter((time) => now - time < 10_000);
    if (recent.length >= 40) return;
    recent.push(now);
    socket.data.eventTimes = recent;

    const alertType = Object.hasOwn(ALERT_SEVERITY, type) ? type : 'other';
    const alert = recordAlert(session, student, alertType, String(message ?? '').slice(0, 200) || 'Actividad registrada');
    socket.emit('alert:recorded', alert);
    emitSession(session);
  });

  socket.on('student:help_request', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data?.studentId);
    if (!session || !student || student.status !== 'active') return;
    if (session.helpRequests.some((request) => request.studentId === student.studentId)) return;
    const request = { requestId: randomUUID(), studentId: student.studentId, studentName: student.name, requestedAt: new Date().toISOString() };
    session.helpRequests.push(request);
    session.helpTotal += 1;
    logEvent(sessionId, 'help_requested', { student, data: { requestId: request.requestId } });
    io.to(profRoom(session)).emit('help:requested', request);
    emitSession(session);
  });

  socket.on('student:help_cancel', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data?.studentId);
    if (!session || !student) return;
    const hadRequest = session.helpRequests.some((request) => request.studentId === student.studentId);
    if (!hadRequest) return;
    session.helpRequests = session.helpRequests.filter((request) => request.studentId !== student.studentId);
    logEvent(sessionId, 'help_cancelled', { student, data: { reason: 'student_cancelled' } });
    io.to(profRoom(session)).emit('help:cancelled', { studentId: student.studentId });
    emitSession(session);
  });

  socket.on('professor:resolve_help', async ({ sessionId, requestId, token }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    const auth = await authFromToken(token);
    if (!auth || !['profesor', 'admin'].includes(auth.role) || auth.email !== session.professorEmail) {
      return socket.emit('session:error', { message: 'No autorizado.' });
    }
    const request = session.helpRequests.find((item) => item.requestId === requestId);
    if (!request) return;
    session.helpRequests = session.helpRequests.filter((item) => item.requestId !== requestId);
    const student = session.students.get(request.studentId);
    if (student) io.to(student.socketId).emit('help:resolved', { requestId });
    session.helpResolvedTotal += 1;
    logEvent(sessionId, 'help_resolved', { actor: auth, student, data: { requestId, waitedSeconds: Math.round((Date.now() - Date.parse(request.requestedAt)) / 1000) } });
    emitSession(session);
  });

  socket.on('disconnect', () => {
    const { sessionId, studentId } = socket.data ?? {};
    const session = sessions.get(sessionId);
    const student = session?.students.get(studentId);
    if (!session || !student) return;
    // Un socket reemplazado por otro (misma cuenta) ya no representa al alumno.
    if (socket.data.replaced || student.socketId !== socket.id) return;
    let changed = false;
    if (student.status === 'active') {
      student.status = 'offline';
      student.leftAt = new Date().toISOString();
      if (session.status === 'active') recordAlert(session, student, 'disconnected', 'Se desconectó de la sesión (cerró la pestaña, apagó el equipo o perdió la conexión)');
      logEvent(sessionId, 'student_left', { student, data: { sessionStatus: session.status } });
      io.to(profRoom(session)).emit('student:left', { ...student, socketId: undefined });
      changed = true;
    }
    if (session.helpRequests.some((request) => request.studentId === studentId)) {
      session.helpRequests = session.helpRequests.filter((request) => request.studentId !== studentId);
      changed = true;
    }
    if (changed) {
      emitSession(session);
      persistSession(session);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Anti-Fraud API listening on port ${PORT}`));
