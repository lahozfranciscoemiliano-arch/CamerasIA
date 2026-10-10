import type { Writable } from "node:stream";

/**
 * Escritor multipart/x-mixed-replace "sólo el último cuadro": si el cliente (o el proxy) no
 * consume, no se encolan cuadros viejos; se guarda uno pendiente y se reemplaza por cada cuadro
 * nuevo. Al vaciarse el buffer (evento drain) se escribe el pendiente. Así el buffer nunca supera
 * ~un cuadro más el high-water mark y la demora no crece mientras la vista siga abierta.
 */
export function pipeLatestMultipart(raw: Writable, boundary: string) {
  let pending: { data: Buffer; contentType: string } | null = null;
  let waitingDrain = false;
  let closed = false;
  let dropped = 0;

  const write = (data: Buffer, contentType: string) => {
    raw.write(`--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Length: ${data.length}\r\n\r\n`);
    raw.write(data);
    // write() devuelve false cuando el buffer superó el high-water mark: esperar drain.
    waitingDrain = !raw.write("\r\n");
  };

  const onDrain = () => {
    waitingDrain = false;
    if (closed || !pending) return;
    const p = pending;
    pending = null;
    write(p.data, p.contentType);
  };
  raw.on("drain", onDrain);

  return {
    push(data: Buffer, contentType = "image/jpeg") {
      if (closed || raw.writableEnded || raw.destroyed) return;
      if (waitingDrain) {
        if (pending) dropped++;
        pending = { data, contentType };
        return;
      }
      write(data, contentType);
    },
    close() {
      closed = true;
      pending = null;
      raw.off("drain", onDrain);
    },
    get dropped() {
      return dropped;
    },
  };
}
