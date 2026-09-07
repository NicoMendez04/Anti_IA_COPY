import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';

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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/sessions', async (req, res) => {
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

app.delete('/api/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' });
  session.status = 'ended';
  io.to(session.sessionId).emit('session:ended', { reason: 'manual_close' });
  emitSession(session);
  res.json({ success: true });
});

app.post('/api/sessions/:sessionId/expel/:studentId', (req, res) => {
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
  socket.on('professor:join', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    socket.join(sessionId);
    socket.emit('session:updated', publicSession(session));
  });

  socket.on('professor:start', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('session:error', { message: 'Sesión no encontrada.' });
    if (!startSession(session)) return socket.emit('session:error', { message: 'La sesión ya fue iniciada o finalizada.' });
  });

  socket.on('student:join', ({ sessionId, name }) => {
    const session = sessions.get(sessionId);
    if (!session || !['waiting', 'active'].includes(session.status)) {
      return socket.emit('session:error', { message: 'Esta sesión ya no está disponible.' });
    }
    const studentId = `student_${randomUUID().slice(0, 8)}`;
    const student = { studentId, socketId: socket.id, name: name.trim(), joinedAt: new Date().toISOString(), status: 'active' };
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
