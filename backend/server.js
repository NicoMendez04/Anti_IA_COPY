import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true }
});

const sessions = new Map();
const authTokens = new Map();
const PORT = Number(process.env.PORT ?? 3001);
const corsOptions = { origin: true };

app.use(cors(corsOptions));
app.use(express.json());

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let users = {};
try {
  users = JSON.parse(await readFile(USERS_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error('No se pudo leer users.json:', err);
}

async function saveUsers() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function requireAuth(role) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const auth = token ? authTokens.get(token) : null;
    if (!auth || auth.role !== role) return res.status(401).json({ message: 'Debes iniciar sesión.' });
    req.auth = auth;
    next();
  };
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

app.post('/api/auth/login', async (req, res) => {
  const { password, role } = req.body;
  const email = String(req.body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Ingresa un correo válido.' });
  if (!password || password.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });
  if (!['profesor', 'estudiante'].includes(role)) return res.status(400).json({ message: 'Rol inválido.' });

  const existing = users[email];
  if (existing) {
    if (existing.role !== role) return res.status(409).json({ message: `Ese correo ya está registrado como ${existing.role}.` });
    const valid = await bcrypt.compare(password, existing.passwordHash);
    if (!valid) return res.status(401).json({ message: 'Contraseña incorrecta.' });
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    users[email] = { passwordHash, role, createdAt: new Date().toISOString() };
    await saveUsers();
  }

  const token = randomUUID();
  authTokens.set(token, { email, role });
  res.json({ token, email, role });
});

app.get('/api/auth/me', (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const auth = token ? authTokens.get(token) : null;
  if (!auth) return res.status(401).json({ message: 'Sesión no válida.' });
  res.json(auth);
});

app.post('/api/sessions', requireAuth('profesor'), async (req, res) => {
  const { professorName, examName, duration = 60 } = req.body;
  if (!professorName?.trim() || !examName?.trim()) {
    return res.status(400).json({ message: 'El nombre del profesor y el examen son obligatorios.' });
  }

  const sessionId = `sess_${randomUUID().slice(0, 8)}`;
  const qrData = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/student/${sessionId}`;
  const qrCode = await QRCode.toDataURL(qrData, { margin: 2, width: 320 });
  const session = {
    sessionId,
    professorEmail: req.auth.email,
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

app.delete('/api/sessions/:sessionId', requireAuth('profesor'), async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  if (session.professorEmail !== req.auth.email) return res.status(403).json({ message: 'No puedes finalizar una sesión que no creaste.' });
  session.status = 'ended';
  io.to(session.sessionId).emit('session:ended', { reason: 'manual_close' });
  emitSession(session);
  await saveSessionLog(session);
  res.json({ success: true });
});

app.post('/api/sessions/:sessionId/expel/:studentId', requireAuth('profesor'), (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  if (session.professorEmail !== req.auth.email) return res.status(403).json({ message: 'No autorizado.' });
  const student = session.students.get(req.params.studentId);
  if (!student) return res.status(404).json({ message: 'Estudiante no encontrado.' });
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
      saveSessionLog(session);
    }
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('professor:join', ({ sessionId, token }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    const auth = token ? authTokens.get(token) : null;
    if (!auth || auth.role !== 'profesor' || auth.email !== session.professorEmail) {
      return socket.emit('session:error', { message: 'No autorizado.' });
    }
    socket.join(sessionId);
    socket.emit('session:updated', publicSession(session));
  });

  socket.on('professor:start', ({ sessionId, token }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    const auth = token ? authTokens.get(token) : null;
    if (!auth || auth.role !== 'profesor' || auth.email !== session.professorEmail) {
      return socket.emit('session:error', { message: 'No autorizado.' });
    }
    if (!startSession(session)) return socket.emit('session:error', { message: 'La sesión ya fue iniciada o finalizada.' });
  });

  socket.on('student:join', ({ sessionId, name, token }) => {
    const auth = token ? authTokens.get(token) : null;
    if (!auth || auth.role !== 'estudiante') return socket.emit('session:error', { message: 'Debes iniciar sesión para unirte.' });
    const session = sessions.get(sessionId);
    if (!session || !['waiting', 'active'].includes(session.status)) {
      return socket.emit('session:error', { message: 'Esta sesión ya no está disponible.' });
    }
    const studentId = `student_${randomUUID().slice(0, 8)}`;
    const student = { studentId, socketId: socket.id, name: name.trim(), email: auth.email, joinedAt: new Date().toISOString(), status: 'active' };
    session.students.set(studentId, student);
    socket.data = { sessionId, studentId };
    socket.join(sessionId);
    socket.emit('session:connected', { sessionId, studentId, students: [...session.students.values()] });
    io.to(sessionId).emit('student:joined', student);
    emitSession(session);
  });

  socket.on('student:event', ({ sessionId, type, message }) => {
    const session = sessions.get(sessionId);
    const student = session?.students.get(socket.data.studentId);
    if (!session || !student) return;
    const alert = { alertId: randomUUID(), studentId: student.studentId, studentName: student.name, type, timestamp: new Date().toISOString(), message: message || 'Actividad registrada' };
    session.alerts.unshift(alert);
    io.to(sessionId).emit('alert:triggered', alert);
    socket.emit('alert:recorded', alert);
    emitSession(session);
  });

  socket.on('disconnect', () => {
    const { sessionId, studentId } = socket.data ?? {};
    const session = sessions.get(sessionId);
    const student = session?.students.get(studentId);
    if (session && student && student.status === 'active') {
      student.status = 'offline';
      io.to(sessionId).emit('student:left', student);
      emitSession(session);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Anti-Fraud API listening on port ${PORT}`));
