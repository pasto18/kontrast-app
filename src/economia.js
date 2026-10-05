// Economía (versión simple): ingresos por espectáculo y gastos de comida, día a día.
// Ingresos = lo que corresponde a cada espectáculo de las entradas vendidas (los abonos y combinadas se reparten entre sus espectáculos).
// Gastos = comida: todas las personas presentes ese día (voluntarias/os e integrantes de compañías) × MEAL_COST_CENTS × número de comidas.
import { db } from './db.js';
import { DAYS, MEAL_COST_CENTS, MEALS } from './config.js';
import { taquilla } from './entradas.js';

export function economia() {
  const shows = taquilla().shows;
  const present = new Map(db.prepare('SELECT date, COUNT(*) n FROM availability WHERE present = 1 GROUP BY date').all().map((r) => [r.date, r.n]));
  const days = DAYS.map((d) => {
    const sh = shows.filter((s) => s.date === d.date).map((s) => ({ id: s.id, time: s.time, obra: s.obra, company: s.company, tickets: s.total, revenue_cents: s.revenue_cents }));
    const income = sh.reduce((n, s) => n + s.revenue_cents, 0);
    const people = present.get(d.date) || 0;
    const meals = MEALS.map((label) => ({ label, people, unit_cents: MEAL_COST_CENTS, total_cents: people * MEAL_COST_CENTS }));
    const expense = meals.reduce((n, m) => n + m.total_cents, 0);
    return { date: d.date, shows: sh, income_cents: income, people, meals, expense_cents: expense, balance_cents: income - expense };
  });
  const sum = (k) => days.reduce((n, d) => n + d[k], 0);
  return { meal_cost_cents: MEAL_COST_CENTS, meals: MEALS, days, totals: { income_cents: sum('income_cents'), expense_cents: sum('expense_cents'), balance_cents: sum('balance_cents') } };
}
