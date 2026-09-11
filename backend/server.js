import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { randomUUID, createHmac } from 'node:crypto';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true }
});

const sessions = new Map();
const PORT = Number(process.env.PORT ?? 3001);
const corsOptions = { origin: true };

app.use(cors(corsOptions));
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar-esta-clave';
const TOKEN_SECRET = process.env.TOKEN_SECRET || ADMIN_PASSWORD;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ message: 'No autorizado. Inicia sesión nuevamente.' });
  next();
}

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
    alerts: session.alerts
  };
}

function emitSession(session) {
  io.to(session.sessionId).emit('session:updated', publicSession(session));
}

const SEVERITY_BY_TYPE = {
  window_blur: 'warning',
  tab_switch: 'warning',
  notification_shade: 'warning',
  app_resumed: 'info',
  disconnected: 'warning',
  reconnected: 'success',
  offline: 'danger',
  devtools: 'danger'
};

function pushAlert(session, { studentId, studentName, type, message, severity }) {
  const alert = { alertId: randomUUID(), studentId, studentName, type, severity: severity || SEVERITY_BY_TYPE[type] || 'warning', timestamp: new Date().toISOString(), message };
  session.alerts.unshift(alert);
  io.to(session.sessionId).emit('alert:triggered', alert);
  return alert;
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const AWAY_GRACE_MS = 45_000;
const awayTimers = new Map();

function scheduleOfflineCheck(session, student) {
  const key = `${session.sessionId}:${student.studentId}`;
  clearTimeout(awayTimers.get(key));
  awayTimers.set(key, setTimeout(() => {
    awayTimers.delete(key);
    if (student.status === 'away') {
      student.status = 'offline';
      pushAlert(session, { studentId: student.studentId, studentName: student.name, type: 'offline', message: 'Sigue sin reconectarse: posible salida de la sesión.' });
      emitSession(session);
    }
  }, AWAY_GRACE_MS));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ message: 'Contraseña incorrecta.' });
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  res.json({ token: signToken({ role: 'professor', exp: expiresAt }), expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { professorName, examName, duration = 60 } = req.body;
  if (!professorName?.trim() || !examName?.trim()) {
    return res.status(400).json({ message: 'El nombre del profesor y el examen son obligatorios.' });
  }

  const sessionId = `sess_${randomUUID().slice(0, 8)}`;
  const qrData = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/student/${sessionId}`;
  const qrCode = await QRCode.toDataURL(qrData, { margin: 2, width: 320 });
  const session = {
    sessionId,
    professorName: professorName.trim(),
    examName: examName.trim(),
    duration: Math.max(5, Number(duration) || 60),
    createdAt: new Date().toISOString(),
    status: 'waiting',
    startedAt: null,
    endsAt: null,
    students: new Map(),
    alerts: [],
    qrCode,
    qrData
  };
  sessions.set(sessionId, session);
  res.status(201).json({ ...publicSession(session), qrCode, qrData });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  res.json({ ...publicSession(session), qrCode: session.qrCode, qrData: session.qrData });
});

app.delete('/api/sessions/:sessionId', requireAuth, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  session.status = 'ended';
  io.to(session.sessionId).emit('session:ended', { reason: 'manual_close' });
  emitSession(session);
  res.json({ success: true });
});

app.post('/api/sessions/:sessionId/expel/:studentId', requireAuth, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  const student = session?.students.get(req.params.studentId);
  if (!session || !student) return res.status(404).json({ message: 'Estudiante no encontrado.' });
  student.status = 'expelled';
  io.to(student.socketId).emit('student:expelled', { reason: 'expelled_by_professor' });
  emitSession(session);
  res.json({ success: true });
});

function startSession(session) {
  if (session.status !== 'waiting') return false;
  const startedAt = new Date();
  session.status = 'active';
  session.startedAt = startedAt.toISOString();
  session.endsAt = new Date(startedAt.getTime() + session.duration * 60_000).toISOString();
  emitSession(session);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.status === 'active' && session.endsAt && Date.parse(session.endsAt) <= now) {
      session.status = 'ended';
      io.to(session.sessionId).emit('session:ended', { reason: 'time_expired' });
      emitSession(session);
    }
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('professor:join', ({ sessionId, token }) => {
    if (!verifyToken(token)) return socket.emit('session:error', { message: 'No autorizado.' });
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    socket.join(sessionId);
    socket.emit('session:updated', publicSession(session));
  });

  socket.on('professor:start', ({ sessionId, token }) => {
    if (!verifyToken(token)) return socket.emit('session:error', { message: 'No autorizado.' });
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    if (!startSession(session)) return socket.emit('session:error', { message: 'La sesión ya fue iniciada o finalizada.' });
  });

  socket.on('student:join', ({ sessionId, name, studentId: existingId }) => {
    const session = sessions.get(sessionId);
    if (!session || !['waiting', 'active'].includes(session.status)) {
      return socket.emit('session:error', { message: 'Esta sesión ya no está disponible.' });
    }
    const existing = existingId && session.students.get(existingId);
    if (existing && existing.status === 'expelled') {
      return socket.emit('session:error', { message: 'Fuiste expulsado de esta sesión.' });
    }
    let student = existing;
    if (student) {
      const wasAway = student.status === 'away' || student.status === 'offline';
      student.socketId = socket.id;
      student.status = 'active';
      if (name?.trim()) student.name = name.trim();
      if (wasAway) {
        const key = `${sessionId}:${student.studentId}`;
        clearTimeout(awayTimers.get(key));
        awayTimers.delete(key);
        const awaySeconds = student.awaySince ? Math.round((Date.now() - Date.parse(student.awaySince)) / 1000) : null;
        student.awaySince = null;
        pushAlert(session, { studentId: student.studentId, studentName: student.name, type: 'reconnected', message: awaySeconds != null ? `Reconectado tras ${formatDuration(awaySeconds)}.` : 'Reconectado a la sesión.' });
      }
    } else {
      const studentId = `student_${randomUUID().slice(0, 8)}`;
      student = { studentId, socketId: socket.id, name: name.trim(), joinedAt: new Date().toISOString(), status: 'active', awaySince: null };
      session.students.set(studentId, student);
    }
    socket.data = { sessionId, studentId: student.studentId };
    socket.join(sessionId);
    socket.emit('session:connected', { sessionId, studentId: student.studentId, students: [...session.students.values()] });
    io.to(sessionId).emit('student:joined', student);
    emitSession(session);
  });

  socket.on('student:event', ({ sessionId, type, message }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data.studentId);
    if (!session || !student) return;
    const alert = pushAlert(session, { studentId: student.studentId, studentName: student.name, type, message: message || 'Actividad registrada' });
    socket.emit('alert:recorded', alert);
    emitSession(session);
  });

  socket.on('disconnect', () => {
    const { sessionId, studentId } = socket.data ?? {};
    const session = sessions.get(sessionId);
    const student = session?.students.get(studentId);
    if (session && student && student.status === 'active') {
      student.status = 'away';
      student.awaySince = new Date().toISOString();
      pushAlert(session, { studentId: student.studentId, studentName: student.name, type: 'disconnected', message: 'Se desconectó (pantalla apagada o pérdida de señal).' });
      io.to(sessionId).emit('student:left', student);
      emitSession(session);
      scheduleOfflineCheck(session, student);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Anti-Fraud API listening on port ${PORT}`));
