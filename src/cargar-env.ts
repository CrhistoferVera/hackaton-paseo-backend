import { cargarEnv } from './common/env.js';

// Se importa primero en main.ts para que las constantes que leen process.env vean el .env.
cargarEnv();
