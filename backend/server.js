import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { authFromToken, registerAccountRoutes, requireAuth } from './accounts.js';
import { logEvent, persistSession, registerRecordRoutes } from './records.js';

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

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    professorName: session.professorName,
    examName: session.examName,
    duration: session.duration,
    createdAt: session.createdAt,
    status: session.status,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    students: [...session.students.values()],
    alerts: session.alerts,
    helpRequests: session.helpRequests
  };
}

const PRESENCE_ALERTS = new Set(['disconnected', 'reconnected', 'second_device']);

function recordAlert(session, student, type, message) {
  const alert = { alertId: randomUUID(), studentId: student.studentId, studentName: student.name, type, timestamp: new Date().toISOString(), message };
  session.alerts.unshift(alert);
  io.to(session.sessionId).emit('alert:triggered', alert);
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
  io.to(session.sessionId).emit('session:updated', publicSession(session));
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

app.post('/api/sessions', requireAuth('profesor', 'admin'), async (req, res) => {
  const { professorName, examName, duration = 60 } = req.body;
  if (!professorName?.trim() || !examName?.trim()) {
    return res.status(400).json({ message: 'El nombre del profesor y el examen son obligatorios.' });
  }

  const sessionId = `sess_${randomUUID().slice(0, 8)}`;
  const qrData = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/student/${sessionId}`;
  const qrCode = await QRCode.toDataURL(qrData, { margin: 2, width: 320 });
  const session = {
    sessionId,
    professorUid: req.auth.uid,
    professorEmail: req.auth.email,
    professorName: professorName.trim(),
    examName: examName.trim(),
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
  logEvent(sessionId, 'session_created', { actor: req.auth, data: { examName: session.examName, duration: session.duration } });
  res.status(201).json({ ...publicSession(session), qrCode, qrData });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  res.json({ ...publicSession(session), qrCode: session.qrCode, qrData: session.qrData });
});

app.delete('/api/sessions/:sessionId', requireAuth('profesor', 'admin'), async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  if (session.professorEmail !== req.auth.email) return res.status(403).json({ message: 'No puedes finalizar una sesión que no creaste.' });
  session.status = 'ended';
  session.endedAt = new Date().toISOString();
  io.to(session.sessionId).emit('session:ended', { reason: 'manual_close' });
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
      io.to(session.sessionId).emit('session:ended', { reason: 'time_expired' });
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
    socket.join(sessionId);
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

  socket.on('student:join', async ({ sessionId, name, token }) => {
    const auth = await authFromToken(token);
    if (!auth || auth.role !== 'estudiante') return socket.emit('session:error', { message: 'Debes iniciar sesión para unirte.' });
    const session = sessions.get(sessionId);
    if (!session || !['waiting', 'active'].includes(session.status)) {
      return socket.emit('session:error', { message: 'Esta sesión ya no está disponible.' });
    }

    // Se identifica al alumno por su cuenta: reconectar o reabrir el enlace retoma su registro.
    let student = [...session.students.values()].find((item) => item.uid === auth.uid);
    if (student?.status === 'expelled') return socket.emit('session:error', { message: 'Fuiste expulsado de esta sesión y no puedes volver a entrar.' });

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
      const cleanName = String(name ?? '').trim() || auth.name || 'Estudiante';
      student = { studentId, uid: auth.uid, socketId: socket.id, name: cleanName, email: auth.email, joinedAt: new Date().toISOString(), leftAt: null, status: 'active' };
      session.students.set(studentId, student);
      logEvent(sessionId, 'student_joined', { student, data: { sessionStatus: session.status } });
    }

    socket.data = { sessionId, studentId: student.studentId };
    socket.join(sessionId);
    socket.emit('session:connected', { sessionId, studentId: student.studentId, students: [...session.students.values()] });
    io.to(sessionId).emit('student:joined', student);
    emitSession(session);
    persistSession(session);
  });

  socket.on('student:event', ({ sessionId, type, message }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data.studentId);
    if (!session || !student || student.socketId !== socket.id) return;
    const alert = recordAlert(session, student, type, message || 'Actividad registrada');
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
    io.to(sessionId).emit('help:requested', request);
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
    io.to(sessionId).emit('help:cancelled', { studentId: student.studentId });
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
      io.to(sessionId).emit('student:left', student);
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
