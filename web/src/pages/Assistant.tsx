import { AnimatePresence, motion } from "framer-motion";
import { Bot, Download, FileText, MessageSquarePlus, Send, Sparkles, Square, Trash2, User, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import Markdown from "../components/Markdown";
import { Empty, ErrorNote, Field, PageHeader, Panel, Spinner, Tabs } from "../components/ui";
import { api, ApiError, streamSse } from "../lib/api";
import { fmtAgo, fmtNum } from "../lib/format";
import { useApi } from "../lib/hooks";

interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
}
interface ConvSummary {
  id: string;
  title: string;
  updated_at: number;
}

const TOOL_LABEL: Record<string, string> = {
  get_system_status: "Estado del sistema",
  search_events: "Buscando eventos",
  get_event: "Detalle de evento",
  list_cameras: "Listando cámaras",
  view_camera: "Mirando cámara en vivo",
  get_network_health: "Salud de la red",
};

const SUGGESTIONS = [
  "¿Cuál es el estado general ahora mismo?",
  "Resumime los eventos críticos y altos de las últimas 12 horas",
  "¿Qué cámaras están sin señal y desde cuándo?",
  "Mirá la cámara del Acceso Principal y decime si hay algo raro",
  "¿Hubo actividad en el perímetro fuera de horario anoche?",
  "¿Está conectada la VPN y responden los servidores exacqVision?",
];

function Chat() {
  const { data: convs, reload } = useApi<ConvSummary[]>("/api/ai/conversations");
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages, activeTool]);

  const open = async (id: string) => {
    if (busy) return;
    setConvId(id);
    setError("");
    const c = await api.get<{ messages: Msg[] }>(`/api/ai/conversations/${id}`);
    setMessages(c.messages);
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    setError("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "", tools: [] }]);
    const ac = new AbortController();
    abortRef.current = ac;
    // Si el turno falla, el servidor no guarda nada: volvemos a la conversación previa (o a una nueva).
    const previousConv = convId;
    let saved = false;
    const patchLast = (fn: (m: Msg) => Msg) => setMessages((all) => [...all.slice(0, -1), fn(all[all.length - 1]!)]);
    try {
      await streamSse(
        "/api/ai/chat",
        { conversationId: convId ?? undefined, message: text },
        (event, data) => {
          if (event === "status") setConvId((data as { conversationId: string }).conversationId);
          else if (event === "text") {
            setActiveTool(null);
            patchLast((m) => ({ ...m, text: m.text + (data as string) }));
          } else if (event === "tool") {
            const name = (data as { name: string }).name;
            setActiveTool(name);
            patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), name] }));
          } else if (event === "done") saved = true;
          else if (event === "error") setError((data as { message: string }).message);
        },
        ac.signal,
      );
    } catch (e) {
      if (!ac.signal.aborted) setError((e as ApiError).message);
    } finally {
      if (!saved) setConvId(previousConv);
      setBusy(false);
      setActiveTool(null);
      void reload();
    }
  };

  const newChat = () => {
    abortRef.current?.abort();
    setConvId(null);
    setMessages([]);
    setError("");
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-230px)] min-h-[520px]">
      <Panel title="Conversaciones" bodyClass="p-2 overflow-y-auto" className="hidden lg:flex" actions={<button className="btn btn-sm btn-ghost text-accent" onClick={newChat}><MessageSquarePlus size={15} /></button>}>
        <div className="space-y-1">
          {convs?.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm cursor-pointer ${c.id === convId ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-panel-3"}`} onClick={() => void open(c.id)}>
              <span className="flex-1 truncate">{c.title}</span>
              <span className="text-[10px] text-muted group-hover:hidden">{fmtAgo(c.updated_at)}</span>
              <button
                className="hidden group-hover:block text-muted hover:text-crit"
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.del(`/api/ai/conversations/${c.id}`);
                  if (c.id === convId) newChat();
                  void reload();
                }}
                aria-label="Eliminar"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!convs?.length && <div className="text-xs text-muted p-2">Sin conversaciones previas.</div>}
        </div>
      </Panel>

      <Panel bodyClass="p-0 flex flex-col h-full" glow>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!messages.length && (
            <div className="h-full flex flex-col items-center justify-center text-center gap-4">
              <div className="relative w-20 h-20 rounded-2xl grid place-items-center bg-ai/10 border border-ai/40">
                <Sparkles size={36} className="text-ai" />
                <span className="absolute inset-0 rounded-2xl ring-alert" style={{ ["--ring-color" as string]: "#a78bfa" }} />
              </div>
              <div>
                <div className="font-display text-2xl tracking-wide">Asistente del SOC</div>
                <p className="text-sm text-ink-2 max-w-lg">Consulta eventos, estado de cámaras, VPN y equipos en tiempo real, y puede mirar cualquier cámara en vivo para describirte la escena.</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 max-w-2xl w-full">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="text-left text-sm rounded-lg border border-line px-3 py-2 hover:border-ai/60 hover:bg-ai/5 text-ink-2" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>
            {messages.map((m, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                {m.role === "assistant" && (
                  <div className="w-8 h-8 shrink-0 rounded-lg grid place-items-center bg-ai/15 border border-ai/40 text-ai">
                    <Bot size={16} />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-xl px-4 py-3 ${m.role === "user" ? "bg-accent/12 border border-accent/30" : "bg-panel-2/70 border border-line"}`}>
                  {m.tools && m.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {m.tools.map((t, j) => (
                        <span key={j} className="inline-flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 bg-ai/10 text-[#d9ceff] border border-ai/30">
                          <Wrench size={10} /> {TOOL_LABEL[t] ?? t}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" ? m.text ? <Markdown text={m.text} /> : <Spinner size={14} /> : <div className="whitespace-pre-wrap text-sm">{m.text.replace(/^\[[^\]]+\]\s*/, "")}</div>}
                </div>
                {m.role === "user" && (
                  <div className="w-8 h-8 shrink-0 rounded-lg grid place-items-center bg-accent/15 border border-accent/40 text-accent">
                    <User size={16} />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
          {activeTool && (
            <div className="flex items-center gap-2 text-xs text-ai pl-11">
              <Spinner size={12} /> {TOOL_LABEL[activeTool] ?? activeTool}…
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div ref={endRef} />
        </div>
        <form
          className="border-t border-line-soft p-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            className="input resize-none h-12 max-h-40"
            placeholder="Preguntá algo sobre la operación… (Enter para enviar, Shift+Enter nueva línea)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn btn-danger" onClick={() => abortRef.current?.abort()} title="Detener">
              <Square size={16} />
            </button>
          ) : (
            <button className="btn btn-ai" disabled={!input.trim()}>
              <Send size={16} />
            </button>
          )}
        </form>
      </Panel>
    </div>
  );
}

function Report() {
  const [hours, setHours] = useState(12);
  const [notes, setNotes] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    setBusy(true);
    setText("");
    setError("");
    try {
      await streamSse("/api/ai/report", { hours, notes: notes || undefined }, (ev, data) => {
        if (ev === "text") setText((t) => t + (data as string));
        if (ev === "error") setError((data as { message: string }).message);
      });
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-4">
      <Panel title="Parámetros" icon={<FileText size={16} />} bodyClass="p-4 space-y-4">
        <Field label="Período">
          <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[8, 12, 24, 48, 72].map((h) => (
              <option key={h} value={h}>
                Últimas {h} horas
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notas del operador (opcional)" hint="Novedades que la IA debe incluir: rondas, llamados, mantenimiento…">
          <textarea className="input h-28" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button className="btn btn-ai w-full" onClick={() => void generate()} disabled={busy}>
          {busy ? <Spinner size={14} /> : <Sparkles size={14} />} Generar reporte de turno
        </button>
        {text && !busy && (
          <a className="btn w-full" download={`reporte_turno_${new Date().toISOString().slice(0, 16)}.md`} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`}>
            <Download size={14} /> Descargar (.md)
          </a>
        )}
        <ErrorNote>{error}</ErrorNote>
      </Panel>
      <Panel title="Reporte" bodyClass="p-5 min-h-[400px]">
        {text ? <Markdown text={text} /> : busy ? <Spinner /> : <Empty icon={<FileText size={28} />} title="Sin reporte">Generá el reporte de entrega de turno a partir de los eventos reales del período.</Empty>}
      </Panel>
    </div>
  );
}

interface Usage {
  model: string;
  available: boolean;
  byFeature: Array<{ feature: string; n: number; input: number; output: number; cache: number }>;
  daily: Array<{ day: string; input: number; output: number }>;
  budget: { usedLastHour: number; maxPerHour: number };
}

function UsageView() {
  const { data } = useApi<Usage>("/api/ai/usage?days=14");
  if (!data) return <Spinner />;
  const totalIn = data.byFeature.reduce((a, f) => a + f.input, 0);
  const totalOut = data.byFeature.reduce((a, f) => a + f.output, 0);
  // Precio de referencia de claude-opus-5-5 (USD por millón de tokens): entrada 4, salida 20.
  const est = (totalIn / 1e6) * 4 + (totalOut / 1e6) * 20;
  const FEATURE: Record<string, string> = { vision: "Análisis visual", assistant: "Asistente", report: "Reportes" };
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Panel title="Resumen 14 días" bodyClass="p-4 space-y-2 text-sm">
        <div>
          Modelo: <code className="font-mono">{data.model}</code>
        </div>
        <div>Tokens de entrada: <b>{fmtNum(totalIn)}</b></div>
        <div>Tokens de salida: <b>{fmtNum(totalOut)}</b></div>
        <div>
          Costo estimado: <b>US$ {est.toFixed(2)}</b> <span className="text-xs text-muted">(referencia; verifique su facturación)</span>
        </div>
        <div className="text-xs text-muted">
          Análisis visuales última hora: {data.budget.usedLastHour} / {data.budget.maxPerHour}
        </div>
        <table className="w-full text-xs mt-2">
          <tbody>
            {data.byFeature.map((f) => (
              <tr key={f.feature} className="border-t border-line-soft">
                <td className="py-1.5">{FEATURE[f.feature] ?? f.feature}</td>
                <td className="text-right">{f.n} llamadas</td>
                <td className="text-right font-mono">{fmtNum(f.input + f.output)} tok</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Tokens por día" className="xl:col-span-2" bodyClass="p-3 h-[300px]">
        {data.daily.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.daily} margin={{ left: -6, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} stroke="#1a2742" />
              <XAxis dataKey="day" stroke="#66779c" tick={{ fontSize: 11 }} tickLine={false} />
              <YAxis stroke="#66779c" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip contentStyle={{ background: "#0f1b33", border: "1px solid #1b2b4b", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "rgba(34,211,238,0.06)" }} />
              <Bar dataKey="input" name="Entrada" stackId="t" fill="#3987e5" stroke="#0b1426" strokeWidth={2} />
              <Bar dataKey="output" name="Salida" stackId="t" fill="#c98500" stroke="#0b1426" strokeWidth={2} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty title="Sin consumo registrado" />
        )}
      </Panel>
    </div>
  );
}

export default function Assistant() {
  const [tab, setTab] = useState<"chat" | "report" | "usage">("chat");
  const { data: status } = useApi<{ available: boolean; model: string }>("/api/ai/status");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Asistente IA"
        subtitle={status ? (status.available ? `Claude · ${status.model}` : "IA no configurada: cargue una credencial tipo 'Anthropic API' en la Bóveda") : ""}
        icon={<Sparkles size={20} />}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "chat", label: "Chat operativo", icon: <Bot size={15} /> },
          { id: "report", label: "Reporte de turno", icon: <FileText size={15} /> },
          { id: "usage", label: "Consumo", icon: <Sparkles size={15} /> },
        ]}
      />
      {tab === "chat" && <Chat />}
      {tab === "report" && <Report />}
      {tab === "usage" && <UsageView />}
    </div>
  );
}
