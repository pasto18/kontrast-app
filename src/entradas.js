// Taquilla: importación del export de la web de venta de entradas (CSV) y consultas.
// Columnas que se usan: No, id_order, order_name, order_surname, Nom assistent, Correu electronic, Tipologia d'entrada
// (y orderField, el nombre completo del comprador, cuando existe).
//
// Modelo:
//   buyers (comprador) 1─* orders (pedido) 1─* tickets (una fila del CSV = una entrada de un asistente)
//   attendees (asistente: nombre + correo) 1─* tickets
//   ticket_types (cada "Tipologia d'entrada" distinta, con su precio) *─* shows (a qué espectáculos da acceso)
import fs from 'node:fs';
import { db, applySeed, parseCsvLine } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER PRIMARY KEY,
  tipologia TEXT NOT NULL UNIQUE,   -- texto original del CSV, p. ej. "Dolores - My!Laika (12,00 €)"
  name TEXT NOT NULL,               -- sin el precio
  price_cents INTEGER,
  kind TEXT NOT NULL                -- entrada | combo | abono
);
CREATE TABLE IF NOT EXISTS ticket_type_shows (
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_type_id, show_id)
);
CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  nombre_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,           -- id_order del CSV
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  order_name TEXT NOT NULL DEFAULT '',
  order_surname TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  no INTEGER,                       -- columna "No" del CSV
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
  ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE
);
-- Reparto de lo pagado por cada entrada entre los espectáculos a los que da acceso (una fila por entrada y espectáculo).
CREATE TABLE IF NOT EXISTS ticket_allocations (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, show_id)
);
CREATE INDEX IF NOT EXISTS alloc_show ON ticket_allocations(show_id);
CREATE INDEX IF NOT EXISTS tickets_type ON tickets(ticket_type_id);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
`);

const norm = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const D = (n) => `2025-04-${String(n).padStart(2, '0')}`;

// ---- A qué espectáculo(s) da acceso cada entrada suelta. [patrón del nombre, [[día, patrón de la obra, hora?], …]]
const SUELTAS = [
  [/^Dinar popular \+ Esperit/i, [[19, /^Dinar Popular/], [19, /^Esperit/]]],
  [/^Dinar popular \+ Inutile/i, [[12, /^Dinar Popular/], [12, /^Inutile/]]],
  [/^Perd[oó]n/i, [[18, /^Perd/]]],
  [/\(ds\. 18\/4\)/, [[18, /^D[ée]crochez/]]], [/\(dv\. 17\/4\)/, [[17, /^D[ée]crochez/]]],
  [/\(dg\. 12\/4\)/, [[12, /^D[ée]crochez/]]], [/\(dv\. 10\/4\)/, [[10, /^D[ée]crochez/]]],
  [/^Perera Elsewhere/i, [[18, /^Perera/]]],
  [/^Dolores/i, [[11, /^Dolores/]]],
  [/^Adeus/i, [[18, /^Adeus/]]],
  [/^Kabaret/i, [[19, /^Kabaret/]]],
  [/^Konvent Klub/i, [[11, /^Konvent Klub/]]],
  [/^ROSE BIF/i, [[11, /^Rose Bif/i]]],
  [/^Rubbish Rabbit/i, [[19, /^Rubbish/]]],
  [/^Chou chou/i, [[17, /^Chou chou/i]]],
  [/^Walk in Progress/i, [[11, /^Walk in Progress/]]],
  [/\(18\.00h\)/, [[18, /^R[òo]dols/i, '18:00']]], [/\(15\.30h\)/, [[18, /^R[òo]dols/i, '15:30']]],
  [/^Muovipussi/i, [[17, /^Muovipussi/]]],
  [/^CRU LAB/i, [[12, /^Cru Lab/i]]],
  [/^Ara o mai/i, [[19, /^Ara o Mai/i]]],
  [/^Eclipse/i, [[17, /^Eclipse/]]],
  [/^ERREURJEAN/i, [[10, /^Compost/]]],
  [/^Queerass/i, [[16, /^Queerass/]]],
  [/^Wander/i, [[16, /^Wander/]]],
  [/^Coconauta/i, [[16, /^Modern Nature/]]],
];
// ---- Abonos: días que cubren y exclusiones. Un abono da acceso a los espectáculos de esos días que tienen entrada suelta propia
// (no a los combinados con el dinar, ni a los gratuitos), salvo los "excepte …".
const ABONOS = [
  [/^Abonament divendres 10/i, [10], []], [/^Abonament dissabte 11/i, [11], []], [/^Abonament diumenge 12/i, [12], []],
  [/^Abonament 1r cap de setmana/i, [10, 11, 12], []],
  [/^Abonament dijous 16/i, [16], []], [/^Abonament divendres 17/i, [17], []],
  [/^Abonament dissabte 18.*excepte Escarlata/i, [18], [/^R[òo]dols/i]],
  [/^Abonament diumenge 19.*excepte The Sinner/i, [19], [/^The Sinner/i]],
  [/^Abonament 2n cap de setmana/i, [17, 18, 19], []], // supuesto: viernes a domingo del 2.º fin de semana
];

function parseTipologia(t) {
  const m = /^(.*) \(([\d.,]+) €\)$/.exec(t.trim());
  const name = m ? m[1].trim() : t.trim();
  const price = m ? Math.round(parseFloat(m[2].replace('.', '').replace(',', '.')) * 100) : null;
  const kind = /^Abonament/i.test(name) ? 'abono' : /^Dinar popular/i.test(name) ? 'combo' : 'entrada';
  return { name, price, kind };
}

function showsOf(rules, name, shows) {
  for (const [re, targets] of rules) {
    if (!re.test(name)) continue;
    return targets.flatMap(([day, obra, time]) => shows.filter((s) => s.date === D(day) && obra.test(s.obra) && (!time || s.time === time)));
  }
  return null;
}

export function importEntradas(csvPath, { transaction = true } = {}) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const h = parseCsvLine(lines[0]).map((x) => x.trim());
  const col = Object.fromEntries(['No', 'id_order', 'order_name', 'order_surname', 'Nom assistent', 'Correu electronic', "Tipologia d'entrada", 'orderField'].map((n) => [n, h.indexOf(n)]));
  for (const [n, i] of Object.entries(col)) if (i < 0 && n !== 'orderField') throw new Error(`Falta la columna "${n}" en el CSV`);
  const shows = db.prepare('SELECT * FROM shows').all();

  if (transaction) db.exec('BEGIN');
  try {
    for (const t of ['ticket_allocations', 'tickets', 'attendees', 'orders', 'buyers', 'ticket_type_shows', 'ticket_types']) db.exec(`DELETE FROM ${t}`);
    const insType = db.prepare('INSERT INTO ticket_types (tipologia, name, price_cents, kind) VALUES (?,?,?,?)');
    const insBuyer = db.prepare('INSERT INTO buyers (nombre, nombre_key) VALUES (?,?)');
    const insOrder = db.prepare('INSERT INTO orders (id, buyer_id, order_name, order_surname) VALUES (?,?,?,?)');
    const insAtt = db.prepare('INSERT INTO attendees (nombre, email, key) VALUES (?,?,?)');
    const insTicket = db.prepare('INSERT INTO tickets (no, order_id, attendee_id, ticket_type_id) VALUES (?,?,?,?)');
    const types = new Map(), buyers = new Map(), orders = new Map(), atts = new Map();
    const sinMapa = new Set();

    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line), g = (n) => (c[col[n]] ?? '').trim();
      const tip = g("Tipologia d'entrada"), attendee = g('Nom assistent');
      if (!tip || !g('id_order')) continue;
      // tipo de entrada
      if (!types.has(tip)) { const p = parseTipologia(tip); types.set(tip, Number(insType.run(tip, p.name, p.price, p.kind).lastInsertRowid)); }
      // comprador del pedido: orderField, o nombre + apellidos, o (si falta) el primer asistente del pedido
      const oid = +g('id_order');
      if (!orders.has(oid)) {
        const nombre = g('orderField') || `${g('order_name')} ${g('order_surname')}`.trim() || attendee;
        const key = norm(nombre);
        if (!buyers.has(key)) buyers.set(key, Number(insBuyer.run(nombre, key).lastInsertRowid));
        insOrder.run(oid, buyers.get(key), g('order_name'), g('order_surname'));
        orders.set(oid, buyers.get(key));
      }
      // asistente (nombre + correo)
      const akey = `${norm(attendee)}|${g('Correu electronic').toLowerCase()}`;
      if (!atts.has(akey)) atts.set(akey, Number(insAtt.run(attendee, g('Correu electronic'), akey).lastInsertRowid));
      insTicket.run(+g('No') || null, oid, atts.get(akey), types.get(tip));
    }

    // a qué espectáculos da acceso cada tipo
    const link = db.prepare('INSERT OR IGNORE INTO ticket_type_shows (ticket_type_id, show_id) VALUES (?,?)');
    const parsed = [...types].map(([tip, id]) => ({ tip, id, ...parseTipologia(tip) }));
    const ticketed = new Set(); // espectáculos con entrada suelta propia
    for (const t of parsed.filter((x) => x.kind !== 'abono')) {
      const ss = showsOf(SUELTAS, t.name, shows);
      if (!ss || !ss.length) { sinMapa.add(t.tip); continue; }
      for (const s of ss) { link.run(t.id, s.id); if (t.kind === 'entrada') ticketed.add(s.id); }
    }
    for (const t of parsed.filter((x) => x.kind === 'abono')) {
      const rule = ABONOS.find(([re]) => re.test(t.name));
      if (!rule) { sinMapa.add(t.tip); continue; }
      for (const s of shows) if (rule[1].some((d) => s.date === D(d)) && ticketed.has(s.id) && !rule[2].some((re) => re.test(s.obra))) link.run(t.id, s.id);
    }
    computeAllocations();
    if (transaction) db.exec('COMMIT');
    return { tickets: lines.length - 1, types: types.size, orders: orders.size, buyers: buyers.size, attendees: atts.size, sinMapa: [...sinMapa] };
  } catch (e) { if (transaction) db.exec('ROLLBACK'); throw e; }
}

// Reparte el precio de cada entrada a partes iguales entre los espectáculos a los que da acceso
// (una entrada suelta: todo para su espectáculo; combinada o abono: precio ÷ nº de espectáculos).
// Los céntimos sobrantes se dan de uno en uno a los primeros espectáculos, para que la suma sea exactamente el precio.
export function computeAllocations() {
  db.exec('DELETE FROM ticket_allocations');
  const showsOf = new Map();
  for (const r of db.prepare(`SELECT l.ticket_type_id, l.show_id FROM ticket_type_shows l JOIN shows s ON s.id = l.show_id ORDER BY s.date, s.time, s.id`).all())
    (showsOf.get(r.ticket_type_id) || showsOf.set(r.ticket_type_id, []).get(r.ticket_type_id)).push(r.show_id);
  const price = new Map(db.prepare('SELECT id, price_cents FROM ticket_types').all().map((t) => [t.id, t.price_cents]));
  const ins = db.prepare('INSERT INTO ticket_allocations (ticket_id, show_id, amount_cents) VALUES (?,?,?)');
  for (const t of db.prepare('SELECT id, ticket_type_id FROM tickets').all()) {
    const ss = showsOf.get(t.ticket_type_id) || [], p = price.get(t.ticket_type_id);
    if (!ss.length || p == null) continue;
    const base = Math.floor(p / ss.length), rest = p - base * ss.length;
    ss.forEach((sid, i) => ins.run(t.id, sid, base + (i < rest ? 1 : 0)));
  }
}

// Primera carga automática desde data/seed/entradas.csv (una sola vez; para recargar: npm run import-entradas -- archivo.csv).
export function seedEntradasIfNeeded(csvPath) {
  applySeed('entradas-v1', () => {
    if (!fs.existsSync(csvPath)) return;
    const r = importEntradas(csvPath, { transaction: false }); // applySeed ya abre su propia transacción
    if (r.sinMapa.length) console.warn(`Entradas sin espectáculo asociado: ${r.sinMapa.join(' | ')}`);
  });
  // Bases cargadas antes de existir el reparto de la recaudación.
  applySeed('entradas-reparto-v1', () => { if (db.prepare('SELECT COUNT(*) n FROM tickets').get().n) computeAllocations(); });
}

// ---- Consultas ----
export function taquilla() {
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const types = db.prepare(`SELECT tt.id, tt.tipologia, tt.name, tt.price_cents, tt.kind, COUNT(t.id) AS count
    FROM ticket_types tt LEFT JOIN tickets t ON t.ticket_type_id = tt.id GROUP BY tt.id ORDER BY tt.kind = 'abono', tt.name, tt.price_cents`).all();
  const cover = new Map();
  for (const r of db.prepare('SELECT ticket_type_id, show_id FROM ticket_type_shows').all()) (cover.get(r.ticket_type_id) || cover.set(r.ticket_type_id, []).get(r.ticket_type_id)).push(r.show_id);
  const byType = new Map(types.map((t) => [t.id, t]));
  // recaudación (reparto) por espectáculo y tipo de entrada
  const money = new Map();
  for (const r of db.prepare(`SELECT ta.show_id, t.ticket_type_id, COUNT(*) AS n, SUM(ta.amount_cents) AS cents
    FROM ticket_allocations ta JOIN tickets t ON t.id = ta.ticket_id GROUP BY ta.show_id, t.ticket_type_id`).all())
    (money.get(r.show_id) || money.set(r.show_id, []).get(r.show_id)).push({ id: r.ticket_type_id, count: r.n, amount_cents: r.cents });
  const shows = db.prepare(`SELECT s.*, c.name AS company FROM shows s JOIN companies c ON c.id = s.company_id ORDER BY s.date, s.time`).all().map((s) => {
    const ts = (money.get(s.id) || []).sort((a, b) => b.amount_cents - a.amount_cents);
    const sum = (f, k) => ts.filter((x) => f(byType.get(x.id))).reduce((n, x) => n + x[k], 0);
    return { id: s.id, date: s.date, time: s.time, obra: s.obra, company: s.company, venue: s.venue, discipline: s.discipline,
      total: sum(() => true, 'count'), sueltas: sum((t) => t.kind !== 'abono', 'count'), abonos: sum((t) => t.kind === 'abono', 'count'),
      revenue_cents: sum(() => true, 'amount_cents'), revenue_sueltas_cents: sum((t) => t.kind !== 'abono', 'amount_cents'), revenue_abonos_cents: sum((t) => t.kind === 'abono', 'amount_cents'),
      types: ts };
  });
  const total = db.prepare('SELECT COALESCE(SUM(tt.price_cents), 0) AS c FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id').get().c;
  const allocated = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ticket_allocations').get().c;
  return {
    summary: { tickets: count('tickets'), orders: count('orders'), buyers: count('buyers'), attendees: count('attendees'), revenue_cents: total, allocated_cents: allocated },
    types: types.map((t) => { const ids = cover.get(t.id) || []; return { ...t, show_ids: ids, n_shows: ids.length, revenue_cents: (t.price_cents ?? 0) * t.count }; }),
    shows,
  };
}

// Entradas de un tipo (p. ej. un abono), cada una con su reparto entre espectáculos, para poder revisar la división.
export function ticketsOfType(typeId) {
  const type = db.prepare('SELECT * FROM ticket_types WHERE id = ?').get(typeId);
  if (!type) return null;
  const rows = db.prepare(`SELECT t.id, t.no, t.order_id, b.nombre AS buyer, a.nombre AS attendee, a.email
    FROM tickets t JOIN orders o ON o.id = t.order_id JOIN buyers b ON b.id = o.buyer_id JOIN attendees a ON a.id = t.attendee_id
    WHERE t.ticket_type_id = ? ORDER BY a.nombre, t.id`).all(typeId);
  const al = new Map();
  for (const r of db.prepare(`SELECT ta.ticket_id, ta.show_id, ta.amount_cents, s.date, s.time, s.obra FROM ticket_allocations ta
    JOIN tickets t ON t.id = ta.ticket_id JOIN shows s ON s.id = ta.show_id WHERE t.ticket_type_id = ? ORDER BY s.date, s.time`).all(typeId))
    (al.get(r.ticket_id) || al.set(r.ticket_id, []).get(r.ticket_id)).push({ show_id: r.show_id, obra: r.obra, date: r.date, time: r.time, amount_cents: r.amount_cents });
  return { type, tickets: rows.map((t) => ({ ...t, allocations: al.get(t.id) || [] })) };
}

// Compradores y asistentes por nombre o correo: cada comprador con sus pedidos, los asistentes de cada pedido y las entradas de cada uno.
export function searchBuyers(q) {
  const tokens = norm(q).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const rows = db.prepare(`SELECT b.id AS buyer_id, b.nombre AS buyer, o.id AS order_id, a.id AS att_id, a.nombre AS att, a.email, tt.tipologia
    FROM tickets t JOIN orders o ON o.id = t.order_id JOIN buyers b ON b.id = o.buyer_id
    JOIN attendees a ON a.id = t.attendee_id JOIN ticket_types tt ON tt.id = t.ticket_type_id ORDER BY b.nombre, o.id, a.nombre`).all();
  const hit = new Set();
  for (const r of rows) { const hay = norm(`${r.buyer} ${r.att} ${r.email}`); if (tokens.every((k) => hay.includes(k))) hit.add(r.buyer_id); }
  const out = new Map();
  for (const r of rows) {
    if (!hit.has(r.buyer_id)) continue;
    const b = out.get(r.buyer_id) || out.set(r.buyer_id, { id: r.buyer_id, nombre: r.buyer, orders: new Map(), tickets: 0 }).get(r.buyer_id);
    const o = b.orders.get(r.order_id) || b.orders.set(r.order_id, { id: r.order_id, attendees: new Map() }).get(r.order_id);
    const a = o.attendees.get(r.att_id) || o.attendees.set(r.att_id, { id: r.att_id, nombre: r.att, email: r.email, tickets: [] }).get(r.att_id);
    a.tickets.push(r.tipologia); b.tickets++;
  }
  return [...out.values()].slice(0, 30).map((b) => ({ ...b, orders: [...b.orders.values()].map((o) => ({ ...o, attendees: [...o.attendees.values()] })) }));
}
