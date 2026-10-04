# Kontrast · gestión del festival

Primer módulo: **voluntarios** (tabla de tareas por día + listado de personas con su disponibilidad).

```bash
npm install
npm start          # http://localhost:3000
npm run reset-db   # borra la BD; se recrea desde data/seed/ al arrancar
```

- Node ≥ 22.13 (usa `node:sqlite`), Express, frontend sin build en `public/`.
- BD: `data/kontrast.db` (se crea sola). Datos iniciales: `data/seed/voluntarios.csv` y las tareas fijas de `src/config.js`.
- Áreas: `cocina` (Cocina y limpieza), `bar`, `tecnica`. Hoy solo hay tareas de cocina.
- El reloj simulado vive en el navegador (localStorage); empieza el lunes 6 a las 08:00.
