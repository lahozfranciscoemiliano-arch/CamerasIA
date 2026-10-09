export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type StepUpHandler = () => Promise<boolean>;
type UnauthHandler = () => void;

let stepUpHandler: StepUpHandler | null = null;
let unauthHandler: UnauthHandler | null = null;

export const setStepUpHandler = (h: StepUpHandler | null) => {
  stepUpHandler = h;
};
export const setUnauthorizedHandler = (h: UnauthHandler | null) => {
  unauthHandler = h;
};

const BASE_HEADERS = { "X-Requested-With": "CamerasIA" };

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { ...BASE_HEADERS, "Content-Type": "application/json" } : BASE_HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("application/json") ? await res.json() : await res.text()) as T;
  }
  let data: { error?: string; message?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  const err = new ApiError(res.status, data.error ?? "error", data.message ?? `Error ${res.status}`);
  // Acción sensible: pedir re-autenticación 2FA y reintentar una vez.
  if (err.code === "step_up_required" && stepUpHandler && !retried) {
    if (await stepUpHandler()) return request<T>(method, path, body, true);
  }
  if (res.status === 401 && err.code === "unauthenticated") unauthHandler?.();
  throw err;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** POST que devuelve Server-Sent Events (streaming de la IA). */
export async function streamSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let data: { error?: string; message?: string } = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? `Error ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      try {
        onEvent(event, JSON.parse(dataLines.join("\n")));
      } catch {
        onEvent(event, dataLines.join("\n"));
      }
    }
  }
}
