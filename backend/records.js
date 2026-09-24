import { randomUUID } from 'node:crypto';
import { firestore, requireAuth } from './accounts.js';
import { buildExamReport } from './reports.js';

const exams = firestore.collection('exams');
const REVIEW_STATUSES = ['', 'clear', 'suspicious', 'annulled'];
const EVENT_CATEGORIES = {
  session_created: 'session', session_started: 'session', session_ended: 'session',
  student_joined: 'presence', student_left: 'presence', student_reconnected: 'presence', student_replaced: 'presence',
  alert: 'alert',
  help_requested: 'help', help_cancelled: 'help', help_resolved: 'help',
  student_expelled: 'moderation',
  review_set: 'review', notes_updated: 'review', record_archived: 'review', report_exported: 'review'
};

// Registro cronológico de todo lo que ocurre en un examen. Solo se agregan documentos, nunca se editan:
// el id (hora + sufijo) los mantiene ordenados y sirve de base para informes.
export function logEvent(sessionId, type, { actor = null, student = null, data = null } = {}) {
  const at = new Date();
  const id = `${String(at.getTime()).padStart(13, '0')}-${randomUUID().slice(0, 6)}`;
  exams.doc(sessionId).collection('events').doc(id).set({
    type,
    category: EVENT_CATEGORIES[type] ?? 'other',
    at: at.toISOString(),
    actor: actor ? { uid: actor.uid ?? null, email: actor.email ?? null, role: actor.role ?? null } : null,
    studentId: student?.studentId ?? null,
    studentUid: student?.uid ?? null,
    studentName: student?.name ?? null,
    data
  }).catch((err) => console.error(`No se pudo registrar el evento ${type} de ${sessionId}:`, err.message));
}

export function examRecord(session) {
  const students = [...session.students.values()].map(({ socketId, ...student }) => student);
  return {
    sessionId: session.sessionId,
    professorUid: session.professorUid,
    professorEmail: session.professorEmail,
    professorName: session.professorName,
    examName: session.examName,
    duration: session.duration,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    endedAt: session.endedAt ?? null,
    students,
    studentUids: [...new Set(students.map((student) => student.uid).filter(Boolean))],
    alerts: session.alerts,
    helpRequestCount: session.helpRequests.length,
    stats: {
      studentCount: students.length,
      alertCount: session.alerts.length,
      alertsByType: session.alerts.reduce((counts, alert) => ({ ...counts, [alert.type]: (counts[alert.type] ?? 0) + 1 }), {}),
      expelledCount: students.filter((student) => student.status === 'expelled').length,
      helpRequested: session.helpTotal ?? 0,
      helpResolved: session.helpResolvedTotal ?? 0,
      durationSeconds: session.startedAt && session.endedAt ? Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000) : null
    },
    updatedAt: new Date().toISOString()
  };
}

// merge: conserva las notas y revisiones que el profesor agrega después.
export async function persistSession(session) {
  try {
    await exams.doc(session.sessionId).set(examRecord(session), { merge: true });
  } catch (err) {
    console.error(`No se pudo guardar el examen ${session.sessionId} en Firestore:`, err.message);
  }
}

function summarize(record) {
  const reviews = record.reviews ?? {};
  return {
    sessionId: record.sessionId,
    examName: record.examName,
    professorName: record.professorName,
    status: record.status,
    duration: record.duration,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    studentCount: record.students?.length ?? 0,
    alertCount: record.alerts?.length ?? 0,
    suspiciousCount: Object.values(reviews).filter((review) => review.status === 'suspicious').length
  };
}

export function registerRecordRoutes(app, sessions) {
  // Los exámenes en curso viven en memoria: se usan como fuente más reciente.
  const withLive = (record) => {
    const live = sessions.get(record.sessionId);
    return live ? { ...record, ...examRecord(live) } : record;
  };

  async function ownedExam(req, res) {
    const snapshot = await exams.doc(req.params.sessionId).get();
    if (!snapshot.exists || snapshot.data().professorUid !== req.auth.uid) {
      res.status(404).json({ message: 'Examen no encontrado.' });
      return null;
    }
    return snapshot;
  }

  const professorOnly = requireAuth('profesor', 'admin');

  app.get('/api/professor/exams', professorOnly, async (req, res) => {
    const snapshot = await exams.where('professorUid', '==', req.auth.uid).get();
    const list = snapshot.docs.filter((doc) => !doc.data().archived).map((doc) => summarize(withLive(doc.data())));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  });

  app.get('/api/professor/exams/:sessionId', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (snapshot) res.json(withLive(snapshot.data()));
  });

  app.patch('/api/professor/exams/:sessionId', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    const notes = String(req.body.notes ?? '').slice(0, 4000);
    await snapshot.ref.update({ notes });
    logEvent(req.params.sessionId, 'notes_updated', { actor: req.auth, data: { notes } });
    res.json({ notes });
  });

  app.put('/api/professor/exams/:sessionId/reviews/:studentId', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    const { studentId } = req.params;
    if (!snapshot.data().students?.some((student) => student.studentId === studentId)) {
      return res.status(404).json({ message: 'Estudiante no encontrado en este examen.' });
    }
    const status = req.body.status ?? '';
    if (!REVIEW_STATUSES.includes(status)) return res.status(400).json({ message: 'Estado de revisión inválido.' });
    const review = { status, note: String(req.body.note ?? '').slice(0, 1000), reviewedAt: new Date().toISOString() };
    await snapshot.ref.update({ [`reviews.${studentId}`]: review });
    const student = snapshot.data().students.find((item) => item.studentId === studentId);
    logEvent(req.params.sessionId, 'review_set', { actor: req.auth, student, data: { status: review.status, note: review.note } });
    res.json(review);
  });

  app.get('/api/professor/exams/:sessionId/events', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    const events = await snapshot.ref.collection('events').get();
    res.json(events.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  });

  // Informe en Excel: resumen, alumnos, alertas e historial completo del examen.
  app.get('/api/professor/exams/:sessionId/report.xlsx', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    try {
      const exam = withLive(snapshot.data());
      const events = (await snapshot.ref.collection('events').get()).docs.map((doc) => doc.data());
      const uids = [...new Set((exam.students ?? []).map((student) => student.uid).filter(Boolean))];
      const profiles = {};
      if (uids.length) {
        const docs = await firestore.getAll(...uids.map((uid) => firestore.collection('users').doc(uid)));
        for (const doc of docs) if (doc.exists) profiles[doc.id] = doc.data();
      }
      const buffer = await buildExamReport({ exam, events, profiles });
      logEvent(req.params.sessionId, 'report_exported', { actor: req.auth, data: { format: 'xlsx' } });
      const filename = `informe-${exam.examName}`.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '-') || 'informe';
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="informe.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`
      });
      res.send(Buffer.from(buffer));
    } catch (err) {
      console.error('No se pudo generar el informe:', err);
      res.status(500).json({ message: 'No se pudo generar el informe.' });
    }
  });

  // "Eliminar" solo oculta el examen de la lista: el registro y su historial se conservan.
  app.delete('/api/professor/exams/:sessionId', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    const live = sessions.get(req.params.sessionId);
    if (live && live.status !== 'ended') {
      return res.status(409).json({ message: 'Finaliza la sesión antes de archivar su registro.' });
    }
    await snapshot.ref.update({ archived: true, archivedAt: new Date().toISOString(), archivedBy: req.auth.email });
    logEvent(req.params.sessionId, 'record_archived', { actor: req.auth });
    res.json({ success: true });
  });

  app.get('/api/student/exams', requireAuth('estudiante'), async (req, res) => {
    const snapshot = await exams.where('studentUids', 'array-contains', req.auth.uid).get();
    const list = snapshot.docs.map((doc) => {
      const record = withLive(doc.data());
      const mine = (record.students ?? []).filter((student) => student.uid === req.auth.uid);
      const myIds = new Set(mine.map((student) => student.studentId));
      return {
        sessionId: record.sessionId,
        examName: record.examName,
        professorName: record.professorName,
        status: record.status,
        duration: record.duration,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? null,
        myStatus: mine.at(-1)?.status ?? 'active',
        myJoinedAt: mine[0]?.joinedAt ?? null,
        myAlerts: (record.alerts ?? []).filter((alert) => myIds.has(alert.studentId)).map(({ type, message, timestamp }) => ({ type, message, timestamp }))
      };
    });
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  });
}
