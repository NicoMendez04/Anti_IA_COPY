import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const ROLES = ['admin', 'profesor', 'estudiante'];
const SELF_REGISTER_ROLES = ['profesor', 'estudiante'];
const STATUSES = ['pending', 'approved', 'disabled'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const PROFILE_TTL_MS = 15_000;

function loadCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  try {
    if (raw) return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    return JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE ?? 'firebase-service-account.json', 'utf8'));
  } catch (err) {
    throw new Error(`No se pudieron cargar las credenciales de Firebase. Define FIREBASE_SERVICE_ACCOUNT (JSON o base64) o coloca backend/firebase-service-account.json. Detalle: ${err.message}`);
  }
}

initializeApp({ credential: cert(loadCredentials()) });
const auth = getAuth();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
const users = db.collection('users');
export const firestore = db;

const parseList = (value) => new Set((value ?? '').split(',').map((item) => item.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
const adminEmails = parseList(process.env.ADMIN_EMAILS);
const allowedDomains = parseList(process.env.ALLOWED_EMAIL_DOMAINS);
const domainAllowed = (email) => allowedDomains.size === 0 || allowedDomains.has(email.split('@')[1]);
const profileCache = new Map();

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const bearerToken = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

async function loadProfile(uid, email, provider, requestedRole, displayName) {
  const cached = profileCache.get(uid);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;

  const ref = users.doc(uid);
  const snapshot = await ref.get();
  // Solo se es administrador por contraseña: un proveedor externo podría declarar cualquier correo.
  const asAdmin = adminEmails.has(email) && provider === 'password';
  let profile = snapshot.exists ? snapshot.data() : null;

  if (!profile) {
    if (!asAdmin && !domainAllowed(email)) {
      await auth.deleteUser(uid).catch(() => {});
      throw Object.assign(new Error('Dominio no autorizado.'), { code: 'DOMAIN_NOT_ALLOWED' });
    }
    const role = asAdmin ? 'admin' : SELF_REGISTER_ROLES.includes(requestedRole) ? requestedRole : 'estudiante';
    // Los profesores siempre esperan aprobación; los estudiantes entran solos si hay dominios autorizados.
    const approved = asAdmin || (role === 'estudiante' && allowedDomains.size > 0);
    profile = { email, name: displayName ?? '', role, status: approved ? 'approved' : 'pending', createdAt: new Date().toISOString() };
    await ref.set(profile);
  } else if (asAdmin && (profile.role !== 'admin' || profile.status !== 'approved')) {
    profile = { ...profile, role: 'admin', status: 'approved' };
    await ref.update({ role: 'admin', status: 'approved' });
  }

  profileCache.set(uid, { profile, at: Date.now() });
  return profile;
}

async function verify(token, requestedRole) {
  if (!token) return null;
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    return null;
  }
  const email = normalizeEmail(decoded.email);
  const provider = decoded.firebase?.sign_in_provider;
  if (provider === 'google.com' && !decoded.email_verified) return null;
  const profile = await loadProfile(decoded.uid, email, provider, requestedRole, decoded.name);
  if (profile.role === 'admin' && provider !== 'password') return null;
  return { uid: decoded.uid, email, profile };
}

export async function authFromToken(token) {
  let verified;
  try { verified = await verify(token); } catch { return null; }
  if (!verified || verified.profile.status !== 'approved') return null;
  const { uid, email, profile } = verified;
  return { uid, email, role: profile.role, name: profile.name };
}

export function requireAuth(...roles) {
  return async (req, res, next) => {
    const context = await authFromToken(bearerToken(req));
    if (!context || !roles.includes(context.role)) return res.status(401).json({ message: 'Debes iniciar sesión.' });
    req.auth = context;
    next();
  };
}

const registrations = new Map();
function limitRegistrations(req, res, next) {
  const now = Date.now();
  const recent = (registrations.get(req.ip) ?? []).filter((time) => now - time < 3_600_000);
  if (recent.length >= 10) return res.status(429).json({ message: 'Demasiados registros desde esta red. Intenta más tarde.' });
  recent.push(now);
  registrations.set(req.ip, recent);
  next();
}

function forgetProfile(uid) {
  profileCache.delete(uid);
}

export function registerAccountRoutes(app) {
  app.post('/api/auth/register', limitRegistrations, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name ?? '').trim();
    const { password, role } = req.body;
    if (!name) return res.status(400).json({ message: 'Ingresa tu nombre.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Ingresa un correo válido.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ message: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
    if (!SELF_REGISTER_ROLES.includes(role)) return res.status(400).json({ message: 'Rol inválido.' });
    if (adminEmails.has(email)) return res.status(403).json({ message: 'Ese correo está reservado.' });
    if (!domainAllowed(email)) return res.status(403).json({ message: 'Tu correo no pertenece a un dominio autorizado.' });

    try {
      const user = await auth.createUser({ email, password, displayName: name });
      await users.doc(user.uid).set({ email, name, role, status: 'pending', createdAt: new Date().toISOString() });
      res.status(201).json({ message: 'Cuenta creada. Un administrador debe aprobarla antes de que puedas entrar.' });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') return res.status(409).json({ message: 'Ya existe una cuenta con ese correo.' });
      console.error('Error al registrar usuario:', err);
      res.status(500).json({ message: 'No se pudo crear la cuenta.' });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const verified = await verify(bearerToken(req), req.query.role);
      if (!verified) return res.status(401).json({ message: 'Sesión no válida.' });
      const { email, profile } = verified;
      res.json({ email, name: profile.name, role: profile.role, status: profile.status });
    } catch (err) {
      if (err.code === 'DOMAIN_NOT_ALLOWED') return res.status(403).json({ message: 'Tu correo no pertenece a un dominio autorizado.' });
      console.error('Error al validar la sesión:', err);
      res.status(500).json({ message: 'No se pudo validar la sesión.' });
    }
  });

  const anyRole = requireAuth(...ROLES);
  const profileText = { institution: 120, department: 120, subjects: 200, career: 120, studentId: 40 };
  const avatarColors = ['#c9f469', '#f4e3a6', '#e6c3bb', '#bfd8f2', '#d9c8f0', '#c7e8d5'];

  app.get('/api/me/profile', anyRole, async (req, res) => {
    const snapshot = await users.doc(req.auth.uid).get();
    res.json({ uid: req.auth.uid, ...snapshot.data() });
  });

  app.patch('/api/me/profile', anyRole, async (req, res) => {
    const updates = {};
    if (req.body.name !== undefined) {
      updates.name = String(req.body.name).trim().slice(0, 80);
      if (!updates.name) return res.status(400).json({ message: 'El nombre no puede quedar vacío.' });
    }
    for (const [field, max] of Object.entries(profileText)) {
      if (req.body[field] !== undefined) updates[field] = String(req.body[field]).trim().slice(0, max);
    }
    if (req.body.avatarColor !== undefined) {
      if (!avatarColors.includes(req.body.avatarColor)) return res.status(400).json({ message: 'Color no válido.' });
      updates.avatarColor = req.body.avatarColor;
    }
    updates.updatedAt = new Date().toISOString();
    await users.doc(req.auth.uid).update(updates);
    forgetProfile(req.auth.uid);
    const snapshot = await users.doc(req.auth.uid).get();
    res.json({ uid: req.auth.uid, ...snapshot.data() });
  });

  const adminOnly = requireAuth('admin');

  app.get('/api/admin/users', adminOnly, async (_req, res) => {
    const snapshot = await users.orderBy('createdAt', 'desc').get();
    res.json(snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() })));
  });

  app.post('/api/admin/users', adminOnly, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name ?? '').trim();
    const { password, role } = req.body;
    if (!name) return res.status(400).json({ message: 'Ingresa el nombre.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Ingresa un correo válido.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ message: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
    if (!ROLES.includes(role)) return res.status(400).json({ message: 'Rol inválido.' });

    try {
      const user = await auth.createUser({ email, password, displayName: name });
      const profile = { email, name, role, status: 'approved', createdAt: new Date().toISOString() };
      await users.doc(user.uid).set(profile);
      res.status(201).json({ uid: user.uid, ...profile });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') return res.status(409).json({ message: 'Ya existe una cuenta con ese correo.' });
      console.error('Error al crear usuario:', err);
      res.status(500).json({ message: 'No se pudo crear la cuenta.' });
    }
  });

  app.patch('/api/admin/users/:uid', adminOnly, async (req, res) => {
    const { uid } = req.params;
    const ref = users.doc(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ message: 'Usuario no encontrado.' });

    const { name, role, status } = req.body;
    const updates = {};
    const authUpdates = {};

    if (name !== undefined) {
      updates.name = String(name).trim();
      authUpdates.displayName = updates.name;
    }
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ message: 'Rol inválido.' });
      updates.role = role;
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Estado inválido.' });
      updates.status = status;
      authUpdates.disabled = status === 'disabled';
    }
    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Ingresa un correo válido.' });
      updates.email = email;
      authUpdates.email = email;
    }

    if (uid === req.auth.uid && ((updates.role && updates.role !== 'admin') || (updates.status && updates.status !== 'approved'))) {
      return res.status(400).json({ message: 'No puedes quitarte tu propio acceso de administrador.' });
    }

    try {
      if (Object.keys(authUpdates).length) await auth.updateUser(uid, authUpdates);
      if (updates.status === 'disabled') await auth.revokeRefreshTokens(uid);
    } catch (err) {
      if (err.code === 'auth/email-already-exists') return res.status(409).json({ message: 'Ya existe una cuenta con ese correo.' });
      console.error('Error al actualizar usuario:', err);
      return res.status(500).json({ message: 'No se pudo actualizar la cuenta.' });
    }

    updates.updatedAt = new Date().toISOString();
    await ref.update(updates);
    forgetProfile(uid);
    res.json({ uid, ...snapshot.data(), ...updates });
  });

  app.post('/api/admin/users/:uid/password', adminOnly, async (req, res) => {
    const { uid } = req.params;
    const { password } = req.body;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ message: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
    try {
      await auth.updateUser(uid, { password });
      await auth.revokeRefreshTokens(uid);
      res.json({ success: true });
    } catch (err) {
      if (err.code === 'auth/user-not-found') return res.status(404).json({ message: 'Usuario no encontrado.' });
      console.error('Error al cambiar contraseña:', err);
      res.status(500).json({ message: 'No se pudo cambiar la contraseña.' });
    }
  });

  app.delete('/api/admin/users/:uid', adminOnly, async (req, res) => {
    const { uid } = req.params;
    if (uid === req.auth.uid) return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta.' });
    try {
      await auth.deleteUser(uid);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') {
        console.error('Error al eliminar usuario:', err);
        return res.status(500).json({ message: 'No se pudo eliminar la cuenta.' });
      }
    }
    await users.doc(uid).delete();
    forgetProfile(uid);
    res.json({ success: true });
  });
}
