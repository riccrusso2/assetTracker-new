// Logica di ribilanciamento e attribuzione crescita — pura, testabile in Jest.

export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Chiave di identità di un asset ATTRAVERSO gli snapshot. Volutamente NON `id`:
// l'id è un uid casuale rigenerato se l'asset viene cancellato e riaggiunto, il
// che spezzerebbe la serie storica in due e conterebbe il riacquisto come un
// versamento. Il nome normalizzato è stabile. Slug perché finisce come dataKey
// di Recharts, dove i punti sono path lookup.
export const snapKey = (a) =>
  (a.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || a.id;

// Asset con target calcolato sul PATRIMONIO TOTALE invece che sul
// sotto-portafoglio ETF. Bitcoin ETP e l'ETF oro si comprano come un ETF ma la
// loro allocazione target è tipicamente una % dell'intero patrimonio — di qui il
// default per Crypto e Oro. La scelta è comunque per singolo asset:
// `targetOnTotal: false` li riporta nel sotto-portafoglio ETF (es. 90/10
// globale-oro, indipendente da liquidità e startup).
export const isTotalTargetAsset = (a) =>
  a.targetOnTotal ?? (a.assetClass === "Crypto" || a.assetClass === "Oro");

// Distribuzione buy-only del budget tra gli asset ETF, proporzionale ai
// target normalizzati, senza mai vendere.
// `band`: scostamento in punti percentuali entro cui un asset si considera già
// a posto. Serve a non inseguire il target ogni mese per mezzo punto — ogni
// riequilibrio costa commissioni e, sui titoli, può realizzare imposte. Se
// nessuno esce dalla banda il budget non resta fermo: si distribuisce ai pesi
// target, che per un PAC è esattamente il comportamento voluto.
export const calcRebalancing = (assets, totalVal, budget, band = 0) => {
  if (!totalVal || totalVal <= 0) return { actions: [] };
  const sumTarget = assets.reduce((acc, a) => acc + (a.targetWeight || 0), 0) || 1;
  const norm = 100 / sumTarget;
  const actions = assets.map((a) => {
    const cur   = (a.lastPrice || 0) * (a.quantity || 0);
    const curW  = (cur / totalVal) * 100;
    const tgtW  = (a.targetWeight || 0) * norm;
    const delta = (tgtW / 100) * totalVal - cur;
    const qty   = a.lastPrice ? delta / a.lastPrice : 0;
    return { ...a, curW, tgtW, delta, qty, inBand: tgtW - curW < band };
  });
  const buy = new Array(actions.length).fill(0);
  let eligible = actions.map((_, i) => i).filter((i) => actions[i].delta > 0 && !actions[i].inBand);
  let remaining = budget;
  for (let iter = 0; iter < 20 && eligible.length > 0 && remaining > 0.005; iter++) {
    const sumEligTgt = eligible.reduce((acc, i) => acc + actions[i].tgtW, 0);
    if (sumEligTgt <= 0) break;
    const nextEligible = [];
    let allocated = 0;
    for (const i of eligible) {
      const proportional = (actions[i].tgtW / sumEligTgt) * remaining;
      const room         = actions[i].delta - buy[i];
      if (proportional >= room) { buy[i] = actions[i].delta; allocated += room; }
      else { buy[i] += proportional; allocated += proportional; nextEligible.push(i); }
    }
    remaining -= allocated;
    eligible   = nextEligible;
  }
  if (remaining > 0.005) {
    // Con una banda attiva il budget avanzato va solo a chi ne è fuori:
    // altrimenti la banda non servirebbe a nulla, si tornerebbe a comprare
    // ogni mese anche ciò che è già a posto. Senza banda (band = 0) resta la
    // distribuzione ai pesi target su tutti, che mantiene le proporzioni.
    const outOfBand = actions.map((_, i) => i).filter((i) => !actions[i].inBand);
    const idxs = band > 0 && outOfBand.length ? outOfBand : actions.map((_, i) => i);
    const sumTgt = idxs.reduce((acc, i) => acc + actions[i].tgtW, 0);
    if (sumTgt > 0) idxs.forEach((i) => { buy[i] += (actions[i].tgtW / sumTgt) * remaining; });
  }
  // ponytail: il delta si misura sul totale attuale, non su totale + budget.
  // Con la seconda base la somma dei delta coinciderebbe col budget e i pesi
  // finirebbero esatti al primo colpo — è un miglioramento vero, ma cambia gli
  // acquisti proposti a chiunque usi già la dashboard: da valutare a parte.
  const rawBuys = actions.map((_, i) => Math.max(0, buy[i] || 0));
  const rounded = rawBuys.map(r2);
  const roundDiff = r2(budget - rounded.reduce((a, b) => a + b, 0));
  if (Math.abs(roundDiff) > 0) { const maxIdx = rounded.indexOf(Math.max(...rounded)); rounded[maxIdx] = r2(rounded[maxIdx] + roundDiff); }
  return {
    actions: actions.map((a, i) => ({
      ...a, monthlyBuy: rounded[i],
      monthlyQty: a.lastPrice && rounded[i] > 0 ? r2(rounded[i] / a.lastPrice) : 0,
    })),
  };
};

// Two-level rebalancing:
// Livello 1 — asset con target sul PATRIMONIO TOTALE (oro, Bitcoin, …).
//   Per ciascuno: quanto manca per raggiungere target% × (patrimonio + budget).
//   "Buy only" — non si vende mai. Se il budget non basta per tutti,
//   viene ripartito in proporzione al fabbisogno.
// Livello 2 — il budget residuo va al sotto-portafoglio ETF (calcRebalancing).
//
// items: [{ id, name, targetPct, currentVal, price }]
//   currentVal = valore attuale ai fini del peso (per l'oro: ETF + fisico)
//   price      = prezzo dello strumento acquistabile (per l'oro: l'ETF oro)
export const calcRebalancingTwoLevel = (etfAssets, items, grandTotal, etfTotalVal, budget, band = 0) => {
  const newTotal = grandTotal + budget;

  const needs = items.map((it) => {
    if (!(it.targetPct > 0 && it.price > 0)) return 0;
    const curPct = grandTotal > 0 ? (it.currentVal / grandTotal) * 100 : 0;
    if (it.targetPct - curPct < band) return 0;          // già dentro la banda
    return Math.max(0, (it.targetPct / 100) * newTotal - it.currentVal);
  });
  const totalNeed = needs.reduce((a, b) => a + b, 0);
  // Se il fabbisogno supera il budget, ripartizione proporzionale
  const scale = totalNeed > budget && totalNeed > 0 ? budget / totalNeed : 1;

  const itemBuys = items.map((it, i) => {
    const buy = r2(needs[i] * scale);
    return {
      ...it,
      buy,
      qty: buy > 0 && it.price > 0 ? r2(buy / it.price) : 0,
      currentPct: grandTotal > 0 ? r2((it.currentVal / grandTotal) * 100) : 0,
    };
  });

  const spent     = itemBuys.reduce((a, x) => a + x.buy, 0);
  const etfBudget = r2(Math.max(0, budget - spent));
  const etfRebalance = calcRebalancing(etfAssets, etfTotalVal, etfBudget, band);

  return { itemBuys, etfBudget, etfTotalVal, etfRebalance };
};

// ====================== DERIVA DAI TARGET ======================
// Scostamento in punti percentuali sotto il quale non si segnala nulla, quando
// l'utente non ha dichiarato una banda propria.
export const DRIFT_ALERT_PP = 5;

// `positions`: [{ name, actualPct, targetPct }] — i pesi arrivano già calcolati
// sulla base giusta (sotto-portafoglio ETF o patrimonio totale, a seconda del
// tipo di target), perché è chi chiama a sapere quale denominatore usare.
//
// Si riporta il **massimo** scostamento, non la somma: sommando i valori
// assoluti la misura cresce col numero di posizioni, e un portafoglio a target
// ma diviso in dieci righe risulterebbe più "derivato" di uno sbilanciato in
// due. `sum` resta disponibile perché è il turnover necessario a rimettere
// tutto in bolla, che è un'altra domanda legittima.
export const calcDrift = (positions = []) => {
  const rows = positions
    .filter((p) => p && Number.isFinite(p.actualPct) && Number.isFinite(p.targetPct))
    .map((p) => ({ ...p, delta: r2(p.actualPct - p.targetPct) }));
  if (!rows.length) return { max: 0, sum: 0, worst: null };
  const worst = rows.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
  return {
    max:  r2(Math.abs(worst.delta)),
    sum:  r2(rows.reduce((acc, p) => acc + Math.abs(p.delta), 0)),
    worst,
  };
};

// Soglia effettiva: se l'utente ha dichiarato una banda di tolleranza è quella
// il criterio, altrimenti il default.
export const driftThreshold = (band) => (band > 0 ? band : DRIFT_ALERT_PP);

// ====================== CONCENTRAZIONE ======================
// Quanto patrimonio dipende da una sola posizione. È la domanda che l'asset
// allocation per classe non risponde: cinque ETF azionari globali sono cinque
// righe nella torta ma un'unica scommessa, e un 50% su un singolo strumento è
// un rischio emittente che il peso per classe non mostra.
// `positions`: [{ name, value }]. La base è il patrimonio totale, non la somma
// delle posizioni: la liquidità diluisce la concentrazione ed è corretto che lo
// faccia.
export const calcConcentration = (positions = [], total = 0) => {
  const rows = (positions || [])
    .filter((p) => p && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!rows.length || !(total > 0)) return { top1: null, top3: null, top1Name: null, count: 0 };
  const pct = (v) => r2((v / total) * 100);
  return {
    top1: pct(rows[0].value),
    top3: pct(rows.slice(0, 3).reduce((a, p) => a + p.value, 0)),
    top1Name: rows[0].name,
    count: rows.length,
  };
};

// Attribuzione crescita mese su mese (solo asset quotati negli snapshot):
// versamenti ≈ Σ Δquantità × prezzo del mese; mercato = Δvalore − versamenti.
// ponytail: approssima gli acquisti al prezzo di fine mese — per precisione
// servirebbe il log delle transazioni.
export const calcGrowthAttribution = (snapshots) => {
  const rows = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1], cur = snapshots[i];
    const prevQ = {};
    let prevVal = 0;
    (prev.assets || []).forEach((a) => { prevQ[snapKey(a)] = a.quantity || 0; prevVal += a.value || 0; });
    let curVal = 0, contrib = 0;
    (cur.assets || []).forEach((a) => {
      curVal  += a.value || 0;
      contrib += ((a.quantity || 0) - (prevQ[snapKey(a)] || 0)) * (a.price || 0);
    });
    rows.push({ label: cur.label, contrib: r2(contrib), market: r2(curVal - prevVal - contrib) });
  }
  return rows;
};

// ====================== STARTUP LIFECYCLE ======================
// Ogni startup ha un esito: attiva (default), exit (incasso), fallita (valore 0).
// Config precedenti non hanno `status`: valgono come attive.
const SU_STATUSES = ["active", "exit", "failed"];
export const suStatus = (s) => (SU_STATUSES.includes(s?.status) ? s.status : "active");

// Metriche del singolo investimento. recovered/pnl/roiPct sono null finché è attivo.
// `currentValue` è la valutazione odierna di un'attiva (round successivi): opzionale,
// se manca l'attiva vale il capitale investito.
export const calcStartupMetrics = (s) => {
  const status    = suStatus(s);
  const invested  = s.invested || 0;
  const fee       = s.fee || 0;
  const totalCost = r2(invested + fee);
  const closed    = status !== "active";
  const recovered = status === "exit" ? (s.exitAmount || 0) : status === "failed" ? 0 : null;
  const pnl       = closed ? r2(recovered - totalCost) : null;
  const roiPct    = closed && totalCost > 0 ? r2((pnl / totalCost) * 100) : null;

  const currentValue = !closed && s.currentValue != null && s.currentValue !== "" ? r2(s.currentValue) : null;
  // Valore odierno: incasso reale sulle concluse, valutazione (o costo) sulle attive.
  const value        = closed ? (recovered || 0) : r2(currentValue ?? invested);
  const unrealPnl    = closed ? null : r2(value - totalCost);
  const unrealRoiPct = !closed && totalCost > 0 ? r2((unrealPnl / totalCost) * 100) : null;

  return { ...s, status, invested, fee, totalCost, closed, recovered, pnl, roiPct,
           currentValue, value, unrealPnl, unrealRoiPct };
};

// Riepilogo aggregato del portafoglio startup. Due letture affiancate:
//  - realizzato: solo le concluse, dice se il recuperato copre il costo sostenuto;
//  - complessivo: tutte le posizioni + l'abbonamento alla piattaforma, cioè se
//    l'operazione startup nel suo insieme è in guadagno o in perdita.
// L'abbonamento è un costo comune: non viene ripartito sulle singole startup.
export const calcStartupPortfolio = (startups, subscription = 0) => {
  const rows   = (startups || []).map(calcStartupMetrics);
  const active = rows.filter((s) => !s.closed);
  const closed = rows.filter((s) => s.closed);
  const failed = rows.filter((s) => s.status === "failed");
  const sum = (list, f) => r2(list.reduce((a, s) => a + f(s), 0));

  const sub          = subscription || 0;
  const investedTot  = sum(rows, (s) => s.invested);
  const feesTot      = sum(rows, (s) => s.fee);
  const activeVal    = sum(active, (s) => s.invested);   // a costo → patrimonio
  const activeValue  = sum(active, (s) => s.value);      // a valutazione corrente
  const closedCost   = sum(closed, (s) => s.totalCost);
  const recoveredTot = sum(closed, (s) => s.recovered || 0);
  const pnlTot       = r2(recoveredTot - closedCost);

  const totalOutlay  = r2(investedTot + feesTot + sub);  // tutto ciò che è uscito di tasca
  const totalValue   = r2(recoveredTot + activeValue);   // tutto ciò che è rientrato o vale ancora
  const pnlOverall   = r2(totalValue - totalOutlay);
  // Somma delle sole colonne della tabella (abbonamento escluso: è un costo comune
  // che non appartiene a nessuna riga).
  const costTot      = r2(investedTot + feesTot);
  const pnlNoSub     = r2(totalValue - costTot);
  // Quando tutte sono chiuse activeValue è 0: complessivo e realizzato-netto convergono.
  const pnlRealizedNet = r2(pnlTot - sub);
  const realizedBase   = r2(closedCost + sub);

  return {
    rows, active, closed,
    investedTot, feesTot, costTot,
    pnlNoSub,
    roiNoSubPct: costTot > 0 ? r2((pnlNoSub / costTot) * 100) : null,
    activeVal, activeValue, closedCost, recoveredTot,
    failedLoss: sum(failed, (s) => s.totalCost),
    pnlTot,
    roiPct: closedCost > 0 ? r2((pnlTot / closedCost) * 100) : null,
    subscription: sub,
    totalOutlay, totalValue, pnlOverall,
    roiOverallPct: totalOutlay > 0 ? r2((pnlOverall / totalOutlay) * 100) : null,
    pnlRealizedNet,
    roiRealizedNetPct: realizedBase > 0 ? r2((pnlRealizedNet / realizedBase) * 100) : null,
    allClosed: rows.length > 0 && active.length === 0,
  };
};

// ====================== DURATA E IRR DEL BOOK STARTUP ======================
// Un investimento in equity crowdfunding si valuta sull'orizzonte, non sul solo
// ROI: 300 € che tornano 400 € valgono molto diversamente dopo due o dopo otto
// anni. Serviva solo la data, che il modello non aveva.
//
// L'abbonamento alla piattaforma resta fuori: è un costo comune e ricorrente,
// non attribuibile a una singola posizione, e senza sapere per quanti anni è
// stato pagato entrerebbe nel calcolo come una cifra arbitraria. Compare nel
// riepilogo costi.
const DAY_MS = 864e5;

// Flussi pronti per xirr(): esborso alla data d'ingresso, incasso alla data
// d'uscita (o valore odierno per le attive). Le posizioni senza data restano
// fuori — un flusso senza data non è collocabile nel tempo.
export const startupCashFlows = (startups, asOf) => {
  const flows = [];
  for (const s of (startups || []).map(calcStartupMetrics)) {
    if (!s.date) continue;
    if (s.totalCost > 0) flows.push({ date: s.date, amount: r2(-s.totalCost) });
    if (s.closed) {
      // Una fallita non produce incasso: il flusso in uscita c'è comunque,
      // altrimenti xirr non vedrebbe mai la perdita.
      const amount = r2(s.recovered || 0);
      if (amount > 0) flows.push({ date: s.exitDate || asOf, amount });
    } else if (s.value > 0) {
      flows.push({ date: asOf, amount: r2(s.value) });
    }
  }
  return flows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
};

// Quanto capitale è fermo da quanto tempo. `asOf` è la data di riferimento per
// le posizioni ancora aperte.
export const startupHoldings = (startups, asOf) => {
  const rows = (startups || []).map(calcStartupMetrics).filter((s) => s.date);
  if (!rows.length) return { withDate: 0, missingDate: (startups || []).length, avgYears: null, oldest: null };
  const end = (s) => (s.closed ? (s.exitDate || asOf) : asOf);
  const years = (s) => (new Date(end(s)) - new Date(s.date)) / (365.25 * DAY_MS);
  const valid = rows.filter((s) => Number.isFinite(years(s)) && years(s) >= 0);
  if (!valid.length) return { withDate: rows.length, missingDate: 0, avgYears: null, oldest: null };
  // Media ponderata per capitale: due anni su 300 € e otto su 3.000 € non
  // pesano uguale nel dire "da quanto è immobilizzato il mio denaro".
  const cost = valid.reduce((a, s) => a + s.totalCost, 0);
  const avgYears = cost > 0
    ? r2(valid.reduce((a, s) => a + years(s) * s.totalCost, 0) / cost)
    : null;
  const openOnes = valid.filter((s) => !s.closed);
  const oldest = openOnes.length
    ? openOnes.reduce((a, b) => (years(b) > years(a) ? b : a))
    : null;
  return {
    withDate: valid.length,
    missingDate: (startups || []).length - valid.length,
    avgYears,
    oldest: oldest ? { name: oldest.name, years: r2(years(oldest)) } : null,
  };
};
