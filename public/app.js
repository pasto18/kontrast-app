'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// ---------- Equipos ↔ áreas ----------
const AREA_TEAMS = { cocina: ['CUINA', 'NETEJA'], bar: ['BAR'], tecnica: ['TÉCNICA'], taquilla: ['TAQUILLA'] };
const STRICT_AREAS = ['taquilla']; // solo personas de su equipo
const teamsOf = (p) => p.equipo.split(',').map((s) => s.trim()).filter(Boolean);
const fitsArea = (p, area) => teamsOf(p).some((t) => AREA_TEAMS[area].includes(t));

// ---------- Estado ----------
let cfg, people = [], tasks = [];
let selDay = null, view = store.get('view', 'voluntarios');
let areas = new Set(store.get('areas', ['cocina', 'bar', 'tecnica']));
let peopleTeams = new Set(store.get('peopleTeams', []).map((x) => (x === 'BILLETERÍA' ? 'TAQUILLA' : x)));
let editingId = null;
let companies = [], spaces = [], dlgCompanies = [], skills = [];
const pickers = { task: { ids: [], other: false }, person: { ids: [], other: false } };
let editingPerson = null, pAv = {};
let showTime = store.get('showTime', false);
let workload = {}, groupHours = {}, loadMode = store.get('loadMode', false);
// Orden de la tabla de Personas: clic en una cabecera = orden principal, segundo clic = inverso, tercer clic = lista original.
let peopleSort = store.get('peopleSort2', { key: null, step: 0 });
const VIEWS = ['voluntarios', 'personas', 'companias', 'espacios'];
let showOtherTeams = store.get('showOtherTeams', false);

// ---------- Reloj simulado (hora "naive": se trata todo como UTC) ----------
const CLOCK_START = '2025-04-06T08:00';
let clockMs = Date.parse(store.get('clock', CLOCK_START) + ':00Z');
let playing = false, timer = null;
const clockStr = () => new Date(clockMs).toISOString().slice(0, 16);
const clockDate = () => clockStr().slice(0, 10);
const toMin = (hhmm) => { const [h, m] = hhmm.split(':'); return +h * 60 + +m; };

function setClock(ms, { follow = true } = {}) {
  const prevDate = clockDate();
  clockMs = ms;
  store.set('clock', clockStr());
  $('#clock-input').value = clockStr();
  $('#clock-toggle').title = `Reloj simulado: ${clockStr().replace('T', ' ')}`;
  if (follow && cfg && clockDate() !== prevDate && cfg.days.some((d) => d.date === clockDate())) selectDay(clockDate());
  else if (view === 'voluntarios' && tasks.length) renderTasks();
  if (view === 'personas' && clockDate() !== prevDate) renderPeople();
  renderDays();
}

function setPlaying(on) {
  playing = on;
  $('#clock-play').textContent = on ? '⏸' : '▶';
  clearInterval(timer);
  if (on) timer = setInterval(() => setClock(clockMs + $('#clock-speed').value * 1000), 1000);
}

// ---------- API ----------
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), msg.startsWith('⚠') ? 8000 : 3500); }
const run = (p) => p.catch((e) => { toast(e.message); });

let conflicts = { unresolved: [], assignments: [], total: 0 };
function renderConflictsButton() {
  $('#view-conflicts').disabled = !conflicts.total;
  $('#conflicts-badge').hidden = !conflicts.total; $('#conflicts-badge').textContent = conflicts.total;
}
async function refreshConflicts() { conflicts = await api('/api/conflicts'); renderConflictsButton(); if ($('#conflicts-dialog').open) renderConflicts(); }
async function loadTasks() { [tasks, conflicts] = await Promise.all([api(`/api/tasks?date=${selDay}`), api('/api/conflicts')]); renderTasks(); renderConflictsButton(); if ($('#conflicts-dialog').open) renderConflicts(); }
function selectDay(date) { selDay = date; store.set('day', date); renderDays(); return loadTasks(); }

// ---------- Selector de día ----------
function renderDays() {
  $('#day-selector').innerHTML = cfg.days.map((d) => `
    <button data-day="${d.date}" class="${d.date === selDay ? 'active' : ''} ${d.date === clockDate() ? 'today' : ''}" title="${d.label}">
      <small>${d.dow.slice(0, 3)}</small><b>${d.day}</b></button>`).join('');
}

// ---------- Tabla de tareas ----------
// Las tareas pueden cruzar la medianoche (23:00–1:00) y las que empiezan antes de las 06:00
// son la madrugada del día siguiente, aunque figuren en el día del turno de noche.
// Horario: una tarea es "de mañana" si empieza antes de las 12:00 (desde las 06:00) y "de noche" si empieza desde las 21:00 o de madrugada.
const periodOf = (start) => { const m = toMin(start); return m < 360 || m >= 1260 ? 'noche' : m < 720 ? 'manana' : 'tarde'; };
const horarioMismatch = (h, start) => (h === 'madrugador' && periodOf(start) === 'noche') || (h === 'trasnochador' && periodOf(start) === 'manana');
const NIGHT = 360;
const durMin = (t) => (toMin(t.end) - toMin(t.start) + 1440) % 1440;
const fmtDur = (t) => (durMin(t) / 60).toFixed(2).replace('.', ',');
const dayMin = (date) => Date.parse(date + 'T00:00:00Z') / 60000;
function absRange(t) {
  const s0 = toMin(t.start), s = dayMin(t.date) + (s0 < NIGHT ? s0 + 1440 : s0);
  return [s, s + durMin(t)];
}
const overlaps = (a, b) => { const [a0, a1] = absRange(a), [b0, b1] = absRange(b); return a0 < b1 && b0 < a1; };

function taskStatus(t) {
  const now = clockMs / 60000, [s, e] = absRange(t);
  return now >= e ? 'past' : now >= s ? 'now' : 'future';
}

const skillName = (id) => skills.find((k) => k.id === id)?.name ?? id;

function pickerOptions(t) {
  const assigned = new Set(t.volunteers.map((v) => v.id));
  const busyWith = (p) => tasks.find((o) => o.id !== t.id && overlaps(o, t) && o.volunteers.some((v) => v.id === p.id));
  const have = new Set(t.volunteers.flatMap((v) => people.find((p) => p.id === v.id)?.skill_ids ?? []));
  const need = t.skills.map((k) => k.id).filter((id) => !have.has(id)); // solo importan las aptitudes que aún nadie aporta
  const matched = (p) => need.filter((id) => p.skill_ids.includes(id));
  const opt = (p) => {
    const b = busyWith(p);
    const teams = teamsOf(p).join('/');
    const m = matched(p).map(skillName).join(', ');
    return `<option value="${p.id}">${esc(p.nombre)}${teams ? ` · ${esc(teams)}` : ''}${m ? ` · ★ ${esc(m)}` : ''}${b ? ` ⚠ solapa con ${esc(b.name)}` : ''}</option>`;
  };
  const byMatch = (l) => [...l].sort((a, b) => matched(b).length - matched(a).length);
  const present = people.filter((p) => !assigned.has(p.id) && p.av[t.date] === 1);
  const groups = [['Equipo coincide', byMatch(present.filter((p) => fitsArea(p, t.area)))]];
  if (showOtherTeams && !STRICT_AREAS.includes(t.area)) groups.push(['Otros equipos', byMatch(present.filter((p) => !fitsArea(p, t.area)))]);
  return '<option value="">+ Añadir…</option>' + groups.filter(([, l]) => l.length)
    .map(([label, l]) => `<optgroup label="${label}">${l.map(opt).join('')}</optgroup>`).join('');
}

// Un hueco por voluntario necesario: el tamaño de la fila no cambia al asignar.
function slots(t) {
  const tk = searchTokens();
  const out = t.volunteers.map((v) => { const hit = tk.length && tk.some((k) => norm(v.nombre).includes(k)); const bad = showTime && horarioMismatch(people.find((p) => p.id === v.id)?.horario, t.start);
    return `<div class="slot${bad ? ' mis' : ''}${hit ? ' hit' : ''}" draggable="true" data-task="${t.id}" data-person="${v.id}" title="${bad ? 'No es el momento del día apropiado para esta persona' : 'Arrastra sobre otro nombre para intercambiar'}"><span class="vol">${esc(v.nombre)}</span><button data-rm="${t.id}:${v.id}" title="Quitar">×</button></div>`; });
  for (let i = t.volunteers.length; i < t.needed; i++) {
    out.push(i === t.volunteers.length
      ? `<div class="slot"><select data-add="${t.id}">${pickerOptions(t)}</select></div>`
      : '<div class="slot free">libre</div>');
  }
  return out.join('');
}

let editing = null, otherTask = null, dirty = false, flashId = null, drag = null;
let focusIds = [], focusTimer = null; // tareas a las que se ha saltado desde Conflictos / Ver tareas / detalles

function skillCell(t) {
  const chips = t.skills.map((k) => `<span class="skc">${esc(k.name)}<button data-tsk-rm="${t.id}:${k.id}" title="Quitar">×</button></span>`).join('');
  if (otherTask === t.id) return `${chips}<span class="other"><input data-tsk-input="${t.id}" placeholder="Nueva aptitud…" maxlength="40"><button data-tsk-save="${t.id}">+</button><button data-tsk-cancel="${t.id}" title="Cancelar">×</button></span>`;
  const have = new Set(t.skills.map((k) => k.id));
  return `${chips}<select data-tsk-add="${t.id}"><option value="">+ aptitud</option>${skills.filter((k) => !have.has(k.id)).map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}<option value="__other">Otro…</option></select>`;
}

const norm = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Búsqueda en el reparto: persona, tarea, espacio, responsable, aptitud, compañía u obra (sin tildes ni mayúsculas, todas las palabras).
function taskHaystack(t) {
  const obras = t.companies.flatMap((c) => (companies.find((x) => x.id === c.id)?.shows ?? []).map((s) => s.obra));
  return norm([t.name, t.space, t.responsible, ...t.volunteers.map((v) => v.nombre), ...t.skills.map((k) => k.name), ...t.companies.map((c) => c.name), ...obras].join(' | '));
}
const searchTokens = () => norm($('#task-search').value.trim()).split(/\s+/).filter(Boolean);

function renderTasks(force = false) {
  if (!force && (editing || otherTask !== null || drag)) { dirty = true; return; } // no pisar una celda en edición
  dirty = false;
  const tokens = searchTokens();
  const byArea = tasks.filter((t) => areas.has(t.area));
  const rows = tokens.length ? byArea.filter((t) => { const h = taskHaystack(t); return tokens.every((k) => h.includes(k)); }) : byArea;
  $('#task-search-count').textContent = tokens.length ? `${rows.length}/${byArea.length} tareas` : '';
  const head = `<thead><tr><th class="tm">Inicio</th><th class="tm">Fin</th><th class="num tm">Dur.</th><th>Área</th><th>Espacio</th><th>Tarea</th><th>Aptitudes</th>
    <th class="num nec" title="Voluntarios necesarios">Nec.</th><th>Responsable</th><th class="est"></th><th>Voluntarios</th><th></th></tr></thead>`;
  if (!rows.length) { $('#tasks-table').innerHTML = head + `<tbody><tr><td colspan="12" class="empty">${tokens.length ? 'Ninguna tarea de este día coincide con la búsqueda.' : 'No hay tareas para este día con los filtros actuales.'}</td></tr></tbody>`; return; }
  $('#tasks-table').innerHTML = head + '<tbody>' + rows.map((t) => {
    const st = taskStatus(t), n = t.volunteers.length;
    const cls = t.needed === 0 ? 'f3' : n === 0 ? 'f0' : n < t.needed ? 'f1' : 'f2';
    return `<tr data-id="${t.id}" class="${st === 'future' ? '' : st}${t.id === flashId ? ' flash' : ''}${focusIds.includes(t.id) ? ' focus' : ''}">
      <td class="tm ed" data-field="start">${st === 'now' ? '<i class="live-dot" title="En curso"></i>' : ''}${t.start}</td><td class="tm ed" data-field="end">${t.end}</td>
      <td class="num tm ed" data-field="dur">${fmtDur(t)}</td>
      <td class="ed" data-field="area"><span class="tag ${t.area}">${esc(cfg.areas[t.area])}</span></td>
      <td class="ed" data-field="space">${esc(t.space)}</td>
      <td class="ed" data-field="name"><b>${esc(t.name)}</b>${t.companies.length ? `<div>${t.companies.map((c) => `<span class="cotag">${esc(c.name)}</span>`).join('')}</div>` : ''}</td>
      <td class="sk"><div class="tsk">${skillCell(t)}</div></td>
      <td class="num nec ed" data-field="needed">${t.needed}</td><td class="ed" data-field="responsible">${esc(t.responsible)}</td>
      <td class="est"><span class="fill ${cls}">${n}/${t.needed}</span></td>
      <td><div class="slots">${slots(t)}</div></td>
      <td class="acts"><button class="icon" data-edit="${t.id}" title="Editar todo">✎</button>
          <button class="icon" data-dup="${t.id}" title="Duplicar">⧉</button>
          <button class="icon" data-del="${t.id}" title="Eliminar">🗑</button></td></tr>`;
  }).join('') + '</tbody>';
  const ot = $('[data-tsk-input]'); if (ot) ot.focus();
  if (flashId) { $(`tr[data-id="${flashId}"]`)?.scrollIntoView({ block: 'nearest' }); flashId = null; }
}

// ---- Guardado de una tarea desde la tabla (edición en celda) ----
async function saveTask(t, patch) {
  const body = { date: t.date, start: t.start, end: t.end, area: t.area, space: t.space, name: t.name, needed: t.needed,
    responsible: t.responsible, company_ids: t.companies.map((c) => c.id), skill_ids: t.skills.map((k) => k.id), ...patch };
  try { await api(`/api/tasks/${t.id}`, 'PUT', body); } catch (e) { toast(e.message); }
  await loadTasks();
}

function startEdit(id, field, td) {
  const t = tasks.find((x) => x.id === id);
  const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let el;
  if (field === 'start' || field === 'end') el = mk('input', { type: 'time', value: t[field] });
  else if (field === 'dur') el = mk('input', { type: 'text', value: fmtDur(t), size: 4 });
  else if (field === 'needed') el = mk('input', { type: 'number', min: 0, max: 99, value: t.needed });
  else if (field === 'area') {
    el = mk('select'); el.innerHTML = Object.entries(cfg.areas).map(([k, l]) => `<option value="${k}" ${k === t.area ? 'selected' : ''}>${esc(l)}</option>`).join('');
  } else {
    el = mk('input', { type: 'text', value: t[field], maxlength: 80 });
    if (field === 'space') el.setAttribute('list', 'space-names');
    if (field === 'responsible') el.setAttribute('list', 'people-names');
  }
  el.className = 'cell-input';
  td.textContent = ''; td.appendChild(el);
  editing = { id, field };
  el.focus(); if (el.select && el.type !== 'time') el.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true; editing = null;
    let patch = null;
    if (save) {
      const v = el.value.trim();
      if (field === 'dur') {
        const h = parseFloat(v.replace(',', '.'));
        if (!(h > 0 && h <= 24)) { toast('Duración inválida (horas, por ejemplo 1,5)'); }
        else { const m = (toMin(t.start) + Math.round(h * 60)) % 1440; patch = { end: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }; }
      } else if (field === 'needed') patch = { needed: v === '' ? t.needed : Number(v) };
      else if ((field === 'start' || field === 'end') && !v) patch = null;
      else if (field === 'name' && !v) patch = null;
      else patch = { [field]: v };
    }
    if (patch && Object.entries(patch).some(([k, v]) => v !== t[k])) await saveTask(t, patch); else renderTasks();
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
  el.addEventListener('blur', () => finish(true));
  if (field === 'area') el.addEventListener('change', () => finish(true));
}

$('#tasks-table').addEventListener('click', (e) => {
  if (e.target.closest('button, select, input, .slots')) return;
  const td = e.target.closest('td.ed');
  if (td && !editing) startEdit(+td.closest('tr').dataset.id, td.dataset.field, td);
});

// ---- Intercambio de voluntarios arrastrando un nombre sobre otro ----
const table = $('#tasks-table');
const dropSlot = (e) => { const s = e.target.closest('.slot[data-person]'); return s && drag && s.dataset.task !== drag.task ? s : null; };
table.addEventListener('dragstart', (e) => {
  const s = e.target.closest('.slot[data-person]'); if (!s) return;
  drag = { task: s.dataset.task, person: s.dataset.person };
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `${drag.task}:${drag.person}`);
  s.classList.add('dragging');
});
table.addEventListener('dragover', (e) => { if (dropSlot(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
table.addEventListener('dragenter', (e) => dropSlot(e)?.classList.add('drop'));
table.addEventListener('dragleave', (e) => { const s = e.target.closest('.slot'); if (s && !s.contains(e.relatedTarget)) s.classList.remove('drop'); });
table.addEventListener('drop', (e) => {
  const s = dropSlot(e); if (!s) return;
  e.preventDefault();
  const from = drag; drag = null;
  run(api('/api/assignments/swap', 'POST', { task_a: +from.task, person_a: +from.person, task_b: +s.dataset.task, person_b: +s.dataset.person })
    .then((r) => { if (r.warnings.length) toast('⚠ ' + r.warnings.join(' · ')); })).finally(loadTasks);
});
table.addEventListener('dragend', () => { drag = null; if (dirty) renderTasks(); else document.querySelectorAll('.slot.dragging,.slot.drop').forEach((x) => x.classList.remove('dragging', 'drop')); });

// Salta a un día y destaca (con scroll) las tareas indicadas. Si un filtro de área o la búsqueda las ocultan, se quitan.
async function goToTasks(date, ids) {
  focusIds = (ids || '').split(',').map(Number).filter(Boolean);
  await selectDay(date);
  const targets = tasks.filter((t) => focusIds.includes(t.id));
  let changed = false;
  for (const t of targets) if (!areas.has(t.area)) { areas.add(t.area); changed = true; }
  if (changed) { store.set('areas', [...areas]); renderAreaFilter(); }
  const tk = searchTokens();
  if (tk.length && targets.some((t) => !tk.every((k) => taskHaystack(t).includes(k)))) $('#task-search').value = '';
  renderTasks(true);
  clearTimeout(focusTimer);
  if (!targets.length) return;
  await new Promise((r) => requestAnimationFrame(r));
  $('tr.focus')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  focusTimer = setTimeout(() => { focusIds = []; document.querySelectorAll('tr.focus').forEach((r) => r.classList.remove('focus')); }, 7500);
}

async function saveTaskSkillOther(id) {
  const name = $(`[data-tsk-input="${id}"]`).value.trim();
  if (!name) return;
  const sk = await api('/api/skills', 'POST', { name });
  if (!skills.some((k) => k.id === sk.id)) skills.push(sk);
  renderAllSkillPickers();
  const t = tasks.find((x) => x.id === id);
  otherTask = null;
  await saveTask(t, { skill_ids: [...new Set([...t.skills.map((k) => k.id), sk.id])] });
}

function renderOthersToggle() {
  $('#others-toggle').classList.toggle('active', showOtherTeams);
  $('#others-toggle').textContent = showOtherTeams ? '✓ Mostrando otros equipos' : 'Mostrar también otros equipos';
}

function renderAreaFilter() {
  $('#area-filter').innerHTML = Object.entries(cfg.areas).map(([k, l]) =>
    `<button data-area="${k}" class="${areas.has(k) ? 'active' : ''}">${l}</button>`).join('');
}

// ---------- Personas ----------
function renderPeopleFilter() {
  $('#people-filter').innerHTML = ['CUINA', 'NETEJA', 'BAR', 'TÉCNICA', 'VIDEO', 'TAQUILLA']
    .map((t) => `<button data-team="${t}" class="${peopleTeams.has(t) ? 'active' : ''}">${t}</button>`).join('');
}

const fmtH = (min) => (min / 60).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
function daySquare(p, d) {
  const v = p.av[d.date], m = workload[p.id]?.[d.date] || 0;
  if (!loadMode) return `<i class="sq hrs ${v === 1 ? 'on' : v === 0 ? 'off' : 'unk'}" title="${d.label}: ${v === 1 ? 'está' : v === 0 ? 'no está' : 'sin datos'}"></i>`;
  const cls = v === 0 ? 'off' : v == null ? 'unk' : m === 0 ? 'bone' : m < cfg.maxMinutes ? 'ok' : m === cfg.maxMinutes ? 'full' : 'over';
  const state = v === 0 ? 'no está' : v == null ? 'sin datos' : `${fmtH(m) || 0} h`;
  return `<i class="sq hrs ${cls}" title="${d.label}: ${state}${v === 0 && m ? ` (¡asignada/o ${fmtH(m)} h estando ausente!)` : ''}">${m ? fmtH(m) : ''}</i>`;
}

async function refreshWorkload() { const r = await api('/api/workload'); workload = r.days; groupHours = r.groups; }

// Balance: solo para quien está en Técnica y en alguno de Bar/Cuina/Neteja. Su tiempo debería repartirse mitad y mitad.
const GRUPO_CORTO = { VOLUNTARIAS: 'VOL', CASA: 'K' };
const CB_TEAMS = ['CUINA', 'NETEJA', 'BAR'];
function balanceCell(p) {
  const t = teamsOf(p);
  if (!(t.includes('TÉCNICA') && t.some((x) => CB_TEAMS.includes(x)))) return '';
  const g = groupHours[p.id] || { cb: 0, t: 0 }, diff = g.t - g.cb;
  const tip = `Técnica ${fmtH(g.t) || 0} h · Bar/Cocina/Limpieza ${fmtH(g.cb) || 0} h`;
  if (diff === 0) return g.cb ? `<span class="baldiff" title="${tip}">=</span>` : '';
  return `<span class="bal ${diff > 0 ? 't' : 'cb'}" title="${tip}">${diff > 0 ? 'T' : 'B/C'} +${fmtH(Math.abs(diff))}</span>`;
}

// Promedio de horas por día de estadía, contando solo los días ya transcurridos (hasta hoy, según el reloj) en los que está.
function avgValue(p) {
  const past = cfg.days.filter((d) => d.date <= clockDate() && p.av[d.date] === 1);
  if (!past.length) return null;
  const mins = cfg.days.filter((d) => d.date <= clockDate()).reduce((n, d) => n + (workload[p.id]?.[d.date] || 0), 0);
  return Math.round(mins / past.length / 6) / 10;
}
function avgHours(p) { const v = avgValue(p); return v === null ? '–' : `${v.toString().replace('.', ',')} h`; }
// Desbalance (horas de diferencia entre Técnica y Bar/Cocina/Limpieza); null si la persona no está en ambos grupos.
function balanceDiff(p) {
  const t = teamsOf(p);
  if (!(t.includes('TÉCNICA') && t.some((x) => CB_TEAMS.includes(x)))) return null;
  const g = groupHours[p.id] || { cb: 0, t: 0 };
  return Math.abs(g.t - g.cb);
}

let pEditing = null, pOther = null, pDirty = false;

// Cada columna: dirección del primer clic ('asc' alfabético / ascendente, 'desc' los mayores primero) y su valor. null = va siempre al final.
const HORARIO_RANK = { madrugador: 0, indiferente: 1, trasnochador: 2 };
const SORTS = {
  nombre: { dir: 'asc', val: (p) => p.nombre },
  grupo: { dir: 'asc', val: (p) => GRUPO_CORTO[p.grupo] || p.grupo || '' },
  equipo: { dir: 'asc', val: (p) => teamsOf(p).join(' ') || null },
  horario: { dir: 'asc', val: (p) => HORARIO_RANK[p.horario || 'indiferente'] },
  aptitudes: { dir: 'asc', val: (p) => p.skill_ids.map(skillName).sort((a, b) => a.localeCompare(b, 'es')).join(' ') || null },
  balance: { dir: 'desc', val: balanceDiff },
  dias: { dir: 'desc', val: (p) => cfg.days.filter((d) => p.av[d.date] === 1).length },
  prom: { dir: 'desc', val: avgValue },
};
function sortSpec(key) {
  if (SORTS[key]) return SORTS[key];
  if (key?.startsWith('day:')) { const date = key.slice(4); return { dir: 'desc', val: (p) => (loadMode ? workload[p.id]?.[date] || 0 : p.av[date] === 1 ? 2 : p.av[date] == null ? 1 : 0) }; }
  return null;
}
function sortPeople(list) {
  const spec = sortSpec(peopleSort.key);
  if (!spec || !peopleSort.step) return;
  const sign = (spec.dir === 'asc') === (peopleSort.step === 1) ? 1 : -1; // paso 2 = inverso
  const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
  list.sort((a, b) => {
    const x = spec.val(a), y = spec.val(b);
    if (x === null || x === undefined) return y === null || y === undefined ? byName(a, b) : 1; // sin valor: siempre al final
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { sensitivity: 'base' });
    return sign * c || byName(a, b);
  });
}
const sortArrow = (key) => {
  if (peopleSort.key !== key || !peopleSort.step) return '';
  const spec = sortSpec(key), up = (spec.dir === 'asc') === (peopleSort.step === 1);
  return ` <span class="sarrow">${up ? '▲' : '▼'}</span>`;
};
const HORARIO_ICON = { madrugador: ['☀', 'Madrugadorx'], trasnochador: ['☾', 'Trasnochadorx'], indiferente: ['–', 'Indiferente'] };

function renderPeople(force = false) {
  if (!force && (pEditing || pOther !== null)) { pDirty = true; return; } // no pisar una celda en edición
  pDirty = false;
  $('#load-toggle').classList.toggle('active', loadMode);
  const q = $('#people-search').value.trim().toLowerCase();
  const list = people.filter((p) => (!q || p.nombre.toLowerCase().includes(q))
    && (!peopleTeams.size || teamsOf(p).some((t) => peopleTeams.has(t))));
  const days = cfg.days;
  const present = (p) => days.filter((d) => p.av[d.date] === 1).length;
  sortPeople(list, present);
  const th = (key, label, attrs = '', cls = '') => `<th class="sortable ${cls}" data-sort="${key}" ${attrs}>${label}${sortArrow(key)}</th>`;
  const head = `<thead><tr>${th('nombre', 'Nombre')}${th('grupo', 'Grupo')}${th('equipo', 'Equipo')}${th('horario', 'Horario', 'title="Horario preferido: ☀ madrugadorx, ☾ trasnochadorx, – indiferente. Orden: madrugadorx, indiferente, trasnochadorx"')}${th('aptitudes', 'Aptitudes')}${th('balance', 'Balance', 'title="Horas de más en Técnica (T) o en Bar/Cocina/Limpieza (B/C). Solo para quien está en ambos grupos. Orden: más desbalance primero"')}${th('dias', 'Días', 'title="Días presentes en el festival. Orden: más días primero"', 'num')}
    ${days.map((d) => `<th class="d sortable" data-sort="day:${d.date}" title="${d.label}: ${loadMode ? 'más horas primero' : 'presentes primero'}">${d.dow.slice(0, 1).toUpperCase()}<br>${d.day}${sortArrow('day:' + d.date)}</th>`).join('')}${th('prom', 'Prom./día', 'title="Horas trabajadas por día de estadía, hasta la fecha del reloj. Orden: más horas primero"', 'num')}<th></th></tr></thead>`;
  const tot = `<tr class="tot"><td colspan="7" style="text-align:right">${loadMode ? 'Horas asignadas por día (lista filtrada)' : 'Presentes por día (lista filtrada)'}</td>
    ${days.map((d) => `<td>${loadMode ? (Math.round(list.reduce((n, p) => n + (workload[p.id]?.[d.date] || 0), 0) / 6) / 10).toString().replace('.', ',') : list.filter((p) => p.av[d.date] === 1).length}</td>`).join('')}<td></td><td></td></tr>`;
  $('#people-table').innerHTML = head + '<tbody>' + tot + list.map((p) => `<tr data-id="${p.id}">
    <td class="ed" data-field="nombre"><button class="mini" data-ptasks="${p.id}" title="Ver las tareas asignadas a esta persona">Ver tareas</button> <b>${esc(p.nombre)}</b>${p.por_confirmar ? ' <span class="conf">POR CONFIRMAR</span>' : ''}</td>
    <td class="ed" data-field="grupo" title="${esc(p.grupo)}">${esc(GRUPO_CORTO[p.grupo] || p.grupo)}</td>
    <td class="ed" data-field="equipo">${teamsOf(p).map((t) => `<span class="eq ${esc(t)}">${esc(t)}</span>`).join('') || '<span class="hint">—</span>'}</td>
    <td class="ed hzc" data-field="horario" title="${HORARIO_ICON[p.horario || 'indiferente'][1]}">${HORARIO_ICON[p.horario || 'indiferente'][0]}</td>
    <td class="aptc">${personSkillCell(p)}</td>
    <td class="balc">${balanceCell(p)}</td>
    <td class="num"><b>${present(p)}</b></td>
    ${days.map((d) => `<td class="d ed" data-tday="${d.date}">${daySquare(p, d)}</td>`).join('')}
    <td class="num">${avgHours(p)}</td>
    <td><button class="icon" data-pedit="${p.id}" title="Editar todo">✎</button></td></tr>`).join('') + '</tbody>';
  const ot = $('[data-psk-input]'); if (ot) ot.focus();
}

function personSkillCell(p) {
  const chips = p.skill_ids.map((id) => `<span class="apt">${esc(skillName(id))}<button data-psk-rm="${p.id}:${id}" title="Quitar">×</button></span>`).join('');
  const note = p.aptitudes ? `<span class="apt-note ed-note" title="Clic para editar la nota">${esc(p.aptitudes)}</span>` : '';
  if (pOther === p.id) return `${chips}<span class="other"><input data-psk-input="${p.id}" placeholder="Nueva aptitud…" maxlength="40"><button data-psk-save="${p.id}">+</button><button data-psk-cancel="${p.id}" title="Cancelar">×</button></span>${note}`;
  const have = new Set(p.skill_ids);
  return `${chips}<select class="psk" data-psk-add="${p.id}"><option value="">+ aptitud</option>${skills.filter((k) => !have.has(k.id)).map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}<option value="__other">Otro…</option></select>${note}`;
}

// ---- Edición en la tabla de Personas ----
function personPayload(p, patch) {
  return { nombre: p.nombre, grupo: p.grupo, horario: p.horario || 'indiferente', equipo: teamsOf(p), aptitudes: p.aptitudes, por_confirmar: !!p.por_confirmar,
    skill_ids: p.skill_ids, av: Object.fromEntries(cfg.days.map((d) => [d.date, p.av[d.date] ?? null])), ...patch };
}
async function savePerson(p, patch) {
  try { await api(`/api/people/${p.id}`, 'PUT', personPayload(p, patch)); } catch (e) { toast(e.message); }
  await reloadPeople();
}

function startPersonEdit(id, field, host) {
  const p = people.find((x) => x.id === id);
  const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let el, done = false, cleanup = () => {};
  if (field === 'equipo') {
    const teams = [...new Set([...DEFAULT_TEAMS, ...people.flatMap(teamsOf)])], mine = teamsOf(p);
    el = mk('div', { className: 'eq-edit' });
    el.innerHTML = teams.map((t) => `<label><input type="checkbox" value="${esc(t)}" ${mine.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
  } else if (field === 'grupo' || field === 'horario') {
    el = mk('select');
    const opts = field === 'horario' ? [['indiferente', 'Indiferente'], ['madrugador', 'Madrugadorx'], ['trasnochador', 'Trasnochadorx']]
      : [...new Set(['VOLUNTARIAS', 'CASA', 'SIDE', ...people.map((x) => x.grupo).filter(Boolean)])].map((g) => [g, g]);
    el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === (field === 'horario' ? p.horario || 'indiferente' : p.grupo) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  } else {
    el = mk('input', { type: 'text', value: p[field] || '', maxlength: field === 'nombre' ? 80 : 120 });
  }
  el.className = (el.className ? el.className + ' ' : '') + 'cell-input';
  if (field === 'equipo') el.className = 'eq-edit';
  if (host.tagName === 'TD') host.textContent = ''; else host.replaceChildren();
  host.appendChild(el);
  pEditing = { id, field };
  if (field !== 'equipo') { el.focus(); if (el.select) el.select(); }
  const finish = async (save) => {
    if (done) return; done = true; pEditing = null; cleanup();
    let patch = null;
    if (save) {
      if (field === 'equipo') { const eq = [...el.querySelectorAll('input:checked')].map((i) => i.value); patch = { equipo: eq }; if (eq.join() === teamsOf(p).join()) patch = null; }
      else { const v = el.value.trim(); if (field === 'nombre' && !v) patch = null; else if (v !== (p[field] || (field === 'horario' ? 'indiferente' : ''))) patch = { [field]: v }; }
    }
    if (patch) await savePerson(p, patch); else renderPeople();
  };
  if (field === 'equipo') {
    const outside = (e) => { if (!el.contains(e.target)) finish(true); };
    document.addEventListener('mousedown', outside, true);
    cleanup = () => document.removeEventListener('mousedown', outside, true);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    el.querySelector('input').focus();
  } else {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
    el.addEventListener('blur', () => finish(true));
    if (el.tagName === 'SELECT') el.addEventListener('change', () => finish(true));
  }
}

$('#people-table').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th && !pEditing) {
    const key = th.dataset.sort;
    peopleSort = peopleSort.key === key ? { key, step: (peopleSort.step + 1) % 3 } : { key, step: 1 };
    store.set('peopleSort2', peopleSort); return renderPeople();
  }
  if (e.target.closest('button, select, input') || pEditing) return;
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const id = +tr.dataset.id;
  const note = e.target.closest('.ed-note');
  if (note) return startPersonEdit(id, 'aptitudes', note);
  const td = e.target.closest('td.ed'); if (!td) return;
  if (td.dataset.tday) { // cuadrado de un día: sin datos → está → no está
    const p = people.find((x) => x.id === id), v = p.av[td.dataset.tday] ?? null;
    return run(savePerson(p, { av: { ...personPayload(p, {}).av, [td.dataset.tday]: v === null ? 1 : v === 1 ? 0 : null } }));
  }
  startPersonEdit(id, td.dataset.field, td);
});

async function savePersonSkillOther(id) {
  const name = $(`[data-psk-input="${id}"]`).value.trim();
  if (!name) return;
  const sk = await api('/api/skills', 'POST', { name });
  if (!skills.some((k) => k.id === sk.id)) skills.push(sk);
  renderAllSkillPickers();
  const p = people.find((x) => x.id === id);
  pOther = null;
  await savePerson(p, { skill_ids: [...new Set([...p.skill_ids, sk.id])] });
}

// ---- Tareas asignadas a una persona ----
async function openPersonTasks(id) {
  const p = people.find((x) => x.id === id);
  const tasks = await api(`/api/people/${id}/tasks`);
  const byDay = new Map();
  for (const t of tasks) (byDay.get(t.date) || byDay.set(t.date, []).get(t.date)).push(t);
  const mins = (l) => l.reduce((n, t) => n + durMin(t), 0);
  $('#detail-title').textContent = `Tareas de ${p.nombre}`;
  $('#detail-sub').textContent = tasks.length ? `${tasks.length} ${tasks.length === 1 ? 'tarea' : 'tareas'} · ${fmtH(mins(tasks)) || 0} h en total` : '';
  $('#detail-body').innerHTML = tasks.length ? [...byDay].map(([date, l]) => {
    const m = mins(l), over = m > cfg.maxMinutes;
    return `<h4>${fmtDay(date)} · <span style="color:${over ? 'var(--bad)' : 'inherit'}">${fmtH(m) || 0} h${over ? ` (tope ${fmtH(cfg.maxMinutes)} h)` : ''}</span>${p.av[date] === 0 ? ' · <span style="color:var(--bad)">figura como ausente</span>' : ''}</h4>
      <div class="table-wrap"><table class="ptl"><tbody>${l.map((t) => `<tr><td>${t.start}–${t.end}</td><td class="num">${fmtH(durMin(t))} h</td>
        <td><span class="tag ${t.area}">${esc(cfg.areas[t.area])}</span></td><td>${esc(t.space)}</td>
        <td><b>${esc(t.name)}</b>${horarioMismatch(p.horario, t.start) ? ' <span class="cst-hz" title="No es el momento del día apropiado para esta persona">⏰ horario</span>' : ''}${t.companies.length ? `<div>${t.companies.map((c) => `<span class="cotag">${esc(c.name)}</span>`).join('')}</div>` : ''}</td>
        <td class="v">${t.volunteers.filter((v) => v.id !== id).map((v) => esc(v.nombre)).join(', ')}</td>
        <td><button data-goto="${t.date}" data-goto-task="${t.id}" title="Ver en la tabla de voluntarios">Ver ›</button></td></tr>`).join('')}</tbody></table></div>`;
  }).join('') : '<div class="empty">Esta persona no tiene tareas asignadas.</div>';
  $('#detail-dialog').showModal();
}

function showView(v) {
  view = v; store.set('view', v);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  for (const k of VIEWS) $(`#view-${k}`).hidden = k !== v;
  if (v === 'personas') run(refreshWorkload().then(renderPeople));
  else if (v === 'voluntarios') renderTasks();
  else run(refreshCatalog().then(v === 'companias' ? renderCompanies : renderSpaces));
}

// ---------- Compañías y espacios ----------
async function refreshCatalog() {
  [companies, spaces] = await Promise.all([api('/api/companies'), api('/api/spaces')]);
  $('#space-names').innerHTML = spaces.map((x) => `<option value="${esc(x.name)}">`).join('');
}
const fmtDay = (date) => cfg.days.find((d) => d.date === date)?.label ?? date;
const nTasks = (n) => `<span class="n ${n ? '' : 'zero'}">${n} ${n === 1 ? 'tarea' : 'tareas'}</span>`;

function renderCompanies() {
  const q = norm($('#companies-search').value.trim());
  const list = companies.filter((c) => !q || norm(c.name).includes(q) || c.shows.some((s) => norm(s.obra).includes(q)));
  $('#companies-count').textContent = `${list.length} de ${companies.length}`;
  $('#companies-cards').innerHTML = list.map((c) => {
    const obras = [...new Set(c.shows.map((s) => s.obra))];
    const discs = [...new Set(c.shows.map((s) => s.discipline))];
    return `<button class="card" data-company="${c.id}">
      <h3>${esc(c.name)}</h3>
      <div>${discs.map((d) => `<span class="disc">${esc(d)}</span>`).join('')}</div>
      ${obras.length && !(obras.length === 1 && obras[0] === c.name) ? `<div class="meta">${obras.map(esc).join(' · ')}</div>` : ''}
      <div class="foot"><span>${[...new Set(c.shows.map((s) => +s.date.slice(8)))].join(', ')} abr</span>${nTasks(c.task_count)}</div></button>`;
  }).join('') || '<div class="empty">Sin resultados</div>';
}

function renderSpaces() {
  const q = norm($('#spaces-search').value.trim());
  const list = spaces.filter((x) => !q || norm(x.name).includes(q));
  $('#spaces-count').textContent = `${list.length} de ${spaces.length}`;
  $('#spaces-cards').innerHTML = list.map((x) => `<button class="card" data-space="${esc(x.name)}">
    <h3>${esc(x.name)}</h3>
    <div>${x.areas.map((a) => `<span class="tag ${a}">${esc(cfg.areas[a])}</span>`).join(' ')}</div>
    <div class="foot"><span>${x.first_date === x.last_date ? fmtDay(x.first_date) : `${fmtDay(x.first_date)} → ${fmtDay(x.last_date)}`}</span>${nTasks(x.task_count)}</div></button>`).join('')
    || '<div class="empty">Sin resultados</div>';
}

function detailTasks(tasks, { showSpace, showCompanies }) {
  if (!tasks.length) return '<div class="empty">Todavía no hay tareas asignadas.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Día</th><th>Hora</th><th>Área</th>${showSpace ? '<th>Espacio</th>' : ''}<th>Tarea</th>
    <th class="num">Cubierto</th><th>Voluntarios</th><th></th></tr></thead><tbody>${tasks.map((t) => {
    const n = t.volunteers.length, cls = t.needed === 0 ? 'f3' : n === 0 ? 'f0' : n < t.needed ? 'f1' : 'f2';
    return `<tr><td>${fmtDay(t.date)}</td><td>${t.start}–${t.end}</td><td><span class="tag ${t.area}">${esc(cfg.areas[t.area])}</span></td>
      ${showSpace ? `<td>${esc(t.space)}</td>` : ''}
      <td><b>${esc(t.name)}</b>${showCompanies && t.companies.length ? `<div>${t.companies.map((c) => `<span class="cotag">${esc(c.name)}</span>`).join('')}</div>` : ''}</td>
      <td class="num"><span class="fill ${cls}">${n}/${t.needed}</span></td>
      <td class="v">${t.volunteers.map((v) => esc(v.nombre)).join(', ')}</td>
      <td><button data-goto="${t.date}" data-goto-task="${t.id}" title="Ver en la tabla de voluntarios">Ver ›</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

async function openDetail(kind, key) {
  let title, sub = '', body;
  if (kind === 'company') {
    const c = companies.find((x) => x.id === +key);
    const tasks = await api(`/api/companies/${c.id}/tasks`);
    title = c.name;
    sub = [...new Set(c.shows.map((s) => s.discipline))].join(' · ');
    body = `<h4>Programa</h4><table><tbody>${c.shows.map((s) => `<tr><td>${fmtDay(s.date)}</td><td>${s.time}</td><td><b>${esc(s.obra)}</b></td><td>${esc(s.venue)}</td></tr>`).join('')}</tbody></table>
      <h4>Tareas (${tasks.length})</h4>${detailTasks(tasks, { showSpace: true, showCompanies: false })}`;
  } else {
    const tasks = await api(`/api/spaces/tasks?name=${encodeURIComponent(key)}`);
    title = key; sub = `${tasks.length} tareas`;
    body = detailTasks(tasks, { showSpace: false, showCompanies: true });
  }
  $('#detail-title').textContent = title; $('#detail-sub').textContent = sub; $('#detail-body').innerHTML = body;
  $('#detail-dialog').showModal();
}

// ---------- Selector de aptitudes (mismo catálogo para tareas y personas) ----------
function renderSkillPicker(key) {
  const st = pickers[key];
  const chips = st.ids.map((id) => `<span>${esc(skillName(id))}<button type="button" data-sk-rm="${key}:${id}" title="Quitar">×</button></span>`).join('') || '<span class="none">Ninguna</span>';
  const opts = skills.filter((k) => !st.ids.includes(k.id)).map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $(`#sp-${key}`).innerHTML = `<div class="chips-in">${chips}</div>` + (st.other
    ? `<div class="other"><input data-sk-input="${key}" placeholder="Nueva aptitud…" maxlength="40"><button type="button" data-sk-save="${key}">Añadir</button><button type="button" data-sk-cancel="${key}" title="Cancelar">×</button></div>`
    : `<select data-sk-add="${key}"><option value="">+ Añadir aptitud…</option>${opts}<option value="__other">Otro…</option></select>`);
  if (st.other) $(`[data-sk-input="${key}"]`).focus();
}
const renderAllSkillPickers = () => { renderSkillPicker('task'); renderSkillPicker('person'); };
function setPicker(key, ids) { pickers[key] = { ids: [...ids], other: false }; renderSkillPicker(key); }

async function saveOtherSkill(key) {
  const name = $(`[data-sk-input="${key}"]`).value.trim();
  if (!name) return;
  const sk = await api('/api/skills', 'POST', { name });
  if (!skills.some((k) => k.id === sk.id)) skills.push(sk);
  if (!pickers[key].ids.includes(sk.id)) pickers[key].ids.push(sk.id);
  pickers[key].other = false;
  renderAllSkillPickers();
}

// ---------- Diálogo de persona ----------
const pdlg = $('#person-dialog'), pform = $('#person-form');
const DEFAULT_TEAMS = ['CUINA', 'NETEJA', 'BAR', 'TÉCNICA', 'VIDEO', 'TAQUILLA'];

function renderPersonDays() {
  $('#person-days').innerHTML = cfg.days.map((d) => { const v = pAv[d.date];
    return `<button type="button" data-pday="${d.date}" title="${d.label}"><span>${d.dow.slice(0, 1).toUpperCase()}${d.day}</span><i class="sq ${v === 1 ? 'on' : v === 0 ? 'off' : 'unk'}"></i></button>`; }).join('');
}

function openPerson(p) {
  editingPerson = p ? p.id : null;
  $('#person-dialog-title').textContent = p ? 'Editar persona' : 'Nueva persona';
  $('#person-delete').hidden = !p;
  $('#person-error').textContent = '';
  const groups = [...new Set(['VOLUNTARIAS', 'CASA', 'SIDE', ...people.map((x) => x.grupo).filter(Boolean)])];
  pform.elements.grupo.innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join('');
  const teams = [...new Set([...DEFAULT_TEAMS, ...people.flatMap(teamsOf)])];
  const mine = p ? teamsOf(p) : [];
  $('#person-teams').innerHTML = teams.map((t) => `<label><input type="checkbox" value="${esc(t)}" ${mine.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
  const v = p || { nombre: '', grupo: 'VOLUNTARIAS', aptitudes: '', por_confirmar: 0, skill_ids: [], av: {} };
  pform.elements.nombre.value = v.nombre;
  pform.elements.grupo.value = v.grupo || 'VOLUNTARIAS';
  pform.elements.aptitudes.value = v.aptitudes;
  pform.elements.horario.value = v.horario || 'indiferente';
  pform.elements.por_confirmar.checked = !!v.por_confirmar;
  pAv = Object.fromEntries(cfg.days.map((d) => [d.date, v.av[d.date] ?? null]));
  renderPersonDays();
  setPicker('person', v.skill_ids);
  pdlg.showModal();
}

pform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = pform.elements;
  const body = { nombre: f.nombre.value, grupo: f.grupo.value, horario: f.horario.value, aptitudes: f.aptitudes.value,
    por_confirmar: f.por_confirmar.checked, av: pAv, skill_ids: pickers.person.ids,
    equipo: [...document.querySelectorAll('#person-teams input:checked')].map((i) => i.value) };
  try {
    if (editingPerson) await api(`/api/people/${editingPerson}`, 'PUT', body); else await api('/api/people', 'POST', body);
    pdlg.close();
    await reloadPeople();
  } catch (err) { $('#person-error').textContent = err.message; }
});
$('#person-cancel').onclick = () => pdlg.close();
$('#person-delete').onclick = async () => {
  const p = people.find((x) => x.id === editingPerson);
  if (!confirm(`¿Eliminar a "${p.nombre}"? Se quitará también de las tareas a las que esté asignada/o.`)) return;
  try { await api(`/api/people/${p.id}`, 'DELETE'); pdlg.close(); await reloadPeople(); await loadTasks(); } catch (err) { $('#person-error').textContent = err.message; }
};
async function reloadPeople() {
  people = await api('/api/people');
  run(refreshConflicts());
  $('#people-names').innerHTML = people.map((p) => `<option value="${esc(p.nombre)}">`).join('');
  renderPeople();
  if (tasks.length) renderTasks();
}

// ---------- Diálogo de tarea ----------
function renderDlgCompanies() {
  const name = (id) => companies.find((c) => c.id === id)?.name ?? id;
  $('#task-companies').innerHTML = dlgCompanies.map((id) => `<span>${esc(name(id))}<button type="button" data-co-rm="${id}" title="Quitar">×</button></span>`).join('') || '<span style="color:var(--mute)">Sin compañía</span>';
  $('#task-company-add').innerHTML = '<option value="">+ Vincular compañía…</option>' + companies.filter((c) => !dlgCompanies.includes(c.id))
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

const dlg = $('#task-dialog'), form = $('#task-form');
function openTask(t) {
  editingId = t ? t.id : null;
  $('#task-dialog-title').textContent = t ? 'Editar tarea' : 'Nueva tarea';
  $('#repeat-wrap').hidden = !!t;
  $('#task-error').textContent = '';
  dlgCompanies = t ? t.companies.map((c) => c.id) : [];
  setPicker('task', t ? t.skills.map((k) => k.id) : []);
  renderDlgCompanies();
  const v = t || { area: [...areas][0] || 'cocina', date: selDay, start: '', end: '', name: '', space: '', needed: 1, responsible: '' };
  for (const k of ['area', 'date', 'start', 'end', 'name', 'space', 'needed', 'responsible']) form.elements[k].value = v[k];
  form.elements.repeatAllDays.checked = false;
  dlg.showModal();
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  body.repeatAllDays = form.elements.repeatAllDays.checked;
  body.company_ids = dlgCompanies;
  body.skill_ids = pickers.task.ids;
  try {
    if (editingId) await api(`/api/tasks/${editingId}`, 'PUT', body); else await api('/api/tasks', 'POST', body);
    dlg.close();
    if (body.date !== selDay && !body.repeatAllDays) await selectDay(body.date); else await loadTasks();
  } catch (err) { $('#task-error').textContent = err.message; }
});
$('#task-cancel').onclick = () => dlg.close();

// ---------- Eventos ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.view) showView(d.view);
  else if (d.day) selectDay(d.day);
  else if (d.area) { areas.has(d.area) ? areas.delete(d.area) : areas.add(d.area); store.set('areas', [...areas]); renderAreaFilter(); renderTasks(); }
  else if (d.team) { peopleTeams.has(d.team) ? peopleTeams.delete(d.team) : peopleTeams.add(d.team); store.set('peopleTeams', [...peopleTeams]); renderPeopleFilter(); renderPeople(); }
  else if (d.rm) { const [t, p] = d.rm.split(':'); run(api(`/api/tasks/${t}/volunteers/${p}`, 'DELETE').then(loadTasks)); }
  else if (d.edit) openTask(tasks.find((t) => t.id === +d.edit));
  else if (d.del) { const t = tasks.find((x) => x.id === +d.del); if (confirm(`¿Eliminar "${t.name}" (${t.start}–${t.end})? Se perderán sus voluntarios asignados.`)) run(api(`/api/tasks/${t.id}`, 'DELETE').then(loadTasks)); }
  else if (d.clock) setClock(clockMs + d.clock * 60000);
  else if (d.dup) run(api(`/api/tasks/${d.dup}/duplicate`, 'POST').then((r) => { flashId = r.id; return loadTasks(); }));
  else if (d.tskRm) { const [id, sid] = d.tskRm.split(':').map(Number); const t = tasks.find((x) => x.id === id); run(saveTask(t, { skill_ids: t.skills.map((k) => k.id).filter((k) => k !== sid) })); }
  else if (d.tskSave) run(saveTaskSkillOther(+d.tskSave));
  else if (d.tskCancel) { otherTask = null; renderTasks(); }
  else if (d.skRm) { const [k, id] = d.skRm.split(':'); pickers[k].ids = pickers[k].ids.filter((x) => x !== +id); renderSkillPicker(k); }
  else if (d.skSave) run(saveOtherSkill(d.skSave));
  else if (d.skCancel) { pickers[d.skCancel].other = false; renderSkillPicker(d.skCancel); }
  else if (d.pedit) openPerson(people.find((p) => p.id === +d.pedit));
  else if (d.pday) { const c = pAv[d.pday]; pAv[d.pday] = c === null ? 1 : c === 1 ? 0 : null; renderPersonDays(); }
  else if (d.pall !== undefined) { for (const day of cfg.days) pAv[day.date] = d.pall === '' ? null : +d.pall; renderPersonDays(); }
  else if (d.company) run(openDetail('company', d.company));
  else if (d.space) run(openDetail('space', d.space));
  else if (d.coRm) { dlgCompanies = dlgCompanies.filter((id) => id !== +d.coRm); renderDlgCompanies(); }
  else if (d.ptasks) run(openPersonTasks(+d.ptasks));
  else if (d.pskRm) { const [pid, sid] = d.pskRm.split(':').map(Number); const p = people.find((x) => x.id === pid); run(savePerson(p, { skill_ids: p.skill_ids.filter((k) => k !== sid) })); }
  else if (d.pskSave) run(savePersonSkillOther(+d.pskSave));
  else if (d.pskCancel) { pOther = null; renderPeople(); }
  else if (d.cand) run(openCandidates(+d.cand));
  else if (d.candAssign) { const [t, p, over] = d.candAssign.split(':').map(Number); run(api(`/api/tasks/${t}/volunteers`, 'POST', { person_id: p, accept_overtime: !!over })).finally(async () => { await loadTasks(); run(openCandidates(t)); }); }
  else if (d.cfxRm) { const [t, p] = d.cfxRm.split(':'); run(api(`/api/tasks/${t}/volunteers/${p}`, 'DELETE').then(loadTasks)); }
  else if (d.goto) { $('#detail-dialog').close(); $('#conflicts-dialog').close(); $('#assign-dialog').close(); showView('voluntarios'); run(goToTasks(d.goto, d.gotoTask)); }
});
document.addEventListener('change', (e) => {
  const s = e.target;
  if (s.dataset.pskAdd !== undefined && s.value) {
    const id = +s.dataset.pskAdd, p = people.find((x) => x.id === id);
    if (s.value === '__other') { pOther = id; renderPeople(true); }
    else run(savePerson(p, { skill_ids: [...p.skill_ids, +s.value] }));
    return;
  }
  if (s.dataset.tskAdd !== undefined && s.value) {
    const id = +s.dataset.tskAdd, t = tasks.find((x) => x.id === id);
    if (s.value === '__other') { otherTask = id; renderTasks(true); }
    else run(saveTask(t, { skill_ids: [...t.skills.map((k) => k.id), +s.value] }));
    return;
  }
  if (s.dataset.skAdd !== undefined && s.value) {
    const k = s.dataset.skAdd;
    if (s.value === '__other') pickers[k].other = true; else pickers[k].ids.push(+s.value);
    renderSkillPicker(k); return;
  }
  if (s.id === 'task-company-add' && s.value) { dlgCompanies.push(+s.value); renderDlgCompanies(); return; }
  if (s.dataset.add && s.value) run(api(`/api/tasks/${s.dataset.add}/volunteers`, 'POST', { person_id: +s.value })).finally(loadTasks);
});
$('#others-toggle').onclick = () => { showOtherTeams = !showOtherTeams; store.set('showOtherTeams', showOtherTeams); renderOthersToggle(); renderTasks(); };
$('#detail-close').onclick = () => $('#detail-dialog').close();
$('#companies-search').oninput = renderCompanies;
$('#spaces-search').oninput = renderSpaces;
document.addEventListener('keydown', (e) => {
  if (e.target.dataset?.pskInput) {
    if (e.key === 'Enter') { e.preventDefault(); run(savePersonSkillOther(+e.target.dataset.pskInput)); }
    else if (e.key === 'Escape') { pOther = null; renderPeople(); }
    return;
  }
  if (e.target.dataset?.tskInput) {
    if (e.key === 'Enter') { e.preventDefault(); run(saveTaskSkillOther(+e.target.dataset.tskInput)); }
    else if (e.key === 'Escape') { otherTask = null; renderTasks(); }
    return;
  }
  if (e.key === 'Enter' && e.target.dataset?.skInput) { e.preventDefault(); run(saveOtherSkill(e.target.dataset.skInput)); }
});
$('#load-toggle').onclick = () => { loadMode = !loadMode; store.set('loadMode', loadMode); run(refreshWorkload().then(renderPeople)); };
async function openCandidates(taskId) {
  const r = await api(`/api/tasks/${taskId}/candidates`);
  const t = r.task, h = (m) => fmtH(m) || '0';
  $('#detail-title').textContent = `Candidatos: ${t.name}`;
  $('#detail-sub').textContent = `${fmtDay(t.date)} · ${t.start}–${t.end} (${h(t.duration)} h) · ${cfg.areas[t.area]}${t.space ? ` · ${t.space}` : ''} · ${t.missing ? `faltan ${t.missing}` : 'ya está cubierta'}`;
  const busy = (o) => `<span class="busy"><span class="tag ${o.area}">${esc(cfg.areas[o.area])}</span> <b>${esc(o.name)}</b> ${o.start}–${o.end}${o.space ? ` · ${esc(o.space)}` : ''}</span>`;
  $('#detail-body').innerHTML = (r.candidates.length
    ? `<p class="cand-note">Personas disponibles ese día, del equipo ${t.uncovered.length ? `y con la aptitud que falta (${esc(t.uncovered.join(', '))}) ` : ''}que aún no están en esta tarea.${t.skills.length && !t.uncovered.length ? ' La aptitud pedida ya la aporta alguien de la tarea.' : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Persona</th><th>Estado</th><th>Qué hace ese día</th><th class="num">Horas</th><th></th></tr></thead><tbody>${r.candidates.map((c) => `<tr>
        <td><b>${esc(c.nombre)}</b>${c.horario_mismatch ? ' <span class="cst-hz" title="No es el momento del día apropiado para esta persona">⏰ horario</span>' : ''}<div>${c.teams.map((x) => `<span class="eq">${esc(x)}</span>`).join('')}${c.skills.map((x) => `<span class="apt">${esc(x)}</span>`).join('')}</div></td>
        <td><span class="cst ${c.status}">${{ libre: 'Libre', solape: 'Ocupada/o a esa hora', tope: `Pasaría de ${h(c.cap)} h` }[c.status]}</span>${c.status === 'solape' && c.over ? `<div class="hint">y además pasaría de ${h(c.cap)} h</div>` : ''}</td>
        <td>${c.blockers.length ? c.blockers.map(busy).join('') : c.tasks.length ? c.tasks.map(busy).join('') : '<span class="hint">Sin tareas ese día</span>'}</td>
        <td class="num">${h(c.minutes)} h → ${h(c.minutes + t.duration)} h</td>
        <td style="white-space:nowrap">${!t.missing ? '' : c.status === 'libre' ? `<button data-cand-assign="${t.id}:${c.id}">Asignar</button>`
          : c.status === 'tope' ? `<button class="danger" data-cand-assign="${t.id}:${c.id}:1" title="Asignar igualmente: ${esc(c.nombre)} pasará de ${h(c.cap)} h (${h(c.minutes + t.duration)} h ese día)">Resolver</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No hay nadie que cumpla las condiciones (disponible ese día, del equipo del área y con la aptitud pedida).</div>');
  $('#detail-dialog').showModal();
}

const KIND = { horario: 'Horario', ausente: 'Ausente', equipo: 'Otro equipo', aptitud: 'Sin aptitud', solape: 'Solape', horas: 'Más de 4 h' };
function renderConflicts() {
  const { unresolved: un, assignments: as, total } = conflicts;
  $('#conflicts-sub').textContent = total ? `${total} ${total === 1 ? 'conflicto' : 'conflictos'}` : '';
  if (!total) { $('#conflicts-body').innerHTML = '<div class="empty">No hay conflictos. 🎉</div>'; return; }
  const when = (x) => `<td>${fmtDay(x.date)}</td><td>${x.start}${x.end ? `–${x.end}` : ''}</td>`;
  const task = (x) => `<span class="tag ${x.area}">${esc(cfg.areas[x.area])}</span> <b>${esc(x.name ?? x.task_name)}</b>${x.space ? ` · ${esc(x.space)}` : ''}`;
  $('#conflicts-body').innerHTML =
    (un.length ? `<h4>Tareas sin cubrir (${un.length})</h4><div class="res-list"><table><thead><tr><th>Día</th><th>Hora</th><th>Tarea</th><th class="num">Faltan</th><th>Motivo</th><th></th></tr></thead><tbody>${un.map((u) =>
      `<tr>${when(u)}<td>${task(u)}</td><td class="num">${u.missing}</td><td>${esc(u.reason)}</td><td style="white-space:nowrap"><button data-cand="${u.task_id}">+ Detalles</button> <button data-goto="${u.date}" data-goto-task="${u.task_id}">Ver ›</button></td></tr>`).join('')}</tbody></table></div>` : '')
    + (as.length ? `<h4>Asignaciones con problemas (${as.length})</h4><div class="res-list"><table><thead><tr><th>Día</th><th>Hora</th><th>Persona</th><th>Problema</th><th>Tarea</th><th></th></tr></thead><tbody>${as.map((c) =>
      `<tr>${when(c)}<td><b>${esc(c.nombre)}</b></td><td><span class="kind ${c.kind}">${KIND[c.kind]}</span> ${esc(c.message)}</td><td>${c.task_id ? task(c) : ''}</td>
       <td style="white-space:nowrap"><button data-goto="${c.date}" data-goto-task="${(c.task_ids || [c.task_id]).filter(Boolean).join(',')}">Ver ›</button>${c.person_id ? ` <button data-cfx-rm="${c.task_id}:${c.person_id}" title="Quitar a esta persona de la tarea">Quitar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '');
}
$('#view-conflicts').onclick = () => { renderConflicts(); $('#conflicts-dialog').showModal(); };
$('#conflicts-close').onclick = () => $('#conflicts-dialog').close();
$('#auto-assign').onclick = () => {
  const day = cfg.days.find((d) => d.date === selDay);
  $('#assign-day-label').textContent = `Solo el día seleccionado (${day.label})`;
  $('#assign-areas').textContent = [...areas].map((a) => cfg.areas[a]).join(', ') || 'ninguna';
  $('#assign-form').hidden = false; $('#assign-result').hidden = true;
  $('#assign-form [name=replace]').checked = false; $('#assign-replace-warn').hidden = true;
  $('#assign-run').disabled = !areas.size;
  $('#assign-dialog').showModal();
};
$('#assign-form [name=replace]').onchange = (e) => { $('#assign-replace-warn').hidden = !e.target.checked; };
$('#assign-cancel').onclick = () => $('#assign-dialog').close();
$('#assign-run').onclick = async () => {
  const btn = $('#assign-run'); btn.disabled = true;
  try {
    const r = await api('/api/assign', 'POST', { scope: document.querySelector('#assign-form [name=scope]:checked').value, date: selDay,
      areas: [...areas], replace: $('#assign-form [name=replace]').checked });
    const slots = r.unresolved_slots;
    $('#assign-result').innerHTML = `<p class="res-sum"><b>${r.assigned}</b> asignaciones nuevas. ${r.unresolved.length
      ? `Quedan <b>${r.unresolved.length}</b> ${r.unresolved.length === 1 ? 'tarea sin resolver' : 'tareas sin resolver'} (${slots} ${slots === 1 ? 'hueco vacío' : 'huecos vacíos'}).`
      : 'No queda ninguna tarea sin resolver. 🎉'}</p>`
      + (r.time_mismatch ? `<p class="hint">${r.time_mismatch} ${r.time_mismatch === 1 ? 'asignación no respeta' : 'asignaciones no respetan'} el horario de la persona (madrugadorx / trasnochadorx); no había otra opción.</p>` : '')
      + (r.imbalanced ? `<p class="hint">${r.imbalanced} ${r.imbalanced === 1 ? 'asignación aumenta' : 'asignaciones aumentan'} el desequilibrio Técnica / Bar-Cocina de alguien que está en ambos grupos (no había otra opción).</p>` : '')
      + (r.unresolved.length ? `<div class="res-list"><table><thead><tr><th>Día</th><th>Hora</th><th>Tarea</th><th class="num">Faltan</th><th>Motivo</th><th></th></tr></thead><tbody>${r.unresolved.map((u) =>
        `<tr><td>${fmtDay(u.date)}</td><td>${u.start}–${u.end}</td><td><span class="tag ${u.area}">${esc(cfg.areas[u.area])}</span> <b>${esc(u.name)}</b>${u.space ? ` · ${esc(u.space)}` : ''}</td><td class="num">${u.missing}</td><td>${esc(u.reason)}</td><td><button data-cand="${u.task_id}">+ Detalles</button></td></tr>`).join('')}</tbody></table></div>` : '')
      + '<div class="actions"><button type="button" id="assign-close" class="primary">Cerrar</button></div>';
    $('#assign-form').hidden = true; $('#assign-result').hidden = false;
    $('#assign-close').onclick = () => $('#assign-dialog').close();
    await loadTasks();
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
};
$('#time-toggle').onclick = () => { showTime = !showTime; store.set('showTime', showTime); $('#time-toggle').classList.toggle('active', showTime); renderTasks(); };
$('#task-search').oninput = () => renderTasks();
$('#add-person').onclick = () => openPerson(null);
$('#add-task').onclick = () => openTask(null);
$('#people-search').oninput = renderPeople;
$('#clock-toggle').onclick = (e) => { e.stopPropagation(); const p = $('#clock-panel'); p.hidden = !p.hidden; $('#clock-toggle').setAttribute('aria-expanded', !p.hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('.clock')) $('#clock-panel').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#clock-panel').hidden = true; });
$('#clock-play').onclick = () => setPlaying(!playing);
$('#clock-reset').onclick = () => { setPlaying(false); setClock(Date.parse(CLOCK_START + ':00Z')); };
$('#clock-input').onchange = (e) => { const ms = Date.parse(e.target.value + ':00Z'); if (!isNaN(ms)) setClock(ms); };

// ---------- Arranque ----------
(async () => {
  [cfg, people] = await Promise.all([api('/api/config'), api('/api/people')]);
  skills = await api('/api/skills');
  await refreshCatalog();
  const fill = (sel, items) => { sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(''); };
  fill(form.elements.area, Object.entries(cfg.areas));
  fill(form.elements.date, cfg.days.map((d) => [d.date, d.label]));
  $('#people-names').innerHTML = people.map((p) => `<option value="${esc(p.nombre)}">`).join('');
  $('#clock-input').value = clockStr();
  $('#clock-toggle').title = `Reloj simulado: ${clockStr().replace('T', ' ')}`;
  renderAllSkillPickers();
  $('#time-toggle').classList.toggle('active', showTime);
  const known = new Set(store.get('knownAreas', ['cocina', 'bar', 'tecnica']));
  for (const k of Object.keys(cfg.areas)) if (!known.has(k)) areas.add(k);
  store.set('knownAreas', Object.keys(cfg.areas)); store.set('areas', [...areas]);
  renderAreaFilter(); renderPeopleFilter(); renderOthersToggle();
  const saved = store.get('day', null);
  const start = cfg.days.some((d) => d.date === clockDate()) ? clockDate() : saved && cfg.days.some((d) => d.date === saved) ? saved : cfg.days[0].date;
  await selectDay(start);
  showView(VIEWS.includes(view) ? view : 'voluntarios');
})().catch((e) => toast(e.message));
