// Carga una malla en Firestore desde un CSV separado por ";" con las columnas:
//   carrera;especialidad;codigo;ramo;semestre;categoria
// Uso: node scripts/import-catalog.mjs seed/ingenieria-civil-industrial.csv
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { importCatalogRows } from '../catalog.js';

const file = process.argv[2];
if (!file) {
  console.error('Indica el archivo CSV. Ej: node scripts/import-catalog.mjs seed/ingenieria-civil-industrial.csv');
  process.exit(1);
}

const [header, ...lines] = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
const columns = header.split(';').map((name) => name.trim().toLowerCase());
const field = (values, name) => values[columns.indexOf(name)]?.trim() ?? '';
const rows = lines.map((line) => {
  const values = line.split(';');
  return { career: field(values, 'carrera'), specialty: field(values, 'especialidad'), code: field(values, 'codigo'), course: field(values, 'ramo'), semester: field(values, 'semestre'), category: field(values, 'categoria') };
});

const result = await importCatalogRows(rows);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
console.log(`Importado: ${result.careers} carrera(s), ${result.specialties} áreas, ${result.courses} ramos (${result.rows} filas).`);
process.exit(0);
