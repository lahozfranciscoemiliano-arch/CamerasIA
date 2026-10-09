import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import type { Bus } from "./realtime/bus.js";
import type { AuditService } from "./audit/service.js";
import type { VaultService } from "./vault/service.js";
import type { AuthService } from "./auth/service.js";
import type { Guard } from "./http/guards.js";
import type { CameraService } from "./exacq/service.js";
import type { EventService } from "./events/service.js";
import type { VpnManager } from "./vpn/manager.js";
import type { HealthService } from "./health/service.js";
import type { AiService } from "./ai/service.js";
import type { DetectionEngine } from "./detection/engine.js";

export interface AppCtx {
  cfg: AppConfig;
  db: Db;
  bus: Bus;
  audit: AuditService;
  vault: VaultService;
  auth: AuthService;
  guard: Guard;
  cameras: CameraService;
  events: EventService;
  vpn: VpnManager;
  health: HealthService;
  ai: AiService;
  detection: DetectionEngine;
  log: (msg: string) => void;
}
