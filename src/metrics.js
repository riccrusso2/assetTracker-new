// Metriche di rendimento e rischio — pure, testabili in Jest.
//
// Stavano dentro App.js, dove nessun test poteva raggiungerle: sono la parte
// della dashboard in cui un errore non si vede a occhio, perché il numero
// sbagliato ha lo stesso aspetto di quello giusto.

import { r2, snapKey } from "./rebalance";

// Sotto queste soglie una metrica non è "meno precisa": è rumore con due
// decimali. Un rapporto di Sharpe su 5 rendimenti mensili dipende quasi
// interamente da quale mese è capitato dentro il campione.
export const MIN_OBS_RATIO = 12;   // Sharpe, Sortino, volatilità
export const MIN_OBS_TREND = 2;    // CAGR, drawdown
export const OBS_RELIABLE  = 24;   // sotto: da leggere come indicazione

// Rendimenti time-weighted: sottrae i flussi esterni (versamenti/prelievi) così
// mettere soldi non si confonde con guadagnare.
// Ogni rendimento porta con sé l'indice dello snapshot di arrivo: i mesi con
// valore precedente a zero vengono saltati, e senza l'indice le serie per i
// grafici si disallineerebbero dalle etichette di un mese, in silenzio.
export const returnsIndexed = (history) => {
  const r = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].v <= 0) continue;
    r.push({ i, r: (history[i].v - (history[i].cf || 0) - history[i - 1].v) / history[i - 1].v });
  }
  return r;
};

export const calcReturns = (history) => returnsIndexed(history).map((x) => x.r);

export const calcCAGR = (history) => {
  if (history.length < 2) return null;
  const years = (new Date(history.at(-1).t) - new Date(history[0].t)) / (365.25 * 864e5);
  if (!(years > 0)) return null;
  const r = calcReturns(history);
  if (r.length < MIN_OBS_TREND) return null;
  const growth = r.reduce((acc, x) => acc * (1 + x), 1);
  if (growth <= 0) return null;
  return Math.pow(growth, 1 / years) - 1;
};

export const calcVolatility = (history) => {
  const r = calcReturns(history);
  if (r.length < MIN_OBS_RATIO) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
  return Math.sqrt(variance * 12);
};

// Drawdown sull'indice dei rendimenti (netti dai versamenti), non sul valore
// lordo: altrimenti un mese senza versamento sembrerebbe una perdita.
export const calcMaxDrawdown = (history) => {
  const r = calcReturns(history);
  if (r.length < MIN_OBS_TREND) return null;
  let idx = 1, peak = 1, mdd = 0;
  for (const x of r) {
    idx *= 1 + x;
    if (idx > peak) peak = idx;
    const dd = (idx - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
};

export const calcSharpe = (history, rf = 0.03) => {
  const cagr = calcCAGR(history);
  const vol  = calcVolatility(history);
  if (cagr == null || vol == null || vol === 0) return null;
  return (cagr - rf) / vol;
};

export const calcSortino = (history, rf = 0.03) => {
  const r = calcReturns(history);
  if (r.length < MIN_OBS_RATIO) return null;
  const meanAnn = (r.reduce((a, b) => a + b, 0) / r.length) * 12;
  const neg = r.filter((x) => x < 0);
  if (!neg.length) return null;
  const downDev = Math.sqrt((neg.reduce((a, b) => a + b ** 2, 0) / neg.length) * 12);
  if (downDev === 0) return null;
  return (meanAnn - rf) / downDev;
};

// Quanto ci si può fidare, dato il numero di osservazioni disponibili.
export const riskQuality = (n) =>
  n < MIN_OBS_RATIO ? "insufficiente" : n < OBS_RELIABLE ? "indicativo" : "solido";

// ====================== PERIMETRO DELLO SNAPSHOT ======================
// `totalValue` è il patrimonio intero (quotate + liquidità + oro fisico +
// startup), ma `assets[]` conteneva solo le posizioni con un prezzo. Con i due
// perimetri disallineati il flusso esterno risultava sbagliato nei due versi:
// comprare un ETF con la liquidità già dentro il totale sembrava una perdita,
// e un versamento in liquidità sembrava un guadagno.
//
// Le parti non quotate diventano righe sintetiche dello snapshot: quantità =
// valore e prezzo = 1 per liquidità e startup (non hanno una quotazione),
// grammi × €/g per l'oro fisico (ce l'ha, e il suo movimento è rendimento).
export const SYNTHETIC_CASH     = "__cash__";
export const SYNTHETIC_PHYSGOLD = "__physgold__";
export const SYNTHETIC_STARTUPS = "__startups__";
// Chiave di ripiego per gli snapshot salvati prima delle righe sintetiche.
export const SYNTHETIC_RESIDUAL = "__nonquotato__";

export const SYNTHETIC_LABELS = {
  [SYNTHETIC_CASH]:     "Liquidità",
  [SYNTHETIC_PHYSGOLD]: "Oro fisico",
  [SYNTHETIC_STARTUPS]: "Startup",
  [SYNTHETIC_RESIDUAL]: "Non quotato",
};

// Una riga sintetica gira in due forme: l'oggetto (che ha `id`) e la chiave già
// risolta da snapKey (che è lo slug del nome). Servono entrambe, altrimenti il
// filtro funziona sugli snapshot e non sui grafici, che ragionano per chiave.
const SYNTHETIC_KEYS = new Set(
  Object.entries(SYNTHETIC_LABELS).flatMap(([id, name]) => [id, snapKey({ id, name })]));

export const isSynthetic = (a) =>
  SYNTHETIC_KEYS.has(typeof a === "string" ? a : (a?.id ?? snapKey(a)));

// Etichetta leggibile a partire dalla chiave risolta, per i grafici.
export const syntheticLabel = (key) =>
  Object.entries(SYNTHETIC_LABELS)
    .find(([id, name]) => key === id || key === snapKey({ id, name }))?.[1] ?? null;

// Righe non quotate di uno snapshot. Le voci a zero restano fuori: una riga a
// quantità 0 che compare e scompare produrrebbe flussi nulli ma rumorosi.
export const syntheticRows = ({ totalCash = 0, physGoldGrams = 0,
                                physGoldPricePerGram = 0, startupsValue = 0 } = {}) => {
  const row = (id, price, quantity) => ({
    id, name: SYNTHETIC_LABELS[id], price, quantity,
    value: r2(price * quantity), synthetic: true,
  });
  const rows = [];
  if (totalCash) rows.push(row(SYNTHETIC_CASH, 1, r2(totalCash)));
  if (physGoldGrams && physGoldPricePerGram) {
    rows.push(row(SYNTHETIC_PHYSGOLD, physGoldPricePerGram, physGoldGrams));
  }
  if (startupsValue) rows.push(row(SYNTHETIC_STARTUPS, 1, r2(startupsValue)));
  return rows;
};

// Serie storica pronta per le metriche: valore mensile + flusso esterno del
// periodo. Il flusso si ricava dalle variazioni di quantità (chiave = snapKey,
// mai l'id, che si rigenera cancellando e riaggiungendo un asset).
export const buildHistory = (snapshots) => {
  const pts = snapshots.map((s) => {
    const rows = s.assets || [];
    const pos = Object.fromEntries(
      rows.map((a) => [snapKey(a), { q: a.quantity || 0, price: a.price || 0 }]));
    // Quello che il totale contiene ma nessuna riga dichiara. Sugli snapshot
    // vecchi è l'intero blocco non quotato; su quelli nuovi è zero. Definirlo
    // come "tutto ciò che avanza" fa sì che il mese di transizione fra i due
    // formati non produca un flusso fantasma: le righe sintetiche che entrano
    // sono esattamente il residuo che esce.
    const residual = r2((s.totalValue || 0) - rows.reduce((acc, a) => acc + (a.value || 0), 0));
    if (Math.abs(residual) > 0.005) pos[SYNTHETIC_RESIDUAL] = { q: residual, price: 1 };
    return { t: `${s.year}-${String(s.month).padStart(2, "0")}-01`, v: s.totalValue, pos };
  });
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) { pts[i].cf = 0; continue; }
    const prev = pts[i - 1].pos, cur = pts[i].pos;
    let cf = 0;
    // Unione delle chiavi, non le sole correnti: una posizione liquidata del
    // tutto sparisce da `assets[]`, e contando solo le chiavi presenti oggi la
    // sua uscita verrebbe letta come perdita di mercato invece che come
    // prelievo. Chi esce si valuta all'ultimo prezzo noto.
    for (const k of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
      const now = cur[k], before = prev[k];
      cf += ((now?.q || 0) - (before?.q || 0)) * (now?.price ?? before?.price ?? 0);
    }
    pts[i].cf = cf;
  }
  return pts;
};

// ====================== FINESTRA TEMPORALE ======================
// Tutte le analisi erano "dall'inizio": con tre anni di storico non c'era modo
// di guardare l'ultimo anno. Le funzioni qui sotto sono già pure e prendono un
// array, quindi basta tagliarlo prima di passarlo.
export const PERIODS = [
  { id: "all", label: "Tutto" },
  { id: "ytd", label: "YTD" },
  { id: "1y",  label: "1 anno" },
  { id: "3y",  label: "3 anni" },
];

const snapDate = (s) => new Date(s.year, (s.month || 1) - 1, 1);

export const sliceSnapshots = (snapshots, period, now = new Date()) => {
  const list = snapshots || [];
  if (!list.length || !period || period === "all") return list;
  const y = now.getFullYear(), mNext = now.getMonth() + 1;
  const cutoff =
    period === "ytd" ? new Date(y, 0, 1) :
    period === "1y"  ? new Date(y - 1, mNext, 1) :
    period === "3y"  ? new Date(y - 3, mNext, 1) : null;
  if (!cutoff) return list;

  const idx = list.findIndex((s) => snapDate(s) >= cutoff);
  if (idx < 0) return [];       // tutto lo storico è più vecchio del periodo
  // Si tiene anche lo snapshot precedente: è il punto di partenza da cui si
  // misura il primo rendimento del periodo. Senza, il primo mese sparirebbe
  // dal conto — `returnsIndexed` parte da i = 1.
  return list.slice(Math.max(0, idx - 1));
};

// Rendimento composto del periodo, al netto dei versamenti.
export const periodReturn = (snapshots) => {
  const r = calcReturns(buildHistory(snapshots));
  if (!r.length) return null;
  return r.reduce((acc, x) => acc * (1 + x), 1) - 1;
};

// Curva di drawdown: quanto si è sotto il massimo raggiunto, mese per mese.
// Il numero singolo dice quanto è stata profonda la buca; la curva dice anche
// quanto è durata, che è ciò che si sopporta davvero.
export const drawdownSeries = (snapshots) => {
  const r = returnsIndexed(buildHistory(snapshots));
  if (!r.length) return [];
  const out = [];
  let idx = 1, peak = 1;
  for (const x of r) {
    idx *= 1 + x.r;
    if (idx > peak) peak = idx;
    out.push({ label: snapshots[x.i].label, dd: r2(((idx - peak) / peak) * 100) });
  }
  return out;
};

// Composizione percentuale nel tempo: la deriva strutturale che una torta
// istantanea non può mostrare.
// Il denominatore è `totalValue`, non la somma delle righe: sugli snapshot
// salvati prima delle righe sintetiche le due cose differiscono del 40%, e
// normalizzare sulle sole righe farebbe risultare il quotato al 100% fino al
// mese della transizione, con un salto nella serie che non è mai avvenuto.
export const allocationOverTime = (snapshots) => snapshots.map((s) => {
  const rows = s.assets || [];
  const total = s.totalValue || rows.reduce((acc, a) => acc + (a.value || 0), 0);
  const row = { label: s.label };
  const pct = (v) => (total > 0 ? r2((v / total) * 100) : 0);
  rows.forEach((a) => { row[snapKey(a)] = pct(a.value || 0); });
  const residual = r2(total - rows.reduce((acc, a) => acc + (a.value || 0), 0));
  if (residual > 0.005) row[SYNTHETIC_RESIDUAL] = pct(residual);
  return row;
});

// Quanti euro ha prodotto ogni asset, al netto di ciò che ci è stato versato
// dentro. Risponde a "chi ha fatto il risultato", che non è "chi ha la
// performance percentuale più alta": conta anche quanto pesa.
export const contributionByAsset = (snapshots) => {
  if (snapshots.length < 2) return [];
  const byKey = {};
  for (let i = 1; i < snapshots.length; i++) {
    const prev = {}, prevQ = {};
    (snapshots[i - 1].assets || []).forEach((a) => {
      prev[snapKey(a)]  = a.value || 0;
      prevQ[snapKey(a)] = a.quantity || 0;
    });
    (snapshots[i].assets || []).forEach((a) => {
      const k = snapKey(a);
      const contrib = ((a.quantity || 0) - (prevQ[k] || 0)) * (a.price || 0);
      const market  = (a.value || 0) - (prev[k] || 0) - contrib;
      byKey[k] = (byKey[k] || 0) + market;
    });
  }
  return Object.entries(byKey)
    .map(([key, gain]) => ({ key, gain: r2(gain) }))
    .sort((a, b) => b.gain - a.gain);
};

// Griglia anno × mese dei rendimenti netti dai versamenti.
export const monthlyReturnsGrid = (snapshots) => {
  const rows = {};
  returnsIndexed(buildHistory(snapshots)).forEach((x) => {
    const s = snapshots[x.i];
    (rows[s.year] ??= { year: s.year, months: {} }).months[s.month] = r2(x.r * 100);
  });
  return Object.values(rows).sort((a, b) => a.year - b.year);
};

// Proiezione a scenari. Tre novità rispetto alla semplice capitalizzazione:
//  - `inflation`: la stessa curva in potere d'acquisto di oggi. Un capitale che
//    raddoppia in vent'anni al 2% di inflazione compra il 35% in più, non il
//    doppio, e questa è l'unica cifra che dice qualcosa sul tenore di vita.
//  - `withdrawAfter`/`withdrawMonthly`: la fase di prelievo, cioè il motivo per
//    cui si accumula. Senza, la proiezione risponde a una domanda che nessuno
//    si pone (quanto avrò se non lo uso mai).
//  - la banda pessimistico/ottimistico resta ±3 punti di rendimento.
export const projectionScenarios = ({
  start, monthly, baseReturn, years,
  inflation = 0, withdrawAfter = null, withdrawMonthly = 0,
}) => {
  const rates = {
    base: baseReturn / 100 / 12,
    pessimistic: Math.max(baseReturn - 3, 0) / 100 / 12,
    optimistic: (baseReturn + 3) / 100 / 12,
  };
  const months = Math.max(0, Math.round(years * 12));
  const infM = inflation / 100 / 12;
  const drawFrom = withdrawAfter == null ? null : Math.round(withdrawAfter * 12);

  const v = { base: start, pessimistic: start, optimistic: start };
  const data = [];
  for (let i = 0; i <= months; i++) {
    if (i % 12 === 0) {
      data.push({
        year: i / 12,
        base: r2(v.base), pessimistic: r2(v.pessimistic), optimistic: r2(v.optimistic),
        // Valore reale: quanto varrebbe quella cifra in euro di oggi.
        real: r2(v.base / Math.pow(1 + infM, i)),
      });
    }
    if (i >= months) break;
    const drawing = drawFrom != null && i >= drawFrom;
    const flow = drawing ? -withdrawMonthly : monthly;
    for (const k of Object.keys(v)) {
      v[k] = v[k] * (1 + rates[k]) + flow;
      if (v[k] < 0) v[k] = 0;              // il capitale si esaurisce, non va in debito
    }
  }
  return data;
};

// Anno in cui il capitale si esaurisce nella fase di prelievo, se accade.
export const depletionYear = (data) => {
  const hit = data.find((d) => d.base <= 0);
  return hit ? hit.year : null;
};

// Confronto con un riferimento: patrimonio e benchmark riportati entrambi a 100
// sul primo snapshot. Il patrimonio usa l'indice dei rendimenti (netto dai
// versamenti), altrimenti si confronterebbe la capacità di risparmio con
// l'andamento di un mercato.
export const benchmarkSeries = (snapshots, benchmarkKey) => {
  if (snapshots.length < 2 || !benchmarkKey) return [];
  const r = returnsIndexed(buildHistory(snapshots));
  const priceAt = (s) => (s.assets || []).find((a) => snapKey(a) === benchmarkKey)?.price ?? null;
  const base = priceAt(snapshots[0]);
  if (!base) return [];

  const out = [{ label: snapshots[0].label, portfolio: 100, benchmark: 100 }];
  let idx = 1;
  for (const x of r) {
    idx *= 1 + x.r;
    const p = priceAt(snapshots[x.i]);
    out.push({
      label: snapshots[x.i].label,
      portfolio: r2(idx * 100),
      benchmark: p ? r2((p / base) * 100) : null,
    });
  }
  return out;
};
