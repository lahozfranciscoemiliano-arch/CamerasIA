import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { estimateQuality, jpegSize, parseJpegInfo } from "../src/video/jpeg.js";

const encode = (width: number, height: number, quality = 75) => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = ((x + y) * 7) % 255;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, quality).data as Buffer;
};

const STD = [16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99];

/** JPEG mínimo armado a mano: SOI, DQT opcional, SOF (marcador elegido) y SOS. */
function handMade(opts: { sof: number; width: number; height: number; dqt16?: boolean; fill?: boolean }) {
  const parts: number[] = [0xff, 0xd8];
  if (opts.fill) parts.push(0xff, 0xff, 0xff); // bytes de relleno antes del marcador
  if (opts.dqt16) {
    parts.push(0xff, 0xdb, 0x00, 2 + 1 + 128, 0x10);
    for (const v of STD) parts.push(v >> 8, v & 0xff);
  }
  parts.push(0xff, opts.sof, 0x00, 17, 8, opts.height >> 8, opts.height & 0xff, opts.width >> 8, opts.width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xda, 0x00, 0x0c, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x00, 0xff, 0xd9);
  return Buffer.from(parts);
}

test("parseJpegInfo: tamaño de JPEG codificados con jpeg-js", () => {
  const small = parseJpegInfo(encode(64, 48));
  assert.ok(small);
  assert.equal(small.width, 64);
  assert.equal(small.height, 48);
  assert.equal(small.components, 3);
  assert.equal(small.precision, 8);
  assert.equal(small.progressive, false);
  assert.equal(small.sof, 0xc0);
  const big = encode(1920, 1080, 50);
  const info = parseJpegInfo(big);
  assert.equal(info?.width, 1920);
  assert.equal(info?.height, 1080);
  assert.deepEqual(jpegSize(big), { width: 1920, height: 1080 }, "jpegSize sigue funcionando");
});

test("parseJpegInfo: SOF2 progresivo, relleno FF y DQT de 16 bits", () => {
  const prog = parseJpegInfo(handMade({ sof: 0xc2, width: 1280, height: 720, dqt16: true, fill: true }));
  assert.ok(prog);
  assert.equal(prog.progressive, true);
  assert.equal(prog.sof, 0xc2);
  assert.equal(prog.width, 1280);
  assert.equal(prog.height, 720);
  assert.equal(prog.quality, 50, "tabla estándar en 16 bits = calidad 50");
  const noDqt = parseJpegInfo(handMade({ sof: 0xc0, width: 320, height: 240 }));
  assert.equal(noDqt?.quality, null);
});

test("parseJpegInfo: entradas inválidas devuelven null", () => {
  const good = encode(64, 48);
  assert.equal(parseJpegInfo(good.subarray(0, 30)), null, "segmento truncado");
  // SOS antes del SOF
  assert.equal(parseJpegInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])), null);
  // PNG
  assert.equal(parseJpegInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), null);
  // Sólo SOI + EOI (el cuadro de prueba de los fixtures)
  assert.equal(parseJpegInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  // Alto 0 (DNL) no soportado
  assert.equal(parseJpegInfo(handMade({ sof: 0xc0, width: 320, height: 0 })), null);
});

test("estimación de calidad (DQT) dentro de ±5 para jpeg-js q=30 y q=90", () => {
  for (const q of [30, 90]) {
    const est = parseJpegInfo(encode(128, 96, q))?.quality;
    assert.ok(est !== null && est !== undefined && Math.abs(est - q) <= 5, `q=${q} estimada ${est}`);
  }
  assert.equal(estimateQuality(STD), 50);
  assert.equal(estimateQuality([1, 2, 3]), null);
});
