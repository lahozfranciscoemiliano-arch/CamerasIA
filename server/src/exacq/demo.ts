import jpeg from "jpeg-js";
import { drawText } from "./font.js";
import type { CameraInfo, Clip, Snapshot, SourceStatus, VideoSource } from "./types.js";

/**
 * Fuente de video simulada para el modo DEMO: genera cuadros JPEG procedurales (escenas con
 * personas/vehículos en movimiento, modo IR nocturno, ruido de sensor) de forma determinística
 * según la hora, de modo que vivo, grabaciones y detección de movimiento funcionen de punta a punta
 * sin conectarse a un exacqVision real.
 */

type Scene = "entrance" | "lobby" | "parking" | "warehouse" | "perimeter" | "server" | "hall" | "dock" | "canteen";

interface DemoCam {
  id: string;
  name: string;
  scene: Scene;
  ir?: boolean;
  flaky?: boolean;
}

export const DEMO_CAMERAS: DemoCam[] = [
  { id: "1", name: "Acceso Principal", scene: "entrance" },
  { id: "2", name: "Recepción", scene: "lobby" },
  { id: "3", name: "Estacionamiento Norte", scene: "parking" },
  { id: "4", name: "Estacionamiento Sur", scene: "parking", ir: true },
  { id: "5", name: "Depósito A", scene: "warehouse" },
  { id: "6", name: "Depósito B", scene: "warehouse", ir: true },
  { id: "7", name: "Perímetro Este", scene: "perimeter", ir: true },
  { id: "8", name: "Perímetro Oeste", scene: "perimeter", flaky: true },
  { id: "9", name: "Sala de Servidores", scene: "server" },
  { id: "10", name: "Carga y Descarga", scene: "dock" },
  { id: "11", name: "Pasillo 2º Piso", scene: "hall" },
  { id: "12", name: "Comedor", scene: "canteen" },
];

const W = 480;
const H = 270;
const HORIZON = Math.round(H * 0.42);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash3 = (a: number, b: number, c: number) => mulberry32((a * 73856093) ^ (b * 19349663) ^ (c * 83492791))();

type RGB = [number, number, number];

function fillRect(buf: Uint8ClampedArray, x: number, y: number, w: number, h: number, c: RGB, alpha = 1) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * W + xx) * 4;
      buf[i] = buf[i]! * (1 - alpha) + c[0] * alpha;
      buf[i + 1] = buf[i + 1]! * (1 - alpha) + c[1] * alpha;
      buf[i + 2] = buf[i + 2]! * (1 - alpha) + c[2] * alpha;
    }
  }
}

function fillEllipse(buf: Uint8ClampedArray, cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1) {
  for (let yy = Math.max(0, Math.floor(cy - ry)); yy < Math.min(H, Math.ceil(cy + ry)); yy++) {
    for (let xx = Math.max(0, Math.floor(cx - rx)); xx < Math.min(W, Math.ceil(cx + rx)); xx++) {
      const dx = (xx - cx) / rx;
      const dy = (yy - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const i = (yy * W + xx) * 4;
      buf[i] = buf[i]! * (1 - alpha) + c[0] * alpha;
      buf[i + 1] = buf[i + 1]! * (1 - alpha) + c[1] * alpha;
      buf[i + 2] = buf[i + 2]! * (1 - alpha) + c[2] * alpha;
    }
  }
}

const PALETTES: Record<Scene, { wall: RGB; floor: RGB; accent: RGB }> = {
  entrance: { wall: [70, 78, 92], floor: [52, 54, 58], accent: [150, 160, 175] },
  lobby: { wall: [120, 112, 100], floor: [88, 80, 72], accent: [190, 170, 140] },
  parking: { wall: [40, 52, 70], floor: [48, 50, 54], accent: [220, 210, 120] },
  warehouse: { wall: [82, 76, 66], floor: [70, 70, 68], accent: [200, 150, 60] },
  perimeter: { wall: [36, 60, 52], floor: [48, 66, 44], accent: [140, 150, 150] },
  server: { wall: [30, 36, 48], floor: [40, 44, 52], accent: [60, 200, 255] },
  hall: { wall: [110, 110, 112], floor: [80, 78, 76], accent: [160, 160, 170] },
  dock: { wall: [74, 70, 64], floor: [60, 60, 60], accent: [230, 180, 40] },
  canteen: { wall: [128, 118, 96], floor: [96, 86, 74], accent: [200, 120, 80] },
};

function buildBackground(cam: DemoCam): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(W * H * 4);
  const p = PALETTES[cam.scene];
  const rnd = mulberry32(Number(cam.id) * 9973);
  for (let y = 0; y < H; y++) {
    const isFloor = y >= HORIZON;
    const base = isFloor ? p.floor : p.wall;
    const k = isFloor ? 0.75 + 0.45 * ((y - HORIZON) / (H - HORIZON)) : 0.8 + 0.25 * (y / HORIZON);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const vignette = 1 - 0.35 * Math.pow(Math.abs(x - W / 2) / (W / 2), 2);
      buf[i] = base[0] * k * vignette;
      buf[i + 1] = base[1] * k * vignette;
      buf[i + 2] = base[2] * k * vignette;
      buf[i + 3] = 255;
    }
  }
  // Líneas de perspectiva del piso
  for (let n = -6; n <= 6; n++) {
    for (let y = HORIZON; y < H; y++) {
      const t = (y - HORIZON) / (H - HORIZON);
      const x = Math.round(W / 2 + n * 40 * t * 2.2);
      if (x >= 0 && x < W) fillRect(buf, x, y, 1, 1, p.accent, 0.12);
    }
  }
  switch (cam.scene) {
    case "parking":
      for (let s = 0; s < 7; s++) fillRect(buf, 20 + s * 66, HORIZON + 70, 3, 80, [230, 230, 210], 0.6);
      for (let s = 0; s < 4; s++) {
        if (rnd() > 0.45) fillRect(buf, 30 + s * 120, HORIZON + 95, 70, 34, [60 + rnd() * 120, 60 + rnd() * 80, 70 + rnd() * 90]);
      }
      fillRect(buf, 0, HORIZON - 70, W, 8, [90, 96, 110]);
      break;
    case "warehouse":
      for (let s = 0; s < 4; s++) {
        fillRect(buf, 10 + s * 125, 30, 90, HORIZON + 40, [110, 80, 40]);
        for (let r = 0; r < 4; r++) fillRect(buf, 14 + s * 125, 40 + r * 34, 82, 22, [150 + rnd() * 60, 120, 70]);
      }
      break;
    case "perimeter":
      for (let x = 0; x < W; x += 24) fillRect(buf, x, HORIZON - 60, 3, 75, [150, 150, 150], 0.8);
      for (let y = HORIZON - 60; y < HORIZON + 15; y += 10) fillRect(buf, 0, y, W, 1, [150, 150, 150], 0.5);
      fillRect(buf, 0, 0, W, HORIZON - 60, [20, 30, 40]);
      break;
    case "server":
      for (let s = 0; s < 5; s++) {
        fillRect(buf, 20 + s * 92, 25, 70, HORIZON + 60, [24, 26, 32]);
        for (let r = 0; r < 18; r++) if (rnd() > 0.3) fillRect(buf, 28 + s * 92 + rnd() * 50, 32 + r * 9, 3, 2, rnd() > 0.2 ? [60, 255, 120] : [255, 180, 40]);
      }
      break;
    case "entrance":
      fillRect(buf, W / 2 - 70, 20, 140, HORIZON + 10, [40, 60, 80]);
      fillRect(buf, W / 2 - 66, 24, 64, HORIZON + 2, [90, 130, 160], 0.6);
      fillRect(buf, W / 2 + 2, 24, 64, HORIZON + 2, [90, 130, 160], 0.6);
      break;
    case "lobby":
      fillRect(buf, 60, HORIZON - 10, 200, 50, [100, 70, 50]);
      fillRect(buf, 330, 40, 110, 70, [40, 40, 50]);
      break;
    case "dock":
      for (let s = 0; s < 3; s++) fillRect(buf, 30 + s * 150, 20, 120, HORIZON + 5, [90, 92, 96]);
      for (let s = 0; s < 3; s++) for (let r = 0; r < 8; r++) fillRect(buf, 30 + s * 150, 24 + r * 14, 120, 2, [60, 60, 64]);
      break;
    case "hall":
      for (let s = 0; s < 4; s++) fillRect(buf, 20 + s * 120, 50, 36, HORIZON - 30, [130, 100, 70]);
      break;
    case "canteen":
      for (let s = 0; s < 3; s++) fillRect(buf, 40 + s * 150, HORIZON + 50, 110, 30, [150, 120, 90]);
      break;
  }
  if (cam.ir) {
    for (let i = 0; i < buf.length; i += 4) {
      const g = 0.3 * buf[i]! + 0.59 * buf[i + 1]! + 0.11 * buf[i + 2]!;
      buf[i] = g * 0.85;
      buf[i + 1] = g * 1.05;
      buf[i + 2] = g * 0.85;
    }
  }
  return buf;
}

interface Actor {
  kind: "person" | "vehicle";
  period: number;
  active: number;
  offset: number;
  from: [number, number];
  to: [number, number];
  color: RGB;
  prob: number;
}

function actorsFor(cam: DemoCam): Actor[] {
  const rnd = mulberry32(Number(cam.id) * 7919 + 13);
  const people = { entrance: 4, lobby: 3, parking: 1, warehouse: 2, perimeter: 1, server: 1, hall: 3, dock: 2, canteen: 4 }[cam.scene];
  const vehicles = cam.scene === "parking" || cam.scene === "dock" ? 2 : 0;
  const out: Actor[] = [];
  for (let i = 0; i < people; i++) {
    const leftToRight = rnd() > 0.5;
    const y = HORIZON + 40 + rnd() * (H - HORIZON - 70);
    out.push({
      kind: "person",
      period: 45 + rnd() * 120,
      active: 0.25 + rnd() * 0.2,
      offset: rnd() * 1000,
      from: [leftToRight ? -30 : W + 30, y],
      to: [leftToRight ? W + 30 : -30, y + (rnd() - 0.5) * 40],
      color: [40 + rnd() * 160, 40 + rnd() * 120, 40 + rnd() * 160],
      prob: cam.scene === "server" || cam.scene === "perimeter" ? 0.15 : 0.55,
    });
  }
  for (let i = 0; i < vehicles; i++) {
    const y = HORIZON + 60 + i * 50;
    out.push({
      kind: "vehicle",
      period: 90 + rnd() * 140,
      active: 0.18,
      offset: rnd() * 1000,
      from: [-120, y],
      to: [W + 120, y],
      color: [80 + rnd() * 170, 80 + rnd() * 120, 80 + rnd() * 120],
      prob: 0.5,
    });
  }
  return out;
}

function activityFactor(hour: number) {
  if (hour >= 8 && hour < 19) return 1;
  if (hour >= 6 && hour < 22) return 0.55;
  return 0.18;
}

function drawPerson(buf: Uint8ClampedArray, x: number, y: number, scale: number, c: RGB, tSec: number, ir: boolean) {
  const col: RGB = ir ? [190, 220, 190] : c;
  const s = scale;
  const swing = Math.sin(tSec * 7) * 5 * s;
  fillEllipse(buf, x, y + 2 * s, 9 * s, 3 * s, [0, 0, 0], 0.35); // sombra
  fillRect(buf, x - 4 * s + swing * 0.3, y - 22 * s, 3 * s, 22 * s, [30, 30, 40]);
  fillRect(buf, x + 1 * s - swing * 0.3, y - 22 * s, 3 * s, 22 * s, [30, 30, 40]);
  fillRect(buf, x - 6 * s, y - 46 * s, 12 * s, 26 * s, col);
  fillEllipse(buf, x, y - 52 * s, 5 * s, 6 * s, ir ? [220, 240, 220] : [210, 170, 140]);
}

function drawVehicle(buf: Uint8ClampedArray, x: number, y: number, scale: number, c: RGB, ir: boolean) {
  const s = scale;
  const col: RGB = ir ? [170, 200, 170] : c;
  fillEllipse(buf, x, y + 2, 60 * s, 6 * s, [0, 0, 0], 0.35);
  fillRect(buf, x - 55 * s, y - 26 * s, 110 * s, 22 * s, col);
  fillRect(buf, x - 32 * s, y - 42 * s, 60 * s, 18 * s, col);
  fillRect(buf, x - 28 * s, y - 39 * s, 24 * s, 13 * s, [40, 60, 80]);
  fillRect(buf, x + 0 * s, y - 39 * s, 24 * s, 13 * s, [40, 60, 80]);
  fillEllipse(buf, x - 32 * s, y - 4 * s, 9 * s, 9 * s, [20, 20, 20]);
  fillEllipse(buf, x + 32 * s, y - 4 * s, 9 * s, 9 * s, [20, 20, 20]);
  fillRect(buf, x + 50 * s, y - 22 * s, 5 * s, 5 * s, [255, 250, 200]);
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export class DemoSource implements VideoSource {
  readonly id = "demo";
  readonly name = "Simulador DEMO";
  readonly kind = "demo" as const;
  private backgrounds = new Map<string, Uint8ClampedArray>();
  private actors = new Map<string, Actor[]>();
  private cache = new Map<string, Snapshot>();

  status(): SourceStatus {
    return { ok: true, detail: "Simulador activo", lastOkAt: Date.now(), latencyMs: 1 };
  }

  private cam(id: string) {
    const c = DEMO_CAMERAS.find((x) => x.id === id);
    if (!c) throw new Error("Cámara demo inexistente");
    return c;
  }

  isOnline(cam: DemoCam, t = Date.now()) {
    if (!cam.flaky) return true;
    const minute = Math.floor(t / 60_000) % 15;
    return minute >= 3;
  }

  async listCameras(): Promise<CameraInfo[]> {
    return DEMO_CAMERAS.map((c) => ({ cameraId: c.id, name: c.name, online: this.isOnline(c), raw: { scene: c.scene, ir: Boolean(c.ir) } }));
  }

  /** Renderiza el cuadro de la cámara en el instante t (ms). Determinístico salvo el ruido del sensor. */
  render(cameraId: string, t: number, quality = 62): Buffer {
    const cam = this.cam(cameraId);
    let bg = this.backgrounds.get(cam.id);
    if (!bg) {
      bg = buildBackground(cam);
      this.backgrounds.set(cam.id, bg);
    }
    let actors = this.actors.get(cam.id);
    if (!actors) {
      actors = actorsFor(cam);
      this.actors.set(cam.id, actors);
    }
    const date = new Date(t);
    const hour = date.getHours() + date.getMinutes() / 60;
    const daylight = cam.ir ? 1 : hour >= 7 && hour < 19.5 ? 1 : hour >= 6 && hour < 21 ? 0.7 : 0.45;
    const buf = new Uint8ClampedArray(bg.length);
    for (let i = 0; i < bg.length; i += 4) {
      buf[i] = bg[i]! * daylight;
      buf[i + 1] = bg[i + 1]! * daylight;
      buf[i + 2] = bg[i + 2]! * daylight;
      buf[i + 3] = 255;
    }
    const tSec = t / 1000;
    const activity = activityFactor(date.getHours());
    actors.forEach((a, idx) => {
      const local = tSec + a.offset;
      const cycle = Math.floor(local / a.period);
      const u = (local % a.period) / a.period;
      if (u > a.active) return;
      if (hash3(Number(cam.id), idx, cycle) > a.prob * activity) return;
      const p = u / a.active;
      const x = a.from[0] + (a.to[0] - a.from[0]) * p;
      const y = a.from[1] + (a.to[1] - a.from[1]) * p;
      const scale = 0.55 + 0.75 * ((y - HORIZON) / (H - HORIZON));
      if (a.kind === "person") drawPerson(buf, x, y, scale, a.color, tSec, Boolean(cam.ir));
      else drawVehicle(buf, x, y, scale, a.color, Boolean(cam.ir));
    });
    // Ruido de sensor (más fuerte de noche)
    const noise = daylight < 1 || cam.ir ? 14 : 7;
    for (let i = 0; i < buf.length; i += 4) {
      const n = (Math.random() - 0.5) * noise;
      buf[i] = Math.max(0, Math.min(255, buf[i]! + n));
      buf[i + 1] = Math.max(0, Math.min(255, buf[i + 1]! + n));
      buf[i + 2] = Math.max(0, Math.min(255, buf[i + 2]! + n));
    }
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    drawText(buf, W, H, `CAM${pad(Number(cam.id))}  ${stamp}`, 6, H - 12, 1);
    if (cam.ir) drawText(buf, W, H, "IR", W - 18, H - 12, 1, [120, 255, 140]);
    return jpeg.encode({ data: buf, width: W, height: H }, quality).data;
  }

  async snapshot(cameraId: string): Promise<Snapshot> {
    const cam = this.cam(cameraId);
    if (!this.isOnline(cam)) throw new Error("Cámara sin señal (simulado)");
    const cached = this.cache.get(cameraId);
    const now = Date.now();
    if (cached && now - cached.ts < 180) return cached;
    const snap = { data: this.render(cameraId, now), contentType: "image/jpeg", ts: now };
    this.cache.set(cameraId, snap);
    return snap;
  }

  async searchRecordings(cameraId: string, start: Date, end: Date): Promise<Clip[]> {
    const cam = this.cam(cameraId);
    const BLOCK = 10 * 60_000;
    const clips: Clip[] = [];
    const now = Date.now();
    for (let b = Math.floor(start.getTime() / BLOCK); b * BLOCK < Math.min(end.getTime(), now); b++) {
      if (hash3(Number(cam.id), b, 7) < 0.12) continue;
      const s = Math.max(b * BLOCK, start.getTime());
      const e = Math.min((b + 1) * BLOCK - 1000 * Math.floor(hash3(b, 3, Number(cam.id)) * 90), end.getTime(), now);
      if (e <= s) continue;
      const last = clips[clips.length - 1];
      if (last && new Date(last.end).getTime() >= s - 1000) last.end = new Date(e).toISOString();
      else clips.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
    }
    return clips;
  }
}
