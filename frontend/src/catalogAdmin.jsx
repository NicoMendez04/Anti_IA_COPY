import { Fragment, useEffect, useState } from 'react';

const COLUMN_NAMES = { carrera: 'career', especialidad: 'specialty', codigo: 'code', ramo: 'course', semestre: 'semester', categoria: 'category' };
const EXAMPLE = 'carrera;especialidad;codigo;ramo;semestre;categoria\nIngeniería Civil Industrial;Matemática;;Cálculo Diferencial;2;Ciencias básicas y/o Transversales';

// Acepta texto pegado desde Excel (tabulaciones) o CSV con ; o , y una fila de encabezados.
function parseRows(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('Pega el encabezado y al menos una fila.');
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const columns = lines[0].split(delimiter).map((name) => COLUMN_NAMES[name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')]);
  if (!columns.includes('specialty') || !columns.includes('course')) throw new Error('El encabezado debe incluir al menos las columnas "especialidad" y "ramo".');
  return lines.slice(1).map((line) => Object.fromEntries(line.split(delimiter).map((value, index) => [columns[index], value.trim()]).filter(([key]) => key)));
}

export function CatalogAdmin({ api }) {
  const [catalog, setCatalog] = useState(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState({ error: '', ok: '' });
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState(false);
  const load = () => api('/api/admin/catalog').then(setCatalog).catch((caught) => setMessage({ error: caught.message, ok: '' }));
  useEffect(() => { load(); }, []);

  async function importText() {
    setMessage({ error: '', ok: '' }); setBusy(true);
    try {
      const result = await api('/api/admin/catalog/import', { method: 'POST', body: JSON.stringify({ rows: parseRows(text) }) });
      setMessage({ error: '', ok: `Importado: ${result.careers} carrera(s), ${result.specialties} áreas y ${result.courses} ramos.` });
      setText(''); await load();
    } catch (caught) { setMessage({ error: caught.message, ok: '' }); } finally { setBusy(false); }
  }
  async function toggle(kind, item) {
    setMessage({ error: '', ok: '' });
    try { await api(`/api/admin/catalog/${kind}/${item.id}`, { method: 'PATCH', body: JSON.stringify({ active: item.active === false }) }); await load(); }
    catch (caught) { setMessage({ error: caught.message, ok: '' }); }
  }

  const coursesOf = (specialtyId) => (catalog?.courses ?? []).filter((course) => course.specialtyIds?.includes(specialtyId));
  return <div>
    <div className="page-kicker">CATÁLOGO DE RAMOS <span>{catalog?.courses?.length ?? 0}</span></div>
    <div className="admin-heading"><h1>Áreas y<br /><em>ramos.</em></h1></div>
    <p className="lede catalog-lede">Las áreas de profesorado agrupan los ramos por disciplina. Cada profesor elige sus áreas en su perfil y solo puede crear sesiones en los ramos de esas áreas.</p>
    {message.error && <p className="error-message">{message.error}</p>}{message.ok && <p className="notice-message">{message.ok}</p>}

    <details className="import-box"><summary>Importar o actualizar la malla</summary>
      <p>Pega las filas desde Excel o un CSV. Un ramo puede repetirse en varias áreas: se une a todas. Columnas: <code>carrera; especialidad; codigo; ramo; semestre; categoria</code>.</p>
      <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
      <button className="button button-dark import-button" type="button" disabled={busy || !text.trim()} onClick={importText}>{busy ? 'Importando…' : 'Importar'} <span>→</span></button>
    </details>

    {!catalog && !message.error && <p className="admin-empty">Cargando…</p>}
    {catalog && <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>Área de profesorado</th><th>Ramos</th><th>Estado</th><th /></tr></thead>
      <tbody>{catalog.specialties.map((specialty) => { const list = coursesOf(specialty.id); return <Fragment key={specialty.id}>
        <tr>
          <td><strong>{specialty.name}</strong></td><td>{list.length}</td>
          <td><span className={`status-pill ${specialty.active === false ? 'status-disabled' : 'status-approved'}`}>{specialty.active === false ? 'Desactivada' : 'Activa'}</span></td>
          <td className="admin-actions"><button type="button" onClick={() => setOpen({ ...open, [specialty.id]: !open[specialty.id] })}>{open[specialty.id] ? 'Ocultar ramos' : 'Ver ramos'}</button><button type="button" onClick={() => toggle('specialties', specialty)}>{specialty.active === false ? 'Activar' : 'Desactivar'}</button></td>
        </tr>
        {open[specialty.id] && <tr className="alert-rows"><td colSpan={4}><ul className="course-list">{list.map((course) => <li key={course.id} className={course.active === false ? 'is-off' : ''}><span>Sem {course.semester ?? '—'}</span> <strong>{course.name}</strong> <em>{course.career}{course.category ? ` · ${course.category}` : ''}</em> <button type="button" className="row-action" onClick={() => toggle('courses', course)}>{course.active === false ? 'Activar' : 'Desactivar'}</button></li>)}</ul></td></tr>}
      </Fragment>; })}</tbody>
    </table>{!catalog.specialties.length && <p className="admin-empty">Aún no hay áreas ni ramos. Importa la malla para empezar.</p>}</div>}
  </div>;
}
