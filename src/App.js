// App.js — Portfolio Tracker — Production-ready, no default data
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  Cell, Tooltip as ReTooltip, ResponsiveContainer,
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
  PiggyBank, Receipt, HandCoins, Coins, Lock, ArrowUpRight, ArrowDownRight,
  Database,
} from "lucide-react";
import "./styles.css";
import {
  Money, useSlidingIndicator, useEntrance, SegmentedBar,
  GRID, GRID_V, X_AXIS, Y_AXIS, CURSOR_LINE, CURSOR_BAND, ACTIVE_DOT, BAR_MAX, ANIM_MS, axisEuro,
} from "./ui";
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
  projectionScenarios, projectionCapital, depletionYear, syntheticRows, isSynthetic, syntheticLabel,
  SYNTHETIC_RESIDUAL, PERIODS, sliceSnapshots, periodReturn, growthAttribution,
} from "./metrics";
import {
  cashflowRows, cashflowTotals, emergencyFund, investableThisMonth,
  planVsActual, cumulativeInvested, investedByYear, monthId, EF_WINDOW,
} from "./cashflow";
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
  CASHFLOW:      "pf.cashflow.v1",
};

const CONFIG_VERSION  = 5;   // v5: bilancio mensile (`cashflow`); v4: registro movimenti
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
  // Bilancio: mesi di spese da tenere liquidi prima di investire, e quota
  // delle entrate destinata agli investimenti (0 = "non impostata", si usa
  // quello che avanza).
  emergencyMonths: 3,
  investTargetPct: 0,
  expenseBudget: 0,       // tetto di spesa mensile (0 = nessun tetto)
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
  const baseTotal = snapshots[0].totalValue || 1;
  // Base di ogni serie = il primo prezzo in cui l'asset compare, non quello del
  // primo snapshot. Prendendo solo snapshots[0] un asset entrato dopo cadeva sul
  // fallback `a.price` del mese corrente, quindi valeva 100 in ogni punto: una
  // linea piatta al posto della sua performance.
  const baseByAssetId = {};
  snapshots.forEach((s) => quotedRows(s).forEach((a) => {
    const k = snapKey(a);
    if (baseByAssetId[k] == null && a.price) baseByAssetId[k] = a.price;
  }));
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
// Validata con validate_palette.js (skill dataviz) contro le superfici reali
// delle card (#ffffff, #141518): tutti i controlli superati. Lo slot viola della
// palette di riferimento è sostituito dal ciano, fuori dalla fascia viola che il
// sistema esclude.
const PALETTE_LIGHT = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#0091b5","#e34948"];
const PALETTE_DARK  = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#0ca30c","#0aa2c7","#e66767"];

// Oltre l'ottava serie non si generano nuove tinte (indistinguibili sotto CVD):
// si riusa la stessa tinta con tratto tratteggiato — identità = colore + tratto.
const seriesDash = (i) => (i >= 8 ? "6 4" : undefined);

// Colori semantici (guadagno/perdita), non categoriali: non vanno mai usati come "serie N".
// Entrambi reggono 3:1 sulla card chiara e su quella scura.
const C_GAIN = "#0f9960";
const C_LOSS = "#e5484d";

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

// Le chiamate passano il formattatore come `fmtFn`; la firma leggeva `fmt`, così
// il formattatore non veniva mai applicato e a schermo finivano i decimali grezzi
// (0.0642542976…). Si accettano entrambi i nomi.
const RiskCard = ({ label, value, fmtFn, fmt: fmtAlias, tooltip, quality }) => {
  const format = fmtFn || fmtAlias;
  const display = value == null ? "—" : (format ? format(value) : value);
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
          <h3><Tag size={16}/>Gestisci asset class</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
        </div>
        <div className="modal-body" style={{ gap: 0 }}>
          {list.map((cls, i) => (
            <div key={i} className="ac-row">
              {editIdx === i ? (
                <>
                  <input className="field-input" style={{ flex: 1 }} value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveEdit()} autoFocus/>
                  <button className="btn btn-primary btn-sm" onClick={saveEdit} aria-label="Conferma"><CheckCircle size={14}/></button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditIdx(null)} aria-label="Annulla"><X size={14}/></button>
                </>
              ) : (
                <>
                  <span className="ac-name">{cls}</span>
                  <button className="icon-btn" onClick={() => startEdit(i)} title="Rinomina" aria-label={`Rinomina ${cls}`}><Edit2 size={14}/></button>
                  <button className="icon-btn danger" onClick={() => remove(i)} title="Rimuovi" aria-label={`Rimuovi ${cls}`}><Trash2 size={14}/></button>
                </>
              )}
            </div>
          ))}
          <div className="ac-row ac-row--new">
            <input className="field-input" style={{ flex: 1 }} placeholder="Nuova asset class…"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNew()}/>
            <button className="btn btn-ghost btn-sm" onClick={addNew}>
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
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
                />
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
                ? `Target massimo ${targetLeft}%: gli altri asset ne occupano già ${etfTargetOthers}% e la somma non può superare 100%.`
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
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
              <p className="hint-text" style={{ marginTop: 0 }}>
                Se l'incasso non è ancora arrivato in liquidità, conviene lasciarla
                attiva con la valutazione pari all'importo dell'exit: così il
                guadagno risulta rendimento e non un versamento. Passa a "Exit"
                nel mese in cui aggiorni anche la liquidità.
              </p>
              <label className="field-label">Importo incassato dall'exit (€) *
                <input type="number" step="any" value={form.exitAmount ?? ""} onChange={(e) => set("exitAmount", e.target.value)} className="field-input"/>
              </label>
              <label className="field-label">Data dell'exit
                <input type="date" value={form.exitDate ?? ""} onChange={(e) => set("exitDate", e.target.value)} className="field-input"/>
              </label>
              <label className="field-label">Note (opzionale)
                <textarea rows={3} value={form.exitNotes ?? ""} onChange={(e) => set("exitNotes", e.target.value)} className="field-input"
                  />
              </label>
            </>
          )}
          {form.status === "failed" && (
            <p className="hint-text is-warn" style={{ margin: 0 }}>
              <AlertTriangle size={15}/>
              <span>Startup fallita: valore finale <strong>0 €</strong>. La perdita sarà pari al costo totale (investito + commissioni).</span>
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
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
            <p className="hint-text is-warn" style={{ margin: 0 }}>
              <AlertTriangle size={15}/>
              <span>Esiste già uno snapshot per questo mese: modificalo invece di crearne un altro.</span>
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

// ---- Modal Bilancio mensile ----
// Tre campi e nient'altro: stipendio netto, entrate extra, spese totali.
// Quanto si è investito NON si chiede — lo dice il registro movimenti, e un
// quarto campo sarebbe la seconda fonte di verità sullo stesso numero.
const CashflowModal = ({ month, taken, expenseBudget = 0, onSave, onClose }) => {
  const dialogRef = useModalA11y(onClose);
  const now = new Date();
  const [form, setForm] = useState(month || {
    year: now.getFullYear(), month: now.getMonth() + 1,
    salary: "", extra: "", expenses: "", note: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const editing = !!month?.id;

  const year  = parseInt(form.year, 10) || 0;
  const mese  = parseInt(form.month, 10) || 0;
  const dup   = !editing && taken.has(monthId(year, mese));
  const salary   = parseFloat(form.salary) || 0;
  const extra    = parseFloat(form.extra) || 0;
  const expenses = parseFloat(form.expenses) || 0;
  const income   = r2(salary + extra);
  const savings  = r2(income - expenses);
  const valid = year > 1990 && mese >= 1 && mese <= 12 && !dup && (income > 0 || expenses > 0);

  const handleSave = () => {
    if (!valid) return;
    onSave({
      id: month?.id || newId(),
      year, month: mese,
      salary: r2(salary), extra: r2(extra), expenses: r2(expenses),
      note: (form.note || "").trim(),
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{editing ? `Modifica ${MONTH_LABELS_IT[mese - 1]} ${year}` : "Aggiungi mese"}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
          <label className="field-label">Stipendio netto (€)
            <input type="number" step="any" value={form.salary}
              onChange={(e) => set("salary", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Entrate extra (€)
            <input type="number" step="any" value={form.extra}
              onChange={(e) => set("extra", e.target.value)} className="field-input"/>
            <span className="hint-text">Tredicesima, bonus, rimborsi, entrate occasionali.</span>
          </label>
          <label className="field-label">Spese totali (€)
            <input type="number" step="any" value={form.expenses}
              onChange={(e) => set("expenses", e.target.value)} className="field-input"/>
          </label>
          <label className="field-label">Note
            <input value={form.note || ""} onChange={(e) => set("note", e.target.value)}
              className="field-input" placeholder="es. vacanza, spesa straordinaria"/>
          </label>

          {(income > 0 || expenses > 0) && (
            <div className="summary-strip">
              <div className="ss-item">
                <span className="ss-label">Entrate</span>
                <span className="ss-value mono">{fmt(income)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Risparmio</span>
                <span className={`ss-value mono ${savings >= 0 ? "pos-text" : "neg-text"}`}>{fmt(savings)}</span>
              </div>
              <div className="ss-item">
                <span className="ss-label">Tasso di risparmio</span>
                <span className="ss-value mono">
                  {income > 0 ? `${r2((savings / income) * 100)}%` : "—"}
                </span>
              </div>
            </div>
          )}
          {expenseBudget > 0 && expenses > expenseBudget && (
            <p className="hint-text is-warn" style={{ margin: 0 }}>
              <AlertTriangle size={15}/>
              <span>Spese sopra il tetto mensile di {fmt(expenseBudget)} ({fmt(r2(expenses - expenseBudget))} in più).</span>
            </p>
          )}
          {dup && (
            <p className="hint-text is-warn" style={{ margin: 0 }}>
              <AlertTriangle size={15}/>
              <span>Questo mese è già registrato: modificalo invece di crearne un altro.</span>
            </p>
          )}
          <p className="hint-text" style={{ margin: 0 }}>
            Il <strong>versato</strong> del mese non si inserisce qui: viene calcolato
            dai movimenti registrati nella tab Movimenti.
          </p>
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
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
          <h3><Coins size={16}/>Configura ETF oro quotato</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
              />
          </label>
          <label className="field-label">Prezzo medio carico (€/quota)
            <input type="number" step="any" value={form.costBasis} onChange={(e) => set("costBasis", e.target.value)}
              className="field-input" readOnly={fromTx}
              title={fromTx ? "Calcolato dai movimenti registrati" : undefined}
              />
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
                ? `Target massimo ${targetLeft}%: gli altri asset quotati ne occupano già ${etfTargetOthers}% e la somma non può superare 100%.`
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
          <h3><Coins size={16}/>Oro fisico 18kt</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
            <code>prezzo spot (€/oz) ÷ 31,1035 × 0,75</code><br/>
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

// ---- Tooltip dei grafici ----
// Il valore è l'elemento forte, il nome della serie lo segue; ogni riga ha la
// sua chiave a linea nel colore della serie (skill dataviz, Tooltips).
const TipKey = ({ color }) => <i className="tt-key" style={{ background: color }}/>;

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="tooltip-row">
          <span><TipKey color={p.color || p.fill}/>{p.name}</span>
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
    <div className="chart-tooltip" style={{ minWidth: 230 }}>
      <div className="tooltip-label">Anno {label}</div>
      <div className="tooltip-row"><span>Ottimistico (+{projReturn + 3}%)</span><span>{fmt(d.optimistic)}</span></div>
      <div className="tooltip-row"><span><TipKey color="var(--accent)"/>Base ({projReturn}%)</span><span>{fmt(d.base)}</span></div>
      <div className="tooltip-row"><span>Pessimistico ({Math.max(projReturn - 3, 0)}%)</span><span>{fmt(d.pessimistic)}</span></div>
    </div>
  );
};

const SnapshotTooltip = ({ active, payload, label, snapshots }) => {
  if (!active || !payload?.length) return null;
  const snap = snapshots.find((s) => s.label === label);
  return (
    <div className="chart-tooltip" style={{ minWidth: 240, maxHeight: 340, overflowY: "auto" }}>
      <div className="tooltip-label">{label}</div>
      {payload.map((p, i) => {
        if (p.dataKey === "__total__") return (
          <div key={i} className="tooltip-row">
            <span><TipKey color={p.color}/>Portafoglio</span>
            <span>{p.value?.toFixed(1)} <span className="muted" style={{ fontWeight: 400 }}>({snap ? fmt(snap.totalValue) : ""})</span></span>
          </div>
        );
        const assetSnap = snap?.assets?.find((a) => snapKey(a) === p.dataKey);
        return (
          <div key={i} className="tooltip-row">
            <span><TipKey color={p.color}/>{p.name}</span>
            <span>{p.value?.toFixed(1)} <span className="muted" style={{ fontWeight: 400 }}>({assetSnap ? fmt(assetSnap.value) : ""})</span></span>
          </div>
        );
      })}
      <div className="tooltip-note">Indice 100 = primo snapshot</div>
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
          <h3><Share2 size={16}/>Condividi portafoglio</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi" title="Chiudi"><X size={18}/></button>
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
                <span className="field-hint" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--pos)" }}><CheckCircle size={14}/> Link copiato negli appunti</span>
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

// Solo presentazione: segna le .table-wrap che scorrono in orizzontale.
const markScrollableTables = () => {
  document.querySelectorAll(".table-wrap").forEach((w) => {
    w.classList.toggle("is-scrollable", w.scrollWidth > w.clientWidth + 1);
  });
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
  { id: "budget",      label: "Bilancio",        short: "Bilancio",  icon: PiggyBank },
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
  // Bilancio mensile: entrate e spese inserite a mano. Il versato NON sta
  // qui — si ricava dai movimenti (vedi cashflow.js), altrimenti sarebbero
  // due fonti di verità sullo stesso numero.
  const [cashflow,     setCashflow]= useLS(STORAGE_KEYS.CASHFLOW, [], uid);

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

  const entering = useEntrance();
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
  const [cfModal,       setCfModal]      = useState(null);

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
    markScrollableTables();
  });

  // Tabelle più larghe del pannello: la classe fissa la colonna del nome mentre
  // si scorre in orizzontale (styles.css). Ricalcolata al ridimensionamento.
  useEffect(() => {
    window.addEventListener("resize", markScrollableTables);
    return () => window.removeEventListener("resize", markScrollableTables);
  }, []);

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
          // Assente nelle config precedenti alla v5.
          setCashflow(Array.isArray(cfg.cashflow) ? cfg.cashflow : []);
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
          setCashflow([]);
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
  // Il ribilanciamento normalizza i target a 100 (vedi calcRebalancing), quindi
  // deriva e tabella devono confrontarsi con gli stessi numeri: con target 48/32
  // che sommano a 80 e posizioni esattamente 60/40 il ribilanciatore vedeva un
  // portafoglio a target e la deriva segnalava 12 punti di scostamento, nella
  // stessa pagina.
  const etfTargetNorm = useMemo(
    () => (etfTargetSum > 0 ? 100 / etfTargetSum : 1), [etfTargetSum]);
  const etfTargetOf = useCallback(
    (a) => r2((a.targetWeight || 0) * etfTargetNorm), [etfTargetNorm]);

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

  // Solo le attive entrano nel patrimonio, alla valutazione dichiarata dove c'è
  // (calcStartupMetrics ripiega sul capitale investito, quindi per chi non
  // compila la valutazione il numero è identico a prima). Col costo fisso una
  // rivalutazione non arrivava mai al patrimonio, e quando la posizione si
  // chiudeva l'intero guadagno compariva di colpo come denaro versato.
  //
  // ponytail: resta scoperto il mese dell'incasso. La riga sintetica delle
  // startup vale `Δquantità × prezzo` per buildHistory, quindi se una posizione
  // esce dal book a un valore diverso da quello a cui era iscritta la differenza
  // è indistinguibile da un versamento. Si evita valorizzando l'exit come
  // valutazione finché è ancora attiva e incassandola il mese dopo; la
  // soluzione generale è un movimento vero per il book startup, come già
  // esiste per le quotate in transactions.js.
  const suTotal    = startupStats.activeValue;
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
        targetPct: etfTargetOf(a),
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
  }, [etfPortfolioAssets, totalTargetAssets, etfSubTotal, goldEtfValue, physGoldValue,
      grandTotal, goldEtf, goldOnTotal, etfTargetOf]);

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
  const finalVal = projData.at(-1)?.base ?? 0;
  // Capitale netto effettivamente immesso: i versamenti si fermano quando parte
  // la fase di prelievo, e i prelievi escono. Contarli per tutti gli anni dava
  // un guadagno col segno sbagliato appena si attivava il prelievo — su una
  // proiezione a 10 anni con prelievo dal quinto, −15.677 € al posto di
  // +104.323 €.
  const projCapital  = useMemo(() => projectionCapital({
    start: grandTotal, monthly: projMonthly, years: projYears,
    withdrawAfter: projWithdraw ? projWithdrawAfter : null,
    withdrawMonthly: projWithdrawMonthly,
  }), [grandTotal, projMonthly, projYears, projWithdraw, projWithdrawAfter, projWithdrawMonthly]);
  const totalContrib = projCapital.netInvested;
  const projGain     = r2(finalVal - totalContrib);
  // Il ROI si misura su quanto è uscito di tasca, non sul netto: con prelievi
  // ampi il netto può andare a zero o sotto e la percentuale esploderebbe.
  const projROI      = projCapital.contributed > 0
    ? (projGain / projCapital.contributed) * 100 : 0;

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
  // I versamenti hanno il colore del primo slot, ricalibrato sul tema.
  const C_CONTRIB = palette[0];

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

  // ---- Bilancio mensile ----
  // `cfRows` è l'unica forma che la UI legge: le entrate e le spese vengono da
  // `cashflow`, il versato dal registro movimenti. Nessuno dei due numeri viene
  // scritto due volte.
  const cfRows   = useMemo(() => cashflowRows(cashflow, transactions), [cashflow, transactions]);
  const cfTotals = useMemo(() => cashflowTotals(cfRows), [cfRows]);
  const cfYear   = new Date().getFullYear();
  const cfYtdRows = useMemo(() => cfRows.filter((r) => r.year === cfYear), [cfRows, cfYear]);
  const cfYtd     = useMemo(() => cashflowTotals(cfYtdRows), [cfYtdRows]);
  const cfCum     = useMemo(() => cumulativeInvested(cfYtdRows), [cfYtdRows]);
  const cfPlan    = useMemo(() => planVsActual(cfRows, settings.investTargetPct ?? 0),
    [cfRows, settings.investTargetPct]);

  // Versato dell'anno dal solo registro: vale anche per i mesi di bilancio non
  // ancora compilati, che nel cumulato sopra non compaiono.
  const investedThisYear = useMemo(
    () => investedByYear(transactions)[cfYear] ?? 0, [transactions, cfYear]);

  const emergency = useMemo(() => emergencyFund({
    cash: totalCash, rows: cfRows, months: settings.emergencyMonths ?? 3,
  }), [totalCash, cfRows, settings.emergencyMonths]);

  // Il mese in corso, se è già stato compilato. Se non lo è, il piano si basa
  // sulla media dei mesi passati: meglio una stima dichiarata che un vuoto.
  const cfThisMonth = useMemo(() => {
    const now = new Date();
    return cfRows.find((r) => r.year === now.getFullYear() && r.month === now.getMonth() + 1) ?? null;
  }, [cfRows]);

  const investable = useMemo(() => investableThisMonth({
    savings:      cfThisMonth ? cfThisMonth.savings : cfTotals.avgSavings,
    income:       cfThisMonth ? cfThisMonth.income  : cfTotals.avgIncome,
    targetPct:    settings.investTargetPct ?? 0,
    emergencyGap: emergency.gap,
    cashSurplus:  emergency.surplus,
  }), [cfThisMonth, cfTotals.avgSavings, cfTotals.avgIncome,
       settings.investTargetPct, emergency.gap, emergency.surplus]);

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
            totalCash, startups, assetClasses, physGold, settings, transactions, cashflow,
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
      physGold, settings, transactions, cashflow]);

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

  // ---- Bilancio: un record per mese ----
  // L'identità è anno+mese, non l'id: due righe per lo stesso mese
  // renderebbero ambiguo ogni tasso e il fondo di sicurezza.
  const saveCfMonth = (m) => {
    setCashflow((prev) => {
      const idx = prev.findIndex((x) => x.year === m.year && x.month === m.month);
      return idx >= 0 ? prev.map((x, i) => (i === idx ? { ...x, ...m } : x)) : [...prev, m];
    });
  };
  const deleteCfMonth = (id) => setCashflow((prev) => prev.filter((m) => m.id !== id));

  // Ponte bilancio → ribilanciamento: il budget del mese smette di essere un
  // numero inventato nelle impostazioni e diventa quello che il bilancio dice
  // di poter investire.
  const applyInvestableBudget = (amount) => {
    setBudget(r2(amount));
    goTab("rebalancing");
  };

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
        // Niente r2 sulla quantità: il registro ricostruisce il costo come
        // quantità × prezzo, e due decimali su uno strumento a tre cifre
        // spostano l'importo speso (500 € a 237,41 € diventano 500,93 €).
        // Vedi deriveHolding in transactions.js.
        quantity: x.amount / x.price, price: x.price, fee: 0,
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
    // Il bilancio contiene lo stipendio: il server lo toglie dalla risposta
    // pubblica (publicConfig), qui si toglie anche la tab.
    ? TABS.filter((t) => !["settings", "transactions", "budget"].includes(t.id))
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
  const allocTotal = fullClassDist.reduce((acc, d) => acc + d.value, 0);
  const renderOverview = () => (
    <div className="tab-content">
      {isEmpty ? (
        <div className="welcome-card">
          <div>
            <div className="welcome-icon"><LayoutDashboard/></div>
            <h2 className="welcome-title">Benvenuto in AssetTracker</h2>
            <p className="welcome-desc">
              Inizia aggiungendo i tuoi investimenti dalla sezione <strong>Portafoglio</strong>.
              Puoi aggiungere ETF, azioni, startup, oro e liquidità.
            </p>
            {!readOnly && (
              <button className="btn btn-primary" onClick={() => { goTab("portfolio"); setAssetModal({}); }}>
                <Plus size={16}/> Inizia ad aggiungere asset
              </button>
            )}
          </div>
          <div className="welcome-features">
            <div className="wf-item"><TrendingUp/> Prezzi live via JustETF</div>
            <div className="wf-item"><Coins/> Prezzo oro 18kt live</div>
            <div className="wf-item"><Target/> Ribilanciamento automatico</div>
            <div className="wf-item"><Camera/> Snapshot mensili</div>
            <div className="wf-item"><LineChartIcon/> Proiezioni future</div>
            <div className="wf-item"><Database/> Backup configurazione</div>
          </div>
        </div>
      ) : (
        <>
          {/* ---- Patrimonio: la cifra che si guarda per prima, col suo andamento ---- */}
          <section className="hero-panel" aria-label="Patrimonio totale e andamento">
            <div className="hero-panel__main">
              <span className="hero-panel__label"><Wallet/> Patrimonio totale</span>
              <div className="rise-mask">
                <p className="hero-figure"><Money text={fmt(grandTotal)}/></p>
              </div>
              <div className="hero-rest enter-seq">
                {monthDelta && (
                  <div className="hero-delta">
                    <span className={`delta-pill ${monthDelta.pct >= 0 ? "pos" : "neg"}`}>
                      {monthDelta.pct >= 0 ? <ArrowUpRight/> : <ArrowDownRight/>}
                      {Math.abs(monthDelta.pct).toFixed(2)}%
                    </span>
                    <span>{fmt(monthDelta.abs)} vs {monthDelta.label}</span>
                  </div>
                )}
                <p className="hero-sub">Liquidità: <strong>{fmt(totalCash)}</strong></p>
                <div className="hero-chips">
                  <span className={`chip ${driftOver ? "chip-warn" : "chip-ok"}`}
                    title={drift.worst
                      ? `Scostamento maggiore: ${drift.worst.name} (${drift.worst.actualPct.toFixed(1)}% contro un target del ${drift.worst.targetPct}%)`
                      : "Nessun target impostato"}>
                    {driftOver ? <AlertTriangle/> : <CheckCircle/>}
                    Deriva max {driftMax.toFixed(1)} pt
                  </span>
                  <span className="chip">
                    <Camera/> {snapshots.length} snapshot
                  </span>
                  {/* Il ponte col bilancio: il patrimonio dice dove sei, questo
                      dice quanto puoi aggiungerci questo mese. */}
                  {investable.available > 0 && (
                    <span className="chip chip-ok"
                      title={`Risparmio del mese meno quanto manca al fondo di sicurezza. Dettaglio nella tab Bilancio.${investable.extraFromCash > 0 ? ` Più ${fmt(investable.extraFromCash)} di liquidità già oltre il fondo.` : ""}`}>
                      <PiggyBank/> Investibile {fmt(investable.available, true)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="hero-panel__chart">
              <div className="chart-head">
                <span className="chart-head__title">Andamento patrimonio</span>
                {patrimonioData.length > 1 && (
                  <span className="chart-head__range">
                    {patrimonioData[0].label} – {patrimonioData.at(-1).label}
                  </span>
                )}
              </div>
              {patrimonioData.length > 1 ? (
                <>
                  <div className="chart-box">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={patrimonioData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="gPatrimonio" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%"   stopColor={palette[0]} stopOpacity={0.18}/>
                            <stop offset="100%" stopColor={palette[0]} stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid {...GRID}/>
                        <XAxis dataKey="label" {...X_AXIS}/>
                        <YAxis {...Y_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`}
                          domain={["auto", "auto"]} width={60}/>
                        <ReTooltip content={<CustomTooltip/>} cursor={CURSOR_LINE}/>
                        <Area type="monotone" dataKey="value" name="Patrimonio"
                          stroke={palette[0]} strokeWidth={2} fill="url(#gPatrimonio)"
                          dot={false} activeDot={ACTIVE_DOT} animationDuration={900}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="hint-text">
                    Valore totale del portafoglio a ogni snapshot mensile. Include i versamenti:
                    per separare mercato e versamenti guarda il grafico "Crescita" più sotto.
                  </p>
                </>
              ) : (
                <div className="chart-empty chart-box">
                  <p className="muted" style={{ margin: 0, padding: 16 }}>
                    L'andamento compare dal secondo snapshot mensile.
                  </p>
                </div>
              )}
            </div>
          </section>

          <div className="grid-3 enter-seq">
            <KpiCard compact label="ETF & Asset quotati" value={fmt(totals.val, true)} icon={Activity}
              trend={totals.ret * 100} trendLabel="sul costo" color="blue"/>
            <KpiCard compact label="Oro" value={fmt(goldTotal, true)} icon={Shield}
              color={goldEtfValue >= goldEtfCost ? "green" : "red"}
              sub={goldTotal > 0 && grandTotal > 0 ? `${((goldTotal / grandTotal) * 100).toFixed(1)}% del patrimonio` : null}
              trend={goldEtfPerfPct}/>
            <KpiCard compact label="Startup attive" value={fmt(suTotal, true)} icon={Briefcase}
              color={startupStats.roiOverallPct != null && startupStats.roiOverallPct < 0 ? "red" : "blue"}
              sub={`Commissioni: ${fmt(suFees)} · Abbonamento: ${fmt(suAbbonamenti)}`}
              footer={startups.length > 0 && (
                <div className="kpi-sub">
                  {startupStats.allClosed ? "Risultato finale" : "Complessivo"}:{" "}
                  <strong style={{ color: startupStats.pnlOverall >= 0 ? "var(--pos)" : "var(--neg)" }}>
                    {fmt(startupStats.pnlOverall)}
                  </strong>
                  {startupStats.closed.length > 0 && (
                    <> · realizzato {fmt(startupStats.pnlTot)} su {startupStats.closed.length} conclus{startupStats.closed.length === 1 ? "a" : "e"}</>
                  )}
                </div>
              )}/>
          </div>

          <div className="grid-split">
            <div className="stack">
            {fullClassDist.length > 0 && (
              <div className="section-card">
                <div className="panel-head">
                  <h3 className="section-title"><PieChartIcon/> Asset allocation</h3>
                  <span className="panel-meta">{fullClassDist.length} voci</span>
                </div>
                <SegmentedBar items={fullClassDist} total={allocTotal} label="Asset allocation"
                  colorOf={(d) => seriesColor(fullClassDist.indexOf(d))} fmtValue={(v) => fmt(v)}/>
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
              <div className="performer">
                <span className="performer__icon pos"><TrendingUp/></span>
                <div className="performer__body">
                  <h3 className="performer__label">Miglior performer</h3>
                  {totals.best
                    ? <div className="big-name" title={totals.best.name}>{totals.best.name}</div>
                    : <p className="muted" style={{ margin: 0 }}>Nessun dato disponibile</p>}
                </div>
                {totals.best && <Badge value={totals.best.perf * 100}/>}
              </div>
            </div>
            <div className="section-card">
              <div className="performer">
                <span className="performer__icon neg"><TrendingDown/></span>
                <div className="performer__body">
                  <h3 className="performer__label">Peggior performer</h3>
                  {totals.worst
                    ? <div className="big-name" title={totals.worst.name}>{totals.worst.name}</div>
                    : <p className="muted" style={{ margin: 0 }}>Nessun dato disponibile</p>}
                </div>
                {totals.worst && <Badge value={totals.worst.perf * 100}/>}
              </div>
            </div>
            </div>

            <div className="section-card">
              <div className="panel-head">
                <h3 className="section-title"><LineChartIcon/> Prezzi asset — base 100</h3>
                <div className="btn-row">
                  {!readOnly && (
                    <>
                      <input ref={importSnapshotsRef} type="file" accept=".json" style={{ display: "none" }}
                        onChange={(e) => { importSnapshots(e.target.files[0]); e.target.value = ""; }}/>
                      <button className="btn btn-ghost btn-sm" onClick={() => importSnapshotsRef.current?.click()}>
                        <Upload/> Importa
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={exportSnapshotsFile} disabled={snapshots.length === 0}>
                        <Download/> Esporta{snapshots.length > 0 ? ` (${snapshots.length})` : ""}
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={saveMonthlySnapshot}
                        disabled={snapshotSaving || isLoading || assets.length === 0}>
                        <Camera/> {snapshotSaving ? "Salvataggio…" : "Snapshot mensile"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {snapshotChartData.length === 0 ? (
                <div className="chart-empty" style={{ height: 280 }}>
                  <div>
                    <p className="muted" style={{ margin: "0 0 8px" }}>Nessuno snapshot registrato.</p>
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>Premi <strong>Snapshot mensile</strong> ogni mese per tracciare l'andamento.</p>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={snapshotChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid {...GRID}/>
                        <XAxis dataKey="label" {...X_AXIS}/>
                        <YAxis {...Y_AXIS} tickFormatter={(v) => v + ""} domain={["auto","auto"]} width={44}/>
                        <ReTooltip content={<SnapshotTooltip snapshots={snapshots}/>} cursor={CURSOR_LINE}/>
                        <ReferenceLine y={100} stroke="var(--chart-axis)"/>
                        {assetIds.map((id, i) => (
                          <Line key={id} type="monotone" dataKey={id} name={assetNameMap[id] || id}
                            stroke={seriesColor(i)} strokeDasharray={seriesDash(i)}
                            strokeWidth={focusedLine === id ? 3 : 2}
                            strokeOpacity={focusedLine && focusedLine !== id ? 0.15 : 1}
                            dot={snapshotChartData.length === 1 ? { r: 4 } : false}
                            activeDot={ACTIVE_DOT} hide={hiddenLines.has(id)} animationDuration={ANIM_MS}/>
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="snapshot-legend">
                    {assetIds.map((id, i) => (
                      <button key={id} className={`legend-item ${hiddenLines.has(id) ? "legend-item--hidden" : ""}`}
                        onClick={() => toggleLine(id)} aria-pressed={!hiddenLines.has(id)}
                        onMouseEnter={() => setFocusedLine(id)} onMouseLeave={() => setFocusedLine(null)}
                        onFocus={() => setFocusedLine(id)} onBlur={() => setFocusedLine(null)}>
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

          {growthRows.length > 0 && (
            <div className="section-card">
              <div className="panel-head">
                <h3 className="section-title"><TrendingUp/> Crescita: versamenti vs mercato</h3>
                <span className="panel-meta">Tutto il patrimonio, dagli snapshot mensili</span>
              </div>
              <div className="summary-strip" style={{ marginBottom: 20, maxWidth: 480 }}>
                <div className="ss-item">
                  <span className="ss-label">Versamenti</span>
                  <span className="ss-value mono">{fmt(growthTotals.contrib)}</span>
                </div>
                <div className="ss-item">
                  <span className="ss-label">Mercato</span>
                  <span className={`ss-value mono ${growthTotals.market >= 0 ? "pos-text" : "neg-text"}`}>{fmt(growthTotals.market)}</span>
                </div>
              </div>
              <div className="chart-legend">
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_CONTRIB }}/>Versamenti</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_GAIN }}/>Mercato in guadagno</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_LOSS }}/>Mercato in perdita</span>
              </div>
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={growthRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                    <CartesianGrid {...GRID}/>
                    <XAxis dataKey="label" {...X_AXIS}/>
                    <YAxis {...Y_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`} width={60}/>
                    <ReTooltip content={<CustomTooltip/>} cursor={CURSOR_BAND}/>
                    <ReferenceLine y={0} stroke="var(--chart-axis)"/>
                    <Bar dataKey="contrib" name="Versamenti" fill={C_CONTRIB} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} animationDuration={ANIM_MS}/>
                    <Bar dataKey="market"  name="Mercato" fill={C_GAIN} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} animationDuration={ANIM_MS}>
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

  // ====================== TAB: BILANCIO ======================
  // Il pezzo che collega lo stipendio al portafoglio: entrate e spese si
  // inseriscono qui, il versato arriva dai movimenti, e la sintesi delle due
  // cose è il budget del ribilanciamento.
  const renderBudget = () => {
    const cfLabel = (r) => `${MONTH_LABELS_IT[r.month - 1]} ${r.year}`;
    const chartRows = cfRows.slice(-18).map((r) => ({
      label: cfLabel(r),
      entrate: r.income, spese: r.expenses, risparmio: r.savings, versato: r.invested,
    }));
    const planRows = cfPlan.slice(-18).map((r) => ({
      label: cfLabel(r), piano: r.planned, versato: r.invested,
    }));
    const stima = !cfThisMonth;   // mese in corso non ancora compilato
    const efPct = emergency.target > 0
      ? Math.min(100, r2((emergency.cash / emergency.target) * 100)) : 0;
    const overBudget = (settings.expenseBudget ?? 0) > 0 && cfThisMonth
      && cfThisMonth.expenses > settings.expenseBudget;

    return (
      <div className="tab-content">
        {cfRows.length === 0 ? (
          <EmptyState icon={PiggyBank} title="Nessun mese registrato"
            description="Registra stipendio, entrate extra e spese di ogni mese: l'app calcola quanto ti resta, quanto ne hai davvero investito (dai movimenti) e quanto puoi investire adesso senza intaccare il fondo di sicurezza."
            action={
              <button className="btn btn-primary" onClick={() => setCfModal({})}>
                <Plus size={15}/> Aggiungi il primo mese
              </button>
            }/>
        ) : (
          <>
            {/* Quanto posso investire — il ponte col ribilanciamento */}
            <div className="section-card">
              <div className="panel-head">
                <h2 className="section-title">
                  <HandCoins size={16}/> Questo mese puoi investire
                </h2>
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={() => setCfModal({})}>
                    <Plus size={15}/> Aggiungi mese
                  </button>
                </div>
              </div>

              <div className="grid-4">
                <KpiCard hero label={stima ? "Investibile (stima)" : "Investibile questo mese"}
                  value={fmt(investable.available)} icon={PiggyBank}
                  color={investable.available > 0 ? "green" : "amber"}
                  sub={stima
                    ? `Media degli ultimi ${cfTotals.months} mesi — il mese in corso non è ancora registrato`
                    : `Da ${fmt(investable.planned)} di ${settings.investTargetPct > 0 ? `quota (${settings.investTargetPct}% delle entrate)` : "risparmio del mese"}`}
                  footer={
                    <div className="hero-chips">
                      {investable.emergencyGap > 0 && (
                        <span className="chip chip-warn" title="Prima si riempie il fondo di sicurezza">
                          <AlertTriangle size={12}/> −{fmt(investable.emergencyGap)} al fondo
                        </span>
                      )}
                      {investable.extraFromCash > 0 && (
                        <span className="chip chip-ok" title="Liquidità già oltre il fondo di sicurezza: capitale fermo">
                          <Wallet size={12}/> +{fmt(investable.extraFromCash)} da liquidità
                        </span>
                      )}
                      <button className="btn btn-ghost btn-sm"
                        onClick={() => applyInvestableBudget(investable.available)}
                        disabled={investable.available <= 0}>
                        <Target size={12}/> Usa come budget
                      </button>
                    </div>
                  }/>
                <KpiCard compact label="Massimo investibile" value={fmt(investable.total, true)}
                  color="blue" icon={Coins}
                  sub="Risparmio del mese + liquidità eccedente il fondo"/>
                <KpiCard compact label={`Versato nel ${cfYear}`} value={fmt(investedThisYear, true)}
                  color="blue" icon={TrendingUp}
                  sub={cfYtd.investmentRate != null
                    ? `${cfYtd.investmentRate}% delle entrate dell'anno`
                    : "Dai movimenti registrati"}/>
                <KpiCard compact label="Tasso di risparmio"
                  value={cfYtd.savingsRate != null ? `${cfYtd.savingsRate}%` : "—"}
                  color={(cfYtd.savingsRate ?? 0) >= 20 ? "green" : "amber"} icon={PiggyBank}
                  sub={`${cfYear} · risparmiati ${fmt(cfYtd.savings, true)} su ${fmt(cfYtd.income, true)}`}/>
              </div>

              {overBudget && (
                <div className="alert alert-amber" style={{ marginTop: 12 }}>
                  <AlertTriangle size={15}/>
                  {" "}Spese di {cfLabel(cfThisMonth)} a {fmt(cfThisMonth.expenses)}, sopra il tetto
                  di {fmt(settings.expenseBudget)} che ti sei dato: {fmt(r2(cfThisMonth.expenses - settings.expenseBudget))} in più.
                </div>
              )}
            </div>

            {/* Fondo di sicurezza */}
            <div className="section-card">
              <h3 className="section-title"><Shield size={16}/> Fondo di sicurezza</h3>
              {emergency.target === 0 ? (
                <p className="muted">
                  Registra le spese di almeno un mese per dimensionare il fondo.
                </p>
              ) : (
                <>
                  <div className="summary-strip" style={{ marginBottom: 12 }}>
                    <div className="ss-item">
                      <span className="ss-label">Spesa media (ultimi {EF_WINDOW} mesi)</span>
                      <span className="ss-value mono">{fmt(emergency.avgExpenses)}</span>
                    </div>
                    <div className="ss-item">
                      <span className="ss-label">Bersaglio ({settings.emergencyMonths ?? 3} mesi)</span>
                      <span className="ss-value mono">{fmt(emergency.target)}</span>
                    </div>
                    <div className="ss-item">
                      <span className="ss-label">Liquidità</span>
                      <span className="ss-value mono">{fmt(emergency.cash)}</span>
                    </div>
                    <div className="ss-item">
                      <span className="ss-label">Mesi coperti</span>
                      <span className={`ss-value mono ${emergency.ok ? "pos-text" : "neg-text"}`}>
                        {emergency.monthsCovered != null ? emergency.monthsCovered.toFixed(1) : "—"}
                      </span>
                    </div>
                  </div>
                  <div className="ef-bar" role="img"
                    aria-label={`Fondo di sicurezza coperto al ${efPct}% del bersaglio`}>
                    <div className={`ef-fill ${emergency.ok ? "ef-ok" : "ef-low"}`}
                      style={{ width: `${efPct}%` }}/>
                  </div>
                  <p className="hint-text" style={{ marginTop: 8 }}>
                    {emergency.ok
                      ? `Fondo completo: ${fmt(emergency.surplus)} di liquidità oltre il bersaglio è capitale fermo, puoi investirlo.`
                      : `Mancano ${fmt(emergency.gap)} al bersaglio. Il fondo viene prima degli investimenti: disinvestire durante un imprevisto significa vendere nel momento peggiore.`}
                  </p>
                </>
              )}
            </div>

            {/* Entrate, spese, risparmio nel tempo */}
            <div className="section-card">
              <h3 className="section-title"><Activity size={16}/> Entrate, spese e risparmio</h3>
              <div className="chart-legend">
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_GAIN }}/>Entrate</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_LOSS }}/>Spese</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_CONTRIB }}/>Risparmio</span>
              </div>
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartRows} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid {...GRID}/>
                    <XAxis dataKey="label" {...X_AXIS}/>
                    <YAxis {...Y_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`} width={60}/>
                    <ReTooltip content={<CustomTooltip/>} cursor={CURSOR_BAND}/>
                    <ReferenceLine y={0} stroke="var(--chart-axis)"/>
                    <Bar dataKey="entrate" name="Entrate" fill={C_GAIN} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX}/>
                    <Bar dataKey="spese"   name="Spese"   fill={C_LOSS} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX}/>
                    <Line type="monotone" dataKey="risparmio" name="Risparmio" stroke={C_CONTRIB}
                      strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: C_CONTRIB }} activeDot={ACTIVE_DOT}/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Piano vs realizzato */}
            <div className="section-card">
              <h3 className="section-title"><Target size={16}/> Pianificato vs versato</h3>
              <p className="hint-text" style={{ marginTop: 0, marginBottom: 12 }}>
                {settings.investTargetPct > 0
                  ? `Il piano è il ${settings.investTargetPct}% delle entrate del mese (Impostazioni → quota da investire).`
                  : "Senza una quota impostata il piano è il risparmio del mese: tutto quello che avanza. Imposta una quota nelle Impostazioni per un obiettivo fisso."}
                {" "}Il versato viene dai movimenti registrati.
              </p>
              <div className="chart-legend">
                <span className="cl-item"><span className="cl-swatch" style={{ background: palette[2] }}/>Piano</span>
                <span className="cl-item"><span className="cl-swatch" style={{ background: C_CONTRIB }}/>Versato</span>
              </div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={planRows} margin={{ top: 4, right: 16, left: 0, bottom: 4 }} barGap={2}>
                    <CartesianGrid {...GRID}/>
                    <XAxis dataKey="label" {...X_AXIS}/>
                    <YAxis {...Y_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`} width={60}/>
                    <ReTooltip content={<CustomTooltip/>} cursor={CURSOR_BAND}/>
                    <ReferenceLine y={0} stroke="var(--chart-axis)"/>
                    <Bar dataKey="piano"   name="Piano"   fill={palette[2]} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX}/>
                    <Bar dataKey="versato" name="Versato" fill={C_CONTRIB} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {cfCum.length > 0 && (
                <p className="hint-text">
                  Cumulato {cfYear}: <strong>{fmt(cfCum.at(-1).cumulative)}</strong> versati
                  nei {cfCum.length} mesi registrati
                  {investedThisYear !== cfCum.at(-1).cumulative && (
                    <> · {fmt(investedThisYear)} contando tutti i movimenti dell'anno,
                    anche quelli di mesi non ancora inseriti nel bilancio</>
                  )}.
                </p>
              )}
            </div>

            {/* Storico mensile */}
            <div className="section-card">
              <div className="panel-head">
                <h3 className="section-title">
                  <Receipt size={16}/> Storico mensile
                </h3>
                <span className="panel-meta">
                  {cfTotals.months} mesi · media risparmio {fmt(cfTotals.avgSavings)}
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Mese</th>
                      <th className="num">Stipendio</th>
                      <th className="num">Extra</th>
                      <th className="num">Spese</th>
                      <th className="num">Risparmio</th>
                      <th className="num">Tasso risp.</th>
                      <th className="num">Versato</th>
                      <th className="num">Tasso invest.</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...cfRows].reverse().map((r) => (
                      <tr key={r.id}>
                        <td className="asset-name">
                          {cfLabel(r)}
                          {r.note && <span className="cell-sub"> · {r.note}</span>}
                        </td>
                        <td className="num mono">{fmt(r.salary)}</td>
                        <td className="num mono">{r.extra ? fmt(r.extra) : "—"}</td>
                        <td className="num mono">{fmt(r.expenses)}</td>
                        <td className={`num mono ${r.savings >= 0 ? "pos-text" : "neg-text"}`}>{fmt(r.savings)}</td>
                        <td className="num mono">{r.savingsRate != null ? `${r.savingsRate}%` : "—"}</td>
                        <td className="num mono">{fmt(r.invested)}</td>
                        <td className="num mono">{r.investmentRate != null ? `${r.investmentRate}%` : "—"}</td>
                        <td>
                          <div className="row-actions">
                            <button className="icon-btn" onClick={() => setCfModal(r)} title="Modifica">
                              <Edit2 size={14}/>
                            </button>
                            <button className="icon-btn danger" title="Elimina"
                              onClick={() => { if (window.confirm(`Rimuovere il bilancio di ${cfLabel(r)}?`)) deleteCfMonth(r.id); }}>
                              <Trash2 size={14}/>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <td><strong>Totale</strong></td>
                      <td className="num mono">{fmt(r2(cfTotals.income - cfRows.reduce((a, r) => a + r.extra, 0)))}</td>
                      <td className="num mono">{fmt(r2(cfRows.reduce((a, r) => a + r.extra, 0)))}</td>
                      <td className="num mono">{fmt(cfTotals.expenses)}</td>
                      <td className={`num mono ${cfTotals.savings >= 0 ? "pos-text" : "neg-text"}`}>{fmt(cfTotals.savings)}</td>
                      <td className="num mono">{cfTotals.savingsRate != null ? `${cfTotals.savingsRate}%` : "—"}</td>
                      <td className="num mono">{fmt(cfTotals.invested)}</td>
                      <td className="num mono">{cfTotals.investmentRate != null ? `${cfTotals.investmentRate}%` : "—"}</td>
                      <td/>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="hint-text" style={{ marginTop: 8 }}>
                I tassi complessivi sono calcolati sui totali, non come media delle
                percentuali mensili: altrimenti il mese della tredicesima peserebbe
                quanto un mese normale.
                {" "}La colonna <strong>Versato</strong> arriva dai movimenti (acquisti meno
                vendite, commissioni comprese): i dividendi non contano come versamento.
              </p>
            </div>
          </>
        )}
      </div>
    );
  };

  // ====================== TAB: PORTFOLIO ======================
  // Le colonne del registro compaiono solo se il registro è in uso: su un
  // portafoglio a posizioni inserite a mano sarebbero due colonne di trattini.
  const hasTxCols = Object.keys(holdingByKey).length > 0;

  const renderPortfolio = () => (
    <div className="tab-content">
      {/* Liquidità */}
      <div className="section-card">
        <div className="panel-head">
          <h2 className="section-title"><Wallet size={16}/> Liquidità</h2>
          {!editCash ? (
            !readOnly && <button className="icon-btn" onClick={() => { setCashInput(totalCash); setEditCash(true); }} title="Modifica liquidità" aria-label="Modifica liquidità"><Edit2 size={14}/></button>
          ) : (
            <div className="cash-edit">
              <input type="number" step="any" value={cashInput} onChange={(e) => setCashInput(e.target.value)}
                className="field-input" aria-label="Liquidità in euro"/>
              <button className="btn btn-primary" onClick={() => { setCash(parseFloat(cashInput) || 0); setEditCash(false); }}>
                <CheckCircle size={14}/> OK
              </button>
              <button className="btn btn-ghost" onClick={() => setEditCash(false)} aria-label="Annulla"><X size={14}/></button>
            </div>
          )}
        </div>
        {!editCash && (
          <div className="cash-figure">
            {totalCash > 0
              ? fmt(totalCash)
              : <span className="muted" style={{ fontSize: 15, fontWeight: 400, letterSpacing: 0 }}>
                  {readOnly ? "Nessuna liquidità registrata" : "Clicca la matita per inserire la liquidità"}
                </span>}
          </div>
        )}
      </div>

      {/* ETF & Asset */}
      <div className="section-card">
        <div className="panel-head">
          <div className="panel-head__group">
            <h2 className="section-title"><Briefcase size={16}/> ETF & Asset quotati</h2>
            {etfSubTotal > 0 && <span className="panel-meta">Totale: <strong>{fmt(etfSubTotal)}</strong></span>}
          </div>
          <div className="btn-row">
            {!readOnly && (
              <button className="btn btn-ghost" onClick={() => setACModal(true)} title="Gestisci asset class">
                <Tag size={15}/> Asset class
              </button>
            )}
            {etfAssets.length > 0 && (
              <div className="search-wrap">
                <Search size={15} className="search-icon"/>
                <input className="search-input" placeholder="Cerca per nome o ISIN" aria-label="Cerca asset" value={search} onChange={(e) => setSearch(e.target.value)}/>
                {search && <button className="icon-btn" onClick={() => setSearch("")} aria-label="Cancella ricerca"><X size={14}/></button>}
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
                    // Confronto col target normalizzato, lo stesso che usa il
                    // ribilanciamento; nel badge resta il valore inserito.
                    const tgtNorm = etfTargetOf(a);
                    const diff    = weight - tgtNorm;
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
                            title={etfTargetSum === 100
                              ? "Target % sul sotto-portafoglio ETF"
                              : `I target inseriti sommano a ${etfTargetSum}%: il confronto e il ribilanciamento usano il valore normalizzato a 100, cioè ${etfTargetOf(a)}%.`}>
                            {a.targetWeight || 0}%
                            {etfTargetSum !== 100 && (
                              <span className="cell-sub"> → {etfTargetOf(a)}%</span>
                            )}
                          </span>
                        </td>
                        <td><span className="class-tag">{a.assetClass}</span></td>
                        <td>
                          {!readOnly && (
                            <div className="row-actions">
                              <button className="icon-btn" onClick={() => setAssetModal(a)} title="Modifica" aria-label="Modifica"><Edit2 size={14}/></button>
                              <button className="icon-btn danger" title="Rimuovi" aria-label="Rimuovi" onClick={() => { if (window.confirm(`Rimuovere ${a.name}?`)) deleteAsset(a.id); }}>
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
                    <tr className="total-row total-row--aside">
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
      <div className="section-card">
        {/* Header */}
        <div className="panel-head">
          <div className="panel-head__group">
            <h2 className="section-title">
              Oro &amp; Bitcoin
            </h2>
            {goldBtcTotal > 0 && (
              <div className="kpi-mini-row">
                <span>Totale: <strong>{fmt(goldBtcTotal)}</strong></span>
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
            >
              <RefreshCw size={14} className={(goldLoading || loading[goldEtf.id]) ? "spin" : ""}/>
              {goldLoading ? "Aggiornamento…" : "Aggiorna prezzi oro"}
            </button>
          )}
        </div>

        {goldPriceErr && (
          <div className="alert alert-amber" style={{ marginBottom: 16 }}>
            <AlertTriangle size={14}/> <span>{goldPriceErr}
            <span className="muted">
              — Assicurati che il backend esponga <code>/api/gold-price</code>
            </span></span>
          </div>
        )}

        {/* ---- ETF Oro quotato ---- */}
        <div className="gold-block">
          <div className="gold-sub-header">
            <span className="gold-sub-label">ETF Oro quotato</span>
            {!readOnly && (
              <button className="icon-btn" onClick={() => setGoldEtfModal(true)} title="Configura ETF oro">
                <Edit2 size={14}/>
              </button>
            )}
          </div>

          {!goldEtf.identifier ? (
            <div className="empty-inline">
              <AlertTriangle size={14}/>
              <span>
                {readOnly ? "Nessun ETF oro configurato." : "Configura l'ETF oro inserendo ISIN e quantità."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost btn-sm"
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
                        <span className="cell-sub">{goldOnTotal ? " tot" : " etf"}</span>
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
        <div className="gold-block">
          <div className="gold-sub-header">
            <span className="gold-sub-label">Oro fisico 18kt</span>
            {!readOnly && (
              <button className="icon-btn" onClick={() => setPhysGoldModal(true)} title="Modifica oro fisico">
                <Edit2 size={14}/>
              </button>
            )}
          </div>

          {physGold.grams === 0 ? (
            <div className="empty-inline">
              <span>
                Nessun oro fisico registrato.{!readOnly && " Clicca la matita per inserire la grammatura."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost btn-sm"
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
                      <th className="num">Ult. agg.</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span className="class-tag class-tag--gold">
                          18kt
                        </span>
                        {" "}Oro fisico
                      </td>
                      <td className="num mono"><strong>{physGold.grams} g</strong></td>
                      <td className="num mono">
                        {physGold.pricePerGram18kt
                          ? fmt(physGold.pricePerGram18kt)
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num mono">
                        <strong>{physGoldValue > 0 ? fmt(physGoldValue) : "—"}</strong>
                      </td>
                      <td className="num muted">
                        {physGold.lastUpdated
                          ? new Date(physGold.lastUpdated).toLocaleDateString("it-IT")
                          : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {physGold.grams > 0 && !physGold.pricePerGram18kt && (
                <p className="hint-text is-warn">
                  <AlertTriangle size={15}/>
                  <span>Prezzo 18kt non disponibile. Premi <strong>Aggiorna prezzi oro</strong> oppure inserisci il prezzo manualmente dalla matita.</span>
                </p>
              )}
              {physGold.grams > 0 && physGold.pricePerGram18kt && (
                <p className="hint-text">
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
        <div className="gold-block">
          <div className="gold-sub-header">
            <span className="gold-sub-label gold-sub-label--btc">Bitcoin</span>
            {!readOnly && (
              <button className="icon-btn" onClick={() => setAssetModal({ targetOnTotal: true, assetClass: "Crypto" })}
                title="Aggiungi asset con target sul patrimonio totale">
                <Plus size={14}/>
              </button>
            )}
          </div>

          {totalTargetAssets.length === 0 ? (
            <div className="empty-inline">
              <span>
                Nessun Bitcoin registrato.{!readOnly && " Aggiungi un ETP con target in % del patrimonio totale."}
              </span>
              {!readOnly && (
                <button className="btn btn-ghost btn-sm"
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
                                <button className="icon-btn" onClick={() => setAssetModal(a)} title="Modifica" aria-label="Modifica"><Edit2 size={14}/></button>
                                <button className="icon-btn danger" title="Rimuovi" aria-label="Rimuovi" onClick={() => { if (window.confirm(`Rimuovere ${a.name}?`)) deleteAsset(a.id); }}>
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
        <div className="panel-head">
          <div className="panel-head__group">
            <h2 className="section-title"><Activity size={16}/> Investimenti Startup</h2>
            {startups.length > 0 && (
              <div className="kpi-mini-row">
                <span>Attive: <strong>{startupStats.active.length}</strong></span>
                <span>Concluse: <strong>{startupStats.closed.length}</strong></span>
                <span>Abbonamento: <strong>{fmt(suAbbonamenti)}</strong></span>
                <span>Esborso: <strong>{fmt(startupStats.totalOutlay)}</strong></span>
              </div>
            )}
          </div>
          {!readOnly && (
            <button className="btn btn-ghost" onClick={() => setStartupModal({})}><Plus size={15}/> Aggiungi startup</button>
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
                ? `Bilancio finale: a fronte di ${fmt(startupStats.totalOutlay)} di esborso complessivo (capitale + commissioni + abbonamento) hai recuperato ${fmt(startupStats.totalValue)}, con un risultato di ${fmt(startupStats.pnlOverall)}.`
                : <>
                    {startupStats.closed.length === 0
                      ? "Nessuna startup conclusa: P&L realizzato e ROI su concluse si calcolano su Exit e Fallimenti."
                      : startupStats.pnlTot >= 0
                        ? `Sulle ${startupStats.closed.length} startup concluse hai recuperato ${fmt(startupStats.recoveredTot)} a fronte di ${fmt(startupStats.closedCost)} di costo totale (commissioni incluse).`
                        : `Sulle ${startupStats.closed.length} startup concluse hai recuperato ${fmt(startupStats.recoveredTot)} a fronte di ${fmt(startupStats.closedCost)} di costo totale (commissioni incluse): il capitale non è ancora rientrato.`}
                    {" "}Il ROI complessivo include l'abbonamento ({fmt(startupStats.subscription)}) e valorizza le {startupStats.active.length} attive a {fmt(startupStats.activeValue)}: diventerà il risultato definitivo quando tutte saranno chiuse.
                  </>}
              {" "}Le startup attive ({fmt(startupStats.activeValue)}) entrano nel patrimonio alla valutazione dichiarata, al costo dove non c'è; le concluse ne escono — l'incasso di un'exit va inserito a mano in liquidità. Per non far leggere il guadagno come un versamento, aggiorna prima la valutazione della posizione e incassa il mese successivo.
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
                          <button className="icon-btn" onClick={() => setStartupModal(s)} title="Modifica" aria-label="Modifica"><Edit2 size={14}/></button>
                          <button className="icon-btn danger" title="Rimuovi" aria-label="Rimuovi" onClick={() => { if (window.confirm(`Rimuovere ${s.name}?`)) deleteSU(s.id); }}>
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
        <div className="panel-head">
          <div>
            <h3 className="section-title"><Settings size={16}/> Configurazione portafoglio</h3>
            <p className="hint-text" style={{ marginTop: 6 }}>
              Il portafoglio viene <strong>salvato automaticamente sul server</strong> a ogni modifica.
              Export/import JSON servono solo come backup o per migrare su un'altra installazione.
            </p>
          </div>
          <div className="btn-row">
            <input ref={configImportRef} type="file" accept=".json" style={{ display: "none" }}
              onChange={(e) => { importConfig(e.target.files[0]); e.target.value = ""; }}/>
            <button className="btn btn-ghost" onClick={() => configImportRef.current?.click()}>
              <Upload size={15}/> Importa
            </button>
            <button className="btn btn-ghost" onClick={exportConfig}>
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
          <div className="panel-head">
            <div className="panel-head__group">
              <h3 className="section-title"><Camera size={16}/> Storico snapshot</h3>
              <span className="panel-meta">{snapshots.length} mesi</span>
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
                  <button key={g.label} className="btn btn-ghost btn-sm"
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
            <div className="table-wrap table-wrap--scroll">
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
            <span className="section-title">Periodo</span>
            <div className="period-tabs" role="group" aria-label="Periodo delle analisi" ref={periodInd.containerRef}>
              <span className="period-ind" ref={periodInd.indRef} aria-hidden="true"/>
              {PERIODS.map((p) => (
                <button key={p.id} className={`period-btn ${period === p.id ? "active" : ""}`}
                  aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <span className="period-bar__info">
              {anaSnaps.length > 1
                ? <>{anaSnaps.length} mesi · da {anaSnaps[0].label} a {anaSnaps.at(-1).label}</>
                : "Storico insufficiente per questo periodo"}
            </span>
          </div>

          <div className="section-card">
            <div className="panel-head">
              <h3 className="section-title"><Shield size={16}/> Metriche di rischio</h3>
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
                ? `${riskObs} rendimenti mensili disponibili: volatilità e rapporti sono indicativi finché non se ne accumulano ${OBS_RELIABLE}. Sotto le 12 osservazioni non vengono proprio calcolati — un numero costruito su pochi mesi dipende da quali mesi sono capitati nel campione, non dal portafoglio.`
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
            <div className="panel-head">
              <h3 className="section-title"><Target size={16}/> Confronto con un riferimento</h3>
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
                      <CartesianGrid {...GRID}/>
                      <XAxis dataKey="label" {...X_AXIS}/>
                      <YAxis {...Y_AXIS} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(0)} width={44}/>
                      <ReTooltip formatter={(v) => (v == null ? "—" : v.toFixed(1))} cursor={CURSOR_LINE}/>
                      <ReferenceLine y={100} stroke="var(--chart-axis)"/>
                      <Line type="monotone" dataKey="portfolio" name="Patrimonio" stroke={seriesColor(0)}
                        strokeWidth={2} dot={false} activeDot={ACTIVE_DOT} animationDuration={ANIM_MS}/>
                      <Line type="monotone" dataKey="benchmark" name="Riferimento" stroke={seriesColor(2)}
                        strokeWidth={2} dot={false} strokeDasharray="5 4" connectNulls activeDot={ACTIVE_DOT} animationDuration={ANIM_MS}/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-legend" style={{ marginTop: 12, marginBottom: 0 }}>
                  <span className="cl-item"><span className="cl-swatch cl-swatch--line" style={{ background: seriesColor(0) }}/> Patrimonio</span>
                  <span className="cl-item"><span className="cl-swatch cl-swatch--dash" style={{ borderColor: seriesColor(2) }}/> {txNameByKey[settings.benchmarkKey] || "Riferimento"}</span>
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
                        <stop offset="0%" stopColor={C_LOSS} stopOpacity={0.04}/>
                        <stop offset="100%" stopColor={C_LOSS} stopOpacity={0.24}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...GRID}/>
                    <XAxis dataKey="label" {...X_AXIS}/>
                    <YAxis {...Y_AXIS} tickFormatter={(v) => `${v}%`} width={48}/>
                    <ReTooltip formatter={(v) => `${v}%`} cursor={CURSOR_LINE}/>
                    <ReferenceLine y={0} stroke="var(--chart-axis)"/>
                    <Area type="monotone" dataKey="dd" name="Drawdown" stroke={C_LOSS} fill="url(#gDd)" strokeWidth={2} activeDot={ACTIVE_DOT} animationDuration={ANIM_MS}/>
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
                    <CartesianGrid {...GRID_V}/>
                    <XAxis type="number" {...X_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`}/>
                    <YAxis type="category" dataKey="key" width={140} {...Y_AXIS}
                      tickFormatter={(k) => assetNameMap[k] || k}/>
                    <ReTooltip formatter={(v) => [fmt(v), "Contributo"]} labelFormatter={(k) => assetNameMap[k] || k} cursor={CURSOR_BAND}/>
                    <ReferenceLine x={0} stroke="var(--chart-axis)"/>
                    <Bar dataKey="gain" radius={[0, 4, 4, 0]} maxBarSize={BAR_MAX} animationDuration={ANIM_MS}>
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
                    <CartesianGrid {...GRID}/>
                    <XAxis dataKey="label" {...X_AXIS}/>
                    <YAxis {...Y_AXIS} domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={44}/>
                    <ReTooltip formatter={(v, k) => [`${v}%`, assetNameMap[k] || k]} cursor={CURSOR_LINE}/>
                    {allIds.map((k, i) => (
                      <Area key={k} type="monotone" dataKey={k} stackId="alloc"
                        stroke={seriesColor(i)} strokeWidth={1.5} fill={seriesColor(i)} fillOpacity={0.55} animationDuration={ANIM_MS}/>
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
                      // Un anno con meno di 12 mesi non è un rendimento annuo: è
                      // il composto dei mesi che ci sono. Senza dirlo, l'anno in
                      // corso e quello d'esordio si leggono come gli altri.
                      const parziale = vals.length > 0 && vals.length < 12;
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
                          <td className={`num mono ${(yearRet ?? 0) >= 0 ? "pos-text" : "neg-text"}`}
                            title={parziale
                              ? `Composto di ${vals.length} mesi su 12: non è un rendimento annuo.`
                              : undefined}>
                            <strong>{yearRet == null ? "—" : `${yearRet > 0 ? "+" : ""}${yearRet.toFixed(1)}%`}</strong>
                            {parziale && <span className="cell-sub"> ({vals.length}m)</span>}
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
                <div style={{ marginTop: 20 }}>
                  <h4 className="sub-head" style={{ marginBottom: 8 }}>Zainetto fiscale</h4>
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
                      <AlertTriangle size={14}/> {fmt(fiscal.expiring)} di minusvalenze scadono a fine
                      anno senza essere state usate: si recuperano solo realizzando una plusvalenza
                      compensabile (azioni, ETC, crypto — non ETF) entro il termine.
                    </div>
                  )}
                  {fiscal.expired > 0 && (
                    <div className="alert alert-amber" style={{ marginTop: 8 }}>
                      <AlertTriangle size={14}/> {fmt(fiscal.expired)} di minusvalenze sono già scadute
                      e non sono più compensabili.
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
        <div className="panel-head">
          <div className="panel-head__group">
            <h2 className="section-title">
              <ArrowLeftRight size={16}/> Movimenti
            </h2>
            {transactions.length > 0 && (
              <span className="panel-meta">{transactions.length} registrati</span>
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
                        <td className="mono code">{t.date}</td>
                        <td className="asset-name">
                          {txNameByKey[t.assetKey] || <span className="muted">{t.assetKey}</span>}
                        </td>
                        <td><span className={`class-tag tx-tag tx-${t.type}`}>{TX_LABELS[t.type] || t.type}</span></td>
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
                              <button className="icon-btn" onClick={() => setTxModal(t)} title="Modifica" aria-label="Modifica"><Edit2 size={14}/></button>
                              <button className="icon-btn danger" title="Rimuovi" aria-label="Rimuovi"
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
  // Gli stessi campi di prima, raggruppati per l'area dell'app su cui agiscono.
  const SETTINGS_GROUPS = [
    { title: "Portafoglio e ribilanciamento", icon: Target, fields: [
      { key: "monthlyBudget",       label: "Budget mensile default (€)",    set: setBudget, step: 50,  min: 0 },
      { key: "rebalanceBand",       label: "Banda ribilanciamento (punti %)", set: null,    step: 0.5, min: 0, max: 25 },
      { key: "startupSubscription", label: "Abbonamento startup annuo (€)", set: null,      step: 1,   min: 0 },
    ]},
    { title: "Proiezione", icon: LineChartIcon, fields: [
      { key: "projReturn",          label: "Rendimento annuo default (%)",  set: setProjR,  step: 0.5, min: 0, max: 30 },
      { key: "projMonthly",         label: "Investimento mensile default (€)", set: setProjM, step: 100, min: 0 },
      { key: "projYears",           label: "Anni proiezione default",       set: setProjY,  step: 1,   min: 1, max: 50 },
      { key: "inflation",           label: "Inflazione attesa (%)",         set: null,      step: 0.1, min: 0, max: 20 },
    ]},
    { title: "Rischio e fisco", icon: Shield, fields: [
      { key: "riskFree",            label: "Tasso privo di rischio (%)",    set: null,      step: 0.1, min: 0, max: 15 },
      { key: "taxRate",             label: "Aliquota capital gain (%)",     set: null,      step: 0.5, min: 0, max: 50 },
      { key: "taxBollo",            label: "Bollo titoli annuo (%)",        set: null,      step: 0.05, min: 0, max: 2 },
    ]},
    { title: "Bilancio", icon: PiggyBank, fields: [
      { key: "emergencyMonths",     label: "Fondo di sicurezza (mesi di spese)", set: null, step: 1, min: 1, max: 24 },
      { key: "investTargetPct",     label: "Quota entrate da investire (%)", set: null,     step: 1,   min: 0, max: 100 },
      { key: "expenseBudget",       label: "Tetto di spesa mensile (€)",    set: null,      step: 50,  min: 0 },
    ]},
  ];
  const renderSettings = () => (
    <div className="tab-content">
      {SETTINGS_GROUPS.map(({ title, icon: Icon, fields }) => (
        <section key={title} className="section-card settings-group">
          <h2 className="section-title"><Icon size={16}/> {title}</h2>
          <div className="form-grid">
            {fields.map(({ key, label, set, step, min, max }) => (
              <label key={key} className="field-label">
                {label}
                <input type="number" value={settings[key] ?? 0}
                  onChange={(e) => setSetting(key, parseFloat(e.target.value) || 0, set)}
                  step={step} min={min} max={max} className="field-input"/>
              </label>
            ))}
          </div>
        </section>
      ))}
      <p className="hint-text" style={{ marginTop: 0 }}>
        Le classi di asset si gestiscono dal pulsante dedicato nella tab Portafoglio.
        {" "}<strong>Quota entrate da investire</strong> a 0 significa "non impostata":
        il piano mensile diventa semplicemente quello che avanza dopo le spese.
        {" "}<strong>Tetto di spesa</strong> a 0 disattiva l'avviso di sforamento.
      </p>
    </div>
  );

  // ====================== TAB: PROJECTION ======================
  const renderProjection = () => (
    <div className="tab-content">
      <div className="section-card">
        <h2 className="section-title"><LineChartIcon size={16}/> Proiezione crescita — scenari multipli</h2>
        <div className="form-grid" style={{ marginBottom: 24 }}>
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

        {cfTotals.avgInvested > 0 && r2(projMonthly) !== cfTotals.avgInvested && (
          <p className="hint-text" style={{ marginTop: -8, marginBottom: 24 }}>
            {/* La proiezione partiva da un numero desiderato. Il bilancio sa
                quello vero, ed è l'unico che dice dove si finisce davvero. */}
            Nei {cfTotals.months} mesi registrati hai versato in media{" "}
            <strong>{fmt(cfTotals.avgInvested)}</strong> al mese.{" "}
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8, verticalAlign: "middle" }}
              onClick={() => setProjM(cfTotals.avgInvested)}>
              <PiggyBank size={13}/> Proietta su questo
            </button>
          </p>
        )}

        {/* Fase di prelievo */}
        <div style={{ marginBottom: 24 }}>
          <label className="field-check">
            <input type="checkbox" checked={projWithdraw} onChange={(e) => setProjW(e.target.checked)}/>
            Simula la fase di prelievo (si smette di versare e si inizia a ritirare)
          </label>
          {projWithdraw && (
            <div className="form-grid" style={{ marginTop: 16 }}>
              <label className="field-label">Inizio prelievi (anni da oggi)
                <input type="number" value={projWithdrawAfter} min={0} max={projYears} step={1}
                  onChange={(e) => setProjWA(parseFloat(e.target.value) || 0)} className="field-input"/>
              </label>
              <label className="field-label">Prelievo mensile (€)
                <input type="number" value={projWithdrawMonthly} min={0} step={100}
                  onChange={(e) => setProjWM(parseFloat(e.target.value) || 0)} className="field-input"/>
              </label>
              <label className="field-label">Prelievo annuo
                <input className="field-input" readOnly value={fmt(projWithdrawMonthly * 12)}/>
              </label>
            </div>
          )}
        </div>

        <div className="grid-4" style={{ marginBottom: 24 }}>
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
          <span className="cl-item"><span className="cl-swatch cl-swatch--line" style={{ background: palette[0] }}/>
            Scenario base ({projReturn}%)
          </span>
          {(settings.inflation ?? 0) > 0 && (
            <span className="cl-item"><span className="cl-swatch cl-swatch--dash" style={{ borderColor: palette[2] }}/>
              Potere d'acquisto di oggi
            </span>
          )}
        </div>
        <div style={{ height: 380 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={projChartData} margin={{ top: 4, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid {...GRID}/>
              <XAxis dataKey="year" {...X_AXIS} label={{ value: "Anni", position: "insideBottom", offset: -4 }}/>
              <YAxis {...Y_AXIS} tickFormatter={(v) => `${axisEuro(v)} €`} width={64}/>
              <ReTooltip content={<ProjectionTooltip projReturn={projReturn}/>} cursor={CURSOR_LINE}/>
              <Area type="monotone" dataKey="range" name="Intervallo" stroke="none"
                fill={palette[0]} fillOpacity={0.16} activeDot={false} isAnimationActive={false}/>
              <Line type="monotone" dataKey="base" name="Scenario base" stroke={palette[0]} strokeWidth={2}
                dot={false} activeDot={ACTIVE_DOT} animationDuration={ANIM_MS}/>
              {(settings.inflation ?? 0) > 0 && (
                <Line type="monotone" dataKey="real" name="Potere d'acquisto" stroke={palette[2]}
                  strokeWidth={2} strokeDasharray="5 4" dot={false} animationDuration={ANIM_MS}/>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="hint-text is-warn">
          <AlertTriangle size={15}/>
          <span>Proiezione ipotetica a rendimento costante. Non costituisce consulenza finanziaria.
          {(settings.inflation ?? 0) > 0 && ` La linea tratteggiata è la stessa cifra espressa in euro di oggi, scontata al ${settings.inflation}% annuo: è quella che dice cosa ci si potrà comprare.`}</span>
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
              <div className="rebal-controls">
                <label className="field-label field-inline">
                  Budget disponibile
                  <input type="number" value={monthBudget} onChange={(e) => setBudget(parseFloat(e.target.value) || 0)}
                    step="100" min="0" className="field-input" style={{ width: 140 }}/>
                </label>
                {investable.available > 0 && r2(monthBudget) !== investable.available && (
                  <button className="btn btn-ghost btn-sm"
                    onClick={() => setBudget(investable.available)}
                    title="Risparmio del mese al netto di quanto manca al fondo di sicurezza">
                    <PiggyBank size={13}/> Usa l'investibile del mese ({fmt(investable.available)})
                  </button>
                )}
                {(settings.rebalanceBand ?? 0) > 0 && (
                  <span className="panel-meta">
                    Banda di tolleranza: <strong>{settings.rebalanceBand}</strong> punti — chi è più
                    vicino di così al target non viene toccato.
                  </span>
                )}
                {!readOnly && (
                  <button className="btn btn-primary rebal-apply"
                    onClick={applyRebalance} disabled={monthBudget <= 0}>
                    <CheckCircle size={15}/> Segna come eseguito
                  </button>
                )}
              </div>

              <div className="grid-3" style={{ marginBottom: 16 }}>
                <KpiCard
                  label="Budget target su patrimonio"
                  value={fmt(totalItemsBudget)}
                  sub={
                    itemBuys.length > 0
                      ? itemBuys.map((x) => `${x.name.split(" ")[0]} ${fmt(x.buy, true)}`).join(" · ")
                      : "Nessun asset a target sul patrimonio totale"
                  }
                  color={totalItemsBudget > 0 ? "green" : "blue"}
                />
                <KpiCard
                  label="Budget ETF & Asset"
                  value={fmt(etfBudget)}
                  sub={`${etfPortfolioAssets.length} asset`}
                  color="blue"
                />
                <KpiCard
                  label="Totale"
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
              <div className="section-card">
                <h3 className="section-title" style={{ marginBottom: 4 }}><Shield size={16}/> Target sul patrimonio totale — Oro & Bitcoin</h3>
                <p className="hint-text" style={{ marginTop: 0, marginBottom: 4 }}>
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
                          <td className="asset-name">{x.name}{x.kind === "gold" && <span className="cell-sub"> (ETF + fisico)</span>}</td>
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
                <Briefcase size={16}/> Acquisto ETF & Asset — budget {fmt(etfBudget)}
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
                        <td className="asset-name">{x.name}</td>
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
                              <strong>{fmt(total)}</strong>{" "}{diff > 0.02 ? <AlertTriangle size={13} style={{ verticalAlign: -2 }} aria-label="Non torna col budget"/> : <CheckCircle size={13} style={{ verticalAlign: -2 }} aria-label="Torna col budget"/>}
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
  // Indicatori che scorrono sotto la voce attiva (sidebar, bottom nav, periodo).
  // Chiamati prima di ogni return condizionale: sono hook.
  const sideInd   = useSlidingIndicator(tab);
  const bottomInd = useSlidingIndicator(tab);
  const periodInd = useSlidingIndicator(`${tab}:${period}`);
  const mainRef   = useRef(null);

  const currentTab = visibleTabs.find((t) => t.id === tab) || visibleTabs[0];
  // Una riga sotto il titolo che dice a cosa serve la pagina.
  const TAB_LEDE = {
    overview:     "Il patrimonio in un colpo d'occhio: valore, composizione e andamento mese per mese.",
    budget:       "Entrate e spese di ogni mese, e quanto puoi investire senza intaccare la riserva di liquidità.",
    portfolio:    "Ogni posizione con prezzo, peso e target: ETF, oro, Bitcoin, startup e liquidità.",
    transactions: "Acquisti, vendite e dividendi: il registro da cui si ricavano quantità e prezzo medio di carico.",
    analysis:     "Rendimento, rischio, confronto e fisco, calcolati sullo storico mensile degli snapshot.",
    projection:   "Dove può arrivare il patrimonio con versamenti e rendimento costanti, e quanto regge ai prelievi.",
    rebalancing:  "Come dividere il budget del mese per riavvicinare i pesi ai target, senza mai vendere.",
    settings:     "Valori predefiniti personali, salvati sul tuo account a ogni modifica.",
  };

  // Link condiviso non valido / revocato: pagina d'errore, nessun dato.
  if (shareErr) {
    return (
      <div className="app app--solo">
        <main className="solo-main">
          <div className="brand">
            <span className="mark" aria-hidden="true">A</span>
            <span className="brand__name">AssetTracker</span>
          </div>
          <div className="welcome-card welcome-card--narrow">
            <div>
              <div className="welcome-icon"><Lock/></div>
              <h2 className="welcome-title">Portafoglio non disponibile</h2>
              <p className="welcome-desc">{shareErr}</p>
              <a className="btn btn-primary" href="/">Apri AssetTracker</a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const savedAt = lastSaved?.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`app ${dark ? "dark" : "light"}${entering ? " app--enter" : ""}`}>
      {/* Primo elemento raggiungibile col Tab. Un pulsante e non un link: un
          href="#…" passerebbe dal routing a hash e riporterebbe su Overview. */}
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Vai al contenuto
      </button>

      <aside className="sidebar">
        <div className="brand">
          <span className="mark" aria-hidden="true">A</span>
          <span className="brand__name">AssetTracker</span>
        </div>

        <nav className="side-nav" aria-label="Sezioni" ref={sideInd.containerRef}>
          <span className="nav-ind" ref={sideInd.indRef} aria-hidden="true"/>
          <p className="side-nav__label">Sezioni</p>
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const on = tab === t.id;
            return (
              <button key={t.id} type="button" className={`tab-btn ${on ? "active" : ""}`}
                onClick={() => goTab(t.id)} aria-current={on ? "page" : undefined} data-tip={t.label}>
                <Icon/> <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          <button type="button" className="side-action" onClick={() => setDark((d) => !d)}
            data-tip={dark ? "Tema chiaro" : "Tema scuro"}>
            {dark ? <Sun/> : <Moon/>}
            <span className="side-action__text">{dark ? "Tema chiaro" : "Tema scuro"}</span>
          </button>
          {!readOnly && session && supabase && (
            <button type="button" className="side-action" onClick={() => supabase.auth.signOut()}
              data-tip="Esci">
              <LogOut/>
              <span className="side-action__text">
                Esci
                <span className="side-action__sub">{session.user?.email || ""}</span>
              </span>
            </button>
          )}
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__lead">
            <span className="mark" aria-hidden="true">A</span>
            <div className="topbar__heading">
              <h1 className="page-title">{currentTab.label}</h1>
              <div className="topbar__status">
                {/* La parte informativa sparisce su mobile (.subtitle-static),
                    lo stato di salvataggio qui sotto no. */}
                <span className="subtitle-static">
                  {readOnly
                    ? <><Eye/> Vista condivisa · sola lettura</>
                    : <><RefreshCw/> Aggiornamento automatico ogni 15 min</>}
                </span>
                {!readOnly && lastSaved && !saveErr && (
                  <span className="status-ok"><span className="status-dot"/>Salvato {savedAt}</span>
                )}
                {!readOnly && saveErr && (
                  <span className="status-err"><AlertTriangle/>Non salvato: {saveErr}</span>
                )}
                {isLoading && (
                  <span className="status-busy"><span className="spinner" aria-hidden="true"/>Aggiornamento prezzi…</span>
                )}
              </div>
            </div>
          </div>

          <div className="topbar__actions">
            {grandTotal > 0 && tab !== "overview" && (
              <div className="grand-total">
                <span className="gt-label">Patrimonio totale</span>
                <span className="gt-value">{fmt(grandTotal)}</span>
                {totals.ret !== 0 && <Badge value={totals.ret * 100}/>}
              </div>
            )}
            {!readOnly && assets.length > 0 && (
              <button className="btn btn-ghost" onClick={fetchAllPrices} disabled={isLoading} title="Aggiorna i prezzi da JustETF">
                <RefreshCw size={16} className={isLoading ? "spin" : ""}/>
                <span className="btn-label">{isLoading ? "Aggiornamento…" : "Aggiorna prezzi"}</span>
              </button>
            )}
            {!readOnly && (
              <button className="btn btn-ghost" onClick={() => setShareModal(true)} title="Condividi in sola lettura">
                <Share2 size={16}/> <span className="btn-label">Condividi</span>
              </button>
            )}
            <button className="icon-btn mobile-only" onClick={() => setDark((d) => !d)} title="Cambia tema" aria-label="Cambia tema">
              {dark ? <Sun size={18}/> : <Moon size={18}/>}
            </button>
            {!readOnly && session && supabase && (
              <button className="icon-btn mobile-only" title={`Esci (${session.user?.email || ""})`}
                aria-label="Esci" onClick={() => supabase.auth.signOut()}>
                <LogOut size={18}/>
              </button>
            )}
          </div>
        </header>

        {(readOnly || error) && (
          <div className="app-notices">
            {readOnly && (
              <div className="alert alert-info">
                <Eye size={16}/>
                <span>
                  Stai visualizzando un portafoglio <strong>condiviso in sola lettura</strong>.
                  Non è possibile aggiungere, modificare o eliminare dati.
                </span>
              </div>
            )}
            {error && (
              <div className="alert alert-red">
                <AlertTriangle size={16}/> <span>{error}</span>
              </div>
            )}
          </div>
        )}

        <main className="app-main" ref={mainRef} tabIndex={-1}>
          <p className="page-lede">{TAB_LEDE[currentTab.id]}</p>
          {tab === "overview"    && renderOverview()}
          {tab === "budget"      && !readOnly && renderBudget()}
          {tab === "portfolio"   && renderPortfolio()}
          {tab === "transactions" && !readOnly && renderTransactions()}
          {tab === "analysis"    && renderAnalysis()}
          {tab === "projection"  && renderProjection()}
          {tab === "rebalancing" && renderRebalancing()}
          {tab === "settings"    && renderSettings()}
        </main>
      </div>

      {/* Nav del telefono: sotto i 640px la sidebar sparisce (vedi styles.css).
          Solo icone, il nome è nell'aria-label e nel titolo della pagina. */}
      <nav className="bottom-nav" aria-label="Sezioni">
        <div className="bottom-nav-inner" ref={bottomInd.containerRef}>
          <span className="bottom-ind" ref={bottomInd.indRef} aria-hidden="true"/>
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const on = tab === t.id;
            return (
              <button key={t.id} type="button" className={`bottom-nav-btn ${on ? "active" : ""}`}
                onClick={() => { goTab(t.id); window.scrollTo(0, 0); }} aria-label={t.label}
                aria-current={on ? "page" : undefined}>
                <Icon/>
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
          {toast.type === "ok" ? <CheckCircle size={16}/> : <AlertTriangle size={16}/>}
          {/* La spunta testuale è già l'icona: non la si ripete. */}
          <span>{toast.text.replace(/^✓\s*/, "")}</span>
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
      {cfModal !== null && (
        <CashflowModal month={cfModal?.id ? cfModal : null}
          taken={new Set(cashflow.map((m) => monthId(m.year, m.month)))}
          expenseBudget={settings.expenseBudget ?? 0}
          onSave={saveCfMonth} onClose={() => setCfModal(null)}/>
      )}
      {shareModal && <ShareModal onClose={() => setShareModal(false)}/>}
    </div>
  );
}
