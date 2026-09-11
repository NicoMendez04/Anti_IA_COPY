import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Html5QrcodeScanner } from 'html5-qrcode';

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;
const socket = io(API_URL, { autoConnect: false });
const TOKEN_KEY = 'vigia_professor_token';

function getStudentId(sessionId) {
  const key = `vigia_student_${sessionId}`;
  let id = localStorage.getItem(key);
  if (!id) { id = ''; }
  return { key, id };
}

function Brand() {
  return <Link className="brand" to="/"><span className="brand-mark">V</span><span>Vigía<span className="brand-dot">.</span></span></Link>;
}

function Layout({ children }) {
  return <main className="app-shell"><header className="topbar"><Brand /><span className="topbar-status"><i /> Sistema operativo</span></header>{children}</main>;
}

function Landing() {
  return <Layout><section className="landing"><div className="eyebrow">CONTROL DE EVALUACIONES / 01</div><h1>Exámenes con<br /><em>presencia real.</em></h1><p className="lede">Una sala digital para crear, supervisar y cerrar tus sesiones de evaluación con claridad.</p><div className="landing-actions"><Link className="button button-dark" to="/professor">Crear una sesión <span>→</span></Link><Link className="button button-light" to="/student">Entrar como estudiante <span>↗</span></Link></div><div className="landing-note"><span className="note-line" /> <span>Sesiones temporales · datos en memoria</span></div></section><aside className="landing-aside"><div className="signal-card"><div className="signal-top"><span>LIVE / VIGILANCIA</span><span className="signal-pulse" /></div><div className="signal-grid"><strong>24</strong><span>estudiantes<br />conectados</span></div><div className="mini-bars"><i /><i /><i /><i /><i /><i /><i /></div></div><p>El aula como un espacio de confianza, con señales visibles cuando algo cambia.</p></aside></Layout>;
}

function ProfessorLogin({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault(); setError(''); setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      localStorage.setItem(TOKEN_KEY, data.token);
      onSuccess(data.token);
    } catch (caught) { setError(caught.message || 'No se pudo iniciar sesión.'); }
    finally { setLoading(false); }
  }

  return <Layout><section className="setup-page"><div className="page-kicker">ACCESO DEL PROFESOR <span>01</span></div><div className="setup-grid"><div><h1>Ingresa tu<br /><em>contraseña.</em></h1><p className="lede">Solo profesores autorizados pueden crear y administrar sesiones.</p></div><form className="session-form" onSubmit={submit}><label>Contraseña<input required type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit" disabled={loading}>Entrar <span>→</span></button></form></div></section></Layout>;
}

function ProfessorDashboard() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [form, setForm] = useState({ professorName: '', examName: '', duration: 60 });
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());

  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(''); }

  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!session || !token) return;
    const update = (next) => setSession((current) => ({ ...current, ...next }));
    socket.on('session:updated', update);
    socket.on('alert:triggered', (alert) => setSession((current) => ({ ...current, alerts: [alert, ...(current.alerts || [])] })));
    socket.connect();
    socket.emit('professor:join', { sessionId: session.sessionId, token });
    return () => { socket.off('session:updated', update); socket.disconnect(); };
  }, [session?.sessionId, token]);

  if (!token) return <ProfessorLogin onSuccess={setToken} />;

  async function createSession(event) {
    event.preventDefault(); setError('');
    try {
      const response = await fetch(`${API_URL}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(form) });
      const data = await response.json();
      if (response.status === 401) { logout(); throw new Error('Tu sesión expiró, inicia sesión de nuevo.'); }
      if (!response.ok) throw new Error(data.message);
      setSession(data);
    } catch (caught) { setError(caught.message || 'No se pudo crear la sesión.'); }
  }

  async function endSession() {
    await fetch(`${API_URL}/api/sessions/${session.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setSession((current) => ({ ...current, status: 'ended' }));
  }
  function startSession() {
    socket.emit('professor:start', { sessionId: session.sessionId, token });
  }
  async function expel(studentId) {
    await fetch(`${API_URL}/api/sessions/${session.sessionId}/expel/${studentId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    setSession((current) => ({ ...current, students: current.students.map((student) => student.studentId === studentId ? { ...student, status: 'expelled' } : student) }));
  }

  if (!session) return <Layout><section className="setup-page"><div className="page-kicker">PANEL DEL PROFESOR <span>01</span></div><div className="setup-grid"><div><h1>Abre una nueva<br /><em>sesión.</em></h1><p className="lede">Configura el espacio de evaluación y comparte el acceso con tu clase.</p></div><form className="session-form" onSubmit={createSession}><label>Tu nombre<input required value={form.professorName} onChange={(e) => setForm({ ...form, professorName: e.target.value })} placeholder="Ej. Ana García" /></label><label>Nombre del examen<input required value={form.examName} onChange={(e) => setForm({ ...form, examName: e.target.value })} placeholder="Ej. Álgebra · Unidad 2" /></label><label>Duración <span className="label-help">MINUTOS</span><input type="number" min="5" max="240" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit">Generar sesión <span>→</span></button><button className="copy-link" type="button" onClick={logout}>Cerrar sesión</button></form></div></section></Layout>;

  const activeStudents = session.students?.filter((student) => student.status === 'active') || [];
  if (session.status === 'ended') return <SessionSummary session={session} />;
  const remainingSeconds = session.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now.getTime()) / 1000)) : 0;
  const remainingLabel = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  return <Layout><section className="dashboard"><div className="dashboard-head"><div><div className="page-kicker">SALA EN DIRECTO <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><h1>{session.examName}</h1><p>Creada por {session.professorName} · {session.status === 'active' ? `Tiempo restante ${remainingLabel}` : session.status === 'waiting' ? 'Esperando inicio' : 'Sesión finalizada'}</p></div><div className="head-actions"><span className={`status-chip ${session.status}`}>{session.status === 'active' ? '● En curso' : session.status === 'waiting' ? '◌ Lista para iniciar' : '○ Finalizada'}</span>{session.status === 'waiting' && <button className="button button-dark" onClick={startSession}>Iniciar examen <span>→</span></button>}{session.status === 'active' && <button className="button button-danger" onClick={endSession}>Finalizar sesión</button>}</div></div><div className="dashboard-grid"><section className="qr-panel"><div className="panel-label">ACCESO DE ESTUDIANTES</div><div className="qr-frame"><img src={session.qrCode} alt="Código QR de acceso" /></div><strong>{session.status === 'waiting' ? 'Escanea y espera el inicio' : 'Sesión iniciada'}</strong><p>También puedes compartir este enlace:</p><button className="copy-link" onClick={() => navigator.clipboard?.writeText(session.qrData)}>{session.qrData.replace('http://', '').replace('https://', '')} <span>Copiar</span></button></section><section className="roster-panel"><div className="panel-header"><div><div className="panel-label">PRESENTES</div><h2>{activeStudents.length.toString().padStart(2, '0')} estudiantes</h2></div><span className="live-dot">{session.status === 'waiting' ? 'ESPERANDO' : 'EN VIVO'}</span></div>{activeStudents.length === 0 ? <div className="empty-state">Esperando a tu primera conexión<br /><span>Comparte el código de acceso con la clase.</span></div> : <div className="student-list">{activeStudents.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>Conectado {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><button className="row-action" onClick={() => expel(student.studentId)} title="Expulsar estudiante">Expulsar</button></div>)}</div>}</section></div><section className="alerts-panel"><div className="panel-header"><div><div className="panel-label">REGISTRO DE ACTIVIDAD</div><h2>Alertas recientes</h2></div><span className="alert-count">{session.alerts?.length || 0}</span></div>{session.alerts?.length ? <div className="alert-list">{session.alerts.slice(0, 6).map((alert) => <div className={`alert-row alert-${alert.severity || 'warning'}`} key={alert.alertId}><span className="alert-icon">{alert.severity === 'success' ? '●' : alert.severity === 'danger' ? '✕' : alert.severity === 'info' ? 'i' : '!'}</span><span><strong>{alert.studentName}</strong> · {alert.message}<small>{new Date(alert.timestamp).toLocaleTimeString('es-ES')}</small></span></div>)}</div> : <div className="empty-alerts">No hay actividad sospechosa registrada.</div>}</section></section></Layout>;
}

function SessionSummary({ session }) {
  const students = session.students || [];
  return <Layout><section className="summary-page"><div className="page-kicker">RESUMEN DE SESIÓN <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><div className="summary-heading"><div><h1>Examen<br /><em>finalizado.</em></h1><p className="lede">La sesión quedó cerrada y el registro temporal está listo para revisar.</p></div><Link className="button button-dark" to="/professor">Nueva sesión <span>→</span></Link></div><div className="summary-metrics"><div><strong>{students.length.toString().padStart(2, '0')}</strong><span>estudiantes<br />registrados</span></div><div><strong>{session.alerts?.length || 0}</strong><span>alertas<br />registradas</span></div><div><strong>{session.duration}<small> min</small></strong><span>duración<br />programada</span></div></div><section className="summary-table"><div className="panel-header"><div><div className="panel-label">LISTA FINAL</div><h2>Estudiantes de la prueba</h2></div></div>{students.length ? <div className="student-list">{students.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>Ingreso: {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><span className="status-chip ended">{student.status === 'expelled' ? 'Expulsado' : student.status === 'offline' ? 'Desconectado' : 'Registrado'}</span></div>)}</div> : <div className="empty-alerts">No hubo estudiantes registrados.</div>}</section></section></Layout>;
}

function StudentEntry() {
  const { sessionId } = useParams(); const navigate = useNavigate(); const [name, setName] = useState(''); const [error, setError] = useState('');
  useEffect(() => { if (!sessionId) return; fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).catch(() => setError('El enlace no corresponde a una sesión activa.')); }, [sessionId]);
  function join(event) { event.preventDefault(); if (!name.trim()) return; navigate(`/student/${sessionId}/live`, { state: { name: name.trim() } }); }
  if (!sessionId) return <StudentScanner />;
  return <Layout><section className="student-entry"><div className="student-badge">ACCESO A SESIÓN</div><h1>Preséntate<br /><em>para comenzar.</em></h1><p className="lede">Escribe tu nombre completo. Tu actividad quedará visible para el profesor durante la sesión.</p><form className="student-form" onSubmit={join}><label>Nombre completo<input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Carlos López" /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit">Entrar a la sesión <span>→</span></button></form></section></Layout>;
}

function StudentScanner() { const navigate = useNavigate(); useEffect(() => { const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 220, height: 220 } }, false); scanner.render((decoded) => { scanner.clear(); try { navigate(new URL(decoded).pathname); } catch { navigate(decoded); } }, () => {}); return () => scanner.clear().catch(() => {}); }, [navigate]); return <Layout><section className="scanner-page"><div className="page-kicker">ENTRADA DE ESTUDIANTE <span>01</span></div><h1>Escanea el<br /><em>código de acceso.</em></h1><p className="lede">Apunta la cámara al QR que muestra tu profesor.</p><div id="reader" className="scanner-box" /></section></Layout>; }

function StudentLive() { const { sessionId } = useParams(); const navigate = useNavigate(); const location = useLocation(); const [session, setSession] = useState(null); const [alertCount, setAlertCount] = useState(0); const [now, setNow] = useState(Date.now()); const [soundEnabled, setSoundEnabled] = useState(false); const audioContext = useRef(null); const wasHiddenRef = useRef(false); const name = location.state?.name || 'Estudiante';
  useEffect(() => { fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => r.json()).then(setSession); const { key: studentKey, id: storedStudentId } = getStudentId(sessionId); const onConnected = (data) => { localStorage.setItem(studentKey, data.studentId); setSession((current) => ({ ...current, students: data.students })); }; const onUpdate = (data) => setSession(data); const onExpelled = () => { localStorage.removeItem(studentKey); navigate('/student'); }; const onEnded = () => setSession((current) => ({ ...current, status: 'ended' })); const onAlert = (alert) => { setAlertCount((value) => value + 1); playAlertSound(); showAlertNotification(alert); }; const join = () => socket.emit('student:join', { sessionId, name, studentId: localStorage.getItem(studentKey) || storedStudentId }); socket.on('session:connected', onConnected); socket.on('session:updated', onUpdate); socket.on('student:expelled', onExpelled); socket.on('session:ended', onEnded); socket.on('alert:recorded', onAlert); socket.on('connect', join); socket.connect(); join(); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); return () => { socket.off('session:connected', onConnected); socket.off('session:updated', onUpdate); socket.off('student:expelled', onExpelled); socket.off('session:ended', onEnded); socket.off('alert:recorded', onAlert); socket.off('connect', join); socket.disconnect(); }; }, [sessionId]);
  function enableSound() { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return; audioContext.current = new AudioContextClass(); audioContext.current.resume(); setSoundEnabled(true); }
  function playAlertSound() { if (!audioContext.current || !soundEnabled) return; const oscillator = audioContext.current.createOscillator(); const gain = audioContext.current.createGain(); oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.18, audioContext.current.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.current.currentTime + 0.35); oscillator.connect(gain); gain.connect(audioContext.current.destination); oscillator.start(); oscillator.stop(audioContext.current.currentTime + 0.35); }
  function showAlertNotification(alert) { if ('Notification' in window && Notification.permission === 'granted') new Notification('Actividad registrada', { body: alert.message }); }
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return undefined;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    const updateTimerNotification = async () => {
      if (!session || session.status !== 'active' || !session.endsAt || Notification.permission !== 'granted') return;
      try {
        const registration = await navigator.serviceWorker.ready;
        const remaining = Math.max(0, Math.ceil((Date.parse(session.endsAt) - Date.now()) / 1000));
        const label = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
        registration.showNotification('Examen en curso', { body: `Tiempo restante: ${label}. No cierres esta app.`, tag: 'exam-timer', silent: true, renotify: false });
      } catch { /* el navegador no soporta notificaciones persistentes */ }
    };
    updateTimerNotification();
    const intervalId = setInterval(updateTimerNotification, 30_000);
    return () => {
      clearInterval(intervalId);
      if ('serviceWorker' in navigator) navigator.serviceWorker.ready.then((registration) => registration.getNotifications({ tag: 'exam-timer' }).then((list) => list.forEach((n) => n.close()))).catch(() => {});
    };
  }, [session?.status, session?.endsAt]);
  useEffect(() => { const report = (type, message) => { setAlertCount((value) => value + 1); socket.emit('student:event', { sessionId, type, message }); }; const blur = () => report('window_blur', 'Perdió foco de ventana'); const visibility = () => { if (document.hidden) { wasHiddenRef.current = true; report('notification_shade', 'Bajó la barra de notificaciones o salió de la app'); } else if (wasHiddenRef.current) { wasHiddenRef.current = false; report('app_resumed', 'Volvió a la app'); } }; window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility); return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); }; }, [sessionId]);
  const remainingSeconds = session?.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now) / 1000)) : 0;
  const formatted = session?.status === 'active' ? `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}` : '--:--';
  const waiting = session?.status === 'waiting';
  if (session?.status === 'ended') return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label">Sesión cerrada</span></header><section className="live-content ended-screen"><div className="live-kicker">{session.examName}</div><h1>Examen<br /><em>finalizado.</em></h1><p className="live-intro">El profesor ha cerrado esta sesión. Tus respuestas y tu registro han quedado guardados.</p></section></div>;
  return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label"><i /> Sesión protegida</span></header><section className="live-content"><div className="live-kicker">{session?.examName || 'Sesión de evaluación'} <span>· {waiting ? 'ESPERANDO INICIO' : 'EN CURSO'}</span></div><h1>Hola, {name.split(' ')[0]}.</h1><p className="live-intro">{waiting ? 'El profesor aún no ha iniciado la evaluación. Permanece en esta pantalla.' : 'Esta pantalla permanece activa mientras realizas tu evaluación.'}</p><div className="timer-card"><span>{waiting ? 'TIEMPO PENDIENTE' : 'TIEMPO RESTANTE'}</span><strong>{formatted}</strong><div className="timer-track"><i style={{ width: session?.status === 'active' ? `${Math.max(0, Math.min(100, (remainingSeconds / (session.duration * 60)) * 100))}%` : '0%' }} /></div></div><div className="live-stats"><div><strong>{session?.students?.filter((s) => s.status === 'active').length || 1}</strong><span>compañeros<br />presentes</span></div><div><strong>{alertCount}</strong><span>eventos<br />registrados</span></div></div><div className="live-notice"><span>◉</span><p><strong>{waiting ? 'Conectado correctamente.' : 'Tu sesión está siendo supervisada.'}</strong><br />{waiting ? 'Recibirás el inicio en esta misma pantalla.' : 'Permanece en esta pestaña hasta entregar tu evaluación.'}</p></div><button className="sound-toggle" onClick={enableSound}>{soundEnabled ? 'Sonido activado' : 'Activar sonido de alertas'}</button></section></div>;
}

export default function App() { return <Routes><Route path="/" element={<Landing />} /><Route path="/professor" element={<ProfessorDashboard />} /><Route path="/student" element={<StudentEntry />} /><Route path="/student/:sessionId" element={<StudentEntry />} /><Route path="/student/:sessionId/live" element={<StudentLive />} /></Routes>; }
