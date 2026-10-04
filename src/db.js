import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAYS, COCINA_FIJAS, FESTIVAL_YEAR } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.DB_PATH || path.join(root, 'data', 'kontrast.db');
const BAR_CSV_PATH = path.join(root, 'data', 'seed', 'bar_tareas.csv');
const CSV_PATH = path.join(root, 'data', 'seed', 'voluntarios.csv');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  grupo TEXT,                 -- VOLUNTARIAS / CASA / SIDE
  equipo TEXT NOT NULL DEFAULT '',   -- CUINA, NETEJA, BAR, TÉCNICA... separados por coma
  sectores TEXT NOT NULL DEFAULT '', -- cocina_bar, tecnica (derivado de equipo)
  dispo INTEGER,              -- 50 / 100
  aptitudes TEXT NOT NULL DEFAULT '',
  por_confirmar INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS availability (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  present INTEGER,            -- 1 está, 0 no está, NULL desconocido / por confirmar
  PRIMARY KEY (person_id, date)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  area TEXT NOT NULL,         -- cocina | bar | tecnica
  space TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  needed INTEGER NOT NULL DEFAULT 1,
  responsible TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_date ON tasks(date, start);
CREATE TABLE IF NOT EXISTS assignments (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, person_id)
);
`);

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const MESES = { abr: '04' };
function headerToDate(h) {
  const m = /^(\d{1,2})-([a-z]{3})$/i.exec(h.trim());
  if (!m || !MESES[m[2].toLowerCase()]) return null;
  return `${FESTIVAL_YEAR}-${MESES[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
}

function sectoresDe(equipo) {
  const s = [];
  if (/CUINA|NETEJA|BAR/.test(equipo)) s.push('cocina_bar');
  if (/TÉCNICA/.test(equipo)) s.push('tecnica');
  return s.join(',');
}

function seedPeople() {
  const lines = fs.readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]);
  const dateCols = header.map((h, i) => ({ i, date: headerToDate(h) })).filter((c) => c.date);
  const aptCol = header.findIndex((h) => h.trim().toLowerCase() === 'aptitudes');
  const insP = db.prepare('INSERT INTO people (nombre, grupo, equipo, sectores, dispo, aptitudes, por_confirmar) VALUES (?,?,?,?,?,?,?)');
  const insA = db.prepare('INSERT INTO availability (person_id, date, present) VALUES (?,?,?)');
  lines.slice(1).forEach((line, idx) => {
    const c = parseCsvLine(line);
    const nombre = (c[0] || '').trim() || `Sin nombre (línea ${idx + 2})`;
    const equipo = (c[2] || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    const dispo = c[3] && !isNaN(+c[3]) ? +c[3] : null;
    const porConfirmar = dateCols.some((d) => /confirmar/i.test(c[d.i] || '')) ? 1 : 0;
    const { lastInsertRowid: id } = insP.run(nombre, (c[1] || '').trim(), equipo, sectoresDe(equipo), dispo, (c[aptCol] || '').trim(), porConfirmar);
    for (const d of dateCols) {
      const v = (c[d.i] || '').trim();
      insA.run(id, d.date, v === '1' ? 1 : v === '0' ? 0 : null);
    }
  });
}

function seedCocina() {
  const ins = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed) VALUES (?,?,?,?,?,?,?)');
  for (const d of DAYS) for (const t of COCINA_FIJAS) ins.run(d.date, t.start, t.end, 'cocina', 'Cocina', t.name, t.needed);
}

// "viernes-10" → fecha del festival; "1:00" / "5" → "01:00" / "05:00"
function normTime(v) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((v || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2] || '00'}` : null;
}

// Tareas de Bar (hoja de 2026 adaptada a las fechas simuladas). Se ignoran las asignaciones.
function seedBar() {
  const lines = fs.readFileSync(BAR_CSV_PATH, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const h = parseCsvLine(lines[0]).map((x) => x.trim());
  const col = (n) => h.indexOf(n);
  const [cDia, cIni, cFin, cEsp, cVol] = ['Dia', 'Hora inicio', 'Hora final', 'BAR', '# VOL'].map(col);
  const ins = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed) VALUES (?,?,?,?,?,?,?)');
  let prev = null;
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const day = DAYS.find((d) => d.day === +c[cDia].split('-')[1]);
    if (!day) { console.warn(`Bar: día no reconocido "${c[cDia]}"`); continue; }
    const end = normTime(c[cFin]);
    // Una hora de inicio rota (#REF!) se completa con el final de la tarea anterior del mismo día.
    let start = normTime(c[cIni]);
    if (!start && prev && prev.date === day.date) { start = prev.end; console.warn(`Bar: ${c[cDia]} sin hora de inicio, se usa ${start}`); }
    if (!start || !end || start === end) { console.warn(`Bar: fila omitida (${line})`); continue; }
    ins.run(day.date, start, end, 'bar', `Bar ${c[cEsp].trim()}`, 'Turno de bar', +c[cVol] || 1);
    prev = { date: day.date, end };
  }
}

// Cada carga inicial se aplica una sola vez (así borrar tareas no las hace reaparecer).
db.exec('CREATE TABLE IF NOT EXISTS seeds (name TEXT PRIMARY KEY)');
function applySeed(name, fn) {
  if (db.prepare('SELECT 1 FROM seeds WHERE name = ?').get(name)) return;
  db.exec('BEGIN');
  try { fn(); db.prepare('INSERT INTO seeds (name) VALUES (?)').run(name); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) n FROM people').get().n === 0) {
    db.exec('BEGIN');
    try { seedPeople(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const hadTasks = db.prepare('SELECT COUNT(*) n FROM tasks').get().n > 0;
  applySeed('cocina-v1', () => { if (!hadTasks) seedCocina(); });
  applySeed('bar-v1', seedBar);
}
