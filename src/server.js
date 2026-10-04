import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedIfEmpty } from './db.js';
import { DAYS, AREAS } from './config.js';

seedIfEmpty();
const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/config', (_req, res) => res.json({ days: DAYS, areas: AREAS }));

app.get('/api/people', (_req, res) => {
  const people = db.prepare('SELECT * FROM people ORDER BY id').all();
  const av = new Map(people.map((p) => [p.id, {}]));
  for (const r of db.prepare('SELECT person_id, date, present FROM availability').all()) av.get(r.person_id)[r.date] = r.present;
  res.json(people.map((p) => ({ ...p, av: av.get(p.id) })));
});

app.get('/api/tasks', (req, res) => {
  const { date } = req.query;
  if (!DAYS.some((d) => d.date === date)) return bad(res, 'Fecha fuera del festival');
  const tasks = db.prepare(`SELECT * FROM tasks WHERE date = ? ORDER BY start < '06:00', start, end, id`).all(date);
  const vols = db.prepare(`SELECT a.task_id, p.id, p.nombre FROM assignments a JOIN people p ON p.id = a.person_id
    JOIN tasks t ON t.id = a.task_id WHERE t.date = ? ORDER BY p.nombre`).all(date);
  const by = new Map(tasks.map((t) => [t.id, []]));
  for (const v of vols) by.get(v.task_id).push({ id: v.id, nombre: v.nombre });
  res.json(tasks.map((t) => ({ ...t, volunteers: by.get(t.id) })));
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
  if (!Number.isInteger(t.needed) || t.needed < 1 || t.needed > 99) return { error: 'Voluntarios necesarios: entero entre 1 y 99' };
  return { t };
}

app.post('/api/tasks', (req, res) => {
  const { t, error } = readTask(req.body);
  if (error) return bad(res, error);
  const dates = req.body.repeatAllDays ? DAYS.map((d) => d.date) : [t.date];
  const ins = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed, responsible) VALUES (?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const date of dates) ins.run(date, t.start, t.end, t.area, t.space, t.name, t.needed, t.responsible);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json({ created: dates.length });
});

app.put('/api/tasks/:id', (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) return bad(res, 'Tarea no encontrada', 404);
  const { t, error } = readTask(req.body);
  if (error) return bad(res, error);
  const n = db.prepare('SELECT COUNT(*) n FROM assignments WHERE task_id = ?').get(id).n;
  if (t.needed < n) return bad(res, `Ya hay ${n} voluntarios asignados; quita alguno antes de bajar la cantidad`, 409);
  db.prepare('UPDATE tasks SET date=?, start=?, end=?, area=?, space=?, name=?, needed=?, responsible=? WHERE id=?')
    .run(t.date, t.start, t.end, t.area, t.space, t.name, t.needed, t.responsible, id);
  res.json({ ok: true });
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
  db.prepare('INSERT OR IGNORE INTO assignments (task_id, person_id) VALUES (?,?)').run(id, pid);
  res.status(201).json({ ok: true });
});

app.delete('/api/tasks/:id/volunteers/:pid', (req, res) => {
  db.prepare('DELETE FROM assignments WHERE task_id = ? AND person_id = ?').run(+req.params.id, +req.params.pid);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => { console.error(err); bad(res, 'Error interno', 500); });

const port = process.env.PORT || 3300;
app.listen(port, () => console.log(`Kontrast app en http://localhost:${port}`));
