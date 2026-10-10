export interface CameraInfo {
  cameraId: string;
  name: string;
  online: boolean;
  /** Deshabilitada en el propio servidor de video (no se mostrará por defecto). */
  disabled?: boolean;
  raw?: unknown;
}

export interface Clip {
  start: string; // ISO UTC
  end: string; // ISO UTC
}

export interface Snapshot {
  data: Buffer;
  contentType: string;
  ts: number;
  /** Tamaño del cuadro (si se leyó de la cabecera JPEG). */
  width?: number;
  height?: number;
}

/** Opciones de un cuadro: calidad/tamaño pedidos al servidor (si los soporta) y cancelación. */
export interface SnapshotOpts {
  quality?: number;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Cuadro de video en vivo (LiveHub): aplica el perfil de video en vivo del servidor y sus fallas
   * no cambian el estado del servidor (son muchas y transitorias).
   */
  live?: boolean;
}

export interface LiveStream {
  body: AsyncIterable<Uint8Array>;
  contentType: string;
  abort: () => void;
}

export interface SourceStatus {
  ok: boolean;
  detail: string;
  lastOkAt: number | null;
  latencyMs?: number;
}

/** Fuente de video: un servidor exacqVision real o el simulador de demo. */
export interface VideoSource {
  readonly id: string;
  readonly name: string;
  readonly kind: "exacq" | "demo";
  listCameras(): Promise<CameraInfo[]>;
  snapshot(cameraId: string, opts?: SnapshotOpts): Promise<Snapshot>;
  /** Stream MJPEG nativo si la fuente lo soporta (si no, se sintetiza a partir de snapshots). */
  liveStream?(cameraId: string): Promise<LiveStream | null>;
  searchRecordings(cameraId: string, start: Date, end: Date): Promise<Clip[]>;
  startExport?(cameraId: string, start: Date, end: Date, name: string): Promise<string>;
  exportProgress?(exportId: string): Promise<number>;
  downloadExport?(exportId: string, dest: string): Promise<{ bytes: number; filename: string }>;
  finishExport?(exportId: string): Promise<void>;
  status(): SourceStatus;
  dispose?(): Promise<void>;
}
