import { firestore, requireAuth } from './accounts.js';

const exams = firestore.collection('exams');
const REVIEW_STATUSES = ['', 'clear', 'suspicious', 'annulled'];

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

  const professorOnly = requireAuth('profesor');

  app.get('/api/professor/exams', professorOnly, async (req, res) => {
    const snapshot = await exams.where('professorUid', '==', req.auth.uid).get();
    const list = snapshot.docs.map((doc) => summarize(withLive(doc.data())));
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
    res.json(review);
  });

  app.delete('/api/professor/exams/:sessionId', professorOnly, async (req, res) => {
    const snapshot = await ownedExam(req, res);
    if (!snapshot) return;
    const live = sessions.get(req.params.sessionId);
    if (live && live.status !== 'ended') {
      return res.status(409).json({ message: 'Finaliza la sesión antes de eliminar su registro.' });
    }
    await snapshot.ref.delete();
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
