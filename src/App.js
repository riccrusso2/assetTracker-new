// App.js — Portfolio Tracker — Production-ready, no default data
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line,
  AreaChart, Area, ComposedChart, ReferenceLine,
} from "recharts";
import {
  RefreshCw, TrendingUp, TrendingDown, PieChart as PieChartIcon,
  LineChart as LineChartIcon, Target, Info, Trash2,
  Edit2, Moon, Sun, Download, Search, X, AlertTriangle,
  Activity, LayoutDashboard, Briefcase, Plus, CheckCircle,
  Shield, ChevronUp, ChevronDown, Wallet, Camera, Upload,
  Settings, Tag, LogOut, Share2, Copy, Eye, Link2, ArrowLeftRight,
} from "lucide-react";
import "./styles.css";
import {
  r2, snapKey, isTotalTargetAsset, calcRebalancingTwoLevel,
  suStatus, calcStartupPortfolio, calcDrift, driftThreshold,
  startupCashFlows, startupHoldings, calcConcentration,
} from "./rebalance";
import {
  TX_TYPES, TX_LABELS, txKey, txCashFlow, holdingFor,
  portfolioRealized, portfolioCashFlows, xirr,
} from "./transactions";
import {
  calcCAGR, calcVolatility, calcMaxDrawdown, calcSharpe, calcSortino, calcReturns,
  riskQuality, buildHistory, drawdownSeries, allocationOverTime,
  contributionByAsset, monthlyReturnsGrid, benchmarkSeries, OBS_RELIABLE,
  projectionScenarios, depletionYear, syntheticRows, isSynthetic, syntheticLabel,
  SYNTHETIC_RESIDUAL, PERIODS, sliceSnapshots, periodReturn, growthAttribution,
} from "./metrics";
import { taxReport, bolloTitoli, latentTax, DEFAULT_TAX } from "./tax";
import { apiFetch } from "./api";
import { supabase } from "./supabaseClient";

// ====================== CONSTANTS ======================
const STORAGE_KEYS = {
  ASSETS:        "pf.assets.v6",
  STARTUP:       "pf.startup.v3",
  GOLD_ETF:      "pf.goldetf.v1",
  PHYS_GOLD:     "pf.physgold.v1",
  DARK_MODE:     "pf.dark.v1",
  CASH:          "pf.cash.v2",
  ASSET_CLASSES: "pf.assetclasses.v1",
  SETTINGS:      "pf.settings.v1",
  TRANSACTIONS:  "pf.transactions.v1",
};

const CONFIG_VERSION  = 4;   // v4: registro movimenti (`transactions`)
const AUTO_REFRESH_MS = 900_000; // 15 min

// Impostazioni per-utente (Fase 10). Salvate nel blob config.data, editabili da UI.
const DEFAULT_SETTINGS = {
  startupSubscription: 468, // abbonamento startup annuo (era hardcoded)
  monthlyBudget: 500,       // budget mensile default (ribilanciamento)
  projReturn: 7,            // rendimento annuo % default (proiezione)
  projMonthly: 500,         // investimento mensile default (proiezione)
  projYears: 10,            // anni proiezione default
  riskFree: 3,              // tasso privo di rischio % (Sharpe/Sortino)
  inflation: 2,             // inflazione attesa % (proiezione in potere d'acquisto)
  rebalanceBand: 0,         // % di scostamento tollerata prima di intervenire (0 = sempre)
  benchmarkKey: "",         // snapKey dell'asset usato come riferimento
  taxRate: DEFAULT_TAX.rate,
  taxBollo: DEFAULT_TAX.bollo,
};

const MONTH_LABELS_IT = [
  "Gen","Feb","Mar","Apr","Mag","Giu",
  "Lug","Ago","Set","Ott","Nov","Dic",
];

// "Oro" c'è perché è la classe che l'app stessa assegna all'ETF oro
// (GOLD_ETF_DEFAULT) ed è, con Crypto, una delle due che di default hanno il
// target sul patrimonio totale — vedi isTotalTargetAsset in rebalance.js.
const DEFAULT_ASSET_CLASSES = [
  "ETF", "Azione", "Commodity", "Crypto", "Oro", "Bond", "Altro",
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
const newId   = ()  => Math.random().toString(36).slice(2, 10);

// Etichette UI degli stati startup (logica in rebalance.js).
const STARTUP_STATUS = {
  active: { label: "Attiva",  cls: "status-active" },
  exit:   { label: "Exit",    cls: "status-exit" },
  failed: { label: "Fallita", cls: "status-failed" },
};

const ls = {
  get: (key, def) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  set: (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// ====================== SNAPSHOT HELPERS ======================
// Indice base 100 dei soli prezzi di mercato. Le righe sintetiche restano
// fuori: liquidità e startup hanno prezzo 1 per costruzione (una retta a 100),
// e l'oro fisico ripeterebbe la curva dell'ETF oro già in grafico.
const quotedRows = (snap) => (snap.assets || []).filter((a) => !isSynthetic(a));

const buildChartData = (snapshots) => {
  if (!snapshots.length) return { data: [], assetIds: [], allIds: [] };
  const base = snapshots[0];
  const baseTotal = base.totalValue || 1;
  const baseByAssetId = {};
  quotedRows(base).forEach((a) => { baseByAssetId[snapKey(a)] = a.price || 1; });
  const assetIdSet = new Set(), allIdSet = new Set();
  snapshots.forEach((s) => {
    const rows = s.assets || [];
    rows.forEach((a) => {
      allIdSet.add(snapKey(a));
      if (!isSynthetic(a)) assetIdSet.add(snapKey(a));
    });
    // Snapshot pre-righe-sintetiche: la parte non quotata esiste solo come
    // differenza rispetto al totale (vedi allocationOverTime).
    const residual = (s.totalValue || 0) - rows.reduce((acc, a) => acc + (a.value || 0), 0);
    if (residual > 0.005) allIdSet.add(SYNTHETIC_RESIDUAL);
  });
  // `assetIds`: solo prezzi di mercato (grafico base 100).
  // `allIds`: tutto il patrimonio (composizione nel tempo, contributo).
  const assetIds = [...assetIdSet], allIds = [...allIdSet];
  const data = snapshots.map((snap) => {
    const point = { label: snap.label };
    point["__total__"] = r2(((snap.totalValue || 0) / baseTotal) * 100);
    quotedRows(snap).forEach((a) => {
      const k = snapKey(a);
      const b = baseByAssetId[k] || a.price || 1;
      point[k] = r2(((a.price || 0) / b) * 100);
    });
    return point;
  });
  return { data, assetIds, allIds };
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
// Palette categoriale a 8 slot, un set per tema: gli stessi 8 toni ricalibrati
// sulla superficie chiara/scura, non un flip automatico. Ordine degli slot fisso
// (massimizza la separazione percettiva tra vicini, anche per i daltonici) e mai
// riassegnato in base al rango: un asset tiene il suo colore anche se filtrato.
const PALETTE_LIGHT = ["#2a78d6","#1baf7a","#eda100","#008300","#4a3aa7","#e34948","#e87ba4","#eb6834"];
const PALETTE_DARK  = ["#3987e5","#199e70","#c98500","#008300","#9085e9","#e66767","#d55181","#d95926"];

// Oltre l'ottava serie non si generano nuove tinte (indistinguibili sotto CVD):
// si riusa la stessa tinta con tratto tratteggiato — identità = colore + tratto.
const seriesDash = (i) => (i >= 8 ? "6 4" : undefined);

// Colori semantici (guadagno/perdita), non categoriali: non vanno mai usati come "serie N".
const C_GAIN = "#10b981";
const C_LOSS = "#ef4444";
const C_CONTRIB = "#3b82f6";

// Cella della heatmap: intensità proporzionale al rendimento, piena intorno al
// ±5% mensile. Oltre quella soglia un colore più carico non distingue più nulla,
// e il numero nella cella dice comunque quanto.
const heatStyle = (v) => {
  if (v == null) return undefined;
  const alpha = Math.round(Math.min(Math.abs(v) / 5, 1) * 0.5 * 255).toString(16).padStart(2, "0");
  return { background: `${v >= 0 ? C_GAIN : C_LOSS}${alpha}` };
};

// ====================== COMPONENTS ======================

const Badge = ({ value, suffix = "%" }) => {
  const pos = value >= 0;
  return (
    <span className={`badge ${pos ? "badge-pos" : "badge-neg"}`}>
      {pos ? "+" : ""}{typeof value === "number" ? value.toFixed(2) : value}{suffix}
    </span>
  );
};

const KpiCard = ({ label, value, sub, icon: Icon, trend, trendLabel, color = "blue", compact = false, hero = false, footer = null }) => (
  <div className={`kpi-card kpi-${color}${hero ? " kpi-hero" : ""}`}>
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
        {trendLabel && <span className="kpi-trend-label">{trendLabel}</span>}
      </div>
    )}
    {footer}
  </div>
);

const StatusTag = ({ status }) => {
  const s = STARTUP_STATUS[status] || STARTUP_STATUS.active;
  return <span className={`status-tag ${s.cls}`}>{s.label}</span>;
};

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

// ---- Comportamento comune degli 8 modali ----
// Esc per chiudere, fuoco portato dentro all'apertura e Tab che ci resta.
// Senza il confinamento il Tab esce dal dialogo e continua a girare sulla
// pagina sotto, che è ancora lì ma non è più raggiungibile con lo sguardo.
// Restituisce il ref da mettere sul contenitore del dialogo.
const useModalA11y = (onClose) => {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prevFocus = document.activeElement;
    const focusables = () => [...node.querySelectorAll(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.disabled && el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // Chi ha aperto il modale riprende il fuoco: senza, torna sul <body> e
      // la navigazione da tastiera riparte dall'inizio della pagina.
      if (prevFocus instanceof HTMLElement) prevFocus.focus();
    };
  }, [onClose]);
  return ref;
};

// ---- Asset Class Manager Modal ----
const AssetClassModal = ({ classes, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
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
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
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
// etfTargetOthers: somma dei target degli altri asset del sotto-portafoglio ETF
// (escluso quello in modifica). Il totale non può superare 100%.
// fromTx: la posizione è calcolata dal registro movimenti, quindi quantità e
// prezzo medio di carico non si toccano da qui — si correggono i movimenti.
const AssetModal = ({ asset, assetClasses, etfTargetOthers = 0, fromTx = false, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const [form, setForm] = useState({
    name: "", identifier: "", quantity: "", costBasis: "",
    targetWeight: "", assetClass: assetClasses[0] || "ETF", currency: "EUR",
    ...asset,
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onTotal    = form.targetOnTotal ?? form.assetClass === "Crypto";
  const target     = parseFloat(form.targetWeight) || 0;
  const targetLeft = r2(100 - etfTargetOthers);
  const targetOver = !onTotal && target > targetLeft;

  const handleSave = () => {
    if (!form.name || !form.quantity || !form.costBasis || targetOver) return;
    onSave({
      ...form,
      id:           form.id || newId(),
      quantity:     parseFloat(form.quantity)     || 0,
      costBasis:    parseFloat(form.costBasis)    || 0,
      targetWeight: target,
      targetOnTotal: onTotal,
      lastPrice:    form.lastPrice ?? null,
      lastUpdated:  form.lastUpdated ?? null,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{asset?.id ? "Modifica asset" : "Aggiungi asset"}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          {[
            { label: "Nome *",                  key: "name",         type: "text" },
            { label: "ISIN / Ticker",           key: "identifier",   type: "text" },
            { label: "Quantità *",              key: "quantity",     type: "number", locked: fromTx },
            { label: "Prezzo medio carico (€) *", key: "costBasis",  type: "number", locked: fromTx },
            { label: "Peso target (%)",         key: "targetWeight", type: "number" },
          ].map(({ label, key, type, locked }) => (
            <label key={key} className="field-label">
              {label}
              <input type={type} value={form[key] ?? ""} onChange={(e) => set(key, e.target.value)}
                className="field-input" step="any" readOnly={locked}
                title={locked ? "Calcolato dai movimenti registrati" : undefined}
                style={locked ? { opacity: 0.6, cursor: "not-allowed" } : undefined}/>
            </label>
          ))}
          {fromTx && (
            <p className="hint-text" style={{ marginTop: 0 }}>
              Quantità e prezzo medio di carico sono calcolati dai movimenti registrati:
              per correggerli modifica il movimento nella tab <strong>Movimenti</strong>.
            </p>
          )}
          <label className="field-label">
            Asset Class
            <select value={form.assetClass} onChange={(e) => set("assetClass", e.target.value)} className="field-input">
              {/* La classe dell'asset resta selezionabile anche se non è più
                  nell'elenco salvato (config vecchie, classe rimossa a mano). */}
              {[...new Set([...assetClasses, form.assetClass])].filter(Boolean)
                .map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="field-label">
            Il target si riferisce a
            <select value={onTotal ? "total" : "etf"} className="field-input"
              onChange={(e) => set("targetOnTotal", e.target.value === "total")}>
              <option value="etf">Sotto-portafoglio ETF &amp; Asset quotati</option>
              <option value="total">Patrimonio totale (come l'oro)</option>
            </select>
          </label>
          <p className="hint-text" style={{ marginTop: 0, color: targetOver ? "var(--red)" : undefined }}>
            {onTotal
              ? "Il peso target è calcolato sull'intero patrimonio (liquidità, ETF, startup, oro). L'asset viene mostrato nella sezione Oro & Bitcoin."
              : targetOver
                ? `⚠ Target massimo ${targetLeft}%: gli altri asset ne occupano già ${etfTargetOthers}% e la somma non può superare 100%.`
                : `Il peso target è calcolato sul solo sotto-portafoglio ETF. Target disponibile: ${targetLeft}% (altri asset: ${etfTargetOthers}%).`}
          </p>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Se inserisci un ISIN valido, il prezzo sarà aggiornato automaticamente via JustETF.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!form.name || !form.quantity || !form.costBasis || targetOver}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Startup ----
const StartupModal = ({ startup, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const [form, setForm] = useState(
    startup?.id ? { ...startup, status: suStatus(startup) }
                : { name: "", invested: "", fee: "", status: "active", date: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const handleSave = () => {
    if (!form.name || !form.invested) return;
    const status = form.status || "active";
    onSave({
      id: form.id || newId(), name: form.name,
      invested: parseFloat(form.invested) || 0,
      fee: parseFloat(form.fee) || 0,
      status,
      // Senza la data l'investimento non ha durata: niente holding period e
      // niente IRR. È opzionale perché le posizioni già inserite non ce l'hanno.
      date: form.date || undefined,
      // Exit: importo incassato + note. Fallita/Attiva: campi ripuliti.
      exitAmount: status === "exit" ? (parseFloat(form.exitAmount) || 0) : undefined,
      exitDate:   status === "exit" ? (form.exitDate || undefined) : undefined,
      exitNotes:  status === "exit" ? (form.exitNotes || "").trim() || undefined : undefined,
      // Attiva: valutazione odierna opzionale (round successivi).
      currentValue: status === "active" && `${form.currentValue ?? ""}` !== ""
        ? parseFloat(form.currentValue) || 0 : undefined,
    });
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
          <label className="field-label">Data investimento
            <input type="date" value={form.date ?? ""} onChange={(e) => set("date", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Stato
            <select value={form.status || "active"} onChange={(e) => set("status", e.target.value)} className="field-input">
              {Object.entries(STARTUP_STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          {form.status === "active" && (
            <label className="field-label">Valutazione attuale (€) — opzionale
              <input type="number" step="any" value={form.currentValue ?? ""} onChange={(e) => set("currentValue", e.target.value)} className="field-input"
                placeholder="Lascia vuoto per valorizzare al costo"/>
            </label>
          )}
          {form.status === "exit" && (
            <>
              <label className="field-label">Importo incassato dall'exit (€) *
                <input type="number" step="any" value={form.exitAmount ?? ""} onChange={(e) => set("exitAmount", e.target.value)} className="field-input"/>
              </label>
              <label className="field-label">Data dell'exit
                <input type="date" value={form.exitDate ?? ""} onChange={(e) => set("exitDate", e.target.value)} className="field-input"/>
              </label>
              <label className="field-label">Note (opzionale)
                <textarea rows={3} value={form.exitNotes ?? ""} onChange={(e) => set("exitNotes", e.target.value)} className="field-input"
                  style={{ resize: "vertical", fontFamily: "'Outfit', sans-serif" }}/>
              </label>
            </>
          )}
          {form.status === "failed" && (
            <p className="hint-text" style={{ margin: 0 }}>
              ⚠ Startup fallita: valore finale <strong>0 €</strong>. La perdita sarà pari al costo totale (investito + commissioni).
            </p>
          )}
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

// ---- Modal Snapshot ----
// Serve a due cose che prima si facevano scrivendo JSON a mano: correggere il
// valore di un mese e riempire un buco nella serie. `nearest` è lo snapshot da
// cui copiare le posizioni quando se ne crea uno nuovo — senza, il mese
// aggiunto spezzerebbe i grafici per asset.
const SnapshotModal = ({ snap, preset, nearest, taken, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const now = new Date();
  const [form, setForm] = useState(snap || preset || {
    year: now.getFullYear(), month: now.getMonth() + 1, totalValue: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const editing = !!snap;

  const year  = parseInt(form.year, 10) || 0;
  const month = parseInt(form.month, 10) || 0;
  const dup   = !editing && taken.has(`${year}-${month}`);
  const valid = year > 1990 && month >= 1 && month <= 12 && `${form.totalValue}` !== "" && !dup;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      label: `${MONTH_LABELS_IT[month - 1]} ${year}`,
      year, month,
      totalValue: parseFloat(form.totalValue) || 0,
      // Le posizioni non si inventano: si riusano quelle del mese più vicino,
      // così il flusso esterno del periodo risulta nullo invece che casuale.
      assets: snap?.assets ?? nearest?.assets ?? [],
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{editing ? `Modifica snapshot ${snap.label}` : "Aggiungi snapshot"}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <label className="field-label">Anno *
            <input type="number" value={form.year} disabled={editing}
              onChange={(e) => set("year", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Mese *
            <select value={form.month} disabled={editing}
              onChange={(e) => set("month", e.target.value)} className="field-input">
              {MONTH_LABELS_IT.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="field-label">Patrimonio totale (€) *
            <input type="number" step="any" value={form.totalValue}
              onChange={(e) => set("totalValue", e.target.value)} className="field-input"/>
          </label>
          {dup && (
            <p className="hint-text" style={{ margin: 0, color: "var(--red)" }}>
              ⚠ Esiste già uno snapshot per questo mese: modificalo invece di crearne un altro.
            </p>
          )}
          {!editing && (
            <p className="hint-text" style={{ margin: 0 }}>
              Le posizioni per asset vengono copiate da <strong>{nearest?.label ?? "nessuno snapshot"}</strong>:
              il mese risulterà senza versamenti né vendite. Per uno storico esatto importa il file
              degli snapshot invece di crearlo qui.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!valid}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Movimento ----
// options: [{ key, name }] — gli asset quotati su cui si può registrare un
// movimento. La chiave è quella degli snapshot (nome slugificato), non l'id.
const TxModal = ({ tx, options, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState(
    tx?.id ? { ...tx }
           : { date: today, assetKey: options[0]?.key || "", type: "buy",
               quantity: "", price: "", fee: "", amount: "", notes: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Il dividendo si registra come importo incassato: quantità e prezzo non
  // hanno significato.
  const isDiv = form.type === "dividend";
  const valid = form.date && form.assetKey &&
    (isDiv ? `${form.amount ?? ""}` !== "" : form.quantity !== "" && form.price !== "");

  const preview = txCashFlow({
    type: form.type,
    quantity: parseFloat(form.quantity) || 0,
    price: parseFloat(form.price) || 0,
    amount: parseFloat(form.amount) || 0,
    fee: parseFloat(form.fee) || 0,
  });

  const handleSave = () => {
    if (!valid) return;
    onSave({
      id: form.id || newId(),
      date: form.date,
      assetKey: form.assetKey,
      type: form.type,
      quantity: isDiv ? 0 : parseFloat(form.quantity) || 0,
      price:    isDiv ? 0 : parseFloat(form.price) || 0,
      amount:   isDiv ? parseFloat(form.amount) || 0 : 0,
      fee: parseFloat(form.fee) || 0,
      notes: (form.notes || "").trim() || undefined,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{tx?.id ? "Modifica movimento" : "Aggiungi movimento"}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <label className="field-label">Data *
            <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Asset *
            <select value={form.assetKey} onChange={(e) => set("assetKey", e.target.value)} className="field-input">
              {options.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
            </select>
          </label>
          <label className="field-label">Tipo *
            <select value={form.type} onChange={(e) => set("type", e.target.value)} className="field-input">
              {TX_TYPES.map((t) => <option key={t} value={t}>{TX_LABELS[t]}</option>)}
            </select>
          </label>
          {isDiv ? (
            <label className="field-label">Importo lordo incassato (€) *
              <input type="number" step="any" value={form.amount ?? ""} onChange={(e) => set("amount", e.target.value)} className="field-input"/>
            </label>
          ) : (
            <>
              <label className="field-label">Quantità *
                <input type="number" step="any" value={form.quantity ?? ""} onChange={(e) => set("quantity", e.target.value)} className="field-input"/>
              </label>
              <label className="field-label">Prezzo per quota (€) *
                <input type="number" step="any" value={form.price ?? ""} onChange={(e) => set("price", e.target.value)} className="field-input"/>
              </label>
            </>
          )}
          <label className="field-label">{isDiv ? "Ritenuta / spese (€)" : "Commissioni (€)"}
            <input type="number" step="any" value={form.fee ?? ""} onChange={(e) => set("fee", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Note (opzionale)
            <input type="text" value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} className="field-input"/>
          </label>
          {valid && (
            <p className="hint-text" style={{ margin: 0 }}>
              {preview < 0
                ? <>Esborso: <strong>{fmt(Math.abs(preview))}</strong></>
                : <>Incasso: <strong>{fmt(preview)}</strong></>}
              {form.type === "buy" && " — commissioni incluse nel prezzo medio di carico."}
              {form.type === "sell" && " — il risultato realizzato è calcolato sul prezzo medio di carico del momento."}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!valid}>
            <CheckCircle size={15}/> Salva
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Modal Gold ETF ----
// etfTargetOthers: somma dei target degli altri asset del sotto-portafoglio ETF.
const GoldEtfModal = ({ goldEtf, etfTargetOthers = 0, fromTx = false, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const [form, setForm] = useState({ ...goldEtf });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onTotal    = isTotalTargetAsset(form);
  const target     = parseFloat(form.targetWeight) || 0;
  const targetLeft = r2(100 - etfTargetOthers);
  const targetOver = !onTotal && target > targetLeft;

  const handleSave = () => {
    if (targetOver) return;
    onSave({
      ...form,
      quantity:     parseFloat(form.quantity)     || 0,
      costBasis:    parseFloat(form.costBasis)    || 0,
      targetWeight: target,
      targetOnTotal: onTotal,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
            <input type="number" step="any" value={form.quantity} onChange={(e) => set("quantity", e.target.value)}
              className="field-input" readOnly={fromTx}
              title={fromTx ? "Calcolato dai movimenti registrati" : undefined}
              style={fromTx ? { opacity: 0.6, cursor: "not-allowed" } : undefined}/>
          </label>
          <label className="field-label">Prezzo medio carico (€/quota)
            <input type="number" step="any" value={form.costBasis} onChange={(e) => set("costBasis", e.target.value)}
              className="field-input" readOnly={fromTx}
              title={fromTx ? "Calcolato dai movimenti registrati" : undefined}
              style={fromTx ? { opacity: 0.6, cursor: "not-allowed" } : undefined}/>
          </label>
          {fromTx && (
            <p className="hint-text" style={{ marginTop: 0 }}>
              Quantità e prezzo medio di carico arrivano dai movimenti registrati:
              per correggerli modifica il movimento nella tab <strong>Movimenti</strong>.
            </p>
          )}
          <label className="field-label">Peso target (%)
            <input type="number" step="any" value={form.targetWeight} onChange={(e) => set("targetWeight", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">
            Il target si riferisce a
            <select value={onTotal ? "total" : "etf"} className="field-input"
              onChange={(e) => set("targetOnTotal", e.target.value === "total")}>
              <option value="etf">Sotto-portafoglio ETF &amp; Asset quotati</option>
              <option value="total">Patrimonio totale (liquidità, ETF, startup, oro)</option>
            </select>
          </label>
          <p className="hint-text" style={{ marginTop: 0, color: targetOver ? "var(--red)" : undefined }}>
            {onTotal
              ? "Il peso considera ETF oro + oro fisico sull'intero patrimonio. Con molta liquidità l'oro risulta spesso sottopesato e il budget mensile va prima tutto qui."
              : targetOver
                ? `⚠ Target massimo ${targetLeft}%: gli altri asset quotati ne occupano già ${etfTargetOthers}% e la somma non può superare 100%.`
                : `Il target è calcolato sul solo sotto-portafoglio ETF (es. 90% globale / 10% oro), indipendente da liquidità e startup. L'oro fisico non entra nel calcolo: conta solo l'ETF quotato. Target disponibile: ${targetLeft}% (altri asset: ${etfTargetOthers}%).`}
          </p>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Il prezzo viene aggiornato automaticamente via JustETF usando l'ISIN inserito.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={targetOver}>
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
  const dialogRef = useModalA11y(onClose);
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
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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

const ProjectionTooltip = ({ active, payload, label, projReturn }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="chart-tooltip" style={{ minWidth: 190 }}>
      <div className="tooltip-label">Anno {label}</div>
      <div className="tooltip-row"><span>Ottimistico (+{projReturn + 3}%)</span><span>{fmt(d.optimistic)}</span></div>
      <div className="tooltip-row" style={{ fontWeight: 700 }}><span>Base ({projReturn}%)</span><span>{fmt(d.base)}</span></div>
      <div className="tooltip-row"><span>Pessimistico ({Math.max(projReturn - 3, 0)}%)</span><span>{fmt(d.pessimistic)}</span></div>
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
        const assetSnap = snap?.assets?.find((a) => snapKey(a) === p.dataKey);
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

// ====================== SHARE MODAL ======================
// Gestisce il link pubblico read-only: crea/riusa il token, copia negli
// appunti, revoca. Lo stato reale vive sul server (/api/share).
const ShareModal = ({ onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const [state,   setState]   = useState(null);   // { enabled, token }
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState(null);
  const [copied,  setCopied]  = useState(false);

  const call = useCallback(async (method) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/share", { method });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { call("GET"); }, [call]);

  const url = state?.token ? `${window.location.origin}/p/${state.token}` : null;

  const copy = async () => {
    if (!url) return;
    try {
      // clipboard API richiede contesto sicuro: fallback su textarea + execCommand.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setErr("Copia non riuscita: seleziona e copia il link manualmente.");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3><Share2 size={16} style={{ marginRight: 8 }}/> Condividi portafoglio</h3>
          <button className="icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Chi riceve il link vede il tuo portafoglio in <strong>sola lettura</strong>,
            senza doversi registrare. Nessuno può modificare, aggiungere o eliminare dati.
          </p>

          {err && (
            <div className="alert alert-red" style={{ marginBottom: 0 }}>
              <AlertTriangle size={14}/> {err}
            </div>
          )}

          {loading && <p className="muted" style={{ fontSize: 13 }}>Caricamento…</p>}

          {!loading && state?.enabled && url && (
            <>
              <label className="field-label">
                Link pubblico
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input className="field-input" readOnly value={url}
                    onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }}/>
                  <button className="btn btn-primary" onClick={copy} style={{ flexShrink: 0 }}>
                    {copied ? <CheckCircle size={14}/> : <Copy size={14}/>}
                    {copied ? "Copiato" : "Copia"}
                  </button>
                </div>
              </label>
              {copied && (
                <span style={{ fontSize: 12, color: "var(--green)" }}>✓ Link copiato negli appunti</span>
              )}
              <p className="hint-text" style={{ margin: 0 }}>
                Il link contiene un codice casuale non indovinabile. Puoi disattivarlo
                quando vuoi: il vecchio link smette subito di funzionare.
              </p>
            </>
          )}

          {!loading && !state?.enabled && (
            <p className="muted" style={{ fontSize: 13 }}>
              La condivisione è disattivata. Genera un link per abilitarla.
            </p>
          )}
        </div>
        <div className="modal-footer">
          {state?.enabled ? (
            <button className="btn btn-ghost" onClick={() => call("DELETE")} disabled={loading}>
              <X size={14}/> Disattiva condivisione
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => call("POST")} disabled={loading}>
              <Link2 size={14}/> Genera link
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
};

// ====================== HOOKS ======================
const useLS = (key, init, uid) => {
  const fullKey = uid ? `${key}::${uid}` : key;
  const [v, setV] = useState(() => ls.get(fullKey, init));
  useEffect(() => ls.set(fullKey, v), [fullKey, v]);
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
      const res  = await apiFetch(`/api/quote?isin=${encodeURIComponent(isin)}`);
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
// `short`: etichetta per la bottom nav mobile, dove lo spazio è ~70px per voce.
const TABS = [
  { id: "overview",    label: "Overview",        short: "Overview",  icon: LayoutDashboard },
  { id: "portfolio",   label: "Portafoglio",     short: "Portaf.",   icon: Briefcase },
  { id: "transactions",label: "Movimenti",       short: "Movim.",    icon: ArrowLeftRight },
  { id: "analysis",    label: "Analisi",         short: "Analisi",   icon: Activity },
  { id: "projection",  label: "Proiezione",      short: "Proiez.",   icon: LineChartIcon },
  { id: "rebalancing", label: "Ribilanciamento", short: "Ribil.",    icon: Target },
  { id: "settings",    label: "Impostazioni",    short: "Impost.",   icon: Settings },
];

// ====================== MAIN APP ======================
export default function App({ session, shareToken } = {}) {
  // ---- State ----
  // shareToken presente → vista pubblica read-only (nessuna auth, nessuna scrittura).
  const readOnly = !!shareToken;
  // uid: namespacing della cache locale per utente (multi-user su stesso browser).
  // In vista condivisa il namespace è il token: i dati altrui non sporcano la
  // cache del proprietario che apre il link nello stesso browser.
  const uid = shareToken ? `share_${shareToken}` : session?.user?.id;
  const [dark,         setDark]    = useLS(STORAGE_KEYS.DARK_MODE, true, uid);
  const [storedAssets, setAssets]  = useLS(STORAGE_KEYS.ASSETS, [], uid);
  const [startups,     setSU]      = useLS(STORAGE_KEYS.STARTUP, [], uid);
  const [totalCash,    setCash]    = useLS(STORAGE_KEYS.CASH, 0, uid);
  const [assetClasses, setAC]      = useLS(STORAGE_KEYS.ASSET_CLASSES, DEFAULT_ASSET_CLASSES, uid);
  const [storedGoldEtf, setGoldEtf]= useLS(STORAGE_KEYS.GOLD_ETF, GOLD_ETF_DEFAULT, uid);
  const [physGold,     setPhysGold]= useLS(STORAGE_KEYS.PHYS_GOLD, PHYS_GOLD_DEFAULT, uid);
  const [settings,     setSettings]= useLS(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS, uid);
  const [transactions, setTx]      = useLS(STORAGE_KEYS.TRANSACTIONS, [], uid);

  // Un asset con movimenti registrati prende da lì quantità e prezzo medio di
  // carico; gli altri restano com'erano stati inseriti a mano. Proiettando la
  // posizione derivata qui, una volta sola, tutto il resto della dashboard
  // (totali, pesi, drift, ribilanciamento, snapshot) continua a leggere gli
  // stessi campi di prima senza sapere che esiste un registro.
  const withHolding = (a) => {
    const h = holdingFor(a, transactions);
    return h.fromTx ? { ...a, quantity: h.quantity, costBasis: h.costBasis } : a;
  };
  const assets  = useMemo(() => storedAssets.map(withHolding),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedAssets, transactions]);
  const goldEtf = useMemo(() => withHolding(storedGoldEtf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedGoldEtf, transactions]);

  const [snapshots,      setSnapshots]    = useState([]);
  const [snapshotSaving, setSnapSaving]   = useState(false);

  // ---- Feedback delle azioni ----
  // Prima c'erano due stati distinti resi in due punti fissi della pagina:
  // il messaggio degli snapshot viveva nell'header di un grafico in Overview,
  // ma tre delle quattro azioni che lo impostano partono dalla tab Analisi.
  // Chi cancellava uno snapshot non vedeva né conferma né errore.
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((type, text) => {
    clearTimeout(toastTimer.current);
    setToast({ type, text });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const [hiddenLines,  setHiddenLines]  = useState(new Set());
  const [focusedLine,  setFocusedLine]  = useState(null);
  const [tab,          setTab]          = useState("overview");
  const [search,       setSearch]       = useState("");

  const [assetModal,    setAssetModal]   = useState(null);
  const [startupModal,  setStartupModal] = useState(null);
  const [goldEtfModal,  setGoldEtfModal] = useState(false);
  const [physGoldModal, setPhysGoldModal]= useState(false);
  const [acModal,       setACModal]      = useState(false);
  const [shareModal,    setShareModal]   = useState(false);
  const [editCash,      setEditCash]     = useState(false);
  const [cashInput,     setCashInput]    = useState("");
  const [txModal,       setTxModal]      = useState(null);
  const [snapModal,     setSnapModal]    = useState(null);

  const [projYears,   setProjY] = useState(settings.projYears ?? 10);
  const [projReturn,  setProjR] = useState(settings.projReturn ?? 7);
  const [projMonthly, setProjM] = useState(settings.projMonthly ?? 500);
  const [monthBudget, setBudget] = useState(settings.monthlyBudget ?? 500);
  // Fase di prelievo: si accumula per spendere, e la proiezione senza questa
  // parte risponde a una domanda che nessuno si pone.
  const [projWithdraw,        setProjW]   = useState(false);
  const [projWithdrawAfter,   setProjWA]  = useState(20);
  const [projWithdrawMonthly, setProjWM]  = useState(1500);

  const [goldLoading,  setGoldLoading]  = useState(false);
  const [goldPriceErr, setGoldPriceErr] = useState(null);
  

  const { fetchOne, loading, error } = usePriceFetcher();
  // I ref servono all'aggiornamento prezzi, che riscrive lo stato: puntano al
  // valore salvato, non a quello derivato dai movimenti, altrimenti le
  // quantità calcolate finirebbero ricongelate dentro la config.
  const assetsRef  = useRef(storedAssets);
  const goldEtfRef = useRef(storedGoldEtf);
  useEffect(() => { assetsRef.current  = storedAssets;  }, [storedAssets]);
  useEffect(() => { goldEtfRef.current = storedGoldEtf; }, [storedGoldEtf]);

  // Dark mode
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);

  // Sotto i 640px le tabelle diventano card e styles.css stampa l'etichetta di
  // colonna con `content: attr(data-label)`. L'etichetta si copia dall'header
  // dopo il render invece di ripeterla a mano su ogni cella delle 7 tabelle
  // (dove verrebbe dimenticata alla prima colonna aggiunta).
  // ponytail: scritto sul DOM perché è un attributo che React non gestisce;
  // solo il tbody, il tfoot usa colSpan e non allinea con l'header.
  // Sotto i 640px `display: block` su tutte le parti della tabella cancella la
  // semantica tabellare: uno screen reader smette di annunciare "colonna X,
  // riga Y" e legge una sequenza piatta di numeri senza sapere cosa sono.
  // I ruoli espliciti la rimettono, e `content: attr(data-label)` non basta
  // perché il contenuto generato dal CSS non è testo accessibile affidabile.
  useEffect(() => {
    const role = (el, value) => { if (el.getAttribute("role") !== value) el.setAttribute("role", value); };
    document.querySelectorAll("table.data-table").forEach((table) => {
      const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      role(table, "table");
      table.querySelectorAll("thead, tbody, tfoot").forEach((g) => role(g, "rowgroup"));
      table.querySelectorAll("tr").forEach((tr) => role(tr, "row"));
      table.querySelectorAll("thead th").forEach((th) => {
        role(th, "columnheader");
        if (!th.hasAttribute("scope")) th.setAttribute("scope", "col");
      });
      table.querySelectorAll("tbody tr").forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          role(td, "cell");
          td.dataset.label = labels[i] || "";
        });
      });
      table.querySelectorAll("tfoot td").forEach((td) => role(td, "cell"));
    });
  });

  // Load snapshots from server (in vista condivisa arrivano da /api/public)
  useEffect(() => {
    if (readOnly) return;
    apiFetch("/api/snapshots")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setSnapshots(data); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Config: il server è la fonte di verità ----
  // Al mount carica data/config.json; localStorage resta cache di fallback
  // (es. server irraggiungibile). Niente più import/export manuale.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [lastSaved,    setLastSaved]    = useState(null);
  const [saveErr,      setSaveErr]      = useState(null);
  const [shareErr,     setShareErr]     = useState(null); // link pubblico non valido

  useEffect(() => {
    // Vista condivisa: un'unica GET pubblica restituisce config + snapshot.
    const load = readOnly
      ? apiFetch(`/api/public/${encodeURIComponent(shareToken)}`).then(async (r) => {
          if (!r.ok) throw new Error("share");
          const payload = await r.json();
          if (Array.isArray(payload.snapshots)) setSnapshots(payload.snapshots);
          return payload.config;
        })
      // Un GET fallito NON è "nessun portafoglio": prima veniva mappato a null,
      // lo stato veniva azzerato e l'auto-save sovrascriveva il blob buono con
      // uno vuoto. Ora l'errore risale al catch e l'auto-save non si arma.
      : apiFetch("/api/config").then((r) => {
          if (!r.ok) throw new Error(`config HTTP ${r.status}`);
          return r.json();
        });

    load
      .then((cfg) => {
        if (cfg && Array.isArray(cfg.assets)) {
          setAssets(cfg.assets);
          setSU(Array.isArray(cfg.startups) ? cfg.startups : []);
          setCash(typeof cfg.totalCash === "number" ? cfg.totalCash : 0);
          setAC(Array.isArray(cfg.assetClasses) ? cfg.assetClasses : DEFAULT_ASSET_CLASSES);
          setGoldEtf(cfg.goldEtf || GOLD_ETF_DEFAULT);
          setPhysGold(cfg.physGold || PHYS_GOLD_DEFAULT);
          // Assente nelle config precedenti alla v4: il portafoglio resta
          // quello inserito a mano finché non si registra il primo movimento.
          setTx(Array.isArray(cfg.transactions) ? cfg.transactions : []);
          const s = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
          setSettings(s);
          // Seed dei controlli proiezione/budget dai default salvati
          setProjY(s.projYears);
          setProjR(s.projReturn);
          setProjM(s.projMonthly);
          setBudget(s.monthlyBudget);
        } else {
          // Nessun portfolio salvato per questo utente: azzera cache locale,
          // altrimenti resta visibile l'ultimo stato cachato in localStorage.
          setAssets([]);
          setSU([]);
          setCash(0);
          setAC(DEFAULT_ASSET_CLASSES);
          setGoldEtf(GOLD_ETF_DEFAULT);
          setPhysGold(PHYS_GOLD_DEFAULT);
          setSettings(DEFAULT_SETTINGS);
          setTx([]);
        }
      })
      // configLoaded arma l'auto-save: si imposta SOLO se il caricamento è
      // riuscito. Su errore si resta in sola lettura di fatto, con la cache
      // locale a schermo, finché l'utente non ricarica.
      .then(() => { if (!readOnly) setConfigLoaded(true); })
      .catch((e) => {
        if (readOnly) {
          setShareErr(e.message === "share"
            ? "Questo link non è valido o la condivisione è stata disattivata."
            : "Impossibile caricare il portafoglio condiviso.");
        } else {
          setSaveErr(`portafoglio non caricato (${e.message}) — ricarica la pagina`);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Gold spot price fetch ----
  // Calls /api/gold-price which proxies gold-api.com XAU/EUR
  // Backend returns: { spotEurPerTroyOz, spotEurPerGram, price18ktPerGram, updatedAt }
  const fetchGoldSpotPrice = useCallback(async () => {
  const res = await apiFetch("/api/gold-price");
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
}, [setPhysGold]);

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
}, [fetchOne, fetchGoldSpotPrice, setGoldEtf]);

  // ---- Derived ----
  const totals = useMemo(() => calcTotals(assets, goldEtf), [assets, goldEtf]);

  // Split: asset con target sul patrimonio totale (es. Bitcoin) vs ETF classici
  const etfAssets = useMemo(() => assets.filter((a) => !isTotalTargetAsset(a)), [assets]);
  const totalTargetAssets = useMemo(() => assets.filter(isTotalTargetAsset), [assets]);
  const totalTargetValue = useMemo(
    () => totalTargetAssets.reduce((s, a) => s + (a.lastPrice || 0) * (a.quantity || 0), 0),
    [totalTargetAssets]);

  // L'ETF oro può avere il target sul patrimonio (default, come da sempre) oppure
  // sul solo sotto-portafoglio ETF (es. 90% globale / 10% oro). Nel secondo caso
  // entra a tutti gli effetti fra gli ETF: stesso peso, stesso livello 2 del
  // ribilanciamento. L'oro fisico non entra mai nel sotto-portafoglio — non è
  // quotato né acquistabile col budget mensile.
  const goldOnTotal = isTotalTargetAsset(goldEtf);
  const etfPortfolioAssets = useMemo(
    () => (goldOnTotal || !goldEtf.identifier ? etfAssets : [...etfAssets, goldEtf]),
    [etfAssets, goldEtf, goldOnTotal]);
  const etfSubTotal = useMemo(
    () => etfPortfolioAssets.reduce((s, a) => s + (a.lastPrice || 0) * (a.quantity || 0), 0),
    [etfPortfolioAssets]);
  // Somma dei target del sotto-portafoglio ETF: non deve mai superare 100%.
  const etfTargetSum = useMemo(
    () => r2(etfPortfolioAssets.reduce((s, a) => s + (a.targetWeight || 0), 0)),
    [etfPortfolioAssets]);

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
  // Totale della sezione Oro & Bitcoin (oro + asset a target sul patrimonio)
  const goldBtcTotal = r2(goldTotal + totalTargetValue);

  // Le startup concluse (exit/failed) escono dal patrimonio: l'incasso di un'exit
  // va registrato manualmente in liquidità.
  const startupStats = useMemo(
    () => calcStartupPortfolio(startups, settings.startupSubscription ?? 0),
    [startups, settings.startupSubscription]);

  const suTotal    = startupStats.activeVal;   // solo startup attive → patrimonio
  const suFees     = startupStats.feesTot;
  const suAbbonamenti = startupStats.subscription;

  // Rendimento e orizzonte del book startup. Il ROI da solo non basta su
  // posizioni illiquide: 300 € che tornano 400 € valgono diversamente dopo due
  // o dopo otto anni. Richiede la data, quindi resta null finché non c'è.
  const suHoldings = useMemo(
    () => startupHoldings(startups, new Date().toISOString().slice(0, 10)),
    [startups]);
  const suIrr = useMemo(
    () => xirr(startupCashFlows(startups, new Date().toISOString().slice(0, 10))),
    [startups]);
  const grandTotal = totals.val + totalCash + physGoldValue + suTotal;

  // Peso dell'oro nella base coerente col suo target: sul patrimonio conta la
  // posizione intera (ETF + fisico), sul sotto-portafoglio ETF solo l'ETF quotato.
  const goldPct = goldOnTotal
    ? (grandTotal > 0 && goldTotal > 0 ? (goldTotal / grandTotal) * 100 : null)
    : (etfSubTotal > 0 && goldEtfValue > 0 ? (goldEtfValue / etfSubTotal) * 100 : null);

  // Variazione patrimonio vs ultimo snapshot chiuso (mese corrente escluso: è auto-aggiornato).
  const monthDelta = useMemo(() => {
    const now = new Date(), m = now.getMonth() + 1, y = now.getFullYear();
    const prev = [...snapshots].reverse().find((s) => !(s.month === m && s.year === y));
    if (!prev?.totalValue) return null;
    return {
      label: prev.label,
      abs: r2(grandTotal - prev.totalValue),
      pct: r2(((grandTotal - prev.totalValue) / prev.totalValue) * 100),
    };
  }, [snapshots, grandTotal]);

  const fullClassDist = useMemo(() => {
    const base = [...classDist];
    if (suTotal    > 0) base.push({ name: "Startup",    value: r2(suTotal) });
    if (goldTotal  > 0) base.push({ name: "Oro",        value: r2(goldTotal) });
    if (totalCash  > 0) base.push({ name: "Liquidità",  value: r2(totalCash) });
    return base;
  }, [classDist, suTotal, goldTotal, totalCash]);

  // Drift a due livelli:
  // - ETF: peso effettivo vs sotto-portafoglio ETF (incluso l'ETF oro se il suo
  //   target è ETF-relative, mai l'oro fisico)
  // - Oro / Bitcoin a target sul patrimonio: peso effettivo vs grandTotal
  const drift = useMemo(() => {
    const pct = (v, base) => (base > 0 ? (v / base) * 100 : 0);
    const positions = [
      // Target sul sotto-portafoglio ETF.
      ...etfPortfolioAssets.map((a) => ({
        name: a.name,
        actualPct: pct((a.lastPrice || 0) * (a.quantity || 0), etfSubTotal),
        targetPct: a.targetWeight || 0,
      })),
      // Target sul patrimonio totale (Bitcoin, …).
      ...totalTargetAssets.map((a) => ({
        name: a.name,
        actualPct: pct((a.lastPrice || 0) * (a.quantity || 0), grandTotal),
        targetPct: a.targetWeight || 0,
      })),
    ];
    // L'oro col target sul patrimonio pesa come ETF + fisico.
    if (goldOnTotal && goldEtf.identifier) {
      positions.push({
        name: goldEtf.name,
        actualPct: pct(goldEtfValue + physGoldValue, grandTotal),
        targetPct: goldEtf.targetWeight || 0,
      });
    }
    return calcDrift(positions);
  }, [etfPortfolioAssets, totalTargetAssets, etfSubTotal, goldEtfValue, physGoldValue, grandTotal, goldEtf, goldOnTotal]);

  const driftMax = drift.max;
  const driftOver = driftMax > driftThreshold(settings.rebalanceBand ?? 0);

  // Livello 1: oro (ETF + fisico) + asset a target totale (Bitcoin, …)
  const rebalanceTwoLevel = useMemo(() => {
    const items = [];
    if (goldOnTotal && goldEtf.identifier && goldEtf.lastPrice) {
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
    return calcRebalancingTwoLevel(etfPortfolioAssets, items, grandTotal, etfSubTotal, monthBudget,
      settings.rebalanceBand ?? 0);
  }, [etfPortfolioAssets, totalTargetAssets, goldEtf, goldEtfValue, physGoldValue, grandTotal, etfSubTotal, monthBudget, goldOnTotal, settings.rebalanceBand]);

  const projData = useMemo(() => projectionScenarios({
    start: grandTotal, monthly: projMonthly, baseReturn: projReturn, years: projYears,
    inflation: settings.inflation ?? 0,
    withdrawAfter: projWithdraw ? projWithdrawAfter : null,
    withdrawMonthly: projWithdrawMonthly,
  }), [grandTotal, projMonthly, projReturn, projYears, settings.inflation,
       projWithdraw, projWithdrawAfter, projWithdrawMonthly]);

  // La proiezione è un intervallo, non tre curve indipendenti: una banda
  // pessimistico→ottimistico più la linea dello scenario base.
  const projChartData = useMemo(
    () => projData.map((d) => ({ ...d, range: [d.pessimistic, d.optimistic] })),
    [projData]);

  const projDepletion = useMemo(
    () => (projWithdraw ? depletionYear(projData) : null), [projWithdraw, projData]);
  const finalVal     = projData.at(-1)?.base ?? 0;
  const totalContrib = grandTotal + projMonthly * 12 * projYears;
  const projGain     = finalVal - totalContrib;
  const projROI      = totalContrib > 0 ? (projGain / totalContrib) * 100 : 0;

  // ---- Finestra temporale delle analisi ----
  // Le funzioni di metrics.js sono pure e prendono un array: basta tagliarlo
  // prima. `snapshots` resta intatto per Overview, che mostra sempre tutto.
  const [period, setPeriod] = useState("all");
  const anaSnaps = useMemo(() => sliceSnapshots(snapshots, period), [snapshots, period]);

  const histForRisk = useMemo(() => buildHistory(anaSnaps), [anaSnaps]);
  const riskObs = useMemo(() => calcReturns(histForRisk).length, [histForRisk]);

  const riskMetrics = useMemo(() => {
    const rf = (settings.riskFree ?? 3) / 100;
    return {
      cagr:    calcCAGR(histForRisk),
      vol:     calcVolatility(histForRisk),
      mdd:     calcMaxDrawdown(histForRisk),
      sharpe:  calcSharpe(histForRisk, rf),
      sortino: calcSortino(histForRisk, rf),
      obs:     riskObs,
      quality: riskQuality(riskObs),
    };
  }, [histForRisk, riskObs, settings.riskFree]);

  const { data: snapshotChartData, assetIds, allIds } =
    useMemo(() => buildChartData(snapshots), [snapshots]);

  // Palette del tema corrente. Lo slot dipende dalla posizione dell'asset, non dal suo valore.
  const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
  const seriesColor = (i) => palette[i % palette.length];

  // Patrimonio in euro nel tempo (asse unico, valuta): il dato che si guarda per primo.
  const patrimonioData = useMemo(
    () => snapshots.map((s) => ({ label: s.label, value: r2(s.totalValue || 0) })),
    [snapshots]);

  // ---- Registro movimenti ----
  const txOptions = useMemo(() => {
    const list = storedAssets.map((a) => ({ key: txKey(a), name: a.name }));
    if (storedGoldEtf.identifier || storedGoldEtf.quantity > 0) {
      list.push({ key: txKey(storedGoldEtf), name: storedGoldEtf.name });
    }
    return list;
  }, [storedAssets, storedGoldEtf]);

  const txNameByKey = useMemo(
    () => Object.fromEntries(txOptions.map((o) => [o.key, o.name])), [txOptions]);

  const txSorted = useMemo(
    () => [...transactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [transactions]);

  const txRealized = useMemo(() => portfolioRealized(transactions), [transactions]);

  // `withHolding` teneva solo quantità e prezzo di carico e buttava via il
  // resto: realizzato, dividendi e commissioni erano calcolati per ogni asset e
  // non arrivavano mai a schermo. Qui si conservano, indicizzati per chiave.
  const holdingByKey = useMemo(() => {
    const m = {};
    for (const a of [...storedAssets, storedGoldEtf]) {
      const h = holdingFor(a, transactions);
      if (h.fromTx) m[txKey(a)] = h;
    }
    return m;
  }, [storedAssets, storedGoldEtf, transactions]);

  // Flusso finale dell'XIRR: solo le posizioni che hanno un registro. Sommarci
  // anche quelle inserite a mano gonfierebbe l'incasso finale senza i relativi
  // esborsi, e il rendimento risulterebbe assurdo.
  const txCurrentValue = useMemo(() => {
    const keys = new Set(transactions.map((t) => t.assetKey));
    return r2([...assets, goldEtf].reduce(
      (s, a) => keys.has(txKey(a)) ? s + (a.lastPrice || 0) * (a.quantity || 0) : s, 0));
  }, [transactions, assets, goldEtf]);

  const txXirr = useMemo(() => xirr(portfolioCashFlows(
    transactions, txCurrentValue, new Date().toISOString().slice(0, 10))),
    [transactions, txCurrentValue]);

  // ---- Analisi storiche (tutte derivate dagli snapshot) ----
  // Rendimento del periodo scelto, composto e al netto dei versamenti. Il CAGR
  // resta la lettura annualizzata; su una finestra corta è questo il numero che
  // risponde a "come sto andando".
  const periodRet = useMemo(() => periodReturn(anaSnaps), [anaSnaps]);

  // Concentrazione sul patrimonio: la torta per classe non la mostra, perché
  // cinque ETF azionari globali sono cinque fette ma una scommessa sola.
  const concentration = useMemo(() => calcConcentration(
    [...assets, goldEtf]
      .filter((a) => a?.lastPrice && a?.quantity)
      .map((a) => ({ name: a.name, value: a.lastPrice * a.quantity })),
    grandTotal), [assets, goldEtf, grandTotal]);

  const ddSeries      = useMemo(() => drawdownSeries(anaSnaps), [anaSnaps]);
  const allocSeries   = useMemo(() => allocationOverTime(anaSnaps), [anaSnaps]);
  const contribByAsset= useMemo(() => contributionByAsset(anaSnaps), [anaSnaps]);
  const returnsGrid   = useMemo(() => monthlyReturnsGrid(anaSnaps), [anaSnaps]);
  const benchSeries   = useMemo(
    () => benchmarkSeries(anaSnaps, settings.benchmarkKey), [anaSnaps, settings.benchmarkKey]);

  // ---- Fisco ----
  // Metadati per chiave: servono a sapere la categoria fiscale di ogni titolo.
  const assetMetaByKey = useMemo(() => {
    const m = {};
    [...assets, goldEtf].forEach((a) => { if (a?.name) m[txKey(a)] = a; });
    return m;
  }, [assets, goldEtf]);

  const taxCfg = useMemo(() => ({
    ...DEFAULT_TAX,
    rate: settings.taxRate ?? DEFAULT_TAX.rate,
    bollo: settings.taxBollo ?? DEFAULT_TAX.bollo,
  }), [settings.taxRate, settings.taxBollo]);

  const fiscal = useMemo(
    () => taxReport(transactions, assetMetaByKey, taxCfg),
    [transactions, assetMetaByKey, taxCfg]);

  // Imposta latente: quanto resterebbe vendendo tutto oggi. Solo sulle posizioni
  // quotate — startup e oro fisico non hanno un prezzo di mercato affidabile.
  const latent = useMemo(() => latentTax(
    [...assets, goldEtf]
      .filter((a) => a?.lastPrice && a?.quantity)
      .map((a) => ({
        value: a.lastPrice * a.quantity,
        cost: (a.costBasis || 0) * a.quantity,
        asset: a,
      })), taxCfg), [assets, goldEtf, taxCfg]);

  // totals.val comprende già l'ETF oro (vedi calcTotals): sommarlo di nuovo
  // raddoppierebbe la base del bollo.
  const bollo = useMemo(() => bolloTitoli(totals.val, taxCfg), [totals.val, taxCfg]);

  // ---- Costi ----
  // I tre pezzi esistevano già, in tre punti diversi, e non venivano mai
  // sommati. Restano però su due orizzonti diversi e mescolarli darebbe un
  // numero senza significato: il bollo e l'abbonamento sono ricorrenti annui,
  // le commissioni sono quanto si è pagato finora. Si tengono separati.
  const costs = useMemo(() => {
    const recurringYear = r2(bollo + (settings.startupSubscription ?? 0));
    const paidToDate    = r2(txRealized.fees + startupStats.feesTot);
    return {
      bollo,
      subscription: r2(settings.startupSubscription ?? 0),
      txFees: txRealized.fees,
      startupFees: startupStats.feesTot,
      recurringYear,
      paidToDate,
      // L'incidenza si misura sui costi ricorrenti: è quella che erode il
      // rendimento ogni anno, mentre le commissioni sono già state pagate.
      recurringPct: grandTotal > 0 ? r2((recurringYear / grandTotal) * 100) : null,
    };
  }, [bollo, settings.startupSubscription, txRealized.fees, startupStats.feesTot, grandTotal]);

  // Mesi mancanti fra il primo e l'ultimo snapshot: un buco nella serie non si
  // vede sul grafico (i punti si toccano lo stesso) ma falsa i rendimenti,
  // perché due mesi di variazione vengono letti come uno.
  const snapshotGaps = useMemo(() => {
    if (snapshots.length < 2) return [];
    const have = new Set(snapshots.map((s) => `${s.year}-${s.month}`));
    const last = snapshots.at(-1);
    const out = [];
    let { year, month } = snapshots[0];
    for (;;) {
      month++;
      if (month > 12) { month = 1; year++; }
      if (year > last.year || (year === last.year && month >= last.month)) break;
      if (!have.has(`${year}-${month}`)) out.push({ year, month, label: `${MONTH_LABELS_IT[month - 1]} ${year}` });
    }
    return out;
  }, [snapshots]);

  // Scarto dal riferimento a oggi, in punti percentuali di indice.
  const benchGap = useMemo(() => {
    const last = benchSeries.at(-1);
    return last && last.benchmark != null ? r2(last.portfolio - last.benchmark) : null;
  }, [benchSeries]);

  // Dividendi incassati sul costo delle posizioni che li hanno prodotti: dice
  // quanto rende oggi il capitale investito allora, non il prezzo di mercato.
  const yieldOnCost = useMemo(() => {
    if (!txRealized.income) return null;
    const keys = new Set(transactions.map((t) => t.assetKey));
    const cost = [...assets, goldEtf].reduce(
      (s, a) => keys.has(txKey(a)) ? s + (a.costBasis || 0) * (a.quantity || 0) : s, 0);
    return cost > 0 ? r2((txRealized.income / cost) * 100) : null;
  }, [txRealized.income, transactions, assets, goldEtf]);

  const growthRows = useMemo(() => growthAttribution(snapshots), [snapshots]);
  const growthTotals = useMemo(() => ({
    contrib: r2(growthRows.reduce((a, x) => a + x.contrib, 0)),
    market:  r2(growthRows.reduce((a, x) => a + x.market, 0)),
  }), [growthRows]);

  const assetNameMap = useMemo(() => {
  const m = {};
  assets.forEach((a) => {
    m[snapKey(a)] = a.chartLabel || a.name.split(" ").slice(0, 3).join(" ");
  });

  if (goldEtf.identifier) {
    m[snapKey(goldEtf)] = goldEtf.name.split(" ").slice(0, 3).join(" ");
  }

  // Le righe non quotate compaiono nei grafici per chiave: senza etichetta la
  // legenda mostrerebbe lo slug.
  allIds.filter(isSynthetic).forEach((k) => { m[k] = syntheticLabel(k); });

  return m;
}, [assets, goldEtf, allIds]);

  // Solo gli ETF classici: gli asset a target totale (Bitcoin) vivono nella
  // sezione Oro & Bitcoin, insieme all'oro con cui condividono la logica di peso.
  const filteredAssets = useMemo(() =>
    search.trim()
      ? etfAssets.filter((a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          (a.identifier || "").toLowerCase().includes(search.toLowerCase()))
      : etfAssets,
    [etfAssets, search]);

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
  }, [fetchOne, setAssets, setGoldEtf]);

  const intervalRef = useRef(null);
  useEffect(() => {
    // Read-only: si mostrano i prezzi salvati dal proprietario, niente refresh
    // (aggiornerebbe lo stato locale mostrando dati che il proprietario non ha).
    // Si aspetta la config: a mount gli asset arrivano solo dalla cache
    // localStorage, che su un browser nuovo è vuota — e il primo refresh
    // sarebbe slittato di 15 minuti.
    if (readOnly || !configLoaded) return;
    if (assetsRef.current.length > 0 || goldEtfRef.current.identifier) fetchAllPrices();
    // Try to refresh physical gold spot on load too
    fetchGoldSpotPrice().catch(() => {});
    intervalRef.current = setInterval(() => {
      fetchAllPrices();
      fetchGoldSpotPrice().catch(() => {});
    }, AUTO_REFRESH_MS);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded]);

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
        // Liquidità, oro fisico e startup sono dentro `totalValue` da sempre:
        // senza una riga il loro movimento veniva attribuito al mercato (un
        // acquisto pagato con la liquidità risultava una perdita, un versamento
        // un guadagno). Vedi syntheticRows in metrics.js.
        ...syntheticRows({
          totalCash,
          physGoldGrams: physGold.grams || 0,
          physGoldPricePerGram: physGold.pricePerGram18kt || 0,
          startupsValue: suTotal,
        }),
      ],
    };
  }, [assets, grandTotal, goldEtf, totalCash, physGold, suTotal]);

  const saveMonthlySnapshot = useCallback(async () => {
    const snapshotData = buildSnapshot();
    const label = snapshotData.label;
    setSnapSaving(true);
    try {
      const res  = await apiFetch("/api/snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshotData),
      });
      const json = await res.json();
      if (!json.ok) throw new Error("Risposta non valida");
      const updated = await apiFetch("/api/snapshots").then((r) => r.json());
      if (Array.isArray(updated)) setSnapshots(updated);
      showToast("ok", `✓ Snapshot "${label}" salvato`);
    } catch (e) {
      showToast("err", `Errore: ${e.message}`);
    } finally {
      setSnapSaving(false);
    }
  }, [buildSnapshot, showToast]);

  // ---- Auto-save config sul server (debounce 1.5s) ----
  // Ogni modifica (asset, cash, oro, startup) viene persistita in data/config.json.
  // In più aggiorna in automatico lo snapshot del mese corrente (upsert per mese/anno),
  // così lo storico si costruisce da solo: apri, aggiorni, chiudi.
  useEffect(() => {
    // In vista condivisa non si scrive mai: nessun auto-save, nessun snapshot.
    if (!configLoaded || readOnly) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: CONFIG_VERSION,
            totalCash, startups, assetClasses, physGold, settings, transactions,
            // Si salva sempre ciò che l'utente ha inserito, mai la posizione
            // ricalcolata dai movimenti: il derivato si rifà a ogni load.
            assets: storedAssets, goldEtf: storedGoldEtf,
          }),
        });
        if (!res.ok) throw new Error(`config HTTP ${res.status}`);
        setLastSaved(new Date());

        // Auto-snapshot mese corrente (solo se ci sono prezzi)
        const snap = buildSnapshot();
        if (snap.assets.length > 0) {
          const sres = await apiFetch("/api/snapshot", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snap),
          });
          if (!sres.ok) throw new Error(`snapshot HTTP ${sres.status}`);
          const updated = await apiFetch("/api/snapshots").then((r) => r.json());
          if (Array.isArray(updated)) setSnapshots(updated);
        }
        setSaveErr(null);
      } catch (e) {
        // Prima era un catch muto: un 401 (token scaduto) o un 500 passavano
        // inosservati e l'utente credeva di aver salvato.
        setSaveErr(e.message || "salvataggio fallito");
      }
    }, 1500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, storedAssets, startups, totalCash, assetClasses, storedGoldEtf,
      physGold, settings, transactions]);

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
        const res  = await apiFetch("/api/snapshot", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        });
        if ((await res.json()).ok) count++;
      }
      const updated = await apiFetch("/api/snapshots").then((r) => r.json());
      if (Array.isArray(updated)) setSnapshots(updated);
      showToast("ok", `✓ Importati ${count} snapshot`);
    } catch (e) {
      showToast("err", `Errore: ${e.message}`);
    } finally {
    }
  }, [showToast]);

  // ---- Config export/import ----
  const exportConfig = useCallback(() => {
    const config = {
      version: CONFIG_VERSION, exportedAt: new Date().toISOString(),
      // `settings` è nell'export perché ne fa parte: senza, un giro
      // export → import perdeva in silenzio aliquota, benchmark, banda di
      // ribilanciamento, inflazione, tasso privo di rischio e abbonamento.
      totalCash, startups, assetClasses, physGold, transactions, settings,
      assets: storedAssets, goldEtf: storedGoldEtf,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio_config_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("ok", "✓ Configurazione esportata");
  }, [storedAssets, startups, totalCash, assetClasses, storedGoldEtf, physGold, transactions, settings, showToast]);

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
      // Un export pre-v4 non ha il registro: si azzera, altrimenti i movimenti
      // di un portafoglio resterebbero appiccicati a quello importato.
      setTx(Array.isArray(config.transactions) ? config.transactions : []);
      // Gli export senza `settings` (fino alla v4) lasciano le preferenze
      // correnti; le chiavi mancanti in un file più vecchio prendono il default.
      if (config.settings) setSettings({ ...DEFAULT_SETTINGS, ...config.settings });
      showToast("ok", `✓ Configurazione importata (${config.exportedAt?.slice(0,10) ?? "?"})`);
    } catch (e) {
      showToast("err", `Errore: ${e.message}`);
    }
    // I setter di useLS sono setter di useState: identità stabile, deps innocue.
  }, [setAssets, setSU, setCash, setAC, setGoldEtf, setPhysGold, setTx, setSettings, showToast]);


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

  // ---- Snapshot: gestione manuale ----
  const refreshSnapshots = useCallback(async () => {
    const updated = await apiFetch("/api/snapshots").then((r) => r.json());
    if (Array.isArray(updated)) setSnapshots(updated);
  }, []);

  const saveSnapshotManual = useCallback(async (snap) => {
    try {
      const res = await apiFetch("/api/snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snap),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshSnapshots();
      showToast("ok", `✓ Snapshot "${snap.label}" salvato`);
    } catch (e) {
      showToast("err", `Errore: ${e.message}`);
    }
  }, [refreshSnapshots, showToast]);

  const deleteSnapshot = useCallback(async (s) => {
    if (!window.confirm(`Eliminare lo snapshot "${s.label}"? Lo storico non è recuperabile.`)) return;
    try {
      const res = await apiFetch(`/api/snapshot/${s.year}/${s.month}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshSnapshots();
      // Mancava la conferma: l'unica azione distruttiva dello storico si
      // concludeva in silenzio, e la riga sparita era l'unico riscontro.
      showToast("ok", `✓ Snapshot "${s.label}" eliminato`);
    } catch (e) {
      showToast("err", `Errore: ${e.message}`);
    }
  }, [refreshSnapshots, showToast]);

  // Il primo movimento di un asset che aveva la posizione inserita a mano deve
  // aggiungersi a quella posizione, non sostituirla: si registra prima la riga
  // di partenza (vedi seedRows).
  const saveTx = (t) => {
    const isNew = !transactions.some((x) => x.id === t.id);
    const seeds = isNew ? seedRows(new Set([t.assetKey])) : [];
    setTx((prev) => {
      const idx = prev.findIndex((x) => x.id === t.id);
      return idx >= 0 ? prev.map((x) => x.id === t.id ? t : x) : [...prev, ...seeds, t];
    });
  };
  const deleteTx = (id) => setTx((prev) => prev.filter((t) => t.id !== id));

  // Chiude il ciclo del ribilanciamento: gli acquisti proposti diventano
  // movimenti veri. Prima il piano restava un foglietto e le quantità si
  // correggevano a mano, senza che nulla registrasse se era stato seguito.
  const applyRebalance = () => {
    const { itemBuys, etfRebalance } = rebalanceTwoLevel;
    const date = new Date().toISOString().slice(0, 10);
    const rows = [
      ...itemBuys
        .filter((it) => it.buy > 0 && it.price > 0)
        .map((it) => ({ name: it.name, price: it.price, amount: it.buy })),
      ...etfRebalance.actions
        .filter((a) => a.monthlyBuy > 0 && a.lastPrice > 0)
        .map((a) => ({ name: a.name, price: a.lastPrice, amount: a.monthlyBuy })),
    ];
    if (!rows.length) return;

    const totale = r2(rows.reduce((s, x) => s + x.amount, 0));
    if (!window.confirm(
      `Registrare ${rows.length} acquisti per ${fmt(totale)} in data odierna?\n\n` +
      rows.map((x) => `• ${x.name}: ${fmt(x.amount)}`).join("\n") +
      "\n\nLe quantità degli asset coinvolti passeranno a essere calcolate dai movimenti."
    )) return;

    // Un asset senza movimenti prende la posizione dai suoi campi; appena ne ha
    // uno la prende dal registro. Senza la riga di partenza, il primo acquisto
    // registrato *sostituirebbe* la posizione invece di aggiungersi: 94 quote
    // diventerebbero le 3 appena comprate.
    setTx((prev) => [...prev, ...seedRows(new Set(rows.map((x) => txKey({ name: x.name })))),
      ...rows.map((x) => ({
        id: newId(), date, assetKey: txKey({ name: x.name }), type: "buy",
        quantity: r2(x.amount / x.price), price: x.price, fee: 0,
        notes: "Ribilanciamento",
      }))]);
    goTab("transactions");
  };

  // Punto di partenza del registro: una riga d'acquisto per ogni posizione già
  // inserita a mano, così quantità e PMC restano identici e da lì in avanti si
  // registrano i movimenti veri. Datata al primo snapshot, che è il momento più
  // antico di cui la dashboard abbia memoria.
  // `keys` limita il seed agli asset che stanno per ricevere un movimento.
  const seedRows = (keys = null) => {
    const first = snapshots[0];
    const date = first
      ? `${first.year}-${String(first.month).padStart(2, "0")}-01`
      : new Date().toISOString().slice(0, 10);
    const already = new Set(transactions.map((t) => t.assetKey));
    return [...storedAssets, ...(storedGoldEtf.identifier ? [storedGoldEtf] : [])]
      .filter((a) => (a.quantity || 0) > 0 && !already.has(txKey(a))
                  && (!keys || keys.has(txKey(a))))
      .map((a) => ({
        id: newId(), date, assetKey: txKey(a), type: "buy",
        quantity: a.quantity, price: a.costBasis || 0, fee: 0,
        notes: "Posizione iniziale",
      }));
  };

  const seedTransactions = () => {
    const seeds = seedRows();
    if (seeds.length) setTx((prev) => [...prev, ...seeds]);
  };

  const isLoading = Object.keys(loading).length > 0;
  const toggleLine = (dataKey) => setHiddenLines((prev) => {
    const next = new Set(prev); next.has(dataKey) ? next.delete(dataKey) : next.add(dataKey); return next;
  });

  const isEmpty = assets.length === 0 && goldTotal === 0 && startups.length === 0 && totalCash === 0;

  // Fuori dalla vista condivisa: le impostazioni perché sono personali e
  // modificabili, il registro movimenti perché è il dettaglio di quando e a
  // quanto si è comprato — si condivide il portafoglio, non lo storico ordini.
  const visibleTabs = readOnly
    ? TABS.filter((t) => t.id !== "settings" && t.id !== "transactions")
    : TABS;

  // ---- Routing per tab sull'hash ----
  // La tab era solo stato React: nessun link diretto, il tasto Indietro usciva
  // dall'app e un link condiviso atterrava sempre su Overview. L'hash basta e
  // non richiede un router: il path resta libero per /p/<token>, che AuthGate
  // legge prima di montare App.
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.replace(/^#\/?/, "");
      return visibleTabs.some((t) => t.id === id) ? id : null;
    };
    const sync = () => setTab(fromHash() ?? "overview");
    sync();                                  // hash iniziale (deep link)
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  // visibleTabs cambia solo con readOnly, che è fisso per tutta la vita di App.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTab = useCallback((id) => {
    // Lo stato si aggiorna subito invece di aspettare il giro di `hashchange`:
    // quell'evento è asincrono, e far dipendere il render da lui rendeva il
    // cambio di tab visibile solo al tick successivo.
    setTab(id);
    // Assegnare l'hash aggiunge una voce di cronologia, così Indietro torna
    // alla tab precedente invece di uscire dall'app. L'hashchange che ne segue
    // rimette lo stesso valore: è un no-op.
    window.location.hash = `#/${id}`;
  }, []);

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
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => { goTab("portfolio"); setAssetModal({}); }} style={{ fontSize: 15, padding: "10px 24px" }}>
              <Plus size={16}/> Inizia ad aggiungere asset
            </button>
          )}
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
          <div className="hero-grid">
            <KpiCard hero label="Patrimonio totale" value={fmt(grandTotal)} icon={Wallet}
              sub={`Liquidità: ${fmt(totalCash)}`} color="blue"
              trend={monthDelta?.pct} trendLabel={monthDelta ? `${fmt(monthDelta.abs)} vs ${monthDelta.label}` : null}
              footer={
                <div className="hero-chips">
                  <span className={`chip ${driftOver ? "chip-warn" : "chip-ok"}`}
                    title={drift.worst
                      ? `Scostamento maggiore: ${drift.worst.name} (${drift.worst.actualPct.toFixed(1)}% contro un target del ${drift.worst.targetPct}%)`
                      : "Nessun target impostato"}>
                    {driftOver ? <AlertTriangle size={12}/> : <CheckCircle size={12}/>}
                    Deriva max {driftMax.toFixed(1)} pt
                  </span>
                  <span className="chip">
                    <Camera size={12}/> {snapshots.length} snapshot
                  </span>
                </div>
              }/>
            <KpiCard compact label="ETF & Asset quotati" value={fmt(totals.val, true)} icon={Activity}
              trend={totals.ret * 100} color="blue"/>
            <KpiCard compact label="Oro" value={fmt(goldTotal, true)} icon={Shield}
              color={goldEtfValue >= goldEtfCost ? "green" : "red"}
              sub={goldTotal > 0 && grandTotal > 0 ? `${((goldTotal / grandTotal) * 100).toFixed(1)}% del patrimonio` : null}
              trend={goldEtfPerfPct}/>
            <KpiCard compact label="Startup attive" value={fmt(suTotal, true)} icon={Briefcase}
              color={startupStats.roiOverallPct != null && startupStats.roiOverallPct < 0 ? "red" : "blue"}
              sub={`Commissioni: ${fmt(suFees)} · Abbonamento: ${fmt(suAbbonamenti)}`}
              footer={startups.length > 0 && (
                <div className="kpi-sub" style={{ marginTop: 6 }}>
                  {startupStats.allClosed ? "Risultato finale" : "Complessivo"}:{" "}
                  <strong style={{ color: startupStats.pnlOverall >= 0 ? "var(--green)" : "var(--red)" }}>
                    {fmt(startupStats.pnlOverall)}
                  </strong>
                  {startupStats.closed.length > 0 && (
                    <> · realizzato {fmt(startupStats.pnlTot)} su {startupStats.closed.length} conclus{startupStats.closed.length === 1 ? "a" : "e"}</>
                  )}
                </div>
              )}/>
          </div>

          {patrimonioData.length > 1 && (
            <div className="section-card">
              <h3 className="section-title"><TrendingUp size={16}/> Andamento patrimonio</h3>
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={patrimonioData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="gPatrimonio" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={palette[0]} stopOpacity={0.25}/>
                        <stop offset="95%" stopColor={palette[0]} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false}/>
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--text-muted)"/>
                    <YAxis tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)" domain={["auto", "auto"]} width={56}/>
                    <ReTooltip content={<CustomTooltip/>}/>
                    <Area type="monotone" dataKey="value" name="Patrimonio"
                      stroke={palette[0]} strokeWidth={2} fill="url(#gPatrimonio)"
                      dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--bg-card)" }}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="hint-text" style={{ marginTop: 4 }}>
                Valore totale del portafoglio a ogni snapshot mensile. Include i versamenti:
                per separare mercato e versamenti guarda il grafico "Crescita" più sotto.
              </p>
            </div>
          )}

          <div className="grid-2">
            {fullClassDist.length > 0 && (
              <div className="section-card">
                <h3 className="section-title"><PieChartIcon size={16}/> Asset allocation</h3>
                <div style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={fullClassDist} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" outerRadius={95} innerRadius={52}
                        stroke="var(--bg-card)" strokeWidth={2}>
                        {fullClassDist.map((_, i) => <Cell key={i} fill={seriesColor(i)}/>)}
                      </Pie>
                      <ReTooltip formatter={(v, n) => [fmt(v), n]}/>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="alloc-legend">
                  {fullClassDist.map((d, i) => (
                    <div key={d.name} className="alloc-row">
                      <span className="legend-dot" style={{ background: seriesColor(i) }}/>
                      <span className="alloc-name">{d.name}</span>
                      <span className="alloc-val mono">{fmt(d.value)}</span>
                      <span className="alloc-pct mono">
                        {grandTotal > 0 ? ((d.value / grandTotal) * 100).toFixed(1) : "0.0"}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="section-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 className="section-title" style={{ margin: 0 }}><LineChartIcon size={16}/> Prezzi asset — base 100</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {!readOnly && (
                    <>
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
                    </>
                  )}
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
                        <CartesianGrid stroke="var(--border)" vertical={false}/>
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--text-muted)"/>
                        <YAxis tickFormatter={(v) => v + ""} tick={{ fontSize: 10 }} stroke="var(--text-muted)" domain={["auto","auto"]}
                          label={{ value: "Indice (base 100)", angle: -90, position: "insideLeft",
                            style: { fontSize: 10, fill: "var(--text-muted)" }, offset: 10 }}/>
                        <ReTooltip content={<SnapshotTooltip snapshots={snapshots}/>}/>
                        <ReferenceLine y={100} stroke="var(--border2)"/>
                        {assetIds.map((id, i) => (
                          <Line key={id} type="monotone" dataKey={id} name={assetNameMap[id] || id}
                            stroke={seriesColor(i)} strokeDasharray={seriesDash(i)}
                            strokeWidth={focusedLine === id ? 3 : 2}
                            strokeOpacity={focusedLine && focusedLine !== id ? 0.15 : 1}
                            dot={snapshotChartData.length === 1 ? { r: 4 } : false}
                            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--bg-card)" }} hide={hiddenLines.has(id)}/>
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="snapshot-legend">
                    {assetIds.map((id, i) => (
                      <button key={id} className={`legend-item ${hiddenLines.has(id) ? "legend-item--hidden" : ""}`}
                        onClick={() => toggleLine(id)}
                        onMouseEnter={() => setFocusedLine(id)} onMouseLeave={() => setFocusedLine(null)}>
                        <span className={`legend-line ${seriesDash(i) ? "legend-line--dashed" : ""}`}
                          style={{ color: seriesColor(i) }}/>
                        {assetNameMap[id] || id}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="grid-2">
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
          </div>


          {growthRows.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><TrendingUp size={16}/> Crescita: versamenti vs mercato</h3>
              <div className="kpi-mini-row" style={{ marginBottom: 12 }}>
                <span>Versamenti: <strong style={{ color: "var(--blue)" }}>{fmt(growthTotals.contrib)}</strong></span>
                <span>Mercato: <strong style={{ color: growthTotals.market >= 0 ? "var(--green)" : "var(--red)" }}>{fmt(growthTotals.market)}</strong></span>
                <span className="muted" style={{ fontSize: 12 }}>Tutto il patrimonio, dagli snapshot mensili</span>
              </div>
              <div className="chart-legend">
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_CONTRIB }}/>Versamenti</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_GAIN }}/>Mercato in guadagno</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_LOSS }}/>Mercato in perdita</span>
              </div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={growthRows} margin={{ top: 4, right: 16, left: 0, bottom: 4 }} barGap={2}>
                    <CartesianGrid stroke="var(--border)" vertical={false}/>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--text-muted)"/>
                    <YAxis tickFormatter={(v) => `€${(v / 1000).toFixed(1)}k`} tick={{ fontSize: 10 }} stroke="var(--text-muted)" width={56}/>
                    <ReTooltip content={<CustomTooltip/>} cursor={{ fill: "var(--bg-card2)" }}/>
                    <ReferenceLine y={0} stroke="var(--border2)"/>
                    <Bar dataKey="contrib" name="Versamenti" fill={C_CONTRIB} radius={[4, 4, 0, 0]}/>
                    <Bar dataKey="market"  name="Mercato" fill={C_GAIN} radius={[4, 4, 0, 0]}>
                      {growthRows.map((d, i) => (
                        <Cell key={i} fill={d.market >= 0 ? C_GAIN : C_LOSS}/>
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ====================== TAB: PORTFOLIO ======================
  // Le colonne del registro compaiono solo se il registro è in uso: su un
  // portafoglio a posizioni inserite a mano sarebbero due colonne di trattini.
  const hasTxCols = Object.keys(holdingByKey).length > 0;

  const renderPortfolio = () => (
    <div className="tab-content">
      {/* Liquidità */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="section-title" style={{ margin: 0 }}><Wallet size={16}/> Liquidità</h2>
          {!editCash ? (
            !readOnly && <button className="icon-btn" onClick={() => { setCashInput(totalCash); setEditCash(true); }}><Edit2 size={14}/></button>
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
            {totalCash > 0
              ? fmt(totalCash)
              : <span className="muted" style={{ fontSize: "1rem" }}>
                  {readOnly ? "Nessuna liquidità registrata" : "Clicca la matita per inserire la liquidità"}
                </span>}
          </div>
        )}
      </div>

      {/* ETF & Asset */}
      <div className="section-card">
        <div className="table-controls" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}><Briefcase size={16}/> ETF & Asset quotati</h2>
            {etfSubTotal > 0 && <span className="muted" style={{ fontSize: 13 }}>Totale: <strong>{fmt(etfSubTotal)}</strong></span>}
          </div>
          <div className="btn-row">
            {!readOnly && (
              <button className="btn btn-ghost" onClick={() => setACModal(true)} title="Gestisci asset class">
                <Tag size={15}/> Asset class
              </button>
            )}
            {etfAssets.length > 0 && (
              <div className="search-wrap" style={{ maxWidth: 260 }}>
                <Search size={15} className="search-icon"/>
                <input className="search-input" placeholder="Cerca…" value={search} onChange={(e) => setSearch(e.target.value)}/>
                {search && <button className="icon-btn" onClick={() => setSearch("")}><X size={14}/></button>}
              </div>
            )}
            {etfAssets.length > 0 && (
              <button className="btn btn-ghost" onClick={() => exportCSV(etfAssets)}><Download size={15}/> CSV</button>
            )}
            {!readOnly && (
              <button className="btn btn-primary" onClick={() => setAssetModal({})}><Plus size={15}/> Aggiungi asset</button>
            )}
          </div>
        </div>

        {etfAssets.length === 0 ? (
          <EmptyState icon={Briefcase} title="Nessun asset ancora"
            description={readOnly
              ? "Questo portafoglio non contiene asset quotati."
              : "Aggiungi ETF, azioni o altri strumenti finanziari quotati. Il prezzo sarà aggiornato automaticamente se inserisci un ISIN valido."}
            action={readOnly ? null : <button className="btn btn-primary" onClick={() => setAssetModal({})}><Plus size={15}/> Aggiungi il primo asset</button>}/>
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
                    {hasTxCols && (
                      <>
                        <th className="num" title="Utile o perdita già incassati dalle vendite di questo asset, al netto delle commissioni">Realizzato</th>
                        <th className="num" title="Dividendi e cedole incassati da questo asset, al netto di ritenute e spese">Dividendi</th>
                      </>
                    )}
                    <th className="num" title="Peso % sul sotto-portafoglio ETF (escluso oro) — somma 100%">Peso</th>
                    <th className="num">Target</th><th>Classe</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssets.map((a) => {
                    const value  = a.lastPrice ? r2(a.lastPrice * (a.quantity || 0)) : 0;
                    const perfE  = a.costBasis && a.lastPrice ? r2((a.lastPrice - a.costBasis) * (a.quantity || 0)) : 0;
                    const perfP  = a.costBasis && a.lastPrice ? r2(((a.lastPrice - a.costBasis) / a.costBasis) * 100) : 0;
                    // Peso sul solo sotto-portafoglio ETF (gli asset a target
                    // sul patrimonio stanno nella sezione Oro & Bitcoin).
                    const weight = etfSubTotal > 0 ? (value / etfSubTotal) * 100 : 0;
                    const diff   = weight - (a.targetWeight || 0);
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
                        {hasTxCols && (() => {
                          const h = holdingByKey[txKey(a)];
                          return (
                            <>
                              <td className={`num mono ${h?.realized >= 0 ? "pos-text" : "neg-text"}`}>
                                {h?.realized ? fmt(h.realized) : <span className="muted">—</span>}
                              </td>
                              <td className="num mono">
                                {h?.income ? fmt(h.income) : <span className="muted">—</span>}
                              </td>
                            </>
                          );
                        })()}
                        <td className="num mono" title="Peso % sul sotto-portafoglio ETF">
                          {weight.toFixed(1)}%
                        </td>
                        <td className="num">
                          <span className={`target-badge ${Math.abs(diff) > 3 ? (diff > 0 ? "over" : "under") : "ok"}`}
                            title="Target % sul sotto-portafoglio ETF">
                            {a.targetWeight || 0}%
                          </span>
                        </td>
                        <td><span className="class-tag">{a.assetClass}</span></td>
                        <td>
                          {!readOnly && (
                            <div className="row-actions">
                              <button className="icon-btn" onClick={() => setAssetModal(a)}><Edit2 size={14}/></button>
                              <button className="icon-btn danger" onClick={() => { if (window.confirm(`Rimuovere ${a.name}?`)) deleteAsset(a.id); }}>
                                <Trash2 size={14}/>
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {/* L'ETF oro col target ETF-relative pesa sul sotto-portafoglio
                      pur restando nella sezione Oro & Bitcoin: qui in chiaro,
                      altrimenti totale e somma target non tornerebbero. */}
                  {!goldOnTotal && goldEtf.identifier && (
                    <tr className="total-row" style={{ opacity: 0.75 }}>
                      <td colSpan={5}>{goldEtf.name} <span className="muted">(sezione Oro &amp; Bitcoin)</span></td>
                      <td className="num mono">{goldEtfValue > 0 ? fmt(goldEtfValue) : "—"}</td>
                      <td colSpan={hasTxCols ? 4 : 2}></td>
                      <td className="num mono">{goldPct != null ? `${goldPct.toFixed(1)}%` : "—"}</td>
                      <td className="num">
                        <span className="target-badge ok">{goldEtf.targetWeight || 0}%</span>
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  )}
                  <tr className="total-row">
                    <td colSpan={5}><strong>Totale</strong></td>
                    <td className="num mono"><strong>{fmt(etfSubTotal)}</strong></td>
                    <td colSpan={hasTxCols ? 4 : 2}></td>
                    <td className="num mono"><strong>100,0%</strong></td>
                    <td className="num">
                      <span className={`target-badge ${etfTargetSum > 100 ? "over" : "ok"}`}
                        title="Somma dei target: non può superare 100%">
                        {etfTargetSum}%
                      </span>
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {etfTargetSum > 100 && (
              <div className="alert alert-amber" style={{ marginTop: 8 }}>
                <AlertTriangle size={14}/> La somma dei target è {etfTargetSum}%: supera il 100%.
                Riduci i target degli asset per tornare entro il limite.
              </div>
            )}
            <p className="hint-text" style={{ marginTop: 8 }}>
              <strong>Peso</strong>: % sul totale ETF & Asset quotati — la somma è sempre 100%.
              {" "}<strong>Target</strong>: obiettivo in % del sotto-portafoglio ETF — la somma non può superare 100%.
              {!goldOnTotal && goldEtf.identifier &&
                " L'ETF oro ha il target sul sotto-portafoglio: è conteggiato nei totali qui sotto, ma resta nella sezione Oro & Bitcoin."}
            </p>
          </>
        )}
      </div>
      <div className="section-card" style={{ borderColor: goldBtcTotal > 0 ? "rgba(245,158,11,0.4)" : undefined }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Oro &amp; Bitcoin
            </h2>
            {goldBtcTotal > 0 && (
              <div className="kpi-mini-row" style={{ marginBottom: 0 }}>
                <span>Totale: <strong style={{ color: "var(--amber)" }}>{fmt(goldBtcTotal)}</strong></span>
                {grandTotal > 0 && (
                  <span>
                    <strong>{((goldBtcTotal / grandTotal) * 100).toFixed(1)}%</strong>
                    <span className="muted"> del patrimonio</span>
                  </span>
                )}
              </div>
            )}
          </div>
          {!readOnly && (
            <button
              className="btn btn-ghost"
              onClick={refreshGoldPrices}
              disabled={goldLoading || isLoading}
              style={{ fontSize: 13 }}
            >
              <RefreshCw size={14} className={(goldLoading || loading[goldEtf.id]) ? "spin" : ""}/>
              {goldLoading ? "Aggiornamento…" : "Aggiorna prezzi oro"}
            </button>
          )}
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
            {!readOnly && (
              <button className="icon-btn" onClick={() => setGoldEtfModal(true)} title="Configura ETF oro">
                <Edit2 size={14}/>
              </button>
            )}
          </div>

          {!goldEtf.identifier ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              background: "rgba(245,158,11,0.06)", border: "1px dashed rgba(245,158,11,0.3)",
              borderRadius: "var(--radius-sm)", color: "var(--amber)" }}>
              <AlertTriangle size={14}/>
              <span style={{ fontSize: 13 }}>
                {readOnly ? "Nessun ETF oro configurato." : "Configura l'ETF oro inserendo ISIN e quantità."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
                  onClick={() => setGoldEtfModal(true)}>
                  Configura
                </button>
              )}
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
                      {/* Peso: ETF + fisico sul patrimonio, oppure solo ETF sul
                          sotto-portafoglio quotato, secondo la modalità scelta. */}
                      <td className="num mono" title={goldOnTotal ? "ETF oro + oro fisico sul patrimonio totale" : "Solo ETF oro sul sotto-portafoglio ETF"}>
                        {goldPct != null ? `${goldPct.toFixed(2)}%` : "—"}
                        <span className="muted" style={{ fontSize: 10 }}>{goldOnTotal ? " tot" : " etf"}</span>
                      </td>
                      <td className="num">
                        {(() => {
                          const tgt  = goldEtf.targetWeight || 0;
                          const diff = (goldPct ?? 0) - tgt;
                          return (
                            <span className={`target-badge ${Math.abs(diff) > 3 ? (diff > 0 ? "over" : "under") : "ok"}`}
                              title={goldOnTotal ? "Target % sul patrimonio totale" : "Target % sul sotto-portafoglio ETF"}>
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
                {goldOnTotal
                  ? <><strong>Peso</strong>: (ETF oro + oro fisico) in % sul patrimonio totale.
                      {" "}<strong>Target</strong>: obiettivo % sul patrimonio totale. Modificabile dalla matita.</>
                  : <><strong>Peso</strong> e <strong>Target</strong>: % sul sotto-portafoglio ETF & Asset quotati, di cui l'ETF oro fa parte
                      (es. 90% globale / 10% oro). L'oro fisico non entra nel calcolo.</>}
              </p>
            </>
          )}
        </div>

        {/* ---- Oro fisico 18kt ---- */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <div className="gold-sub-header">
            <span className="gold-sub-label">Oro fisico 18kt</span>
            {!readOnly && (
              <button className="icon-btn" onClick={() => setPhysGoldModal(true)} title="Modifica oro fisico">
                <Edit2 size={14}/>
              </button>
            )}
          </div>

          {physGold.grams === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              background: "var(--bg-card2)", border: "1px dashed var(--border)",
              borderRadius: "var(--radius-sm)", color: "var(--text-muted)" }}>
              <span style={{ fontSize: 13 }}>
                Nessun oro fisico registrato.{!readOnly && " Clicca la matita per inserire la grammatura."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
                  onClick={() => setPhysGoldModal(true)}>
                  Aggiungi
                </button>
              )}
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

        {/* ---- Bitcoin & asset con target sul patrimonio ---- */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 16 }}>
          <div className="gold-sub-header">
            <span className="gold-sub-label">Bitcoin</span>
            {!readOnly && (
              <button className="icon-btn" onClick={() => setAssetModal({ targetOnTotal: true, assetClass: "Crypto" })}
                title="Aggiungi asset con target sul patrimonio totale">
                <Plus size={14}/>
              </button>
            )}
          </div>

          {totalTargetAssets.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
              background: "var(--bg-card2)", border: "1px dashed var(--border)",
              borderRadius: "var(--radius-sm)", color: "var(--text-muted)" }}>
              <span style={{ fontSize: 13 }}>
                Nessun Bitcoin registrato.{!readOnly && " Aggiungi un ETP con target in % del patrimonio totale."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
                  onClick={() => setAssetModal({ targetOnTotal: true, assetClass: "Crypto" })}>
                  Aggiungi
                </button>
              )}
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
                      <th className="num">Peso</th><th className="num">Target</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {totalTargetAssets.map((a) => {
                      const value = a.lastPrice ? r2(a.lastPrice * (a.quantity || 0)) : 0;
                      const perfE = a.costBasis && a.lastPrice ? r2((a.lastPrice - a.costBasis) * (a.quantity || 0)) : 0;
                      const perfP = a.costBasis && a.lastPrice ? r2(((a.lastPrice - a.costBasis) / a.costBasis) * 100) : 0;
                      // Peso sul patrimonio totale, come l'oro
                      const weight = grandTotal > 0 ? (value / grandTotal) * 100 : 0;
                      const diff   = weight - (a.targetWeight || 0);
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
                          <td className="num mono">{value > 0 ? `${weight.toFixed(2)}%` : "—"}</td>
                          <td className="num">
                            <span className={`target-badge ${Math.abs(diff) > 3 ? (diff > 0 ? "over" : "under") : "ok"}`}
                              title="Target % sul patrimonio totale">
                              {a.targetWeight || 0}%
                            </span>
                          </td>
                          <td>
                            {!readOnly && (
                              <div className="row-actions">
                                <button className="icon-btn" onClick={() => setAssetModal(a)}><Edit2 size={14}/></button>
                                <button className="icon-btn danger" onClick={() => { if (window.confirm(`Rimuovere ${a.name}?`)) deleteAsset(a.id); }}>
                                  <Trash2 size={14}/>
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint-text" style={{ marginTop: 6 }}>
                <strong>Peso</strong> e <strong>Target</strong>: % sul patrimonio totale, come l'oro.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Startup */}
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}><Activity size={16}/> Investimenti Startup</h2>
            {startups.length > 0 && (
              <div className="kpi-mini-row" style={{ marginBottom: 0 }}>
                <span>Attive: <strong>{startupStats.active.length}</strong></span>
                <span>Concluse: <strong>{startupStats.closed.length}</strong></span>
                <span>Abbonamento: <strong>{fmt(suAbbonamenti)}</strong></span>
                <span>Esborso: <strong>{fmt(startupStats.totalOutlay)}</strong></span>
              </div>
            )}
          </div>
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => setStartupModal({})}><Plus size={15}/> Aggiungi startup</button>
          )}
        </div>

        {startups.length > 0 && (
          <>
            <div className="summary-strip">
              <div className="ss-item">
                <span className="ss-label">Capitale investito</span>
                <span className="ss-value mono">{fmt(startupStats.investedTot)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Commissioni</span>
                <span className="ss-value mono">{fmt(startupStats.feesTot)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Abbonamento</span>
                <span className="ss-value mono">{fmt(startupStats.subscription)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Esborso totale</span>
                <span className="ss-value mono">{fmt(startupStats.totalOutlay)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Recuperato da exit</span>
                <span className="ss-value mono pos-text">{fmt(startupStats.recoveredTot)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Perdite da fallimenti</span>
                <span className="ss-value mono neg-text">{startupStats.failedLoss > 0 ? `−${fmt(startupStats.failedLoss)}` : fmt(0)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">P&amp;L realizzato</span>
                <span className="ss-value mono" style={{ color: startupStats.pnlTot >= 0 ? "var(--green)" : "var(--red)" }}>
                  {startupStats.closed.length > 0 ? fmt(startupStats.pnlTot) : "—"}
                </span>
              </div>
              <div className="ss-item ss-item--strong">
                <span className="ss-label">{startupStats.allClosed ? "Risultato finale" : "P&L complessivo"}</span>
                <span className="ss-value mono" style={{ color: startupStats.pnlOverall >= 0 ? "var(--green)" : "var(--red)" }}>
                  {fmt(startupStats.pnlOverall)}
                </span>
              </div>
              <div className="ss-item ss-item--strong">
                <span className="ss-label">{startupStats.allClosed ? "ROI finale" : "ROI complessivo"}</span>
                <span className="ss-value">
                  {startupStats.roiOverallPct != null ? <Badge value={startupStats.roiOverallPct}/> : <span className="muted mono">—</span>}
                </span>
              </div>
              {/* Le due letture che il ROI da solo non dà su posizioni
                  illiquide: quanto rende all'anno e da quanto è fermo. */}
              <div className="ss-item ss-item--strong"
                title="Rendimento annualizzato dei flussi: tiene conto di quando è entrato e uscito ogni euro. Abbonamento escluso, è un costo comune.">
                <span className="ss-label">IRR</span>
                <span className="ss-value">
                  {suIrr != null ? <Badge value={r2(suIrr * 100)}/> : <span className="muted mono">—</span>}
                </span>
              </div>
              <div className="ss-item"
                title={suHoldings.oldest
                  ? `La più vecchia ancora aperta è ${suHoldings.oldest.name}, da ${suHoldings.oldest.years} anni`
                  : "Serve la data d'investimento"}>
                <span className="ss-label">Durata media</span>
                <span className="ss-value mono">
                  {suHoldings.avgYears != null
                    ? `${suHoldings.avgYears.toFixed(1)} anni`
                    : <span className="muted">—</span>}
                </span>
              </div>
            </div>
            {suHoldings.missingDate > 0 && (
              <p className="hint-text" style={{ marginTop: 8 }}>
                {suHoldings.missingDate === startups.length
                  ? "Nessuna startup ha la data d'investimento: senza, non si possono calcolare IRR e durata."
                  : `${suHoldings.missingDate} startup su ${startups.length} non hanno la data d'investimento e restano fuori da IRR e durata.`}
                {" "}Si aggiunge dal pulsante di modifica della riga.
              </p>
            )}
            <p className="hint-text" style={{ marginTop: 10 }}>
              {startupStats.allClosed
                ? `🏁 Bilancio finale: a fronte di ${fmt(startupStats.totalOutlay)} di esborso complessivo (capitale + commissioni + abbonamento) hai recuperato ${fmt(startupStats.totalValue)}, con un risultato di ${fmt(startupStats.pnlOverall)}.`
                : <>
                    {startupStats.closed.length === 0
                      ? "Nessuna startup conclusa: P&L realizzato e ROI su concluse si calcolano su Exit e Fallimenti."
                      : startupStats.pnlTot >= 0
                        ? `✅ Sulle ${startupStats.closed.length} startup concluse hai recuperato ${fmt(startupStats.recoveredTot)} a fronte di ${fmt(startupStats.closedCost)} di costo totale (commissioni incluse).`
                        : `⚠ Sulle ${startupStats.closed.length} startup concluse hai recuperato ${fmt(startupStats.recoveredTot)} a fronte di ${fmt(startupStats.closedCost)} di costo totale (commissioni incluse): il capitale non è ancora rientrato.`}
                    {" "}Il ROI complessivo include l'abbonamento ({fmt(startupStats.subscription)}) e valorizza le {startupStats.active.length} attive a {fmt(startupStats.activeValue)}: diventerà il risultato definitivo quando tutte saranno chiuse.
                  </>}
              {" "}Le startup attive ({fmt(startupStats.activeVal)}) sono valorizzate al costo nel patrimonio; le concluse ne escono — l'incasso di un'exit va inserito a mano in liquidità.
            </p>
          </>
        )}

        {startups.length === 0 ? (
          <EmptyState icon={Activity} title="Nessuna startup"
            description={readOnly
              ? "Questo portafoglio non contiene investimenti in startup."
              : "Traccia gli investimenti in startup e fondi di venture capital. Inserisci l'importo investito e le eventuali commissioni."}
            action={readOnly ? null : <button className="btn btn-primary" onClick={() => setStartupModal({})}><Plus size={15}/> Aggiungi startup</button>}/>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th><th>Stato</th>
                  <th className="num">Investito</th><th className="num">Commissioni</th><th className="num">Costo totale</th>
                  <th className="num">Recuperato / Valore</th><th className="num">P&amp;L</th><th className="num">ROI</th><th></th>
                </tr>
              </thead>
              <tbody>
                {startupStats.rows.map((s) => (
                  <tr key={s.id} className={s.closed ? "row-closed" : ""}>
                    <td className="asset-name">
                      {s.name}
                      {s.exitNotes && <span className="note-mark" title={s.exitNotes}><Info size={12}/></span>}
                    </td>
                    <td><StatusTag status={s.status}/></td>
                    <td className="num mono"><strong>{fmt(s.invested)}</strong></td>
                    <td className="num mono">{fmt(s.fee)}</td>
                    <td className="num mono">{fmt(s.totalCost)}</td>
                    {/* Sulle attive con valutazione: valore stimato e P&L non realizzato, in muted. */}
                    <td className="num mono">
                      {s.closed ? fmt(s.recovered)
                        : s.currentValue != null ? <span className="muted" title="Valutazione attuale stimata">{fmt(s.value)}</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className={`num mono ${s.pnl == null ? "" : s.pnl >= 0 ? "pos-text" : "neg-text"}`}>
                      {s.closed ? <strong>{fmt(s.pnl)}</strong>
                        : s.currentValue != null ? <span className="muted" title="Non realizzato">{fmt(s.unrealPnl)}</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num">
                      {s.closed && s.roiPct != null ? <Badge value={s.roiPct}/>
                        : !s.closed && s.currentValue != null && s.unrealRoiPct != null ? <Badge value={s.unrealRoiPct}/>
                        : <span className="muted mono">—</span>}
                    </td>
                    <td>
                      {!readOnly && (
                        <div className="row-actions">
                          <button className="icon-btn" onClick={() => setStartupModal(s)}><Edit2 size={14}/></button>
                          <button className="icon-btn danger" onClick={() => { if (window.confirm(`Rimuovere ${s.name}?`)) deleteSU(s.id); }}>
                            <Trash2 size={14}/>
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <td colSpan={2}><strong>Totale</strong> <span className="muted">(abbonamento escluso)</span></td>
                  <td className="num mono"><strong>{fmt(startupStats.investedTot)}</strong></td>
                  <td className="num mono"><strong>{fmt(startupStats.feesTot)}</strong></td>
                  <td className="num mono"><strong>{fmt(startupStats.costTot)}</strong></td>
                  <td className="num mono"><strong>{fmt(startupStats.totalValue)}</strong></td>
                  <td className="num mono" style={{ color: startupStats.pnlNoSub >= 0 ? "var(--green)" : "var(--red)" }}>
                    <strong>{fmt(startupStats.pnlNoSub)}</strong>
                  </td>
                  <td className="num">{startupStats.roiNoSubPct != null ? <Badge value={startupStats.roiNoSubPct}/> : <span className="muted mono">—</span>}</td>
                  <td></td>
                </tr>
                {/* Il bilancio complessivo (abbonamento + attive a valutazione) sta
                    già nella summary-strip in testa: qui restano i totali di colonna. */}
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Config export/import — riservato al proprietario */}
      {!readOnly && (
      <div className="section-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h3 className="section-title" style={{ margin: 0 }}><Settings size={16}/> Configurazione portafoglio</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Il portafoglio viene <strong>salvato automaticamente sul server</strong> a ogni modifica.
              Export/import JSON servono solo come backup o per migrare su un'altra installazione.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
      )}
    </div>
  );

  // ====================== TAB: ANALISI ======================
  // Le metriche di rischio stavano in Overview, dove occupavano quanto il
  // grafico del patrimonio pur essendo la parte che si consulta di rado. Qui
  // stanno insieme a ciò che serve per leggerle: confronto, drawdown, chi ha
  // prodotto il risultato, come è cambiata la composizione.
  const renderAnalysis = () => (
    <div className="tab-content">
      {/* ---- Storico snapshot ---- */}
      {!readOnly && (
        <div className="section-card">
          <div className="table-controls" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h3 className="section-title" style={{ margin: 0 }}><Camera size={16}/> Storico snapshot</h3>
              <span className="muted" style={{ fontSize: 13 }}>{snapshots.length} mesi</span>
            </div>
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => setSnapModal({})}>
                <Plus size={15}/> Aggiungi mese
              </button>
            </div>
          </div>

          {snapshotGaps.length > 0 && (
            <div className="alert alert-amber" style={{ marginBottom: 12 }}>
              <AlertTriangle size={14}/>
              <span>
                Mancano {snapshotGaps.length} mesi nella serie ({snapshotGaps.map((g) => g.label).join(", ")}).
                I rendimenti di quei periodi vengono attribuiti al mese successivo.
                {" "}
                {snapshotGaps.map((g) => (
                  <button key={g.label} className="btn btn-ghost" style={{ padding: "2px 8px", marginRight: 4 }}
                    onClick={() => setSnapModal({ year: g.year, month: g.month, totalValue: "" })}>
                    + {g.label}
                  </button>
                ))}
              </span>
            </div>
          )}

          {snapshots.length === 0 ? (
            <EmptyState icon={Camera} title="Nessuno snapshot"
              description="Lo snapshot del mese corrente viene creato da solo a ogni modifica. Per lo storico passato puoi importare un file o aggiungere i mesi a mano."/>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mese</th><th className="num">Patrimonio</th>
                    <th className="num">Var.</th><th className="num">Asset</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {[...snapshots].reverse().map((s, i, arr) => {
                    const prev = arr[i + 1];
                    const delta = prev?.totalValue
                      ? r2(((s.totalValue - prev.totalValue) / prev.totalValue) * 100) : null;
                    return (
                      <tr key={`${s.year}-${s.month}`}>
                        <td className="mono">{s.label}</td>
                        <td className="num mono"><strong>{fmt(s.totalValue)}</strong></td>
                        <td className="num">{delta == null ? "—" : <Badge value={delta}/>}</td>
                        <td className="num mono muted">{(s.assets || []).length}</td>
                        <td>
                          <div className="row-actions">
                            <button className="icon-btn" title="Modifica il valore"
                              onClick={() => setSnapModal(s)}><Edit2 size={14}/></button>
                            <button className="icon-btn danger" title="Elimina"
                              onClick={() => deleteSnapshot(s)}><Trash2 size={14}/></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint-text" style={{ marginTop: 8 }}>
            Il mese corrente si aggiorna da solo a ogni modifica del portafoglio. Modificare uno
            snapshot passato cambia solo il patrimonio totale: le posizioni per asset restano
            quelle salvate allora.
          </p>
        </div>
      )}

      {snapshots.length < 2 ? (
        <div className="section-card">
          <EmptyState icon={Activity} title="Servono almeno due snapshot"
            description="Le analisi si costruiscono sullo storico mensile. Salva uno snapshot dalla tab Overview: dal secondo in poi qui comparirà il confronto con il riferimento, il drawdown e il contributo di ogni asset."/>
        </div>
      ) : (
        <>
          {/* Finestra temporale: vale per tutte le analisi sotto. */}
          <div className="section-card period-bar">
            <span className="section-title" style={{ margin: 0 }}>Periodo</span>
            <div className="period-tabs" role="group" aria-label="Periodo delle analisi">
              {PERIODS.map((p) => (
                <button key={p.id} className={`period-btn ${period === p.id ? "active" : ""}`}
                  aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
              {anaSnaps.length > 1
                ? <>{anaSnaps.length} mesi · da {anaSnaps[0].label} a {anaSnaps.at(-1).label}</>
                : "Storico insufficiente per questo periodo"}
            </span>
          </div>

          <div className="section-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h3 className="section-title" style={{ margin: 0 }}><Shield size={16}/> Metriche di rischio</h3>
              <span className={`target-badge ${riskMetrics.quality === "solido" ? "ok" : "under"}`}>
                {riskObs} osservazioni — {riskMetrics.quality}
              </span>
            </div>
            <div className="grid-3 risk-grid" style={{ marginTop: 12 }}>
              <RiskCard label={period === "all" ? "Rendimento" : `Rendimento ${PERIODS.find((p) => p.id === period).label}`}
                value={periodRet}
                fmtFn={(v) => fmtPct(v * 100)}
                tooltip="Rendimento composto del periodo selezionato, al netto dei versamenti. Non annualizzato: su una finestra corta è questo il numero che dice come sta andando."
                quality={periodRet > 0 ? "good" : "bad"}/>
              <RiskCard label="CAGR"          value={riskMetrics.cagr}
                fmtFn={(v) => fmtPct(v * 100)} tooltip="Tasso di crescita annuo composto, al netto dei versamenti"
                quality={riskMetrics.cagr > 0.05 ? "good" : "bad"}/>
              <RiskCard label="Volatilità"    value={riskMetrics.vol}
                fmtFn={(v) => fmtPct(v * 100)} tooltip="Volatilità annualizzata"
                quality={riskMetrics.vol < 0.2 ? "good" : "bad"}/>
              <RiskCard label="Max Drawdown"  value={riskMetrics.mdd}
                fmtFn={(v) => fmtPct(v * 100)} tooltip="Perdita massima dal picco"
                quality={riskMetrics.mdd > -0.15 ? "good" : "bad"}/>
              <RiskCard label="Sharpe Ratio"  value={riskMetrics.sharpe}
                fmtFn={(v) => v.toFixed(2)} tooltip="Rendimento per unità di rischio. >1 ottimo"
                quality={riskMetrics.sharpe > 1 ? "good" : riskMetrics.sharpe > 0 ? "neutral" : "bad"}/>
              <RiskCard label="Sortino Ratio" value={riskMetrics.sortino}
                fmtFn={(v) => v.toFixed(2)} tooltip="Penalizza solo la volatilità negativa"
                quality={riskMetrics.sortino > 1 ? "good" : riskMetrics.sortino > 0 ? "neutral" : "bad"}/>
            </div>
            <p className="hint-text">
              {riskObs < OBS_RELIABLE
                ? `⚠ ${riskObs} rendimenti mensili disponibili: volatilità e rapporti sono indicativi finché non se ne accumulano ${OBS_RELIABLE}. Sotto le 12 osservazioni non vengono proprio calcolati — un numero costruito su pochi mesi dipende da quali mesi sono capitati nel campione, non dal portafoglio.`
                : `Campione di ${riskObs} rendimenti mensili. Tasso privo di rischio: ${settings.riskFree ?? 3}% (modificabile in Impostazioni).`}
            </p>
            {concentration.top1 != null && (
              <>
                <div className="summary-strip" style={{ marginTop: 4 }}>
                  <div className="ss-item">
                    <span className="ss-label">Posizione maggiore</span>
                    <span className="ss-value mono">{concentration.top1.toFixed(1)}%</span>
                  </div>
                  <div className="ss-item">
                    <span className="ss-label">Prime tre</span>
                    <span className="ss-value mono">{concentration.top3.toFixed(1)}%</span>
                  </div>
                  <div className="ss-item">
                    <span className="ss-label">Posizioni quotate</span>
                    <span className="ss-value mono">{concentration.count}</span>
                  </div>
                </div>
                <p className="hint-text">
                  <strong>{concentration.top1Name}</strong> da sola vale il{" "}
                  {concentration.top1.toFixed(1)}% del patrimonio. È la lettura che la torta per
                  classe non dà: più ETF azionari globali sono più fette ma un&apos;unica
                  scommessa, e il peso di un singolo strumento è anche rischio emittente.
                  Liquidità, oro fisico e startup sono nel denominatore e quindi diluiscono.
                </p>
              </>
            )}
          </div>

          {transactions.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><ArrowLeftRight size={16}/> Risultato dai movimenti</h3>
              <div className="grid-3">
                <RiskCard label="XIRR" value={txXirr}
                  fmtFn={(v) => fmtPct(v * 100)}
                  tooltip="Rendimento annualizzato ponderato per i flussi: tiene conto di quando è entrato ogni euro"
                  quality={txXirr > 0.05 ? "good" : txXirr > 0 ? "neutral" : "bad"}/>
                <RiskCard label="P&L realizzato" value={txRealized.realized || null}
                  fmtFn={(v) => fmt(v)}
                  tooltip="Guadagno o perdita già incassati dalle vendite, al netto delle commissioni"
                  quality={txRealized.realized >= 0 ? "good" : "bad"}/>
                <RiskCard label="Dividendi incassati" value={txRealized.income || null}
                  fmtFn={(v) => fmt(v)}
                  tooltip="Dividendi e cedole registrati, al netto di ritenute e spese"
                  quality="neutral"/>
              </div>
              <p className="hint-text">
                Calcolate sulle sole posizioni con movimenti registrati.
                {yieldOnCost != null && <> Rendimento da dividendi sul costo (<strong>yield on cost</strong>): <strong>{fmtPct(yieldOnCost)}</strong>.</>}
              </p>
              {/* Le due misure esistevano già in due card diverse senza essere
                  mai confrontate: la loro differenza è l'unico numero che dice
                  se il *quando* si è comprato ha aiutato o meno. */}
              {txXirr != null && riskMetrics.cagr != null && (
                <p className="hint-text">
                  <strong>XIRR {fmtPct(txXirr * 100)}</strong> contro un{" "}
                  <strong>CAGR del patrimonio {fmtPct(riskMetrics.cagr * 100)}</strong>:{" "}
                  {Math.abs(txXirr - riskMetrics.cagr) < 0.005
                    ? "le due misure coincidono, il momento dei versamenti non ha spostato il risultato."
                    : txXirr > riskMetrics.cagr
                      ? `${fmtPct((txXirr - riskMetrics.cagr) * 100)} a favore dell'investitore — i versamenti sono caduti in momenti mediamente favorevoli.`
                      : `${fmtPct((txXirr - riskMetrics.cagr) * 100)} a sfavore — i versamenti sono caduti in momenti mediamente sfavorevoli.`}
                  {" "}Il CAGR misura il portafoglio, l&apos;XIRR misura chi lo alimenta:
                  la differenza è il contributo del <em>quando</em>.
                </p>
              )}
            </div>
          )}

          {/* ---- Benchmark ---- */}
          <div className="section-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h3 className="section-title" style={{ margin: 0 }}><Target size={16}/> Confronto con un riferimento</h3>
              {!readOnly && (
                <select className="field-input" style={{ maxWidth: 260, marginTop: 0 }}
                  value={settings.benchmarkKey || ""}
                  onChange={(e) => setSettings((p) => ({ ...p, benchmarkKey: e.target.value }))}>
                  <option value="">Nessun riferimento</option>
                  {txOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
                </select>
              )}
            </div>
            {benchSeries.length > 1 ? (
              <>
                <div style={{ height: 260, marginTop: 12 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={benchSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                      <XAxis dataKey="label" tick={{ fontSize: 11 }}/>
                      <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(0)}/>
                      <ReTooltip formatter={(v) => (v == null ? "—" : v.toFixed(1))}/>
                      <ReferenceLine y={100} stroke="var(--text-muted)" strokeDasharray="4 4"/>
                      <Line type="monotone" dataKey="portfolio" name="Patrimonio" stroke={seriesColor(0)}
                        strokeWidth={2.2} dot={false}/>
                      <Line type="monotone" dataKey="benchmark" name="Riferimento" stroke={seriesColor(2)}
                        strokeWidth={2} dot={false} strokeDasharray="5 4" connectNulls/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-legend">
                  <span><i style={{ background: seriesColor(0) }}/> Patrimonio</span>
                  <span><i style={{ background: seriesColor(2) }}/> {txNameByKey[settings.benchmarkKey] || "Riferimento"}</span>
                </div>
                <p className="hint-text">
                  Entrambi riportati a 100 sul primo snapshot. Il patrimonio è al netto dei versamenti:
                  qui si vede se il portafoglio ha fatto meglio o peggio del riferimento, non quanto si è risparmiato.
                  {benchGap != null && (
                    <> Differenza a oggi: <strong style={{ color: benchGap >= 0 ? "var(--green)" : "var(--red)" }}>
                      {fmtPct(benchGap)}</strong>.</>
                  )}
                </p>
              </>
            ) : (
              <p className="hint-text" style={{ marginTop: 12 }}>
                Scegli un asset come riferimento. Se vuoi confrontarti con un indice che non possiedi,
                aggiungilo in Portafoglio con quantità <strong>0</strong>: non entra nel patrimonio ma
                il suo prezzo finisce negli snapshot ed è utilizzabile qui.
              </p>
            )}
          </div>

          {/* ---- Drawdown ---- */}
          {ddSeries.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><TrendingDown size={16}/> Drawdown</h3>
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ddSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gDd" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C_LOSS} stopOpacity={0.05}/>
                        <stop offset="100%" stopColor={C_LOSS} stopOpacity={0.35}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize: 11 }}/>
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`}/>
                    <ReTooltip formatter={(v) => `${v}%`}/>
                    <ReferenceLine y={0} stroke="var(--border)"/>
                    <Area type="monotone" dataKey="dd" stroke={C_LOSS} fill="url(#gDd)" strokeWidth={2}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="hint-text">
                Quanto si è sotto il massimo raggiunto. Il valore peggiore dice quanto è stata profonda
                la discesa; la larghezza della zona in rosso dice quanto è durata — che è la parte
                che si sopporta davvero.
              </p>
            </div>
          )}

          {/* ---- Chi ha prodotto il risultato ---- */}
          {contribByAsset.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><TrendingUp size={16}/> Contributo al risultato</h3>
              <div style={{ height: Math.max(160, contribByAsset.length * 38) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={contribByAsset} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false}/>
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v, true)}/>
                    <YAxis type="category" dataKey="key" width={110} tick={{ fontSize: 11 }}
                      tickFormatter={(k) => assetNameMap[k] || k}/>
                    <ReTooltip formatter={(v) => fmt(v)} labelFormatter={(k) => assetNameMap[k] || k}/>
                    <ReferenceLine x={0} stroke="var(--border)"/>
                    <Bar dataKey="gain" radius={[0, 4, 4, 0]}>
                      {contribByAsset.map((d) => (
                        <Cell key={d.key} fill={d.gain >= 0 ? C_GAIN : C_LOSS}/>
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="hint-text">
                Euro prodotti dal mercato, al netto di quanto ci è stato versato dentro. Non coincide
                con la performance percentuale: un asset piccolo che sale molto può contare meno di
                uno grande che sale poco.
              </p>
            </div>
          )}

          {/* ---- Composizione nel tempo ---- */}
          {allocSeries.length > 1 && (
            <div className="section-card">
              <h3 className="section-title"><PieChartIcon size={16}/> Composizione nel tempo</h3>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={allocSeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize: 11 }}/>
                    <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`}/>
                    <ReTooltip formatter={(v, k) => [`${v}%`, assetNameMap[k] || k]}/>
                    {allIds.map((k, i) => (
                      <Area key={k} type="monotone" dataKey={k} stackId="alloc"
                        stroke={seriesColor(i)} fill={seriesColor(i)} fillOpacity={0.6}/>
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="hint-text">
                Peso percentuale di ogni voce del patrimonio, mese per mese: mostra la deriva che la
                torta di oggi non può far vedere. Liquidità, startup e oro fisico sono inclusi come
                voci a sé. Sugli snapshot salvati prima compaiono raggruppati sotto
                «Non quotato», perché allora venivano registrati solo nel totale.
              </p>
            </div>
          )}

          {/* ---- Heatmap rendimenti ---- */}
          {returnsGrid.length > 0 && (
            <div className="section-card">
              <h3 className="section-title"><Activity size={16}/> Rendimenti mensili</h3>
              <div className="table-wrap">
                <table className="data-table heatmap">
                  <thead>
                    <tr>
                      <th>Anno</th>
                      {MONTH_LABELS_IT.map((m) => <th key={m} className="num">{m}</th>)}
                      <th className="num">Anno</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returnsGrid.map((row) => {
                      const vals = Object.values(row.months);
                      const yearRet = vals.length
                        ? r2((vals.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100) : null;
                      return (
                        <tr key={row.year}>
                          <td className="mono"><strong>{row.year}</strong></td>
                          {MONTH_LABELS_IT.map((m, i) => {
                            const v = row.months[i + 1];
                            return (
                              <td key={m} className="num mono" style={heatStyle(v)}>
                                {v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
                              </td>
                            );
                          })}
                          <td className={`num mono ${(yearRet ?? 0) >= 0 ? "pos-text" : "neg-text"}`}>
                            <strong>{yearRet == null ? "—" : `${yearRet > 0 ? "+" : ""}${yearRet.toFixed(1)}%`}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint-text">
                Rendimento mensile al netto dei versamenti. La colonna finale compone i mesi
                disponibili dell'anno: se l'anno è incompleto, è un parziale.
              </p>
            </div>
          )}

          {/* ---- Costi ---- */}
          {(costs.recurringYear > 0 || costs.paidToDate > 0) && (
            <div className="section-card">
              <h3 className="section-title"><Wallet size={16}/> Costi</h3>
              <div className="summary-strip" style={{ marginBottom: 12 }}>
                <div className="ss-item ss-item--strong">
                  <span className="ss-label">Ricorrenti / anno</span>
                  <span className="ss-value mono neg-text">{fmt(costs.recurringYear)}</span>
                </div>
                <div className="ss-item ss-item--strong"
                  title="Quanto i costi ricorrenti pesano ogni anno sul patrimonio: è la quota di rendimento che se ne va prima di qualunque risultato di mercato.">
                  <span className="ss-label">Incidenza annua</span>
                  <span className="ss-value mono">
                    {costs.recurringPct != null ? `${costs.recurringPct.toFixed(2)}%` : "—"}
                  </span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Bollo titoli</span>
                  <span className="ss-value mono">{fmt(costs.bollo)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Abbonamento startup</span>
                  <span className="ss-value mono">{fmt(costs.subscription)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Commissioni movimenti</span>
                  <span className="ss-value mono">{costs.txFees ? fmt(costs.txFees) : "—"}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Commissioni startup</span>
                  <span className="ss-value mono">{costs.startupFees ? fmt(costs.startupFees) : "—"}</span>
                </div>
              </div>
              <p className="hint-text">
                Le prime due voci sono <strong>ricorrenti</strong>: si ripagano ogni anno, e
                l'incidenza dice quanto rendimento va via prima ancora di guardare il mercato.
                Le commissioni sono invece quanto è stato pagato <strong>finora</strong>
                {" "}({fmt(costs.paidToDate)} in tutto): sommarle alle prime darebbe un numero
                senza significato, perché coprono periodi diversi.
                {!transactions.length && " Le commissioni sui movimenti compaiono quando il registro è in uso."}
              </p>
            </div>
          )}

          {/* ---- Fisco ---- */}
          {(fiscal.years.length > 0 || latent.latentGain !== 0) && (
            <div className="section-card">
              <h3 className="section-title"><Wallet size={16}/> Fisco</h3>
              <div className="summary-strip" style={{ marginBottom: 12 }}>
                <div className="ss-item">
                  <span className="ss-label">Imposta latente</span>
                  <span className="ss-value mono neg-text">{fmt(latent.latentTax)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Patrimonio netto stimato</span>
                  <span className="ss-value mono">{fmt(grandTotal - latent.latentTax)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Bollo titoli / anno</span>
                  <span className="ss-value mono">{fmt(bollo)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Imposta già maturata</span>
                  <span className="ss-value mono">{fmt(fiscal.totalTax)}</span>
                </div>
              </div>

              {fiscal.years.length > 0 && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Anno</th>
                        <th className="num" title="Plusvalenze da ETF: non compensabili con le minusvalenze">Redditi di capitale</th>
                        <th className="num" title="Plusvalenze da azioni, ETC, crypto: compensabili">Redditi diversi</th>
                        <th className="num">Minusvalenze</th>
                        <th className="num">Compensate</th>
                        <th className="num">Imponibile</th>
                        <th className="num">Imposta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fiscal.years.map((y) => (
                        <tr key={y.year}>
                          <td className="mono"><strong>{y.year}</strong></td>
                          <td className="num mono">{fmt(y.capitalGains)}</td>
                          <td className="num mono">{fmt(y.diverseGains)}</td>
                          <td className="num mono neg-text">{y.losses ? `−${fmt(y.losses)}` : "—"}</td>
                          <td className="num mono">{y.offset ? fmt(y.offset) : "—"}</td>
                          <td className="num mono">{fmt(y.taxable)}</td>
                          <td className="num mono neg-text"><strong>{fmt(y.tax)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {fiscal.pool.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h4 style={{ fontSize: 13, margin: "0 0 6px" }}>Zainetto fiscale</h4>
                  <div className="kpi-mini-row">
                    {fiscal.pool.map((l) => (
                      <span key={l.year}>
                        {l.year}: <strong>{fmt(l.amount)}</strong>{" "}
                        <span className="muted">(usabile fino al {l.expiresAfter})</span>
                      </span>
                    ))}
                  </div>
                  {fiscal.expiring > 0 && (
                    <div className="alert alert-amber" style={{ marginTop: 8 }}>
                      <AlertTriangle size={14}/> {fmt(fiscal.expiring)} di minusvalenze scadono senza
                      essere state usate: si recuperano solo realizzando una plusvalenza compensabile
                      (azioni, ETC, crypto — non ETF) entro il termine.
                    </div>
                  )}
                </div>
              )}

              <p className="hint-text">
                Stima in regime amministrato, con criterio <strong>LIFO</strong> sui lotti — diverso dal
                prezzo medio di carico usato altrove per mostrare la performance. Le plusvalenze da ETF
                armonizzati sono redditi di capitale: <strong>non</strong> si compensano con le
                minusvalenze, nemmeno con quelle degli ETF stessi. Non sostituisce l'estratto conto
                fiscale dell'intermediario.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ====================== TAB: MOVIMENTI ======================
  const renderTransactions = () => (
    <div className="tab-content">
      <div className="section-card">
        <div className="table-controls" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              <ArrowLeftRight size={16}/> Movimenti
            </h2>
            {transactions.length > 0 && (
              <span className="muted" style={{ fontSize: 13 }}>{transactions.length} registrati</span>
            )}
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => setTxModal({})} disabled={!txOptions.length}>
              <Plus size={15}/> Aggiungi movimento
            </button>
          </div>
        </div>

        {transactions.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="Nessun movimento registrato"
            description={txOptions.length
              ? "Finché il registro è vuoto le posizioni restano quelle inserite a mano. Registrando acquisti, vendite e dividendi la dashboard calcola da sé quantità e prezzo medio di carico, e sblocca il risultato realizzato e il rendimento ponderato per i flussi (XIRR)."
              : "Aggiungi prima un asset dalla tab Portafoglio."}
            action={txOptions.length ? (
              <div className="btn-row">
                <button className="btn btn-primary" onClick={seedTransactions}>
                  <Upload size={15}/> Genera dalle posizioni attuali
                </button>
                <button className="btn btn-ghost" onClick={() => setTxModal({})}>
                  <Plus size={15}/> Aggiungi a mano
                </button>
              </div>
            ) : null}/>
        ) : (
          <>
            <div className="summary-strip" style={{ marginBottom: 12 }}>
              <div className="ss-item">
                <span className="ss-label">Realizzato</span>
                <span className={`ss-value mono ${txRealized.realized >= 0 ? "pos-text" : "neg-text"}`}>
                  {fmt(txRealized.realized)}
                </span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Dividendi</span>
                <span className="ss-value mono">{fmt(txRealized.income)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Commissioni</span>
                <span className="ss-value mono">{fmt(txRealized.fees)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">XIRR</span>
                <span className={`ss-value mono ${(txXirr ?? 0) >= 0 ? "pos-text" : "neg-text"}`}>
                  {txXirr == null ? "—" : fmtPct(txXirr * 100)}
                </span>
              </div>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Data</th><th>Asset</th><th>Tipo</th>
                    <th className="num">Quantità</th><th className="num">Prezzo</th>
                    <th className="num">Commissioni</th><th className="num">Importo</th>
                    <th>Note</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {txSorted.map((t) => {
                    const flow = txCashFlow(t);
                    return (
                      <tr key={t.id}>
                        <td className="mono">{t.date}</td>
                        <td className="asset-name">
                          {txNameByKey[t.assetKey] || <span className="muted">{t.assetKey}</span>}
                        </td>
                        <td><span className="class-tag">{TX_LABELS[t.type] || t.type}</span></td>
                        <td className="num mono">{t.type === "dividend" ? "—" : t.quantity}</td>
                        <td className="num mono">{t.type === "dividend" ? "—" : fmt(t.price)}</td>
                        <td className="num mono">{t.fee ? fmt(t.fee) : "—"}</td>
                        <td className={`num mono ${flow >= 0 ? "pos-text" : "neg-text"}`}>
                          {flow >= 0 ? "+" : "−"}{fmt(Math.abs(flow))}
                        </td>
                        <td className="muted">{t.notes || "—"}</td>
                        <td>
                          {!readOnly && (
                            <div className="row-actions">
                              <button className="icon-btn" onClick={() => setTxModal(t)}><Edit2 size={14}/></button>
                              <button className="icon-btn danger"
                                onClick={() => { if (window.confirm("Rimuovere questo movimento?")) deleteTx(t.id); }}>
                                <Trash2 size={14}/>
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="hint-text" style={{ marginTop: 8 }}>
              Gli asset che compaiono qui hanno quantità e prezzo medio di carico
              <strong> calcolati dai movimenti</strong>: nella tab Portafoglio non sono più
              modificabili a mano. Gli altri restano come li hai inseriti.
              {" "}L'<strong>XIRR</strong> considera solo le posizioni con un registro
              ({fmt(txCurrentValue)} di valore attuale).
            </p>
          </>
        )}
      </div>
    </div>
  );

  // ====================== TAB: SETTINGS ======================
  // Fase 10: valori per-utente, salvati nel blob config (auto-save). Zero hardcoded.
  const setSetting = (key, val, liveSetter) => {
    setSettings((prev) => ({ ...prev, [key]: val }));
    if (liveSetter) liveSetter(val); // aggiorna anche il controllo live corrispondente
  };
  const renderSettings = () => (
    <div className="tab-content">
      <div className="section-card">
        <h2 className="section-title"><Settings size={16}/> Impostazioni</h2>
        <p className="welcome-desc" style={{ marginTop: 0 }}>
          Valori predefiniti personali. Salvati automaticamente sul tuo account.
        </p>
        <div className="grid-3" style={{ marginBottom: "1.5rem" }}>
          {[
            { key: "startupSubscription", label: "Abbonamento startup annuo (€)", set: null,      step: 1,   min: 0 },
            { key: "monthlyBudget",       label: "Budget mensile default (€)",    set: setBudget, step: 50,  min: 0 },
            { key: "projReturn",          label: "Rendimento annuo default (%)",  set: setProjR,  step: 0.5, min: 0, max: 30 },
            { key: "projMonthly",         label: "Investimento mensile default (€)", set: setProjM, step: 100, min: 0 },
            { key: "projYears",           label: "Anni proiezione default",       set: setProjY,  step: 1,   min: 1, max: 50 },
            { key: "inflation",           label: "Inflazione attesa (%)",         set: null,      step: 0.1, min: 0, max: 20 },
            { key: "riskFree",            label: "Tasso privo di rischio (%)",    set: null,      step: 0.1, min: 0, max: 15 },
            { key: "rebalanceBand",       label: "Banda ribilanciamento (punti %)", set: null,    step: 0.5, min: 0, max: 25 },
            { key: "taxRate",             label: "Aliquota capital gain (%)",     set: null,      step: 0.5, min: 0, max: 50 },
            { key: "taxBollo",            label: "Bollo titoli annuo (%)",        set: null,      step: 0.05, min: 0, max: 2 },
          ].map(({ key, label, set, step, min, max }) => (
            <label key={key} className="field-label">
              {label}
              <input type="number" value={settings[key] ?? 0}
                onChange={(e) => setSetting(key, parseFloat(e.target.value) || 0, set)}
                step={step} min={min} max={max} className="field-input"/>
            </label>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
          Le classi di asset si gestiscono dal pulsante dedicato nella tab Portafoglio.
        </p>
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

        {/* Fase di prelievo */}
        <div style={{ marginBottom: "1.5rem" }}>
          <label className="field-label" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={projWithdraw} onChange={(e) => setProjW(e.target.checked)}
              style={{ width: 18, height: 18, minHeight: 0 }}/>
            Simula la fase di prelievo (si smette di versare e si inizia a ritirare)
          </label>
          {projWithdraw && (
            <div className="grid-3" style={{ marginTop: 8 }}>
              <label className="field-label">Inizio prelievi (anni da oggi)
                <input type="number" value={projWithdrawAfter} min={0} max={projYears} step={1}
                  onChange={(e) => setProjWA(parseFloat(e.target.value) || 0)} className="field-input"/>
              </label>
              <label className="field-label">Prelievo mensile (€)
                <input type="number" value={projWithdrawMonthly} min={0} step={100}
                  onChange={(e) => setProjWM(parseFloat(e.target.value) || 0)} className="field-input"/>
              </label>
              <label className="field-label">Prelievo annuo
                <input className="field-input" readOnly value={fmt(projWithdrawMonthly * 12)}
                  style={{ opacity: 0.6 }}/>
              </label>
            </div>
          )}
        </div>

        <div className="grid-4" style={{ marginBottom: "1.5rem" }}>
          <KpiCard label="Valore iniziale" value={fmt(grandTotal, true)} color="blue"/>
          <KpiCard label={`Proiettato (${projYears}a) — Base`} value={fmt(finalVal, true)} color="green"/>
          <KpiCard label="In potere d'acquisto di oggi"
            value={fmt(projData.at(-1)?.real ?? 0, true)}
            sub={`inflazione ${settings.inflation ?? 0}%`} color="blue"/>
          <KpiCard label="Guadagno previsto" value={fmt(projGain, true)} sub={`ROI stimato: ${projROI.toFixed(1)}%`}
            color={projGain >= 0 ? "green" : "red"}/>
        </div>

        {projWithdraw && (
          projDepletion != null ? (
            <div className="alert alert-amber" style={{ marginBottom: 12 }}>
              <AlertTriangle size={14}/> Con questi parametri il capitale si esaurisce
              dopo <strong>{projDepletion} anni</strong>: il prelievo è più alto di quanto
              il portafoglio riesca a produrre.
            </div>
          ) : (
            <div className="alert alert-green" style={{ marginBottom: 12 }}>
              <CheckCircle size={14}/> Il capitale regge tutti i {projYears} anni della proiezione
              con un prelievo di {fmt(projWithdrawMonthly)} al mese.
            </div>
          )
        )}
        <div className="chart-legend">
          <span className="cl-item"><span className="cl-swatch cl-swatch--band" style={{ background: palette[0] }}/>
            Intervallo {Math.max(projReturn - 3, 0)}%–{projReturn + 3}%
          </span>
          <span className="cl-item"><span className="cl-swatch" style={{ background: palette[0] }}/>
            Scenario base ({projReturn}%)
          </span>
          {(settings.inflation ?? 0) > 0 && (
            <span className="cl-item"><span className="cl-swatch" style={{ background: palette[2] }}/>
              Potere d'acquisto di oggi
            </span>
          )}
        </div>
        <div style={{ height: 380 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={projChartData} margin={{ top: 4, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="var(--border)" vertical={false}/>
              <XAxis dataKey="year" label={{ value: "Anni", position: "insideBottom", offset: -6 }} tick={{ fontSize: 11 }} stroke="var(--text-muted)"/>
              <YAxis tickFormatter={(v) => `€${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} stroke="var(--text-muted)" width={60}/>
              <ReTooltip content={<ProjectionTooltip projReturn={projReturn}/>}/>
              <Area type="monotone" dataKey="range" name="Intervallo" stroke="none"
                fill={palette[0]} fillOpacity={0.16} activeDot={false} isAnimationActive={false}/>
              <Line type="monotone" dataKey="base" name="Scenario base" stroke={palette[0]} strokeWidth={2}
                dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--bg-card)" }}/>
              {(settings.inflation ?? 0) > 0 && (
                <Line type="monotone" dataKey="real" name="Potere d'acquisto" stroke={palette[2]}
                  strokeWidth={2} strokeDasharray="5 4" dot={false}/>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="hint-text">
          ⚠ Proiezione ipotetica a rendimento costante. Non costituisce consulenza finanziaria.
          {(settings.inflation ?? 0) > 0 && ` La linea tratteggiata è la stessa cifra espressa in euro di oggi, scontata al ${settings.inflation}% annuo: è quella che dice cosa ci si potrà comprare.`}
        </p>
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
        {assets.length === 0 && !goldEtf.identifier ? (
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
                {(settings.rebalanceBand ?? 0) > 0 && (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Banda di tolleranza: <strong>{settings.rebalanceBand}</strong> punti — chi è più
                    vicino di così al target non viene toccato.
                  </span>
                )}
                {!readOnly && (
                  <button className="btn btn-primary" style={{ marginLeft: "auto" }}
                    onClick={applyRebalance} disabled={monthBudget <= 0}>
                    <CheckCircle size={15}/> Segna come eseguito
                  </button>
                )}
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
                  sub={`${etfPortfolioAssets.length} asset`}
                  color="blue"
                />
                <KpiCard
                  label="💼 Totale"
                  value={fmt(monthBudget)}
                  sub={itemBuys.length === 0
                    ? "Nessun target sul patrimonio → tutto agli ETF"
                    : allAtTarget ? "Oro/Bitcoin al target → tutto agli ETF" : "Prima oro e Bitcoin, poi ETF"}
                  color="blue"
                />
              </div>

              {allAtTarget && (
                <div className="alert alert-amber" style={{ marginBottom: 12 }}>
                  <AlertTriangle size={15}/>
                  {" "}Tutti gli asset a target sul patrimonio (oro, Bitcoin, …) sono già al target o sopra. Budget interamente allocato agli ETF.
                </div>
              )}

              {driftOver && drift.worst && (
                <div className="alert alert-amber">
                  <AlertTriangle size={15}/>
                  {" "}<strong>{drift.worst.name}</strong> è a {drift.worst.actualPct.toFixed(1)}%
                  {" "}contro un target del {drift.worst.targetPct}%: {driftMax.toFixed(1)} punti di
                  scostamento, oltre la soglia di {driftThreshold(settings.rebalanceBand ?? 0)}.
                  {" "}Per rimettere tutto a target servirebbero {drift.sum.toFixed(1)} punti di
                  spostamento complessivo.
                </div>
              )}
            </div>

            {/* Livello 1: asset a target sul patrimonio totale */}
            {itemBuys.length > 0 && (
              <div className="section-card" style={{ borderColor: "rgba(245,158,11,0.4)" }}>
                <h3 className="section-title" style={{ marginBottom: 4 }}>🥇 Target sul patrimonio totale — Oro & Bitcoin</h3>
                <p className="hint-text" style={{ marginBottom: 12 }}>
                  Questi asset hanno il target espresso in % del <strong>patrimonio totale</strong> (liquidità + ETF + startup + oro).
                  {goldOnTotal && " Il peso dell'oro considera ETF oro + oro fisico; il budget va solo sull'ETF oro (l'oro fisico è illiquido)."}
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
                I pesi (Peso attuale e Target) sono calcolati all'interno del sotto-portafoglio ETF
                {goldOnTotal ? " (escluso oro)" : " (ETF oro incluso, oro fisico escluso)"},
                quindi sommano a 100%. Il budget viene allocato prioritariamente agli asset sottopesati, senza mai vendere.
              </p>
            </div>
          </>
        )}
      </div>
    );
  };

  // ====================== RENDER ======================
  // Link condiviso non valido / revocato: pagina d'errore, nessun dato.
  if (shareErr) {
    return (
      <div className={`app ${dark ? "dark" : "light"}`}>
        <header className="app-header">
          <div className="header-left">
            <div className="logo-mark">PF</div>
            <h1 className="app-title">Portfolio Tracker</h1>
          </div>
        </header>
        <main className="app-main">
          <div className="welcome-card">
            <div className="welcome-icon">🔒</div>
            <h2 className="welcome-title">Portafoglio non disponibile</h2>
            <p className="welcome-desc">{shareErr}</p>
            <a className="btn btn-primary" href="/">Vai al Portfolio Tracker</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={`app ${dark ? "dark" : "light"}`}>
      <header className="app-header">
        <div className="header-left">
          <div className="logo-mark">PF</div>
          <div>
            <h1 className="app-title">Portfolio Tracker</h1>
            <p className="app-subtitle">
              {/* La parte informativa sparisce su mobile (.subtitle-static),
                  lo stato di salvataggio qui sotto no. */}
              <span className="subtitle-static">
                {readOnly
                  ? <><Eye size={12}/> Vista condivisa · sola lettura</>
                  : <><Info size={12}/> Aggiornamento automatico ogni 15 min</>}
              </span>
              {!readOnly && lastSaved && !saveErr && (
                <span style={{ color: "var(--green)" }}>
                  Salvato {lastSaved.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {!readOnly && saveErr && (
                <span style={{ color: "var(--red)" }}>⚠ Non salvato: {saveErr}</span>
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
          {!readOnly && assets.length > 0 && (
            <button className="btn btn-primary" onClick={fetchAllPrices} disabled={isLoading}>
              <RefreshCw size={14} className={isLoading ? "spin" : ""}/>
              {isLoading ? "Aggiornamento…" : "Aggiorna prezzi"}
            </button>
          )}
          {!readOnly && (
            <button className="btn btn-ghost" onClick={() => setShareModal(true)} title="Condividi in sola lettura">
              <Share2 size={15}/> Condividi
            </button>
          )}
          <button className="icon-btn theme-toggle" onClick={() => setDark((d) => !d)} title="Cambia tema">
            {dark ? <Sun size={17}/> : <Moon size={17}/>}
          </button>
          {!readOnly && session && supabase && (
            <button className="icon-btn theme-toggle" title={`Esci (${session.user?.email || ""})`}
              onClick={() => supabase.auth.signOut()}>
              <LogOut size={17}/>
            </button>
          )}
        </div>
      </header>

      {readOnly && (
        <div className="alert alert-amber mx-4">
          <Eye size={14}/>
          <span>
            Stai visualizzando un portafoglio <strong>condiviso in sola lettura</strong>.
            Non è possibile aggiungere, modificare o eliminare dati.
          </span>
        </div>
      )}

      {error && (
        <div className="alert alert-red mx-4">
          <AlertTriangle size={14}/> {error}
        </div>
      )}

      <nav className="tab-bar">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} className={`tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => goTab(t.id)}>
              <Icon size={15}/> {t.label}
            </button>
          );
        })}
      </nav>

      <main className="app-main">
        {tab === "overview"    && renderOverview()}
        {tab === "portfolio"   && renderPortfolio()}
        {tab === "transactions" && !readOnly && renderTransactions()}
        {tab === "analysis"    && renderAnalysis()}
        {tab === "projection"  && renderProjection()}
        {tab === "rebalancing" && renderRebalancing()}
        {tab === "settings"    && renderSettings()}
      </main>

      {/* Nav mobile: la .tab-bar è nascosta sotto i 768px (vedi styles.css) */}
      <nav className="bottom-nav">
        <div className="bottom-nav-inner">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} className={`bottom-nav-btn ${tab === t.id ? "active" : ""}`}
                onClick={() => { goTab(t.id); window.scrollTo(0, 0); }} aria-label={t.label}>
                <Icon size={19}/> <span>{t.short}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Feedback delle azioni: unico host, così il messaggio si vede da
          qualunque tab sia partita l'azione. `role=status` lo fa annunciare
          agli screen reader senza rubare il fuoco. */}
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status" aria-live="polite">
          {toast.type === "ok" ? <CheckCircle size={15}/> : <AlertTriangle size={15}/>}
          <span>{toast.text}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Chiudi">
            <X size={14}/>
          </button>
        </div>
      )}

      {/* Modali */}
      {assetModal !== null && (
        <AssetModal
          // La tabella passa l'asset derivato dai movimenti; il modale deve
          // ricevere quello salvato, altrimenti salvando si riscrive la
          // posizione calcolata dentro la config.
          asset={(assetModal?.id && storedAssets.find((s) => s.id === assetModal.id)) || assetModal}
          assetClasses={assetClasses}
          etfTargetOthers={r2(etfTargetSum - (assetModal?.id && !isTotalTargetAsset(assetModal) ? (assetModal.targetWeight || 0) : 0))}
          fromTx={!!assetModal?.id && transactions.some((t) => t.assetKey === txKey(assetModal))}
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
        <GoldEtfModal goldEtf={storedGoldEtf}
          etfTargetOthers={r2(etfTargetSum - (goldOnTotal ? 0 : (goldEtf.targetWeight || 0)))}
          fromTx={transactions.some((t) => t.assetKey === txKey(storedGoldEtf))}
          onSave={(updated) => {
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
      {txModal !== null && (
        <TxModal tx={txModal?.id ? txModal : null} options={txOptions}
          onSave={saveTx} onClose={() => setTxModal(null)}/>
      )}
      {snapModal !== null && (
        <SnapshotModal
          snap={snapModal?.label ? snapModal : null}
          preset={!snapModal?.label && snapModal?.year ? snapModal : null}
          nearest={snapModal?.year
            ? [...snapshots].reverse().find((s) => s.year < snapModal.year
                || (s.year === snapModal.year && s.month < snapModal.month)) ?? snapshots[0]
            : snapshots.at(-1)}
          taken={new Set(snapshots.map((s) => `${s.year}-${s.month}`))}
          onSave={saveSnapshotManual} onClose={() => setSnapModal(null)}/>
      )}
      {shareModal && <ShareModal onClose={() => setShareModal(false)}/>}
    </div>
  );
}
