import { motion } from "framer-motion";
import { CheckCircle2, Copy, Download, KeyRound, LogOut, QrCode, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ErrorNote, Field, OkNote, Spinner } from "../components/ui";

export function PasswordForm({ onDone, submitLabel = "Cambiar contraseña" }: { onDone: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const checks = [
    { ok: next.length >= 12, label: "12+ caracteres" },
    { ok: [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(next)).length >= 3, label: "3 tipos (a, A, 0, #)" },
    { ok: next.length > 0 && next === confirm, label: "Coinciden" },
  ];
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api.post("/api/auth/password", { current, next });
          onDone();
        } catch (err) {
          setError((err as ApiError).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Contraseña actual">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="Nueva contraseña">
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Repetir nueva contraseña">
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-3 text-xs">
        {checks.map((c) => (
          <span key={c.label} className={`flex items-center gap-1 ${c.ok ? "text-ok" : "text-muted"}`}>
            <CheckCircle2 size={13} /> {c.label}
          </span>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      <button className="btn btn-primary w-full" disabled={busy || !checks.every((c) => c.ok) || !current}>
        {submitLabel}
      </button>
    </form>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  return (
    <div className="space-y-3">
      <OkNote>Guarde estos códigos en un lugar seguro (gestor de contraseñas o impresos). Cada uno sirve una sola vez si pierde su teléfono.</OkNote>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-bg/60 border border-line rounded-lg p-3">
        {codes.map((c) => (
          <span key={c} className="tracking-wider text-center py-1">
            {c}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(text)}>
          <Copy size={14} /> Copiar
        </button>
        <a className="btn btn-sm" download="camerasia-codigos-recuperacion.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>
          <Download size={14} /> Descargar
        </a>
      </div>
    </div>
  );
}

export function TotpEnroll({ onDone }: { onDone: (codes: string[]) => void }) {
  const [data, setData] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .post<{ secret: string; qr: string }>("/api/auth/totp/begin")
      .then(setData)
      .catch((e) => setError((e as ApiError).message));
  }, []);
  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/totp/confirm", { code });
          onDone(r.recoveryCodes);
        } catch (err) {
          setError((err as ApiError).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="text-sm text-ink-2 space-y-1 list-decimal ml-5">
        <li>Abra Google Authenticator, Microsoft Authenticator, FortiToken Mobile u otra app TOTP.</li>
        <li>Escanee el código QR (o cargue la clave manualmente).</li>
        <li>Ingrese el código de 6 dígitos que muestra la app.</li>
      </ol>
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <img src={data.qr} alt="Código QR 2FA" className="w-44 h-44 rounded-lg border border-accent/40 shadow-[0_0_30px_-10px_#22d3ee]" />
        <div className="flex-1 w-full space-y-2">
          <span className="label">Clave manual</span>
          <code className="block break-all font-mono text-sm bg-bg/60 border border-line rounded-lg p-2 select-all">{data.secret}</code>
          <input
            className="input text-center font-mono text-xl tracking-[0.4em]"
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <button className="btn btn-primary w-full" disabled={busy || code.length !== 6}>
        <ShieldCheck size={16} /> Activar 2FA
      </button>
    </form>
  );
}

/** Primer ingreso: cambio obligatorio de contraseña y alta de 2FA. */
export default function Onboarding() {
  const { me, refresh, logout } = useAuth();
  const [codes, setCodes] = useState<string[] | null>(null);
  const needPw = me?.restrictions.mustChangePassword;
  const needTotp = me?.restrictions.mustEnrollTotp;
  const step = needPw ? 1 : codes ? 3 : 2;

  return (
    <div className="min-h-full flex items-center justify-center p-4 bg-radial bg-grid">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="panel panel-glow w-full max-w-[560px] p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl grid place-items-center bg-accent/10 border border-accent/30 text-accent">{step === 1 ? <KeyRound size={20} /> : <QrCode size={20} />}</div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-wide">Configuración de seguridad</h1>
            <p className="text-sm text-ink-2">Hola {me?.user.displayName}. Antes de continuar, asegure su cuenta.</p>
          </div>
          <button className="ml-auto btn btn-ghost btn-sm" onClick={() => void logout()} title="Salir">
            <LogOut size={16} />
          </button>
        </div>
        <div className="flex gap-2 mb-5">
          {["Contraseña", "Verificación 2FA", "Códigos de recuperación"].map((s, i) => (
            <div key={s} className="flex-1">
              <div className={`h-1 rounded-full ${i + 1 <= step ? "bg-accent shadow-[0_0_8px_#22d3ee]" : "bg-line"}`} />
              <div className={`text-[11px] mt-1 ${i + 1 === step ? "text-accent" : "text-muted"}`}>{s}</div>
            </div>
          ))}
        </div>
        {step === 1 && <PasswordForm onDone={() => void refresh()} submitLabel="Guardar y continuar" />}
        {step === 2 && needTotp && <TotpEnroll onDone={setCodes} />}
        {step === 2 && !needTotp && (
          <button className="btn btn-primary w-full" onClick={() => void refresh()}>
            Continuar
          </button>
        )}
        {step === 3 && codes && (
          <div className="space-y-4">
            <RecoveryCodes codes={codes} />
            <button className="btn btn-primary w-full" onClick={() => void refresh()}>
              Ya los guardé — Ingresar al centro de monitoreo
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
