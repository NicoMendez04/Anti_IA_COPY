import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const AVATAR_COLORS = ['#c9f469', '#f4e3a6', '#e6c3bb', '#bfd8f2', '#d9c8f0', '#c7e8d5'];
const REVIEW_LABELS = { '': 'Sin revisar', clear: 'Sin observaciones', suspicious: 'Sospechoso', annulled: 'Anulado' };
const EXAM_STATUS = { waiting: 'En espera', active: 'En curso', ended: 'Finalizado' };
const STUDENT_STATUS = { active: 'Conectado', offline: 'Desconectado', expelled: 'Expulsado' };
const ALERT_LABELS = { tab_switch: 'Cambio de pestaña', window_blur: 'Pérdida de foco', screen_lock: 'Pantalla oculta o bloqueada', disconnected: 'Desconexión', reconnected: 'Reconexión', second_device: 'Otro dispositivo' };
const NAV = {
  profesor: [['/professor', 'Nueva sesión'], ['/professor/exams', 'Mis exámenes'], ['/professor/profile', 'Mi perfil']],
  estudiante: [['/student', 'Unirme a un examen'], ['/student/exams', 'Mis exámenes'], ['/student/profile', 'Mi perfil']]
};

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const formatTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const alertLabel = (alert) => ALERT_LABELS[alert.type] ?? alert.type;

function downloadCsv(filename, rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob([`﻿${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  link.click();
  URL.revokeObjectURL(link.href);
}

export function Avatar({ name, color }) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('');
  return <span className="avatar" style={{ background: color || AVATAR_COLORS[0] }}>{initials || '?'}</span>;
}

export function AreaNav({ role, profile, onLogout }) {
  const { pathname } = useLocation();
  return <nav className="area-nav">
    {NAV[role].map(([to, label]) => <Link key={to} to={to} className={pathname === to ? 'is-active' : ''}>{label}</Link>)}
    <span className="area-nav-spacer" />
    {profile && <span className="area-user"><Avatar name={profile.name || profile.email} color={profile.avatarColor} /> {profile.name || profile.email}</span>}
    {onLogout && <button className="row-action" type="button" onClick={onLogout}>Cerrar sesión</button>}
  </nav>;
}

export function ProfileView({ api, role, profile, onSaved }) {
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState({ error: '', ok: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (profile) setForm({ name: profile.name ?? '', institution: profile.institution ?? '', department: profile.department ?? '', subjects: profile.subjects ?? '', career: profile.career ?? '', studentId: profile.studentId ?? '', avatarColor: profile.avatarColor ?? AVATAR_COLORS[0] }); }, [profile]);
  if (!form) return <p className="admin-empty">Cargando perfil…</p>;
  const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });
  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage({ error: '', ok: '' });
    try { onSaved(await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(form) })); setMessage({ error: '', ok: 'Perfil actualizado.' }); }
    catch (caught) { setMessage({ error: caught.message, ok: '' }); } finally { setSaving(false); }
  }
  return <div className="profile-page">
    <div className="page-kicker">MI PERFIL <span>{role === 'profesor' ? 'PROFESOR' : 'ESTUDIANTE'}</span></div>
    <div className="profile-head"><Avatar name={form.name || profile.email} color={form.avatarColor} /><div><h1>{form.name || 'Tu perfil'}</h1><p>{profile.email} · desde {formatDate(profile.createdAt)}</p></div></div>
    <form className="profile-form" onSubmit={save}>
      <label>Nombre completo<input required value={form.name} onChange={set('name')} /></label>
      <label>Institución<input value={form.institution} onChange={set('institution')} placeholder="Ej. Universidad de Chile" /></label>
      {role === 'profesor' ? <>
        <label>Departamento o facultad<input value={form.department} onChange={set('department')} /></label>
        <label>Asignaturas<input value={form.subjects} onChange={set('subjects')} placeholder="Ej. Álgebra, Cálculo I" /></label>
      </> : <>
        <label>Carrera<input value={form.career} onChange={set('career')} /></label>
        <label>Matrícula<input value={form.studentId} onChange={set('studentId')} /></label>
      </>}
      <div className="profile-colors"><span>Color del avatar</span><div>{AVATAR_COLORS.map((color) => <button key={color} type="button" aria-label={`Color ${color}`} className={form.avatarColor === color ? 'is-active' : ''} style={{ background: color }} onClick={() => setForm({ ...form, avatarColor: color })} />)}</div></div>
      {message.error && <p className="error-message">{message.error}</p>}{message.ok && <p className="notice-message">{message.ok}</p>}
      <button className="button button-dark" type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar cambios'} <span>→</span></button>
    </form>
  </div>;
}

function ExamDetail({ api, detail, setDetail, onBack, onDeleted }) {
  const [notes, setNotes] = useState(detail.notes ?? '');
  const [open, setOpen] = useState({});
  const [message, setMessage] = useState({ error: '', ok: '' });
  const reviews = detail.reviews ?? {};
  const alertsOf = (studentId) => (detail.alerts ?? []).filter((alert) => alert.studentId === studentId);
  const guard = async (action, ok = '') => { setMessage({ error: '', ok: '' }); try { await action(); setMessage({ error: '', ok }); } catch (caught) { setMessage({ error: caught.message, ok: '' }); } };

  const saveNotes = () => guard(async () => { await api(`/api/professor/exams/${detail.sessionId}`, { method: 'PATCH', body: JSON.stringify({ notes }) }); setDetail({ ...detail, notes }); }, 'Notas guardadas.');
  const saveReview = (studentId, changes) => guard(async () => {
    const review = await api(`/api/professor/exams/${detail.sessionId}/reviews/${studentId}`, { method: 'PUT', body: JSON.stringify({ ...reviews[studentId], ...changes }) });
    setDetail({ ...detail, reviews: { ...reviews, [studentId]: review } });
  });
  const remove = () => {
    if (window.confirm(`¿Eliminar el registro de "${detail.examName}"? Esta acción no se puede deshacer.`)) guard(async () => { await api(`/api/professor/exams/${detail.sessionId}`, { method: 'DELETE' }); onDeleted(detail.sessionId); });
  };
  const exportStudents = () => downloadCsv(`${detail.examName}-alumnos.csv`, [['Alumno', 'Correo', 'Ingreso', 'Estado', 'Alertas', 'Revisión', 'Nota'], ...(detail.students ?? []).map((student) => [student.name, student.email, formatDate(student.joinedAt), STUDENT_STATUS[student.status] ?? student.status, alertsOf(student.studentId).length, REVIEW_LABELS[reviews[student.studentId]?.status ?? ''], reviews[student.studentId]?.note ?? ''])]);
  const exportAlerts = () => downloadCsv(`${detail.examName}-alertas.csv`, [['Alumno', 'Hora', 'Tipo', 'Detalle'], ...(detail.alerts ?? []).map((alert) => [alert.studentName, formatDate(alert.timestamp), alertLabel(alert), alert.message])]);

  return <div className="exam-detail">
    <button className="row-action back-link" type="button" onClick={onBack}>← Volver a mis exámenes</button>
    <div className="admin-heading"><div><h1 className="detail-title">{detail.examName}</h1><p className="detail-meta">{formatDate(detail.createdAt)} · {detail.duration} min · <span className={`status-pill exam-${detail.status}`}>{EXAM_STATUS[detail.status]}</span></p></div>
      <div className="detail-actions"><button className="button button-light" type="button" onClick={exportStudents}>Exportar alumnos <span>↓</span></button><button className="button button-light" type="button" onClick={exportAlerts}>Exportar alertas <span>↓</span></button></div></div>
    <div className="metrics"><div><strong>{detail.students?.length ?? 0}</strong><span>alumnos</span></div><div><strong>{detail.alerts?.length ?? 0}</strong><span>alertas</span></div><div><strong>{Object.values(reviews).filter((review) => review.status === 'suspicious').length}</strong><span>sospechosos</span></div><div><strong>{detail.helpRequestCount ?? 0}</strong><span>ayudas pendientes al cierre</span></div></div>
    {message.error && <p className="error-message">{message.error}</p>}{message.ok && <p className="notice-message">{message.ok}</p>}
    <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>Alumno</th><th>Ingreso</th><th>Estado</th><th>Alertas</th><th>Revisión</th><th>Nota</th></tr></thead>
      <tbody>{(detail.students ?? []).map((student) => { const review = reviews[student.studentId] ?? {}; const alerts = alertsOf(student.studentId); return <Fragment key={student.studentId}>
        <tr>
          <td><strong>{student.name}</strong><span>{student.email}</span></td>
          <td>{formatTime(student.joinedAt)}</td>
          <td>{STUDENT_STATUS[student.status] ?? student.status}</td>
          <td>{alerts.length ? <button type="button" className="row-action alert-toggle" onClick={() => setOpen({ ...open, [student.studentId]: !open[student.studentId] })}>{alerts.length} {open[student.studentId] ? '▴' : '▾'}</button> : 0}</td>
          <td><select value={review.status ?? ''} onChange={(e) => saveReview(student.studentId, { status: e.target.value })}>{Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
          <td><input className="note-input" defaultValue={review.note ?? ''} maxLength={1000} placeholder="Agregar nota" onBlur={(e) => e.target.value !== (review.note ?? '') && saveReview(student.studentId, { note: e.target.value })} /></td>
        </tr>
        {open[student.studentId] && <tr className="alert-rows"><td colSpan={6}><ul>{alerts.map((alert) => <li key={alert.alertId}><span>{formatTime(alert.timestamp)}</span> <strong>{alertLabel(alert)}</strong> · {alert.message}</li>)}</ul></td></tr>}
      </Fragment>; })}</tbody>
    </table>{!detail.students?.length && <p className="admin-empty">Nadie se conectó a este examen.</p>}</div>
    <div className="notes-box"><label>Notas del examen<textarea rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observaciones generales, incidentes, decisiones…" /></label><button className="button button-dark" type="button" onClick={saveNotes}>Guardar notas <span>→</span></button></div>
    {detail.status === 'ended' && <button className="row-action danger-link" type="button" onClick={remove}>Eliminar este registro</button>}
  </div>;
}

export function ProfessorExamsView({ api }) {
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/api/professor/exams').then(setList).catch((caught) => setError(caught.message)); }, []);
  const open = (sessionId) => { setError(''); api(`/api/professor/exams/${sessionId}`).then(setDetail).catch((caught) => setError(caught.message)); };
  const back = () => { setDetail(null); api('/api/professor/exams').then(setList).catch(() => {}); };

  if (detail) return <ExamDetail api={api} detail={detail} setDetail={setDetail} onBack={back} onDeleted={(id) => { setList((current) => current?.filter((exam) => exam.sessionId !== id)); setDetail(null); }} />;
  const needle = query.trim().toLowerCase();
  const visible = (list ?? []).filter((exam) => !needle || exam.examName.toLowerCase().includes(needle));
  return <div>
    <div className="page-kicker">MIS EXÁMENES <span>{list?.length ?? 0}</span></div>
    <div className="admin-heading"><h1>Registros de<br /><em>evaluaciones.</em></h1></div>
    {error && <p className="error-message">{error}</p>}
    <div className="admin-toolbar"><input className="admin-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre del examen" /></div>
    <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>Examen</th><th>Fecha</th><th>Estado</th><th>Alumnos</th><th>Alertas</th><th>Sospechosos</th><th /></tr></thead>
      <tbody>{visible.map((exam) => <tr key={exam.sessionId}>
        <td><strong>{exam.examName}</strong><span>{exam.duration} min</span></td><td>{formatDate(exam.createdAt)}</td>
        <td><span className={`status-pill exam-${exam.status}`}>{EXAM_STATUS[exam.status]}</span></td>
        <td>{exam.studentCount}</td><td>{exam.alertCount}</td><td>{exam.suspiciousCount}</td>
        <td className="admin-actions"><button type="button" onClick={() => open(exam.sessionId)}>Abrir</button></td>
      </tr>)}</tbody>
    </table>{list && visible.length === 0 && <p className="admin-empty">{list.length ? 'No hay exámenes que coincidan.' : 'Aún no has realizado exámenes. Crea una sesión para empezar.'}</p>}{!list && !error && <p className="admin-empty">Cargando…</p>}</div>
  </div>;
}

export function StudentExamsView({ api }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState({});
  const [error, setError] = useState('');
  useEffect(() => { api('/api/student/exams').then(setList).catch((caught) => setError(caught.message)); }, []);
  return <div>
    <div className="page-kicker">MIS EXÁMENES <span>{list?.length ?? 0}</span></div>
    <div className="admin-heading"><h1>Exámenes<br /><em>rendidos.</em></h1></div>
    {error && <p className="error-message">{error}</p>}
    <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>Examen</th><th>Profesor</th><th>Fecha</th><th>Estado</th><th>Mis alertas</th></tr></thead>
      <tbody>{(list ?? []).map((exam) => <Fragment key={exam.sessionId}>
        <tr>
          <td><strong>{exam.examName}</strong><span>{exam.duration} min</span></td><td>{exam.professorName}</td><td>{formatDate(exam.createdAt)}</td>
          <td><span className={`status-pill exam-${exam.status}`}>{exam.myStatus === 'expelled' ? 'Expulsado' : EXAM_STATUS[exam.status]}</span></td>
          <td>{exam.myAlerts.length ? <button type="button" className="row-action alert-toggle" onClick={() => setOpen({ ...open, [exam.sessionId]: !open[exam.sessionId] })}>{exam.myAlerts.length} {open[exam.sessionId] ? '▴' : '▾'}</button> : 0}</td>
        </tr>
        {open[exam.sessionId] && <tr className="alert-rows"><td colSpan={5}><ul>{exam.myAlerts.map((alert, index) => <li key={index}><span>{formatTime(alert.timestamp)}</span> <strong>{alertLabel(alert)}</strong> · {alert.message}</li>)}</ul></td></tr>}
      </Fragment>)}</tbody>
    </table>{list && list.length === 0 && <p className="admin-empty">Aún no has rendido exámenes. Escanea el QR de tu profesor para unirte a uno.</p>}{!list && !error && <p className="admin-empty">Cargando…</p>}</div>
  </div>;
}
