import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { GoogleAuthProvider, OAuthProvider, onIdTokenChanged, signInWithEmailAndPassword, signInWithPopup, signOut } from 'firebase/auth';
import { firebaseAuth } from './firebase.js';
import { AreaNav, ProfessorExamsView, ProfileView, StudentExamsView } from './panels.jsx';

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;
const socket = io(API_URL, { autoConnect: false });

function Brand() {
  return <Link className="brand" to="/"><span className="brand-mark">V</span><span>Vigía<span className="brand-dot">.</span></span></Link>;
}

function Layout({ children }) {
  return <main className="app-shell"><header className="topbar"><Brand /><span className="topbar-status"><i /> Sistema operativo</span></header>{children}</main>;
}

async function fetchProfile(token, role) {
  const response = await fetch(`${API_URL}/api/auth/me?role=${role}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.message || 'Sesión no válida.'), { status: response.status });
  }
  return response.json();
}

function useAuth(role) {
  const storageKey = `vigia_auth_${role}`;
  const [auth, setAuth] = useState(() => { try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; } });
  const clear = () => { setAuth(null); localStorage.removeItem(storageKey); };
  const save = (next) => { setAuth((current) => (current && current.token === next.token ? current : next)); localStorage.setItem(storageKey, JSON.stringify(next)); };
  useEffect(() => onIdTokenChanged(firebaseAuth, async (user) => {
    if (!user) return clear();
    try {
      const token = await user.getIdToken();
      const profile = await fetchProfile(token, role);
      if (profile.status !== 'approved' || profile.role !== role) return clear();
      save({ token, email: profile.email, role: profile.role, name: profile.name });
    } catch (caught) { if (caught.status === 401 || caught.status === 403) clear(); }
  }), []);
  async function logout() { await signOut(firebaseAuth); clear(); }
  return { auth, login: save, logout };
}

const ACCESS_LABELS = { profesor: 'ACCESO DE PROFESOR', estudiante: 'ACCESO DE ESTUDIANTE', admin: 'ADMINISTRACIÓN' };
const AUTH_ERRORS = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/wrong-password': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'Correo o contraseña incorrectos.',
  'auth/user-disabled': 'Tu cuenta está desactivada. Contacta a un administrador.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
  'auth/network-request-failed': 'Sin conexión con el servidor. Revisa tu red.',
  'auth/unauthorized-domain': 'Este sitio no está autorizado en Firebase. Agrégalo en Authentication → Settings → Authorized domains.',
  'auth/popup-blocked': 'El navegador bloqueó la ventana de Microsoft. Permite las ventanas emergentes e inténtalo de nuevo.',
  'auth/account-exists-with-different-credential': 'Ese correo ya tiene una cuenta con contraseña. Usa "correo y contraseña".'
};
const IGNORED_AUTH_ERRORS = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
const MICROSOFT_ENABLED = import.meta.env.VITE_ENABLE_MICROSOFT === 'true';
const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.setCustomParameters({ prompt: 'select_account', ...(import.meta.env.VITE_MS_TENANT ? { tenant: import.meta.env.VITE_MS_TENANT } : {}) });

function LoginForm({ role, onAuthenticated }) {
  const canRegister = role !== 'admin';
  const [mode, setMode] = useState('login');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [loading, setLoading] = useState(false);
  const registering = mode === 'register';
  function switchMode() { setMode(registering ? 'login' : 'register'); setError(''); setNotice(''); }
  async function signInAs(signIn) {
    const credential = await signIn();
    const token = await credential.user.getIdToken();
    const profile = await fetchProfile(token, role);
    const rejection = profile.status === 'pending' ? 'Tu cuenta está pendiente de aprobación por un administrador.'
      : profile.status === 'disabled' ? 'Tu cuenta está desactivada. Contacta a un administrador.'
      : profile.role !== role ? `Esta cuenta no tiene acceso como ${role}.` : null;
    if (rejection) { await signOut(firebaseAuth); throw new Error(rejection); }
    onAuthenticated({ token, email: profile.email, role: profile.role, name: profile.name });
  }
  async function run(action) {
    setError(''); setNotice(''); setLoading(true);
    try { await action(); } catch (caught) {
      if (IGNORED_AUTH_ERRORS.includes(caught.code)) return;
      if (caught.status) await signOut(firebaseAuth).catch(() => {});
      setError(AUTH_ERRORS[caught.code] || caught.message || 'No se pudo iniciar sesión.');
    } finally { setLoading(false); }
  }
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      if (!registering) return signInAs(() => signInWithEmailAndPassword(firebaseAuth, email, password));
      const response = await fetch(`${API_URL}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password, role }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setNotice(data.message); setMode('login'); setPassword('');
    });
  };
  return <section className="setup-page"><div className="page-kicker">{ACCESS_LABELS[role]} <span>01</span></div><div className="setup-grid"><div><h1>{registering ? <>Solicita tu<br /><em>cuenta.</em></> : <>Inicia con tu<br /><em>correo institucional.</em></>}</h1><p className="lede">{registering ? 'Crea tu cuenta con tu correo institucional. Un administrador debe aprobarla antes de que puedas entrar.' : 'Ingresa con tu correo institucional y tu contraseña.'}</p></div><form className="session-form" onSubmit={submit}>
    {registering && <label>Nombre completo<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Ana García" /></label>}
    <label>Correo institucional<input autoFocus required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nombre@institucion.edu" /></label>
    <label>Contraseña<input required type="password" minLength={registering ? 8 : 6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={registering ? 'Mínimo 8 caracteres' : 'Tu contraseña'} /></label>
    {notice && <p className="notice-message">{notice}</p>}{error && <p className="error-message">{error}</p>}
    <button className="button button-dark" type="submit" disabled={loading}>{loading ? 'Verificando…' : registering ? 'Solicitar cuenta' : 'Continuar'} <span>→</span></button>
    {canRegister && !registering && <button className="button button-light" type="button" disabled={loading} onClick={() => run(() => signInAs(() => signInWithPopup(firebaseAuth, googleProvider)))}>Entrar con Google <span>↗</span></button>}
    {canRegister && MICROSOFT_ENABLED && !registering && <button className="button button-light" type="button" disabled={loading} onClick={() => run(() => signInAs(() => signInWithPopup(firebaseAuth, microsoftProvider)))}>Entrar con Microsoft <span>↗</span></button>}
    {canRegister && <button className="row-action switch-mode" type="button" onClick={switchMode}>{registering ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Solicítala'}</button>}
  </form></div></section>;
}

async function request(token, path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'No se pudo completar la acción.');
  return data;
}

function RoleArea({ role, view }) {
  const { auth, login, logout } = useAuth(role);
  const [profile, setProfile] = useState(null);
  const api = (path, options) => request(auth.token, path, options);
  useEffect(() => { if (auth) api('/api/me/profile').then(setProfile).catch(() => {}); }, [Boolean(auth)]);
  if (!auth) return <Layout><LoginForm role={role} onAuthenticated={login} /></Layout>;
  return <Layout><AreaNav role={role} profile={profile} onLogout={logout} /><section className="area-page">
    {view === 'profile' ? <ProfileView api={api} role={role} profile={profile} onSaved={setProfile} /> : role === 'profesor' ? <ProfessorExamsView api={api} /> : <StudentExamsView api={api} />}
  </section></Layout>;
}

function Landing() {
  return <Layout><section className="landing"><div className="eyebrow">CONTROL DE EVALUACIONES / 01</div><h1>Exámenes con<br /><em>presencia real.</em></h1><p className="lede">Una sala digital para crear, supervisar y cerrar tus sesiones de evaluación con claridad.</p><div className="landing-actions"><Link className="button button-dark" to="/professor">Crear una sesión <span>→</span></Link><Link className="button button-light" to="/student">Entrar como estudiante <span>↗</span></Link></div><div className="landing-note"><span className="note-line" /> <span>Sesiones temporales · datos en memoria · <Link className="admin-link" to="/admin">Administración</Link></span></div></section><aside className="landing-aside"><div className="signal-card"><div className="signal-top"><span>LIVE / VIGILANCIA</span><span className="signal-pulse" /></div><div className="signal-grid"><strong>24</strong><span>estudiantes<br />conectados</span></div><div className="mini-bars"><i /><i /><i /><i /><i /><i /><i /></div></div><p>El aula como un espacio de confianza, con señales visibles cuando algo cambia.</p></aside></Layout>;
}

function ProfessorDashboard() {
  const { auth, login, logout } = useAuth('profesor');
  const [form, setForm] = useState({ professorName: '', examName: '', duration: 60 });
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());
  const [helpSoundEnabled, setHelpSoundEnabled] = useState(false);
  const helpAudioContext = useRef(null);

  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!session) return;
    const update = (next) => setSession((current) => ({ ...current, ...next }));
    socket.on('session:updated', update);
    socket.on('alert:triggered', (alert) => setSession((current) => ({ ...current, alerts: [alert, ...(current.alerts || [])] })));
    socket.on('help:requested', playHelpSound);
    socket.connect();
    socket.emit('professor:join', { sessionId: session.sessionId, token: auth?.token });
    return () => { socket.off('session:updated', update); socket.off('help:requested', playHelpSound); socket.disconnect(); };
  }, [session?.sessionId]);

  function enableHelpSound() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    helpAudioContext.current = new AudioContextClass();
    helpAudioContext.current.resume();
    setHelpSoundEnabled(true);
  }
  function playHelpSound() {
    const ctx = helpAudioContext.current;
    if (!ctx) return;
    [660, 880].forEach((freq, i) => {
      const oscillator = ctx.createOscillator(); const gain = ctx.createGain();
      oscillator.frequency.value = freq;
      const start = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      oscillator.connect(gain); gain.connect(ctx.destination);
      oscillator.start(start); oscillator.stop(start + 0.3);
    });
  }
  function resolveHelp(requestId) {
    socket.emit('professor:resolve_help', { sessionId: session.sessionId, requestId, token: auth?.token });
  }
  function formatElapsed(iso) {
    const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  }

  async function createSession(event) {
    event.preventDefault(); setError('');
    try {
      const response = await fetch(`${API_URL}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setSession(data);
    } catch (caught) { setError(caught.message || 'No se pudo crear la sesión.'); }
  }

  async function endSession() {
    await fetch(`${API_URL}/api/sessions/${session.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } });
    setSession((current) => ({ ...current, status: 'ended' }));
  }
  function startSession() {
    socket.emit('professor:start', { sessionId: session.sessionId, token: auth?.token });
  }
  async function expel(studentId) {
    await fetch(`${API_URL}/api/sessions/${session.sessionId}/expel/${studentId}`, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}` } });
    setSession((current) => ({ ...current, students: current.students.map((student) => student.studentId === studentId ? { ...student, status: 'expelled' } : student) }));
  }

  if (!auth) return <Layout><LoginForm role="profesor" onAuthenticated={login} /></Layout>;

  if (!session) return <Layout><AreaNav role="profesor" /><section className="setup-page"><div className="page-kicker">PANEL DEL PROFESOR <span>01</span></div><div className="setup-grid"><div><h1>Abre una nueva<br /><em>sesión.</em></h1><p className="lede">Configura el espacio de evaluación y comparte el acceso con tu clase.</p><div className="landing-note"><span className="note-line" /> <span>{auth.email} · <button className="row-action" type="button" onClick={logout}>Cerrar sesión</button></span></div></div><form className="session-form" onSubmit={createSession}><label>Tu nombre<input required value={form.professorName} onChange={(e) => setForm({ ...form, professorName: e.target.value })} placeholder="Ej. Ana García" /></label><label>Nombre del examen<input required value={form.examName} onChange={(e) => setForm({ ...form, examName: e.target.value })} placeholder="Ej. Álgebra · Unidad 2" /></label><label>Duración <span className="label-help">MINUTOS</span><input type="number" min="5" max="240" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit">Generar sesión <span>→</span></button></form></div></section></Layout>;

  const activeStudents = session.students?.filter((student) => student.status === 'active') || [];
  if (session.status === 'ended') return <SessionSummary session={session} />;
  const pendingHelp = session.helpRequests || [];
  const remainingSeconds = session.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now.getTime()) / 1000)) : 0;
  const remainingLabel = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  return <Layout><section className="dashboard"><div className="dashboard-head"><div><div className="page-kicker">SALA EN DIRECTO <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><h1>{session.examName}</h1><p>Creada por {session.professorName} · {session.status === 'active' ? `Tiempo restante ${remainingLabel}` : session.status === 'waiting' ? 'Esperando inicio' : 'Sesión finalizada'}</p></div><div className="head-actions">{pendingHelp.length > 0 && <span className="help-badge">✋ {pendingHelp.length} en espera</span>}<span className={`status-chip ${session.status}`}>{session.status === 'active' ? '● En curso' : session.status === 'waiting' ? '◌ Lista para iniciar' : '○ Finalizada'}</span>{session.status === 'waiting' && <button className="button button-dark" onClick={startSession}>Iniciar examen <span>→</span></button>}{session.status === 'active' && <button className="button button-danger" onClick={endSession}>Finalizar sesión</button>}</div></div><section className="help-panel"><div className="panel-header"><div><div className="panel-label">SOLICITUDES DE AYUDA</div><h2>{pendingHelp.length ? `${pendingHelp.length} en espera` : 'Nadie ha llamado'}</h2></div><button className="sound-toggle" type="button" onClick={enableHelpSound}>{helpSoundEnabled ? 'Sonido activado' : 'Activar aviso sonoro'}</button></div>{pendingHelp.length ? <div className="help-list">{pendingHelp.map((request) => <div className="help-row" key={request.requestId}><span className="help-dot" /><span className="help-name">{request.studentName}<small>Esperando {formatElapsed(request.requestedAt)}</small></span><button className="button button-dark" type="button" onClick={() => resolveHelp(request.requestId)}>Atender</button></div>)}</div> : <div className="empty-state">Sin solicitudes activas.<br /><span>Cuando un estudiante llame, aparecerá aquí.</span></div>}</section><div className="dashboard-grid"><section className="qr-panel"><div className="panel-label">ACCESO DE ESTUDIANTES</div><div className="qr-frame"><img src={session.qrCode} alt="Código QR de acceso" /></div><strong>{session.status === 'waiting' ? 'Escanea y espera el inicio' : 'Sesión iniciada'}</strong><p>También puedes compartir este enlace:</p><button className="copy-link" onClick={() => navigator.clipboard?.writeText(session.qrData)}>{session.qrData.replace('http://', '').replace('https://', '')} <span>Copiar</span></button></section><section className="roster-panel"><div className="panel-header"><div><div className="panel-label">PRESENTES</div><h2>{activeStudents.length.toString().padStart(2, '0')} estudiantes</h2></div><span className="live-dot">{session.status === 'waiting' ? 'ESPERANDO' : 'EN VIVO'}</span></div>{activeStudents.length === 0 ? <div className="empty-state">Esperando a tu primera conexión<br /><span>Comparte el código de acceso con la clase.</span></div> : <div className="student-list">{activeStudents.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>{student.email ? `${student.email} · ` : ''}Conectado {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><button className="row-action" onClick={() => expel(student.studentId)} title="Expulsar estudiante">Expulsar</button></div>)}</div>}</section></div><section className="alerts-panel"><div className="panel-header"><div><div className="panel-label">REGISTRO DE ACTIVIDAD</div><h2>Alertas recientes</h2></div><span className="alert-count">{session.alerts?.length || 0}</span></div>{session.alerts?.length ? <div className="alert-list">{session.alerts.slice(0, 6).map((alert) => <div className="alert-row" key={alert.alertId}><span className={`alert-icon${alert.type === 'screen_lock' ? ' alert-icon-lock' : ''}`}>{alert.type === 'screen_lock' ? '●' : '!'}</span><span><strong>{alert.studentName}</strong> · {alert.message}<small>{new Date(alert.timestamp).toLocaleTimeString('es-ES')}</small></span></div>)}</div> : <div className="empty-alerts">No hay actividad sospechosa registrada.</div>}</section></section></Layout>;
}

function SessionSummary({ session }) {
  const students = session.students || [];
  const alertHistory = [...(session.alerts || [])].reverse();
  return <Layout><section className="summary-page"><div className="page-kicker">RESUMEN DE SESIÓN <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><div className="summary-heading"><div><h1>Examen<br /><em>finalizado.</em></h1><p className="lede">La sesión quedó cerrada y el registro temporal está listo para revisar.</p></div><Link className="button button-dark" to="/professor">Nueva sesión <span>→</span></Link></div><div className="summary-metrics"><div><strong>{students.length.toString().padStart(2, '0')}</strong><span>estudiantes<br />registrados</span></div><div><strong>{session.alerts?.length || 0}</strong><span>alertas<br />registradas</span></div><div><strong>{session.duration}<small> min</small></strong><span>duración<br />programada</span></div></div><section className="summary-table"><div className="panel-header"><div><div className="panel-label">LISTA FINAL</div><h2>Estudiantes de la prueba</h2></div></div>{students.length ? <div className="student-list">{students.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>{student.email ? `${student.email} · ` : ''}Ingreso: {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><span className="status-chip ended">{student.status === 'expelled' ? 'Expulsado' : student.status === 'offline' ? 'Desconectado' : 'Registrado'}</span></div>)}</div> : <div className="empty-alerts">No hubo estudiantes registrados.</div>}</section><section className="alerts-panel summary-alerts"><div className="panel-header"><div><div className="panel-label">HISTORIAL DE ALERTAS</div><h2>Actividad durante el examen</h2></div><span className="alert-count">{alertHistory.length}</span></div>{alertHistory.length ? <div className="alert-list">{alertHistory.map((alert) => <div className="alert-row" key={alert.alertId}><span className={`alert-icon${alert.type === 'screen_lock' ? ' alert-icon-lock' : ''}`}>{alert.type === 'screen_lock' ? '●' : '!'}</span><span><strong>{alert.studentName}</strong> · {alert.message}<small>{new Date(alert.timestamp).toLocaleTimeString('es-ES')}</small></span></div>)}</div> : <div className="empty-alerts">No hubo actividad sospechosa durante el examen.</div>}</section></section></Layout>;
}

function StudentEntry() {
  const { sessionId } = useParams(); const navigate = useNavigate(); const { auth, login } = useAuth('estudiante'); const [name, setName] = useState(''); const [error, setError] = useState('');
  useEffect(() => { if (!sessionId) return; fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).catch(() => setError('El enlace no corresponde a una sesión activa.')); }, [sessionId]);
  function join(event) { event.preventDefault(); if (!name.trim()) return; navigate(`/student/${sessionId}/live`, { state: { name: name.trim() } }); }
  if (!sessionId) return <StudentScanner />;
  if (!auth) return <Layout><LoginForm role="estudiante" onAuthenticated={login} /></Layout>;
  return <Layout><AreaNav role="estudiante" /><section className="student-entry"><div className="student-badge">ACCESO A SESIÓN</div><h1>Preséntate<br /><em>para comenzar.</em></h1><p className="lede">Escribe tu nombre completo. Tu actividad quedará visible para el profesor durante la sesión.</p><form className="student-form" onSubmit={join}><label>Nombre completo<input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Carlos López" /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit">Entrar a la sesión <span>→</span></button></form></section></Layout>;
}

function StudentScanner() { const navigate = useNavigate(); useEffect(() => { const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 220, height: 220 } }, false); scanner.render((decoded) => { scanner.clear(); try { navigate(new URL(decoded).pathname); } catch { navigate(decoded); } }, () => {}); return () => scanner.clear().catch(() => {}); }, [navigate]); return <Layout><AreaNav role="estudiante" /><section className="scanner-page"><div className="page-kicker">ENTRADA DE ESTUDIANTE <span>01</span></div><h1>Escanea el<br /><em>código de acceso.</em></h1><p className="lede">Apunta la cámara al QR que muestra tu profesor.</p><div id="reader" className="scanner-box" /></section></Layout>; }

function StudentLive() { const { sessionId } = useParams(); const navigate = useNavigate(); const location = useLocation(); const { auth } = useAuth('estudiante'); const [session, setSession] = useState(null); const [alertCount, setAlertCount] = useState(0); const [now, setNow] = useState(Date.now()); const [soundEnabled, setSoundEnabled] = useState(false); const [helpStatus, setHelpStatus] = useState('idle'); const audioContext = useRef(null); const tokenRef = useRef(auth?.token); tokenRef.current = auth?.token; const [notice, setNotice] = useState(null); const name = location.state?.name || 'Estudiante';
  useEffect(() => { if (!auth) navigate(`/student/${sessionId}`); }, [auth, sessionId]);
  useEffect(() => { if (!auth) return; fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => r.json()).then(setSession); const onConnected = (data) => setSession((current) => ({ ...current, students: data.students })); const onUpdate = (data) => setSession(data); const onExpelled = () => navigate('/student'); const onEnded = () => setSession((current) => ({ ...current, status: 'ended' })); const onAlert = (alert) => { setAlertCount((value) => value + 1); playAlertSound(); showAlertNotification(alert); }; const onHelpResolved = () => setHelpStatus('idle'); socket.on('session:connected', onConnected); socket.on('session:updated', onUpdate); socket.on('student:expelled', onExpelled); socket.on('session:ended', onEnded); socket.on('alert:recorded', onAlert); socket.on('help:resolved', onHelpResolved); const join = () => socket.emit('student:join', { sessionId, name, token: tokenRef.current }); const onReplaced = () => { setNotice({ title: 'Sesión abierta en otro dispositivo', text: 'Esta sesión se abrió desde otro dispositivo o pestaña, por lo que esta quedó cerrada. El profesor fue avisado.' }); socket.disconnect(); }; const onSessionError = ({ message }) => setNotice({ title: 'No se pudo entrar a la sesión', text: message }); socket.on('connect', join); socket.on('student:replaced', onReplaced); socket.on('session:error', onSessionError); socket.connect(); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); return () => { socket.off('session:connected', onConnected); socket.off('session:updated', onUpdate); socket.off('student:expelled', onExpelled); socket.off('session:ended', onEnded); socket.off('alert:recorded', onAlert); socket.off('help:resolved', onHelpResolved); socket.off('connect', join); socket.off('student:replaced', onReplaced); socket.off('session:error', onSessionError); socket.disconnect(); }; }, [sessionId, Boolean(auth)]);
  function enableSound() { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return; audioContext.current = new AudioContextClass(); audioContext.current.resume(); setSoundEnabled(true); }
  function playAlertSound() { if (!audioContext.current || !soundEnabled) return; const oscillator = audioContext.current.createOscillator(); const gain = audioContext.current.createGain(); oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.18, audioContext.current.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.current.currentTime + 0.35); oscillator.connect(gain); gain.connect(audioContext.current.destination); oscillator.start(); oscillator.stop(audioContext.current.currentTime + 0.35); }
  function showAlertNotification(alert) { if ('Notification' in window && Notification.permission === 'granted') new Notification('Actividad registrada', { body: alert.message }); }
  function requestHelp() { socket.emit('student:help_request', { sessionId }); setHelpStatus('pending'); }
  function cancelHelp() { socket.emit('student:help_cancel', { sessionId }); setHelpStatus('idle'); }
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const report = (type, message) => { setAlertCount((value) => value + 1); socket.emit('student:event', { sessionId, type, message }); }; let lastInteraction = Date.now(); const markInteraction = () => { lastInteraction = Date.now(); }; const interactionEvents = ['pointerdown', 'touchstart', 'keydown', 'scroll']; interactionEvents.forEach((eventName) => window.addEventListener(eventName, markInteraction, { passive: true })); const visibility = () => { if (!document.hidden) return; const idleMs = Date.now() - lastInteraction; if (idleMs >= 5000) report('screen_lock', 'Ocultó la pantalla tras un rato sin tocarla (posible bloqueo o cierre)'); else report('tab_switch', 'Cambió de pestaña o aplicación'); }; const blur = () => { if (!document.hidden) report('window_blur', 'Perdió foco de ventana'); }; window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility); return () => { interactionEvents.forEach((eventName) => window.removeEventListener(eventName, markInteraction)); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); }; }, [sessionId]);
  const remainingSeconds = session?.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now) / 1000)) : 0;
  const formatted = session?.status === 'active' ? `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}` : '--:--';
  const waiting = session?.status === 'waiting';
  if (notice) return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label">Sesión cerrada</span></header><section className="live-content ended-screen"><div className="live-kicker">{session?.examName || 'Sesión de evaluación'}</div><h1>{notice.title}</h1><p className="live-intro">{notice.text}</p></section></div>;
  if (session?.status === 'ended') return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label">Sesión cerrada</span></header><section className="live-content ended-screen"><div className="live-kicker">{session.examName}</div><h1>Examen<br /><em>finalizado.</em></h1><p className="live-intro">El profesor ha cerrado esta sesión. Tus respuestas y tu registro han quedado guardados.</p></section></div>;
  return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label"><i /> Sesión protegida</span></header><section className="live-content"><div className="live-kicker">{session?.examName || 'Sesión de evaluación'} <span>· {waiting ? 'ESPERANDO INICIO' : 'EN CURSO'}</span></div><h1>Hola, {name.split(' ')[0]}.</h1><p className="live-intro">{waiting ? 'El profesor aún no ha iniciado la evaluación. Permanece en esta pantalla.' : 'Esta pantalla permanece activa mientras realizas tu evaluación.'}</p><div className="timer-card"><span>{waiting ? 'TIEMPO PENDIENTE' : 'TIEMPO RESTANTE'}</span><strong>{formatted}</strong><div className="timer-track"><i style={{ width: session?.status === 'active' ? `${Math.max(0, Math.min(100, (remainingSeconds / (session.duration * 60)) * 100))}%` : '0%' }} /></div></div><div className="live-stats"><div><strong>{session?.students?.filter((s) => s.status === 'active').length || 1}</strong><span>compañeros<br />presentes</span></div><div><strong>{alertCount}</strong><span>eventos<br />registrados</span></div></div><div className="live-notice"><span>◉</span><p><strong>{waiting ? 'Conectado correctamente.' : 'Tu sesión está siendo supervisada.'}</strong><br />{waiting ? 'Recibirás el inicio en esta misma pantalla.' : 'Permanece en esta pestaña hasta entregar tu evaluación.'}</p></div><button className="sound-toggle" onClick={enableSound}>{soundEnabled ? 'Sonido activado' : 'Activar sonido de alertas'}</button></section><button className={`help-button${helpStatus === 'pending' ? ' help-button-pending' : ''}`} type="button" onClick={helpStatus === 'pending' ? cancelHelp : requestHelp}>{helpStatus === 'pending' ? 'Esperando al profesor… (cancelar)' : '✋ Tengo una duda'}</button></div>;
}

const STATUS_LABELS = { pending: 'Pendiente', approved: 'Aprobado', disabled: 'Desactivado' };
const ROLE_LABELS = { admin: 'Administrador', profesor: 'Profesor', estudiante: 'Estudiante' };
const STATUS_FILTERS = [['all', 'Todos'], ['pending', 'Pendientes'], ['approved', 'Aprobados'], ['disabled', 'Desactivados']];
const EMPTY_USER = { name: '', email: '', password: '', role: 'profesor' };

function AdminPanel() {
  const { auth, login, logout } = useAuth('admin');
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_USER);

  async function call(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'No se pudo completar la acción.');
    return data;
  }
  async function run(action) { setError(''); try { await action(); } catch (caught) { setError(caught.message); } }

  useEffect(() => { if (auth) run(async () => setUsers(await call('/api/admin/users'))); }, [Boolean(auth)]);

  const patch = (user, changes) => run(async () => {
    const updated = await call(`/api/admin/users/${user.uid}`, { method: 'PATCH', body: JSON.stringify(changes) });
    setUsers((list) => list.map((item) => (item.uid === user.uid ? { ...item, ...updated } : item)));
  });
  const resetPassword = (user) => {
    const password = window.prompt(`Nueva contraseña para ${user.email} (mínimo 8 caracteres):`);
    if (password) run(async () => { await call(`/api/admin/users/${user.uid}/password`, { method: 'POST', body: JSON.stringify({ password }) }); window.alert('Contraseña actualizada.'); });
  };
  const remove = (user) => {
    if (window.confirm(`¿Eliminar la cuenta de ${user.email}? Esta acción no se puede deshacer.`)) {
      run(async () => { await call(`/api/admin/users/${user.uid}`, { method: 'DELETE' }); setUsers((list) => list.filter((item) => item.uid !== user.uid)); });
    }
  };
  const create = (event) => {
    event.preventDefault();
    run(async () => { const created = await call('/api/admin/users', { method: 'POST', body: JSON.stringify(form) }); setUsers((list) => [created, ...list]); setForm(EMPTY_USER); setShowForm(false); });
  };

  if (!auth) return <Layout><LoginForm role="admin" onAuthenticated={login} /></Layout>;

  const pending = users.filter((user) => user.status === 'pending').length;
  const needle = query.trim().toLowerCase();
  const statusOrder = { pending: 0, approved: 1, disabled: 2 };
  const visible = users.filter((user) => (filter === 'all' || user.status === filter) && (!needle || `${user.name} ${user.email}`.toLowerCase().includes(needle))).sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return <Layout><section className="admin-page">
    <div className="page-kicker">ADMINISTRACIÓN DE CUENTAS <span>{users.length}</span></div>
    <div className="admin-heading"><h1>Gestión de<br /><em>usuarios.</em></h1><div className="landing-note"><span className="note-line" /> <span>{auth.email} · <button className="row-action" type="button" onClick={logout}>Cerrar sesión</button></span></div></div>
    {pending > 0 && <p className="notice-message">{pending} {pending === 1 ? 'cuenta espera' : 'cuentas esperan'} aprobación.</p>}
    {error && <p className="error-message">{error}</p>}
    <div className="admin-toolbar">
      <input className="admin-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre o correo" />
      <div className="admin-filters">{STATUS_FILTERS.map(([value, label]) => <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button className="button button-dark admin-new" type="button" onClick={() => setShowForm((open) => !open)}>{showForm ? 'Cancelar' : 'Nuevo usuario'} <span>{showForm ? '×' : '+'}</span></button>
    </div>
    {showForm && <form className="admin-form" onSubmit={create}>
      <label>Nombre<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Correo<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label>Contraseña<input required type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Mínimo 8 caracteres" /></label>
      <label>Rol<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="button button-dark" type="submit">Crear cuenta <span>→</span></button>
    </form>}
    <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{visible.map((user) => { const self = user.uid === auth.uid || user.email === auth.email; return <tr key={user.uid}>
        <td><strong>{user.name || '—'}</strong><span>{user.email}</span></td>
        <td><select value={user.role} disabled={self} onChange={(e) => patch(user, { role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
        <td><span className={`status-pill status-${user.status}`}>{STATUS_LABELS[user.status]}</span></td>
        <td className="admin-actions">
          {user.status !== 'approved' && <button type="button" onClick={() => patch(user, { status: 'approved' })}>{user.status === 'pending' ? 'Aprobar' : 'Activar'}</button>}
          {user.status === 'approved' && !self && <button type="button" onClick={() => patch(user, { status: 'disabled' })}>Desactivar</button>}
          <button type="button" onClick={() => patch(user, { name: window.prompt('Nombre:', user.name) ?? user.name })}>Renombrar</button>
          <button type="button" onClick={() => resetPassword(user)}>Contraseña</button>
          {!self && <button type="button" className="danger" onClick={() => remove(user)}>Eliminar</button>}
        </td>
      </tr>; })}</tbody>
    </table>{visible.length === 0 && <p className="admin-empty">No hay usuarios que coincidan.</p>}</div>
  </section></Layout>;
}

export default function App() { return <Routes><Route path="/" element={<Landing />} /><Route path="/professor" element={<ProfessorDashboard />} /><Route path="/professor/exams" element={<RoleArea role="profesor" view="exams" />} /><Route path="/professor/profile" element={<RoleArea role="profesor" view="profile" />} /><Route path="/student/exams" element={<RoleArea role="estudiante" view="exams" />} /><Route path="/student/profile" element={<RoleArea role="estudiante" view="profile" />} /><Route path="/admin" element={<AdminPanel />} /><Route path="/student" element={<StudentEntry />} /><Route path="/student/:sessionId" element={<StudentEntry />} /><Route path="/student/:sessionId/live" element={<StudentLive />} /></Routes>; }
