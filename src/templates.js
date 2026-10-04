// Plantillas de tareas recurrentes por espectáculo (taquilla, montaje, desmontaje…).
// Cada plantilla genera una tarea por espectáculo del programa, con horas relativas al inicio de la función.
// Al guardar una plantilla se actualizan todas sus tareas a la vez (también las editadas a mano);
// los voluntarios asignados se conservan.
import { db } from './db.js';

const hhmm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fill = (pattern, show, company) => pattern.replaceAll('{obra}', show.obra).replaceAll('{compania}', company).replace(/\s+/g, ' ').trim();

export function listTemplates() {
  const shows = db.prepare('SELECT discipline FROM shows').all();
  return db.prepare('SELECT * FROM task_templates ORDER BY id').all().map((t) => {
    const excluded = t.exclude_disciplines ? t.exclude_disciplines.split('|') : [];
    return {
      ...t, exclude: excluded,
      skill_ids: db.prepare('SELECT skill_id FROM template_skills WHERE template_id = ?').all(t.id).map((r) => r.skill_id),
      task_count: db.prepare('SELECT COUNT(*) n FROM tasks WHERE template_id = ?').get(t.id).n,
      show_count: shows.filter((s) => !excluded.includes(s.discipline)).length,
    };
  });
}

export function disciplines() {
  return db.prepare('SELECT DISTINCT discipline FROM shows ORDER BY discipline').all().map((r) => r.discipline);
}

// Crea o actualiza las tareas de una plantilla para todos los espectáculos a los que se aplica.
export function applyTemplate(id) {
  const t = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id);
  const excluded = new Set(t.exclude_disciplines ? t.exclude_disciplines.split('|') : []);
  const skillIds = db.prepare('SELECT skill_id FROM template_skills WHERE template_id = ?').all(id).map((r) => r.skill_id);
  const existing = new Map(db.prepare('SELECT * FROM tasks WHERE template_id = ?').all(id).map((x) => [x.show_id, x]));
  const count = (taskId) => db.prepare('SELECT COUNT(*) n FROM assignments WHERE task_id = ?').get(taskId).n;
  const res = { created: 0, updated: 0, deleted: 0, kept: 0, trimmed: 0 };
  const insTask = db.prepare('INSERT INTO tasks (date, start, end, area, space, name, needed, template_id, show_id) VALUES (?,?,?,?,?,?,?,?,?)');
  const updTask = db.prepare('UPDATE tasks SET date=?, start=?, end=?, area=?, space=?, name=?, needed=? WHERE id=?');
  const linkCo = db.prepare('INSERT OR IGNORE INTO task_companies (task_id, company_id) VALUES (?,?)');
  const insSkill = db.prepare('INSERT INTO task_skills (task_id, skill_id) VALUES (?,?)');

  db.exec('BEGIN');
  try {
    for (const show of db.prepare('SELECT s.*, c.name AS company FROM shows s JOIN companies c ON c.id = s.company_id ORDER BY s.date, s.time').all()) {
      const old = existing.get(show.id);
      if (excluded.has(show.discipline)) { // la plantilla ya no se aplica a este espectáculo
        if (old) { if (count(old.id)) { db.prepare('UPDATE tasks SET template_id = NULL, show_id = NULL WHERE id = ?').run(old.id); res.kept++; } else { db.prepare('DELETE FROM tasks WHERE id = ?').run(old.id); res.deleted++; } }
        continue;
      }
      const m = +show.time.slice(0, 2) * 60 + +show.time.slice(3);
      const f = [show.date, hhmm(m + t.start_offset), hhmm(m + t.end_offset), t.area, t.space || show.venue, fill(t.task_name, show, show.company)];
      if (old) {
        const assigned = count(old.id), needed = Math.max(t.needed, assigned); // nunca se quita gente que ya está asignada
        if (needed > t.needed) res.trimmed++;
        updTask.run(...f, needed, old.id);
        db.prepare('DELETE FROM task_skills WHERE task_id = ?').run(old.id);
        for (const s of skillIds) insSkill.run(old.id, s);
        linkCo.run(old.id, show.company_id);
        res.updated++;
      } else {
        const taskId = Number(insTask.run(...f, t.needed, id, show.id).lastInsertRowid);
        for (const s of skillIds) insSkill.run(taskId, s);
        linkCo.run(taskId, show.company_id);
        res.created++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
}
