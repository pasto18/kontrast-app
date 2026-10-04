import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAYS, COCINA_FIJAS, FESTIVAL_YEAR, TAQUILLA, SIN_TAQUILLA } from './config.js';
import { PROGRAMA, REGLAS_TAREAS } from './programa.js';

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
  aptitudes TEXT NOT NULL DEFAULT '',
  por_confirmar INTEGER NOT NULL DEFAULT 0,
  horario TEXT NOT NULL DEFAULT 'indiferente'  -- madrugador | trasnochador | indiferente
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
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  obra TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  discipline TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_companies (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, company_id)
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS task_skills (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, skill_id)
);
CREATE TABLE IF NOT EXISTS person_skills (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, skill_id)
);
CREATE TABLE IF NOT EXISTS assign_unresolved (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accepted_overtime (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,   -- total del día aceptado a propósito (pasa del tope)
  PRIMARY KEY (person_id, date)
);
CREATE TABLE IF NOT EXISTS assignments (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, person_id)
);
`);

// La "disponibilidad" 50/100 de la hoja ya no se usa: solo importa el balance entre grupos.
if (db.prepare("SELECT 1 FROM pragma_table_info('people') WHERE name = 'dispo'").get()) db.exec('ALTER TABLE people DROP COLUMN dispo');

// Horario preferido (bases creadas antes de existir esta condición).
if (!db.prepare("SELECT 1 FROM pragma_table_info('people') WHERE name = 'horario'").get()) db.exec("ALTER TABLE people ADD COLUMN horario TEXT NOT NULL DEFAULT 'indiferente'");

// El equipo "BILLETERÍA" pasa a llamarse TAQUILLA en toda la aplicación.
db.exec("UPDATE people SET equipo = REPLACE(REPLACE(equipo, 'BILLETERÍA', 'TAQUILLA'), 'BILLETERIA', 'TAQUILLA') WHERE equipo LIKE '%BILLETER%'");

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

export function sectoresDe(equipo) {
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
  const insP = db.prepare('INSERT INTO people (nombre, grupo, equipo, sectores, aptitudes, por_confirmar) VALUES (?,?,?,?,?,?)');
  const insA = db.prepare('INSERT INTO availability (person_id, date, present) VALUES (?,?,?)');
  lines.slice(1).forEach((line, idx) => {
    const c = parseCsvLine(line);
    const nombre = (c[0] || '').trim() || `Sin nombre (línea ${idx + 2})`;
    const equipo = (c[2] || '').split(',').map((s) => s.trim().replace(/^BILLETER[IÍ]A$/i, 'TAQUILLA')).filter(Boolean).join(', ');
    const porConfirmar = dateCols.some((d) => /confirmar/i.test(c[d.i] || '')) ? 1 : 0;
    const { lastInsertRowid: id } = insP.run(nombre, (c[1] || '').trim(), equipo, sectoresDe(equipo), (c[aptCol] || '').trim(), porConfirmar);
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

// Tareas de Técnica (dos hojas). Se ignoran las asignaciones de técnicos y voluntarios;
// se conserva el responsable. Las fechas fuera del festival (lunes 20) se omiten.
function seedTecnica() {
  const ins = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed, responsible) VALUES (?,?,?,?,?,?,?,?)');
  for (const file of ['tecnica_1a.csv', 'tecnica_2a.csv']) {
    const lines = fs.readFileSync(path.join(root, 'data', 'seed', file), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    const h = parseCsvLine(lines[0]).map((x) => x.trim());
    const col = (n) => h.indexOf(n);
    const [cDia, cIni, cFin, cDur, cEsp, cResp, cTarea, cVol] =
      ['Dia', 'Hora inicio', 'Hora final', 'Duración', 'Espacio', 'Responsable', 'Tarea', 'Nº voluntarios'].map(col);
    let skipped = 0;
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      if (!c[cDia]?.trim()) continue; // fila vacía
      const day = DAYS.find((d) => d.day === +c[cDia].split('-')[1]);
      const start = normTime(c[cIni]);
      const name = (c[cTarea] || '').trim();
      if (!day || !start || !name) { skipped++; continue; }
      let end = normTime(c[cFin]);
      if (!end) { // final ausente ("-" o vacío): inicio + duración
        const dur = Math.round(parseFloat((c[cDur] || '').replace(',', '.')) * 60);
        const m = (+start.slice(0, 2) * 60 + +start.slice(3) + dur) % 1440;
        end = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      }
      if (end === start) { skipped++; continue; }
      ins.run(day.date, start, end, 'tecnica', (c[cEsp] || '').trim(), name, Math.max(0, parseInt(c[cVol], 10) || 0), (c[cResp] || '').trim());
    }
    if (skipped) console.warn(`Técnica (${file}): ${skipped} filas omitidas (fuera del festival o sin tarea/hora)`);
  }
}

// Aptitudes iniciales (catálogo compartido entre tareas y personas). Del texto libre de la hoja
// solo se migran las dos que lo dicen explícitamente (sonido, luces); el texto original se conserva.
function seedSkills() {
  const ins = db.prepare('INSERT OR IGNORE INTO skills (name) VALUES (?)');
  for (const n of ['Sonido', 'Iluminación', 'Conducción de trailer', 'Rigging', 'Construcción']) ins.run(n);
  const id = (n) => db.prepare('SELECT id FROM skills WHERE name = ?').get(n).id;
  const link = db.prepare('INSERT OR IGNORE INTO person_skills (person_id, skill_id) VALUES (?,?)');
  for (const p of db.prepare("SELECT id, aptitudes FROM people WHERE aptitudes <> ''").all()) {
    if (/sonido/i.test(p.aptitudes)) link.run(p.id, id('Sonido'));
    if (/luces/i.test(p.aptitudes)) link.run(p.id, id('Iluminación'));
  }
}

// Turno de taquilla de un espectáculo: de 1 h antes a 30 min después de su inicio, con el nombre "Taquilla <obra>".
// Se vincula a la compañía del espectáculo. (Se crea una vez por espectáculo; si se borra a mano no reaparece.)
const hhmm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;
export function createTaquilla(show) {
  const m = +show.time.slice(0, 2) * 60 + +show.time.slice(3);
  const id = Number(db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed) VALUES (?,?,?,?,?,?,?)')
    .run(show.date, hhmm(m - TAQUILLA.before), hhmm(m + TAQUILLA.after), 'taquilla', show.venue, `Taquilla ${show.obra}`, TAQUILLA.needed).lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO task_companies (task_id, company_id) VALUES (?,?)').run(id, show.company_id);
  return id;
}
function seedTaquillas() {
  for (const show of db.prepare('SELECT * FROM shows ORDER BY date, time').all()) if (!SIN_TAQUILLA.includes(show.discipline)) createTaquilla(show);
}

// Datos de prueba: reparte al azar (con semilla fija) 40 % trasnochadorx, 30 % madrugadorx y 30 % indiferente.
function seedHorarios() {
  const ids = db.prepare('SELECT id FROM people ORDER BY id').all().map((r) => r.id);
  let x = 20250406; const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const nT = Math.round(ids.length * 0.4), nM = Math.round(ids.length * 0.3);
  const up = db.prepare('UPDATE people SET horario = ? WHERE id = ?');
  ids.forEach((id, i) => up.run(i < nT ? 'trasnochador' : i < nT + nM ? 'madrugador' : 'indiferente', id));
}

const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function suggestCompanies(taskName) {
  const n = norm(taskName);
  return REGLAS_TAREAS.filter(([re]) => re.test(n)).map(([, name]) => name);
}

function seedCompanias() {
  const insC = db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)');
  const getC = db.prepare('SELECT id FROM companies WHERE name = ?');
  const insS = db.prepare('INSERT INTO shows (company_id, obra, date, time, discipline, venue) VALUES (?,?,?,?,?,?)');
  for (const [date, time, obra, company, disc, venue] of PROGRAMA) {
    const name = company || obra;
    insC.run(name);
    insS.run(getC.get(name).id, obra, date, time, disc, venue);
  }
  const link = db.prepare('INSERT OR IGNORE INTO task_companies (task_id, company_id) VALUES (?,?)');
  for (const t of db.prepare("SELECT id, name FROM tasks WHERE area = 'tecnica'").all())
    for (const name of suggestCompanies(t.name)) link.run(t.id, getC.get(name).id);
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
  applySeed('tecnica-v1', seedTecnica);
  applySeed('companias-v1', seedCompanias);
  applySeed('skills-v1', seedSkills);
  applySeed('taquilla-v1', seedTaquillas);
  applySeed('horarios-azar-v1', seedHorarios);
}
