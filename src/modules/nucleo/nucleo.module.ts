import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.js';
import { AuditoriaService, NotificacionesService, TelemetriaService } from './nucleo.services.js';

@Global()
@Module({
  providers: [EventBus, TelemetriaService, AuditoriaService, NotificacionesService],
  exports: [EventBus, TelemetriaService, AuditoriaService, NotificacionesService],
})
export class NucleoModule {}
