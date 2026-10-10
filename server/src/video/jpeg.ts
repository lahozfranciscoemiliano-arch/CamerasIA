/** Lee ancho y alto de un JPEG (marcador SOF) sin decodificarlo. Devuelve null si no es un JPEG válido. */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // Relleno (FF FF…) y marcadores sin longitud
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fin de imagen / inicio de datos sin SOF
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2) return null;
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= buf.length) return null;
      const height = (buf[i + 5]! << 8) | buf[i + 6]!;
      const width = (buf[i + 7]! << 8) | buf[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  precision: number;
  progressive: boolean;
  /** Marcador SOF encontrado (0xC0 baseline, 0xC2 progresivo, …). */
  sof: number;
  /** Calidad estimada (escala IJG 1-100) a partir de la tabla de cuantización de luminancia; null sin DQT. */
  quality: number | null;
}

/** Tabla estándar de luminancia (calidad 50, orden zigzag, igual que la guarda el DQT). */
const STD_LUMA_ZIGZAG = [
  16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99,
];

/**
 * Estima la calidad JPEG (escala IJG) comparando la tabla de luminancia con la estándar:
 * S = promedio(100·T/std); q = S ≤ 100 ? (200 − S) / 2 : 5000 / S.
 */
export function estimateQuality(table: ArrayLike<number>): number | null {
  if (table.length < 64) return null;
  let sum = 0;
  for (let k = 0; k < 64; k++) sum += (100 * table[k]!) / STD_LUMA_ZIGZAG[k]!;
  const s = sum / 64;
  if (!(s > 0)) return null;
  const q = s <= 100 ? (200 - s) / 2 : 5000 / s;
  return Math.max(1, Math.min(100, Math.round(q)));
}

/**
 * Lee la cabecera de un JPEG (sin decodificar la imagen): tamaño, componentes, si es progresivo y
 * una estimación de la calidad. Sólo recorre los segmentos hasta el SOF (microsegundos), por eso se
 * usa en cada cuadro en vivo. Devuelve null si no es un JPEG válido o está truncado.
 */
export function parseJpegInfo(buf: Uint8Array, maxScan = 65536): JpegInfo | null {
  const len = buf.length;
  if (len < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const limit = Math.min(len, maxScan);
  const u16 = (p: number) => (buf[p]! << 8) | buf[p + 1]!;
  let luma: number[] | null = null;
  let i = 2;
  while (i + 4 <= limit) {
    if (buf[i] !== 0xff) return null;
    // Bytes de relleno FF FF…
    while (i + 1 < limit && buf[i + 1] === 0xff) i++;
    if (i + 4 > limit) return null;
    const m = buf[i + 1]!;
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // fin de imagen o datos de escaneo antes del SOF
    const segLen = u16(i + 2);
    if (segLen < 2 || i + 2 + segLen > len) return null; // segmento truncado
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (segLen < 8) return null;
      const height = u16(i + 5);
      const width = u16(i + 7);
      if (height === 0 || width === 0) return null; // DNL: alto definido después del escaneo (no soportado)
      return {
        width,
        height,
        precision: buf[i + 4]!,
        components: buf[i + 9]!,
        progressive: m === 0xc2 || m === 0xc6 || m === 0xca,
        sof: m,
        quality: luma ? estimateQuality(luma) : null,
      };
    }
    if (m === 0xdb) {
      // DQT: una o más tablas (8 o 16 bits); interesa la 0 (luminancia).
      let p = i + 4;
      const end = i + 2 + segLen;
      while (p < end) {
        const pq = buf[p]! >> 4;
        const tq = buf[p]! & 15;
        p++;
        const size = pq ? 128 : 64;
        if (p + size > end) return null;
        if (tq === 0) {
          const t: number[] = new Array(64);
          for (let k = 0; k < 64; k++) t[k] = pq ? u16(p + 2 * k) : buf[p + k]!;
          luma = t;
        }
        p += size;
      }
    }
    i += 2 + segLen;
  }
  return null;
}
