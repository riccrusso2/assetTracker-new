// App.js — Portfolio Tracker — Production-ready, no default data
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line,
  Legend, AreaChart, Area, ReferenceLine,
} from "recharts";
import {
  RefreshCw, TrendingUp, TrendingDown, PieChart as PieChartIcon,
  BarChart2, LineChart as LineChartIcon, Target, Info, Trash2,
  Edit2, Moon, Sun, Download, Search, X, AlertTriangle,
  Activity, LayoutDashboard, Briefcase, Plus, CheckCircle,
  Shield, ChevronUp, ChevronDown, Wallet, Camera, Upload,
  Settings, Tag,
} from "lucide-react";
import "./styles.css";
import {
  r2, isTotalTargetAsset, calcRebalancingTwoLevel, calcGrowthAttribution,
} from "./rebalance";

// ====================== CONSTANTS ======================
const STORAGE_KEYS = {
  ASSETS:        "pf.assets.v6",
  STARTUP:       "pf.startup.v3",
  GOLD_ETF:      "pf.goldetf.v1",
  PHYS_GOLD:     "pf.physgold.v1",
  DARK_MODE:     "pf.dark.v1",
  CASH:          "pf.cash.v2",
  ASSET_CLASSES: "pf.assetclasses.v1",
};

const CONFIG_VERSION  = 3;
const AUTO_REFRESH_MS = 900_000; // 15 min
const STARTUP_ABBONAMENTO = 468;

const MONTH_LABELS_IT = [
  "Gen","Feb","Mar","Apr","Mag","Giu",
  "Lug","Ago","Set","Ott","Nov","Dic",
];

const DEFAULT_ASSET_CLASSES = [
  "ETF", "Azione", "Commodity", "Crypto", "Bond", "Altro",
];

const GOLD_ETF_DEFAULT = {
  id: "gold-etf",
  name: "Physical Gold USD (Acc)",
  identifier: "",
  quantity: 0,
  costBasis: 0,
  lastPrice: null,
  lastUpdated: null,
  targetWeight: 0,
  assetClass: "Oro",
  manual: false,
};

const PHYS_GOLD_DEFAULT = {
  grams: 0,
  pricePerGram18kt: null,
  lastUpdated: null,
  manualOverride: false,
};

// ====================== UTILITIES ======================
const fmt = (n, compact = false) => {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    if (compact && Math.abs(n) >= 10_000) {
      return new Intl.NumberFormat("it-IT", {
        style: "currency", currency: "EUR",
        notation: "compact", maximumFractionDigits: 1,
      }).format(n);
    }
    return new Intl.NumberFormat("it-IT", {
      style: "currency", currency: "EUR", maximumFractionDigits: 2,
    }).format(n);
  } catch { return n.toFixed(2) + " €"; }
};

const fmtPct = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const isISIN  = (v) => /^[A-Z0-9]{12}$/i.test((v || "").trim());
const uid     = ()  => Math.random().toString(36).slice(2, 10);

const ls = {
  get: (key, def) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  set: (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// ====================== RISK METRICS ======================
const calcCAGR = (history) => {
  if (history.length < 2) return null;
  const years = (new Date(history.at(-1).t) - new Date(history[0].t)) / (365.25 * 864e5);
  if (years <= 0 || history[0].v <= 0) return null;
  return Math.pow(history.at(-1).v / history[0].v, 1 / years) - 1;
};

const calcReturns = (history) => {
  const r = [];
  for (let i = 1; i < history.length; i++)
    r.push((history[i].v - history[i - 1].v) / history[i - 1].v);
  return r;
};

const calcVolatility = (history) => {
  const r = calcReturns(history);
  if (r.length < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
  return Math.sqrt(variance * 12);
};

const calcMaxDrawdown = (history) => {
  let peak = -Infinity, mdd = 0;
  for (const h of history) {
    if (h.v > peak) peak = h.v;
    const dd = (h.v - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
};

const calcSharpe = (history, rf = 0.03) => {
  const cagr = calcCAGR(history);
  const vol  = calcVolatility(history);
  if (cagr == null || vol == null || vol === 0) return null;
  return (cagr - rf) / vol;
};

const calcSortino = (history, rf = 0.03) => {
  const r = calcReturns(history);
  if (r.length < 2) return null;

  const meanAnn = (r.reduce((a, b) => a + b, 0) / r.length) * 12;
  const neg = r.filter((x) => x < 0);
  if (!neg.length) return null;

  const downDev = Math.sqrt(
    (neg.reduce((a, b) => a + b ** 2, 0) / neg.length) * 12
  );

  if (downDev === 0) return null;
  return (meanAnn - rf) / downDev;
};

// ====================== SNAPSHOT HELPERS ======================
const buildChartData = (snapshots) => {
  if (!snapshots.length) return { data: [], assetIds: [] };
  const base = snapshots[0];
  const baseTotal = base.totalValue || 1;
  const baseByAssetId = {};
  (base.assets || []).forEach((a) => { baseByAssetId[a.id] = a.price || 1; });
  const assetIdSet = new Set();
  snapshots.forEach((s) => (s.assets || []).forEach((a) => assetIdSet.add(a.id)));
  const assetIds = [...assetIdSet];
  const data = snapshots.map((snap) => {
    const point = { label: snap.label };
    point["__total__"] = r2(((snap.totalValue || 0) / baseTotal) * 100);
    (snap.assets || []).forEach((a) => {
      const b = baseByAssetId[a.id] || a.price || 1;
      point[a.id] = r2(((a.price || 0) / b) * 100);
    });
    return point;
  });
  return { data, assetIds };
};

// ====================== CALCULATIONS ======================
const calcTotals = (assets, goldEtf) => {
  let val = 0, cost = 0;

  for (const a of assets) {
    if (a.lastPrice && a.quantity) val += a.lastPrice * a.quantity;
    if (a.costBasis && a.quantity) cost += a.costBasis * a.quantity;
  }

  if (goldEtf && goldEtf.lastPrice && goldEtf.quantity) {
    val += goldEtf.lastPrice * goldEtf.quantity;
  }

  if (goldEtf && goldEtf.costBasis && goldEtf.quantity) {
    cost += goldEtf.costBasis * goldEtf.quantity;
  }

  const ret = cost > 0 ? (val - cost) / cost : 0;

  const perfs = assets
    .filter((a) => a.lastPrice && a.costBasis)
    .map((a) => ({
      id: a.id,
      name: a.name,
      perf: (a.lastPrice - a.costBasis) / a.costBasis,
    }));

  if (goldEtf && goldEtf.lastPrice && goldEtf.costBasis && goldEtf.quantity) {
    perfs.push({
      id: goldEtf.id,
      name: goldEtf.name,
      perf: (goldEtf.lastPrice - goldEtf.costBasis) / goldEtf.costBasis,
    });
  }

  const best = perfs.length ? perfs.reduce((p, c) => (c.perf > p.perf ? c : p)) : null;
  const worst = perfs.length ? perfs.reduce((p, c) => (c.perf < p.perf ? c : p)) : null;

  return { val, cost, ret, best, worst };
};

const calcClassDist = (assets) => {
  const map = {};
  for (const a of assets) {
    const v = a.lastPrice ? a.lastPrice * (a.quantity || 0) : 0;
    if (v > 0) map[a.assetClass] = (map[a.assetClass] || 0) + v;
  }
  return Object.entries(map).map(([name, value]) => ({ name, value: r2(value) }));
};

const calcProjectionScenarios = (start, monthly, baseReturn, years) => {
  const pessimistic = Math.max(baseReturn - 3, 0);
  const optimistic  = baseReturn + 3;
  const m = baseReturn / 100 / 12, mp = pessimistic / 100 / 12, mo = optimistic / 100 / 12;
  const months = years * 12;
  const data = [];
  let vb = start, vp = start, vo = start;
  for (let i = 0; i <= months; i++) {
    if (i % 12 === 0) data.push({ year: i / 12, base: r2(vb), pessimistic: r2(vp), optimistic: r2(vo) });
    if (i < months) {
      vb = vb * (1 + m)  + monthly;
      vp = vp * (1 + mp) + monthly;
      vo = vo * (1 + mo) + monthly;
    }
  }
  return data;
};

const exportCSV = (assets) => {
  const header = "Nome,ISIN,Quantità,Prezzo Acquisto,Prezzo Attuale,Valore,Perf €,Perf %,Asset Class";
  const rows = assets.map((a) => {
    const v    = a.lastPrice ? r2(a.lastPrice * (a.quantity || 0)) : 0;
    const pE   = a.costBasis && a.lastPrice ? r2((a.lastPrice - a.costBasis) * (a.quantity || 0)) : 0;
    const pPct = a.costBasis && a.lastPrice ? r2(((a.lastPrice - a.costBasis) / a.costBasis) * 100) : 0;
    return [a.name, a.identifier || "", a.quantity || 0, a.costBasis || 0,
      a.lastPrice || 0, v, pE, pPct + "%", a.assetClass || ""].join(",");
  });
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `portfolio_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

// ====================== COLORS ======================
const PALETTE = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6",
                 "#14b8a6","#f97316","#22c55e","#e879f9","#60a5fa",
                 "#a78bfa","#fb923c","#34d399","#f472b6","#38bdf8"];

const TOTAL_LINE_COLOR       = "#ffffff";
const TOTAL_LINE_COLOR_LIGHT = "#1e293b";

// ====================== COMPONENTS ======================

const Badge = ({ value, suffix = "%" }) => {
  const pos = value >= 0;
  return (
    <span className={`badge ${pos ? "badge-pos" : "badge-neg"}`}>
      {pos ? "+" : ""}{typeof value === "number" ? value.toFixed(2) : value}{suffix}
    </span>
  );
};

const KpiCard = ({ label, value, sub, icon: Icon, trend, color = "blue", compact = false }) => (
  <div className={`kpi-card kpi-${color}`}>
    <div className="kpi-top">
      <span className="kpi-label">{label}</span>
      {Icon && <Icon className="kpi-icon" />}
    </div>
    <div className={`kpi-value ${compact ? "kpi-compact" : ""}`}>{value}</div>
    {sub && <div className="kpi-sub">{sub}</div>}
    {trend != null && (
      <div className={`kpi-trend ${trend >= 0 ? "pos" : "neg"}`}>
        {trend >= 0 ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
        {Math.abs(trend).toFixed(2)}%
      </div>
    )}
  </div>
);

const RiskCard = ({ label, value, fmt: fmtFn, tooltip, quality }) => {
  const display = value == null ? "—" : (fmtFn ? fmtFn(value) : value);
  const qualColor = quality === "good" ? "var(--green)" : quality === "bad" ? "var(--red)" : "var(--text-muted)";
  return (
    <div className="risk-card" title={tooltip}>
      <div className="risk-label">{label}</div>
      <div className="risk-value" style={{ color: qualColor }}>{display}</div>
    </div>
  );
};

const EmptyState = ({ icon: Icon, title, description, action }) => (
  <div className="empty-state">
    <div className="empty-icon"><Icon size={28} /></div>
    <div className="empty-title">{title}</div>
    <div className="empty-desc">{description}</div>
    {action && <div style={{ marginTop: 16 }}>{action}</div>}
  </div>
);

// ---- Asset Class Manager Modal ----
const AssetClassModal = ({ classes, onSave, onClose }) => {
  const [list, setList] = useState([...classes]);
  const [newName, setNewName] = useState("");
  const [editIdx, setEditIdx] = useState(null);
  const [editVal, setEditVal] = useState("");

  const addNew = () => {
    const trimmed = newName.trim();
    if (!trimmed || list.includes(trimmed)) return;
    setList([...list, trimmed]);
    setNewName("");
  };

  const startEdit = (i) => { setEditIdx(i); setEditVal(list[i]); };
  const saveEdit  = () => {
    if (!editVal.trim()) return;
    const next = [...list];
    next[editIdx] = editVal.trim();
    setList(next);
    setEditIdx(null);
    setEditVal("");
  };
  const remove = (i) => setList(list.filter((_, idx) => idx !== i));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3><Tag size={16} style={{ marginRight: 8 }}/>Gestisci Asset Class</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body" style={{ gap: 8, maxHeight: 360, overflowY: "auto" }}>
          {list.map((cls, i) => (
            <div key={i} className="ac-row">
              {editIdx === i ? (
                <>
                  <input className="field-input" style={{ flex: 1 }} value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveEdit()} autoFocus/>
                  <button className="btn btn-primary" style={{ padding: "6px 12px" }} onClick={saveEdit}><CheckCircle size={14}/></button>
                  <button className="btn btn-ghost" style={{ padding: "6px 12px" }} onClick={() => setEditIdx(null)}><X size={14}/></button>
                </>
              ) : (
                <>
                  <span className="ac-name">{cls}</span>
                  <button className="icon-btn" onClick={() => startEdit(i)}><Edit2 size={13}/></button>
                  <button className="icon-btn danger" onClick={() => remove(i)}><Trash2 size={13}/></button>
                </>
              )}
            </div>
          ))}
          <div className="ac-row" style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <input className="field-input" style={{ flex: 1 }} placeholder="Nuova asset class…"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNew()}/>
            <button className="btn btn-primary" style={{ padding: "6px 12px" }} onClick={addNew}>
              <Plus size={14}/> Aggiungi
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={() => { onSave(list); onClose(); }}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal ETF / Asset ----
const AssetModal = ({ asset, assetClasses, onSave, onClose }) => {
  const [form, setForm] = useState(asset || {
    name: "", identifier: "", quantity: "", costBasis: "",
    targetWeight: "", assetClass: assetClasses[0] || "ETF", currency: "EUR",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (!form.name || !form.quantity || !form.costBasis) return;
    onSave({
      ...form,
      id:           form.id || uid(),
      quantity:     parseFloat(form.quantity)     || 0,
      costBasis:    parseFloat(form.costBasis)    || 0,
      targetWeight: parseFloat(form.targetWeight) || 0,
      targetOnTotal: form.targetOnTotal ?? form.assetClass === "Crypto",
      lastPrice:    form.lastPrice ?? null,
      lastUpdated:  form.lastUpdated ?? null,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{asset?.id ? "Modifica asset" : "Aggiungi asset"}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          {[
            { label: "Nome *",                  key: "name",         type: "text" },
            { label: "ISIN / Ticker",           key: "identifier",   type: "text" },
            { label: "Quantità *",              key: "quantity",     type: "number" },
            { label: "Prezzo medio carico (€) *", key: "costBasis",  type: "number" },
            { label: "Peso target (%)",         key: "targetWeight", type: "number" },
          ].map(({ label, key, type }) => (
            <label key={key} className="field-label">
              {label}
              <input type={type} value={form[key] ?? ""} onChange={(e) => set(key, e.target.value)}
                className="field-input" step="any"/>
            </label>
          ))}
          <label className="field-label">
            Asset Class
            <select value={form.assetClass} onChange={(e) => set("assetClass", e.target.value)} className="field-input">
              {assetClasses.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="field-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" style={{ width: "auto" }}
              checked={form.targetOnTotal ?? form.assetClass === "Crypto"}
              onChange={(e) => set("targetOnTotal", e.target.checked)}/>
            Target in % del patrimonio totale (come l'oro)
          </label>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Se inserisci un ISIN valido, il prezzo sarà aggiornato automaticamente via JustETF.
            {" "}Con la spunta attiva, il peso target è calcolato sull'intero patrimonio (liquidità, ETF, startup, oro) invece che sul solo sotto-portafoglio ETF — utile per Bitcoin.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!form.name || !form.quantity || !form.costBasis}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Startup ----
const StartupModal = ({ startup, onSave, onClose }) => {
  const [form, setForm] = useState(startup || { name: "", invested: "", fee: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const handleSave = () => {
    if (!form.name || !form.invested) return;
    onSave({ id: form.id || uid(), name: form.name,
      invested: parseFloat(form.invested) || 0, fee: parseFloat(form.fee) || 0 });
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{startup?.id ? "Modifica startup" : "Aggiungi startup"}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <label className="field-label">Nome *
            <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Importo investito (€) *
            <input type="number" step="any" value={form.invested} onChange={(e) => set("invested", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Commissioni (€)
            <input type="number" step="any" value={form.fee} onChange={(e) => set("fee", e.target.value)} className="field-input"/>
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!form.name || !form.invested}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Gold ETF ----
const GoldEtfModal = ({ goldEtf, onSave, onClose }) => {
  const [form, setForm] = useState({ ...goldEtf });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => {
    onSave({
      ...form,
      quantity:     parseFloat(form.quantity)     || 0,
      costBasis:    parseFloat(form.costBasis)    || 0,
      targetWeight: parseFloat(form.targetWeight) || 0,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>⚙️ Configura ETF Oro quotato</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <label className="field-label">Nome
            <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">ISIN *
            <input type="text" value={form.identifier} onChange={(e) => set("identifier", e.target.value.toUpperCase())}
              className="field-input" placeholder="es. IE00B4ND3602"/>
          </label>
          <label className="field-label">Quantità (quote)
            <input type="number" step="any" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Prezzo medio carico (€/quota)
            <input type="number" step="any" value={form.costBasis} onChange={(e) => set("costBasis", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Peso target (%)
            <input type="number" step="any" value={form.targetWeight} onChange={(e) => set("targetWeight", e.target.value)} className="field-input"/>
          </label>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Il prezzo viene aggiornato automaticamente via JustETF usando l'ISIN inserito.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Physical Gold ----
// No cost basis — only grams and optional manual price override
const PhysGoldModal = ({ physGold, onSave, onClose }) => {
  const [form, setForm] = useState({ ...physGold });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => {
  if (!form.grams) return;

  const hasManualPrice =
    form.pricePerGram18kt !== "" && form.pricePerGram18kt != null;

  onSave({
    grams: parseFloat(form.grams) || 0,
    pricePerGram18kt: hasManualPrice
      ? parseFloat(form.pricePerGram18kt) || null
      : null,
    lastUpdated: physGold.lastUpdated ?? null,
    manualOverride: hasManualPrice,
  });

  onClose();
};

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🔶 Oro fisico 18kt</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <label className="field-label">Grammatura totale (g) *
            <input type="number" step="any" min="0" value={form.grams}
              onChange={(e) => set("grams", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">
            Prezzo 18kt manuale (€/g)
            <input type="number" step="any" min="0"
              value={form.pricePerGram18kt ?? ""}
              onChange={(e) => set("pricePerGram18kt", e.target.value)}
              className="field-input" placeholder="Lascia vuoto per aggiornamento automatico"/>
          </label>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Il prezzo 18kt viene aggiornato automaticamente tramite <strong>gold-api.com</strong>:<br/>
            <code style={{ fontSize: 11 }}>prezzo spot (€/oz) ÷ 31,1035 × 0,75</code><br/>
            Inserisci un valore manuale solo per sovrascrivere il fetch automatico.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!form.grams}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Custom Tooltip ----
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="tooltip-row">
          <span style={{ color: p.color }}>{p.name}</span>
          <span>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const SnapshotTooltip = ({ active, payload, label, snapshots }) => {
  if (!active || !payload?.length) return null;
  const snap = snapshots.find((s) => s.label === label);
  return (
    <div className="chart-tooltip" style={{ minWidth: 200, maxHeight: 320, overflowY: "auto" }}>
      <div className="tooltip-label">{label}</div>
      {payload.map((p, i) => {
        if (p.dataKey === "__total__") return (
          <div key={i} className="tooltip-row">
            <span style={{ color: p.color, fontWeight: 700 }}>Portafoglio</span>
            <span style={{ fontWeight: 700 }}>{p.value?.toFixed(1)} <span style={{ color: "var(--text-muted)", fontSize: 11 }}>({snap ? fmt(snap.totalValue) : ""})</span></span>
          </div>
        );
        const assetSnap = snap?.assets?.find((a) => a.id === p.dataKey);
        return (
          <div key={i} className="tooltip-row">
            <span style={{ color: p.color }}>{p.name}</span>
            <span>{p.value?.toFixed(1)} <span style={{ color: "var(--text-muted)", fontSize: 11 }}>({assetSnap ? fmt(assetSnap.value) : ""})</span></span>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Indice 100 = primo snapshot</div>
    </div>
  );
};

// ====================== HOOKS ======================
const useLS = (key, init) => {
  const [v, setV] = useState(() => ls.get(key, init));
  useEffect(() => ls.set(key, v), [key, v]);
  return [v, setV];
};

const usePriceFetcher = () => {
  const [loading, setLoading] = useState({});
  const [error,   setError]   = useState(null);
  const fetchOne = useCallback(async (a) => {
    setLoading((s) => ({ ...s, [a.id]: true }));
    setError(null);
    try {
      if (a.manual) return { price: a.lastPrice, ts: Date.now() };
      const isin = (a.identifier || "").trim();
      if (!isISIN(isin)) throw new Error(`ISIN non valido: ${isin}`);
      const res  = await fetch(`/api/quote?isin=${encodeURIComponent(isin)}`);
      if (!res.ok) throw new Error(`Errore fetch: ${res.status}`);
      const data = await res.json();
      if (!data.latestQuote?.raw) throw new Error(`Nessun dato per ${isin}`);
      return { price: parseFloat(data.latestQuote.raw), ts: Date.now() };
    } catch (e) {
      setError(e.message);
      return { price: null };
    } finally {
      setLoading((s) => { const c = { ...s }; delete c[a.id]; return c; });
    }
  }, []);
  return { fetchOne, loading, error };
};

// ====================== TABS ======================
const TABS = [
  { id: "overview",    label: "Overview",        icon: LayoutDashboard },
  { id: "portfolio",   label: "Portafoglio",     icon: Briefcase },
  { id: "projection",  label: "Proiezione",      icon: LineChartIcon },
  { id: "rebalancing", label: "Ribilanciamento", icon: Target },
];

// ====================== MAIN APP ======================
export default function App() {
  // ---- State ----
  const [dark,         setDark]    = useLS(STORAGE_KEYS.DARK_MODE, true);
  const [assets,       setAssets]  = useLS(STORAGE_KEYS.ASSETS, []);
  const [startups,     setSU]      = useLS(STORAGE_KEYS.STARTUP, []);
  const [totalCash,    setCash]    = useLS(STORAGE_KEYS.CASH, 0);
  const [assetClasses, setAC]      = useLS(STORAGE_KEYS.ASSET_CLASSES, DEFAULT_ASSET_CLASSES);
  const [goldEtf,      setGoldEtf] = useLS(STORAGE_KEYS.GOLD_ETF, GOLD_ETF_DEFAULT);
  const [physGold,     setPhysGold]= useLS(STORAGE_KEYS.PHYS_GOLD, PHYS_GOLD_DEFAULT);

  const [snapshots,      setSnapshots]    = useState([]);
  const [snapshotSaving, setSnapSaving]   = useState(false);
  const [snapshotMsg,    setSnapMsg]      = useState(null);

  const [hiddenLines,  setHiddenLines]  = useState(new Set());
  const [tab,          setTab]          = useState("overview");
  const [search,       setSearch]       = useState("");

  const [assetModal,    setAssetModal]   = useState(null);
  const [startupModal,  setStartupModal] = useState(null);
  const [goldEtfModal,  setGoldEtfModal] = useState(false);
  const [physGoldModal, setPhysGoldModal]= useState(false);
  const [acModal,       setACModal]      = useState(false);
  const [editCash,      setEditCash]     = useState(false);
  const [cashInput,     setCashInput]    = useState("");
  const [configMsg,     setConfigMsg]    = useState(null);

  const [projYears,   setProjY] = useState(10);
  const [projReturn,  setProjR] = useState(7);
  const [projMonthly, setProjM] = useState(500);
  const [monthBudget, setBudget] = useState(500);

  const [goldLoading,  setGoldLoading]  = useState(false);
  const [goldPriceErr, setGoldPriceErr] = useState(null);
  

  const { fetchOne, loading, error } = usePriceFetcher();
  const assetsRef  = useRef(assets);
  const goldEtfRef = useRef(goldEtf);
  useEffect(() => { assetsRef.current  = assets;  }, [assets]);
  useEffect(() => { goldEtfRef.current = goldEtf; }, [goldEtf]);

  // Dark mode
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);

  // Load snapshots from server
  useEffect(() => {
    fetch("/api/snapshots")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setSnapshots(data); })
      .catch(() => {});
  }, []);

  // ---- Config: il server è la fonte di verità ----
  // Al mount carica data/config.json; localStorage resta cache di fallback
  // (es. server irraggiungibile). Niente più import/export manuale.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [lastSaved,    setLastSaved]    = useState(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg && Array.isArray(cfg.assets)) {
          setAssets(cfg.assets);
          if (Array.isArray(cfg.startups))       setSU(cfg.startups);
          if (typeof cfg.totalCash === "number") setCash(cfg.totalCash);
          if (Array.isArray(cfg.assetClasses))   setAC(cfg.assetClasses);
          if (cfg.goldEtf)  setGoldEtf(cfg.goldEtf);
          if (cfg.physGold) setPhysGold(cfg.physGold);
        }
      })
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Gold spot price fetch ----
  // Calls /api/gold-price which proxies gold-api.com XAU/EUR
  // Backend returns: { spotEurPerTroyOz, spotEurPerGram, price18ktPerGram, updatedAt }
  const fetchGoldSpotPrice = useCallback(async () => {
  const res = await fetch("/api/gold-price");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  let price18kt = null;
  if (typeof data.price18ktPerGram === "number") {
    price18kt = data.price18ktPerGram;
  } else if (typeof data.spotEurPerGram === "number") {
    price18kt = r2(data.spotEurPerGram * 0.75);
  } else if (typeof data.spotEurPerTroyOz === "number") {
    price18kt = r2((data.spotEurPerTroyOz / 31.1035) * 0.75);
  } else {
    throw new Error("Formato risposta /api/gold-price non valido");
  }

  setPhysGold((prev) => ({
    ...prev,
    pricePerGram18kt:
      prev.pricePerGram18kt != null && prev.lastUpdated && prev.manualOverride
        ? prev.pricePerGram18kt
        : r2(price18kt),
    lastUpdated: data.updatedAt ?? new Date().toISOString(),
  }));
}, []);

const refreshGoldPrices = useCallback(async () => {
  setGoldLoading(true);
  setGoldPriceErr(null);
  try {
    const tasks = [];

    const etf = goldEtfRef.current;
    if (etf?.identifier && isISIN(etf.identifier)) {
      tasks.push(
        fetchOne(etf).then((res) => {
          if (res.price != null) {
            setGoldEtf((prev) => ({
              ...prev,
              lastPrice: res.price,
              lastUpdated: new Date().toISOString(),
            }));
          }
        }).catch(() => {})
      );
    }

    tasks.push(
      fetchGoldSpotPrice().catch((e) => {
        setGoldPriceErr(`Prezzo spot non disponibile: ${e.message}`);
      })
    );

    await Promise.all(tasks);
  } finally {
    setGoldLoading(false);
  }
}, [fetchOne, fetchGoldSpotPrice]);

  // ---- Derived ----
  const totals = useMemo(() => calcTotals(assets, goldEtf), [assets, goldEtf]);
  const assetTotals = useMemo(() => calcTotals(assets, null), [assets]);

  // Split: asset con target sul patrimonio totale (es. Bitcoin) vs ETF classici
  const etfAssets = useMemo(() => assets.filter((a) => !isTotalTargetAsset(a)), [assets]);
  const totalTargetAssets = useMemo(() => assets.filter(isTotalTargetAsset), [assets]);
  const etfSubTotal = useMemo(
    () => etfAssets.reduce((s, a) => s + (a.lastPrice || 0) * (a.quantity || 0), 0),
    [etfAssets]);

  const classDist = useMemo(() => calcClassDist(assets), [assets]);
  const goldEtfValue = useMemo(() =>
    (goldEtf.lastPrice && goldEtf.quantity) ? r2(goldEtf.lastPrice * goldEtf.quantity) : 0,
    [goldEtf]);
  const goldEtfCost = useMemo(() =>
    (goldEtf.costBasis && goldEtf.quantity) ? r2(goldEtf.costBasis * goldEtf.quantity) : 0,
    [goldEtf]);
  const goldEtfPerfE = useMemo(() =>
    goldEtf.lastPrice && goldEtf.costBasis && goldEtf.quantity
      ? r2((goldEtf.lastPrice - goldEtf.costBasis) * goldEtf.quantity)
      : 0,
    [goldEtf]
  );
  const goldEtfPerfPct = useMemo(() =>
    goldEtf.lastPrice && goldEtf.costBasis
      ? r2(((goldEtf.lastPrice - goldEtf.costBasis) / goldEtf.costBasis) * 100)
      : 0,
    [goldEtf]
  );

  // Physical gold: value only (no cost basis, no performance)
  const physGoldValue = useMemo(() =>
    (physGold.pricePerGram18kt && physGold.grams) ? r2(physGold.pricePerGram18kt * physGold.grams) : 0,
    [physGold]);

  const goldTotal = goldEtfValue + physGoldValue;

  const suTotal    = useMemo(() => startups.reduce((a, s) => a + (s.invested || 0), 0), [startups]);
  const suFees     = useMemo(() => startups.reduce((a, s) => a + (s.fee || 0), 0), [startups]);
  const suAbbonamenti = STARTUP_ABBONAMENTO;
  const grandTotal = totals.val + totalCash + physGoldValue + suTotal;

  const fullClassDist = useMemo(() => {
    const base = [...classDist];
    if (suTotal    > 0) base.push({ name: "Startup",    value: r2(suTotal) });
    if (goldTotal  > 0) base.push({ name: "Oro",        value: r2(goldTotal) });
    if (totalCash  > 0) base.push({ name: "Liquidità",  value: r2(totalCash) });
    return base;
  }, [classDist, suTotal, goldTotal, totalCash]);

  // Drift a due livelli:
  // - ETF: peso effettivo vs sotto-portafoglio ETF (senza oro né asset a target totale)
  // - Oro / Bitcoin: peso effettivo vs grandTotal (intero patrimonio)
  const drift = useMemo(() => {
    const etfDrift = etfAssets.reduce((acc, a) => {
      const v = (a.lastPrice || 0) * (a.quantity || 0);
      const actual = etfSubTotal > 0 ? (v / etfSubTotal) * 100 : 0;
      return acc + Math.abs(actual - (a.targetWeight || 0));
    }, 0);
    const goldActual = grandTotal > 0 ? ((goldEtfValue + physGoldValue) / grandTotal) * 100 : 0;
    const goldDrift  = goldEtf.identifier ? Math.abs(goldActual - (goldEtf.targetWeight || 0)) : 0;
    const ttDrift = totalTargetAssets.reduce((acc, a) => {
      const v = (a.lastPrice || 0) * (a.quantity || 0);
      const actual = grandTotal > 0 ? (v / grandTotal) * 100 : 0;
      return acc + Math.abs(actual - (a.targetWeight || 0));
    }, 0);
    return etfDrift + goldDrift + ttDrift;
  }, [etfAssets, totalTargetAssets, etfSubTotal, goldEtfValue, physGoldValue, grandTotal, goldEtf]);

  // Livello 1: oro (ETF + fisico) + asset a target totale (Bitcoin, …)
  const rebalanceTwoLevel = useMemo(() => {
    const items = [];
    if (goldEtf.identifier && goldEtf.lastPrice) {
      items.push({
        id: goldEtf.id, name: goldEtf.name, kind: "gold",
        targetPct: goldEtf.targetWeight || 0,
        currentVal: goldEtfValue + physGoldValue,
        price: goldEtf.lastPrice,
      });
    }
    totalTargetAssets.forEach((a) => {
      if (!a.lastPrice) return;
      items.push({
        id: a.id, name: a.name, kind: "asset",
        targetPct: a.targetWeight || 0,
        currentVal: a.lastPrice * (a.quantity || 0),
        price: a.lastPrice,
      });
    });
    return calcRebalancingTwoLevel(etfAssets, items, grandTotal, etfSubTotal, monthBudget);
  }, [etfAssets, totalTargetAssets, goldEtf, goldEtfValue, physGoldValue, grandTotal, etfSubTotal, monthBudget]);

  const projData = useMemo(() => calcProjectionScenarios(grandTotal, projMonthly, projReturn, projYears),
    [grandTotal, projMonthly, projReturn, projYears]);

  const finalVal     = projData.at(-1)?.base ?? 0;
  const totalContrib = grandTotal + projMonthly * 12 * projYears;
  const projGain     = finalVal - totalContrib;
  const projROI      = totalContrib > 0 ? (projGain / totalContrib) * 100 : 0;

  const histForRisk = useMemo(() =>
  snapshots.map((s) => ({
    t: `${s.year}-${String(s.month).padStart(2, "0")}-01`,  // ← sempre mese/anno
    v: s.totalValue,
  })),
  [snapshots]);

  const riskMetrics = useMemo(() => ({
    cagr:    calcCAGR(histForRisk),
    vol:     calcVolatility(histForRisk),
    mdd:     calcMaxDrawdown(histForRisk),
    sharpe:  calcSharpe(histForRisk),
    sortino: calcSortino(histForRisk),
  }), [histForRisk]);

  const { data: snapshotChartData, assetIds } = useMemo(() => buildChartData(snapshots), [snapshots]);

  const growthAttribution = useMemo(() => calcGrowthAttribution(snapshots), [snapshots]);
  const growthTotals = useMemo(() => ({
    contrib: r2(growthAttribution.reduce((a, x) => a + x.contrib, 0)),
    market:  r2(growthAttribution.reduce((a, x) => a + x.market, 0)),
  }), [growthAttribution]);

  const assetNameMap = useMemo(() => {
  const m = {};
  assets.forEach((a) => {
    m[a.id] = a.chartLabel || a.name.split(" ").slice(0, 3).join(" ");
  });

  if (goldEtf.identifier) {
    m[goldEtf.id] = goldEtf.name.split(" ").slice(0, 3).join(" ");
  }

  return m;
}, [assets, goldEtf]);

  const filteredAssets = useMemo(() =>
    search.trim()
      ? assets.filter((a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          (a.identifier || "").toLowerCase().includes(search.toLowerCase()))
      : assets,
    [assets, search]);

  // ---- Actions ----
  const fetchAllPrices = useCallback(async () => {
    const tasks = [];

    // Regular assets
    if (assetsRef.current?.length) {
      tasks.push(
        Promise.all(
          assetsRef.current.map(async (a) => {
            const res = await fetchOne(a);
            return res.price != null
              ? { ...a, lastPrice: res.price, lastUpdated: new Date().toISOString() }
              : a;
          })
        ).then((updated) => setAssets(updated))
      );
    }

    // Gold ETF (parallel)
    const etf = goldEtfRef.current;
    if (etf?.identifier && isISIN(etf.identifier)) {
      tasks.push(
        fetchOne(etf).then((res) => {
          if (res.price != null) {
            setGoldEtf((prev) => ({ ...prev, lastPrice: res.price, lastUpdated: new Date().toISOString() }));
          }
        }).catch(() => {})
      );
    }

    await Promise.all(tasks);
  }, [fetchOne, setAssets]);

  const intervalRef = useRef(null);
  useEffect(() => {
    if (assets.length > 0 || goldEtf.identifier) fetchAllPrices();
    // Try to refresh physical gold spot on load too
    fetchGoldSpotPrice().catch(() => {});
    intervalRef.current = setInterval(() => {
      fetchAllPrices();
      fetchGoldSpotPrice().catch(() => {});
    }, AUTO_REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Snapshot ----
  const buildSnapshot = useCallback(() => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year  = now.getFullYear();
    const label = `${MONTH_LABELS_IT[month - 1]} ${year}`;
    const goldEtfSnap = (goldEtf.lastPrice && goldEtf.quantity)
      ? [{ id: goldEtf.id, name: goldEtf.name, price: goldEtf.lastPrice,
          quantity: goldEtf.quantity, value: r2(goldEtf.lastPrice * goldEtf.quantity) }]
      : [];
    return {
      label, month, year,
      totalValue: r2(grandTotal),
      assets: [
        ...assets.filter((a) => a.lastPrice).map((a) => ({
          id: a.id, name: a.name, price: a.lastPrice,
          quantity: a.quantity, value: r2((a.lastPrice || 0) * (a.quantity || 0)),
        })),
        ...goldEtfSnap,
      ],
    };
  }, [assets, grandTotal, goldEtf]);

  const saveMonthlySnapshot = useCallback(async () => {
    const snapshotData = buildSnapshot();
    const label = snapshotData.label;
    setSnapSaving(true);
    setSnapMsg(null);
    try {
      const res  = await fetch("/api/snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshotData),
      });
      const json = await res.json();
      if (!json.ok) throw new Error("Risposta non valida");
      const updated = await fetch("/api/snapshots").then((r) => r.json());
      if (Array.isArray(updated)) setSnapshots(updated);
      setSnapMsg({ type: "ok", text: `✓ Snapshot "${label}" salvato` });
    } catch (e) {
      setSnapMsg({ type: "err", text: `Errore: ${e.message}` });
    } finally {
      setSnapSaving(false);
      setTimeout(() => setSnapMsg(null), 5000);
    }
  }, [buildSnapshot]);

  // ---- Auto-save config sul server (debounce 1.5s) ----
  // Ogni modifica (asset, cash, oro, startup) viene persistita in data/config.json.
  // In più aggiorna in automatico lo snapshot del mese corrente (upsert per mese/anno),
  // così lo storico si costruisce da solo: apri, aggiorni, chiudi.
  useEffect(() => {
    if (!configLoaded) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: CONFIG_VERSION,
            totalCash, assets, startups, assetClasses, goldEtf, physGold,
          }),
        });
        if (!res.ok) return;
        setLastSaved(new Date());

        // Auto-snapshot mese corrente (solo se ci sono prezzi)
        const snap = buildSnapshot();
        if (snap.assets.length > 0) {
          await fetch("/api/snapshot", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snap),
          });
          const updated = await fetch("/api/snapshots").then((r) => r.json());
          if (Array.isArray(updated)) setSnapshots(updated);
        }
      } catch { /* offline: localStorage fa da cache */ }
    }, 1500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, assets, startups, totalCash, assetClasses, goldEtf, physGold]);

  const exportSnapshotsFile = useCallback(() => {
    const blob = new Blob([JSON.stringify(snapshots, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `snapshots_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [snapshots]);

  const importSnapshotsRef = useRef(null);
  const importSnapshots = useCallback(async (file) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error("Il file non contiene un array di snapshot.");
      let count = 0;
      for (const snap of parsed) {
        const res  = await fetch("/api/snapshot", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        });
        if ((await res.json()).ok) count++;
      }
      const updated = await fetch("/api/snapshots").then((r) => r.json());
      if (Array.isArray(updated)) setSnapshots(updated);
      setSnapMsg({ type: "ok", text: `✓ Importati ${count} snapshot` });
    } catch (e) {
      setSnapMsg({ type: "err", text: `Errore: ${e.message}` });
    } finally {
      setTimeout(() => setSnapMsg(null), 5000);
    }
  }, []);

  // ---- Config export/import ----
  const exportConfig = useCallback(() => {
    const config = {
      version: CONFIG_VERSION, exportedAt: new Date().toISOString(),
      totalCash, assets, startups, assetClasses, goldEtf, physGold,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio_config_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showCfgMsg("ok", "✓ Configurazione esportata");
  }, [assets, startups, totalCash, assetClasses, goldEtf, physGold]);

  const configImportRef = useRef(null);
  const importConfig = useCallback(async (file) => {
    if (!file) return;
    try {
      const config = JSON.parse(await file.text());
      if (!config.version || !Array.isArray(config.assets))
        throw new Error("File non valido.");
      if (Array.isArray(config.assets))       setAssets(config.assets);
      if (Array.isArray(config.startups))     setSU(config.startups);
      if (typeof config.totalCash === "number") setCash(config.totalCash);
      if (Array.isArray(config.assetClasses)) setAC(config.assetClasses);
      if (config.goldEtf)  setGoldEtf(config.goldEtf);
      if (config.physGold) setPhysGold(config.physGold);
      showCfgMsg("ok", `✓ Configurazione importata (${config.exportedAt?.slice(0,10) ?? "?"})`);
    } catch (e) {
      showCfgMsg("err", `Errore: ${e.message}`);
    }
  }, []);

  const showCfgMsg = (type, text) => {
    setConfigMsg({ type, text });
    setTimeout(() => setConfigMsg(null), 5000);
  };

  // ---- CRUD ----
  const saveAsset = (a) => setAssets((prev) => {
    const idx = prev.findIndex((x) => x.id === a.id);
    return idx >= 0 ? prev.map((x) => x.id === a.id ? a : x) : [...prev, a];
  });
  const saveSU = (s) => setSU((prev) => {
    const idx = prev.findIndex((x) => x.id === s.id);
    return idx >= 0 ? prev.map((x) => x.id === s.id ? s : x) : [...prev, s];
  });

  const deleteAsset = (id) => setAssets((prev) => prev.filter((a) => a.id !== id));
  const deleteSU    = (id) => setSU((prev) => prev.filter((s) => s.id !== id));

  const isLoading = Object.keys(loading).length > 0;
  const toggleLine = (dataKey) => setHiddenLines((prev) => {
    const next = new Set(prev); next.has(dataKey) ? next.delete(dataKey) : next.add(dataKey); return next;
  });

  const isEmpty = assets.length === 0 && goldTotal === 0 && startups.length === 0 && totalCash === 0;

  // ====================== TAB: OVERVIEW ======================
  const renderOverview = () => (
    <div className="tab-content">
      {isEmpty ? (
        <div className="welcome-card">
          <div className="welcome-icon">📊</div>
          <h2 className="welcome-title">Benvenuto in Portfolio Tracker</h2>
          <p className="welcome-desc">
            Inizia aggiungendo i tuoi investimenti dalla sezione <strong>Portafoglio</strong>.
            Puoi aggiungere ETF, azioni, startup, oro e liquidità.
          </p>
          <button className="btn btn-primary" onClick={() => setTab("portfolio")} style={{ fontSize: 15, padding: "10px 24px" }}>
            <Plus size={16}/> Inizia ad aggiungere asset
          </button>
          <div className="welcome-features">
            <div className="wf-item"><span>📈</span> Prezzi live via JustETF</div>
            <div className="wf-item"><span>💰</span> Prezzo oro 18kt live</div>
            <div className="wf-item"><span>🎯</span> Ribilanciamento automatico</div>
            <div className="wf-item"><span>📷</span> Snapshot mensili</div>
            <div className="wf-item"><span>🔮</span> Proiezioni future</div>
            <div className="wf-item"><span>💾</span> Backup configurazione</div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid-4">
            <KpiCard label="Patrimonio totale" value={fmt(grandTotal, true)} icon={Wallet}
              sub={`Liquidità: ${fmt(totalCash)}`} color="blue"/>
            <KpiCard
            label="ETF & Asset quotati"
            value={fmt(totals.val, true)}
            icon={Activity}
            trend={totals.ret * 100}
            color="blue"
          />
            <KpiCard label="Oro" 
              value={fmt(goldTotal, true)}
              color={goldEtfValue >= goldEtfCost ? "green" : "red"}
              trend={goldEtfPerfPct}/>
            <KpiCard label="Startup"
              value={fmt(suTotal, true)}
              sub={suFees > 0 ? `Commissioni: ${fmt(suFees)}, Abbonamento: ${fmt(suAbbonamenti)}` : `Abbonamento: ${fmt(suAbbonamenti)}`}
              color="blue"/>
          </div>

          {snapshots.length > 2 && (
            <div className="section-card">
              <h3 className="section-title"><Shield size={16}/> Metriche di rischio</h3>
              <div className="grid-5">
                <RiskCard label="CAGR"          value={riskMetrics.cagr}
                  fmtFn={(v) => fmtPct(v * 100)} tooltip="Tasso di crescita annuo composto"
                  quality={riskMetrics.cagr > 0.05 ? "good" : "bad"}/>
                <RiskCard label="Volatilità"    value={riskMetrics.vol}
                  fmtFn={(v) => fmtPct(v * 100)} tooltip="Volatilità annualizzata"
                  quality={riskMetrics.vol < 0.2 ? "good" : "bad"}/>
                <RiskCard label="Max Drawdown"  value={riskMetrics.mdd}
                  fmtFn={(v) => fmtPct(v * 100)} tooltip="Perdita massima dal picco"
                  quality={riskMetrics.mdd > -0.15 ? "good" : "bad"}/>
                <RiskCard label="Sharpe Ratio"  value={riskMetrics.sharpe}
                  fmtFn={(v) => v.toFixed(2)} tooltip=">1 ottimo"
                  quality={riskMetrics.sharpe > 1 ? "good" : riskMetrics.sharpe > 0 ? "neutral" : "bad"}/>
                <RiskCard label="Sortino Ratio" value={riskMetrics.sortino}
                  fmtFn={(v) => v.toFixed(2)} tooltip="Penalizza solo la volatilità negativa"
                  quality={riskMetrics.sortino > 1 ? "good" : riskMetrics.sortino > 0 ? "neutral" : "bad"}/>
              </div>
              <p className="hint-text">⚠ Metriche calcolate su {snapshots.length} snapshot mensili. Servono almeno 3 snapshot.</p>
            </div>
          )}

          {growthAttribution.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><TrendingUp size={16}/> Crescita: versamenti vs mercato</h3>
              <div className="kpi-mini-row" style={{ marginBottom: 12 }}>
                <span>Versamenti: <strong style={{ color: "var(--blue)" }}>{fmt(growthTotals.contrib)}</strong></span>
                <span>Mercato: <strong style={{ color: growthTotals.market >= 0 ? "var(--green)" : "var(--red)" }}>{fmt(growthTotals.market)}</strong></span>
                <span className="muted" style={{ fontSize: 12 }}>Solo asset quotati, stimato dagli snapshot mensili</span>
              </div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={growthAttribution} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--text-muted)"/>
                    <YAxis tickFormatter={(v) => `€${(v / 1000).toFixed(1)}k`} tick={{ fontSize: 10 }} stroke="var(--text-muted)"/>
                    <ReTooltip content={<CustomTooltip/>}/>
                    <Legend/>
                    <ReferenceLine y={0} stroke="var(--border2)"/>
                    <Bar dataKey="contrib" name="Versamenti" stackId="g" fill="#3b82f6" radius={[0, 0, 0, 0]}/>
                    <Bar dataKey="market"  name="Mercato"    stackId="g" fill="#10b981" radius={[3, 3, 0, 0]}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="grid-3">
            <div className="section-card">
              <h3 className="section-title"><TrendingUp size={16}/> Miglior performer</h3>
              {totals.best
                ? <><div className="big-name">{totals.best.name}</div><Badge value={totals.best.perf * 100}/></>
                : <p className="muted">Nessun dato disponibile</p>}
            </div>
            <div className="section-card">
              <h3 className="section-title"><TrendingDown size={16}/> Peggior performer</h3>
              {totals.worst
                ? <><div className="big-name">{totals.worst.name}</div><Badge value={totals.worst.perf * 100}/></>
                : <p className="muted">Nessun dato disponibile</p>}
            </div>
            <div className="section-card">
              <h3 className="section-title"><BarChart2 size={16}/> Composizione</h3>
              <div className="stat-row"><span>ETF / Asset quotati</span><strong>{fmt(totals.val)}</strong></div>
              <div className="stat-row"><span>Startup</span><strong>{fmt(suTotal)}</strong></div>
              <div className="stat-row">
                <span>Oro</span>
                <strong>{fmt(goldTotal)}</strong>
              </div>
              <div className="stat-row"><span>Liquidità</span><strong>{fmt(totalCash)}</strong></div>
            </div>
          </div>

          <div className="grid-2">
            {fullClassDist.length > 0 && (
              <div className="section-card">
                <h3 className="section-title"><PieChartIcon size={16}/> Asset allocation</h3>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={fullClassDist} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" outerRadius={95} innerRadius={45}
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}>
                        {fullClassDist.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]}/>)}
                      </Pie>
                      <ReTooltip formatter={(v, n) => [fmt(v), n]}/>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="section-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 className="section-title" style={{ margin: 0 }}><LineChartIcon size={16}/> Storico prezzi mensile</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {snapshotMsg && (
                    <span style={{ fontSize: 12, color: snapshotMsg.type === "ok" ? "var(--green)" : "var(--red)" }}>
                      {snapshotMsg.text}
                    </span>
                  )}
                  <input ref={importSnapshotsRef} type="file" accept=".json" style={{ display: "none" }}
                    onChange={(e) => { importSnapshots(e.target.files[0]); e.target.value = ""; }}/>
                  <button className="btn btn-ghost" onClick={() => importSnapshotsRef.current?.click()} style={{ fontSize: 12, padding: "6px 12px" }}>
                    <Upload size={13}/> Importa
                  </button>
                  <button className="btn btn-ghost" onClick={exportSnapshotsFile} disabled={snapshots.length === 0} style={{ fontSize: 12, padding: "6px 12px" }}>
                    <Download size={13}/> Esporta{snapshots.length > 0 ? ` (${snapshots.length})` : ""}
                  </button>
                  <button className="btn btn-primary" onClick={saveMonthlySnapshot}
                    disabled={snapshotSaving || isLoading || assets.length === 0} style={{ fontSize: 12, padding: "6px 12px" }}>
                    <Camera size={13}/> {snapshotSaving ? "Salvataggio…" : "Snapshot mensile"}
                  </button>
                </div>
              </div>
              {snapshotChartData.length === 0 ? (
                <div className="chart-empty" style={{ height: 280 }}>
                  <div style={{ textAlign: "center" }}>
                    <p className="muted" style={{ marginBottom: 8 }}>Nessuno snapshot registrato.</p>
                    <p className="muted" style={{ fontSize: 12 }}>Premi <strong>Snapshot mensile</strong> ogni mese per tracciare l'andamento.</p>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ height: 260 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={snapshotChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--text-muted)"/>
                        <YAxis tickFormatter={(v) => v + ""} tick={{ fontSize: 10 }} stroke="var(--text-muted)" domain={["auto","auto"]}
                          label={{ value: "Indice (base 100)", angle: -90, position: "insideLeft",
                            style: { fontSize: 10, fill: "var(--text-muted)" }, offset: 10 }}/>
                        <ReTooltip content={<SnapshotTooltip snapshots={snapshots}/>}/>
                        <Line type="monotone" dataKey="__total__" name="Portafoglio"
                          stroke={dark ? TOTAL_LINE_COLOR : TOTAL_LINE_COLOR_LIGHT} strokeWidth={2.5}
                          dot={{ r: 3 }} activeDot={{ r: 5 }} hide={hiddenLines.has("__total__")}/>
                        {assetIds.map((id, i) => (
                          <Line key={id} type="monotone" dataKey={id} name={assetNameMap[id] || id}
                            stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.5}
                            dot={snapshotChartData.length === 1 ? { r: 4 } : false}
                            activeDot={{ r: 4 }} hide={hiddenLines.has(id)}/>
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="snapshot-legend">
                    <button className={`legend-item ${hiddenLines.has("__total__") ? "legend-item--hidden" : ""}`}
                      onClick={() => toggleLine("__total__")}>
                      <span className="legend-dot" style={{ background: dark ? TOTAL_LINE_COLOR : TOTAL_LINE_COLOR_LIGHT }}/>
                      Portafoglio
                    </button>
                    {assetIds.map((id, i) => (
                      <button key={id} className={`legend-item ${hiddenLines.has(id) ? "legend-item--hidden" : ""}`}
                        onClick={() => toggleLine(id)}>
                        <span className="legend-dot" style={{ background: PALETTE[i % PALETTE.length] }}/>
                        {assetNameMap[id] || id}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );

  // ====================== TAB: PORTFOLIO ======================
  const renderPortfolio = () => (
    <div className="tab-content">
      {/* Config export/import */}
      <div className="section-card" style={{ borderColor: "var(--blue)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h3 className="section-title" style={{ margin: 0 }}><Settings size={16}/> Configurazione portafoglio</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Il portafoglio viene <strong>salvato automaticamente sul server</strong> a ogni modifica.
              Export/import JSON servono solo come backup o per migrare su un'altra installazione.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {configMsg && (
              <span style={{ fontSize: 12, color: configMsg.type === "ok" ? "var(--green)" : "var(--red)" }}>
                {configMsg.text}
              </span>
            )}
            <input ref={configImportRef} type="file" accept=".json" style={{ display: "none" }}
              onChange={(e) => { importConfig(e.target.files[0]); e.target.value = ""; }}/>
            <button className="btn btn-ghost" onClick={() => configImportRef.current?.click()}>
              <Upload size={15}/> Importa
            </button>
            <button className="btn btn-primary" onClick={exportConfig}>
              <Download size={15}/> Esporta configurazione
            </button>
          </div>
        </div>
      </div>

      {/* Liquidità */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="section-title" style={{ margin: 0 }}><Wallet size={16}/> Liquidità</h2>
          {!editCash ? (
            <button className="icon-btn" onClick={() => { setCashInput(totalCash); setEditCash(true); }}><Edit2 size={14}/></button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" step="any" value={cashInput} onChange={(e) => setCashInput(e.target.value)}
                className="field-input" style={{ width: 140 }}/>
              <button className="btn btn-primary" onClick={() => { setCash(parseFloat(cashInput) || 0); setEditCash(false); }}>
                <CheckCircle size={14}/> OK
              </button>
              <button className="btn btn-ghost" onClick={() => setEditCash(false)}><X size={14}/></button>
            </div>
          )}
        </div>
        {!editCash && (
          <div style={{ fontSize: "1.6rem", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", marginTop: 8 }}>
            {totalCash > 0 ? fmt(totalCash) : <span className="muted" style={{ fontSize: "1rem" }}>Clicca la matita per inserire la liquidità</span>}
          </div>
        )}
      </div>

      {/* ETF & Asset */}
      <div className="section-card">
        <div className="table-controls" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}><Briefcase size={16}/> ETF & Asset quotati</h2>
            {assetTotals.val > 0 && <span className="muted" style={{ fontSize: 13 }}>Totale: <strong>{fmt(assetTotals.val)}</strong></span>}
          </div>
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={() => setACModal(true)} title="Gestisci asset class">
              <Tag size={15}/> Asset class
            </button>
            {assets.length > 0 && (
              <div className="search-wrap" style={{ maxWidth: 260 }}>
                <Search size={15} className="search-icon"/>
                <input className="search-input" placeholder="Cerca…" value={search} onChange={(e) => setSearch(e.target.value)}/>
                {search && <button className="icon-btn" onClick={() => setSearch("")}><X size={14}/></button>}
              </div>
            )}
            {assets.length > 0 && (
              <button className="btn btn-ghost" onClick={() => exportCSV(assets)}><Download size={15}/> CSV</button>
            )}
            <button className="btn btn-primary" onClick={() => setAssetModal({})}><Plus size={15}/> Aggiungi asset</button>
          </div>
        </div>

        {assets.length === 0 ? (
          <EmptyState icon={Briefcase} title="Nessun asset ancora"
            description="Aggiungi ETF, azioni o altri strumenti finanziari quotati. Il prezzo sarà aggiornato automaticamente se inserisci un ISIN valido."
            action={<button className="btn btn-primary" onClick={() => setAssetModal({})}><Plus size={15}/> Aggiungi il primo asset</button>}/>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nome</th><th>ISIN</th><th className="num">Quantità</th>
                    <th className="num">P. Acquisto</th><th className="num">P. Attuale</th>
                    <th className="num">Valore</th><th className="num">Perf €</th>
                    <th className="num">Perf %</th>
                    <th className="num" title="Peso % sul sotto-portafoglio ETF (escluso oro) — somma 100%">Peso</th>
                    <th className="num">Target</th><th>Classe</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssets.map((a) => {
                    const value  = a.lastPrice ? r2(a.lastPrice * (a.quantity || 0)) : 0;
                    const perfE  = a.costBasis && a.lastPrice ? r2((a.lastPrice - a.costBasis) * (a.quantity || 0)) : 0;
                    const perfP  = a.costBasis && a.lastPrice ? r2(((a.lastPrice - a.costBasis) / a.costBasis) * 100) : 0;
                    // Peso: ETF sul sotto-portafoglio ETF; asset a target totale
                    // (es. Bitcoin) sul patrimonio intero, come l'oro
                    const onTotal = isTotalTargetAsset(a);
                    const denom   = onTotal ? grandTotal : etfSubTotal;
                    const weight  = denom > 0 ? (value / denom) * 100 : 0;
                    const diff    = weight - (a.targetWeight || 0);
                    return (
                      <tr key={a.id}>
                        <td className="asset-name">
                          {loading[a.id] && <span className="loading-dot inline-dot"/>}
                          {a.name}
                        </td>
                        <td className="mono muted">{a.identifier || "—"}</td>
                        <td className="num mono">{a.quantity}</td>
                        <td className="num mono">{fmt(a.costBasis)}</td>
                        <td className="num mono">{a.lastPrice ? fmt(a.lastPrice) : <span className="muted">—</span>}</td>
                        <td className="num mono"><strong>{value > 0 ? fmt(value) : "—"}</strong></td>
                        <td className={`num mono ${perfE >= 0 ? "pos-text" : "neg-text"}`}>
                          {a.lastPrice && a.costBasis ? `${perfE >= 0 ? "+" : ""}${fmt(perfE)}` : "—"}
                        </td>
                        <td className="num">{a.lastPrice && a.costBasis ? <Badge value={perfP}/> : "—"}</td>
                        <td className="num mono" title={onTotal ? "Peso % sul patrimonio totale" : "Peso % sul sotto-portafoglio ETF"}>
                          {weight.toFixed(1)}%{onTotal && <span className="muted" style={{ fontSize: 10 }}> tot</span>}
                        </td>
                        <td className="num">
                          <span className={`target-badge ${Math.abs(diff) > 3 ? (diff > 0 ? "over" : "under") : "ok"}`}
                            title={onTotal ? "Target % sul patrimonio totale" : "Target % sul sotto-portafoglio ETF"}>
                            {a.targetWeight || 0}%
                          </span>
                        </td>
                        <td><span className="class-tag">{a.assetClass}</span></td>
                        <td>
                          <div className="row-actions">
                            <button className="icon-btn" onClick={() => setAssetModal(a)}><Edit2 size={14}/></button>
                            <button className="icon-btn danger" onClick={() => { if (window.confirm(`Rimuovere ${a.name}?`)) deleteAsset(a.id); }}>
                              <Trash2 size={14}/>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint-text" style={{ marginTop: 8 }}>
              <strong>Peso</strong>: % sul totale ETF & Asset (escluso oro e asset "tot") — la somma è sempre 100%.
              {" "}<strong>Target</strong>: obiettivo in % del sotto-portafoglio ETF.
              {" "}Gli asset marcati <strong>tot</strong> (es. Bitcoin) hanno peso e target calcolati sul <strong>patrimonio totale</strong>, come l'oro.
            </p>
          </>
        )}
      </div>
      <div className="section-card" style={{ borderColor: goldTotal > 0 ? "rgba(245,158,11,0.4)" : undefined }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Oro
            </h2>
            {goldTotal > 0 && (
              <div className="kpi-mini-row" style={{ marginBottom: 0 }}>
                <span>Totale: <strong style={{ color: "var(--amber)" }}>{fmt(goldTotal)}</strong></span>
                {grandTotal > 0 && (
                  <span>
                    <strong>{((goldTotal / grandTotal) * 100).toFixed(1)}%</strong>
                    <span className="muted"> del patrimonio</span>
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            className="btn btn-ghost"
            onClick={refreshGoldPrices}
            disabled={goldLoading || isLoading}
            style={{ fontSize: 13 }}
          >
            <RefreshCw size={14} className={(goldLoading || loading[goldEtf.id]) ? "spin" : ""}/>
            {goldLoading ? "Aggiornamento…" : "Aggiorna prezzi oro"}
          </button>
        </div>

        {goldPriceErr && (
          <div className="alert alert-amber" style={{ marginBottom: 16 }}>
            <AlertTriangle size={14}/> {goldPriceErr}
            <span style={{ fontSize: 12, marginLeft: 8, opacity: 0.8 }}>
              — Assicurati che il backend esponga <code style={{ background: "rgba(0,0,0,0.2)", padding: "1px 5px", borderRadius: 4 }}>/api/gold-price</code>
            </span>
          </div>
        )}

        {/* ---- ETF Oro quotato ---- */}
        <div style={{ marginBottom: 20 }}>
          <div className="gold-sub-header">
            <span className="gold-sub-label">ETF Oro quotato</span>
            <button className="icon-btn" onClick={() => setGoldEtfModal(true)} title="Configura ETF oro">
              <Edit2 size={14}/>
            </button>
          </div>

          {!goldEtf.identifier ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              background: "rgba(245,158,11,0.06)", border: "1px dashed rgba(245,158,11,0.3)",
              borderRadius: "var(--radius-sm)", color: "var(--amber)" }}>
              <AlertTriangle size={14}/>
              <span style={{ fontSize: 13 }}>
                Configura l'ETF oro inserendo ISIN e quantità.
              </span>
              <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
                onClick={() => setGoldEtfModal(true)}>
                Configura
              </button>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Nome</th><th>ISIN</th><th className="num">Quantità</th>
                      <th className="num">P. Acquisto</th><th className="num">P. Attuale</th>
                      <th className="num">Valore</th><th className="num">Perf €</th><th className="num">Perf %</th>
                      <th className="num">Peso</th><th className="num">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="asset-name">
                        {loading[goldEtf.id] && <span className="loading-dot inline-dot"/>}
                        {goldEtf.name}
                      </td>
                      <td className="mono muted">{goldEtf.identifier}</td>
                      <td className="num mono">{goldEtf.quantity}</td>
                      <td className="num mono">{fmt(goldEtf.costBasis)}</td>
                      <td className="num mono">
                        {goldEtf.lastPrice ? fmt(goldEtf.lastPrice) : <span className="muted">—</span>}
                      </td>
                      <td className="num mono"><strong>{goldEtfValue > 0 ? fmt(goldEtfValue) : "—"}</strong></td>
                      <td className={`num mono ${goldEtfPerfE >= 0 ? "pos-text" : "neg-text"}`}>
                        {goldEtf.lastPrice && goldEtf.costBasis
                          ? `${goldEtfPerfE >= 0 ? "+" : ""}${fmt(goldEtfPerfE)}` : "—"}
                      </td>
                      <td className="num">
                        {goldEtf.lastPrice && goldEtf.costBasis
                          ? <Badge value={goldEtfPerfPct}/> : "—"}
                      </td>
                      {/* Peso oro (ETF + fisico) vs patrimonio totale */}
                      <td className="num mono">
                        {grandTotal > 0 && goldTotal > 0
                          ? `${((goldTotal / grandTotal) * 100).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="num">
                        {(() => {
                          const goldPct = grandTotal > 0 ? (goldTotal / grandTotal) * 100 : 0;
                          const tgt     = goldEtf.targetWeight || 0;
                          const diff    = goldPct - tgt;
                          return (
                            <span className={`target-badge ${Math.abs(diff) > 3 ? (diff > 0 ? "over" : "under") : "ok"}`}>
                              {tgt}%
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="hint-text" style={{ marginTop: 6 }}>
                <strong>Peso</strong>: (ETF oro + oro fisico) in % sul patrimonio totale.
                {" "}<strong>Target</strong>: obiettivo % sul patrimonio totale.
              </p>
            </>
          )}
        </div>

        {/* ---- Oro fisico 18kt ---- */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <div className="gold-sub-header">
            <span className="gold-sub-label">Oro fisico 18kt</span>
            <button className="icon-btn" onClick={() => setPhysGoldModal(true)} title="Modifica oro fisico">
              <Edit2 size={14}/>
            </button>
          </div>

          {physGold.grams === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              background: "var(--bg-card2)", border: "1px dashed var(--border)",
              borderRadius: "var(--radius-sm)", color: "var(--text-muted)" }}>
              <span style={{ fontSize: 13 }}>
                Nessun oro fisico registrato. Clicca la matita per inserire la grammatura.
              </span>
              <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
                onClick={() => setPhysGoldModal(true)}>
                Aggiungi
              </button>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th className="num">Grammatura</th>
                      <th className="num">Prezzo 18kt /g</th>
                      <th className="num">Valore totale</th>
                      <th className="num" style={{ fontSize: 10, whiteSpace: "nowrap" }}>Ult. agg.</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span className="class-tag" style={{ background: "rgba(245,158,11,0.1)", borderColor: "rgba(245,158,11,0.3)", color: "var(--amber)" }}>
                          18kt
                        </span>
                        {" "}Oro fisico
                      </td>
                      <td className="num mono"><strong>{physGold.grams} g</strong></td>
                      <td className="num mono">
                        {physGold.pricePerGram18kt
                          ? <span style={{ color: "var(--amber)" }}>{fmt(physGold.pricePerGram18kt)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num mono">
                        <strong>{physGoldValue > 0 ? fmt(physGoldValue) : "—"}</strong>
                      </td>
                      <td className="num muted" style={{ fontSize: 11 }}>
                        {physGold.lastUpdated
                          ? new Date(physGold.lastUpdated).toLocaleDateString("it-IT")
                          : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {physGold.grams > 0 && !physGold.pricePerGram18kt && (
                <p className="hint-text">
                  ⚠ Prezzo 18kt non disponibile. Premi <strong>Aggiorna prezzi oro</strong> oppure inserisci il prezzo manualmente dalla matita.
                </p>
              )}
              {physGold.grams > 0 && physGold.pricePerGram18kt && (
                <p className="hint-text" style={{ color: "var(--text-muted)" }}>
                  Calcolato come <strong>spot XAU/EUR (oz) ÷ 31,1035 × 0,75</strong> via gold-api.com.
                  {physGold.lastUpdated && (
                    <> Aggiornato il {new Date(physGold.lastUpdated).toLocaleString("it-IT")}.</>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Startup */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}><Activity size={16}/> Investimenti Startup</h2>
            {startups.length > 0 && (
              <div className="kpi-mini-row" style={{ marginBottom: 0 }}>
                <span>Totale: <strong>{fmt(suTotal)}</strong></span>
                <span>Commissioni: <strong>{fmt(suFees)}</strong></span>
                <span>Abbonamento: <strong>{fmt(suAbbonamenti)}</strong></span>
              </div>
            )}
          </div>
          <button className="btn btn-primary" onClick={() => setStartupModal({})}><Plus size={15}/> Aggiungi startup</button>
        </div>
        {startups.length === 0 ? (
          <EmptyState icon={Activity} title="Nessuna startup"
            description="Traccia gli investimenti in startup e fondi di venture capital. Inserisci l'importo investito e le eventuali commissioni."
            action={<button className="btn btn-primary" onClick={() => setStartupModal({})}><Plus size={15}/> Aggiungi startup</button>}/>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Nome</th><th className="num">Importo investito</th><th className="num">Commissioni</th><th></th></tr></thead>
              <tbody>
                {startups.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="num mono"><strong>{fmt(s.invested)}</strong></td>
                    <td className="num mono">{fmt(s.fee)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-btn" onClick={() => setStartupModal(s)}><Edit2 size={14}/></button>
                        <button className="icon-btn danger" onClick={() => { if (window.confirm(`Rimuovere ${s.name}?`)) deleteSU(s.id); }}>
                          <Trash2 size={14}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  // ====================== TAB: PROJECTION ======================
  const renderProjection = () => (
    <div className="tab-content">
      <div className="section-card">
        <h2 className="section-title"><LineChartIcon size={16}/> Proiezione crescita — scenari multipli</h2>
        <div className="grid-3" style={{ marginBottom: "1.5rem" }}>
          {[
            { label: "Rendimento annuo base (%)", val: projReturn, set: setProjR, step: 0.5, min: 0, max: 30 },
            { label: "Investimento mensile (€)",  val: projMonthly, set: setProjM, step: 100, min: 0 },
            { label: "Anni di proiezione",         val: projYears,  set: setProjY, step: 1,   min: 1, max: 50 },
          ].map(({ label, val, set, step, min, max }) => (
            <label key={label} className="field-label">
              {label}
              <input type="number" value={val} onChange={(e) => set(parseFloat(e.target.value) || 0)}
                step={step} min={min} max={max} className="field-input"/>
            </label>
          ))}
        </div>
        <div className="grid-4" style={{ marginBottom: "1.5rem" }}>
          <KpiCard label="Valore iniziale" value={fmt(grandTotal, true)} color="blue"/>
          <KpiCard label={`Proiettato (${projYears}a) — Base`} value={fmt(finalVal, true)} color="green"/>
          <KpiCard label="Ottimistico (+3%)" value={fmt(projData.at(-1)?.optimistic ?? 0, true)} color="green"/>
          <KpiCard label="Guadagno previsto" value={fmt(projGain, true)} sub={`ROI stimato: ${projROI.toFixed(1)}%`}
            color={projGain >= 0 ? "green" : "red"}/>
        </div>
        <div style={{ height: 380 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={projData}>
              <defs>
                {[{ id: "gOpt", color: "#10b981" },{ id: "gBase", color: "#3b82f6" },{ id: "gPess", color: "#f59e0b" }].map(({ id, color }) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.2}/>
                    <stop offset="95%" stopColor={color} stopOpacity={0}/>
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="year" label={{ value: "Anni", position: "insideBottom", offset: -4 }} tick={{ fontSize: 11 }} stroke="var(--text-muted)"/>
              <YAxis tickFormatter={(v) => `€${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} stroke="var(--text-muted)"/>
              <ReTooltip content={<CustomTooltip/>}/>
              <Legend/>
              <Area type="monotone" dataKey="optimistic" name={`Ottimistico (+${projReturn + 3}%)`} stroke="#10b981" fill="url(#gOpt)" strokeWidth={2} dot={false}/>
              <Area type="monotone" dataKey="base"        name={`Base (${projReturn}%)`}              stroke="#3b82f6" fill="url(#gBase)" strokeWidth={2.5} dot={false}/>
              <Area type="monotone" dataKey="pessimistic" name={`Pessimistico (${Math.max(projReturn - 3, 0)}%)`} stroke="#f59e0b" fill="url(#gPess)" strokeWidth={2} dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="hint-text">⚠ Proiezione ipotetica basata su rendimento costante. Non costituisce consulenza finanziaria.</p>
      </div>
    </div>
  );

  // ====================== TAB: REBALANCING ======================
  const renderRebalancing = () => {
    const { itemBuys, etfBudget, etfRebalance } = rebalanceTwoLevel;
    const totalItemsBudget = r2(itemBuys.reduce((a, x) => a + x.buy, 0));
    const allAtTarget = itemBuys.length > 0 && totalItemsBudget === 0;

    return (
      <div className="tab-content">
        {assets.length === 0 ? (
          <EmptyState icon={Target} title="Nessun asset da ribilanciare"
            description="Aggiungi asset con pesi target nella sezione Portafoglio per vedere i suggerimenti di ribilanciamento."/>
        ) : (
          <>
            {/* Budget mensile + split */}
            <div className="section-card">
              <h2 className="section-title"><Target size={16}/> Ribilanciamento — budget mensile</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: "1.2rem", flexWrap: "wrap" }}>
                <label className="field-label" style={{ flexDirection: "row", alignItems: "center", gap: 8, margin: 0 }}>
                  Budget disponibile:
                  <input type="number" value={monthBudget} onChange={(e) => setBudget(parseFloat(e.target.value) || 0)}
                    step="100" min="0" className="field-input" style={{ width: 120 }}/>
                </label>
              </div>

              <div className="grid-3" style={{ marginBottom: "1rem" }}>
                <KpiCard
                  label="🥇 Budget target su patrimonio"
                  value={fmt(totalItemsBudget)}
                  sub={
                    itemBuys.length > 0
                      ? itemBuys.map((x) => `${x.name.split(" ")[0]} ${fmt(x.buy, true)}`).join(" · ")
                      : "Nessun asset a target sul patrimonio totale"
                  }
                  color={totalItemsBudget > 0 ? "green" : "blue"}
                />
                <KpiCard
                  label="📈 Budget ETF & Asset"
                  value={fmt(etfBudget)}
                  sub={`${etfAssets.length} asset`}
                  color="blue"
                />
                <KpiCard
                  label="💼 Totale"
                  value={fmt(monthBudget)}
                  sub={allAtTarget ? "Oro/Bitcoin al target → tutto agli ETF" : "Prima oro e Bitcoin, poi ETF"}
                  color="blue"
                />
              </div>

              {allAtTarget && (
                <div className="alert alert-amber" style={{ marginBottom: 12 }}>
                  <AlertTriangle size={15}/>
                  {" "}Tutti gli asset a target sul patrimonio (oro, Bitcoin, …) sono già al target o sopra. Budget interamente allocato agli ETF.
                </div>
              )}

              {drift > 5 && (
                <div className="alert alert-amber">
                  <AlertTriangle size={15}/> Drift del {drift.toFixed(1)}% — il portafoglio si è allontanato dai target.
                </div>
              )}
            </div>

            {/* Livello 1: asset a target sul patrimonio totale */}
            {itemBuys.length > 0 && (
              <div className="section-card" style={{ borderColor: "rgba(245,158,11,0.4)" }}>
                <h3 className="section-title" style={{ marginBottom: 4 }}>🥇 Target sul patrimonio totale — Oro & Bitcoin</h3>
                <p className="hint-text" style={{ marginBottom: 12 }}>
                  Questi asset hanno il target espresso in % del <strong>patrimonio totale</strong> (liquidità + ETF + startup + oro).
                  Il peso dell'oro considera ETF oro + oro fisico; il budget va solo sull'ETF oro (l'oro fisico è illiquido).
                </p>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="num">Peso su patrimonio</th>
                        <th className="num">Target</th>
                        <th className="num">Acquisto mese</th>
                        <th className="num">Quote acquisto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itemBuys.map((x) => (
                        <tr key={x.id}>
                          <td className="asset-name">{x.name}{x.kind === "gold" && <span className="muted" style={{ fontSize: 11 }}> (ETF + fisico)</span>}</td>
                          <td className="num mono">{x.currentPct.toFixed(2)}%</td>
                          <td className="num mono">{x.targetPct.toFixed(2)}%</td>
                          <td className="num mono pos-text">
                            <strong>{x.buy > 0 ? fmt(x.buy) : <span className="muted">—</span>}</strong>
                          </td>
                          <td className="num mono">
                            {x.qty > 0 ? x.qty : <span className="muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ETF rebalancing */}
            <div className="section-card">
              <h3 className="section-title" style={{ marginBottom: 12 }}>
                📈 Acquisto ETF & Asset — budget {fmt(etfBudget)}
              </h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th className="num">Peso attuale</th>
                      <th className="num">Target (norm.)</th>
                      <th className="num">Delta €</th>
                      <th className="num">Qty Δ</th>
                      <th className="num">Acquisto mese</th>
                      <th className="num">Qty acquisto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {etfRebalance.actions.map((x) => (
                      <tr key={x.id}>
                        <td>{x.name}</td>
                        <td className="num mono">{x.curW.toFixed(2)}%</td>
                        <td className="num mono">{x.tgtW.toFixed(2)}%</td>
                        <td className={`num mono ${x.delta >= 0 ? "pos-text" : "neg-text"}`}>
                          {x.delta >= 0 ? "+" : ""}{fmt(x.delta)}
                        </td>
                        <td className="num mono">{x.qty.toFixed(4)}</td>
                        <td className="num mono pos-text">{fmt(x.monthlyBuy)}</td>
                        <td className="num mono">{x.monthlyQty > 0 ? x.monthlyQty : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <td colSpan={5}><strong>Totale acquisto ETF mensile</strong></td>
                      <td className="num mono">
                        {(() => {
                          const total = r2(etfRebalance.actions.reduce((acc, x) => acc + (x.monthlyBuy || 0), 0));
                          const diff  = r2(Math.abs(total - etfBudget));
                          return (
                            <span className={diff > 0.02 ? "neg-text" : "pos-text"}>
                              <strong>{fmt(total)}</strong>{diff > 0.02 ? " ⚠" : " ✓"}
                            </span>
                          );
                        })()}
                      </td>
                      <td/>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="hint-text">
                I pesi (Peso attuale e Target) sono calcolati all'interno del sotto-portafoglio ETF (escluso oro),
                quindi sommano a 100%. Il budget viene allocato prioritariamente agli asset sottopesati, senza mai vendere.
              </p>
            </div>
          </>
        )}
      </div>
    );
  };

  // ====================== RENDER ======================
  return (
    <div className={`app ${dark ? "dark" : "light"}`}>
      <header className="app-header">
        <div className="header-left">
          <div className="logo-mark">PF</div>
          <div>
            <h1 className="app-title">Portfolio Tracker</h1>
            <p className="app-subtitle">
              <Info size={12}/> Aggiornamento automatico ogni 15 min
              {lastSaved && (
                <span style={{ color: "var(--green)" }}>
                  · Salvato {lastSaved.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {isLoading && (
                <span className="loading-dot-row">
                  <span className="loading-dot"/><span className="loading-dot"/><span className="loading-dot"/>
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="header-right">
          {grandTotal > 0 && (
            <div className="grand-total">
              <span className="gt-label">Patrimonio totale</span>
              <span className="gt-value">{fmt(grandTotal)}</span>
              {totals.ret !== 0 && <Badge value={totals.ret * 100}/>}
            </div>
          )}
          {assets.length > 0 && (
            <button className="btn btn-primary" onClick={fetchAllPrices} disabled={isLoading}>
              <RefreshCw size={14} className={isLoading ? "spin" : ""}/>
              {isLoading ? "Aggiornamento…" : "Aggiorna prezzi"}
            </button>
          )}
          <button className="icon-btn theme-toggle" onClick={() => setDark((d) => !d)} title="Cambia tema">
            {dark ? <Sun size={17}/> : <Moon size={17}/>}
          </button>
        </div>
      </header>

      {error && (
        <div className="alert alert-red mx-4">
          <AlertTriangle size={14}/> {error}
        </div>
      )}

      <nav className="tab-bar">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} className={`tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              <Icon size={15}/> {t.label}
            </button>
          );
        })}
      </nav>

      <main className="app-main">
        {tab === "overview"    && renderOverview()}
        {tab === "portfolio"   && renderPortfolio()}
        {tab === "projection"  && renderProjection()}
        {tab === "rebalancing" && renderRebalancing()}
      </main>

      {/* Modali */}
      {assetModal !== null && (
        <AssetModal
          asset={assetModal?.id ? assetModal : null}
          assetClasses={assetClasses}
          onSave={(a) => {
            saveAsset(a);

            // Fetch prezzi se ISIN valido (sia nuovo che modifica)
            if (a.identifier && isISIN(a.identifier)) {
              setTimeout(fetchAllPrices, 300);
            }
          }}
          onClose={() => setAssetModal(null)}
        />
      )}
      {startupModal !== null && (
        <StartupModal startup={startupModal?.id ? startupModal : null} onSave={saveSU} onClose={() => setStartupModal(null)}/>
      )}
      {goldEtfModal && (
        <GoldEtfModal goldEtf={goldEtf} onSave={(updated) => {
          setGoldEtf(updated);
          if (updated.identifier && isISIN(updated.identifier)) setTimeout(refreshGoldPrices, 300);
        }} onClose={() => setGoldEtfModal(false)}/>
      )}
      {physGoldModal && (
        <PhysGoldModal physGold={physGold} onSave={(updated) => {
          setPhysGold(updated);
          // Only fetch auto price if no manual override was given
          if (!updated.pricePerGram18kt) fetchGoldSpotPrice().catch(() => {});
        }} onClose={() => setPhysGoldModal(false)}/>
      )}
      {acModal && (
        <AssetClassModal classes={assetClasses} onSave={setAC} onClose={() => setACModal(false)}/>
      )}
    </div>
  );
}