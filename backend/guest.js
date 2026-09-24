import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Pase de invitado: identifica a un alumno dentro de UNA sesión sin necesidad de cuenta.
// Va firmado, así que el alumno no puede alterar su nombre, correo o RUT después de registrarse.
const SECRET = process.env.GUEST_TOKEN_SECRET || randomBytes(32).toString('hex');
if (!process.env.GUEST_TOKEN_SECRET) {
  console.warn('GUEST_TOKEN_SECRET no está definido: los pases de invitado dejarán de valer si el servidor se reinicia.');
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('base64url');

export function signGuestToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyGuestToken(token) {
  if (typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/** Valida un RUT chileno (con o sin puntos y guion) y lo devuelve como "12345678-9", o null si no es válido. */
export function normalizeRut(input) {
  const clean = String(input ?? '').replace(/[.\s-]/g, '').toUpperCase();
  if (!/^\d{7,8}[\dK]$/.test(clean)) return null;
  const body = clean.slice(0, -1);
  const check = clean.slice(-1);
  let sum = 0;
  let factor = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder);
  return check === expected ? `${Number(body)}-${check}` : null;
}

const attempts = new Map();
/** Límite simple por IP para el registro de invitados. */
export function limitGuestRegistrations(req, res, next) {
  const now = Date.now();
  const recent = (attempts.get(req.ip) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= 30) return res.status(429).json({ message: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' });
  recent.push(now);
  attempts.set(req.ip, recent);
  next();
}
