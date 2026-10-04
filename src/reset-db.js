import fs from 'node:fs';
import { DB_PATH } from './db.js';
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + s, { force: true });
console.log('Base de datos borrada. Se recreará con los datos iniciales al arrancar el servidor.');
