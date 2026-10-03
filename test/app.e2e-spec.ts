import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from './../src/app.module.js';

describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), 'paseo-e2e-'));
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('GET / responde el estado del servicio', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect((r) => expect(r.body.estado).toBe('ok'));
  });

  it('las rutas protegidas exigen sesión', () => {
    return request(app.getHttpServer()).get('/cliente/resumen').expect(401);
  });

  afterAll(async () => {
    await app.close();
  });
});
