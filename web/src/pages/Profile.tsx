import { BellRing, KeyRound, LogOut, MonitorSmartphone, QrCode, ShieldCheck, UserCog } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useToast } from "../components/toasts";
import { Field, Modal, PageHeader, Panel, Toggle } from "../components/ui";
import { DEFAULT_PREFS } from "../lib/alertPolicy";
import { useAlerts } from "../lib/alerts";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CATEGORY_LABEL, fmtAgo, fmtDateTime, fmtHM, ROLE_LABEL, SEVERITY_LABEL } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { AlertCategory, AlertThreshold, Severity } from "../lib/types";
import { PasswordForm, RecoveryCodes, TotpEnroll } from "./Onboarding";

const THRESHOLD_OPTIONS: AlertThreshold[] = ["info", "low", "medium", "high", "critical", "off"];
const thresholdLabel = (t: AlertThreshold) => (t === "off" ? "Nunca" : SEVERITY_LABEL[t as Severity]);

/** Preferencias de alertas guardadas en este navegador (cada puesto del SOC puede tener las suyas). */
function AlertPrefsPanel() {
  const { prefs, setPrefs, dndUntil, setDnd } = useAlerts();
  const location = useLocation();
  useEffect(() => {
    if (location.hash === "#alertas") document.getElementById("alertas")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash]);
  const setCat = (c: AlertCategory, channel: "toast" | "sound", v: AlertThreshold) => setPrefs({ ...prefs, [c]: { ...prefs[c], [channel]: v } });
  const select = (c: AlertCategory, channel: "toast" | "sound") => (
    <select className="input !py-1" value={prefs[c][channel]} onChange={(e) => setCat(c, channel, e.target.value as AlertThreshold)}>
      {THRESHOLD_OPTIONS.map((t) => (
        <option key={t} value={t}>
          {t === "off" ? "Nunca" : `${thresholdLabel(t)} o más`}
        </option>
      ))}
    </select>
  );
  return (
    <div id="alertas" className="scroll-mt-4">
      <Panel
        title="Alertas en esta consola"
        icon={<BellRing size={16} />}
        bodyClass="p-4 space-y-4"
        actions={
          <button className="btn btn-sm btn-ghost" onClick={() => setPrefs({ ...DEFAULT_PREFS, dndUntil: prefs.dndUntil })}>
            Restablecer
          </button>
        }
      >
        <p className="text-xs text-ink-2">
          Se guardan en este navegador. El servidor ya agrupa las alertas y espera 1 minuto antes de avisar caídas de cámaras, servidores o VPN; aquí elige qué
          avisos ve y oye este puesto.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="label text-left">
              <tr>
                <th className="py-2 pr-3">Categoría</th>
                <th className="pr-3">Aviso desde</th>
                <th className="pr-3">Sonido desde</th>
              </tr>
            </thead>
            <tbody>
              {(["security", "infra"] as AlertCategory[]).map((c) => (
                <tr key={c} className="border-t border-line-soft">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{CATEGORY_LABEL[c]}</div>
                    <div className="text-[11px] text-muted">{c === "security" ? "Personas, intrusión, sabotaje, IA" : "Cámaras, servidores, equipos, VPN"}</div>
                  </td>
                  <td className="pr-3">{select(c, "toast")}</td>
                  <td className="pr-3">{select(c, "sound")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Pausa entre sonidos (s)" hint="Las críticas suenan igual, con al menos 5 s de separación.">
            <input
              className="input"
              type="number"
              min={0}
              max={600}
              value={prefs.soundCooldownSec}
              onChange={(e) => setPrefs({ ...prefs, soundCooldownSec: Number(e.target.value) })}
            />
          </Field>
          <Field label="Máx. avisos visibles" hint='El resto se resume en "+N más".'>
            <input className="input" type="number" min={1} max={8} value={prefs.maxToasts} onChange={(e) => setPrefs({ ...prefs, maxToasts: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="space-y-2">
          <Toggle checked={prefs.recoveries} onChange={(v) => setPrefs({ ...prefs, recoveries: v })} label="Avisar recuperaciones (aviso verde, sin sonido)" />
          <Toggle checked={prefs.dndAllowCritical} onChange={(v) => setPrefs({ ...prefs, dndAllowCritical: v })} label='"No molestar" deja pasar las críticas' />
          <Toggle checked={!prefs.muted} onChange={(v) => setPrefs({ ...prefs, muted: !v })} label="Sonidos activados" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-2">No molestar:</span>
          {dndUntil ? (
            <>
              <span className="text-info">activo hasta las {fmtHM(dndUntil)}</span>
              <button className="btn btn-sm" onClick={() => setDnd(null)}>
                Desactivar
              </button>
            </>
          ) : (
            [
              ["15 min", 15],
              ["1 h", 60],
              ["4 h", 240],
            ].map(([l, m]) => (
              <button key={l} className="btn btn-sm" onClick={() => setDnd(m as number)}>
                {l}
              </button>
            ))
          )}
          {!dndUntil && (
            <button className="btn btn-sm" onClick={() => setDnd("morning")}>
              Hasta las 07:00
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}

interface SessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  mfa: boolean;
  current: boolean;
}

export default function Profile() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const { data: sessions, reload } = useApi<SessionInfo[]>("/api/auth/sessions");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [reenroll, setReenroll] = useState(false);
  if (!me) return null;
  return (
    <div className="space-y-4">
      <PageHeader title="Mi perfil" subtitle={`${me.user.displayName} · ${ROLE_LABEL[me.user.role]}`} icon={<UserCog size={20} />} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Cambiar contraseña" icon={<KeyRound size={16} />}>
          <PasswordForm
            onDone={() => {
              toast({ tone: "ok", title: "Contraseña actualizada", body: "Se cerraron sus otras sesiones." });
              void reload();
            }}
          />
        </Panel>
        <Panel title="Verificación en dos pasos" icon={<ShieldCheck size={16} />} bodyClass="p-4 space-y-3">
          <div className="text-sm">
            Estado: {me.user.totpEnabled ? <b className="text-ok">Activa</b> : <b className="text-warn">Inactiva</b>}
          </div>
          <div className="text-sm text-ink-2">Códigos de recuperación disponibles: {me.recoveryCodesLeft}</div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-sm"
              onClick={async () => {
                const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/recovery-codes");
                setCodes(r.recoveryCodes);
                void refresh();
              }}
            >
              Generar nuevos códigos
            </button>
            <button className="btn btn-sm" onClick={() => setReenroll(true)}>
              <QrCode size={14} /> Cambiar dispositivo 2FA
            </button>
          </div>
        </Panel>
        <Panel title="Datos de la cuenta" icon={<UserCog size={16} />} bodyClass="p-4 text-sm space-y-1.5 text-ink-2">
          <div>
            Usuario: <span className="font-mono text-ink">{me.user.username}</span>
          </div>
          <div>Rol: {ROLE_LABEL[me.user.role]}</div>
          <div>Último ingreso: {fmtDateTime(me.user.lastLoginAt)}</div>
          <div>IP: {me.user.lastLoginIp ?? "—"}</div>
          <div>Creado: {fmtDateTime(me.user.createdAt)}</div>
        </Panel>
      </div>
      <AlertPrefsPanel />
      <Panel title="Sesiones activas" icon={<MonitorSmartphone size={16} />}>
        <table className="w-full text-sm">
          <tbody>
            {sessions?.map((s) => (
              <tr key={s.id} className="border-t border-line-soft">
                <td className="py-2 pr-3 max-w-[380px] truncate text-xs text-ink-2" title={s.userAgent ?? ""}>
                  {s.userAgent ?? "—"}
                </td>
                <td className="pr-3 font-mono text-xs">{s.ip}</td>
                <td className="pr-3 text-xs">activa {fmtAgo(s.lastSeenAt)}</td>
                <td className="pr-3 text-xs">{s.mfa ? "2FA ✓" : ""}</td>
                <td className="text-right">
                  {s.current ? (
                    <span className="text-xs text-accent">Esta sesión</span>
                  ) : (
                    <button className="btn btn-ghost btn-sm text-muted hover:text-crit" onClick={async () => (await api.del(`/api/auth/sessions/${s.id}`), void reload())}>
                      <LogOut size={14} /> Cerrar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Modal open={Boolean(codes)} onClose={() => setCodes(null)} title="Nuevos códigos de recuperación">
        {codes && <RecoveryCodes codes={codes} />}
      </Modal>
      <Modal open={reenroll} onClose={() => setReenroll(false)} title="Registrar nuevo dispositivo 2FA" width={560}>
        {reenroll && (
          <TotpEnroll
            onDone={(c) => {
              setReenroll(false);
              setCodes(c);
              void refresh();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
