// Economía (versión simple): ingresos y gastos, día a día.
// Ingresos = lo que corresponde a cada espectáculo de las entradas vendidas (los abonos y combinadas se reparten entre sus espectáculos).
// Gastos = comida (todas las personas presentes ese día × MEAL_COST_CENTS × número de comidas)
//        + pago a las compañías (CACHE_PER_MEMBER_CENTS por integrante y por actuación, el día de cada espectáculo).
import { db } from './db.js';
import { DAYS, MEAL_COST_CENTS, MEALS, CACHE_PER_MEMBER_CENTS } from './config.js';
import { taquilla } from './entradas.js';

export function economia() {
  const shows = taquilla().shows;
  const present = new Map(db.prepare('SELECT date, COUNT(*) n FROM availability WHERE present = 1 GROUP BY date').all().map((r) => [r.date, r.n]));
  const members = new Map(db.prepare('SELECT company_id, COUNT(*) n FROM people WHERE company_id IS NOT NULL GROUP BY company_id').all().map((r) => [r.company_id, r.n]));
  const companyOf = new Map(db.prepare('SELECT id, company_id FROM shows').all().map((r) => [r.id, r.company_id]));
  const days = DAYS.map((d) => {
    const sh = shows.filter((s) => s.date === d.date).map((s) => {
      const n = members.get(companyOf.get(s.id)) || 0, cost = n * CACHE_PER_MEMBER_CENTS;
      return { id: s.id, time: s.time, obra: s.obra, company: s.company, tickets: s.total, revenue_cents: s.revenue_cents, members: n, cost_cents: cost, result_cents: s.revenue_cents - cost };
    });
    const income = sh.reduce((n, s) => n + s.revenue_cents, 0);
    const people = present.get(d.date) || 0;
    const meals = MEALS.map((label) => ({ label, people, unit_cents: MEAL_COST_CENTS, total_cents: people * MEAL_COST_CENTS }));
    const food = meals.reduce((n, m) => n + m.total_cents, 0);
    const cache = sh.reduce((n, s) => n + s.cost_cents, 0);
    return { date: d.date, shows: sh, income_cents: income, people, meals, food_cents: food, cache_cents: cache, expense_cents: food + cache, balance_cents: income - food - cache };
  });
  const sum = (k) => days.reduce((n, d) => n + d[k], 0);
  return {
    meal_cost_cents: MEAL_COST_CENTS, meals: MEALS, cache_per_member_cents: CACHE_PER_MEMBER_CENTS, days,
    totals: { income_cents: sum('income_cents'), food_cents: sum('food_cents'), cache_cents: sum('cache_cents'), expense_cents: sum('expense_cents'), balance_cents: sum('balance_cents') },
  };
}
