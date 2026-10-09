import { KeyRound, LogOut, MonitorSmartphone, QrCode, ShieldCheck, UserCog } from "lucide-react";
import { useState } from "react";
import { useToast } from "../components/toasts";
import { Modal, PageHeader, Panel } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtAgo, fmtDateTime, ROLE_LABEL } from "../lib/format";
import { useApi } from "../lib/hooks";
import { PasswordForm, RecoveryCodes, TotpEnroll } from "./Onboarding";

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
