import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, tierFor } from "../src/live/protocol.js";
// El decodificador del navegador (sin DOM: sólo DataView) se prueba contra el codificador del servidor.
import { decodeHeader, drawRect, tierFor as webTierFor } from "../../web/src/lib/live-protocol.js";

test("protocolo /api/live: la cabecera del servidor se lee igual en el navegador", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const meta = { subId: 65535, seq: 4_000_000_000, tCap: 1_760_000_000_123.5, upMs: 321, width: 1920, height: 1080, flags: 0b1011, dropped: 70_000 };
  const buf = encodeFrame(meta, jpeg);
  assert.equal(buf.length, 32 + jpeg.length);
  // Bytes fijos (golden) de la cabecera.
  assert.deepEqual([...buf.subarray(0, 4)], [1, 1, 0xff, 0xff]);
  assert.equal(buf.readUInt32LE(28), jpeg.length);
  const server = decodeFrame(buf)!;
  assert.equal(server.dropped, 65535, "descartados se satura en u16");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const web = decodeHeader(ab)!;
  assert.ok(web);
  for (const k of ["subId", "seq", "tCap", "upMs", "width", "height", "flags"] as const) assert.equal(web[k], meta[k], k);
  assert.equal(web.dropped, 65535);
  assert.deepEqual([...web.payload], [...jpeg]);
  // Largo inconsistente o versión distinta: se ignora.
  assert.equal(decodeHeader(ab.slice(0, ab.byteLength - 1)), null);
  const bad = new Uint8Array(ab.slice(0));
  bad[0] = 2;
  assert.equal(decodeHeader(bad.buffer), null);
});

test("escalones de ancho y rectángulos de dibujo", () => {
  for (const [px, t] of [[0, 0], [100, 320], [320, 320], [321, 480], [700, 960], [1920, 1920], [2500, 0]] as const) {
    assert.equal(tierFor(px), t, `servidor ${px}`);
    assert.equal(webTierFor(px), t, `navegador ${px}`);
  }
  // cover: 1920×1080 en un lienzo cuadrado recorta los costados.
  const c = drawRect(1920, 1080, 500, 500, "cover");
  assert.deepEqual([Math.round(c.sx), c.sy, Math.round(c.sw), c.sh, c.dx, c.dy, c.dw, c.dh], [420, 0, 1080, 1080, 0, 0, 500, 500]);
  // contain: imagen 4:3 en lienzo 16:9 con bandas laterales.
  const k = drawRect(640, 480, 1600, 900, "contain");
  assert.deepEqual([k.sx, k.sy, k.sw, k.sh, k.dx, k.dy, k.dw, k.dh], [0, 0, 640, 480, 200, 0, 1200, 900]);
});
