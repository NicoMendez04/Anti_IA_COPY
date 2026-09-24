import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { GoogleAuthProvider, OAuthProvider, onIdTokenChanged, signInWithEmailAndPassword, signInWithPopup, signOut } from 'firebase/auth';
import { firebaseAuth } from './firebase.js';
import { AreaNav, CourseFields, ProfessorExamsView, ProfileView, StudentExamsView } from './panels.jsx';
import { CatalogAdmin } from './catalogAdmin.jsx';

const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:3001`;
const socket = io(API_URL, { autoConnect: false });

function Brand() {
  return <Link className="brand" to="/"><span className="brand-mark">V</span><span>Vigía<span className="brand-dot">.</span></span></Link>;
}

function Layout({ children }) {
  return <main className="app-shell"><header className="topbar"><Brand /><span className="topbar-status"><i /> Sistema operativo</span></header>{children}</main>;
}

async function fetchProfile(token, role = '') {
  const response = await fetch(`${API_URL}/api/auth/me?role=${role}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.message || 'Sesión no válida.'), { status: response.status });
  }
  return response.json();
}

const AUTH_KEY = 'vigia_auth';
const readCachedAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; } };

// Primera pantalla tras entrar: quien aún no completó su perfil empieza por ahí.
function homeFor(auth) {
  if (auth.role === 'admin') return '/admin';
  const area = auth.role === 'profesor' ? 'professor' : 'student';
  return auth.onboarded ? `/${area}` : `/${area}/profile`;
}

function useAuth(role) {
  const [session, setSession] = useState(readCachedAuth);
  const clear = () => { setSession(null); localStorage.removeItem(AUTH_KEY); };
  const save = (next) => { setSession((current) => (current && current.token === next.token && current.onboarded === next.onboarded ? current : next)); localStorage.setItem(AUTH_KEY, JSON.stringify(next)); };
  useEffect(() => onIdTokenChanged(firebaseAuth, async (user) => {
    if (!user) return clear();
    try {
      const token = await user.getIdToken();
      const profile = await fetchProfile(token);
      if (profile.status !== 'approved') return clear();
      save({ token, email: profile.email, role: profile.role, name: profile.name, onboarded: profile.onboarded });
    } catch (caught) { if (caught.status === 401 || caught.status === 403) clear(); }
  }), []);
  async function logout() { await signOut(firebaseAuth); clear(); }
  const auth = session && (!role || session.role === role || (role === 'profesor' && session.role === 'admin')) ? session : null;
  return { auth, session, login: save, logout };
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
  'auth/popup-blocked': 'El navegador bloqueó la ventana de acceso. Permite las ventanas emergentes e inténtalo de nuevo.',
  'auth/account-exists-with-different-credential': 'Ese correo ya tiene una cuenta con contraseña. Entra con correo y contraseña.'
};
const IGNORED_AUTH_ERRORS = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
const REJECTIONS = {
  pending: 'Tu solicitud sigue pendiente: un administrador aún debe aprobarla.',
  rejected: 'Tu solicitud de acceso fue rechazada. Contacta a un administrador.',
  disabled: 'Tu cuenta está desactivada. Contacta a un administrador.'
};

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
const MICROSOFT_ENABLED = import.meta.env.VITE_ENABLE_MICROSOFT === 'true';
const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.setCustomParameters({ prompt: 'select_account', ...(import.meta.env.VITE_MS_TENANT ? { tenant: import.meta.env.VITE_MS_TENANT } : {}) });

// Ejecuta un inicio de sesión y traduce cualquier fallo a un mensaje para el usuario.
async function attempt(action, setError, setLoading) {
  setError(''); setLoading(true);
  try { await action(); } catch (caught) {
    if (IGNORED_AUTH_ERRORS.includes(caught.code)) return;
    if (caught.status) await signOut(firebaseAuth).catch(() => {});
    setError(AUTH_ERRORS[caught.code] || caught.message || 'No se pudo iniciar sesión.');
  } finally { setLoading(false); }
}

function ProviderButtons({ loading, onProvider, label = 'Entrar' }) {
  return <>
    <button className="button button-light" type="button" disabled={loading} onClick={() => onProvider(googleProvider)}>{label} con Google <span>↗</span></button>
    {MICROSOFT_ENABLED && <button className="button button-light" type="button" disabled={loading} onClick={() => onProvider(microsoftProvider)}>{label} con Microsoft <span>↗</span></button>}
  </>;
}

function LoginForm({ role, onAuthenticated }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  async function signInAs(signIn) {
    const credential = await signIn();
    const token = await credential.user.getIdToken();
    const profile = await fetchProfile(token);
    const rejection = REJECTIONS[profile.status] ?? (role && profile.role !== role && !(role === 'profesor' && profile.role === 'admin') ? `Esta cuenta no tiene acceso como ${role}.` : null);
    if (rejection) { await signOut(firebaseAuth); throw new Error(rejection); }
    onAuthenticated({ token, email: profile.email, role: profile.role, name: profile.name, onboarded: profile.onboarded });
  }
  const submit = (event) => { event.preventDefault(); attempt(() => signInAs(() => signInWithEmailAndPassword(firebaseAuth, email, password)), setError, setLoading); };
  return <section className="setup-page"><div className="page-kicker">{role ? ACCESS_LABELS[role] : 'INICIAR SESIÓN'} <span>01</span></div><div className="setup-grid"><div><h1>Inicia con tu<br /><em>correo institucional.</em></h1><p className="lede">Ingresa con tu correo institucional y tu contraseña, o con Google.</p></div><form className="session-form" onSubmit={submit}>
    <label>Correo institucional<input autoFocus required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nombre@institucion.edu" /></label>
    <label>Contraseña<input required type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Tu contraseña" /></label>
    {error && <p className="error-message">{error}</p>}
    <button className="button button-dark" type="submit" disabled={loading}>{loading ? 'Verificando…' : 'Continuar'} <span>→</span></button>
    {role !== 'admin' && <ProviderButtons loading={loading} onProvider={(provider) => attempt(() => signInAs(() => signInWithPopup(firebaseAuth, provider)), setError, setLoading)} />}
    {role !== 'admin' && <Link className="row-action switch-mode" to="/register">¿No tienes cuenta? Solicita acceso</Link>}
  </form></div></section>;
}

const ROLE_CHOICES = [['profesor', 'Soy profesor', 'Crea sesiones de evaluación, supervisa a tu curso en vivo y revisa los registros.'], ['estudiante', 'Soy estudiante', 'Únete a los exámenes con un QR y consulta tu historial de evaluaciones.']];

function RegisterPage() {
  const [role, setRole] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', requestNote: '' });
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [sent, setSent] = useState(false);
  const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });
  const needRole = () => { if (!role) throw new Error('Elige a qué rol postulas.'); };
  const byPassword = (event) => {
    event.preventDefault();
    attempt(async () => {
      needRole();
      const response = await fetch(`${API_URL}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, role }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setSent(true);
    }, setError, setLoading);
  };
  const byProvider = (provider) => attempt(async () => {
    needRole();
    const credential = await signInWithPopup(firebaseAuth, provider);
    const token = await credential.user.getIdToken();
    try { await request(token, '/api/auth/request', { method: 'POST', body: JSON.stringify({ role, name: form.name, requestNote: form.requestNote }) }); }
    finally { await signOut(firebaseAuth).catch(() => {}); }
    setSent(true);
  }, setError, setLoading);

  if (sent) return <Layout><section className="setup-page"><div className="page-kicker">SOLICITUD DE ACCESO <span>✓</span></div><div className="setup-grid"><div><h1>Solicitud<br /><em>enviada.</em></h1><p className="lede">Un administrador revisará tu solicitud como <strong>{role === 'profesor' ? 'profesor' : 'estudiante'}</strong>. Cuando la apruebe podrás iniciar sesión, y tu primera pantalla será tu perfil.</p></div><div className="session-form"><Link className="button button-dark" to="/login">Ir a iniciar sesión <span>→</span></Link><Link className="button button-light" to="/">Volver al inicio <span>↗</span></Link></div></div></section></Layout>;
  return <Layout><section className="setup-page"><div className="page-kicker">SOLICITAR ACCESO <span>01</span></div><div className="setup-grid"><div><h1>Solicita<br /><em>tu cuenta.</em></h1><p className="lede">Cuéntanos quién eres y a qué rol postulas. Un administrador revisará tu solicitud y, si la aprueba, crearemos tu perfil.</p></div><form className="session-form" onSubmit={byPassword}>
    <div className="role-choices" role="radiogroup" aria-label="Rol al que postulas">{ROLE_CHOICES.map(([value, title, text]) => <button key={value} type="button" role="radio" aria-checked={role === value} className={role === value ? 'is-active' : ''} onClick={() => setRole(value)}><strong>{title}</strong><span>{text}</span></button>)}</div>
    <label>Nombre completo<input required value={form.name} onChange={set('name')} placeholder="Ej. Ana García" /></label>
    <label>Correo institucional<input required type="email" value={form.email} onChange={set('email')} placeholder="nombre@institucion.edu" /></label>
    <label>Contraseña<input required type="password" minLength={8} value={form.password} onChange={set('password')} placeholder="Mínimo 8 caracteres" /></label>
    <label>Mensaje para el administrador <em className="optional">(opcional)</em><textarea rows={3} maxLength={500} value={form.requestNote} onChange={set('requestNote')} placeholder="Ej. Profesor de Álgebra, Facultad de Ingeniería" /></label>
    {error && <p className="error-message">{error}</p>}
    <button className="button button-dark" type="submit" disabled={loading}>{loading ? 'Enviando…' : 'Enviar solicitud'} <span>→</span></button>
    <p className="or-divider"><span>o solicita con</span></p>
    <ProviderButtons loading={loading} label="Solicitar" onProvider={byProvider} />
    <Link className="row-action switch-mode" to="/login">¿Ya tienes cuenta? Inicia sesión</Link>
  </form></div></section></Layout>;
}

function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  useEffect(() => { if (session) navigate(homeFor(session), { replace: true }); }, [session]);
  return <Layout><LoginForm onAuthenticated={(next) => { login(next); navigate(homeFor(next), { replace: true }); }} /></Layout>;
}

const guestStorageKey = (sessionId) => `vigia_guest_${sessionId}`;
const readGuest = (sessionId) => { try { return JSON.parse(localStorage.getItem(guestStorageKey(sessionId))); } catch { return null; } };

function formatRut(value) {
  const clean = value.replace(/[^0-9kK]/g, '').toUpperCase().slice(0, 9);
  if (clean.length < 2) return clean;
  return `${clean.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${clean.slice(-1)}`;
}

function isValidRut(value) {
  const clean = value.replace(/[.\s-]/g, '').toUpperCase();
  if (!/^\d{7,8}[\dK]$/.test(clean)) return false;
  let sum = 0; let factor = 2;
  for (let index = clean.length - 2; index >= 0; index -= 1) { sum += Number(clean[index]) * factor; factor = factor === 7 ? 2 : factor + 1; }
  const remainder = 11 - (sum % 11);
  return clean.slice(-1) === (remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder));
}

async function request(token, path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'No se pudo completar la acción.');
  return data;
}

function RoleArea({ role, view }) {
  const { auth, login, logout } = useAuth(role);
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const api = (path, options) => request(auth.token, path, options);
  const download = async (path, filename) => {
    const response = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || 'No se pudo descargar el archivo.');
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await response.blob()), download: filename });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  useEffect(() => { if (!auth) return; api('/api/me/profile').then(setProfile).catch(() => {}); api('/api/catalog').then(setCatalog).catch(() => {}); }, [Boolean(auth)]);
  if (!auth) return <Layout><LoginForm role={role} onAuthenticated={login} /></Layout>;
  return <Layout><AreaNav role={role} profile={profile} onLogout={logout} admin={auth.role === 'admin'} /><section className="area-page">
    {view === 'profile' ? <ProfileView api={api} role={role} profile={profile} catalog={catalog} onSaved={(saved) => { const firstTime = profile && !profile.onboarded; setProfile(saved); if (firstTime) navigate(homeFor({ role, onboarded: true })); }} /> : role === 'profesor' ? <ProfessorExamsView api={api} download={download} /> : <StudentExamsView api={api} />}
  </section></Layout>;
}

const FEATURES = [
  ['01', 'Sesiones con QR', 'Crea un examen, comparte el código QR y tus alumnos entran desde su celular en segundos.'],
  ['02', 'Supervisión en vivo', 'Ve quién está conectado y recibe alertas cuando alguien cambia de pestaña, bloquea la pantalla o se desconecta.'],
  ['03', 'Dudas sin interrumpir', 'Los alumnos levantan la mano desde su pantalla y tú los atiendes desde tu panel.'],
  ['04', 'Registros y revisión', 'Cada examen queda guardado: revisa alumno por alumno, agrega notas y exporta los resultados.'],
  ['05', 'Perfiles y accesos', 'Cada persona tiene su perfil. Un administrador aprueba quién entra como profesor o como estudiante.']
];
const STEPS = [
  ['Solicita acceso', 'Elige si postulas como profesor o estudiante y cuéntanos quién eres.'],
  ['Un administrador te aprueba', 'Revisa tu solicitud y te asigna el rol y los permisos.'],
  ['Completa tu perfil', 'Al entrar por primera vez, tu perfil es lo primero que ves. Después, comienza a usar Vigía.']
];

function Landing() {
  const { session } = useAuth();
  return <Layout>
    <section className="landing"><div className="eyebrow">CONTROL DE EVALUACIONES / 01</div><h1>Exámenes con<br /><em>presencia real.</em></h1><p className="lede">Vigía es una sala digital para crear, supervisar y cerrar sesiones de evaluación con claridad: el profesor ve en vivo lo que ocurre, y cada examen queda registrado.</p>
      <div className="landing-actions">{session
        ? <Link className="button button-dark" to={homeFor(session)}>Ir a mi panel <span>→</span></Link>
        : <><Link className="button button-dark" to="/register">Solicitar acceso <span>→</span></Link><Link className="button button-light" to="/login">Iniciar sesión <span>↗</span></Link></>}</div>
      <div className="landing-note"><span className="note-line" /> <span>Acceso por aprobación · <Link className="admin-link" to="/admin">Administración</Link></span></div></section>
    <aside className="landing-aside"><div className="signal-card"><div className="signal-top"><span>LIVE / VIGILANCIA</span><span className="signal-pulse" /></div><div className="signal-grid"><strong>24</strong><span>estudiantes<br />conectados</span></div><div className="mini-bars"><i /><i /><i /><i /><i /><i /><i /></div></div><p>El aula como un espacio de confianza, con señales visibles cuando algo cambia.</p></aside>
    <section className="portal-section"><div className="page-kicker">QUÉ HACE VIGÍA <span>02</span></div><div className="feature-grid">{FEATURES.map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="portal-section"><div className="page-kicker">CÓMO EMPEZAR <span>03</span></div><ol className="steps">{STEPS.map(([title, text], index) => <li key={title}><strong>{index + 1}</strong><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
      {!session && <div className="portal-cta"><p>¿Cómo quieres registrarte?</p><div className="landing-actions"><Link className="button button-dark" to="/register">Solicitar acceso <span>→</span></Link><Link className="button button-light" to="/login">Ya tengo cuenta <span>↗</span></Link></div></div>}</section>
  </Layout>;
}

function ProfessorDashboard() {
  const { auth, login, logout } = useAuth('profesor');
  const [form, setForm] = useState({ examName: '', duration: 60, courseId: '', customCourseName: '', description: '' });
  const [profile, setProfile] = useState(null);
  const [catalog, setCatalog] = useState(null);
  useEffect(() => { if (!auth) return; request(auth.token, '/api/me/profile').then(setProfile).catch(() => {}); request(auth.token, '/api/catalog').then(setCatalog).catch(() => {}); }, [Boolean(auth)]);
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
      const response = await fetch(`${API_URL}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ examName: form.examName, duration: form.duration, courseId: form.courseId, customCourseName: form.customCourseName, description: form.description }) });
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

  if (!session) return <Layout><AreaNav role="profesor" admin={auth.role === 'admin'} /><section className="setup-page"><div className="page-kicker">PANEL DEL PROFESOR <span>01</span></div><div className="setup-grid"><div><h1>Abre una nueva<br /><em>sesión.</em></h1><p className="lede">Configura el espacio de evaluación y comparte el acceso con tu clase.</p><div className="landing-note"><span className="note-line" /> <span>{auth.email} · <button className="row-action" type="button" onClick={logout}>Cerrar sesión</button></span></div></div><form className="session-form" onSubmit={createSession}><CourseFields form={form} setForm={setForm} profile={profile} catalog={catalog} isAdmin={auth.role === 'admin'} /><label>Nombre del examen<input required value={form.examName} onChange={(e) => setForm({ ...form, examName: e.target.value })} placeholder="Ej. Álgebra · Unidad 2" /></label><label>Descripción <span className="label-help">OPCIONAL</span><textarea rows={3} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ej. Unidad 2: derivadas e integrales. Se permite calculadora." /></label><label>Duración <span className="label-help">MINUTOS</span><input type="number" min="5" max="240" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>{error && <p className="error-message">{error}</p>}<button className="button button-dark" type="submit">Generar sesión <span>→</span></button></form></div></section></Layout>;

  const activeStudents = session.students?.filter((student) => student.status === 'active') || [];
  if (session.status === 'ended') return <SessionSummary session={session} />;
  const pendingHelp = session.helpRequests || [];
  const remainingSeconds = session.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now.getTime()) / 1000)) : 0;
  const remainingLabel = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  return <Layout><section className="dashboard"><div className="dashboard-head"><div><div className="page-kicker">SALA EN DIRECTO <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><h1>{session.examName}</h1><p>Creada por {session.professorName} · {session.status === 'active' ? `Tiempo restante ${remainingLabel}` : session.status === 'waiting' ? 'Esperando inicio' : 'Sesión finalizada'}</p></div><div className="head-actions">{pendingHelp.length > 0 && <span className="help-badge">✋ {pendingHelp.length} en espera</span>}<span className={`status-chip ${session.status}`}>{session.status === 'active' ? '● En curso' : session.status === 'waiting' ? '◌ Lista para iniciar' : '○ Finalizada'}</span>{session.status === 'waiting' && <button className="button button-dark" onClick={startSession}>Iniciar examen <span>→</span></button>}{session.status === 'active' && <button className="button button-danger" onClick={endSession}>Finalizar sesión</button>}</div></div><section className="help-panel"><div className="panel-header"><div><div className="panel-label">SOLICITUDES DE AYUDA</div><h2>{pendingHelp.length ? `${pendingHelp.length} en espera` : 'Nadie ha llamado'}</h2></div><button className="sound-toggle" type="button" onClick={enableHelpSound}>{helpSoundEnabled ? 'Sonido activado' : 'Activar aviso sonoro'}</button></div>{pendingHelp.length ? <div className="help-list">{pendingHelp.map((request) => <div className="help-row" key={request.requestId}><span className="help-dot" /><span className="help-name">{request.studentName}<small>Esperando {formatElapsed(request.requestedAt)}</small></span><button className="button button-dark" type="button" onClick={() => resolveHelp(request.requestId)}>Atender</button></div>)}</div> : <div className="empty-state">Sin solicitudes activas.<br /><span>Cuando un estudiante llame, aparecerá aquí.</span></div>}</section><div className="dashboard-grid"><section className="qr-panel"><div className="panel-label">ACCESO DE ESTUDIANTES</div><div className="qr-frame"><img src={session.qrCode} alt="Código QR de acceso" /></div><strong>{session.status === 'waiting' ? 'Escanea y espera el inicio' : 'Sesión iniciada'}</strong><p>También puedes compartir este enlace:</p><button className="copy-link" onClick={() => navigator.clipboard?.writeText(session.qrData)}>{session.qrData.replace('http://', '').replace('https://', '')} <span>Copiar</span></button></section><section className="roster-panel"><div className="panel-header"><div><div className="panel-label">PRESENTES</div><h2>{activeStudents.length.toString().padStart(2, '0')} estudiantes</h2></div><span className="live-dot">{session.status === 'waiting' ? 'ESPERANDO' : 'EN VIVO'}</span></div>{activeStudents.length === 0 ? <div className="empty-state">Esperando a tu primera conexión<br /><span>Comparte el código de acceso con la clase.</span></div> : <div className="student-list">{activeStudents.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>{student.rut ? `${student.rut} · ` : ''}{student.email ? `${student.email} · ` : ''}Conectado {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><button className="row-action" onClick={() => expel(student.studentId)} title="Expulsar estudiante">Expulsar</button></div>)}</div>}</section></div><section className="alerts-panel"><div className="panel-header"><div><div className="panel-label">REGISTRO DE ACTIVIDAD</div><h2>Alertas recientes</h2></div><span className="alert-count">{session.alerts?.length || 0}</span></div>{session.alerts?.length ? <div className="alert-list">{session.alerts.slice(0, 10).map((alert) => <div className="alert-row" key={alert.alertId}><span className={`alert-icon alert-sev-${alert.severity ?? 'info'}${alert.type === 'screen_lock' ? ' alert-icon-lock' : ''}`}>{alert.type === 'screen_lock' ? '●' : '!'}</span><span><strong>{alert.studentName}</strong> · {alert.message}<small>{new Date(alert.timestamp).toLocaleTimeString('es-ES')}</small></span></div>)}</div> : <div className="empty-alerts">No hay actividad sospechosa registrada.</div>}</section></section></Layout>;
}

function SessionSummary({ session }) {
  const students = session.students || [];
  const alertHistory = [...(session.alerts || [])].reverse();
  return <Layout><section className="summary-page"><div className="page-kicker">RESUMEN DE SESIÓN <span>/{session.sessionId.slice(-4).toUpperCase()}</span></div><div className="summary-heading"><div><h1>Examen<br /><em>finalizado.</em></h1><p className="lede">La sesión quedó cerrada y el registro temporal está listo para revisar.</p></div><Link className="button button-dark" to="/professor">Nueva sesión <span>→</span></Link></div><div className="summary-metrics"><div><strong>{students.length.toString().padStart(2, '0')}</strong><span>estudiantes<br />registrados</span></div><div><strong>{session.alerts?.length || 0}</strong><span>alertas<br />registradas</span></div><div><strong>{session.duration}<small> min</small></strong><span>duración<br />programada</span></div></div><section className="summary-table"><div className="panel-header"><div><div className="panel-label">LISTA FINAL</div><h2>Estudiantes de la prueba</h2></div></div>{students.length ? <div className="student-list">{students.map((student) => <div className="student-row" key={student.studentId}><span className="avatar">{student.name.charAt(0).toUpperCase()}</span><span className="student-name">{student.name}<small>{student.email ? `${student.email} · ` : ''}Ingreso: {new Date(student.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></span><span className="status-chip ended">{student.status === 'expelled' ? 'Expulsado' : student.status === 'offline' ? 'Desconectado' : 'Registrado'}</span></div>)}</div> : <div className="empty-alerts">No hubo estudiantes registrados.</div>}</section><section className="alerts-panel summary-alerts"><div className="panel-header"><div><div className="panel-label">HISTORIAL DE ALERTAS</div><h2>Actividad durante el examen</h2></div><span className="alert-count">{alertHistory.length}</span></div>{alertHistory.length ? <div className="alert-list">{alertHistory.map((alert) => <div className="alert-row" key={alert.alertId}><span className={`alert-icon${alert.type === 'screen_lock' ? ' alert-icon-lock' : ''}`}>{alert.type === 'screen_lock' ? '●' : '!'}</span><span><strong>{alert.studentName}</strong> · {alert.message}<small>{new Date(alert.timestamp).toLocaleTimeString('es-ES')}</small></span></div>)}</div> : <div className="empty-alerts">No hubo actividad sospechosa durante el examen.</div>}</section></section></Layout>;
}

function StudentEntry() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { session: account } = useAuth();
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', rut: '' });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(() => readGuest(sessionId));

  useEffect(() => {
    if (!sessionId) return;
    fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then(setInfo).catch(() => setError('El enlace no corresponde a una sesión activa.'));
  }, [sessionId]);
  // Quien ya tiene cuenta de estudiante entra con sus datos precargados y el examen queda en su historial.
  useEffect(() => { if (account?.role === 'estudiante') setForm((current) => ({ ...current, name: current.name || account.name || '', email: current.email || account.email || '' })); }, [account?.email]);

  async function join(event) {
    event.preventDefault(); setError('');
    if (!isValidRut(form.rut)) return setError('El RUT no es válido. Revisa el número y el dígito verificador.');
    setLoading(true);
    try {
      const headers = { 'Content-Type': 'application/json', ...(account?.role === 'estudiante' ? { Authorization: `Bearer ${account.token}` } : {}) };
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/guest`, { method: 'POST', headers, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      localStorage.setItem(guestStorageKey(sessionId), JSON.stringify({ token: data.token, student: data.student }));
      navigate(`/student/${sessionId}/live`);
    } catch (caught) { setError(caught.message || 'No se pudo registrar tu ingreso.'); } finally { setLoading(false); }
  }
  function forget() { localStorage.removeItem(guestStorageKey(sessionId)); setSaved(null); }

  if (!sessionId) return <StudentScanner />;
  const ended = info && info.status === 'ended';
  if (saved && !ended && !error) return <Layout><section className="student-entry"><div className="student-badge">ACCESO A SESIÓN</div><h1>Ya estás<br /><em>registrado.</em></h1><p className="lede">Entraste como <strong>{saved.student.name}</strong> ({saved.student.rut}). Tu pase sigue vigente: puedes volver al examen aunque hayas cerrado la página.</p><div className="student-form"><button className="button button-dark" type="button" onClick={() => navigate(`/student/${sessionId}/live`)}>Volver al examen <span>→</span></button><button className="row-action switch-mode" type="button" onClick={forget}>No soy yo · registrar otros datos</button></div></section></Layout>;
  return <Layout><section className="student-entry"><div className="student-badge">ACCESO A SESIÓN</div>
    <h1>Ingresa a<br /><em>la evaluación.</em></h1>
    {info && <p className="lede"><strong>{info.examName}</strong>{info.courseName ? ` · ${info.courseName}` : ''}{info.professorName ? ` · Prof. ${info.professorName}` : ''}{info.description ? <><br /><span className="entry-desc">{info.description}</span></> : null}</p>}
    {ended && <p className="error-message">Esta sesión ya finalizó.</p>}
    <form className="student-form" onSubmit={join}>
      <label>Nombre completo<input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Carlos López Pérez" autoComplete="name" /></label>
      <label>Correo<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="nombre@correo.cl" autoComplete="email" /></label>
      <label>RUT<input required inputMode="text" value={form.rut} onChange={(e) => setForm({ ...form, rut: formatRut(e.target.value) })} placeholder="12.345.678-5" maxLength={12} /></label>
      <label className="consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>Entiendo que mi actividad durante el examen (cambios de pantalla, desconexiones, copiar y pegar, entre otras) queda registrada, y que el profesor validará estos datos.</span></label>
      {error && <p className="error-message">{error}</p>}
      <button className="button button-dark" type="submit" disabled={loading || !consent || ended}>{loading ? 'Registrando…' : 'Entrar al examen'} <span>→</span></button>
    </form></section></Layout>;
}

function StudentScanner() { const navigate = useNavigate(); useEffect(() => { const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 220, height: 220 } }, false); scanner.render((decoded) => { scanner.clear(); try { navigate(new URL(decoded).pathname); } catch { navigate(decoded); } }, () => {}); return () => scanner.clear().catch(() => {}); }, [navigate]); return <Layout><AreaNav role="estudiante" /><section className="scanner-page"><div className="page-kicker">ENTRADA DE ESTUDIANTE <span>01</span></div><h1>Escanea el<br /><em>código de acceso.</em></h1><p className="lede">Apunta la cámara al QR que muestra tu profesor.</p><div id="reader" className="scanner-box" /></section></Layout>; }

function StudentLive() { const { sessionId } = useParams(); const navigate = useNavigate(); const location = useLocation(); const guest = readGuest(sessionId); const [session, setSession] = useState(null); const [alertCount, setAlertCount] = useState(0); const [now, setNow] = useState(Date.now()); const [soundEnabled, setSoundEnabled] = useState(false); const [helpStatus, setHelpStatus] = useState('idle'); const audioContext = useRef(null); const [notice, setNotice] = useState(null); const name = guest?.student?.name || 'Estudiante';
  useEffect(() => { if (!guest) navigate(`/student/${sessionId}`, { replace: true }); }, [sessionId]);
  useEffect(() => { if (!guest) return; fetch(`${API_URL}/api/sessions/${sessionId}`).then((r) => r.json()).then(setSession); const onConnected = (data) => setSession((current) => ({ ...current, students: data.students })); const onUpdate = (data) => setSession(data); const onExpelled = () => navigate('/student'); const onEnded = () => setSession((current) => ({ ...current, status: 'ended' })); const onAlert = (alert) => { setAlertCount((value) => value + 1); playAlertSound(); showAlertNotification(alert); }; const onHelpResolved = () => setHelpStatus('idle'); socket.on('session:connected', onConnected); socket.on('session:updated', onUpdate); socket.on('student:expelled', onExpelled); socket.on('session:ended', onEnded); socket.on('alert:recorded', onAlert); socket.on('help:resolved', onHelpResolved); const join = () => socket.emit('student:join', { sessionId, guestToken: guest.token }); const onReplaced = () => { setNotice({ title: 'Sesión abierta en otro dispositivo', text: 'Esta sesión se abrió desde otro dispositivo o pestaña, por lo que esta quedó cerrada. El profesor fue avisado.' }); socket.disconnect(); }; const onSessionError = ({ message }) => setNotice({ title: 'No se pudo entrar a la sesión', text: message, retry: !/expulsado/.test(message) }); socket.on('connect', join); socket.on('student:replaced', onReplaced); socket.on('session:error', onSessionError); socket.connect(); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); return () => { socket.off('session:connected', onConnected); socket.off('session:updated', onUpdate); socket.off('student:expelled', onExpelled); socket.off('session:ended', onEnded); socket.off('alert:recorded', onAlert); socket.off('help:resolved', onHelpResolved); socket.off('connect', join); socket.off('student:replaced', onReplaced); socket.off('session:error', onSessionError); socket.disconnect(); }; }, [sessionId]);
  function enableSound() { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return; audioContext.current = new AudioContextClass(); audioContext.current.resume(); setSoundEnabled(true); }
  function playAlertSound() { if (!audioContext.current || !soundEnabled) return; const oscillator = audioContext.current.createOscillator(); const gain = audioContext.current.createGain(); oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.18, audioContext.current.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.current.currentTime + 0.35); oscillator.connect(gain); gain.connect(audioContext.current.destination); oscillator.start(); oscillator.stop(audioContext.current.currentTime + 0.35); }
  function showAlertNotification(alert) { if ('Notification' in window && Notification.permission === 'granted') new Notification('Actividad registrada', { body: alert.message }); }
  function requestHelp() { socket.emit('student:help_request', { sessionId }); setHelpStatus('pending'); }
  function cancelHelp() { socket.emit('student:help_cancel', { sessionId }); setHelpStatus('idle'); }
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!guest) return undefined;
    // Cada acción del alumno se envía al servidor, que la registra y avisa al profesor. El contador local lo
    // actualiza la confirmación del servidor, así no se cuenta doble.
    const lastSent = {};
    const report = (type, message, minGapMs = 700) => {
      const now = Date.now();
      if (now - (lastSent[type] ?? 0) < minGapMs) return;
      lastSent[type] = now;
      socket.emit('student:event', { sessionId, type, message });
    };
    let lastInteraction = Date.now();
    let hiddenAt = null;
    let idleReported = false;
    const markInteraction = () => { lastInteraction = Date.now(); idleReported = false; };
    const interactionEvents = ['pointerdown', 'touchstart', 'keydown', 'scroll', 'mousemove'];
    interactionEvents.forEach((eventName) => window.addEventListener(eventName, markInteraction, { passive: true }));

    const visibility = () => {
      if (document.hidden) {
        const idleMs = Date.now() - lastInteraction;
        hiddenAt = Date.now();
        if (idleMs >= 5000) report('screen_lock', 'Ocultó la pantalla tras un rato sin tocarla (posible bloqueo o cierre)');
        else report('tab_switch', 'Cambió de pestaña o aplicación');
      } else if (hiddenAt) {
        const seconds = Math.round((Date.now() - hiddenAt) / 1000);
        hiddenAt = null;
        report('returned', `Volvió a la pantalla del examen tras ${seconds} s`);
      }
    };
    const blur = () => { if (!document.hidden) report('window_blur', 'Perdió foco de ventana'); };
    const keydown = (event) => {
      const key = event.key?.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if (key === 'printscreen') report('screenshot_key', 'Presionó la tecla Imprimir pantalla');
      else if (key === 'f12' || (command && event.shiftKey && ['i', 'j', 'c'].includes(key))) report('shortcut', 'Intentó abrir las herramientas de desarrollador');
      else if (command && ['u', 's', 'f', 'a'].includes(key)) report('shortcut', `Usó el atajo ${event.metaKey ? 'Cmd' : 'Ctrl'}+${key.toUpperCase()}`);
    };
    const listeners = [
      [window, 'blur', blur], [document, 'visibilitychange', visibility], [document, 'keydown', keydown],
      [document, 'copy', () => report('copy', 'Copió contenido de la página')], [document, 'cut', () => report('cut', 'Cortó contenido de la página')], [document, 'paste', () => report('paste', 'Pegó contenido en la página')],
      [document, 'contextmenu', () => report('context_menu', 'Abrió el menú contextual (clic derecho o pulsación larga)')],
      [window, 'beforeprint', () => report('print', 'Intentó imprimir la página')],
      [window, 'orientationchange', () => report('orientation_change', 'Giró la pantalla del dispositivo', 2000)]
    ];
    listeners.forEach(([target, eventName, handler]) => target.addEventListener(eventName, handler));
    const idleTimer = setInterval(() => {
      if (!document.hidden && !idleReported && Date.now() - lastInteraction > 90_000) { idleReported = true; report('idle', 'Sin interacción con la pantalla por más de 90 s'); }
    }, 5000);
    return () => {
      interactionEvents.forEach((eventName) => window.removeEventListener(eventName, markInteraction));
      listeners.forEach(([target, eventName, handler]) => target.removeEventListener(eventName, handler));
      clearInterval(idleTimer);
    };
  }, [sessionId]);
  const remainingSeconds = session?.endsAt ? Math.max(0, Math.ceil((Date.parse(session.endsAt) - now) / 1000)) : 0;
  const formatted = session?.status === 'active' ? `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}` : '--:--';
  const waiting = session?.status === 'waiting';
  if (notice) return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label">Sesión cerrada</span></header><section className="live-content ended-screen"><div className="live-kicker">{session?.examName || 'Sesión de evaluación'}</div><h1>{notice.title}</h1><p className="live-intro">{notice.text}</p>{notice.retry && <Link className="button button-dark" to={`/student/${sessionId}`} onClick={() => localStorage.removeItem(guestStorageKey(sessionId))}>Volver a registrarme <span>→</span></Link>}</section></div>;
  if (session?.status === 'ended') return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label">Sesión cerrada</span></header><section className="live-content ended-screen"><div className="live-kicker">{session.examName}</div><h1>Examen<br /><em>finalizado.</em></h1><p className="live-intro">El profesor ha cerrado esta sesión. Tus respuestas y tu registro han quedado guardados.</p></section></div>;
  return <div className="live-shell"><header className="live-header"><Brand /><span className="secure-label"><i /> Sesión protegida</span></header><section className="live-content"><div className="live-kicker">{session?.examName || 'Sesión de evaluación'} <span>· {waiting ? 'ESPERANDO INICIO' : 'EN CURSO'}</span></div><h1>Hola, {name.split(' ')[0]}.</h1><p className="live-intro">{waiting ? 'El profesor aún no ha iniciado la evaluación. Permanece en esta pantalla.' : 'Esta pantalla permanece activa mientras realizas tu evaluación.'}</p><div className="timer-card"><span>{waiting ? 'TIEMPO PENDIENTE' : 'TIEMPO RESTANTE'}</span><strong>{formatted}</strong><div className="timer-track"><i style={{ width: session?.status === 'active' ? `${Math.max(0, Math.min(100, (remainingSeconds / (session.duration * 60)) * 100))}%` : '0%' }} /></div></div><div className="live-stats"><div><strong>{session?.students?.filter((s) => s.status === 'active').length || 1}</strong><span>compañeros<br />presentes</span></div><div><strong>{alertCount}</strong><span>eventos<br />registrados</span></div></div><div className="live-notice"><span>◉</span><p><strong>{waiting ? 'Conectado correctamente.' : 'Tu sesión está siendo supervisada.'}</strong><br />{waiting ? 'Recibirás el inicio en esta misma pantalla.' : 'Permanece en esta pestaña hasta entregar tu evaluación.'}</p></div><button className="sound-toggle" onClick={enableSound}>{soundEnabled ? 'Sonido activado' : 'Activar sonido de alertas'}</button></section><button className={`help-button${helpStatus === 'pending' ? ' help-button-pending' : ''}`} type="button" onClick={helpStatus === 'pending' ? cancelHelp : requestHelp}>{helpStatus === 'pending' ? 'Esperando al profesor… (cancelar)' : '✋ Tengo una duda'}</button></div>;
}

const STATUS_LABELS = { pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazada', disabled: 'Desactivado' };
const ROLE_LABELS = { admin: 'Administrador', profesor: 'Profesor', estudiante: 'Estudiante' };
const STATUS_FILTERS = [['all', 'Todos'], ['pending', 'Solicitudes'], ['approved', 'Aprobados'], ['rejected', 'Rechazadas'], ['disabled', 'Desactivados']];
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
  const statusOrder = { pending: 0, approved: 1, rejected: 2, disabled: 3 };
  const visible = users.filter((user) => (filter === 'all' || user.status === filter) && (!needle || `${user.name} ${user.email}`.toLowerCase().includes(needle))).sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return <Layout><section className="admin-page">
    <div className="page-kicker">ADMINISTRACIÓN DE CUENTAS <span>{users.length}</span></div>
    <div className="admin-heading"><h1>Gestión de<br /><em>usuarios.</em></h1><div className="landing-note"><span className="note-line" /> <span>{auth.email} · <Link className="admin-link" to="/admin/catalog">Catálogo de ramos</Link> · <Link className="admin-link" to="/professor">Modo profesor</Link> · <button className="row-action" type="button" onClick={logout}>Cerrar sesión</button></span></div></div>
    {pending > 0 && <p className="notice-message">{pending} {pending === 1 ? 'solicitud espera' : 'solicitudes esperan'} tu revisión.</p>}
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
        <td><strong>{user.name || '—'}</strong><span>{user.email}</span>{user.requestNote && <em className="request-note">“{user.requestNote}”</em>}</td>
        <td>{user.status === 'pending' && <small className="request-hint">Solicita ser</small>}<select value={user.role} disabled={self} onChange={(e) => patch(user, { role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
        <td><span className={`status-pill status-${user.status}`}>{STATUS_LABELS[user.status]}</span></td>
        <td className="admin-actions">
          {user.status !== 'approved' && <button type="button" onClick={() => patch(user, { status: 'approved' })}>{user.status === 'disabled' ? 'Activar' : 'Aprobar'}</button>}
          {user.status === 'pending' && <button type="button" className="danger" onClick={() => patch(user, { status: 'rejected' })}>Rechazar</button>}
          {user.status === 'approved' && !self && <button type="button" onClick={() => patch(user, { status: 'disabled' })}>Desactivar</button>}
          <button type="button" onClick={() => patch(user, { name: window.prompt('Nombre:', user.name) ?? user.name })}>Renombrar</button>
          <button type="button" onClick={() => resetPassword(user)}>Contraseña</button>
          {!self && <button type="button" className="danger" onClick={() => remove(user)}>Eliminar</button>}
        </td>
      </tr>; })}</tbody>
    </table>{visible.length === 0 && <p className="admin-empty">No hay usuarios que coincidan.</p>}</div>
  </section></Layout>;
}

function AdminCatalogPage() {
  const { auth, login } = useAuth('admin');
  if (!auth) return <Layout><LoginForm role="admin" onAuthenticated={login} /></Layout>;
  return <Layout><section className="admin-page"><Link className="admin-link" to="/admin">← Usuarios</Link><CatalogAdmin api={(path, options) => request(auth.token, path, options)} /></section></Layout>;
}

export default function App() { return <Routes><Route path="/" element={<Landing />} /><Route path="/login" element={<LoginPage />} /><Route path="/register" element={<RegisterPage />} /><Route path="/professor" element={<ProfessorDashboard />} /><Route path="/professor/exams" element={<RoleArea role="profesor" view="exams" />} /><Route path="/professor/profile" element={<RoleArea role="profesor" view="profile" />} /><Route path="/student/exams" element={<RoleArea role="estudiante" view="exams" />} /><Route path="/student/profile" element={<RoleArea role="estudiante" view="profile" />} /><Route path="/admin" element={<AdminPanel />} /><Route path="/admin/catalog" element={<AdminCatalogPage />} /><Route path="/student" element={<StudentEntry />} /><Route path="/student/:sessionId" element={<StudentEntry />} /><Route path="/student/:sessionId/live" element={<StudentLive />} /></Routes>; }
