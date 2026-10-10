import type { Db } from "../db/index.js";
import type { CameraService } from "../exacq/service.js";
import { DemoSource } from "../exacq/demo.js";
import type { EventService, EventType, Severity } from "../events/service.js";

interface Scenario {
  camera: string;
  type: EventType;
  severity: Severity;
  title: string;
  summary: string;
  detected: string[];
  people: number;
  vehicles: number;
  action: string;
  weight: number;
  nightOnly?: boolean;
}

const SCENARIOS: Scenario[] = [
  { camera: "3", type: "vehicle", severity: "low", title: "Vehículo ingresando al estacionamiento", summary: "Auto sedán gris ingresa por el acceso norte y estaciona en la fila 2.", detected: ["vehiculo"], people: 0, vehicles: 1, action: "Registrar. Sin acción.", weight: 6 },
  { camera: "1", type: "person", severity: "low", title: "Ingreso de personal por acceso principal", summary: "Dos personas con ropa de trabajo ingresan por la puerta principal.", detected: ["persona"], people: 2, vehicles: 0, action: "Sin acción.", weight: 7 },
  { camera: "1", type: "loitering", severity: "medium", title: "Merodeo frente al acceso principal", summary: "Una persona con campera oscura permanece más de 3 minutos frente al acceso observando el interior.", detected: ["persona"], people: 1, vehicles: 0, action: "Verificar con guardia de recepción.", weight: 2 },
  { camera: "2", type: "ai_alert", severity: "medium", title: "Objeto abandonado en recepción", summary: "Bolso negro sin dueño aparente junto al mostrador de recepción desde hace 6 minutos.", detected: ["paquete"], people: 0, vehicles: 0, action: "Enviar guardia a verificar el objeto.", weight: 1 },
  { camera: "7", type: "intrusion", severity: "high", title: "Persona junto al cerco perimetral fuera de horario", summary: "Persona caminando pegada al cerco perimetral este, sin chaleco ni identificación visible.", detected: ["persona"], people: 1, vehicles: 0, action: "Despachar ronda al sector este y mantener seguimiento.", weight: 2, nightOnly: true },
  { camera: "9", type: "person", severity: "medium", title: "Acceso a sala de servidores", summary: "Persona ingresa a la sala de servidores y se dirige al rack 3.", detected: ["persona"], people: 1, vehicles: 0, action: "Confirmar con mesa de ayuda si hay un trabajo programado.", weight: 2 },
  { camera: "10", type: "vehicle", severity: "info", title: "Camión en zona de carga y descarga", summary: "Camión mediano estacionado en la dársena 2 con la caja abierta; dos operarios descargando.", detected: ["vehiculo", "persona"], people: 2, vehicles: 1, action: "Sin acción.", weight: 4 },
  { camera: "6", type: "intrusion", severity: "critical", title: "Intrusión en Depósito B fuera de horario", summary: "Persona encapuchada se desplaza entre estanterías con linterna; el depósito debería estar cerrado.", detected: ["persona"], people: 1, vehicles: 0, action: "Activar protocolo de intrusión: avisar a seguridad y a la policía.", weight: 0.3, nightOnly: true },
  { camera: "4", type: "vehicle", severity: "medium", title: "Vehículo detenido con motor encendido", summary: "Camioneta blanca detenida en el estacionamiento sur con luces encendidas, sin descender ocupantes.", detected: ["vehiculo"], people: 0, vehicles: 1, action: "Observar; si persiste más de 10 minutos, enviar guardia.", weight: 1.5 },
  { camera: "11", type: "person", severity: "low", title: "Circulación en pasillo 2º piso", summary: "Tres personas caminan por el pasillo hacia las oficinas.", detected: ["persona"], people: 3, vehicles: 0, action: "Sin acción.", weight: 5 },
  { camera: "12", type: "motion", severity: "info", title: "Actividad en comedor", summary: "Personal almorzando; actividad normal.", detected: ["persona"], people: 5, vehicles: 0, action: "Sin acción.", weight: 3 },
  { camera: "5", type: "tamper", severity: "high", title: "Posible obstrucción de cámara en Depósito A", summary: "La imagen perdió nitidez de forma abrupta; posible objeto delante del lente.", detected: ["otro"], people: 0, vehicles: 0, action: "Revisar físicamente la cámara.", weight: 0.4 },
];

const THREAT: Record<Severity, string> = { info: "none", low: "low", medium: "medium", high: "high", critical: "critical" };

function pick(weights: Scenario[], night: boolean) {
  const list = weights.filter((s) => !s.nightOnly || night);
  const total = list.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * total;
  for (const s of list) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return list[0]!;
}

/**
 * Simulador de detecciones IA para el modo DEMO: genera eventos variados con análisis "tipo IA"
 * (marcados como simulados) para que el tablero muestre actividad realista sin API key ni cámaras reales.
 */
export class DemoSimulator {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private cameras: CameraService,
    private events: EventService,
  ) {}

  private demoSource() {
    const s = this.cameras.sources.get("demo");
    return s instanceof DemoSource ? s : undefined;
  }

  private emit(ts = Date.now(), withSnapshot = true, historical = false) {
    const hour = new Date(ts).getHours();
    const night = hour < 7 || hour >= 20;
    const s = pick(SCENARIOS, night);
    const camKey = `demo:${s.camera}`;
    const cam = this.cameras.row(camKey);
    if (!cam) return;
    const src = this.demoSource();
    const snapshot = withSnapshot && src ? src.render(s.camera, ts) : null;
    const ev = this.events.create({
      ts,
      type: s.type,
      severity: s.severity,
      source: "demo",
      cameraId: camKey,
      title: `${s.title}`,
      description: s.summary,
      snapshot,
      ai: {
        summary: s.summary,
        people_count: s.people,
        vehicles_count: s.vehicles,
        detected: s.detected,
        activities: [],
        anomalies: s.severity === "info" || s.severity === "low" ? [] : [s.title],
        event_type: s.type,
        threat_level: THREAT[s.severity],
        recommended_action: s.action,
        confidence: 0.7 + Math.random() * 0.28,
        simulated: true,
        model: "demo",
      },
    });
    if (historical) {
      const r = Math.random();
      const status = s.severity === "info" ? "resolved" : r < 0.55 ? "resolved" : r < 0.7 ? "false_positive" : r < 0.85 ? "ack" : "new";
      if (status !== "new") {
        const by = ["operador1", "supervisor", "operador2"][Math.floor(Math.random() * 3)]!;
        this.db.run(
          "UPDATE events SET status = $st, ack_by = $by, ack_at = $ack, resolved_by = CASE WHEN $st IN ('resolved','false_positive') THEN $by END, resolved_at = CASE WHEN $st IN ('resolved','false_positive') THEN $res END WHERE id = $id",
          { st: status, by, ack: ts + 30_000 + Math.random() * 240_000, res: ts + 300_000 + Math.random() * 900_000, id: ev.id },
        );
      }
    }
  }

  /** Puebla 24 h de historia en el primer arranque para que los gráficos tengan datos. */
  seedHistory() {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n;
    if (n > 0) return;
    const now = Date.now();
    let t = now - 24 * 3600_000;
    while (t < now - 120_000) {
      const hour = new Date(t).getHours();
      const rate = hour >= 8 && hour < 19 ? 9 : hour >= 6 && hour < 22 ? 5 : 2; // eventos/hora
      t += (3600_000 / rate) * (0.4 + Math.random() * 1.2);
      this.emit(t, Math.random() < 0.35, true);
    }
  }

  /** Simula el trabajo de los operadores: atiende eventos viejos para que el tablero refleje una operación real. */
  private simulateOperators() {
    const now = Date.now();
    const by = ["operador1", "operador2", "supervisor"][Math.floor(Math.random() * 3)]!;
    this.db.run(
      `UPDATE events SET status = 'resolved', ack_by = COALESCE(ack_by, $by), ack_at = COALESCE(ack_at, $now), resolved_by = $by, resolved_at = $now
       WHERE status IN ('new','ack') AND source IN ('demo','motor') AND severity IN ('info','low') AND ts < $cut1`,
      { by, now, cut1: now - 8 * 60_000 },
    );
    this.db.run(
      `UPDATE events SET status = 'resolved', ack_by = COALESCE(ack_by, $by), ack_at = COALESCE(ack_at, $now), resolved_by = $by, resolved_at = $now
       WHERE status IN ('new','ack','investigating') AND source = 'demo' AND severity IN ('medium','high','critical') AND ts < $cut2`,
      { by, now, cut2: now - 25 * 60_000 },
    );
  }

  start() {
    const schedule = () => {
      const delay = 25_000 + Math.random() * 50_000;
      this.timer = setTimeout(() => {
        try {
          this.emit();
          this.simulateOperators();
        } finally {
          schedule();
        }
      }, delay);
      this.timer.unref();
    };
    schedule();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
