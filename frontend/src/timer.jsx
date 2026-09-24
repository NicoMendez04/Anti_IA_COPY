import { useEffect } from 'react';

const pad = (value) => String(value).padStart(2, '0');

export const formatClockTime = (date, withSeconds = true) => date.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false });

export function formatCountdown(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function timerState(session, now) {
  if (session.status === 'active' && session.endsAt) {
    const seconds = Math.max(0, Math.ceil((Date.parse(session.endsAt) - now.getTime()) / 1000));
    return { seconds, label: 'TIEMPO RESTANTE', tone: seconds <= 60 ? 'danger' : seconds <= 300 ? 'warn' : 'ok', percent: Math.min(100, (seconds / (session.duration * 60)) * 100) };
  }
  if (session.status === 'waiting') return { seconds: session.duration * 60, label: 'DURACIÓN DEL EXAMEN', tone: 'idle', percent: 100 };
  return { seconds: 0, label: 'EXAMEN FINALIZADO', tone: 'idle', percent: 0 };
}

/** Temporizador grande del panel del profesor, con la hora local en tiempo real. */
export function BigTimer({ session, now, onProject }) {
  const { seconds, label, tone, percent } = timerState(session, now);
  return <section className={`big-timer tone-${tone}`} aria-label="Temporizador del examen">
    <div className="big-timer-main">
      <span className="big-timer-label">{label}</span>
      <strong className="big-timer-digits" aria-live="off">{formatCountdown(seconds)}</strong>
      <div className="big-timer-bar"><i style={{ width: `${percent}%` }} /></div>
    </div>
    <div className="big-timer-side">
      <div><span>HORA ACTUAL</span><strong>{formatClockTime(now)}</strong></div>
      {session.status === 'active' && session.endsAt && <div><span>TERMINA A LAS</span><strong>{formatClockTime(new Date(session.endsAt), false)}</strong></div>}
      <button type="button" onClick={onProject}>Proyectar en pantalla completa</button>
    </div>
  </section>;
}

/** Vista a pantalla completa pensada para un proyector: se lee desde el fondo de la sala. Esc para salir. */
export function ProjectorOverlay({ session, now, onClose }) {
  const { seconds, label, tone } = timerState(session, now);
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    const onFullscreen = () => { if (!document.fullscreenElement) onClose(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  const status = session.status === 'active' ? 'EN CURSO' : session.status === 'waiting' ? 'ESPERANDO INICIO' : 'FINALIZADO';
  return <div className={`projector tone-${tone}`} role="dialog" aria-label="Temporizador para proyectar">
    <header><div><strong>{session.examName}</strong>{session.courseName && <span>{session.courseName}</span>}</div><button type="button" onClick={onClose}>Salir · Esc</button></header>
    <main><span className="projector-label">{label}</span><div className="projector-digits">{formatCountdown(seconds)}</div></main>
    <footer><div><span>HORA ACTUAL</span><strong>{formatClockTime(now)}</strong></div><div className="projector-status">{status}</div>{session.status === 'active' && session.endsAt && <div><span>TERMINA A LAS</span><strong>{formatClockTime(new Date(session.endsAt), false)}</strong></div>}</footer>
  </div>;
}
