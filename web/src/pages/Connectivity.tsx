import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Building2, Cloud, Edit3, Lock, Network, Plug, PlugZap, Plus, Server, ShieldAlert, ShieldCheck, Terminal, Trash2, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Sparkline } from "../components/charts";
import { useToast } from "../components/toasts";
import { Dot, Empty, ErrorNote, Field, Modal, PageHeader, Panel, Spinner, Toggle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtAgo, fmtBytes, fmtDuration, fmtTime } from "../lib/format";
import { useApi, useNow } from "../lib/hooks";
import { useTopic } from "../lib/realtime";
import type { Host, SourceStatus, VaultEntry, VpnProfile, VpnStatus } from "../lib/types";

function TunnelGraphic({ state }: { state: VpnStatus["state"] }) {
  const up = state === "connected";
  const busy = state === "connecting" || state === "disconnecting";
  const color = up ? "#19d27c" : busy ? "#ffb020" : state === "error" ? "#ff3b5c" : "#33476e";
  const nodes = [
    { icon: <Server size={22} />, label: "Servidor SOC" },
    { icon: <ShieldCheck size={22} />, label: "FortiGate" },
    { icon: <Building2 size={22} />, label: "Red interna" },
  ];
  return (
    <div className="flex items-center justify-between gap-2 py-4 px-2">
      {nodes.map((n, i) => (
        <div key={n.label} className="contents">
          <div className="flex flex-col items-center gap-1.5 w-24">
            <div className="w-14 h-14 rounded-xl grid place-items-center border" style={{ borderColor: color, color, boxShadow: up ? `0 0 22px -6px ${color}` : undefined, background: `color-mix(in oklab, ${color} 10%, transparent)` }}>
              {n.icon}
            </div>
            <span className="text-[11px] text-ink-2 text-center">{n.label}</span>
          </div>
          {i < nodes.length - 1 && (
            <div className="relative flex-1 h-1 rounded-full overflow-hidden" style={{ background: `color-mix(in oklab, ${color} 25%, transparent)` }}>
              {(up || busy) && (
                <motion.div className="absolute inset-y-0 w-1/3 rounded-full" style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} animate={{ x: ["-100%", "300%"] }} transition={{ repeat: Infinity, duration: up ? 1.4 : 0.8, ease: "linear", delay: i * 0.3 }} />
              )}
              {i === 0 && <Lock size={12} className="absolute left-1/2 -top-4 -translate-x-1/2" style={{ color }} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProfileModal({ profile, open, onClose, onSaved }: { profile: VpnProfile | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { data: vault } = useApi<VaultEntry[]>(open ? "/api/vault" : null);
  const [form, setForm] = useState<Partial<VpnProfile>>({});
  const [certs, setCerts] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setForm(profile ?? { name: "", host: "", port: 443, setRoutes: true, setDns: false, otpRequired: false, autoConnect: false, halfInternetRoutes: false });
    setCerts((profile?.trustedCerts ?? []).join("\n"));
    setError("");
  }, [open, profile]);
  const set = <K extends keyof VpnProfile>(k: K, v: VpnProfile[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setError("");
    const body = { ...form, trustedCerts: certs.split(/\s+/).filter(Boolean), port: Number(form.port) };
    delete (body as Partial<VpnProfile>).id;
    delete (body as Partial<VpnProfile>).updatedAt;
    try {
      if (profile) await api.patch(`/api/vpn/profiles/${profile.id}`, body);
      else await api.post("/api/vpn/profiles", body);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={profile ? "Editar perfil FortiVPN" : "Nuevo perfil FortiVPN"}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>
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
          <input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Oficina Central" />
        </Field>
        <Field label="Credencial (bóveda)" hint="Usuario y contraseña del SSL-VPN, guardados cifrados">
          <select className="input" value={form.credentialId ?? ""} onChange={(e) => set("credentialId", e.target.value || null)}>
            <option value="">— Seleccionar —</option>
            {vault
              ?.filter((v) => v.kind === "fortivpn" || v.kind === "generic")
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.usernameMasked})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Gateway FortiGate (host)">
          <input className="input" value={form.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="vpn.empresa.com o IP pública" />
        </Field>
        <Field label="Puerto">
          <input className="input" type="number" value={form.port ?? 443} onChange={(e) => set("port", Number(e.target.value))} />
        </Field>
        <Field label="Realm (opcional)">
          <input className="input" value={form.realm ?? ""} onChange={(e) => set("realm", e.target.value || null)} />
        </Field>
        <div className="space-y-2.5 pt-5">
          <Toggle checked={Boolean(form.otpRequired)} onChange={(v) => set("otpRequired", v)} label="Requiere OTP (FortiToken)" />
          <Toggle checked={Boolean(form.autoConnect)} onChange={(v) => set("autoConnect", v)} label="Conectar automáticamente / reconectar" disabled={form.otpRequired} />
          <Toggle checked={Boolean(form.setRoutes)} onChange={(v) => set("setRoutes", v)} label="Aplicar rutas del FortiGate" />
          <Toggle checked={Boolean(form.setDns)} onChange={(v) => set("setDns", v)} label="Usar DNS de la VPN" />
        </div>
        <div className="sm:col-span-2">
          <Field label="Huellas SHA-256 de certificado confiables" hint="Una por línea. Si queda vacío y el certificado no es de una CA pública, el primer intento mostrará la huella para confirmarla.">
            <textarea className="input font-mono text-xs h-20" value={certs} onChange={(e) => setCerts(e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Modal>
  );
}

function HostRow({ h, canAdmin, onDelete }: { h: Host; canAdmin: boolean; onDelete: () => void }) {
  const { data: hist } = useApi<Array<{ ts: number; ok: number; latency_ms: number | null }>>(`/api/health/hosts/${h.id}/history`, { interval: 60_000 });
  return (
    <tr className="border-t border-line-soft">
      <td className="py-2 pr-3">
        <span className="flex items-center gap-2">
          <Dot tone={h.status === "up" ? "ok" : h.status === "down" ? "crit" : "muted"} pulse={h.status === "down"} />
          {h.name}
          {h.simulated && <span className="text-[10px] text-ai">demo</span>}
        </span>
      </td>
      <td className="pr-3 font-mono text-xs text-ink-2">
        {h.host}:{h.port}
      </td>
      <td className="pr-3 text-xs">{h.kind}</td>
      <td className="pr-3 font-mono text-xs">{h.status === "up" ? `${h.latencyMs} ms` : <span className="text-crit">DOWN</span>}</td>
      <td className="pr-3">
        <Sparkline values={(hist ?? []).slice(-60).map((x) => (x.ok ? x.latency_ms : null))} />
      </td>
      <td className="pr-3 text-xs text-muted">{fmtAgo(h.changedAt)}</td>
      <td className="text-right">
        {canAdmin && (
          <button className="btn btn-ghost btn-sm text-muted hover:text-crit" onClick={onDelete} aria-label="Eliminar">
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}

export default function Connectivity() {
  const { can } = useAuth();
  const toast = useToast();
  const now = useNow();
  const { data: status, setData: setStatus } = useApi<VpnStatus>("/api/vpn/status");
  const { data: profiles, reload: reloadProfiles } = useApi<VpnProfile[]>(can("operator") ? "/api/vpn/profiles" : null);
  const { data: logsInit } = useApi<Array<{ ts: number; line: string }>>(can("operator") ? "/api/vpn/logs" : null);
  const { data: sources } = useApi<SourceStatus[]>("/api/exacq/status", { interval: 15_000 });
  const { data: hosts, setData: setHosts, reload: reloadHosts } = useApi<Host[]>("/api/health/hosts");
  const [logs, setLogs] = useState<Array<{ ts: number; line: string }>>([]);
  const [profileId, setProfileId] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<VpnProfile | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [hostForm, setHostForm] = useState({ name: "", host: "", port: 80, kind: "exacq" });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsInit) setLogs(logsInit);
  }, [logsInit]);
  useEffect(() => {
    if (!profileId && profiles?.length) setProfileId(status?.profileId ?? profiles[0]!.id);
  }, [profiles, profileId, status]);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }), [logs]);

  useTopic<VpnStatus>("vpn.status", setStatus);
  useTopic<{ ts: number; line: string }>("vpn.log", (l) => setLogs((all) => [...all.slice(-300), l]));
  useTopic<{ hosts: Host[] }>("health.update", (h) => setHosts(h.hosts));

  const profile = profiles?.find((p) => p.id === profileId);
  const st = status?.state ?? "disconnected";

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/api/vpn/connect", { profileId, otp: otp || undefined });
      setOtp("");
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const trustCert = async () => {
    if (!status?.untrustedCertDigest || !status.profileId) return;
    try {
      await api.post(`/api/vpn/profiles/${status.profileId}/trust-cert`, { digest: status.untrustedCertDigest });
      toast({ tone: "ok", title: "Huella agregada al perfil", body: "Vuelva a conectar." });
      void reloadProfiles();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Conectividad" subtitle="Túnel FortiVPN hacia la red interna, servidores de video y equipos monitoreados" icon={<Network size={20} />} />

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Panel title="Túnel FortiVPN (SSL-VPN)" icon={<Cloud size={16} />} className="xl:col-span-3" glow bodyClass="p-4 space-y-4">
          <TunnelGraphic state={st} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
            {[
              { l: "Estado", v: { connected: "CONECTADA", connecting: "CONECTANDO", disconnecting: "CERRANDO", disconnected: "DESCONECTADA", error: "ERROR" }[st] },
              { l: "IP asignada", v: status?.assignedIp ?? "—" },
              { l: "Tiempo activo", v: st === "connected" && status?.since ? fmtDuration(now - status.since) : "—" },
              { l: "Modo", v: status?.mode === "simulate" ? "Simulado" : status?.mode === "disabled" ? "Deshabilitado" : "openfortivpn" },
            ].map((x) => (
              <div key={x.l} className="rounded-lg bg-bg/50 border border-line-soft py-2 px-1">
                <div className="font-display font-bold tracking-wide text-ink truncate">{x.v}</div>
                <div className="text-[10px] text-muted uppercase tracking-wider">{x.l}</div>
              </div>
            ))}
          </div>
          {st === "connected" && (
            <div className="flex gap-4 text-sm text-ink-2">
              <span className="flex items-center gap-1">
                <ArrowDownToLine size={14} className="text-accent" /> {fmtBytes(status?.rxBytes)}
              </span>
              <span className="flex items-center gap-1">
                <ArrowUpFromLine size={14} className="text-ai" /> {fmtBytes(status?.txBytes)}
              </span>
              <span className="text-muted text-xs self-center">
                {status?.gateway} · {status?.iface ?? ""} · por {status?.connectedBy}
              </span>
            </div>
          )}
          {status?.mode === "simulate" && (
            <div className="text-xs text-ai bg-ai/10 border border-ai/30 rounded-lg px-3 py-2">
              openfortivpn no está instalado en este servidor: el túnel se <b>simula</b>. Use la imagen Docker incluida (trae openfortivpn) para conexiones reales.
            </div>
          )}
          {status?.untrustedCertDigest && (
            <div className="rounded-lg border border-warn/50 bg-warn/10 p-3 text-sm space-y-2">
              <div className="flex items-center gap-2 font-semibold text-warn">
                <ShieldAlert size={16} /> Certificado del FortiGate no confiable
              </div>
              <div className="text-xs text-ink-2">Verifique que esta huella coincida con el certificado de su FortiGate (System → Certificates) antes de confiar:</div>
              <code className="block break-all font-mono text-xs bg-bg/60 p-2 rounded">{status.untrustedCertDigest}</code>
              {can("admin") && (
                <button className="btn btn-sm" onClick={() => void trustCert()}>
                  Confiar en esta huella
                </button>
              )}
            </div>
          )}
          {can("operator") ? (
            profiles?.length ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Perfil">
                  <select className="input !w-56" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={st !== "disconnected" && st !== "error"}>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.host}:{p.port}
                      </option>
                    ))}
                  </select>
                </Field>
                {profile?.otpRequired && (st === "disconnected" || st === "error") && (
                  <Field label="OTP FortiToken">
                    <input className="input !w-36 font-mono tracking-[0.3em]" inputMode="numeric" maxLength={10} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
                  </Field>
                )}
                {st === "connected" || st === "connecting" ? (
                  <button className="btn btn-danger" onClick={() => void api.post("/api/vpn/disconnect")}>
                    <Unplug size={15} /> Desconectar
                  </button>
                ) : (
                  <button className="btn btn-primary" disabled={busy || !profileId || (profile?.otpRequired && otp.length < 6)} onClick={() => void connect()}>
                    {busy ? <Spinner size={14} /> : <PlugZap size={15} />} Conectar
                  </button>
                )}
              </div>
            ) : (
              <Empty icon={<Plug size={24} />} title="Sin perfiles VPN">
                {can("admin") ? "Cree un perfil con el gateway del FortiGate y una credencial guardada en la bóveda." : "Pida a un administrador que configure un perfil."}
              </Empty>
            )
          ) : (
            <div className="text-xs text-muted">Su rol sólo permite ver el estado del túnel.</div>
          )}
          {(error || (st === "error" && status?.error)) && <ErrorNote>{error || status?.error}</ErrorNote>}
        </Panel>

        <Panel title="Consola openfortivpn" icon={<Terminal size={16} />} className="xl:col-span-2" bodyClass="p-0">
          <div ref={logRef} className="h-[360px] overflow-y-auto bg-[#03060d] font-mono text-[11.5px] leading-relaxed p-3 rounded-b-xl">
            {logs.map((l, i) => (
              <div key={i} className={/ERROR/.test(l.line) ? "text-crit" : /Tunnel is up|Authenticated|Connected/.test(l.line) ? "text-ok" : /^»/.test(l.line) ? "text-accent" : "text-ink-2"}>
                <span className="text-muted">{fmtTime(l.ts)} </span>
                {l.line}
              </div>
            ))}
            {!logs.length && <div className="text-muted">$ esperando actividad del túnel…</div>}
            <span className="inline-block w-2 h-3.5 bg-accent/80 animate-blink align-middle" />
          </div>
        </Panel>
      </div>

      {can("admin") && (
        <Panel
          title="Perfiles VPN"
          icon={<ShieldCheck size={16} />}
          actions={
            <button
              className="btn btn-sm"
              onClick={() => {
                setEditing(null);
                setModalOpen(true);
              }}
            >
              <Plus size={14} /> Nuevo perfil
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="label text-left">
                <tr>
                  <th className="py-2 pr-3">Nombre</th>
                  <th className="pr-3">Gateway</th>
                  <th className="pr-3">OTP</th>
                  <th className="pr-3">Auto</th>
                  <th className="pr-3">Certificados</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {profiles?.map((p) => (
                  <tr key={p.id} className="border-t border-line-soft">
                    <td className="py-2 pr-3">{p.name}</td>
                    <td className="pr-3 font-mono text-xs">
                      {p.host}:{p.port}
                    </td>
                    <td className="pr-3">{p.otpRequired ? "Sí" : "No"}</td>
                    <td className="pr-3">{p.autoConnect ? "Sí" : "No"}</td>
                    <td className="pr-3 text-xs text-ink-2">{p.trustedCerts.length} huella(s)</td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(p);
                          setModalOpen(true);
                        }}
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        className="btn btn-ghost btn-sm text-muted hover:text-crit"
                        onClick={async () => {
                          if (!confirm(`¿Eliminar el perfil "${p.name}"?`)) return;
                          try {
                            await api.del(`/api/vpn/profiles/${p.id}`);
                            void reloadProfiles();
                          } catch (e) {
                            setError((e as ApiError).message);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!profiles?.length && <div className="text-sm text-muted py-3">Todavía no hay perfiles. Cree uno con el gateway del FortiGate y una credencial de la bóveda.</div>}
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Servidores de video" icon={<Server size={16} />} bodyClass="p-3 space-y-2">
          {sources?.map((s) => (
            <div key={s.id} className="flex items-start gap-2 rounded-lg border border-line-soft p-2.5">
              <Dot tone={s.ok ? "ok" : "crit"} pulse={!s.ok} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-xs text-muted truncate">{s.ok ? `OK · ${s.latencyMs ?? "-"} ms · ${fmtAgo(s.lastOkAt)}` : s.detail}</div>
              </div>
              <span className="text-[10px] uppercase text-muted">{s.kind}</span>
            </div>
          ))}
        </Panel>
        <Panel title="Equipos monitoreados (TCP)" icon={<Network size={16} />} className="xl:col-span-2" bodyClass="p-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="label text-left">
                <tr>
                  <th className="py-2 pr-3">Equipo</th>
                  <th className="pr-3">Dirección</th>
                  <th className="pr-3">Tipo</th>
                  <th className="pr-3">Latencia</th>
                  <th className="pr-3">Última hora</th>
                  <th className="pr-3">Último cambio</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hosts?.map((h) => (
                  <HostRow
                    key={h.id}
                    h={h}
                    canAdmin={can("admin")}
                    onDelete={async () => {
                      await api.del(`/api/health/hosts/${h.id}`);
                      void reloadHosts();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {can("admin") && (
            <form
              className="mt-3 flex flex-wrap gap-2 items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.post("/api/health/hosts", { ...hostForm, port: Number(hostForm.port) });
                  setHostForm({ name: "", host: "", port: 80, kind: "exacq" });
                  void reloadHosts();
                } catch (err) {
                  setError((err as ApiError).message);
                }
              }}
            >
              <input className="input !w-44 !py-1.5" placeholder="Nombre" value={hostForm.name} onChange={(e) => setHostForm({ ...hostForm, name: e.target.value })} />
              <input className="input !w-40 !py-1.5" placeholder="192.168.109.58" value={hostForm.host} onChange={(e) => setHostForm({ ...hostForm, host: e.target.value })} />
              <input className="input !w-24 !py-1.5" type="number" placeholder="Puerto" value={hostForm.port} onChange={(e) => setHostForm({ ...hostForm, port: Number(e.target.value) })} />
              <select className="input !w-36 !py-1.5" value={hostForm.kind} onChange={(e) => setHostForm({ ...hostForm, kind: e.target.value })}>
                {["exacq", "fortigate", "nvr", "camera", "switch", "server", "other"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <button className="btn btn-sm" disabled={!hostForm.name || !hostForm.host}>
                <Plus size={14} /> Agregar
              </button>
            </form>
          )}
        </Panel>
      </div>

      <ProfileModal profile={editing} open={modalOpen} onClose={() => setModalOpen(false)} onSaved={() => void reloadProfiles()} />
    </div>
  );
}
