// Calendario del festival (año simulado). Las etiquetas de día de la semana
// son fijas porque el festival arranca en "lunes 6".
export const FESTIVAL_YEAR = 2025;
export const FESTIVAL_MONTH = 4;
export const FIRST_DAY = 6;
export const DAY_COUNT = 14; // 6 → 19 de abril
const DOW = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export const DAYS = Array.from({ length: DAY_COUNT }, (_, i) => {
  const n = FIRST_DAY + i;
  const mm = String(FESTIVAL_MONTH).padStart(2, '0');
  const dow = DOW[i % 7];
  return {
    date: `${FESTIVAL_YEAR}-${mm}-${String(n).padStart(2, '0')}`,
    day: n,
    dow,
    label: `${dow} ${n}`,
  };
});

export const AREAS = {
  cocina: 'Cocina y limpieza',
  bar: 'Bar',
  tecnica: 'Técnica',
};

// Tareas fijas de Cocina y limpieza, repetidas cada día.
export const COCINA_FIJAS = [
  { start: '08:30', end: '10:30', name: 'Esmorzar', needed: 1 },
  { start: '10:00', end: '13:30', name: 'Dinar', needed: 2 },
  { start: '14:30', end: '16:00', name: 'Neteja DINAR', needed: 2 },
  { start: '17:00', end: '20:30', name: 'Sopar', needed: 2 },
  { start: '22:00', end: '23:30', name: 'Neteja SOPAR', needed: 2 },
];
