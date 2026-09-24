import { FieldValue } from 'firebase-admin/firestore';
import { firestore, requireAuth } from './accounts.js';

const careers = firestore.collection('careers');
const specialties = firestore.collection('specialties');
const courses = firestore.collection('courses');
const MAX_IMPORT_ROWS = 2000;
const BATCH_SIZE = 400;

const slug = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
const byName = (a, b) => a.name.localeCompare(b.name, 'es');

export async function loadCatalog({ includeInactive = false } = {}) {
  const [careerDocs, specialtyDocs, courseDocs] = await Promise.all([careers.get(), specialties.get(), courses.get()]);
  const keep = (item) => includeInactive || item.active !== false;
  return {
    careers: careerDocs.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(keep).sort(byName),
    specialties: specialtyDocs.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(keep).sort(byName),
    courses: courseDocs.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(keep).sort((a, b) => (a.semester ?? 99) - (b.semester ?? 99) || byName(a, b))
  };
}

/**
 * Valida el ramo elegido para una sesión. Mientras el catálogo esté vacío no se exige nada;
 * después, un profesor solo puede usar ramos de las áreas que eligió en su perfil.
 */
export const CUSTOM_COURSE = '__custom__';

export async function resolveCourse({ courseId, customCourseName, professorSpecialtyIds = [], isAdmin }) {
  // "Personalizado": cualquier profesor puede usarlo, por ejemplo al tomar la prueba de un colega de otra área.
  if (courseId === CUSTOM_COURSE) {
    const name = String(customCourseName ?? '').trim().slice(0, 160);
    if (!name) return { error: 'Escribe el nombre del ramo personalizado.' };
    return { course: { id: null, name, custom: true }, specialties: [] };
  }

  const catalog = await loadCatalog();
  if (!catalog.courses.length) return { course: null, specialties: [] };

  if (!courseId) return { error: 'Elige el ramo de la sesión o usa "Personalizado".' };
  if (!isAdmin && !professorSpecialtyIds.length) return { error: 'Completa tu perfil: elige tus áreas de profesorado para ver tus ramos, o usa "Personalizado".' };

  const course = catalog.courses.find((item) => item.id === courseId);
  if (!course) return { error: 'El ramo elegido no existe o está desactivado.' };
  const courseSpecialties = course.specialtyIds ?? [];
  if (!isAdmin && !courseSpecialties.some((id) => professorSpecialtyIds.includes(id))) return { error: 'Ese ramo no pertenece a tus áreas de profesorado.' };
  return { course, specialties: catalog.specialties.filter((item) => courseSpecialties.includes(item.id) && (isAdmin || professorSpecialtyIds.includes(item.id))) };
}

function normalizeRows(rows) {
  const clean = [];
  for (const row of rows) {
    const specialty = String(row?.specialty ?? '').trim();
    const course = String(row?.course ?? '').trim();
    if (!specialty || !course) continue;
    const semester = Number.parseInt(row.semester, 10);
    clean.push({
      career: String(row.career ?? '').trim().slice(0, 120),
      specialty: specialty.slice(0, 120),
      course: course.slice(0, 160),
      code: String(row.code ?? '').trim().slice(0, 40),
      semester: Number.isFinite(semester) ? semester : null,
      category: String(row.category ?? '').trim().slice(0, 120)
    });
  }
  return clean;
}

/** Carga (o actualiza) la malla desde filas planas: carrera, especialidad, código, ramo, semestre y categoría. */
export async function importCatalogRows(inputRows) {
  const rows = normalizeRows(inputRows.slice(0, MAX_IMPORT_ROWS));
  if (!rows.length) return { status: 400, error: 'No se encontraron filas válidas: cada fila necesita al menos especialidad y ramo.' };

  const careerMap = new Map();
  const specialtyMap = new Map();
  const courseMap = new Map();
  for (const row of rows) {
    const specialtyId = slug(row.specialty);
    if (!specialtyId) continue;
    specialtyMap.set(specialtyId, row.specialty);
    const careerId = slug(row.career);
    if (careerId) careerMap.set(careerId, row.career);
    const courseId = slug(`${row.career} ${row.code || row.course}`);
    if (!courseId) continue;
    const entry = courseMap.get(courseId) ?? { name: row.course, code: row.code, semester: row.semester, category: row.category, career: row.career, careerId, specialtyIds: new Set() };
    entry.specialtyIds.add(specialtyId);
    courseMap.set(courseId, entry);
  }

  const now = new Date().toISOString();
  const writes = [
    ...[...careerMap].map(([id, name]) => (batch) => batch.set(careers.doc(id), { name, active: true, updatedAt: now }, { merge: true })),
    ...[...specialtyMap].map(([id, name]) => (batch) => batch.set(specialties.doc(id), { name, active: true, updatedAt: now }, { merge: true })),
    ...[...courseMap].map(([id, entry]) => (batch) => batch.set(courses.doc(id), {
      name: entry.name, code: entry.code, semester: entry.semester, category: entry.category, career: entry.career, careerId: entry.careerId,
      active: true, updatedAt: now, specialtyIds: FieldValue.arrayUnion(...entry.specialtyIds)
    }, { merge: true }))
  ];
  try {
    for (let start = 0; start < writes.length; start += BATCH_SIZE) {
      const batch = firestore.batch();
      writes.slice(start, start + BATCH_SIZE).forEach((write) => write(batch));
      await batch.commit();
    }
  } catch (err) {
    console.error('No se pudo importar el catálogo:', err);
    return { status: 500, error: 'No se pudo importar el catálogo.' };
  }
  return { careers: careerMap.size, specialties: specialtyMap.size, courses: courseMap.size, rows: rows.length };
}

export function registerCatalogRoutes(app) {
  app.get('/api/catalog', requireAuth('admin', 'profesor', 'estudiante'), async (_req, res) => {
    res.json(await loadCatalog());
  });

  const adminOnly = requireAuth('admin');

  app.get('/api/admin/catalog', adminOnly, async (_req, res) => {
    res.json(await loadCatalog({ includeInactive: true }));
  });

  // Carga (o actualiza) la malla a partir de filas planas: especialidad, código, ramo y semestre.
  app.post('/api/admin/catalog/import', adminOnly, async (req, res) => {
    const result = await importCatalogRows(Array.isArray(req.body.rows) ? req.body.rows : []);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.json(result);
  });

  const patch = (collection) => async (req, res) => {
    const ref = collection.doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ message: 'No encontrado.' });
    const updates = {};
    if (req.body.name !== undefined) {
      updates.name = String(req.body.name).trim().slice(0, 160);
      if (!updates.name) return res.status(400).json({ message: 'El nombre no puede quedar vacío.' });
    }
    if (req.body.active !== undefined) updates.active = req.body.active === true;
    if (collection === courses) {
      if (req.body.category !== undefined) updates.category = String(req.body.category).trim().slice(0, 120);
      if (req.body.code !== undefined) updates.code = String(req.body.code).trim().slice(0, 40);
      if (req.body.semester !== undefined) updates.semester = Number.isFinite(Number(req.body.semester)) ? Number(req.body.semester) : null;
    }
    updates.updatedAt = new Date().toISOString();
    await ref.update(updates);
    res.json({ id: ref.id, ...(await ref.get()).data() });
  };
  app.patch('/api/admin/catalog/careers/:id', adminOnly, patch(careers));
  app.patch('/api/admin/catalog/specialties/:id', adminOnly, patch(specialties));
  app.patch('/api/admin/catalog/courses/:id', adminOnly, patch(courses));
}
