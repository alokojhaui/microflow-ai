import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import {
  FlaskConical, Activity, AlertTriangle, CheckCircle2, RotateCw, Sparkles, Droplet,
  SlidersHorizontal, Layers, Image as ImageIcon, Upload, Beaker, Info, Key, X,
  Sun, Moon,
} from "lucide-react";
// ---------------------------------------------------------------------------
// Gemini REST API — direct fetch to generativelanguage.googleapis.com
// (avoids @google/genai SDK routing to internal GCP endpoints)
// ---------------------------------------------------------------------------
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getApiKey() {
  return (
    sessionStorage.getItem("mf_gemini_key") ||
    import.meta.env.VITE_GEMINI_API_KEY ||
    ""
  );
}

async function callGemini({ system, content, max_tokens = 1000 }) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    throw new Error("NO_KEY");
  }

  // Build parts array — handles plain string or Anthropic-style array (vision)
  let parts;
  if (typeof content === "string") {
    parts = [{ text: content }];
  } else if (Array.isArray(content)) {
    parts = content.map((p) => {
      if (p.type === "image") {
        return { inline_data: { mime_type: p.source.media_type, data: p.source.data } };
      }
      return { text: p.text };
    });
  } else {
    parts = [{ text: JSON.stringify(content) }];
  }

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: max_tokens,
      temperature: 0.3,
      responseMimeType: "application/json",
    },
  };

  let res;
  try {
    res = await fetch(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
  } catch (netErr) {
    throw new Error(`Network error: ${netErr.message}`);
  }

  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch (_) { errBody = res.statusText; }
    // Try to extract a human-readable message from the API error JSON
    try {
      const parsed = JSON.parse(errBody);
      const msg = parsed?.error?.message || errBody;
      if (res.status === 400) throw new Error(`Bad request: ${msg}`);
      if (res.status === 401 || res.status === 403) throw new Error(`API key rejected (${res.status}): ${msg}`);
      if (res.status === 429) throw new Error(`Quota exceeded — wait a moment and retry.`);
      throw new Error(`Gemini ${res.status}: ${msg}`);
    } catch (e) {
      if (e.message.startsWith("Gemini") || e.message.startsWith("API") ||
          e.message.startsWith("Bad") || e.message.startsWith("Quota") ||
          e.message.startsWith("Network")) throw e;
      throw new Error(`Gemini API error ${res.status}: ${errBody.slice(0, 200)}`);
    }
  }

  const data = await res.json();

  // Check for blocked or empty response
  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY" || finishReason === "RECITATION") {
    throw new Error(`Response blocked by Gemini safety filters (${finishReason}).`);
  }

  const raw = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");

  if (!raw.trim()) {
    // Log the full response for debugging
    console.error("Empty Gemini response:", JSON.stringify(data));
    throw new Error(`Gemini returned an empty response. Finish reason: ${finishReason || "unknown"}`);
  }

  // Robust JSON extraction: strip markdown fences then find the first { } block
  const stripped = raw.replace(/```json\s*|```\s*/g, "").trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("No JSON object found in Gemini response:", raw);
    throw new Error("Gemini response did not contain valid JSON.");
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    console.error("JSON parse failed:", jsonMatch[0]);
    throw new Error(`JSON parse error: ${parseErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Domain data: dose-response presets (Hill equation)
// ---------------------------------------------------------------------------
const DEFAULT_COMPOUNDS = [
  { id: "mf071", name: "MF-071", cls: "Kinase inhibitor", ic50: 2.5, hill: 1.4, bottom: 8 },
  { id: "cmpB", name: "Compound B", cls: "Natural product analog", ic50: 35, hill: 1.0, bottom: 45 },
  { id: "nce19", name: "NCE-19", cls: "Novel chemical entity", ic50: 0.6, hill: 2.2, bottom: 5 },
  { id: "veh", name: "Vehicle (DMSO)", cls: "Control", ic50: 1000, hill: 1.0, bottom: 95 },
];
const DEFAULT_COLORS = {
  mf071: "var(--cyan)",
  cmpB: "var(--amber)",
  nce19: "var(--coral)",
  veh: "var(--violet)",
};
// Extra colors cycled for user-added compounds
const CUSTOM_COLOR_POOL = [
  "#a78bfa", "#34d399", "#fb923c", "#f472b6",
  "#60a5fa", "#e879f9", "#facc15", "#2dd4bf",
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const noise = (mag) => (Math.random() - 0.5) * 2 * mag;

function fmtConc(v) {
  if (v >= 100) return Math.round(v).toString();
  if (v >= 1) return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 1000) / 1000).toString();
}

function logspace(min, max, n) {
  const lo = Math.log10(min), hi = Math.log10(max);
  const step = (hi - lo) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.pow(10, lo + step * i));
}

function simulateWells(preset, concentrations, labels) {
  return concentrations.map((c, i) => {
    const viability = clamp(
      preset.bottom + (100 - preset.bottom) / (1 + Math.pow(c / preset.ic50, preset.hill)) + noise(4),
      0, 100
    );
    const morphology = clamp(viability * 0.82 + noise(6) + 6, 0, 100);
    const deadDots = Math.round(((100 - viability) / 100) * 9);
    return { id: i, concentration: c, label: labels[i], viability, morphology, deadDots };
  });
}

// Real (non-AI) curve fit: grid-search least-squares fit of the four-parameter
// Hill equation to observed well data.
function fitHillCurve(wells) {
  const xs = wells.map((w) => Math.max(w.concentration, 1e-6));
  const ys = wells.map((w) => w.viability);
  const top = 100;
  const minX = Math.min(...xs.filter((x) => x > 1e-4));
  const maxX = Math.max(...xs);
  const lo = Math.log10(minX / 5), hi = Math.log10(maxX * 5);
  const ic50Candidates = Array.from({ length: 41 }, (_, i) => Math.pow(10, lo + ((hi - lo) * i) / 40));
  const hillCandidates = Array.from({ length: 14 }, (_, i) => 0.4 + i * 0.2);
  const bottomCandidates = Array.from({ length: 21 }, (_, i) => i * 5);

  let best = null;
  for (const ic50 of ic50Candidates) {
    for (const hill of hillCandidates) {
      for (const bottom of bottomCandidates) {
        let sse = 0;
        for (let i = 0; i < xs.length; i++) {
          const pred = bottom + (top - bottom) / (1 + Math.pow(xs[i] / ic50, hill));
          const err = ys[i] - pred;
          sse += err * err;
        }
        if (!best || sse < best.sse) best = { sse, ic50, hill, bottom };
      }
    }
  }
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ssTot = ys.reduce((a, y) => a + (y - meanY) * (y - meanY), 0);
  const r2 = ssTot > 0 ? clamp(1 - best.sse / ssTot, 0, 1) : 0;
  return { ic50: best.ic50, hill: best.hill, bottom: best.bottom, r2 };
}

function riskColor(risk) {
  if (risk === "High") return "var(--coral)";
  if (risk === "Moderate") return "var(--amber)";
  if (risk === "Low") return "var(--cyan)";
  return "var(--muted)";
}

// Deterministic 3×3 jittered dot layout used inside every well
const DOT_OFFSETS = [
  [-9, -9], [0, -10], [9, -8],
  [-10, 1], [1, 0], [10, 2],
  [-8, 10], [0, 9], [9, 10],
];

// ---------------------------------------------------------------------------
// API Key settings panel
// ---------------------------------------------------------------------------
function ApiKeyPanel({ onClose }) {
  const [val, setVal] = useState(sessionStorage.getItem("mf_gemini_key") || "");
  const save = () => {
    if (val.trim()) sessionStorage.setItem("mf_gemini_key", val.trim());
    else sessionStorage.removeItem("mf_gemini_key");
    onClose();
  };
  const envKey = import.meta.env.VITE_GEMINI_API_KEY;
  const hasEnv = envKey && envKey !== "your_gemini_api_key_here";

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(7,11,22,0.82)", backdropFilter: "blur(4px)",
      zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14,
        padding: "24px 26px", maxWidth: 420, width: "100%", position: "relative",
      }}>
        <button onClick={onClose} style={{
          position: "absolute", top: 14, right: 14, background: "none", border: "none",
          color: "var(--muted)", cursor: "pointer", padding: 4,
        }}>
          <X size={16} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <Key size={16} color="var(--cyan)" />
          <span style={{ fontWeight: 600, fontSize: 15 }}>Gemini API Key</span>
        </div>
        {hasEnv && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, color: "var(--cyan)",
            fontSize: 12.5, marginBottom: 12, padding: "7px 10px",
            background: "rgba(77,232,212,0.07)", borderRadius: 7,
          }}>
            <CheckCircle2 size={13} /> Key loaded from <code>.env</code> file — AI features ready.
          </div>
        )}
        {!hasEnv && (
          <>
            <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
              Paste your <strong style={{ color: "var(--text)" }}>Google Gemini API key</strong> to enable AI analysis.
              Stored only in session storage — cleared when you close the tab.
            </p>
            <input
              type="password"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="AIza…"
              style={{
                width: "100%", background: "var(--panel-2)", border: "1px solid var(--line)",
                color: "var(--text)", padding: "9px 12px", borderRadius: 8, fontSize: 13,
                marginBottom: 12, fontFamily: "monospace",
              }}
            />
            <button className="mf-btn primary" onClick={save} style={{ width: "100%", justifyContent: "center" }}>
              <CheckCircle2 size={14} /> Save key &amp; close
            </button>
            <p style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>
              Get a free key at{" "}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--cyan)" }}>
                aistudio.google.com/apikey
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add compound modal
// ---------------------------------------------------------------------------
const FIELD_STYLE = {
  width: "100%", background: "var(--panel-2)", border: "1px solid var(--line)",
  color: "var(--text)", padding: "8px 11px", borderRadius: 8, fontSize: 13,
  marginBottom: 11,
};

function AddCompoundModal({ onClose, onAdd, colorPool }) {
  const [name, setName] = useState("");
  const [cls, setCls] = useState("");
  const [ic50, setIc50] = useState("10");
  const [hill, setHill] = useState("1.0");
  const [bottom, setBottom] = useState("5");
  const [colorIdx, setColorIdx] = useState(0);
  const [err, setErr] = useState("");

  const validate = () => {
    if (!name.trim()) return "Compound name is required.";
    const ic = parseFloat(ic50);
    const hl = parseFloat(hill);
    const bt = parseFloat(bottom);
    if (isNaN(ic) || ic <= 0) return "IC50 must be a positive number (µM).";
    if (isNaN(hl) || hl < 0.1 || hl > 5) return "Hill slope must be between 0.1 and 5.";
    if (isNaN(bt) || bt < 0 || bt > 100) return "Bottom plateau must be 0–100%.";
    return null;
  };

  const submit = () => {
    const e = validate();
    if (e) { setErr(e); return; }
    onAdd({
      id: "custom_" + Date.now(),
      name: name.trim(),
      cls: cls.trim() || "Custom compound",
      ic50: parseFloat(ic50),
      hill: parseFloat(hill),
      bottom: parseFloat(bottom),
      customColor: colorPool[colorIdx % colorPool.length],
    });
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(7,11,22,0.85)", backdropFilter: "blur(4px)",
      zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14,
        padding: "24px 26px", maxWidth: 440, width: "100%", position: "relative",
        animation: "mfFadeIn 0.2s ease",
      }}>
        <button onClick={onClose} style={{
          position: "absolute", top: 14, right: 14, background: "none", border: "none",
          color: "var(--muted)", cursor: "pointer", padding: 4,
        }}><X size={16} /></button>

        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 18 }}>
          <FlaskConical size={16} color="var(--cyan)" />
          <span style={{ fontWeight: 600, fontSize: 15 }}>Add custom compound</span>
        </div>

        <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>
          Compound name <span style={{ color: "var(--coral)" }}>*</span>
        </label>
        <input style={FIELD_STYLE} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CPX-3140" />

        <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>
          Compound class
        </label>
        <input style={FIELD_STYLE} value={cls} onChange={e => setCls(e.target.value)} placeholder="e.g. HDAC inhibitor" />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>IC50 (µM)</label>
            <input style={{ ...FIELD_STYLE, marginBottom: 0 }} type="number" min="0.0001" step="any"
              value={ic50} onChange={e => setIc50(e.target.value)} />
          </div>
          <div>
            <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>Hill slope</label>
            <input style={{ ...FIELD_STYLE, marginBottom: 0 }} type="number" min="0.1" max="5" step="0.1"
              value={hill} onChange={e => setHill(e.target.value)} />
          </div>
          <div>
            <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>Bottom %</label>
            <input style={{ ...FIELD_STYLE, marginBottom: 0 }} type="number" min="0" max="100" step="1"
              value={bottom} onChange={e => setBottom(e.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 14, marginBottom: 14 }}>
          <label style={{ display: "block", color: "var(--muted)", fontSize: 12, marginBottom: 7 }}>
            Curve colour
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {colorPool.map((c, i) => (
              <button key={c} onClick={() => setColorIdx(i)} style={{
                width: 24, height: 24, borderRadius: "50%", background: c, border: "none",
                cursor: "pointer", outline: colorIdx === i ? `2px solid ${c}` : "2px solid transparent",
                outlineOffset: 2, transition: "outline 0.1s",
              }} title={c} />
            ))}
          </div>
        </div>

        {err && (
          <div style={{ color: "var(--coral)", fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />{err}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button className="mf-btn" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>Cancel</button>
          <button className="mf-btn primary" onClick={submit} style={{ flex: 1, justifyContent: "center" }}>
            <CheckCircle2 size={14} /> Add compound
          </button>
        </div>

        <p style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
          IC50 sets the half-maximal dose. Hill slope controls curve steepness.
          Bottom % is the minimum viability plateau.
        </p>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
export default function App() {
  const [compounds, setCompounds] = useState(DEFAULT_COMPOUNDS);
  const [compoundColors, setCompoundColors] = useState({ ...DEFAULT_COLORS });
  const [showAddModal, setShowAddModal] = useState(false);

  const addCompound = useCallback((c) => {
    setCompounds((prev) => [...prev, c]);
    setCompoundColors((prev) => ({ ...prev, [c.id]: c.customColor }));
  }, []);

  const removeCompound = useCallback((id) => {
    setCompounds((prev) => prev.filter((c) => c.id !== id));
    setCompoundColors((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }, []);

  const [mode, setMode] = useState("single");
  const [doseMinExp, setDoseMinExp] = useState(-2);
  const [doseMaxExp, setDoseMaxExp] = useState(2);
  const [history, setHistory] = useState([]);
  const [showKeyPanel, setShowKeyPanel] = useState(false);

  const hasKey = () => {
    const env = import.meta.env.VITE_GEMINI_API_KEY;
    return (env && env !== "your_gemini_api_key_here") || !!sessionStorage.getItem("mf_gemini_key");
  };
  const [keyReady, setKeyReady] = useState(hasKey());

  const handleKeyPanelClose = () => {
    setShowKeyPanel(false);
    setKeyReady(hasKey());
  };

  const pushHistory = useCallback((entry) => {
    setHistory((prev) => [entry, ...prev].slice(0, 8));
  }, []);

  const treatmentConcs = useMemo(
    () => logspace(Math.pow(10, doseMinExp), Math.pow(10, doseMaxExp), 5),
    [doseMinExp, doseMaxExp]
  );
  const concentrations = useMemo(() => [treatmentConcs[0] / 10, ...treatmentConcs], [treatmentConcs]);
  const labels = useMemo(() => ["Ctrl", ...treatmentConcs.map(fmtConc)], [treatmentConcs]);

  const onMinChange = (e) => {
    const v = parseFloat(e.target.value);
    setDoseMinExp(Math.min(v, doseMaxExp - 1));
  };
  const onMaxChange = (e) => {
    const v = parseFloat(e.target.value);
    setDoseMaxExp(Math.max(v, doseMinExp + 1));
  };

  const [theme, setTheme] = useState(() => localStorage.getItem("mf_theme") || "dark");

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("mf_theme", next);
      return next;
    });
  }, []);

  return (
    <div className="mf-root" data-theme={theme}>
      <style>{`
        .mf-root {
          --ink: #0b1220;
          --panel: #121b2e;
          --panel-2: #16213a;
          --line: #24324d;
          --text: #e7eef5;
          --muted: #8ea0bd;
          --cyan: #4de8d4;
          --coral: #ff6b6b;
          --amber: #f5b942;
          --violet: #b98cff;
          --bg-grad: radial-gradient(ellipse at top left, #0e1830 0%, var(--ink) 55%);
          --btn-bg: linear-gradient(180deg, #1a2740, #14203a);
          --btn-bg-primary: linear-gradient(180deg, #1c3a36, #142822);
          --tab-active-bg: linear-gradient(180deg, #16241f, #101c19);
        }
        .mf-root[data-theme="light"] {
          --ink: #f8fafc;
          --panel: #ffffff;
          --panel-2: #f1f5f9;
          --line: #cbd5e1;
          --text: #0f172a;
          --muted: #64748b;
          --cyan: #0d9488;
          --coral: #e11d48;
          --amber: #d97706;
          --violet: #7c3aed;
          --bg-grad: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
          --btn-bg: linear-gradient(180deg, #ffffff, #f1f5f9);
          --btn-bg-primary: linear-gradient(180deg, #f0fdfa, #ccfbf1);
          --tab-active-bg: linear-gradient(180deg, #f0fdfa, #ccfbf1);
        }

          font-family: 'Inter', -apple-system, sans-serif;
          background: var(--bg-grad);
          color: var(--text);
          padding: 28px;
          border-radius: 0;
          min-height: 100vh;
          box-sizing: border-box;
        }
        .mf-root * { box-sizing: border-box; }
        .mf-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .mf-display { font-family: 'Space Grotesk', 'Inter', sans-serif; }
        .mf-root :focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }

        .mf-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; animation: mfFadeIn 0.5s ease; flex-wrap: wrap; gap: 10px; }
        .mf-title { display:flex; align-items:center; gap:10px; }
        .mf-title h1 { font-size: 22px; margin:0; letter-spacing: 0.3px; }
        .mf-title p { margin:2px 0 0; color: var(--muted); font-size: 13px; }
        .mf-header-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .mf-status { display:flex; align-items:center; gap:7px; font-size:12px; color: var(--muted); }
        .mf-dot { width:8px; height:8px; border-radius:50%; background: var(--cyan); box-shadow: 0 0 8px var(--cyan); animation: mfPulse 2s infinite; }
        .mf-dot-warn { background: var(--amber); box-shadow: 0 0 8px var(--amber); }

        .mf-tabs { display:flex; gap:8px; margin-bottom:18px; flex-wrap:wrap; }
        .mf-tab { background: var(--panel); border: 1px solid var(--line); color: var(--muted); padding: 8px 14px; border-radius: 9px; font-size: 13px; cursor: pointer; display:flex; align-items:center; gap:7px; transition: all 0.15s ease; }
        .mf-tab:hover { color: var(--text); border-color: #33415f; }
        .mf-tab.active { color: var(--cyan); border-color: #275a52; background: var(--tab-active-bg); }

        .mf-grid { display:grid; grid-template-columns: 1fr 1.1fr; gap: 22px; }
        @media (max-width: 820px) { .mf-grid { grid-template-columns: 1fr; } }

        .mf-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
        .mf-card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 14px; display:flex; align-items:center; gap:7px; }

        .mf-controls { display:flex; gap:10px; margin-bottom: 14px; flex-wrap: wrap; }
        .mf-select { flex: 1; min-width: 180px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 9px 10px; border-radius: 8px; font-size: 13px; }
        .mf-btn { background: var(--btn-bg); border: 1px solid var(--line); color: var(--text); padding: 9px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; display:flex; align-items:center; gap:7px; transition: all 0.15s ease; }
        .mf-btn:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
        .mf-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .mf-btn.primary { background: var(--btn-bg-primary); border-color: #275a52; color: var(--cyan); }
        .mf-btn.primary:hover:not(:disabled) { box-shadow: 0 0 0 3px rgba(77,232,212,0.15); }
        .mf-btn.key-btn { border-color: var(--amber); color: var(--amber); }
        .mf-btn.key-btn:hover:not(:disabled) { box-shadow: 0 0 0 3px rgba(245,185,66,0.15); }

        .mf-slider-row { margin-bottom: 6px; }
        .mf-slider-row label { display:flex; justify-content:space-between; font-size:12.5px; color:var(--muted); margin-bottom:5px; }
        .mf-slider-row label span { color: var(--text); }
        input[type="range"] { -webkit-appearance:none; width:100%; height:4px; background:var(--line); border-radius:2px; outline:none; margin:0 0 16px; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:var(--cyan); cursor:pointer; box-shadow:0 0 6px rgba(77,232,212,0.6); }
        input[type="range"]::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:var(--cyan); border:none; cursor:pointer; }
        input[type="checkbox"] { accent-color: var(--cyan); width:14px; height:14px; }

        .mf-dose-chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:2px; }
        .mf-dose-chip { background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; font-size: 11px; color: var(--muted); }
        .mf-dose-caption { color: var(--muted); font-size: 11.5px; margin: 10px 0 0; }

        .mf-check-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
        .mf-check-item { display:flex; align-items:center; gap:7px; font-size:13px; cursor:pointer; padding:7px 11px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); }
        .mf-swatch { width:10px; height:10px; border-radius:50%; display:inline-block; }

        .mf-upload-zone { border:1.5px dashed var(--line); border-radius:10px; padding:30px 20px; text-align:center; cursor:pointer; transition:border-color .15s ease; }
        .mf-upload-zone:hover { border-color: var(--cyan); }
        .mf-upload-zone p { color: var(--muted); font-size:13px; margin:10px 0 0; }
        .mf-thumb { max-width:100%; max-height:240px; border-radius:8px; border:1px solid var(--line); display:block; margin:0 auto 14px; }

        .mf-chip-svg { width: 100%; height: auto; }
        .mf-flow { stroke-dasharray: 6 5; animation: mfFlow 1.4s linear infinite; }
        .mf-well-label { font-size: 10px; fill: var(--muted); font-family: 'JetBrains Mono', monospace; }
        .mf-dot-cell { transition: fill 0.6s ease; }

        .mf-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
        .mf-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 5px 8px; border-bottom: 1px solid var(--line); }
        .mf-table td { padding: 5px 8px; border-bottom: 1px solid #1c2740; }

        .mf-ai-panel { margin-top: 20px; background: #0d1526; border: 1px solid var(--line); border-radius: 12px; padding: 18px; animation: mfFadeIn 0.4s ease; }
        .mf-ai-h { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 10px; display:flex; align-items:center; gap:7px; }
        .mf-ai-error { display:flex; align-items:center; gap:8px; color: var(--coral); font-size:13px; flex-wrap: wrap; }
        .mf-ai-readout { display:flex; gap: 22px; flex-wrap: wrap; margin: 10px 0 12px; }
        .mf-ai-stat { display:flex; flex-direction: column; }
        .mf-ai-stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
        .mf-ai-stat .v { font-size: 17px; margin-top: 2px; }
        .mf-ai-text { color: var(--text); font-size: 13.5px; line-height: 1.55; margin-bottom: 6px; }
        .mf-notice { display:flex; align-items:center; gap:8px; color: var(--amber); font-size:13px; margin-bottom:10px; }
        .mf-rec { margin-top: 10px; padding: 10px 12px; background: rgba(77,232,212,0.06); border-left: 2px solid var(--cyan); border-radius: 4px; font-size: 13px; }

        .mf-fit-block { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 14px; }
        .mf-eyebrow { color: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 3px; }

        .mf-history { display:flex; gap: 10px; overflow-x: auto; margin-top: 18px; padding-bottom: 4px; }
        .mf-hist-pill { flex: 0 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 8px 12px; font-size: 11.5px; min-width: 140px; }
        .mf-hist-pill .c { color: var(--text); font-weight: 600; }
        .mf-hist-pill .r { margin-top: 3px; }

        .mf-no-key-banner { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
          background: rgba(245,185,66,0.07); border: 1px solid rgba(245,185,66,0.25); border-radius:10px;
          padding: 10px 14px; margin-bottom: 18px; font-size: 13px; color: var(--amber); }

        @keyframes mfFadeIn { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform: translateY(0); } }
        @keyframes mfPulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
        @keyframes mfFlow { to { stroke-dashoffset: -22; } }
        @keyframes mfSpin { to { transform: rotate(360deg); } }
        .mf-spin { animation: mfSpin 0.9s linear infinite; transform-origin: center; display:inline-block; }
        @media (prefers-reduced-motion: reduce) {
          .mf-flow, .mf-dot, .mf-spin { animation: none; }
        }
      `}</style>

      {showKeyPanel && <ApiKeyPanel onClose={handleKeyPanelClose} />}
      {showAddModal && (
        <AddCompoundModal
          onClose={() => setShowAddModal(false)}
          onAdd={addCompound}
          colorPool={CUSTOM_COLOR_POOL}
        />
      )}

      <div className="mf-header">
        <div className="mf-title">
          <FlaskConical size={22} color="var(--cyan)" />
          <div>
            <h1 className="mf-display">MicroFlow AI</h1>
            <p>Smart microfluidics for cell-culture drug screening</p>
          </div>
        </div>
        <div className="mf-header-right">
          <button className="mf-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button className="mf-btn" onClick={() => setShowAddModal(true)} style={{ borderColor: "var(--violet)", color: "var(--violet)" }}>
            <FlaskConical size={13} /> Add compound
          </button>
          <button className={`mf-btn ${keyReady ? "" : "key-btn"}`} onClick={() => setShowKeyPanel(true)} id="api-key-btn">
            <Key size={13} /> {keyReady ? "API key set" : "Set API key"}
          </button>
          <div className="mf-status">
            <span className={`mf-dot ${keyReady ? "" : "mf-dot-warn"}`} />
            {keyReady ? "Gemini ready" : "No API key"}
          </div>
        </div>
      </div>

      {!keyReady && (
        <div className="mf-no-key-banner">
          <span><AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            No Gemini API key detected. Simulation works locally — AI analysis requires a key.
          </span>
          <button className="mf-btn key-btn" onClick={() => setShowKeyPanel(true)} style={{ padding: "6px 12px" }}>
            <Key size={12} /> Add key
          </button>
        </div>
      )}

      <div className="mf-tabs">
        <button id="tab-single" className={`mf-tab ${mode === "single" ? "active" : ""}`} onClick={() => setMode("single")}>
          <Beaker size={14} /> Simulated assay
        </button>
        <button id="tab-compare" className={`mf-tab ${mode === "compare" ? "active" : ""}`} onClick={() => setMode("compare")}>
          <Layers size={14} /> Compare compounds
        </button>
        <button id="tab-image" className={`mf-tab ${mode === "image" ? "active" : ""}`} onClick={() => setMode("image")}>
          <ImageIcon size={14} /> Upload image
        </button>
      </div>

      {mode !== "image" && (
        <div className="mf-card" style={{ marginBottom: 18 }}>
          <h2><SlidersHorizontal size={14} /> Dose range</h2>
          <div className="mf-slider-row">
            <label>Low dose <span className="mf-mono">{fmtConc(Math.pow(10, doseMinExp))} µM</span></label>
            <input id="slider-dose-min" type="range" min={-4} max={1.5} step={0.25} value={doseMinExp} onChange={onMinChange} />
          </div>
          <div className="mf-slider-row">
            <label>High dose <span className="mf-mono">{fmtConc(Math.pow(10, doseMaxExp))} µM</span></label>
            <input id="slider-dose-max" type="range" min={-1} max={3.5} step={0.25} value={doseMaxExp} onChange={onMaxChange} />
          </div>
          <div className="mf-dose-chips mf-mono">
            {labels.map((l, i) => (
              <span key={i} className="mf-dose-chip">{i === 0 ? "Ctrl" : `${l} µM`}</span>
            ))}
          </div>
          <p className="mf-dose-caption">Applies to Simulated Assay and Compare Compounds modes.</p>
        </div>
      )}

      {mode === "single" && (
        <SingleAssayView
          concentrations={concentrations}
          labels={labels}
          pushHistory={pushHistory}
          keyReady={keyReady}
          onNeedKey={() => setShowKeyPanel(true)}
          compounds={compounds}
          compoundColors={compoundColors}
          onRemoveCompound={removeCompound}
          onAddCompound={() => setShowAddModal(true)}
        />
      )}
      {mode === "compare" && (
        <CompareView
          concentrations={concentrations}
          labels={labels}
          pushHistory={pushHistory}
          keyReady={keyReady}
          onNeedKey={() => setShowKeyPanel(true)}
          compounds={compounds}
          compoundColors={compoundColors}
          onAddCompound={() => setShowAddModal(true)}
        />
      )}
      {mode === "image" && (
        <ImageView
          pushHistory={pushHistory}
          keyReady={keyReady}
          onNeedKey={() => setShowKeyPanel(true)}
        />
      )}

      {history.length > 0 && (
        <div className="mf-history">
          {history.map((h, i) => (
            <div className="mf-hist-pill mf-mono" key={i}>
              <div className="mf-eyebrow">{h.kind}</div>
              <div className="c">{h.compound}</div>
              <div style={{ color: "var(--muted)" }}>{new Date(h.ts).toLocaleTimeString()}</div>
              <div className="r" style={{ color: riskColor(h.risk) }}>
                {h.risk}{h.ic50 && h.ic50 !== "—" ? ` · IC50 ${h.ic50}µM` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function Rec({ children }) {
  return (
    <div className="mf-rec">
      <CheckCircle2 size={13} style={{ verticalAlign: "-2px", marginRight: 6, color: "var(--cyan)" }} />
      {children}
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div style={{ padding: "40px 10px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single assay mode
// ---------------------------------------------------------------------------
function SingleAssayView({ concentrations, labels, pushHistory, keyReady, onNeedKey, compounds, compoundColors, onRemoveCompound, onAddCompound }) {
  const [presetId, setPresetId] = useState(compounds[0].id);
  const preset = compounds.find((p) => p.id === presetId) || compounds[0];

  // If the selected compound was removed, fall back to first
  useEffect(() => {
    if (!compounds.find((p) => p.id === presetId)) setPresetId(compounds[0]?.id);
  }, [compounds, presetId]);
  const [wells, setWells] = useState(null);
  const [running, setRunning] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  useEffect(() => { setWells(null); setAiResult(null); setAiError(null); }, [concentrations, presetId]);

  const runAssay = useCallback(() => {
    setRunning(true); setAiResult(null); setAiError(null);
    setTimeout(() => {
      setWells(simulateWells(preset, concentrations, labels));
      setRunning(false);
    }, 700);
  }, [preset, concentrations, labels]);

  const fit = useMemo(() => (wells ? fitHillCurve(wells) : null), [wells]);

  const analyzeWithAI = useCallback(async () => {
    if (!keyReady) { onNeedKey(); return; }
    if (!wells || !fit) return;
    setAiLoading(true); setAiError(null);
    try {
      const payload = {
        assayType: "Live/dead fluorescence viability assay, 6-point dose-response, organ-on-chip microwell array",
        compound: preset.name,
        compoundClass: preset.cls,
        wells: wells.map((w) => ({
          concentrationUM: w.label === "Ctrl" ? 0 : w.concentration,
          viabilityPercent: Number(w.viability.toFixed(1)),
          morphologyScore: Number(w.morphology.toFixed(1)),
        })),
        computedFit: {
          ic50UM: Number(fit.ic50.toFixed(3)),
          hillSlope: Number(fit.hill.toFixed(2)),
          bottomPlateauPercent: Number(fit.bottom.toFixed(1)),
          rSquared: Number(fit.r2.toFixed(3)),
        },
      };
      const parsed = await callGemini({
        system:
          "You interpret dose-response data from a simulated microfluidic organ-on-chip drug screening assay. " +
          "The IC50, Hill slope, bottom plateau, and R-squared in computedFit were already calculated by a local " +
          "nonlinear least-squares regression — treat them as ground truth, do NOT recompute or contradict them. " +
          "Your job is only to interpret what they mean biologically and to judge fit quality from rSquared. " +
          "Respond with ONLY a valid JSON object (no markdown fences, no preamble) matching exactly this schema: " +
          '{"toxicityRisk": "Low"|"Moderate"|"High", "confidence": "Low"|"Moderate"|"High", ' +
          '"fitQualityNote": string, "summary": string, "recommendation": string}. ' +
          "confidence should be lower if rSquared is below about 0.85 or if there are too few wells to trust the fit. " +
          "fitQualityNote is one short sentence on whether the fit is trustworthy. " +
          "summary is 2-3 sentences interpreting the curve shape and viability trend. " +
          "recommendation is 1-2 sentences on whether to advance, re-titrate, or deprioritize this compound.",
        content: JSON.stringify(payload),
      });
      setAiResult(parsed);
      pushHistory({
        kind: "Single run", ts: Date.now(), compound: preset.name,
        risk: parsed.toxicityRisk, ic50: Number(fit.ic50.toFixed(2)),
      });
    } catch (e) {
      if (e.message === "NO_KEY") {
        setAiError("NO_KEY");
      } else {
        setAiError(e.message || "AI analysis failed — try again.");
      }
    } finally {
      setAiLoading(false);
    }
  }, [wells, fit, preset, pushHistory, keyReady, onNeedKey]);

  const chartData = useMemo(
    () => (wells || []).map((w) => ({ concentration: w.concentration, viability: w.viability, morphology: w.morphology })),
    [wells]
  );

  return (
    <>
      <div className="mf-grid">
        <div className="mf-card">
          <h2><Droplet size={14} /> Gradient-generator chip</h2>
          <div className="mf-controls">
            <select id="compound-select" className="mf-select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {compounds.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.cls}</option>
              ))}
            </select>
            <button id="run-assay-btn" className="mf-btn primary" onClick={runAssay} disabled={running}>
              <Activity size={14} />
              {running
                ? <><span className="mf-spin" style={{ display: "inline-flex" }}><RotateCw size={14} /></span> Running…</>
                : wells ? "Re-run assay" : "Run assay"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <button className="mf-btn" onClick={onAddCompound} style={{ fontSize: 12, padding: "5px 10px", borderColor: "var(--violet)", color: "var(--violet)" }}>
              <FlaskConical size={12} /> Add compound
            </button>
            {preset?.id?.startsWith("custom_") && (
              <button className="mf-btn" onClick={() => onRemoveCompound(preset.id)}
                style={{ fontSize: 12, padding: "5px 10px", borderColor: "var(--coral)", color: "var(--coral)" }}>
                <X size={12} /> Remove "{preset.name}"
              </button>
            )}
          </div>
          <ChipSVG wells={wells} />
        </div>

        <div className="mf-card">
          <h2><Activity size={14} /> Dose–response readout</h2>
          {!wells ? (
            <EmptyState text="Select a compound and run the assay to generate a dose-response curve." />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#1c2740" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="concentration" type="number" scale="log"
                    domain={[concentrations[0] * 0.7, concentrations[concentrations.length - 1] * 1.4]}
                    ticks={concentrations} tickFormatter={(v) => (v === concentrations[0] ? "Ctrl" : fmtConc(v))}
                    stroke="#8ea0bd" fontSize={11}
                  />
                  <YAxis domain={[0, 100]} stroke="#8ea0bd" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "#121b2e", border: "1px solid #24324d", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(v) => (v === concentrations[0] ? "Vehicle control" : `${fmtConc(v)} µM`)}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={50} stroke="#8ea0bd" strokeDasharray="4 4"
                    label={{ value: "50%", fontSize: 10, fill: "#8ea0bd" }} />
                  <Line type="monotone" dataKey="viability" name="Viability %" stroke="var(--cyan)" strokeWidth={2.5} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="morphology" name="Morphology score" stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2.5 }} />
                </ComposedChart>
              </ResponsiveContainer>

              <table className="mf-table mf-mono">
                <thead><tr><th>Well</th><th>[µM]</th><th>Viability</th><th>Morphology</th></tr></thead>
                <tbody>
                  {wells.map((w) => (
                    <tr key={w.id}>
                      <td>W{w.id + 1}</td>
                      <td>{w.label}</td>
                      <td>{w.viability.toFixed(1)}%</td>
                      <td>{w.morphology.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {fit && (
                <div className="mf-fit-block mf-mono">
                  <div className="mf-eyebrow" style={{ marginBottom: 6 }}>Computed locally — not AI-generated</div>
                  <div className="mf-ai-readout">
                    <div className="mf-ai-stat"><span className="k">IC50 (fit)</span><span className="v">{fmtConc(fit.ic50)} µM</span></div>
                    <div className="mf-ai-stat"><span className="k">Hill slope</span><span className="v">{fit.hill.toFixed(2)}</span></div>
                    <div className="mf-ai-stat"><span className="k">Bottom plateau</span><span className="v">{fit.bottom.toFixed(0)}%</span></div>
                    <div className="mf-ai-stat">
                      <span className="k">Fit R²</span>
                      <span className="v" style={{ color: fit.r2 < 0.85 ? "var(--amber)" : "var(--cyan)" }}>
                        {fit.r2.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <button id="analyze-ai-btn" className="mf-btn primary" onClick={analyzeWithAI} disabled={aiLoading}>
                  {aiLoading
                    ? <><span className="mf-spin"><RotateCw size={14} /></span> Analyzing curve…</>
                    : <><Sparkles size={14} /> Analyze with Gemini</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {(aiResult || aiError) && (
        <div className="mf-ai-panel">
          <h2 className="mf-mono mf-ai-h"><Sparkles size={14} color="var(--cyan)" /> AI interpretation — {preset.name}</h2>
          {aiError ? (
            <div className="mf-ai-error">
              <AlertTriangle size={16} />
              {aiError === "NO_KEY"
                ? <>No API key set. <button className="mf-btn key-btn" onClick={onNeedKey}>Add key</button></>
                : <>{aiError} <button className="mf-btn" onClick={analyzeWithAI}>Retry</button></>}
            </div>
          ) : (
            <>
              <div className="mf-ai-readout mf-mono">
                <div className="mf-ai-stat">
                  <span className="k">Toxicity risk</span>
                  <span className="v" style={{ color: riskColor(aiResult.toxicityRisk) }}>{aiResult.toxicityRisk}</span>
                </div>
                <div className="mf-ai-stat">
                  <span className="k">Confidence</span>
                  <span className="v">{aiResult.confidence}</span>
                </div>
              </div>
              <p className="mf-ai-text" style={{ color: "var(--muted)", fontSize: 12.5 }}>{aiResult.fitQualityNote}</p>
              <p className="mf-ai-text">{aiResult.summary}</p>
              <Rec>{aiResult.recommendation}</Rec>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Compare compounds mode
// ---------------------------------------------------------------------------
function CompareView({ concentrations, labels, pushHistory, keyReady, onNeedKey, compounds, compoundColors, onAddCompound }) {
  const [selected, setSelected] = useState(compounds.map((p) => p.id));
  const [compareWells, setCompareWells] = useState(null);
  const [running, setRunning] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  // Keep selection valid when compounds list changes (e.g. new compound added)
  useEffect(() => {
    setSelected((prev) => {
      const validIds = compounds.map((c) => c.id);
      const kept = prev.filter((id) => validIds.includes(id));
      // Auto-select newly added compounds
      const added = validIds.filter((id) => !prev.includes(id));
      return [...kept, ...added];
    });
  }, [compounds]);

  useEffect(() => { setCompareWells(null); setAiResult(null); setAiError(null); }, [concentrations]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const runCompare = useCallback(() => {
    if (selected.length < 2) return;
    setRunning(true); setAiResult(null); setAiError(null);
    setTimeout(() => {
      const result = {};
      selected.forEach((id) => {
        const p = compounds.find((pp) => pp.id === id);
        result[id] = simulateWells(p, concentrations, labels);
      });
      setCompareWells(result);
      setRunning(false);
    }, 700);
  }, [selected, concentrations, labels, compounds]);

  const analyzeCompare = useCallback(async () => {
    if (!keyReady) { onNeedKey(); return; }
    if (!compareWells) return;
    setAiLoading(true); setAiError(null);
    try {
      const payload = selected.map((id) => {
        const p = compounds.find((pp) => pp.id === id);
        return {
          compound: p.name,
          compoundClass: p.cls,
          wells: compareWells[id].map((w) => ({
            concentrationUM: w.label === "Ctrl" ? 0 : w.concentration,
            viabilityPercent: Number(w.viability.toFixed(1)),
          })),
        };
      });
      const parsed = await callGemini({
        max_tokens: 1200,
        system:
          "You compare several compounds tested in parallel on a simulated microfluidic organ-on-chip dose-response assay. " +
          "Respond with ONLY a valid JSON object (no markdown fences, no preamble) matching exactly this schema: " +
          '{"ranking": [{"compound": string, "ic50EstimateUM": number, "toxicityRisk": "Low"|"Moderate"|"High", "rank": number, "note": string}], ' +
          '"overallRecommendation": string}. rank 1 is the strongest candidate to advance (best efficacy/safety balance). ' +
          "note is one short clause per compound. overallRecommendation is 1-2 sentences comparing the set and naming which to prioritize.",
        content: JSON.stringify(payload),
      });
      setAiResult(parsed);
      const top = [...(parsed.ranking || [])].sort((a, b) => a.rank - b.rank)[0];
      pushHistory({
        kind: "Comparison", ts: Date.now(),
        compound: `${selected.length} compounds`,
        risk: top?.toxicityRisk || "—",
        ic50: top?.ic50EstimateUM ?? "—",
      });
    } catch (e) {
      if (e.message === "NO_KEY") setAiError("NO_KEY");
      else setAiError(e.message || "AI comparison failed — try again.");
    } finally {
      setAiLoading(false);
    }
  }, [compareWells, selected, pushHistory, keyReady, onNeedKey]);

  const chartData = useMemo(() => {
    if (!compareWells) return [];
    return concentrations.map((c, i) => {
      const point = { concentration: c };
      selected.forEach((id) => { point[id] = compareWells[id]?.[i]?.viability; });
      return point;
    });
  }, [compareWells, concentrations, selected]);

  const sortedRanking = aiResult ? [...(aiResult.ranking || [])].sort((a, b) => a.rank - b.rank) : [];

  return (
    <>
      <div className="mf-card">
        <h2><Layers size={14} /> Compounds to compare</h2>
        <div className="mf-check-row">
          {compounds.map((p) => (
            <label key={p.id} className="mf-check-item">
              <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
              <span className="mf-swatch" style={{ background: compoundColors[p.id] }} />
              {p.name}
            </label>
          ))}
          <button className="mf-btn" onClick={onAddCompound}
            style={{ fontSize: 12, padding: "5px 10px", borderColor: "var(--violet)", color: "var(--violet)" }}>
            <FlaskConical size={12} /> Add compound
          </button>
        </div>
        <button id="run-compare-btn" className="mf-btn primary" onClick={runCompare} disabled={running || selected.length < 2}>
          <Activity size={14} />
          {running
            ? <><span className="mf-spin"><RotateCw size={14} /></span> Running…</>
            : compareWells ? "Re-run comparison" : "Run comparison"}
        </button>
        {selected.length < 2 && (
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>Select at least 2 compounds.</p>
        )}
      </div>

      {compareWells && (
        <div className="mf-card" style={{ marginTop: 18 }}>
          <h2><Activity size={14} /> Overlaid dose–response</h2>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1c2740" strokeDasharray="3 3" />
              <XAxis
                dataKey="concentration" type="number" scale="log"
                domain={[concentrations[0] * 0.7, concentrations[concentrations.length - 1] * 1.4]}
                ticks={concentrations} tickFormatter={(v) => (v === concentrations[0] ? "Ctrl" : fmtConc(v))}
                stroke="#8ea0bd" fontSize={11}
              />
              <YAxis domain={[0, 100]} stroke="#8ea0bd" fontSize={11} />
              <Tooltip
                contentStyle={{ background: "#121b2e", border: "1px solid #24324d", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => (v === concentrations[0] ? "Vehicle control" : `${fmtConc(v)} µM`)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={50} stroke="#8ea0bd" strokeDasharray="4 4" />
              {selected.map((id) => (
                <Line
                  key={id} type="monotone" dataKey={id}
                  name={compounds.find((p) => p.id === id)?.name || id}
                  stroke={compoundColors[id]} strokeWidth={2.3} dot={{ r: 3 }} connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 10 }}>
            <button id="analyze-compare-btn" className="mf-btn primary" onClick={analyzeCompare} disabled={aiLoading}>
              {aiLoading
                ? <><span className="mf-spin"><RotateCw size={14} /></span> Comparing…</>
                : <><Sparkles size={14} /> Analyze with Gemini</>}
            </button>
          </div>
        </div>
      )}

      {(aiResult || aiError) && (
        <div className="mf-ai-panel">
          <h2 className="mf-mono mf-ai-h"><Sparkles size={14} color="var(--cyan)" /> Comparative AI analysis</h2>
          {aiError ? (
            <div className="mf-ai-error">
              <AlertTriangle size={16} />
              {aiError === "NO_KEY"
                ? <>No API key set. <button className="mf-btn key-btn" onClick={onNeedKey}>Add key</button></>
                : <>{aiError} <button className="mf-btn" onClick={analyzeCompare}>Retry</button></>}
            </div>
          ) : (
            <>
              <table className="mf-table mf-mono">
                <thead>
                  <tr><th>#</th><th>Compound</th><th>IC50</th><th>Risk</th><th style={{ fontFamily: "'Inter', sans-serif" }}>Note</th></tr>
                </thead>
                <tbody>
                  {sortedRanking.map((r) => (
                    <tr key={r.compound}>
                      <td>{r.rank}</td>
                      <td>{r.compound}</td>
                      <td>{r.ic50EstimateUM} µM</td>
                      <td style={{ color: riskColor(r.toxicityRisk) }}>{r.toxicityRisk}</td>
                      <td style={{ fontFamily: "'Inter', sans-serif", color: "var(--muted)" }}>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Rec>{aiResult.overallRecommendation}</Rec>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Real image upload mode (Gemini vision)
// ---------------------------------------------------------------------------
function ImageView({ pushHistory, keyReady, onNeedKey }) {
  const [file, setFile] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) { setError("Please upload an image file."); return; }
    if (f.size > 8 * 1024 * 1024) { setError("Image is too large (max ~8MB)."); return; }
    setError(null); setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      setFile({ base64, mediaType: f.type, previewUrl: dataUrl, name: f.name });
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(f);
  };

  const analyzeImage = useCallback(async () => {
    if (!keyReady) { onNeedKey(); return; }
    if (!file) return;
    setAnalyzing(true); setError(null);
    try {
      const parsed = await callGemini({
        max_tokens: 900,
        system:
          "You are analyzing an uploaded microscopy or cell-culture image for a microfluidic drug-screening dashboard. " +
          "Give a best-effort qualitative visual read only — this is not a substitute for a calibrated quantitative assay, and you should say so if relevant. " +
          "If the image does not appear to show cells, a culture well, or microscopy content, set imageLooksLikeCellCulture to false and describe what you actually see instead of inventing cell data. " +
          'Respond with ONLY a valid JSON object, no markdown fences: {"imageLooksLikeCellCulture": boolean, "cellDensity": "Low"|"Moderate"|"High"|"Unclear", ' +
          '"estimatedViabilityPercent": number|null, "morphologyNotes": string, "anomaliesDetected": string, "summary": string, "recommendation": string}',
        content: [
          { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } },
          { type: "text", text: "Analyze this image as a cell-culture microwell image from a microfluidic drug-screening chip." },
        ],
      });
      setResult(parsed);
      pushHistory({
        kind: "Image scan", ts: Date.now(),
        compound: file.name.length > 18 ? file.name.slice(0, 18) + "…" : file.name,
        risk: parsed.imageLooksLikeCellCulture ? parsed.cellDensity : "n/a",
        ic50: "—",
      });
    } catch (e) {
      if (e.message === "NO_KEY") setError("NO_KEY");
      else setError(e.message || "Image analysis failed — try again.");
    } finally {
      setAnalyzing(false);
    }
  }, [file, pushHistory, keyReady, onNeedKey]);

  return (
    <>
      <div className="mf-card">
        <h2><ImageIcon size={14} /> Real microscopy image</h2>
        <input ref={inputRef} id="image-upload-input" type="file" accept="image/*" style={{ display: "none" }} onChange={onFileChange} />
        {!file ? (
          <div
            className="mf-upload-zone" onClick={() => inputRef.current?.click()}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") inputRef.current?.click(); }}
          >
            <Upload size={22} color="var(--muted)" />
            <p>Click to upload a cell-culture or microscopy image (JPG/PNG)</p>
          </div>
        ) : (
          <>
            <img src={file.previewUrl} alt="Uploaded microscopy image" className="mf-thumb" />
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button className="mf-btn" onClick={() => { setFile(null); setResult(null); setError(null); }}>
                Choose different image
              </button>
              <button id="analyze-image-btn" className="mf-btn primary" onClick={analyzeImage} disabled={analyzing}>
                {analyzing
                  ? <><span className="mf-spin"><RotateCw size={14} /></span> Analyzing image…</>
                  : <><Sparkles size={14} /> Analyze with Gemini</>}
              </button>
            </div>
          </>
        )}
        {error && error !== "NO_KEY" && (
          <div className="mf-ai-error" style={{ marginTop: 12 }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}
        {error === "NO_KEY" && (
          <div className="mf-ai-error" style={{ marginTop: 12 }}>
            <AlertTriangle size={14} /> No API key set.
            <button className="mf-btn key-btn" onClick={onNeedKey}>Add key</button>
          </div>
        )}
      </div>

      {result && (
        <div className="mf-ai-panel">
          <h2 className="mf-mono mf-ai-h"><Sparkles size={14} color="var(--cyan)" /> Image analysis</h2>
          {!result.imageLooksLikeCellCulture && (
            <div className="mf-notice">
              <Info size={14} /> This doesn't look like a cell-culture or microscopy image — showing Gemini's raw read instead of assay stats.
            </div>
          )}
          {result.imageLooksLikeCellCulture && (
            <div className="mf-ai-readout mf-mono">
              <div className="mf-ai-stat"><span className="k">Cell density</span><span className="v">{result.cellDensity}</span></div>
              <div className="mf-ai-stat">
                <span className="k">Est. viability</span>
                <span className="v">{result.estimatedViabilityPercent != null ? `${result.estimatedViabilityPercent}%` : "—"}</span>
              </div>
            </div>
          )}
          <p className="mf-ai-text">{result.summary}</p>
          {result.morphologyNotes && (
            <p className="mf-ai-text" style={{ color: "var(--muted)" }}>{result.morphologyNotes}</p>
          )}
          {result.anomaliesDetected && result.anomaliesDetected.toLowerCase() !== "none" && (
            <p className="mf-ai-text" style={{ color: "var(--amber)" }}>
              <AlertTriangle size={12} style={{ verticalAlign: "-1px", marginRight: 5 }} />
              {result.anomaliesDetected}
            </p>
          )}
          <Rec>{result.recommendation}</Rec>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chip visual: two inlets → serpentine mixing channel → 6 wells
// ---------------------------------------------------------------------------
function ChipSVG({ wells }) {
  const levels = [
    { y: 30, nodes: [290, 380] },
    { y: 70, nodes: [245, 335, 425] },
    { y: 110, nodes: [200, 290, 380, 470] },
    { y: 150, nodes: [155, 245, 335, 425, 515] },
    { y: 190, nodes: [110, 200, 290, 380, 470, 560] },
  ];

  const pipe = (x1, y1, x2, y2) => {
    const midY = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
  };

  return (
    <svg className="mf-chip-svg" viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" aria-label="Microfluidic chip diagram">
      <defs>
        <linearGradient id="mixGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="10%" stopColor="var(--amber)" />
          <stop offset="50%" stopColor="#8ea0bd" />
          <stop offset="90%" stopColor="var(--cyan)" />
        </linearGradient>
      </defs>

      {/* Inlets */}
      <circle cx="290" cy="18" r="12" fill="var(--amber)" opacity="0.85" />
      <text x="290" y="6" textAnchor="middle" className="mf-well-label">DRUG</text>
      <circle cx="380" cy="18" r="12" fill="var(--cyan)" opacity="0.85" />
      <text x="380" y="6" textAnchor="middle" className="mf-well-label">MEDIA</text>

      {/* Tree mixer structural pipes */}
      {levels.slice(0, 4).map((lvl, i) =>
        lvl.nodes.map((nx, j) => (
          <g key={`bg-${i}-${j}`}>
            <path d={pipe(nx, lvl.y, levels[i+1].nodes[j], levels[i+1].y)} stroke="var(--line)" strokeWidth="7" fill="none" strokeLinecap="round" />
            <path d={pipe(nx, lvl.y, levels[i+1].nodes[j+1], levels[i+1].y)} stroke="var(--line)" strokeWidth="7" fill="none" strokeLinecap="round" />
          </g>
        ))
      )}

      {/* Tree mixer fluid animation */}
      {levels.slice(0, 4).map((lvl, i) =>
        lvl.nodes.map((nx, j) => (
          <g key={`flow-${i}-${j}`}>
            <path className={wells ? "mf-flow" : ""} d={pipe(nx, lvl.y, levels[i+1].nodes[j], levels[i+1].y)} stroke="url(#mixGrad)" strokeWidth="3" fill="none" strokeLinecap="round" opacity={wells ? "0.9" : "0"} />
            <path className={wells ? "mf-flow" : ""} d={pipe(nx, lvl.y, levels[i+1].nodes[j+1], levels[i+1].y)} stroke="url(#mixGrad)" strokeWidth="3" fill="none" strokeLinecap="round" opacity={wells ? "0.9" : "0"} />
          </g>
        ))
      )}
      
      <text x="335" y="100" textAnchor="middle" className="mf-well-label" fill="var(--muted)">CHRISTMAS TREE MIXER</text>

      {/* Vertical drops into wells */}
      {levels[4].nodes.map((x, i) => (
        <path key={`drop-${i}`} d={`M${x},190 V240`} stroke="var(--line)" strokeWidth="7" fill="none" strokeLinecap="round" />
      ))}
      {levels[4].nodes.map((x, i) => (
        <path key={`drop-flow-${i}`} className={wells ? "mf-flow" : ""} d={`M${x},190 V240`} stroke="url(#mixGrad)" strokeWidth="3" fill="none" strokeLinecap="round" opacity={wells ? "0.9" : "0"} />
      ))}

      {/* Wells */}
      {levels[4].nodes.map((x, i) => {
        const w = wells ? wells[i] : null;
        return (
          <g key={x}>
            <circle cx={x} cy="290" r="34" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="2.5" />
            {DOT_OFFSETS.map(([dx, dy], j) => {
              let fill = "var(--muted)";
              if (w) fill = j < w.deadDots ? "var(--coral)" : "var(--cyan)";
              return (
                <circle key={j} className="mf-dot-cell"
                  cx={x + dx} cy={290 + dy} r="2.6"
                  fill={fill} opacity={w ? 0.9 : 0.3}
                />
              );
            })}
            <text x={x} y="342" textAnchor="middle" className="mf-well-label">
              {w ? `${w.label}µM` : "—"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
