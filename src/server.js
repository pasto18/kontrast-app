import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedIfEmpty, sectoresDe } from './db.js';
import { DAYS, AREAS, AREA_TEAMS, STRICT_AREAS, HORARIOS, MAX_DAILY_MINUTES, capOf } from './config.js';
import { listTemplates, disciplines, applyTemplate } from './templates.js';
import { autoAssign, workload, findConflicts, candidatesFor, range, overlap, durMin } from './assigner.js';

seedIfEmpty();
const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/config', (_req, res) => res.json({ days: DAYS, areas: AREAS, maxMinutes: MAX_DAILY_MINUTES }));

function peopleList() {
  const people = db.prepare('SELECT * FROM people ORDER BY id').all();
  const m = new Map(people.map((p) => [p.id, { ...p, av: {}, skill_ids: [] }]));
  for (const r of db.prepare('SELECT person_id, date, present FROM availability').all()) m.get(r.person_id).av[r.date] = r.present;
  for (const r of db.prepare('SELECT person_id, skill_id FROM person_skills').all()) m.get(r.person_id).skill_ids.push(r.skill_id);
  return [...m.values()];
}
app.get('/api/people', (_req, res) => res.json(peopleList()));

const skillIds = (body) => [...new Set((Array.isArray(body.skill_ids) ? body.skill_ids : []).map(Number))];
const allSkillsExist = (ids) => ids.every((id) => db.prepare('SELECT 1 FROM skills WHERE id = ?').get(id));

app.get('/api/skills', (_req, res) => res.json(db.prepare('SELECT id, name FROM skills ORDER BY id').all()));

const stripAccents = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
app.post('/api/skills', (req, res) => {
  const name = String(req.body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) return bad(res, 'La aptitud necesita un nombre (máx. 40 caracteres)');
  const dup = db.prepare('SELECT id, name FROM skills').all().find((s) => stripAccents(s.name) === stripAccents(name));
  if (dup) return res.json(dup);
  res.status(201).json({ id: Number(db.prepare('INSERT INTO skills (name) VALUES (?)').run(name).lastInsertRowid), name });
});

function readPerson(body) {
  const nombre = String(body.nombre ?? '').trim();
  if (!nombre) return { error: 'La persona necesita un nombre' };
  const equipo = [...new Set((Array.isArray(body.equipo) ? body.equipo : []).map((x) => String(x).trim()).filter(Boolean))].join(', ');
  const av = {};
  for (const d of DAYS) {
    const v = body.av?.[d.date];
    if (v !== undefined) { if (![0, 1, null].includes(v)) return { error: 'Valor de día inválido' }; av[d.date] = v; }
  }
  const ids = skillIds(body);
  if (!allSkillsExist(ids)) return { error: 'Aptitud no encontrada' };
  const horario = body.horario ?? 'indiferente';
  if (!HORARIOS.includes(horario)) return { error: 'Horario inválido' };
  return { p: { nombre, grupo: String(body.grupo ?? '').trim(), equipo, sectores: sectoresDe(equipo),
    aptitudes: String(body.aptitudes ?? '').trim(), por_confirmar: body.por_confirmar ? 1 : 0, horario }, av, ids };
}

function savePersonRelations(id, av, ids) {
  const up = db.prepare('INSERT OR REPLACE INTO availability (person_id, date, present) VALUES (?,?,?)');
  for (const [date, v] of Object.entries(av)) up.run(id, date, v);
  db.prepare('DELETE FROM person_skills WHERE person_id = ?').run(id);
  const ins = db.prepare('INSERT INTO person_skills (person_id, skill_id) VALUES (?,?)');
  for (const sid of ids) ins.run(id, sid);
}

app.post('/api/people', (req, res) => {
  const { p, av, ids, error } = readPerson(req.body);
  if (error) return bad(res, error);
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare('INSERT INTO people (nombre, grupo, equipo, sectores, aptitudes, por_confirmar, horario) VALUES (?,?,?,?,?,?,?)')
      .run(p.nombre, p.grupo, p.equipo, p.sectores, p.aptitudes, p.por_confirmar, p.horario).lastInsertRowid);
    savePersonRelations(id, av, ids);
    db.exec('COMMIT');
    res.status(201).json({ id });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.put('/api/people/:id', (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return bad(res, 'Persona no encontrada', 404);
  const { p, av, ids, error } = readPerson(req.body);
  if (error) return bad(res, error);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE people SET nombre=?, grupo=?, equipo=?, sectores=?, aptitudes=?, por_confirmar=?, horario=? WHERE id=?')
      .run(p.nombre, p.grupo, p.equipo, p.sectores, p.aptitudes, p.por_confirmar, p.horario, id);
    savePersonRelations(id, av, ids);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.delete('/api/people/:id', (req, res) => {
  db.prepare('DELETE FROM people WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

const ORDER = `ORDER BY date, start < '06:00', start, end, id`;

// Añade voluntarios y compañías a cada tarea.
function withRelations(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id), ph = ids.map(() => '?').join(',');
  const by = new Map(tasks.map((t) => [t.id, { ...t, volunteers: [], companies: [], skills: [] }]));
  for (const v of db.prepare(`SELECT a.task_id, p.id, p.nombre FROM assignments a JOIN people p ON p.id = a.person_id
    WHERE a.task_id IN (${ph}) ORDER BY p.nombre`).all(...ids)) by.get(v.task_id).volunteers.push({ id: v.id, nombre: v.nombre });
  for (const c of db.prepare(`SELECT tc.task_id, c.id, c.name FROM task_companies tc JOIN companies c ON c.id = tc.company_id
    WHERE tc.task_id IN (${ph}) ORDER BY c.name`).all(...ids)) by.get(c.task_id).companies.push({ id: c.id, name: c.name });
  for (const k of db.prepare(`SELECT ts.task_id, s.id, s.name FROM task_skills ts JOIN skills s ON s.id = ts.skill_id
    WHERE ts.task_id IN (${ph}) ORDER BY s.id`).all(...ids)) by.get(k.task_id).skills.push({ id: k.id, name: k.name });
  return tasks.map((t) => by.get(t.id));
}

app.get('/api/tasks', (req, res) => {
  const { date } = req.query;
  if (!DAYS.some((d) => d.date === date)) return bad(res, 'Fecha fuera del festival');
  res.json(withRelations(db.prepare(`SELECT * FROM tasks WHERE date = ? ${ORDER}`).all(date)));
});

const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });

app.get('/api/companies', (_req, res) => {
  const shows = db.prepare('SELECT * FROM shows ORDER BY date, time').all();
  const counts = new Map(db.prepare('SELECT company_id, COUNT(*) n FROM task_companies GROUP BY company_id').all().map((r) => [r.company_id, r.n]));
  res.json(db.prepare('SELECT * FROM companies').all().map((c) => ({
    ...c, task_count: counts.get(c.id) || 0, shows: shows.filter((s) => s.company_id === c.id),
  })).sort(byName));
});

app.get('/api/companies/:id/tasks', (req, res) => {
  res.json(withRelations(db.prepare(`SELECT t.* FROM tasks t JOIN task_companies tc ON tc.task_id = t.id
    WHERE tc.company_id = ? ${ORDER.replace(/(date|start|end|id)\b/g, 't.$1')}`).all(+req.params.id)));
});

app.get('/api/people/:id/tasks', (req, res) => {
  res.json(withRelations(db.prepare(`SELECT t.* FROM tasks t JOIN assignments a ON a.task_id = t.id WHERE a.person_id = ?
    ORDER BY t.date, t.start < '06:00', t.start, t.end, t.id`).all(+req.params.id)));
});

app.get('/api/spaces', (_req, res) => {
  res.json(db.prepare(`SELECT space AS name, COUNT(*) task_count, GROUP_CONCAT(DISTINCT area) areas, MIN(date) first_date, MAX(date) last_date
    FROM tasks WHERE space <> '' GROUP BY space`).all().sort(byName).map((r) => ({ ...r, areas: r.areas.split(',') })));
});

app.get('/api/spaces/tasks', (req, res) => {
  res.json(withRelations(db.prepare(`SELECT * FROM tasks WHERE space = ? ${ORDER}`).all(String(req.query.name ?? ''))));
});

function readTask(body) {
  const t = {
    date: body.date, start: body.start, end: body.end, area: body.area,
    space: String(body.space ?? '').trim(), name: String(body.name ?? '').trim(),
    needed: Number(body.needed), responsible: String(body.responsible ?? '').trim(),
  };
  if (!DAYS.some((d) => d.date === t.date)) return { error: 'Fecha fuera del festival' };
  if (!HHMM.test(t.start) || !HHMM.test(t.end)) return { error: 'Hora inválida (HH:MM)' };
  if (t.end === t.start) return { error: 'La hora final no puede coincidir con la de inicio' };
  if (!AREAS[t.area]) return { error: 'Área inválida' };
  if (!t.name) return { error: 'La tarea necesita un nombre' };
  if (!Number.isInteger(t.needed) || t.needed < 0 || t.needed > 99) return { error: 'Voluntarios necesarios: entero entre 0 y 99' };
  const ids = [...new Set((Array.isArray(body.company_ids) ? body.company_ids : []).map(Number))];
  if (ids.some((id) => !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id))) return { error: 'Compañía no encontrada' };
  const sk = skillIds(body);
  if (!allSkillsExist(sk)) return { error: 'Aptitud no encontrada' };
  return { t, ids, sk };
}

function setSkills(taskId, ids) {
  db.prepare('DELETE FROM task_skills WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT INTO task_skills (task_id, skill_id) VALUES (?,?)');
  for (const id of ids) ins.run(taskId, id);
}

function setCompanies(taskId, ids) {
  db.prepare('DELETE FROM task_companies WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT INTO task_companies (task_id, company_id) VALUES (?,?)');
  for (const id of ids) ins.run(taskId, id);
}

app.post('/api/tasks', (req, res) => {
  const { t, ids, sk, error } = readTask(req.body);
  if (error) return bad(res, error);
  const dates = req.body.repeatAllDays ? DAYS.map((d) => d.date) : [t.date];
  const ins = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed, responsible) VALUES (?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const date of dates) {
      const id = ins.run(date, t.start, t.end, t.area, t.space, t.name, t.needed, t.responsible).lastInsertRowid;
      setCompanies(id, ids); setSkills(id, sk);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json({ created: dates.length });
});

app.put('/api/tasks/:id', (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) return bad(res, 'Tarea no encontrada', 404);
  const { t, ids, sk, error } = readTask(req.body);
  if (error) return bad(res, error);
  const n = db.prepare('SELECT COUNT(*) n FROM assignments WHERE task_id = ?').get(id).n;
  if (t.needed < n) return bad(res, `Ya hay ${n} voluntarios asignados; quita alguno antes de bajar la cantidad`, 409);
  db.prepare('UPDATE tasks SET date=?, start=?, end=?, area=?, space=?, name=?, needed=?, responsible=? WHERE id=?')
    .run(t.date, t.start, t.end, t.area, t.space, t.name, t.needed, t.responsible, id);
  setCompanies(id, ids);
  setSkills(id, sk);
  res.json({ ok: true });
});

// Duplica una tarea (sin voluntarios asignados); queda justo debajo del original en el orden de la tabla.
app.post('/api/tasks/:id/duplicate', (req, res) => {
  const src = db.prepare('SELECT * FROM tasks WHERE id = ?').get(+req.params.id);
  if (!src) return bad(res, 'Tarea no encontrada', 404);
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed, responsible) VALUES (?,?,?,?,?,?,?,?)')
      .run(src.date, src.start, src.end, src.area, src.space, src.name, src.needed, src.responsible).lastInsertRowid);
    db.prepare('INSERT INTO task_companies (task_id, company_id) SELECT ?, company_id FROM task_companies WHERE task_id = ?').run(id, src.id);
    db.prepare('INSERT INTO task_skills (task_id, skill_id) SELECT ?, skill_id FROM task_skills WHERE task_id = ?').run(id, src.id);
    db.exec('COMMIT');
    res.status(201).json({ id });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/volunteers', (req, res) => {
  const id = +req.params.id, pid = +req.body.person_id;
  const task = db.prepare('SELECT needed FROM tasks WHERE id = ?').get(id);
  if (!task) return bad(res, 'Tarea no encontrada', 404);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(pid)) return bad(res, 'Persona no encontrada', 404);
  const n = db.prepare('SELECT COUNT(*) n FROM assignments WHERE task_id = ?').get(id).n;
  if (n >= task.needed) return bad(res, 'La tarea ya tiene todos los voluntarios necesarios', 409);
  const strict = strictError(id, pid);
  if (strict) return bad(res, strict, 409);
  db.prepare('INSERT OR IGNORE INTO assignments (task_id, person_id) VALUES (?,?)').run(id, pid);
  // "Resolver" desde Conflictos: se acepta a propósito que la persona pase del tope de horas ese día.
  if (req.body.accept_overtime) {
    const t = db.prepare('SELECT date FROM tasks WHERE id = ?').get(id);
    const mins = db.prepare('SELECT t.start, t.end FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.person_id = ? AND t.date = ?').all(pid, t.date)
      .reduce((n, r) => n + durMin(r), 0);
    const cap = capOf((db.prepare('SELECT equipo FROM people WHERE id = ?').get(pid)?.equipo ?? '').split(',').map((e) => e.trim()));
    if (mins > cap) db.prepare('INSERT OR REPLACE INTO accepted_overtime (person_id, date, minutes) VALUES (?,?,?)').run(pid, t.date, mins);
  }
  res.status(201).json({ ok: true });
});

app.delete('/api/tasks/:id/volunteers/:pid', (req, res) => {
  db.prepare('DELETE FROM assignments WHERE task_id = ? AND person_id = ?').run(+req.params.id, +req.params.pid);
  res.json({ ok: true });
});

// Áreas estrictas (taquilla): solo personas del equipo correspondiente.
function strictError(taskId, personId) {
  const t = db.prepare('SELECT area, name FROM tasks WHERE id = ?').get(taskId);
  if (!t || !STRICT_AREAS.includes(t.area)) return null;
  const p = db.prepare('SELECT nombre, equipo FROM people WHERE id = ?').get(personId);
  const ok = AREA_TEAMS[t.area].some((x) => p.equipo.split(',').map((e) => e.trim()).includes(x));
  return ok ? null : `"${t.name}" solo admite personas del equipo ${AREA_TEAMS[t.area].join('/')} (${p.nombre} no lo es)`;
}

// Avisos (no bloqueantes) tras colocar a una persona en una tarea a mano.
function assignmentWarnings(personId, taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const p = db.prepare('SELECT nombre, equipo FROM people WHERE id = ?').get(personId);
  const out = [];
  const present = db.prepare('SELECT present FROM availability WHERE person_id = ? AND date = ?').get(personId, t.date)?.present;
  if (present === 0) out.push(`${p.nombre} figura como ausente ese día`);
  if (!AREA_TEAMS[t.area].some((x) => p.equipo.split(',').map((e) => e.trim()).includes(x))) out.push(`${p.nombre} no es del equipo de ${AREAS[t.area]}`);
  const mine = db.prepare('SELECT t.* FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.person_id = ? AND t.date = ?').all(personId, t.date);
  for (const o of mine) if (o.id !== t.id && overlap(range(o), range(t))) out.push(`${p.nombre} se solapa con "${o.name}" (${o.start}–${o.end})`);
  const mins = mine.reduce((n, o) => n + durMin(o), 0);
  const cap = capOf(p.equipo.split(',').map((e) => e.trim()));
  if (mins > cap) out.push(`${p.nombre} pasa a trabajar ${(mins / 60).toString().replace('.', ',')} h ese día (tope ${cap / 60} h)`);
  return out;
}

// Intercambia dos voluntarios entre dos tareas distintas.
app.post('/api/assignments/swap', (req, res) => {
  const [ta, pa, tb, pb] = ['task_a', 'person_a', 'task_b', 'person_b'].map((k) => +req.body[k]);
  if (ta === tb) return bad(res, 'Elige nombres de tareas distintas');
  const has = (t, p) => !!db.prepare('SELECT 1 FROM assignments WHERE task_id = ? AND person_id = ?').get(t, p);
  if (!has(ta, pa) || !has(tb, pb)) return bad(res, 'Esa asignación ya no existe; la tabla se ha recargado', 409);
  if (has(tb, pa) || has(ta, pb)) return bad(res, 'Una de las dos personas ya está en la otra tarea', 409);
  const strict = strictError(tb, pa) || strictError(ta, pb);
  if (strict) return bad(res, strict, 409);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM assignments WHERE (task_id = ? AND person_id = ?) OR (task_id = ? AND person_id = ?)').run(ta, pa, tb, pb);
    const ins = db.prepare('INSERT INTO assignments (task_id, person_id) VALUES (?,?)');
    ins.run(tb, pa); ins.run(ta, pb);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, warnings: [...assignmentWarnings(pa, tb), ...assignmentWarnings(pb, ta)] });
});

// Conflictos: tareas que el asignador dejó sin cubrir (y siguen sin cubrir) + problemas en las asignaciones.
app.get('/api/conflicts', (_req, res) => {
  const unresolved = db.prepare(`SELECT t.id AS task_id, t.date, t.start, t.end, t.area, t.name, t.space, u.reason,
      t.needed - (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id) AS missing
    FROM assign_unresolved u JOIN tasks t ON t.id = u.task_id
    WHERE t.needed > (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id)
    ORDER BY t.date, t.start < '06:00', t.start`).all();
  const assignments = findConflicts();
  res.json({ unresolved, assignments, total: unresolved.length + assignments.length });
});

app.get('/api/tasks/:id/candidates', (req, res) => {
  const r = candidatesFor(+req.params.id);
  if (!r) return bad(res, 'Tarea no encontrada', 404);
  res.json(r);
});

// ---- Plantillas de tareas por espectáculo ----
function readTemplate(body) {
  const t = {
    name: String(body.name ?? '').trim(), task_name: String(body.task_name ?? '').trim(), area: body.area,
    start_offset: Number(body.start_offset), end_offset: Number(body.end_offset), needed: Number(body.needed),
    space: String(body.space ?? '').trim(),
    exclude: (Array.isArray(body.exclude) ? body.exclude : []).map((x) => String(x).trim()).filter(Boolean),
  };
  if (!t.name) return { error: 'La plantilla necesita un nombre' };
  if (!t.task_name) return { error: 'Indica cómo se llamarán las tareas (por ejemplo "Montaje {obra}")' };
  if (!AREAS[t.area]) return { error: 'Área inválida' };
  if (![t.start_offset, t.end_offset].every((n) => Number.isInteger(n) && Math.abs(n) <= 1440)) return { error: 'Los minutos deben ser números enteros' };
  if (t.end_offset <= t.start_offset) return { error: 'La tarea debe terminar después de empezar' };
  if (t.end_offset - t.start_offset >= 1440) return { error: 'La tarea no puede durar un día entero' };
  if (!Number.isInteger(t.needed) || t.needed < 0 || t.needed > 99) return { error: 'Voluntarios necesarios: entero entre 0 y 99' };
  const ids = skillIds(body);
  if (!allSkillsExist(ids)) return { error: 'Aptitud no encontrada' };
  return { t, ids };
}
function saveTemplate(id, t, ids) {
  const vals = [t.name, t.task_name, t.area, t.start_offset, t.end_offset, t.needed, t.space, t.exclude.join('|')];
  if (id) db.prepare('UPDATE task_templates SET name=?, task_name=?, area=?, start_offset=?, end_offset=?, needed=?, space=?, exclude_disciplines=? WHERE id=?').run(...vals, id);
  else id = Number(db.prepare('INSERT INTO task_templates (name, task_name, area, start_offset, end_offset, needed, space, exclude_disciplines) VALUES (?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
  db.prepare('DELETE FROM template_skills WHERE template_id = ?').run(id);
  for (const s of ids) db.prepare('INSERT INTO template_skills (template_id, skill_id) VALUES (?,?)').run(id, s);
  return id;
}
app.get('/api/templates', (_req, res) => res.json({ templates: listTemplates(), disciplines: disciplines() }));
app.post('/api/templates', (req, res) => {
  const { t, ids, error } = readTemplate(req.body);
  if (error) return bad(res, error);
  const id = saveTemplate(null, t, ids);
  res.status(201).json({ id, result: applyTemplate(id) });
});
app.put('/api/templates/:id', (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM task_templates WHERE id = ?').get(id)) return bad(res, 'Plantilla no encontrada', 404);
  const { t, ids, error } = readTemplate(req.body);
  if (error) return bad(res, error);
  saveTemplate(id, t, ids);
  res.json({ id, result: applyTemplate(id) });
});
// Eliminar una plantilla conserva sus tareas actuales como tareas sueltas.
app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM task_templates WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

app.get('/api/workload', (_req, res) => res.json(workload()));

app.post('/api/assign', (req, res) => {
  const { scope, date, replace } = req.body;
  const areas = Array.isArray(req.body.areas) ? req.body.areas.filter((a) => AREAS[a]) : [];
  if (!areas.length) return bad(res, 'Elige al menos un área');
  if (scope === 'day' && !DAYS.some((d) => d.date === date)) return bad(res, 'Fecha fuera del festival');
  const dates = scope === 'all' ? DAYS.map((d) => d.date) : [date];
  res.json({ ...autoAssign({ dates, areas, replace: !!replace }), days: dates.length });
});

app.use((err, _req, res, _next) => { console.error(err); bad(res, 'Error interno', 500); });

const port = process.env.PORT || 3300;
app.listen(port, () => console.log(`Kontrast app en http://localhost:${port}`));
