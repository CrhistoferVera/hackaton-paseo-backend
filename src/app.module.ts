import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { DbModule } from './infra/db/db.module.js';
import { RealtimeModule } from './infra/realtime/realtime.module.js';
import { NucleoModule } from './modules/nucleo/nucleo.module.js';
import { IaModule } from './modules/ia/llm.service.js';
import { MODULOS_DOMINIO } from './modules/modulos.js';

@Module({
  imports: [DbModule, RealtimeModule, NucleoModule, IaModule, ...MODULOS_DOMINIO],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
