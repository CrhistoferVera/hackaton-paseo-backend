import './cargar-env.js';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { DIR_UPLOADS } from './common/archivos.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  const origenes = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origenes.length ? origenes : true, credentials: true });
  mkdirSync(DIR_UPLOADS, { recursive: true });
  app.useStaticAssets(DIR_UPLOADS, { prefix: '/uploads/' });
  app.enableShutdownHooks();
  const puerto = Number(process.env.PORT ?? 4000);
  await app.listen(puerto, '0.0.0.0');
  new Logger('Paseo Points').log(`API escuchando en http://localhost:${puerto}`);
}
await bootstrap();
