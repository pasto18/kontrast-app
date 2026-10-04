'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// ---------- Equipos ↔ áreas ----------
const AREA_TEAMS = { cocina: ['CUINA', 'NETEJA'], bar: ['BAR'], tecnica: ['TÉCNICA'] };
const teamsOf = (p) => p.equipo.split(',').map((s) => s.trim()).filter(Boolean);
const fitsArea = (p, area) => teamsOf(p).some((t) => AREA_TEAMS[area].includes(t));

// ---------- Estado ----------
let cfg, people = [], tasks = [];
let selDay = null, view = store.get('view', 'voluntarios');
let areas = new Set(store.get('areas', ['cocina', 'bar', 'tecnica']));
let peopleTeams = new Set(store.get('peopleTeams', []));
let editingId = null;
let companies = [], spaces = [], dlgCompanies = [];
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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }
const run = (p) => p.catch((e) => { toast(e.message); });

async function loadTasks() { tasks = await api(`/api/tasks?date=${selDay}`); renderTasks(); }
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

function pickerOptions(t) {
  const assigned = new Set(t.volunteers.map((v) => v.id));
  const busyWith = (p) => tasks.find((o) => o.id !== t.id && overlaps(o, t) && o.volunteers.some((v) => v.id === p.id));
  const opt = (p) => {
    const b = busyWith(p);
    const teams = teamsOf(p).join('/');
    return `<option value="${p.id}">${esc(p.nombre)}${teams ? ` · ${esc(teams)}` : ''}${b ? ` ⚠ solapa con ${esc(b.name)}` : ''}</option>`;
  };
  const present = people.filter((p) => !assigned.has(p.id) && p.av[t.date] === 1);
  const groups = [['Equipo coincide', present.filter((p) => fitsArea(p, t.area))]];
  if (showOtherTeams) groups.push(['Otros equipos', present.filter((p) => !fitsArea(p, t.area))]);
  return '<option value="">+ Añadir…</option>' + groups.filter(([, l]) => l.length)
    .map(([label, l]) => `<optgroup label="${label}">${l.map(opt).join('')}</optgroup>`).join('');
}

// Un hueco por voluntario necesario: el tamaño de la fila no cambia al asignar.
function slots(t) {
  const out = t.volunteers.map((v) => `<div class="slot"><span class="vol">${esc(v.nombre)}</span><button data-rm="${t.id}:${v.id}" title="Quitar">×</button></div>`);
  for (let i = t.volunteers.length; i < t.needed; i++) {
    out.push(i === t.volunteers.length
      ? `<div class="slot"><select data-add="${t.id}">${pickerOptions(t)}</select></div>`
      : '<div class="slot free">libre</div>');
  }
  return out.join('');
}

function renderTasks() {
  const rows = tasks.filter((t) => areas.has(t.area));
  const head = `<thead><tr><th>Inicio</th><th>Fin</th><th class="num">Dur.</th><th>Área</th><th>Espacio</th><th>Tarea</th>
    <th class="num nec" title="Voluntarios necesarios">Nec.</th><th>Responsable</th><th class="est"></th><th>Voluntarios</th><th></th></tr></thead>`;
  if (!rows.length) { $('#tasks-table').innerHTML = head + `<tbody><tr><td colspan="11" class="empty">No hay tareas para este día con los filtros actuales.</td></tr></tbody>`; return; }
  $('#tasks-table').innerHTML = head + '<tbody>' + rows.map((t) => {
    const st = taskStatus(t), n = t.volunteers.length;
    const cls = t.needed === 0 ? 'f3' : n === 0 ? 'f0' : n < t.needed ? 'f1' : 'f2';
    return `<tr class="${st === 'future' ? '' : st}">
      <td>${t.start}${st === 'now' ? '<span class="badge live">EN CURSO</span>' : ''}</td><td>${t.end}</td>
      <td class="num">${fmtDur(t)}</td>
      <td><span class="tag ${t.area}">${esc(cfg.areas[t.area])}</span></td>
      <td>${esc(t.space)}</td><td><b>${esc(t.name)}</b>${t.companies.length ? `<div>${t.companies.map((c) => `<span class="cotag">${esc(c.name)}</span>`).join("")}</div>` : ""}</td>
      <td class="num nec">${t.needed}</td><td>${esc(t.responsible)}</td>
      <td class="est"><span class="fill ${cls}">${n}/${t.needed}</span></td>
      <td><div class="slots">${slots(t)}</div></td>
      <td><button class="icon" data-edit="${t.id}" title="Editar">✎</button>
          <button class="icon" data-del="${t.id}" title="Eliminar">🗑</button></td></tr>`;
  }).join('') + '</tbody>';
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
  $('#people-filter').innerHTML = ['CUINA', 'NETEJA', 'BAR', 'TÉCNICA', 'VIDEO', 'BILLETERÍA']
    .map((t) => `<button data-team="${t}" class="${peopleTeams.has(t) ? 'active' : ''}">${t}</button>`).join('');
}

function renderPeople() {
  const q = $('#people-search').value.trim().toLowerCase();
  const list = people.filter((p) => (!q || p.nombre.toLowerCase().includes(q))
    && (!peopleTeams.size || teamsOf(p).some((t) => peopleTeams.has(t))));
  const days = cfg.days;
  const head = `<thead><tr><th>Nombre</th><th>Grupo</th><th>Equipo</th><th class="num">Dispo</th>
    ${days.map((d) => `<th class="d" title="${d.label}">${d.dow.slice(0, 1).toUpperCase()}<br>${d.day}</th>`).join('')}<th>Aptitudes</th></tr></thead>`;
  const tot = `<tr class="tot"><td colspan="4" style="text-align:right">Presentes por día (lista filtrada)</td>
    ${days.map((d) => `<td>${list.filter((p) => p.av[d.date] === 1).length}</td>`).join('')}<td></td></tr>`;
  $('#people-table').innerHTML = head + '<tbody>' + tot + list.map((p) => `<tr>
    <td><b>${esc(p.nombre)}</b>${p.por_confirmar ? ' <span class="conf">POR CONFIRMAR</span>' : ''}</td>
    <td>${esc(p.grupo)}</td>
    <td>${teamsOf(p).map((t) => `<span class="eq ${esc(t)}">${esc(t)}</span>`).join('')}</td>
    <td class="num">${p.dispo ?? ''}${p.dispo ? '%' : ''}</td>
    ${days.map((d) => { const v = p.av[d.date]; return `<td class="d"><i class="sq ${v === 1 ? 'on' : v === 0 ? 'off' : 'unk'}" title="${d.label}: ${v === 1 ? 'está' : v === 0 ? 'no está' : 'sin datos'}"></i></td>`; }).join('')}
    <td>${esc(p.aptitudes)}</td></tr>`).join('') + '</tbody>';
}

function showView(v) {
  view = v; store.set('view', v);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  for (const k of VIEWS) $(`#view-${k}`).hidden = k !== v;
  if (v === 'personas') renderPeople();
  else if (v === 'voluntarios') renderTasks();
  else run(refreshCatalog().then(v === 'companias' ? renderCompanies : renderSpaces));
}

// ---------- Compañías y espacios ----------
async function refreshCatalog() {
  [companies, spaces] = await Promise.all([api('/api/companies'), api('/api/spaces')]);
  $('#space-names').innerHTML = spaces.map((x) => `<option value="${esc(x.name)}">`).join('');
}
const fmtDay = (date) => cfg.days.find((d) => d.date === date)?.label ?? date;
const norm = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
      <td><button data-goto="${t.date}" title="Ver en la tabla de voluntarios">Ver ›</button></td></tr>`;
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
  else if (d.company) run(openDetail('company', d.company));
  else if (d.space) run(openDetail('space', d.space));
  else if (d.coRm) { dlgCompanies = dlgCompanies.filter((id) => id !== +d.coRm); renderDlgCompanies(); }
  else if (d.goto) { $('#detail-dialog').close(); showView('voluntarios'); selectDay(d.goto); }
});
document.addEventListener('change', (e) => {
  const s = e.target;
  if (s.id === 'task-company-add' && s.value) { dlgCompanies.push(+s.value); renderDlgCompanies(); return; }
  if (s.dataset.add && s.value) run(api(`/api/tasks/${s.dataset.add}/volunteers`, 'POST', { person_id: +s.value })).finally(loadTasks);
});
$('#others-toggle').onclick = () => { showOtherTeams = !showOtherTeams; store.set('showOtherTeams', showOtherTeams); renderOthersToggle(); renderTasks(); };
$('#detail-close').onclick = () => $('#detail-dialog').close();
$('#companies-search').oninput = renderCompanies;
$('#spaces-search').oninput = renderSpaces;
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
  await refreshCatalog();
  const fill = (sel, items) => { sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(''); };
  fill(form.elements.area, Object.entries(cfg.areas));
  fill(form.elements.date, cfg.days.map((d) => [d.date, d.label]));
  $('#people-names').innerHTML = people.map((p) => `<option value="${esc(p.nombre)}">`).join('');
  $('#clock-input').value = clockStr();
  $('#clock-toggle').title = `Reloj simulado: ${clockStr().replace('T', ' ')}`;
  renderAreaFilter(); renderPeopleFilter(); renderOthersToggle();
  const saved = store.get('day', null);
  const start = cfg.days.some((d) => d.date === clockDate()) ? clockDate() : saved && cfg.days.some((d) => d.date === saved) ? saved : cfg.days[0].date;
  await selectDay(start);
  showView(VIEWS.includes(view) ? view : 'voluntarios');
})().catch((e) => toast(e.message));
