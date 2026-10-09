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
