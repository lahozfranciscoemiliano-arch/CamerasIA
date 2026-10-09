import { Bot, Cctv, Edit3, Eye, KeyRound, Lock, Plus, Server, ShieldCheck, Trash2, Webhook } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "../components/toasts";
import { Empty, ErrorNote, Field, Modal, PageHeader, Panel, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { fmtAgo } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { VaultEntry } from "../lib/types";

const KINDS: Array<{ id: VaultEntry["kind"]; label: string; icon: ReactNode; hint: string }> = [
  { id: "fortivpn", label: "FortiVPN (SSL-VPN)", icon: <ShieldCheck size={16} />, hint: "Usuario y contraseña del portal SSL-VPN del FortiGate" },
  { id: "exacq", label: "exacqVision", icon: <Server size={16} />, hint: "Usuario del exacqVision Web Service (idealmente uno de sólo lectura)" },
  { id: "anthropic", label: "Anthropic API (IA)", icon: <Bot size={16} />, hint: "API key de Claude (se guarda en el campo token)" },
  { id: "camera", label: "Cámara / NVR", icon: <Cctv size={16} />, hint: "Credenciales de equipos individuales" },
  { id: "api", label: "API / Webhook", icon: <Webhook size={16} />, hint: "Tokens de integraciones" },
  { id: "generic", label: "Genérica", icon: <KeyRound size={16} />, hint: "Otra credencial" },
];
const kindOf = (k: string) => KINDS.find((x) => x.id === k) ?? KINDS[5]!;

function EntryModal({ entry, open, onClose, onSaved }: { entry: VaultEntry | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: "", kind: "fortivpn" as VaultEntry["kind"], host: "", notes: "", username: "", password: "", token: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({ name: entry?.name ?? "", kind: entry?.kind ?? "fortivpn", host: entry?.host ?? "", notes: entry?.notes ?? "", username: "", password: "", token: "" });
    setError("");
  }, [open, entry]);
  const k = kindOf(form.kind);
  const save = async () => {
    setBusy(true);
    setError("");
    const secret: Record<string, string> = {};
    if (form.username) secret.username = form.username;
    if (form.password) secret.password = form.password;
    if (form.token) secret.token = form.token;
    try {
      if (entry) await api.patch(`/api/vault/${entry.id}`, { name: form.name, host: form.host || null, notes: form.notes || null, secret: Object.keys(secret).length ? secret : undefined });
      else await api.post("/api/vault", { name: form.name, kind: form.kind, host: form.host || undefined, notes: form.notes || undefined, secret });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
      setForm((f) => ({ ...f, password: "", token: "" }));
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={entry ? `Editar · ${entry.name}` : "Nueva credencial"}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !form.name} onClick={() => void save()}>
            <Lock size={14} /> Guardar cifrado
          </button>
        </>
      }
    >
      <form className="grid grid-cols-1 sm:grid-cols-2 gap-4" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <Field label="Nombre">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="FortiGate Casa Central" />
        </Field>
        <Field label="Tipo" hint={k.hint}>
          <select className="input" value={form.kind} disabled={Boolean(entry)} onChange={(e) => setForm({ ...form, kind: e.target.value as VaultEntry["kind"] })}>
            {KINDS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Host / referencia (opcional)">
          <input className="input" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.109.58 / vpn.empresa.com" />
        </Field>
        {form.kind !== "anthropic" && (
          <Field label="Usuario" hint={entry ? `Actual: ${entry.usernameMasked ?? "—"} (vacío = no cambiar)` : undefined}>
            <input className="input" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
        )}
        {form.kind !== "anthropic" && (
          <Field label="Contraseña" hint={entry ? (entry.hasPassword ? "Guardada (vacío = no cambiar)" : "Sin contraseña") : undefined}>
            <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        )}
        {(form.kind === "anthropic" || form.kind === "api") && (
          <div className="sm:col-span-2">
            <Field label="Token / API key" hint={entry ? (entry.hasToken ? "Guardado (vacío = no cambiar)" : "Sin token") : "sk-ant-…"}>
              <input className="input font-mono" type="password" autoComplete="new-password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            </Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="Notas (no cifradas)">
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Responsable, vencimiento, etc." />
          </Field>
        </div>
      </form>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Modal>
  );
}

export default function Vault() {
  const toast = useToast();
  const { data, loading, reload } = useApi<VaultEntry[]>("/api/vault");
  const [editing, setEditing] = useState<VaultEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; secret: Record<string, unknown> } | null>(null);

  const reveal = async (e: VaultEntry) => {
    try {
      const s = await api.post<Record<string, unknown>>(`/api/vault/${e.id}/reveal`);
      setRevealed({ name: e.name, secret: s });
      setTimeout(() => setRevealed(null), 30_000);
    } catch (err) {
      toast({ tone: "error", title: "No se puede revelar", body: (err as ApiError).message });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bóveda de credenciales"
        subtitle="Accesos a FortiVPN, exacqVision e IA guardados cifrados para no tener que tipearlos cada vez"
        icon={<KeyRound size={20} />}
        actions={
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus size={14} /> Nueva credencial
          </button>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <Panel title="Protección" icon={<Lock size={16} />} glow bodyClass="p-4 space-y-2 text-sm text-ink-2">
          <p>• Cifrado <b className="text-ink">AES-256-GCM</b> por credencial, atado a su registro (AAD).</p>
          <p>• La clave maestra vive fuera de la base (<code className="font-mono text-xs">VAULT_MASTER_KEY</code>).</p>
          <p>• Los secretos <b className="text-ink">nunca se envían al navegador</b>: el servidor los usa en memoria para el túnel VPN, exacqVision y la IA.</p>
          <p>• Crear, editar o borrar exige <b className="text-ink">re-confirmar con 2FA</b>.</p>
          <p>• Cada uso y cambio queda en la bitácora de auditoría encadenada.</p>
        </Panel>
        <Panel title="Credenciales" className="xl:col-span-3" bodyClass="p-3">
          {loading && !data ? (
            <Spinner />
          ) : data?.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {data.map((e) => {
                const k = kindOf(e.kind);
                return (
                  <div key={e.id} className="rounded-xl border border-line bg-panel-2/40 p-3 hover:border-accent-dim transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-lg grid place-items-center bg-accent/10 text-accent border border-accent/30">{k.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{e.name}</div>
                        <div className="text-[11px] text-muted">{k.label}</div>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(e);
                          setOpen(true);
                        }}
                        title="Editar"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void reveal(e)} title="Revelar (requiere VAULT_ALLOW_REVEAL)">
                        <Eye size={14} />
                      </button>
                      <button
                        className="btn btn-ghost btn-sm text-muted hover:text-crit"
                        onClick={async () => {
                          if (!confirm(`¿Eliminar "${e.name}"? Los perfiles que la usen quedarán sin credencial.`)) return;
                          await api.del(`/api/vault/${e.id}`).catch((err) => toast({ tone: "error", title: (err as ApiError).message }));
                          void reload();
                        }}
                        title="Eliminar"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="label !text-[10px]">Usuario</div>
                        <div className="font-mono">{e.usernameMasked ?? "—"}</div>
                      </div>
                      <div>
                        <div className="label !text-[10px]">Secreto</div>
                        <div className="font-mono">{e.hasPassword || e.hasToken ? "••••••••••" : "—"}</div>
                      </div>
                      <div>
                        <div className="label !text-[10px]">Host</div>
                        <div className="truncate">{e.host ?? "—"}</div>
                      </div>
                      <div>
                        <div className="label !text-[10px]">Último uso</div>
                        <div>{fmtAgo(e.lastUsedAt)}</div>
                      </div>
                    </div>
                    {e.notes && <div className="mt-2 text-xs text-ink-2">{e.notes}</div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty icon={<KeyRound size={28} />} title="La bóveda está vacía">
              Cargue el usuario del SSL-VPN de FortiGate, el usuario de exacqVision y la API key de Anthropic.
            </Empty>
          )}
        </Panel>
      </div>

      <EntryModal entry={editing} open={open} onClose={() => setOpen(false)} onSaved={() => void reload()} />
      <Modal open={Boolean(revealed)} onClose={() => setRevealed(null)} title={`Secreto · ${revealed?.name ?? ""}`} width={460}>
        <p className="text-xs text-warn mb-3">Visible por 30 segundos. Esta acción quedó registrada en la auditoría.</p>
        <pre className="font-mono text-sm bg-bg p-3 rounded-lg border border-line overflow-x-auto select-all">{JSON.stringify(revealed?.secret, null, 2)}</pre>
      </Modal>
    </div>
  );
}
