/**
 * Módulos de dominio y sus dependencias explícitas. Cada módulo exporta solo su servicio público.
 * Grafo (sin ciclos): fidelizacion ← identidad ← comercio; promociones ← presencia ← participacion;
 * presencia + recinto ← paseoya; todos ← inteligencia/integraciones (solo lectura).
 */
import { Module } from '@nestjs/common';
import { FidelizacionModule } from './fidelizacion/fidelizacion.module.js';
import { ConfianzaModule } from './confianza/confianza.module.js';
import { RecompensasModule } from './recompensas/recompensas.module.js';
import { IdentidadService } from './identidad/identidad.service.js';
import { AdminUsuariosController, AuthController, ClienteCuentaController, NotificacionesController } from './identidad/identidad.controller.js';
import { RecintoService } from './recinto/recinto.service.js';
import { AdminRecintoController, LocalRecintoController, RecintoController } from './recinto/recinto.controller.js';
import { PromocionesService } from './participacion/promociones.service.js';
import { MisionesService } from './participacion/misiones.service.js';
import { ExperienciasService } from './participacion/experiencias.service.js';
import { EventosService } from './participacion/eventos.service.js';
import { ComercioParticipacionController, EventosAdminController, EventosClienteController, ParticipacionAdminController, ParticipacionClienteController, PromocionesLocalController } from './participacion/participacion.controller.js';
import { PresenciaService } from './presencia/presencia.service.js';
import { PresenciaController } from './presencia/presencia.controller.js';
import { ComprasService } from './comercio/compras.service.js';
import { CajaController, ClienteFacturaController } from './comercio/comercio.controller.js';
import { PaseoYaService } from './paseoya/paseoya.service.js';
import { PaseoYaAdminController, PaseoYaCatalogoController, PaseoYaClienteController, PaseoYaLocalController } from './paseoya/paseoya.controller.js';
import { InteligenciaService } from './inteligencia/inteligencia.service.js';
import { AsistenteController, InteligenciaController, PanelLocalController } from './inteligencia/inteligencia.controller.js';
import { AsistenteAdmin } from './inteligencia/asistente.service.js';
import { JarvisService } from './integraciones/jarvis.service.js';
import { IntegracionesApiController, JarvisClienteController } from './integraciones/integraciones.controller.js';
import { JarvisGateway } from './integraciones/jarvis.gateway.js';
import { JarvisModule } from './jarvis/jarvis.module.js';
import { OfertasModule } from './ofertas/ofertas.module.js';

@Module({
  imports: [FidelizacionModule],
  controllers: [AuthController, ClienteCuentaController, AdminUsuariosController, NotificacionesController],
  providers: [IdentidadService],
  exports: [IdentidadService],
})
export class IdentidadModule {}

@Module({
  controllers: [RecintoController, AdminRecintoController, LocalRecintoController],
  providers: [RecintoService],
  exports: [RecintoService],
})
export class RecintoModule {}

@Module({ providers: [PromocionesService], exports: [PromocionesService] })
export class PromocionesModule {}

@Module({
  imports: [FidelizacionModule, PromocionesModule],
  controllers: [PresenciaController],
  providers: [PresenciaService],
  exports: [PresenciaService],
})
export class PresenciaModule {}

@Module({
  imports: [FidelizacionModule, PromocionesModule, PresenciaModule],
  controllers: [ParticipacionClienteController, PromocionesLocalController, ParticipacionAdminController, ComercioParticipacionController, EventosAdminController, EventosClienteController],
  providers: [MisionesService, ExperienciasService, EventosService],
  exports: [MisionesService, EventosService],
})
export class ParticipacionModule {}

@Module({
  imports: [IdentidadModule, FidelizacionModule, PromocionesModule, PresenciaModule, ConfianzaModule],
  controllers: [CajaController, ClienteFacturaController],
  providers: [ComprasService],
  exports: [ComprasService],
})
export class ComercioModule {}

@Module({
  imports: [FidelizacionModule, PresenciaModule, RecintoModule],
  controllers: [PaseoYaCatalogoController, PaseoYaClienteController, PaseoYaLocalController, PaseoYaAdminController],
  providers: [PaseoYaService],
  exports: [PaseoYaService],
})
export class PaseoYaModule {}

@Module({
  imports: [JarvisModule],
  controllers: [InteligenciaController, PanelLocalController, AsistenteController],
  providers: [InteligenciaService, AsistenteAdmin],
})
export class InteligenciaModule {}

@Module({
  imports: [FidelizacionModule, RecompensasModule, PaseoYaModule, JarvisModule],
  controllers: [IntegracionesApiController, JarvisClienteController],
  providers: [JarvisService, JarvisGateway],
})
export class IntegracionesModule {}

export const MODULOS_DOMINIO = [
  FidelizacionModule,
  ConfianzaModule,
  IdentidadModule,
  RecintoModule,
  PromocionesModule,
  PresenciaModule,
  ParticipacionModule,
  ComercioModule,
  RecompensasModule,
  PaseoYaModule,
  InteligenciaModule,
  JarvisModule,
  OfertasModule,
  IntegracionesModule,
];
