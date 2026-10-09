import jpeg from "jpeg-js";

export const GRID_W = 64;
export const GRID_H = 36;

/** Reduce un JPEG a una grilla de luminancia 64x36 (promedio por celda). */
export function lumaGrid(jpegData: Buffer): Float32Array {
  const img = jpeg.decode(jpegData, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 512 });
  const out = new Float32Array(GRID_W * GRID_H);
  const counts = new Uint32Array(GRID_W * GRID_H);
  const { width, height, data } = img;
  const stepX = Math.max(1, Math.floor(width / (GRID_W * 4)));
  const stepY = Math.max(1, Math.floor(height / (GRID_H * 4)));
  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(GRID_H - 1, Math.floor((y / height) * GRID_H));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(GRID_W - 1, Math.floor((x / width) * GRID_W));
      const i = (y * width + x) * 4;
      const idx = gy * GRID_W + gx;
      out[idx]! += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      counts[idx]! += 1;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = counts[i] ? out[i]! / counts[i]! : 0;
  return out;
}

export function stats(grid: Float32Array) {
  let sum = 0;
  for (const v of grid) sum += v;
  const mean = sum / grid.length;
  let varSum = 0;
  for (const v of grid) varSum += (v - mean) ** 2;
  return { mean, std: Math.sqrt(varSum / grid.length) };
}

export interface MotionResult {
  changedFraction: number;
  meanDiff: number;
  motion: boolean;
  /** Caja aproximada de la zona con cambio (en fracciones 0-1). */
  box: { x: number; y: number; w: number; h: number } | null;
  tamper: boolean;
}

/**
 * Compara dos grillas: cuenta celdas cuyo brillo cambió más que el umbral (compensando cambios globales de luz).
 * sensitivity 1..100 (más alto = más sensible).
 */
export function compareGrids(prev: Float32Array, cur: Float32Array, sensitivity: number): MotionResult {
  const sPrev = stats(prev);
  const sCur = stats(cur);
  const globalShift = sCur.mean - sPrev.mean;
  const cellThreshold = 26 - sensitivity * 0.16; // 10..26 niveles de gris
  let changed = 0;
  let diffSum = 0;
  let minX = GRID_W;
  let minY = GRID_H;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < cur.length; i++) {
    const d = Math.abs(cur[i]! - prev[i]! - globalShift);
    diffSum += d;
    if (d > cellThreshold) {
      changed++;
      const x = i % GRID_W;
      const y = Math.floor(i / GRID_W);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const changedFraction = changed / cur.length;
  const minFraction = 0.03 - sensitivity * 0.00025; // 0.5% .. 3% de la imagen
  // Sabotaje: la imagen pasa a ser casi uniforme (tapada, enfocada al piso, cegada) desde una escena con detalle.
  const tamper = sPrev.std > 14 && sCur.std < 4;
  return {
    changedFraction,
    meanDiff: diffSum / cur.length,
    motion: changedFraction >= minFraction && changed >= 3,
    box: maxX >= 0 ? { x: minX / GRID_W, y: minY / GRID_H, w: (maxX - minX + 1) / GRID_W, h: (maxY - minY + 1) / GRID_H } : null,
    tamper,
  };
}
