import { BellRing, Cctv, CheckCircle2, Copy, Edit3, FileClock, KeyRound, Link2, Plug, Plus, RefreshCw, ScanSearch, Server, ShieldCheck, Sparkles, Trash2, Unlock, UserPlus, Users, Webhook, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "../components/toasts";
import { Dot, Empty, ErrorNote, Field, Modal, OkNote, PageHeader, Panel, Spinner, Tabs, Toggle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtAgo, fmtDateTime, fmtHM, ROLE_LABEL, SEVERITY_LABEL } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { AlertSettings, AuditRow, Camera, ExacqServer, Role, Severity, User, VaultEntry, VpnProfile } from "../lib/types";

type Tab = "users" | "servers" | "cameras" | "alerts" | "ai" | "integrations" | "audit";

const MUTE_CHOICES: Array<{ value: string; label: string; minutes?: number; forever?: boolean }> = [
  { value: "", label: "Activas" },
  { value: "60", label: "Silenciar 1 h", minutes: 60 },
  { value: "480", label: "Silenciar 8 h", minutes: 480 },
  { value: "1440", label: "Silenciar 24 h", minutes: 1440 },
  { value: "10080", label: "Silenciar 7 d", minutes: 10_080 },
  { value: "forever", label: "Silenciar siempre", forever: true },
];
// "Para siempre" se guarda como 9999-12-31.
const FOREVER_FROM = Date.UTC(9000, 0, 1);

// ───────────────────────── Usuarios ─────────────────────────
function UsersTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const toast = useToast();
  const { data: users, reload } = useApi<User[]>("/api/users");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", role: "operator" as Role, password: "" });
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: "ok", title: ok });
      void reload();
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    }
  };
  return (
    <Panel
      title="Usuarios y roles"
      icon={<Users size={16} />}
      actions={canAdmin && (
        <button className="btn btn-sm" onClick={() => (setForm({ username: "", displayName: "", role: "operator", password: "" }), setError(""), setOpen(true))}>
          <UserPlus size={14} /> Nuevo usuario
        </button>
      )}
    >
      <div className="text-xs text-ink-2 mb-3">
        <b>Administrador</b>: todo. <b>Operador</b>: video, eventos, IA y conectar VPN. <b>Observador</b>: sólo ver. <b>Tester (ChatGPT)</b>: ver cámaras, consultar configuración y ejecutar diagnósticos de exacqVision. Todos deben activar 2FA en el primer ingreso.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="label text-left">
            <tr>
              <th className="py-2 pr-3">Usuario</th>
              <th className="pr-3">Rol</th>
              <th className="pr-3">2FA</th>
              <th className="pr-3">Último ingreso</th>
              <th className="pr-3">Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id} className="border-t border-line-soft">
                <td className="py-2 pr-3">
                  <div className="font-medium">{u.displayName}</div>
                  <div className="text-xs text-muted font-mono">{u.username}</div>
                </td>
                <td className="pr-3">
                  {canAdmin ? <select className="input !py-1 !w-44" value={u.role} onChange={(e) => void run(() => api.patch(`/api/users/${u.id}`, { role: e.target.value }), "Rol actualizado")}>
                    {(["admin", "operator", "viewer", "tester"] as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select> : ROLE_LABEL[u.role]}
                </td>
                <td className="pr-3">{u.totpEnabled ? <span className="text-ok flex items-center gap-1"><ShieldCheck size={14} /> Activo</span> : <span className="text-warn">Pendiente</span>}</td>
                <td className="pr-3 text-xs text-ink-2">
                  {fmtAgo(u.lastLoginAt)}
                  <div className="text-muted font-mono">{u.lastLoginIp ?? ""}</div>
                </td>
                <td className="pr-3">
                  {u.disabled ? <span className="text-muted">Deshabilitado</span> : u.lockedUntil && u.lockedUntil > Date.now() ? <span className="text-crit">Bloqueado</span> : <span className="text-ok">Activo</span>}
                </td>
                <td className="text-right whitespace-nowrap space-x-1">
                  {canAdmin && <>
                  {u.lockedUntil && u.lockedUntil > Date.now() && (
                    <button className="btn btn-ghost btn-sm" title="Desbloquear" onClick={() => void run(() => api.post(`/api/users/${u.id}/unlock`), "Usuario desbloqueado")}>
                      <Unlock size={14} />
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Restablecer contraseña"
                    onClick={() => {
                      const p = prompt(`Nueva contraseña temporal para ${u.username} (12+ caracteres, 3 tipos):`);
                      if (p) void run(() => api.post(`/api/users/${u.id}/password`, { password: p }), "Contraseña restablecida (deberá cambiarla al ingresar)");
                    }}
                  >
                    <KeyRound size={14} />
                  </button>
                  <button className="btn btn-ghost btn-sm" title="Restablecer 2FA" onClick={() => confirm(`¿Restablecer 2FA de ${u.username}? Deberá enrolarse de nuevo.`) && void run(() => api.post(`/api/users/${u.id}/reset-2fa`), "2FA restablecido")}>
                    <ShieldCheck size={14} />
                  </button>
                  <button className="btn btn-ghost btn-sm" title={u.disabled ? "Habilitar" : "Deshabilitar"} onClick={() => void run(() => api.patch(`/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? "Usuario habilitado" : "Usuario deshabilitado")}>
                    {u.disabled ? <CheckCircle2 size={14} className="text-ok" /> : <XCircle size={14} className="text-crit" />}
                  </button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={canAdmin && open}
        onClose={() => setOpen(false)}
        title="Nuevo usuario"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                setError("");
                try {
                  await api.post("/api/users", form);
                  setOpen(false);
                  toast({ tone: "ok", title: "Usuario creado", body: "Deberá cambiar la contraseña y activar 2FA en su primer ingreso." });
                  void reload();
                } catch (e) {
                  setError((e as ApiError).message);
                }
              }}
            >
              Crear
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Usuario">
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label="Nombre a mostrar">
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </Field>
          <Field label="Rol">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(["admin", "operator", "viewer", "tester"] as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contraseña temporal">
            <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Modal>
    </Panel>
  );
}

// ───────────────────────── Servidores exacqVision ─────────────────────────
function ServersTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const toast = useToast();
  const { data: servers, reload } = useApi<ExacqServer[]>("/api/exacq/servers");
  const { data: vault } = useApi<VaultEntry[]>("/api/vault");
  const { data: profiles } = useApi<VpnProfile[]>("/api/vpn/profiles");
  const [editing, setEditing] = useState<ExacqServer | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<ExacqServer>>({});
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ title: string; kind: "test" | "detect" | "raw"; serverId: string; body: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const edit = (s: ExacqServer | null) => {
    setEditing(s);
    setForm(s ?? { name: "exacqVision Principal", baseUrl: "http://192.168.109.58", enabled: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    setError("");
    setOpen(true);
  };
  const save = async () => {
    setError("");
    const body = {
      name: form.name,
      baseUrl: form.baseUrl,
      credentialId: form.credentialId || null,
      enabled: form.enabled ?? true,
      snapshotTemplate: form.snapshotTemplate || null,
      liveTemplate: form.liveTemplate || null,
      vpnProfileId: form.vpnProfileId || null,
      timezone: form.timezone || null,
    };
    try {
      if (editing) await api.patch(`/api/exacq/servers/${editing.id}`, body);
      else await api.post("/api/exacq/servers", body);
      setOpen(false);
      void reload();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const action = async (id: string, kind: "test" | "detect" | "raw") => {
    setBusy(`${id}:${kind}`);
    try {
      const r = kind === "raw" ? await api.get(`/api/exacq/servers/${id}/raw-config`) : await api.post(`/api/exacq/servers/${id}/${kind}`);
      setResult({
        title: kind === "test" ? "Prueba de conexión" : kind === "detect" ? "Detección de URLs de video" : canAdmin ? "config.web (JSON crudo)" : "Diagnóstico de cámaras (config.web)",
        kind,
        serverId: id,
        body: r,
      });
      void reload();
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Servidores exacqVision" icon={<Server size={16} />} actions={canAdmin && <button className="btn btn-sm" onClick={() => edit(null)}><Plus size={14} /> Agregar servidor</button>}>
      <div className="text-xs text-ink-2 mb-3">
        Se usa la API HTTP del <b>exacqVision Web Service</b> (login.web, config.web, search.web, export.web). Si el servidor está en la red interna y este centro corre fuera de ella, asocie un perfil
        FortiVPN y conéctelo en <i>Conectividad</i>.
      </div>
      {servers?.length ? (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.id} className="rounded-xl border border-line p-3 flex flex-wrap items-center gap-3">
              <Dot tone={!s.enabled ? "muted" : s.lastError ? "crit" : s.lastOkAt ? "ok" : "warn"} pulse={Boolean(s.lastError)} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{s.name}</div>
                <div className="text-xs font-mono text-ink-2">{s.baseUrl}</div>
                <div className="text-xs text-muted">{s.lastError ? `Error: ${s.lastError}` : s.lastOkAt ? `OK ${fmtAgo(s.lastOkAt)}` : "Sin contacto todavía"}</div>
                {!canAdmin && <div className="mt-2 text-xs text-ink-2 space-y-1">
                  <div>Estado: {s.enabled ? "Habilitado" : "Deshabilitado"} · Zona horaria: {s.timezone ?? "Predeterminada"}</div>
                  <div>VPN: {s.vpnProfileId ? profiles?.find((p) => p.id === s.vpnProfileId)?.name ?? s.vpnProfileId : "Acceso directo"}</div>
                  <div>Credencial: {s.credentialId ? vault?.find((v) => v.id === s.credentialId)?.name ?? s.credentialId : "Sin credencial"}</div>
                  <div className="break-all">Snapshot: {s.snapshotTemplate ?? "Predeterminado"}</div>
                  <div className="break-all">Stream: {s.liveTemplate ?? "Predeterminado"}</div>
                </div>}
              </div>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void action(s.id, "test")}>
                {busy === `${s.id}:test` ? <Spinner size={13} /> : <Plug size={13} />} Probar
              </button>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void action(s.id, "detect")} title="Prueba URLs candidatas de snapshot/stream">
                {busy === `${s.id}:detect` ? <Spinner size={13} /> : <ScanSearch size={13} />} Detectar video
              </button>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void action(s.id, "raw")}>
                JSON
              </button>
              {canAdmin && <><button className="btn btn-ghost btn-sm" onClick={() => edit(s)}>
                <Edit3 size={14} />
              </button>
              <button className="btn btn-ghost btn-sm text-muted hover:text-crit" onClick={async () => confirm(`¿Eliminar ${s.name}?`) && (await api.del(`/api/exacq/servers/${s.id}`), void reload())}>
                <Trash2 size={14} />
              </button>
              </>}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Server size={28} />} title="Sin servidores configurados">
          {canAdmin ? "Agregue su servidor (p. ej. http://192.168.109.58) y una credencial de exacqVision de la bóveda." : "Un administrador debe agregar el servidor de exacqVision y su credencial."}
        </Empty>
      )}

      <Modal
        open={canAdmin && open}
        onClose={() => setOpen(false)}
        title={editing ? `Editar ${editing.name}` : "Agregar servidor exacqVision"}
        width={680}
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button className="btn btn-primary" onClick={() => void save()}>
              Guardar
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Nombre">
            <input className="input" value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="URL del Web Service" hint="La misma dirección con la que abre el cliente web de exacq, normalmente http:// (p. ej. http://192.168.109.58, o :8080 si cambió el puerto)">
            <input className="input font-mono" value={form.baseUrl ?? ""} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </Field>
          <Field label="Credencial (bóveda)">
            <select className="input" value={form.credentialId ?? ""} onChange={(e) => setForm({ ...form, credentialId: e.target.value || null })}>
              <option value="">— Seleccionar —</option>
              {vault
                ?.filter((v) => v.kind === "exacq" || v.kind === "generic")
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.usernameMasked})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Requiere VPN (perfil)">
            <select className="input" value={form.vpnProfileId ?? ""} onChange={(e) => setForm({ ...form, vpnProfileId: e.target.value || null })}>
              <option value="">— Acceso directo —</option>
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Zona horaria del servidor">
            <input className="input" value={form.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="America/Argentina/Buenos_Aires" />
          </Field>
          <div className="pt-6">
            <Toggle checked={form.enabled ?? true} onChange={(v) => setForm({ ...form, enabled: v })} label="Habilitado" />
          </div>
          <div className="sm:col-span-2">
            <Field label="Plantilla de snapshot (opcional)" hint="Variables {session} {camera} {quality}. Vacío = automático: se prueban las URLs conocidas y se guarda la que funcione ('Detectar video' lo hace a pedido).">
              <input className="input font-mono text-xs" value={form.snapshotTemplate ?? ""} onChange={(e) => setForm({ ...form, snapshotTemplate: e.target.value })} placeholder="/v1/video.web?s={session}&camera={camera}&fmt=jpg" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Plantilla de stream MJPEG (opcional)" hint="Si se define y responde multipart, se usa para video fluido; si no, se arma el video con snapshots.">
              <input className="input font-mono text-xs" value={form.liveTemplate ?? ""} onChange={(e) => setForm({ ...form, liveTemplate: e.target.value })} placeholder="/v1/video.web?s={session}&camera={camera}&fmt=mjpg" />
            </Field>
          </div>
        </div>
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Modal>
      <Modal open={Boolean(result)} onClose={() => setResult(null)} title={result?.title ?? ""} width={760}>
        {result?.kind === "test" ? (
          <DiagnosisView
            d={result.body as Diagnosis}
            onUseUrl={!canAdmin ? undefined : async (baseUrl) => {
              try {
                await api.patch(`/api/exacq/servers/${result.serverId}`, { baseUrl });
                toast({ tone: "ok", title: `URL cambiada a ${baseUrl}` });
                setResult(null);
                void reload();
                void action(result.serverId, "test");
              } catch (e) {
                toast({ tone: "error", title: (e as ApiError).message });
              }
            }}
          />
        ) : result?.kind === "detect" ? (
          <DetectView d={result.body as Detection} />
        ) : (
          <pre className="font-mono text-xs bg-bg p-3 rounded-lg border border-line overflow-auto max-h-[60vh]">{JSON.stringify(result?.body, null, 2)}</pre>
        )}
      </Modal>
    </Panel>
  );
}

interface Diagnosis {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string; ms?: number }>;
  cameras?: number;
  online?: number;
  disabled?: number;
  sample?: Array<{ id: string; name: string; online: boolean }>;
  snapshotTemplate?: string;
  suggestion?: { baseUrl: string; reason: string };
  latencyMs?: number;
}

interface Detection {
  snapshot: string | null;
  live: string | null;
  applied?: boolean;
  tried: Array<{ template: string; result: string }>;
}

function DiagnosisView({ d, onUseUrl }: { d: Diagnosis; onUseUrl?: (baseUrl: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {d.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
            {s.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-crit" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">
                {s.step} {s.ms !== undefined && <span className="text-xs font-normal text-muted">· {s.ms} ms</span>}
              </div>
              <div className="text-xs text-ink-2 break-words">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>
      {d.suggestion && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">{d.suggestion.reason}</div>
          {onUseUrl && <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onUseUrl?.(d.suggestion!.baseUrl);
              setBusy(false);
            }}
          >
            {busy ? <Spinner size={13} /> : <Link2 size={13} />} Usar {d.suggestion.baseUrl}
          </button>}
        </div>
      )}
      {d.ok && <OkNote>Todo en orden: {d.online} de {d.cameras} cámaras con video. Las imágenes aparecen en el Video en vivo.</OkNote>}
      {d.snapshotTemplate && (
        <div className="text-xs text-muted">
          URL de imagen en uso: <code className="font-mono text-ink-2 break-all">{d.snapshotTemplate}</code>
        </div>
      )}
    </div>
  );
}

function DetectView({ d }: { d: Detection }) {
  return (
    <div className="space-y-3">
      {d.applied ? (
        <OkNote>
          Guardado en el servidor. Imagen: <code className="font-mono break-all">{d.snapshot ?? "—"}</code>
          {d.live ? (
            <>
              {" "}
              · Stream: <code className="font-mono break-all">{d.live}</code>
            </>
          ) : (
            " · Sin stream MJPEG: el video se arma con imágenes sucesivas."
          )}
        </OkNote>
      ) : d.snapshot ? (
        <OkNote>
          Funciona: <code className="font-mono break-all">{d.snapshot}</code>. Un administrador debe pulsar "Detectar video" para guardarla.
        </OkNote>
      ) : (
        <ErrorNote>Ninguna URL conocida devolvió imagen. Use "Probar" para ver en qué paso falla.</ErrorNote>
      )}
      <table className="w-full text-xs">
        <tbody>
          {d.tried.map((t, i) => (
            <tr key={i} className="border-t border-line-soft">
              <td className="py-1.5 pr-3 font-mono break-all text-ink-2">{t.template}</td>
              <td className={`py-1.5 whitespace-nowrap ${t.result.startsWith("OK") ? "text-ok" : "text-muted"}`}>{t.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────── Cámaras ─────────────────────────
function CamerasTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const toast = useToast();
  const canMute = can("operator");
  // Incluye las deshabilitadas en exacqVision (se muestran atenuadas).
  const { data: cams, setData } = useApi<Camera[]>("/api/cameras?all=1");
  const mute = async (c: Camera, value: string) => {
    const choice = MUTE_CHOICES.find((m) => m.value === value);
    try {
      const u = await api.post<Camera>(`/api/cameras/${encodeURIComponent(c.id)}/mute`, choice?.forever ? { minutes: null, forever: true } : { minutes: choice?.minutes ?? null });
      setData((all) => all?.map((x) => (x.id === c.id ? u : x)) ?? all);
      toast({ tone: "ok", title: choice?.minutes || choice?.forever ? `Alertas de ${c.name} silenciadas` : `Alertas de ${c.name} activas` });
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    }
  };
  const patch = async (c: Camera, body: Record<string, unknown>) => {
    try {
      const u = await api.patch<Camera>(`/api/cameras/${encodeURIComponent(c.id)}`, body);
      setData((all) => all?.map((x) => (x.id === c.id ? u : x)) ?? all);
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    }
  };
  return (
    <Panel title="Cámaras" icon={<Cctv size={16} />}>
      <div className="text-xs text-ink-2 mb-3">
        <b>Detección</b>: análisis local de movimiento y sabotaje (sin costo). <b>Verificación IA</b>: cada alarma de movimiento se confirma con Claude visión, que clasifica (persona, vehículo, intrusión…) y descarta falsas alarmas.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="label text-left">
            <tr>
              <th className="py-2 pr-3">Cámara</th>
              <th className="pr-3">Zona</th>
              <th className="pr-3">Servidor</th>
              <th className="pr-3">Visible</th>
              <th className="pr-3">Detección</th>
              <th className="pr-3">Verificación IA</th>
              <th className="pr-3">Sensibilidad</th>
              <th className="pr-3">Alertas</th>
            </tr>
          </thead>
          <tbody>
            {cams?.map((c) => (
              <tr key={c.id} className={`border-t border-line-soft ${c.vmsDisabled ? "opacity-50" : ""}`}>
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <Dot tone={c.vmsDisabled ? "muted" : c.online ? "ok" : "crit"} />
                    <input className="input !py-1 !w-48" readOnly={!canAdmin} defaultValue={c.name} onBlur={(e) => canAdmin && e.target.value !== c.name && void patch(c, { name: e.target.value })} />
                  </span>
                </td>
                <td className="pr-3">
                  <input className="input !py-1 !w-36" readOnly={!canAdmin} defaultValue={c.zone ?? ""} placeholder="Perímetro, Depósito…" onBlur={(e) => canAdmin && e.target.value !== (c.zone ?? "") && void patch(c, { zone: e.target.value || null })} />
                </td>
                <td className="pr-3 text-xs text-ink-2">
                  {c.serverName}
                  {c.vmsDisabled && <div className="text-[10px] text-muted whitespace-nowrap">Deshabilitada en exacqVision</div>}
                </td>
                <td className="pr-3">
                  <Toggle checked={c.enabled} onChange={(v) => void patch(c, { enabled: v })} disabled={!canAdmin} />
                </td>
                <td className="pr-3">
                  <Toggle checked={c.motionEnabled} onChange={(v) => void patch(c, { motionEnabled: v })} disabled={!canAdmin} />
                </td>
                <td className="pr-3">
                  <Toggle checked={c.aiVerify} onChange={(v) => void patch(c, { aiVerify: v })} disabled={!canAdmin || !c.motionEnabled} />
                </td>
                <td className="pr-3">
                  <input type="range" min={1} max={100} defaultValue={c.sensitivity} disabled={!canAdmin} className="accent-[#22d3ee] w-28" onMouseUp={(e) => canAdmin && void patch(c, { sensitivity: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => canAdmin && void patch(c, { sensitivity: Number((e.target as HTMLInputElement).value) })} />
                  <span className="text-xs font-mono ml-1">{c.sensitivity}</span>
                </td>
                <td className="pr-3">
                  <select className="input !py-1 !w-40" value="" disabled={!canMute || c.vmsDisabled} onChange={(e) => void mute(c, e.target.value)} aria-label={`Alertas de ${c.name}`}>
                    <option value="" disabled>
                      {c.alertsMutedUntil ? (c.alertsMutedUntil >= FOREVER_FROM ? "Silenciada siempre" : `Silenciada hasta ${fmtHM(c.alertsMutedUntil)}`) : "Activas"}
                    </option>
                    {MUTE_CHOICES.filter((m) => m.value || c.alertsMutedUntil).map((m) => (
                      <option key={m.value || "on"} value={m.value || "on"}>
                        {m.value ? m.label : "Reactivar"}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ───────────────────────── Alertas (política del servidor) ─────────────────────────
const ALERT_FIELDS: Array<{ group: string; fields: Array<{ key: keyof AlertSettings; label: string; unit?: string }> }> = [
  {
    group: "Cámaras y servidores de video",
    fields: [
      { key: "cameraOfflineAfterSec", label: "Cámara sin señal: avisar tras", unit: "s" },
      { key: "cameraOfflineMinSyncs", label: "…y al menos estas sincronizaciones seguidas" },
      { key: "groupMinCameras", label: "Agrupar desde (cámaras a la vez)" },
      { key: "sourceDownAfterSec", label: "Servidor caído: avisar tras", unit: "s" },
      { key: "sourceDownMinSyncs", label: "…y al menos estas sincronizaciones seguidas" },
      { key: "sourceCriticalAfterMin", label: "Servidor caído: crítica tras", unit: "min" },
    ],
  },
  {
    group: "VPN y equipos",
    fields: [
      { key: "vpnDownGraceSec", label: "VPN caída: período de gracia (microcortes)", unit: "s" },
      { key: "vpnCriticalAfterMin", label: "VPN caída: crítica tras", unit: "min" },
      { key: "hostDownAfterChecks", label: "Equipo caído tras chequeos fallidos" },
      { key: "hostUpAfterChecks", label: "Equipo recuperado tras chequeos correctos" },
      { key: "hostProbeRetryMs", label: "Reintento de sondeo", unit: "ms" },
    ],
  },
  {
    group: "Repeticiones y detección",
    fields: [
      { key: "reopenWindowMin", label: "Reabrir el mismo evento si vuelve a caer dentro de", unit: "min" },
      { key: "motionDedupeMin", label: "Movimiento: agrupar repeticiones durante", unit: "min" },
      { key: "aiReverifyMin", label: "Re-verificar con IA cada", unit: "min" },
      { key: "tamperConfirmFrames", label: "Sabotaje: cuadros seguidos para confirmar" },
      { key: "tamperGlobalCameras", label: "Sabotaje simultáneo = cambio global desde (cámaras)" },
      { key: "tamperGlobalWindowSec", label: "Ventana de sabotaje simultáneo", unit: "s" },
      { key: "tamperDedupeMin", label: "Sabotaje: agrupar repeticiones durante", unit: "min" },
      { key: "ingestDedupeSec", label: "Detecciones externas: agrupar repeticiones durante", unit: "s" },
    ],
  },
  {
    group: "Notificaciones",
    fields: [
      { key: "notifyCoalesceMs", label: "Agrupar avisos que llegan dentro de", unit: "ms" },
      { key: "maxNotificationsPerMin", label: "Máximo de avisos por minuto (las críticas no esperan)" },
    ],
  },
];

function AlertsTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const toast = useToast();
  const { data } = useApi<AlertSettings>("/api/alerts/settings");
  const [form, setForm] = useState<AlertSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  if (!form) return <Spinner />;
  return (
    <Panel title="Política de alertas del servidor" icon={<BellRing size={16} />} bodyClass="p-4 space-y-5 max-w-4xl">
      <p className="text-sm text-ink-2">
        Regla general: <b>se avisa si algo sigue caído más de 1 minuto</b>. Los microcortes se registran sin avisar, las caídas simultáneas se agrupan y lo
        repetido suma ocurrencias en el mismo evento. Cada consola elige además qué ve y oye en <i>Mi perfil → Alertas en esta consola</i>.
      </p>
      {ALERT_FIELDS.map((g) => (
        <div key={g.group}>
          <div className="label mb-2">{g.group}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {g.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`}>
                <input
                  className="input"
                  type="number"
                  readOnly={!canAdmin}
                  value={form[f.key] as number}
                  onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
      <Field label="Severidad mínima para notificar">
        <select className="input !w-48" disabled={!canAdmin} value={form.notifyMinSeverity} onChange={(e) => setForm({ ...form, notifyMinSeverity: e.target.value as Severity })}>
          {(["info", "low", "medium", "high", "critical"] as Severity[]).map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNote>{error}</ErrorNote>
      {canAdmin && (
        <button
          className="btn btn-primary"
          onClick={async () => {
            setError("");
            try {
              setForm(await api.put<AlertSettings>("/api/alerts/settings", form));
              toast({ tone: "ok", title: "Política de alertas guardada" });
            } catch (e) {
              setError((e as ApiError).message);
            }
          }}
        >
          Guardar
        </button>
      )}
    </Panel>
  );
}

// ───────────────────────── IA ─────────────────────────
function AiTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const toast = useToast();
  const { data } = useApi<{ available: boolean; model: string; settings: { siteContext: string; businessHours: string; autoVerify: boolean } }>("/api/ai/status");
  const [form, setForm] = useState({ siteContext: "", businessHours: "", autoVerify: true });
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  return (
    <Panel title="Inteligencia artificial (Claude)" icon={<Sparkles size={16} />} bodyClass="p-4 space-y-4 max-w-3xl">
      {data && (data.available ? <OkNote>Conectado con {data.model}. La API key se toma de la bóveda (tipo "Anthropic API").</OkNote> : <ErrorNote>No hay API key: cargue una credencial tipo "Anthropic API" en la Bóveda.</ErrorNote>)}
      <Field label="Contexto del sitio" hint="Ayuda a la IA a evaluar riesgos: tipo de instalación, zonas restringidas, qué es normal y qué no.">
        <textarea className="input h-28" readOnly={!canAdmin} value={form.siteContext} onChange={(e) => setForm({ ...form, siteContext: e.target.value })} />
      </Field>
      <Field label="Horario laboral">
        <input className="input" readOnly={!canAdmin} value={form.businessHours} onChange={(e) => setForm({ ...form, businessHours: e.target.value })} />
      </Field>
      <Toggle checked={form.autoVerify} onChange={(v) => setForm({ ...form, autoVerify: v })} disabled={!canAdmin} label="Verificar automáticamente las alarmas de movimiento con IA (en cámaras con verificación activa)" />
      {canAdmin && <button
        className="btn btn-primary"
        onClick={async () => {
          await api.put("/api/ai/settings", form);
          toast({ tone: "ok", title: "Configuración de IA guardada" });
        }}
      >
        Guardar
      </button>
      }
    </Panel>
  );
}

// ───────────────────────── Integraciones ─────────────────────────
function IntegrationsTab() {
  const { can } = useAuth();
  const canAdmin = can("admin");
  const { data: keys, reload } = useApi<Array<{ id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null; revoked: number }>>("/api/ingest/keys");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const example = `curl -X POST ${location.origin}/api/ingest/detections \\
  -H "Authorization: Bearer ${(canAdmin && created) || "cia_XXXXXXXX"}" \\
  -H "Content-Type: application/json" \\
  -d '{"camera":"Acceso Principal","type":"person","severity":"high","title":"Persona detectada fuera de horario","confidence":0.91,"snapshot":"<jpeg base64>","verify":true}'`;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Panel title="Ingesta de detecciones externas" icon={<Webhook size={16} />} bodyClass="p-4 space-y-3">
        <p className="text-sm text-ink-2">
          Permite que otros sistemas (Frigate, CodeProject.AI, analíticas de cámaras, scripts, Node-RED) envíen detecciones al centro. Opcionalmente se verifican con IA.
        </p>
        {canAdmin && <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api.post<{ key: string }>("/api/ingest/keys", { name });
            setCreated(r.key);
            setName("");
            void reload();
          }}
        >
          <input className="input" placeholder="Nombre de la integración (p. ej. Frigate depósito)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" disabled={!name}>
            <Plus size={14} /> Crear clave
          </button>
        </form>}
        {canAdmin && created && (
          <OkNote>
            Copie la clave ahora; no se volverá a mostrar:
            <code className="block font-mono text-xs mt-1 break-all select-all">{created}</code>
          </OkNote>
        )}
        <table className="w-full text-sm">
          <tbody>
            {keys?.map((k) => (
              <tr key={k.id} className="border-t border-line-soft">
                <td className="py-2">{k.name}</td>
                <td className="font-mono text-xs text-ink-2">{k.prefix}…</td>
                <td className="text-xs text-muted">{k.lastUsedAt ? `usada ${fmtAgo(k.lastUsedAt)}` : "sin uso"}</td>
                <td className="text-right">
                  {k.revoked ? (
                    <span className="text-xs text-muted">revocada</span>
                  ) : canAdmin ? (
                    <button className="btn btn-ghost btn-sm text-muted hover:text-crit" onClick={async () => (await api.del(`/api/ingest/keys/${k.id}`), void reload())}>
                      Revocar
                    </button>
                  ) : <span className="text-xs text-ok">activa</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Ejemplo" icon={<Link2 size={16} />} bodyClass="p-4 space-y-2">
        <pre className="font-mono text-[11px] bg-bg p-3 rounded-lg border border-line overflow-x-auto whitespace-pre-wrap">{example}</pre>
        <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(example)}>
          <Copy size={13} /> Copiar
        </button>
        <p className="text-xs text-muted">
          Campos: camera (nombre, id exacq o id interno), type (person, vehicle, intrusion, loitering, tamper, external…), severity (info…critical), title, description, confidence, snapshot (JPEG
          base64), verify (pedir verificación IA).
        </p>
      </Panel>
    </div>
  );
}

// ───────────────────────── Auditoría ─────────────────────────
function AuditTab() {
  const [action, setAction] = useState("");
  const { data, reload } = useApi<AuditRow[]>(`/api/audit?limit=300${action ? `&action=${encodeURIComponent(action)}` : ""}`);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null);
  return (
    <Panel
      title="Bitácora de auditoría (encadenada con SHA-256)"
      icon={<FileClock size={16} />}
      actions={
        <>
          <select className="input !py-1 !w-44" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas las acciones</option>
            {["auth", "vault", "vpn", "user", "exacq", "camera", "event", "alerts", "recording", "ai", "ingest"].map((a) => (
              <option key={a} value={a}>
                {a}.*
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={async () => setVerify(await api.get("/api/audit/verify"))}>
            <ShieldCheck size={14} /> Verificar integridad
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => void reload()}>
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      {verify && (
        <div className="mb-3">
          {verify.ok ? <OkNote>Cadena íntegra: {verify.checked} registros verificados, sin alteraciones.</OkNote> : <ErrorNote>¡Cadena rota en el registro #{verify.brokenAt}! La bitácora fue modificada fuera de la aplicación.</ErrorNote>}
        </div>
      )}
      <div className="overflow-x-auto max-h-[60vh]">
        <table className="w-full text-xs">
          <thead className="label text-left sticky top-0 bg-panel">
            <tr>
              <th className="py-2 pr-3">Fecha</th>
              <th className="pr-3">Usuario</th>
              <th className="pr-3">Acción</th>
              <th className="pr-3">Objetivo</th>
              <th className="pr-3">IP</th>
              <th className="pr-3">Resultado</th>
              <th className="pr-3">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="border-t border-line-soft align-top">
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{fmtDateTime(r.ts)}</td>
                <td className="pr-3">{r.username ?? "—"}</td>
                <td className="pr-3 font-mono text-accent">{r.action}</td>
                <td className="pr-3 max-w-[180px] truncate" title={r.target ?? ""}>
                  {r.target ?? ""}
                </td>
                <td className="pr-3 font-mono text-ink-2">{r.ip ?? ""}</td>
                <td className={`pr-3 ${r.outcome === "success" ? "text-ok" : "text-crit"}`}>{r.outcome}</td>
                <td className="pr-3 font-mono text-muted max-w-[320px] truncate" title={JSON.stringify(r.details)}>
                  {r.details ? JSON.stringify(r.details) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default function Admin() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("servers");
  return (
    <div className="space-y-4">
      <PageHeader title="Administración" subtitle="Usuarios, servidores de video, cámaras, alertas, IA, integraciones y auditoría" icon={<ShieldCheck size={20} />} />
      {!can("admin") && <div className="text-xs text-ink-2 rounded-lg border border-line bg-panel px-3 py-2">Acceso Tester: consulta de configuración y diagnósticos de exacqVision. Los cambios requieren un administrador.</div>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "servers", label: "Servidores exacqVision", icon: <Server size={15} /> },
          { id: "cameras", label: "Cámaras", icon: <Cctv size={15} /> },
          { id: "alerts", label: "Alertas", icon: <BellRing size={15} /> },
          { id: "users", label: "Usuarios", icon: <Users size={15} /> },
          { id: "ai", label: "IA", icon: <Sparkles size={15} /> },
          { id: "integrations", label: "Integraciones", icon: <Webhook size={15} /> },
          { id: "audit", label: "Auditoría", icon: <FileClock size={15} /> },
        ]}
      />
      {tab === "users" && <UsersTab />}
      {tab === "servers" && <ServersTab />}
      {tab === "cameras" && <CamerasTab />}
      {tab === "alerts" && <AlertsTab />}
      {tab === "ai" && <AiTab />}
      {tab === "integrations" && <IntegrationsTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
