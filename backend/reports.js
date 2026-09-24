import ExcelJS from 'exceljs';

const TIMEZONE = process.env.REPORT_TIMEZONE ?? 'America/Santiago';
const DATE_FORMAT = 'dd-mm-yyyy hh:mm:ss';

const REVIEW_LABELS = { '': 'Sin revisar', clear: 'Sin observaciones', suspicious: 'Sospechoso', annulled: 'Anulado' };
const EXAM_STATUS = { waiting: 'En espera', active: 'En curso', ended: 'Finalizado' };
const STUDENT_STATUS = { active: 'Conectado', offline: 'Desconectado', expelled: 'Expulsado' };
const ALERT_LABELS = { tab_switch: 'Cambio de pestaña', window_blur: 'Pérdida de foco', screen_lock: 'Pantalla oculta o bloqueada', disconnected: 'Desconexión', reconnected: 'Reconexión', second_device: 'Otro dispositivo', auto_expelled: 'Expulsión automática', copy: 'Copiar', cut: 'Cortar', paste: 'Pegar', context_menu: 'Menú contextual', print: 'Imprimir', screenshot_key: 'Captura de pantalla', shortcut: 'Atajo de teclado', returned: 'Volvió a la pantalla', orientation_change: 'Giro de pantalla', idle: 'Sin interacción', other: 'Otra actividad' };
const SEVERITY_LABELS = { info: 'Informativa', warning: 'Advertencia', critical: 'Crítica' };
const CATEGORY_LABELS = { session: 'Sesión', presence: 'Presencia', alert: 'Alertas', help: 'Ayuda', moderation: 'Moderación', review: 'Revisión' };
const EVENT_LABELS = {
  session_created: 'Sesión creada', session_started: 'Examen iniciado', session_ended: 'Examen finalizado',
  student_joined: 'Alumno ingresó', student_left: 'Alumno salió', student_reconnected: 'Alumno volvió', student_replaced: 'Sesión abierta en otro dispositivo',
  alert: 'Alerta', help_requested: 'Pidió ayuda', help_cancelled: 'Canceló su pedido de ayuda', help_resolved: 'Ayuda atendida',
  student_expelled: 'Alumno expulsado', student_readmitted: 'Alumno readmitido', late_join_toggled: 'Ingreso tardío', review_set: 'Revisión del profesor', notes_updated: 'Notas del examen actualizadas',
  record_archived: 'Registro archivado', report_exported: 'Informe exportado'
};

// Excel no guarda zona horaria: se escribe la hora local como si fuera UTC para que se lea igual en la hoja.
function localDate(iso) {
  if (!iso) return null;
  const wallClock = new Date(iso).toLocaleString('sv-SE', { timeZone: TIMEZONE });
  return new Date(`${wallClock.replace(' ', 'T')}Z`);
}

const formatSeconds = (seconds) => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);
const formatClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-CL', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }) : '');

function describeEvent({ type, data }) {
  const info = data ?? {};
  switch (type) {
    case 'session_created': return `${info.examName} · ${info.duration} min`;
    case 'session_started': return info.endsAt ? `Termina a las ${formatClock(info.endsAt)}` : '';
    case 'session_ended': return info.reason === 'time_expired' ? 'Se cumplió el tiempo' : 'Cerrado por el profesor';
    case 'student_joined': return info.sessionStatus === 'active' ? 'Con el examen en curso' : 'Antes del inicio';
    case 'student_left': return info.sessionStatus === 'active' ? 'Durante el examen' : 'Antes del inicio o tras el cierre';
    case 'student_reconnected': return `Tras ${formatSeconds(info.awaySeconds ?? 0)} desconectado`;
    case 'alert': return `${ALERT_LABELS[info.alertType] ?? info.alertType} · ${info.message ?? ''}`;
    case 'student_expelled': return info.reason === 'max_alerts' ? `Límite de avisos alcanzado (${info.strikes})` : 'Decisión del profesor';
    case 'student_readmitted': return `Readmitido con el cupo completo (tenía ${info.previousStrikes} avisos)`;
    case 'late_join_toggled': return info.allow ? 'Habilitado' : 'Deshabilitado';
    case 'help_resolved': return `Esperó ${formatSeconds(info.waitedSeconds ?? 0)}`;
    case 'review_set': return `${REVIEW_LABELS[info.status ?? ''] ?? info.status}${info.note ? ` · ${info.note}` : ''}`;
    case 'notes_updated': return info.notes ? `"${info.notes}"` : 'Notas vaciadas';
    default: return '';
  }
}

function addTable(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(({ header, width, dates }) => ({ header, width, style: dates ? { numFmt: DATE_FORMAT } : {} }));
  sheet.addRows(rows);
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF191918' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

/** Arma el informe de un examen. `profiles` es un mapa uid -> ficha del usuario (carrera, matrícula). */
export async function buildExamReport({ exam, events, profiles }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vigía';
  workbook.created = new Date();

  const students = exam.students ?? [];
  const alerts = [...(exam.alerts ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reviews = exam.reviews ?? {};
  const stats = exam.stats ?? {};
  const reviewCount = (status) => Object.values(reviews).filter((review) => review.status === status).length;
  const reviewed = Object.values(reviews).filter((review) => review.status).length;

  // --- Resumen
  const summary = workbook.addWorksheet('Resumen');
  summary.columns = [{ width: 34 }, { width: 46 }];
  const facts = [
    ['Examen', exam.examName], ['Descripción', exam.description ?? ''], ['Ramo', exam.courseName ?? ''], ['Tipo de ramo', exam.courseCustom ? 'Personalizado' : exam.courseName ? 'De la malla' : ''], ['Código del ramo', exam.courseCode ?? ''], ['Carrera', exam.career ?? ''],
    ['Semestre del ramo', exam.courseSemester ?? ''], ['Categoría del ramo', exam.courseCategory ?? ''], ['Áreas del profesor', (exam.specialtyNames ?? []).join(', ')],
    ['Profesor', exam.professorName], ['Correo del profesor', exam.professorEmail],
    ['Estado', EXAM_STATUS[exam.status] ?? exam.status], ['Creado', localDate(exam.createdAt)], ['Inicio', localDate(exam.startedAt)], ['Fin', localDate(exam.endedAt)],
    ['Duración configurada (min)', exam.duration], ['Duración real', stats.durationSeconds != null ? formatSeconds(stats.durationSeconds) : ''],
    ['Alumnos', students.length], ['Alertas registradas', alerts.length], ['Alumnos expulsados', stats.expelledCount ?? 0],
    ['Ayudas solicitadas', stats.helpRequested ?? 0], ['Ayudas atendidas', stats.helpResolved ?? 0],
    ['Revisados', reviewed], ['Sin observaciones', reviewCount('clear')], ['Sospechosos', reviewCount('suspicious')], ['Anulados', reviewCount('annulled')], ['Sin revisar', students.length - reviewed],
    ['Notas del examen', exam.notes ?? '']
  ];
  summary.addRow(['Informe de examen']).font = { bold: true, size: 16 };
  summary.addRow([]);
  for (const row of facts) {
    const added = summary.addRow(row);
    added.getCell(1).font = { bold: true };
    if (row[1] instanceof Date) added.getCell(2).numFmt = DATE_FORMAT;
    added.getCell(2).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
  }
  summary.addRow([]);
  const byTypeHeader = summary.addRow(['Alertas por tipo', 'Cantidad']);
  byTypeHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  byTypeHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF191918' } };
  for (const [type, count] of Object.entries(stats.alertsByType ?? {})) summary.addRow([ALERT_LABELS[type] ?? type, count]).getCell(2).alignment = { horizontal: 'left' };

  // --- Alumnos
  const alertsOf = (studentId) => alerts.filter((alert) => alert.studentId === studentId);
  addTable(workbook, 'Alumnos', [
    { header: 'Alumno', width: 28 }, { header: 'RUT', width: 14 }, { header: 'Correo', width: 32 }, { header: 'Acceso', width: 12 }, { header: 'Carrera', width: 24 }, { header: 'Matrícula', width: 14 },
    { header: 'Ingreso', width: 20, dates: true }, { header: 'Última salida', width: 20, dates: true }, { header: 'Estado', width: 14 }, { header: 'Motivo de expulsión', width: 22 }, { header: 'Avisos', width: 9 },
    { header: 'Alertas', width: 10 }, { header: 'Desconexiones', width: 15 }, { header: 'Reconexiones', width: 14 }, { header: 'Tiempo fuera', width: 14 }, { header: 'Revisión', width: 18 }, { header: 'Nota de revisión', width: 40 }
  ], students.map((student) => {
    const profile = profiles?.[student.uid] ?? {};
    const review = reviews[student.studentId] ?? {};
    const own = alertsOf(student.studentId);
    return [student.name, student.rut ?? '', student.email, student.guest ? 'Invitado' : 'Cuenta', profile.career ?? '', profile.studentId ?? '', localDate(student.joinedAt), localDate(student.leftAt), STUDENT_STATUS[student.status] ?? student.status, student.status === 'expelled' ? (student.expelledReason === 'max_alerts' ? 'Límite de avisos' : 'Profesor') : '', student.strikes ?? 0, own.length, own.filter((alert) => alert.type === 'disconnected').length, student.reconnectCount ?? 0, formatSeconds(student.awaySeconds ?? 0), REVIEW_LABELS[review.status ?? ''], review.note ?? ''];
  }));

  // --- Alertas
  addTable(workbook, 'Alertas', [
    { header: 'Fecha y hora', width: 20, dates: true }, { header: 'Alumno', width: 28 }, { header: 'RUT', width: 14 }, { header: 'Tipo', width: 28 }, { header: 'Gravedad', width: 14 }, { header: 'Detalle', width: 60 }
  ], alerts.map((alert) => [localDate(alert.timestamp), alert.studentName, students.find((student) => student.studentId === alert.studentId)?.rut ?? '', ALERT_LABELS[alert.type] ?? alert.type, SEVERITY_LABELS[alert.severity] ?? '', alert.message]));

  // --- Historial completo
  const rutOf = (studentId) => students.find((student) => student.studentId === studentId)?.rut ?? '';
  const emailOf = (studentId) => students.find((student) => student.studentId === studentId)?.email ?? '';
  addTable(workbook, 'Historial', [
    { header: 'Fecha y hora', width: 20, dates: true }, { header: 'Categoría', width: 14 }, { header: 'Evento', width: 34 }, { header: 'Alumno', width: 26 },
    { header: 'RUT', width: 14 }, { header: 'Correo del alumno', width: 30 }, { header: 'Responsable', width: 30 }, { header: 'Detalle', width: 60 }
  ], events.map((event) => [localDate(event.at), CATEGORY_LABELS[event.category] ?? event.category, EVENT_LABELS[event.type] ?? event.type, event.studentName ?? '', rutOf(event.studentId), emailOf(event.studentId), event.actor?.email ?? '', describeEvent(event)]));

  return workbook.xlsx.writeBuffer();
}
