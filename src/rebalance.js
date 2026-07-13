// Logica di ribilanciamento e attribuzione crescita — pura, testabile in Jest.

export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Chiave di identità di un asset ATTRAVERSO gli snapshot. Volutamente NON `id`:
// l'id è un uid casuale rigenerato se l'asset viene cancellato e riaggiunto, il
// che spezzerebbe la serie storica in due e conterebbe il riacquisto come un
// versamento. Il nome normalizzato è stabile. Slug perché finisce come dataKey
// di Recharts, dove i punti sono path lookup.
export const snapKey = (a) =>
  (a.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || a.id;

// Asset con target calcolato sul PATRIMONIO TOTALE (come l'oro) invece che
// sul sotto-portafoglio ETF. Bitcoin ETP si compra come un ETF ma la sua
// allocazione target è una % dell'intero patrimonio.
export const isTotalTargetAsset = (a) => a.targetOnTotal ?? a.assetClass === "Crypto";

// Distribuzione buy-only del budget tra gli asset ETF, proporzionale ai
// target normalizzati, senza mai vendere.
export const calcRebalancing = (assets, totalVal, budget) => {
  if (!totalVal || totalVal <= 0) return { actions: [] };
  const sumTarget = assets.reduce((acc, a) => acc + (a.targetWeight || 0), 0) || 1;
  const norm = 100 / sumTarget;
  const actions = assets.map((a) => {
    const cur   = (a.lastPrice || 0) * (a.quantity || 0);
    const curW  = (cur / totalVal) * 100;
    const tgtW  = (a.targetWeight || 0) * norm;
    const delta = (tgtW / 100) * totalVal - cur;
    const qty   = a.lastPrice ? delta / a.lastPrice : 0;
    return { ...a, curW, tgtW, delta, qty };
  });
  const buy = new Array(actions.length).fill(0);
  let eligible = actions.map((_, i) => i).filter((i) => actions[i].delta > 0);
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
    const sumAllTgt = actions.reduce((acc, a) => acc + a.tgtW, 0);
    if (sumAllTgt > 0) actions.forEach((a, i) => { buy[i] += (a.tgtW / sumAllTgt) * remaining; });
  }
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
export const calcRebalancingTwoLevel = (etfAssets, items, grandTotal, etfTotalVal, budget) => {
  const newTotal = grandTotal + budget;

  const needs = items.map((it) =>
    it.targetPct > 0 && it.price > 0
      ? Math.max(0, (it.targetPct / 100) * newTotal - it.currentVal)
      : 0
  );
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
  const etfRebalance = calcRebalancing(etfAssets, etfTotalVal, etfBudget);

  return { itemBuys, etfBudget, etfTotalVal, etfRebalance };
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
export const calcStartupMetrics = (s) => {
  const status    = suStatus(s);
  const invested  = s.invested || 0;
  const fee       = s.fee || 0;
  const totalCost = r2(invested + fee);
  const closed    = status !== "active";
  const recovered = status === "exit" ? (s.exitAmount || 0) : status === "failed" ? 0 : null;
  const pnl       = closed ? r2(recovered - totalCost) : null;
  const roiPct    = closed && totalCost > 0 ? r2((pnl / totalCost) * 100) : null;
  return { ...s, status, invested, fee, totalCost, closed, recovered, pnl, roiPct };
};

// Riepilogo aggregato del portafoglio startup. P&L e ROI si misurano solo sulle
// concluse: dicono se il recuperato copre il costo sostenuto, commissioni incluse.
export const calcStartupPortfolio = (startups) => {
  const rows   = (startups || []).map(calcStartupMetrics);
  const active = rows.filter((s) => !s.closed);
  const closed = rows.filter((s) => s.closed);
  const failed = rows.filter((s) => s.status === "failed");
  const sum = (list, f) => r2(list.reduce((a, s) => a + f(s), 0));

  const investedTot  = sum(rows, (s) => s.invested);
  const feesTot      = sum(rows, (s) => s.fee);
  const activeVal    = sum(active, (s) => s.invested);
  const closedCost   = sum(closed, (s) => s.totalCost);
  const recoveredTot = sum(closed, (s) => s.recovered || 0);
  const pnlTot       = r2(recoveredTot - closedCost);

  return {
    rows, active, closed,
    investedTot, feesTot,
    costTot:    r2(investedTot + feesTot),
    activeVal, closedCost, recoveredTot,
    failedLoss: sum(failed, (s) => s.totalCost),
    pnlTot,
    roiPct: closedCost > 0 ? r2((pnlTot / closedCost) * 100) : null,
  };
};
