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
  taquilla: 'Taquilla',
};

// Tareas fijas de Cocina y limpieza, repetidas cada día.
export const COCINA_FIJAS = [
  { start: '08:30', end: '10:30', name: 'Esmorzar', needed: 1 },
  { start: '10:00', end: '13:30', name: 'Dinar', needed: 2 },
  { start: '14:30', end: '16:00', name: 'Neteja DINAR', needed: 2 },
  { start: '17:00', end: '20:30', name: 'Sopar', needed: 2 },
  { start: '22:00', end: '23:30', name: 'Neteja SOPAR', needed: 2 },
];

// Un equipo de la hoja de voluntarios puede cubrir una o más áreas de tareas.
export const AREA_TEAMS = { cocina: ['CUINA', 'NETEJA'], bar: ['BAR'], tecnica: ['TÉCNICA'], taquilla: ['TAQUILLA'] };
// Áreas en las que SOLO puede trabajar gente de su equipo (el servidor rechaza al resto).
export const STRICT_AREAS = ['taquilla'];
// Turno de taquilla automático por espectáculo: desde 1 h antes hasta 30 min después del inicio.
export const TAQUILLA = { before: 60, after: 30, needed: 3 };
// Disciplinas del programa que no son espectáculos y no llevan taquilla.
export const SIN_TAQUILLA = ['DINAR', 'XERRADA'];
// Tope de horas que una persona puede trabajar en un día (lo respeta el asignador automático).
export const MAX_DAILY_MINUTES = 240;

// Los dos grandes grupos de la hoja de voluntarios: Bar/Neteja/Cuina ("cb") y Técnica ("t").
export const AREA_GROUP = { cocina: 'cb', bar: 'cb', tecnica: 't', taquilla: null };
