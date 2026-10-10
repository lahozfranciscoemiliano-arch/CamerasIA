import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Fingerprint, Lock, Radar, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Me } from "../lib/types";
import { ErrorNote } from "../components/ui";

function RadarBackdrop() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      <div className="absolute inset-0 bg-grid opacity-70" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[140vmax] h-[140vmax] max-w-[1600px] max-h-[1600px]">
        {[0.25, 0.45, 0.65, 0.85].map((s) => (
          <div key={s} className="absolute rounded-full border border-accent/10" style={{ inset: `${(1 - s) * 50}%` }} />
        ))}
        <div className="absolute inset-0 rounded-full animate-sweep" style={{ background: "conic-gradient(from 0deg, rgba(34,211,238,0.16), transparent 18%)" }} />
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-accent/10" />
        <div className="absolute top-1/2 left-0 right-0 h-px bg-accent/10" />
      </div>
      {[
        [18, 30],
        [72, 22],
        [64, 74],
        [28, 70],
        [84, 52],
      ].map(([x, y], i) => (
        <span key={i} className="absolute w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${i * 0.4}s`, boxShadow: "0 0 12px #22d3ee" }} />
      ))}
      <div className="absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-accent/5 to-transparent animate-scan" />
    </div>
  );
}

export default function Login() {
  const { setMe } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ mfaRequired: boolean; mfaToken?: string } & Partial<Me>>("/api/auth/login", { username, password });
      if (res.mfaRequired) {
        setMfaToken(res.mfaToken!);
        setPassword("");
      } else setMe(res as Me);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setMe(await api.post<Me>("/api/auth/mfa", { mfaToken, code }));
    } catch (err) {
      const ex = err as ApiError;
      setError(ex.message);
      if (ex.code === "mfa_expired") setMfaToken(null);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-full flex items-center justify-center p-4 bg-radial overflow-hidden">
      <RadarBackdrop />
      <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease: "easeOut" }} className="relative w-full max-w-[420px]">
        <div className="panel panel-glow p-7 backdrop-blur-md bg-panel/80">
          <div className="absolute inset-3 hud-corners pointer-events-none rounded-lg opacity-60" />
          <div className="flex flex-col items-center text-center mb-6">
            <div className="relative w-16 h-16 rounded-2xl grid place-items-center bg-accent/10 border border-accent/40 overflow-hidden mb-3">
              <Radar size={30} className="text-accent" />
              <span className="absolute inset-0 animate-sweep" style={{ background: "conic-gradient(from 0deg, rgba(34,211,238,.4), transparent 30%)" }} />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-[0.2em]">CAMERAS·IA</h1>
            <p className="label mt-1">Centro de Monitoreo de Seguridad</p>
          </div>

          <AnimatePresence mode="wait">
            {!mfaToken ? (
              <motion.form key="pw" onSubmit={submitPassword} className="space-y-4" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input className="input pl-9" placeholder="Usuario" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input className="input pl-9" placeholder="Contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <ErrorNote>{error}</ErrorNote>
                <button className="btn btn-primary w-full py-2.5" disabled={busy || !username || !password}>
                  <Fingerprint size={16} /> {busy ? "Verificando…" : "Ingresar"}
                </button>
              </motion.form>
            ) : (
              <motion.form key="mfa" onSubmit={submitCode} className="space-y-4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
                <div className="flex items-center gap-2 text-sm text-ink-2">
                  <ShieldCheck size={18} className="text-ok" />
                  Verificación en dos pasos
                </div>
                <input
                  className="input text-center font-mono text-2xl tracking-[0.5em] py-3"
                  placeholder="••••••"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={16}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <p className="text-xs text-muted">Ingrese el código de 6 dígitos de su app autenticadora o un código de recuperación (XXXX-XXXX-XXXX).</p>
                <ErrorNote>{error}</ErrorNote>
                <button className="btn btn-primary w-full py-2.5" disabled={busy || code.length < 6}>
                  {busy ? "Verificando…" : "Confirmar"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost w-full text-ink-2"
                  onClick={() => {
                    setMfaToken(null);
                    setError("");
                  }}
                >
                  <ArrowLeft size={14} /> Volver
                </button>
              </motion.form>
            )}
          </AnimatePresence>
        </div>
        <p className="text-center text-[11px] text-muted mt-4 tracking-wide">
          Acceso restringido y auditado. Toda actividad queda registrada en la bitácora de seguridad.
        </p>
      </motion.div>
    </div>
  );
}
