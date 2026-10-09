import { EventEmitter } from "node:events";

export type RealtimeTopic =
  | "event.new"
  | "event.update"
  | "vpn.status"
  | "vpn.log"
  | "camera.status"
  | "health.update"
  | "ai.analysis"
  | "system.notice";

export interface RealtimeMessage {
  topic: RealtimeTopic;
  data: unknown;
  ts: number;
}

/** Bus interno: los servicios publican, el hub WebSocket reenvía a los clientes autenticados. */
export class Bus extends EventEmitter {
  publish(topic: RealtimeTopic, data: unknown) {
    const msg: RealtimeMessage = { topic, data, ts: Date.now() };
    this.emit("message", msg);
  }
}
