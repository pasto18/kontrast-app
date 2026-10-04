# Kontrast · gestión del festival

Primer módulo: **voluntarios** (tabla de tareas por día + listado de personas con su disponibilidad).

```bash
npm install
npm start          # http://localhost:3300
npm run reset-db   # borra la BD; se recrea desde data/seed/ al arrancar
```

- Node ≥ 22.13 (usa `node:sqlite`), Express, frontend sin build en `public/`.
- BD: `data/kontrast.db` (se crea sola). Datos iniciales: `data/seed/voluntarios.csv` y las tareas fijas de `src/config.js`.
- Áreas: `cocina` (Cocina y limpieza), `bar`, `tecnica`. Hay tareas de cocina (fijas) y de bar; técnica (de las hojas de 2026), taquilla automática por espectáculo; compañías (programa del cartel) y espacios.
- El reloj simulado vive en el navegador (localStorage); empieza el lunes 6 a las 08:00.
