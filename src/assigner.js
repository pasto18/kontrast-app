// Asignador automático de voluntarios.
// 1) Tareas que piden aptitudes: se cubren primero, solo con personas que tengan alguna de ellas.
// 2) Resto de tareas: cualquier persona del equipo que corresponda al área.
// Siempre: la persona está ese día, es del equipo del área, no se solapa con otra tarea suya
// y no supera MAX_DAILY_MINUTES de trabajo ese día. Lo que no se pueda cubrir se deja vacío.
import { db } from './db.js';
import { AREA_TEAMS, AREAS, AREA_GROUP, MAX_DAILY_MINUTES as CAP } from './config.js';

const NIGHT = 360; // los turnos que empiezan antes de las 06:00 son madrugada del día siguiente
const toMin = (h) => +h.slice(0, 2) * 60 + +h.slice(3);
export const durMin = (t) => (toMin(t.end) - toMin(t.start) + 1440) % 1440;
export const range = (t) => { const s0 = toMin(t.start), s = s0 < NIGHT ? s0 + 1440 : s0; return [s, s + durMin(t)]; };
export const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];

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
      const clearMark = db.prepare('DELETE FROM assign_unresolved WHERE task_id = ?');
      for (const t of tasks) if (areas.includes(t.area)) clearMark.run(t.id);
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
        db.prepare('INSERT OR REPLACE INTO assign_unresolved (task_id, reason) VALUES (?,?)').run(c.t.id, reason);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return result;
}

// Minutos trabajados: por persona y día (todas las áreas, según el día en que figura cada tarea)
// y por persona y grupo (cb = Bar/Cocina/Limpieza, t = Técnica) en todo el festival.
export function workload() {
  const days = {}, groups = {};
  for (const r of db.prepare('SELECT a.person_id, t.date, t.start, t.end, t.area FROM assignments a JOIN tasks t ON t.id = a.task_id').all()) {
    const m = durMin(r);
    const d = days[r.person_id] ||= {};
    d[r.date] = (d[r.date] || 0) + m;
    const g = groups[r.person_id] ||= { cb: 0, t: 0 };
    g[AREA_GROUP[r.area]] += m;
  }
  return { days, groups };
}

const order = (a, b) => a.date.localeCompare(b.date) || (a.start < '06:00') - (b.start < '06:00') || a.start.localeCompare(b.start);
const fmtH = (min) => (min / 60).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');

// Problemas en las asignaciones actuales (hechas a mano o automáticas):
// ausente, fuera de equipo, sin la aptitud pedida, solapes y exceso de horas.
export function findConflicts() {
  const people = new Map(loadPeople().map((p) => [p.id, p]));
  const skillNames = new Map(db.prepare('SELECT id, name FROM skills').all().map((s) => [s.id, s.name]));
  const taskSkills = new Map();
  for (const r of db.prepare('SELECT task_id, skill_id FROM task_skills').all()) (taskSkills.get(r.task_id) || taskSkills.set(r.task_id, []).get(r.task_id)).push(r.skill_id);
  const rows = db.prepare('SELECT a.person_id, t.* FROM assignments a JOIN tasks t ON t.id = a.task_id').all();
  const out = [];
  const add = (kind, p, t, message) => out.push({ kind, person_id: p.id, nombre: p.nombre, date: t.date, task_id: t.id, task_name: t.name,
    start: t.start, end: t.end, area: t.area, space: t.space, message });
  const byPersonDay = new Map();
  for (const r of rows) {
    const p = people.get(r.person_id), need = taskSkills.get(r.id) || [];
    if (p.av[r.date] === 0) add('ausente', p, r, 'figura como ausente ese día');
    if (!AREA_TEAMS[r.area].some((x) => p.teams.has(x))) add('equipo', p, r, `no es del equipo de ${AREAS[r.area]}`);
    if (need.length && !need.some((s) => p.skills.has(s))) add('aptitud', p, r, `no tiene la aptitud pedida (${need.map((s) => skillNames.get(s)).join(', ')})`);
    const k = `${r.person_id}|${r.date}`;
    (byPersonDay.get(k) || byPersonDay.set(k, []).get(k)).push(r);
  }
  for (const list of byPersonDay.values()) {
    const p = people.get(list[0].person_id);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (!overlap(range(list[i]), range(list[j]))) continue;
      const [a, b] = [list[i], list[j]].sort(order);
      add('solape', p, b, `se solapa con "${a.name}" (${a.start}–${a.end})`);
    }
    const mins = list.reduce((n, t) => n + durMin(t), 0);
    if (mins > CAP) {
      const first = [...list].sort(order)[0];
      out.push({ kind: 'horas', person_id: p.id, nombre: p.nombre, date: first.date, task_id: null, task_name: '', start: first.start, end: '', area: first.area, space: '',
        message: `trabaja ${fmtH(mins)} h ese día (tope ${CAP / 60} h): ${[...list].sort(order).map((t) => `${t.name} ${t.start}–${t.end}`).join(' · ')}` });
    }
  }
  return out.sort(order);
}

// Quién podría cubrir una tarea (disponible ese día, del equipo y con la aptitud pedida) y qué le impide hacerlo ahora.
export function candidatesFor(taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!t) return null;
  const skillIds = db.prepare('SELECT skill_id FROM task_skills WHERE task_id = ?').all(taskId).map((r) => r.skill_id);
  const skillNames = new Map(db.prepare('SELECT id, name FROM skills').all().map((s) => [s.id, s.name]));
  const inTask = new Set(db.prepare('SELECT person_id FROM assignments WHERE task_id = ?').all(taskId).map((r) => r.person_id));
  const mine = new Map();
  for (const r of db.prepare('SELECT a.person_id, t.* FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.date = ? AND t.id <> ?').all(t.date, taskId))
    (mine.get(r.person_id) || mine.set(r.person_id, []).get(r.person_id)).push(r);
  const dur = durMin(t), mineRange = range(t);
  const brief = (o) => ({ task_id: o.id, name: o.name, start: o.start, end: o.end, area: o.area, space: o.space });
  const candidates = loadPeople()
    .filter((p) => p.av[t.date] === 1 && AREA_TEAMS[t.area].some((x) => p.teams.has(x)) && !inTask.has(p.id)
      && (!skillIds.length || skillIds.some((s) => p.skills.has(s))))
    .map((p) => {
      const tasks = (mine.get(p.id) || []).sort(order);
      const minutes = tasks.reduce((n, o) => n + durMin(o), 0);
      const blockers = tasks.filter((o) => overlap(range(o), mineRange)).map(brief);
      const over = minutes + dur > CAP;
      return { id: p.id, nombre: p.nombre, teams: [...p.teams], skills: [...p.skills].filter((s) => skillIds.includes(s)).map((s) => skillNames.get(s)),
        minutes, tasks: tasks.map(brief), blockers, over, status: blockers.length ? 'solape' : over ? 'tope' : 'libre' };
    })
    .sort((a, b) => ['libre', 'tope', 'solape'].indexOf(a.status) - ['libre', 'tope', 'solape'].indexOf(b.status) || a.minutes - b.minutes || a.nombre.localeCompare(b.nombre));
  return { task: { ...t, assigned: inTask.size, missing: Math.max(0, t.needed - inTask.size), duration: dur,
    skills: skillIds.map((s) => skillNames.get(s)) }, cap: CAP, candidates };
}
