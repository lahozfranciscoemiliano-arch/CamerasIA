import { KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setStepUpHandler } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ErrorNote, Field, Modal } from "./ui";

/**
 * Re-autenticación para acciones sensibles: cuando la API responde "step_up_required" se pide el código 2FA,
 * se valida y se reintenta automáticamente la operación original.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { me, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const totp = me?.user.totpEnabled ?? false;

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setCode("");
          setError("");
          setOpen(true);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/step-up", totp ? { code } : { password: code });
      await refresh();
      finish(true);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Modal
        open={open}
        onClose={() => finish(false)}
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-accent" /> Confirmar identidad
          </span>
        }
        width={420}
        footer={
          <>
            <button className="btn" onClick={() => finish(false)}>
              Cancelar
            </button>
            <button className="btn btn-primary" disabled={busy || code.length < (totp ? 6 : 1)} onClick={() => void submit()}>
              Confirmar
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <p className="text-sm text-ink-2">
            Esta acción es sensible (credenciales, VPN, usuarios). {totp ? "Ingrese el código de su app autenticadora." : "Ingrese su contraseña."}
          </p>
          <Field label={totp ? "Código 2FA o de recuperación" : "Contraseña"}>
            <div className="relative">
              <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                className="input pl-9 font-mono tracking-[0.3em]"
                type={totp ? "text" : "password"}
                inputMode={totp ? "numeric" : undefined}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={totp ? "123456" : "••••••••"}
              />
            </div>
          </Field>
          <ErrorNote>{error}</ErrorNote>
        </form>
      </Modal>
    </>
  );
}
