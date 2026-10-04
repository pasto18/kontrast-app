// Asignador automático de voluntarios.
// 1) Tareas que piden aptitudes: se cubren primero, solo con personas que tengan alguna de ellas.
// 2) Resto de tareas: cualquier persona del equipo que corresponda al área.
// Siempre: la persona está ese día, es del equipo del área, no se solapa con otra tarea suya
// y no supera MAX_DAILY_MINUTES de trabajo ese día. Lo que no se pueda cubrir se deja vacío.
import { db } from './db.js';
import { AREA_TEAMS, AREAS, AREA_GROUP, STRICT_AREAS, MAX_DAILY_MINUTES as CAP } from './config.js';

const NIGHT = 360; // los turnos que empiezan antes de las 06:00 son madrugada del día siguiente
const toMin = (h) => +h.slice(0, 2) * 60 + +h.slice(3);
export const durMin = (t) => (toMin(t.end) - toMin(t.start) + 1440) % 1440;
export const range = (t) => { const s0 = toMin(t.start), s = s0 < NIGHT ? s0 + 1440 : s0; return [s, s + durMin(t)]; };
export const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];

function loadPeople() {
  const people = new Map(db.prepare('SELECT id, nombre, equipo FROM people').all().map((p) => [p.id, {
    id: p.id, nombre: p.nombre, av: {}, skills: new Set(),
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

  result.imbalanced = 0;

  db.exec('BEGIN');
  try {
    // Primero se limpia lo que se va a rehacer, para que los totales por grupo no cuenten asignaciones que desaparecen.
    const clearMark = db.prepare('DELETE FROM assign_unresolved WHERE task_id = ?');
    const del = db.prepare('DELETE FROM assignments WHERE task_id = ?');
    for (const date of dates) for (const t of db.prepare('SELECT id, area FROM tasks WHERE date = ?').all(date)) {
      if (!areas.includes(t.area)) continue;
      clearMark.run(t.id);
      if (replace) del.run(t.id);
    }

    // Horas de cada persona en cada grupo (cb = Bar/Cocina/Limpieza, t = Técnica) en todo el festival.
    // Quien está en ambos grupos debería repartir su tiempo mitad y mitad.
    const gh = new Map(people.map((p) => [p.id, { cb: 0, t: 0 }]));
    for (const r of db.prepare('SELECT a.person_id, t.area, t.start, t.end FROM assignments a JOIN tasks t ON t.id = a.task_id').all()) if (AREA_GROUP[r.area]) gh.get(r.person_id)[AREA_GROUP[r.area]] += durMin(r);
    const dual = (p) => p.teams.has('TÉCNICA') && ['CUINA', 'NETEJA', 'BAR'].some((x) => p.teams.has(x));
    // Clase de un candidato para una tarea: 0 = va por detrás en ese grupo (conviene ponerlo), 1 = neutro, 2 = ya va por delante (se evita).
    const balClass = (p, c) => {
      if (!dual(p)) return 1;
      const g = AREA_GROUP[c.t.area], o = g === 't' ? 'cb' : 't';
      if (!g) return 1; // las tareas sin grupo (taquilla) no entran en el balance
      const d = gh.get(p.id)[g] - gh.get(p.id)[o];
      return d < 0 ? 0 : d > 0 ? 2 : 1;
    };
    const gap = (p, c) => { const g = AREA_GROUP[c.t.area], o = g === 't' ? 'cb' : 't'; return g && dual(p) ? gh.get(p.id)[g] - gh.get(p.id)[o] : 0; };

    for (const date of dates) {
      const tasks = db.prepare('SELECT * FROM tasks WHERE date = ?').all(date);
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
        fullPool: people.filter((p) => p.av[date] === 1 && AREA_TEAMS[t.area].some((x) => p.teams.has(x))),
      })).filter((c) => c.missing > 0);
      // pool = quién puede aportar una aptitud pedida; fullPool = cualquiera del equipo que esté ese día.
      for (const c of cts) c.pool = c.skills.length ? c.fullPool.filter((p) => c.skills.some((s) => p.skills.has(s))) : c.fullPool;
      const uncovered = (c) => { const have = new Set([...c.who].flatMap((pid) => [...byId.get(pid).skills])); return c.skills.filter((s) => !have.has(s)); };

      const eligible = (p, c) => !c.who.has(p.id) && (load.get(p.id) || 0) + c.dur <= CAP
        && !(busy.get(p.id) || []).some((r) => overlap(r, c.range));
      const give = (p, c) => {
        if (balClass(p, c) === 2) result.imbalanced++;
        insert.run(c.t.id, p.id); c.who.add(p.id); c.missing--; book(p.id, c.t); result.assigned++;
        if (AREA_GROUP[c.t.area]) gh.get(p.id)[AREA_GROUP[c.t.area]] += c.dur;
      };
      const lo = (p) => load.get(p.id) || 0;

      // Cubrir las aptitudes pedidas: basta con que alguien de la tarea tenga cada una; el resto no necesita tenerla.
      const coverSkills = (c) => {
        while (c.missing > 0) {
          const unc = uncovered(c);
          if (!unc.length) break;
          const n = (p) => unc.filter((s) => p.skills.has(s)).length;
          const best = c.pool.filter((p) => eligible(p, c) && n(p) > 0)
            .sort((a, b) => n(b) - n(a) || balClass(a, c) - balClass(b, c) || gap(a, c) - gap(b, c) || lo(a) - lo(b) || a.id - b.id)[0];
          if (!best) break;
          give(best, c);
        }
      };
      // Rellenar el resto de huecos con cualquiera del equipo (reparte la carga y el balance Técnica / Bar-Cocina).
      const fill = (c) => (c.skills.length ? c.fullPool : c.pool);
      const fillRest = (c) => {
        while (c.missing > 0 && !uncovered(c).length) {
          const best = fill(c).filter((p) => eligible(p, c))
            .sort((a, b) => balClass(a, c) - balClass(b, c) || gap(a, c) - gap(b, c) || lo(a) - lo(b) || a.teams.size - b.teams.size || a.id - b.id)[0];
          if (!best) break;
          give(best, c);
        }
      };
      const bySize = (a, b) => fill(a).length - fill(b).length || a.range[0] - b.range[0];

      // Fase 0: taquilla (gente escasa y exclusiva de ese equipo): se cubren primero todos sus turnos del día.
      // Quien sobre queda libre y se aprovecha después en las tareas de sus otros equipos.
      const strict = cts.filter((c) => STRICT_AREAS.includes(c.t.area));
      for (const c of [...strict].sort(bySize)) { coverSkills(c); fillRest(c); }
      // Fase 1: tareas con aptitudes (las más difíciles primero).
      const rest = cts.filter((c) => !STRICT_AREAS.includes(c.t.area));
      for (const c of rest.filter((x) => x.skills.length).sort((a, b) => a.pool.length - b.pool.length || a.range[0] - b.range[0])) coverSkills(c);
      // Fase 2: resto de huecos. Primero las tareas con menos gente posible.
      for (const c of rest.filter((x) => x.missing > 0).sort(bySize)) fillRest(c);

      for (const c of cts.filter((x) => x.missing > 0)) {
        let reason;
        const unc = uncovered(c), absent = fill(c).filter((p) => !c.who.has(p.id));
        const cand = unc.length ? c.pool.filter((p) => unc.some((s) => p.skills.has(s)) && !c.who.has(p.id)) : absent;
        if (c.dur > CAP) reason = `dura más de ${CAP / 60} h`;
        else if (!c.fullPool.length) reason = 'nadie del equipo disponible ese día';
        else if (unc.length && !cand.length) reason = `nadie disponible con la aptitud (${unc.map((s) => skillNames.get(s)).join(', ')})`;
        else if (!cand.length) reason = 'no hay más personas del equipo disponibles ese día';
        else if (cand.every((p) => (load.get(p.id) || 0) + c.dur > CAP)) reason = `quienes podrían ya llegarían al tope de ${CAP / 60} h`;
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
    if (AREA_GROUP[r.area]) g[AREA_GROUP[r.area]] += m;
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
    const p = people.get(r.person_id);
    if (p.av[r.date] === 0) add('ausente', p, r, 'figura como ausente ese día');
    if (!AREA_TEAMS[r.area].some((x) => p.teams.has(x))) add('equipo', p, r, `no es del equipo de ${AREAS[r.area]}`);
    const k = `${r.person_id}|${r.date}`;
    (byPersonDay.get(k) || byPersonDay.set(k, []).get(k)).push(r);
  }
  // Aptitudes: basta con que una persona de la tarea tenga cada aptitud pedida.
  const pending = new Set(db.prepare('SELECT u.task_id FROM assign_unresolved u JOIN tasks t ON t.id = u.task_id WHERE t.needed > (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id)').all().map((r) => r.task_id));
  const byTask = new Map();
  for (const r of rows) (byTask.get(r.id) || byTask.set(r.id, []).get(r.id)).push(r);
  for (const list of byTask.values()) {
    const t = list[0], need = taskSkills.get(t.id) || [];
    const lacking = need.filter((s) => !list.some((r) => people.get(r.person_id).skills.has(s)));
    if (!lacking.length || pending.has(t.id)) continue;
    out.push({ kind: 'aptitud', person_id: null, nombre: list.map((r) => people.get(r.person_id).nombre).join(', '), date: t.date, task_id: t.id, task_name: t.name,
      start: t.start, end: t.end, area: t.area, space: t.space, message: `nadie de la tarea tiene la aptitud pedida (${lacking.map((s) => skillNames.get(s)).join(', ')})` });
  }
  for (const list of byPersonDay.values()) {
    const p = people.get(list[0].person_id);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (!overlap(range(list[i]), range(list[j]))) continue;
      const [a, b] = [list[i], list[j]].sort(order);
      add('solape', p, b, `se solapa con "${a.name}" (${a.start}–${a.end})`);
    }
    const mins = list.reduce((n, t) => n + durMin(t), 0);
    // Un exceso aceptado a propósito (botón Resolver) deja de ser conflicto mientras no aumente.
    const ok = db.prepare('SELECT minutes FROM accepted_overtime WHERE person_id = ? AND date = ?').get(p.id, list[0].date);
    if (mins > CAP && !(ok && mins <= ok.minutes)) {
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
  const peopleAll = loadPeople();
  const have = new Set(peopleAll.filter((p) => inTask.has(p.id)).flatMap((p) => [...p.skills]));
  const uncoveredIds = skillIds.filter((s) => !have.has(s)); // aptitudes que aún no aporta nadie de la tarea
  const brief = (o) => ({ task_id: o.id, name: o.name, start: o.start, end: o.end, area: o.area, space: o.space });
  const candidates = peopleAll
    .filter((p) => p.av[t.date] === 1 && AREA_TEAMS[t.area].some((x) => p.teams.has(x)) && !inTask.has(p.id)
      && (!uncoveredIds.length || uncoveredIds.some((s) => p.skills.has(s))))
    .map((p) => {
      const tasks = (mine.get(p.id) || []).sort(order);
      const minutes = tasks.reduce((n, o) => n + durMin(o), 0);
      const blockers = tasks.filter((o) => overlap(range(o), mineRange)).map(brief);
      const over = minutes + dur > CAP;
      return { id: p.id, nombre: p.nombre, teams: [...p.teams], skills: [...p.skills].filter((s) => uncoveredIds.includes(s) || skillIds.includes(s)).map((s) => skillNames.get(s)),
        minutes, tasks: tasks.map(brief), blockers, over, status: blockers.length ? 'solape' : over ? 'tope' : 'libre' };
    })
    .sort((a, b) => ['libre', 'tope', 'solape'].indexOf(a.status) - ['libre', 'tope', 'solape'].indexOf(b.status) || a.minutes - b.minutes || a.nombre.localeCompare(b.nombre));
  return { task: { ...t, assigned: inTask.size, missing: Math.max(0, t.needed - inTask.size), duration: dur,
    skills: skillIds.map((s) => skillNames.get(s)), uncovered: uncoveredIds.map((s) => skillNames.get(s)) }, cap: CAP, candidates };
}
