// Uso: npm run import-entradas -- ruta/al/export.csv   (sustituye todas las entradas, pedidos, compradores y asistentes)
import './db.js';
import { seedIfEmpty } from './db.js';
import { importEntradas } from './entradas.js';
seedIfEmpty();
const file = process.argv[2];
if (!file) { console.error('Indica el CSV: npm run import-entradas -- archivo.csv'); process.exit(1); }
const r = importEntradas(file);
console.log(`Importado: ${r.tickets} entradas, ${r.types} tipos, ${r.orders} pedidos, ${r.buyers} compradores, ${r.attendees} asistentes.`);
if (r.sinMapa.length) console.log('Sin espectáculo asociado:\n - ' + r.sinMapa.join('\n - '));
