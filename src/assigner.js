// Asignador automático de voluntarios.
// 1) Tareas que piden aptitudes: se cubren primero, solo con personas que tengan alguna de ellas.
// 2) Resto de tareas: cualquier persona del equipo que corresponda al área.
// Siempre: la persona está ese día, es del equipo del área, no se solapa con otra tarea suya
// y no supera MAX_DAILY_MINUTES de trabajo ese día. Lo que no se pueda cubrir se deja vacío.
import { db } from './db.js';
import { AREA_TEAMS, MAX_DAILY_MINUTES as CAP } from './config.js';

const NIGHT = 360; // los turnos que empiezan antes de las 06:00 son madrugada del día siguiente
const toMin = (h) => +h.slice(0, 2) * 60 + +h.slice(3);
export const durMin = (t) => (toMin(t.end) - toMin(t.start) + 1440) % 1440;
const range = (t) => { const s0 = toMin(t.start), s = s0 < NIGHT ? s0 + 1440 : s0; return [s, s + durMin(t)]; };
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];

function loadPeople() {
  const people = new Map(db.prepare('SELECT id, nombre, equipo, dispo FROM people').all().map((p) => [p.id, {
    id: p.id, nombre: p.nombre, dispo: p.dispo ?? 0, av: {}, skills: new Set(),
    teams: new Set(p.equipo.split(',').map((x) => x.trim()).filter(Boolean)),
  }]));
  for (const r of db.prepare('SELECT person_id, date, present FROM availability').all()) people.get(r.person_id).av[r.date] = r.present;
  for (const r of db.prepare('SELECT person_id, skill_id FROM person_skills').all()) people.get(r.person_id).skills.add(r.skill_id);
  return [...people.values()];
}

export function autoAssign({ dates, areas, replace }) {
  const people = loadPeople();
  const byId = new Map(people.map((p) => [p.id, p]));
  const skillNames = new Map(db.prepare('SELECT id, name FROM skills').all().map((s) => [s.id, s.name]));
  const result = { assigned: 0, unresolved: [], unresolved_slots: 0 };
  const insert = db.prepare('INSERT OR IGNORE INTO assignments (task_id, person_id) VALUES (?,?)');

  db.exec('BEGIN');
  try {
    for (const date of dates) {
      const tasks = db.prepare('SELECT * FROM tasks WHERE date = ?').all(date);
      if (replace) {
        const del = db.prepare('DELETE FROM assignments WHERE task_id = ?');
        for (const t of tasks) if (areas.includes(t.area)) del.run(t.id);
      }
      const assigned = new Map(tasks.map((t) => [t.id, new Set()]));
      for (const r of db.prepare('SELECT a.task_id, a.person_id FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.date = ?').all(date)) assigned.get(r.task_id).add(r.person_id);
      const taskSkills = new Map(tasks.map((t) => [t.id, []]));
      for (const r of db.prepare('SELECT ts.task_id, ts.skill_id FROM task_skills ts JOIN tasks t ON t.id = ts.task_id WHERE t.date = ?').all(date)) taskSkills.get(r.task_id).push(r.skill_id);

      // Horas y huecos de cada persona ese día, contando lo que ya tiene asignado (de cualquier área).
      const load = new Map(), busy = new Map();
      const book = (pid, t) => { load.set(pid, (load.get(pid) || 0) + durMin(t)); (busy.get(pid) || busy.set(pid, []).get(pid)).push(range(t)); };
      for (const t of tasks) for (const pid of assigned.get(t.id)) book(pid, t);

      const cts = tasks.filter((t) => areas.includes(t.area)).map((t) => ({
        t, dur: durMin(t), range: range(t), skills: taskSkills.get(t.id), who: assigned.get(t.id), missing: t.needed - assigned.get(t.id).size,
        pool: people.filter((p) => p.av[date] === 1 && AREA_TEAMS[t.area].some((x) => p.teams.has(x))),
      })).filter((c) => c.missing > 0);
      for (const c of cts) if (c.skills.length) c.pool = c.pool.filter((p) => c.skills.some((s) => p.skills.has(s)));

      const eligible = (p, c) => !c.who.has(p.id) && (load.get(p.id) || 0) + c.dur <= CAP
        && !(busy.get(p.id) || []).some((r) => overlap(r, c.range));
      const give = (p, c) => { insert.run(c.t.id, p.id); c.who.add(p.id); c.missing--; book(p.id, c.t); result.assigned++; };
      const lo = (p) => load.get(p.id) || 0;

      // Fase 1: tareas con aptitudes (las más difíciles primero). Se intenta cubrir cada aptitud pedida.
      const phase1 = cts.filter((c) => c.skills.length).sort((a, b) => a.pool.length - b.pool.length || a.range[0] - b.range[0]);
      for (const c of phase1) {
        while (c.missing > 0) {
          const covered = new Set([...c.who].flatMap((pid) => [...byId.get(pid).skills]));
          const score = (p) => c.skills.filter((s) => p.skills.has(s)).length + 10 * c.skills.filter((s) => p.skills.has(s) && !covered.has(s)).length;
          const best = c.pool.filter((p) => eligible(p, c))
            .sort((a, b) => score(b) - score(a) || lo(a) - lo(b) || b.dispo - a.dispo || a.id - b.id)[0];
          if (!best) break;
          give(best, c);
        }
      }
      // Fase 2: tareas sin aptitudes. Primero las que tienen menos gente posible; se reparte la carga.
      const phase2 = cts.filter((c) => !c.skills.length).sort((a, b) => a.pool.length - b.pool.length || a.range[0] - b.range[0]);
      for (const c of phase2) {
        while (c.missing > 0) {
          const best = c.pool.filter((p) => eligible(p, c))
            .sort((a, b) => lo(a) - lo(b) || a.teams.size - b.teams.size || b.dispo - a.dispo || a.id - b.id)[0];
          if (!best) break;
          give(best, c);
        }
      }

      for (const c of cts.filter((x) => x.missing > 0)) {
        let reason;
        const inTeam = people.filter((p) => p.av[date] === 1 && AREA_TEAMS[c.t.area].some((x) => p.teams.has(x)) && !c.who.has(p.id));
        if (c.dur > CAP) reason = `dura más de ${CAP / 60} h`;
        else if (!inTeam.length) reason = 'nadie del equipo disponible ese día';
        else if (c.skills.length && !c.pool.length) reason = `nadie disponible con la aptitud (${c.skills.map((s) => skillNames.get(s)).join(', ')})`;
        else if (c.pool.every((p) => (load.get(p.id) || 0) + c.dur > CAP)) reason = `quienes podrían ya llegarían al tope de ${CAP / 60} h`;
        else reason = 'los candidatos están en otra tarea a la misma hora';
        result.unresolved.push({ task_id: c.t.id, date, start: c.t.start, end: c.t.end, area: c.t.area, name: c.t.name, space: c.t.space, missing: c.missing, reason });
        result.unresolved_slots += c.missing;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return result;
}

// Minutos trabajados por persona y día (todas las áreas, según el día en que figura cada tarea).
export function workload() {
  const out = {};
  for (const r of db.prepare('SELECT a.person_id, t.date, t.start, t.end FROM assignments a JOIN tasks t ON t.id = a.task_id').all()) {
    const days = out[r.person_id] ||= {};
    days[r.date] = (days[r.date] || 0) + durMin(r);
  }
  return out;
}
