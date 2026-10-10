const CAMERA_FIELDS = new Set(["id", "Id", "name", "Name", "enabled", "Enabled", "connected", "Connected", "online", "Online", "disabled", "state"]);

/** Preserva la estructura para diagnosticar versiones distintas sin exponer
 * valores de configuración, usuarios ni tokens del Web Service. */
function shape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 12) return Array.isArray(value) ? "array" : "object";
  if (Array.isArray(value)) return { type: "array", length: value.length, sample: value.slice(0, 3).map((item) => shape(item, depth + 1)) };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]));
}

export function diagnosticConfig(config: unknown) {
  const root = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const cameraField = Array.isArray(root.Cameras) ? "Cameras" : Array.isArray(root.cameras) ? "cameras" : null;
  const inventory = cameraField ? root[cameraField] as unknown[] : [];
  const cameras = inventory.filter((cam): cam is Record<string, unknown> => Boolean(cam) && typeof cam === "object" && !Array.isArray(cam)).map((cam) =>
    Object.fromEntries(Object.entries(cam).filter(([key, value]) => CAMERA_FIELDS.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value)))),
  );
  return { cameraField, cameraCount: inventory.length, cameras, shape: shape(config) };
}
