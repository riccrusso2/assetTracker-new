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

// Distribuzione buy-only del budget tra gli asset ETF, senza mai vendere.
//
// Il fabbisogno di ogni asset si misura sul patrimonio DOPO il budget
// (`totalVal + budget`): è la base su cui il budget viene effettivamente speso.
// Misurarlo sul totale attuale — com'era prima — significava che un asset appena
// sopra target restava a zero anche quando il budget lo rendeva sottopesato: con
// 100k di portafoglio, oro al 13% contro un target del 10% e un budget di 100k,
// finiva al 6,5% senza ricevere un euro.
//
// `band`: scostamento in punti percentuali entro cui un asset si considera già
// a posto. Serve a non inseguire il target ogni mese per mezzo punto — ogni
// riequilibrio costa commissioni e, sui titoli, può realizzare imposte. È una
// priorità, non un'esclusione: chi è fuori banda viene servito per primo, il
// resto del budget copre comunque il fabbisogno di tutti gli altri. Se nessuno
// ha più fabbisogno il surplus si distribuisce ai pesi target, che per un PAC è
// esattamente il comportamento voluto.
export const calcRebalancing = (assets, totalVal, budget, band = 0) => {
  const newTotal = (totalVal || 0) + (budget || 0);
  // Anche con un portafoglio ancora a zero il budget va allocato: è il primo
  // mese d'uso, i target ci sono e la ripartizione ai pesi è già la risposta.
  if (!(newTotal > 0)) return { actions: [] };
  const sumTarget = assets.reduce((acc, a) => acc + (a.targetWeight || 0), 0) || 1;
  const norm = 100 / sumTarget;
  const rows = assets.map((a) => {
    const cur   = (a.lastPrice || 0) * (a.quantity || 0);
    const tgtW  = (a.targetWeight || 0) * norm;
    const need  = Math.max(0, (tgtW / 100) * newTotal - cur);
    const delta = (tgtW / 100) * totalVal - cur;
    return {
      ...a, tgtW, need, delta,
      curW: totalVal > 0 ? (cur / totalVal) * 100 : 0,
      qty:  a.lastPrice ? delta / a.lastPrice : 0,
      // Senza prezzo l'asset risulterebbe a valore 0, quindi il più sottopesato
      // di tutti: si prenderebbe il budget e applyRebalance lo scarterebbe,
      // registrando acquisti per molto meno del budget mostrato a schermo.
      buyable: (a.lastPrice || 0) > 0,
      // La banda si misura sullo stesso scostamento che si sta per colmare,
      // non sul peso attuale: altrimenti torna l'incoerenza di basi di sopra.
      inBand: (need / newTotal) * 100 < band,
    };
  });

  const buy = new Array(rows.length).fill(0);
  let remaining = budget || 0;
  // Riempimento ad acqua: quota proporzionale al fabbisogno residuo, mai oltre
  // il fabbisogno. Una passata basta — se il budget copre tutto ognuno prende
  // il suo, altrimenti la quota è già una frazione del fabbisogno.
  const fill = (idxs) => {
    const pool = idxs.filter((i) => rows[i].buyable && rows[i].need - buy[i] > 0.005);
    const sum  = pool.reduce((acc, i) => acc + (rows[i].need - buy[i]), 0);
    if (sum <= 0 || remaining <= 0.005) return;
    const k = Math.min(1, remaining / sum);
    for (const i of pool) {
      const add = (rows[i].need - buy[i]) * k;
      buy[i] += add;
      remaining -= add;
    }
  };
  fill(rows.map((_, i) => i).filter((i) => !rows[i].inBand));   // prima chi è fuori banda
  fill(rows.map((_, i) => i));                                  // poi il fabbisogno residuo
  if (remaining > 0.005) {
    // Tutti al target: il surplus è denaro nuovo e va ai pesi target. Quando
    // nessuno ha deriva il fabbisogno è già proporzionale al target, quindi le
    // due ripartizioni coincidono e questo ramo serve solo oltre il target.
    const idxs = rows.map((_, i) => i).filter((i) => rows[i].buyable);
    const sumTgt = idxs.reduce((acc, i) => acc + rows[i].tgtW, 0);
    if (sumTgt > 0) idxs.forEach((i) => { buy[i] += (rows[i].tgtW / sumTgt) * remaining; });
  }

  const rounded   = buy.map((b) => r2(Math.max(0, b || 0)));
  const allocated = rounded.reduce((a, b) => a + b, 0);
  const roundDiff = r2(budget - allocated);
  // `allocated > 0` è la guardia: senza, con tutti i target a zero il resto di
  // arrotondamento vale l'intero budget e finisce sul primo asset dell'array.
  if (Math.abs(roundDiff) > 0 && allocated > 0) {
    const maxIdx = rounded.indexOf(Math.max(...rounded));
    rounded[maxIdx] = r2(rounded[maxIdx] + roundDiff);
  }
  return {
    actions: rows.map((a, i) => ({
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
    if (!(it.targetPct > 0 && it.price > 0) || !(newTotal > 0)) return 0;
    // Stesso criterio del livello 2: fabbisogno e banda sul patrimonio DOPO il
    // budget. Con il peso attuale come base un asset sopra target non riceveva
    // nulla nemmeno quando il budget lo rendeva sottopesato — e `gapPP/100 ×
    // newTotal` è identicamente il fabbisogno, quindi le due misure non possono
    // più divergere.
    const gapPP = it.targetPct - (it.currentVal / newTotal) * 100;
    if (gapPP < band) return 0;                          // già dentro la banda
    return (gapPP / 100) * newTotal;
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

// ====================== COMPOSIZIONE DEL PATRIMONIO ======================
// Scomposizione a due livelli per l'export Excel: le macro-categorie della
// Overview ("Asset allocation": classi degli asset quotati, poi Startup, Oro,
// Liquidità) e, dentro ognuna, le singole posizioni.
//
// Ogni posizione porta tre percentuali che rispondono a domande diverse:
//  - `pctCategory`: quanto pesa dentro la sua macro-categoria;
//  - `pctTotal`:    quanto pesa sul patrimonio;
//  - `weight` contro `target`: il peso misurato sulla STESSA base del target,
//    cioè il "Peso" delle tabelle del Portafoglio. Per gli ETF è il
//    sotto-portafoglio ETF (target normalizzato a 100 come nel
//    ribilanciamento), per oro e crypto il patrimonio totale. Senza questa
//    colonna il confronto col target sarebbe fra numeri con denominatori
//    diversi.
//
// Le basi replicano quelle di App.js (grandTotal, etfSubTotal, goldPct): se
// cambiano lì, vanno cambiate qui, altrimenti il file dice un numero diverso
// da quello a schermo. I valori restano non arrotondati: l'arrotondamento è
// del formato di cella, così la somma delle righe torna esattamente al totale.
export const TARGET_BASE = {
  etf:   "Sotto-portafoglio ETF",
  total: "Patrimonio totale",
  gold:  "Patrimonio totale (ETF + oro fisico)",
};

export const portfolioBreakdown = ({
  assets = [], goldEtf = null, physGold = null, startups = [], totalCash = 0, subscription = 0,
} = {}) => {
  const valOf = (a) => (a && a.lastPrice ? a.lastPrice * (a.quantity || 0) : 0);
  const pct   = (v, base) => (base > 0 ? (v / base) * 100 : null);
  const list  = assets || [];
  const gold  = goldEtf || {};

  // ---- Basi, come in App.js ----
  const goldOnTotal   = isTotalTargetAsset(gold);
  const goldEtfValue  = valOf(gold);
  const physGoldValue = physGold?.pricePerGram18kt && physGold?.grams
    ? r2(physGold.pricePerGram18kt * physGold.grams) : 0;
  const su   = calcStartupPortfolio(startups, subscription);
  const cash = Number(totalCash) || 0;
  const grandTotal = list.reduce((s, a) => s + valOf(a), 0) + goldEtfValue
    + cash + physGoldValue + su.activeValue;

  // L'ETF oro entra nel sotto-portafoglio solo col target ETF-relative.
  const etfPortfolio = list.filter((a) => !isTotalTargetAsset(a));
  if (!goldOnTotal && gold.identifier) etfPortfolio.push(gold);
  const etfSubTotal  = etfPortfolio.reduce((s, a) => s + valOf(a), 0);
  const etfTargetSum = r2(etfPortfolio.reduce((s, a) => s + (a.targetWeight || 0), 0));
  const etfNorm      = etfTargetSum > 0 ? 100 / etfTargetSum : 1;

  const noTarget = { weight: null, target: null, targetBase: null };
  const quoted = (a, kind = "asset") => {
    const value   = valOf(a);
    const qty     = a.quantity || 0;
    const hasPerf = !!(a.costBasis && a.lastPrice);
    const tgt = isTotalTargetAsset(a)
      ? { weight: pct(value, grandTotal), target: a.targetWeight || 0, targetBase: TARGET_BASE.total }
      : { weight: pct(value, etfSubTotal), target: r2((a.targetWeight || 0) * etfNorm), targetBase: TARGET_BASE.etf };
    return {
      kind, name: a.name || "", isin: a.identifier || "", assetClass: a.assetClass || "",
      quantity: qty, unitCost: a.costBasis || null, price: a.lastPrice || null,
      value, cost: a.costBasis ? a.costBasis * qty : null,
      pnl:    hasPerf ? (a.lastPrice - a.costBasis) * qty : null,
      pnlPct: hasPerf ? ((a.lastPrice - a.costBasis) / a.costBasis) * 100 : null,
      ...tgt,
    };
  };

  // ---- Macro-categorie, nell'ordine della Overview ----
  // Le classi entrano per prima comparsa con valore (come calcClassDist), poi
  // quelle dei soli asset ancora a zero, che si esportano comunque: sono nel
  // portafoglio anche senza prezzo o con quantità 0 (tracker di benchmark).
  const cats = new Map();
  const add  = (name, pos) => {
    if (!cats.has(name)) cats.set(name, []);
    cats.get(name).push(pos);
  };
  const classOf = (a) => a.assetClass || "Altro";
  [...list.filter((a) => valOf(a) > 0), ...list].forEach((a) => {
    if (!cats.has(classOf(a))) cats.set(classOf(a), []);
  });
  list.forEach((a) => add(classOf(a), quoted(a)));

  // Solo le attive sono nel patrimonio; le concluse restano in `startups`.
  su.active.forEach((s) => {
    // Senza valutazione dichiarata il valore è il costo e il P&L non esiste:
    // la UI mostra "—", e un −commissioni qui sarebbe un numero inventato.
    const valued = s.currentValue != null;
    add("Startup", {
      kind: "startup", name: s.name || "", isin: "", assetClass: "Startup",
      quantity: null, unitCost: null, price: null,
      value: s.value, cost: s.totalCost,
      pnl:    valued ? s.unrealPnl : null,
      pnlPct: valued ? s.unrealRoiPct : null,
      date: s.date || null, ...noTarget,
    });
  });

  // Oro: ETF quotato e fisico nella stessa categoria, come nella Overview. Se
  // il target dell'oro è sul patrimonio vale per ETF + fisico insieme, e così
  // lo misura la UI (goldPct).
  if (gold.identifier || goldEtfValue > 0) {
    const g = quoted({ ...gold, name: gold.name || "ETF oro" }, "goldEtf");
    if (goldOnTotal) {
      Object.assign(g, {
        weight: pct(goldEtfValue + physGoldValue, grandTotal),
        target: gold.targetWeight || 0,
        targetBase: TARGET_BASE.gold,
      });
    }
    add("Oro", g);
  }
  if ((physGold?.grams || 0) > 0) {
    add("Oro", {
      kind: "physGold", name: "Oro fisico 18kt", isin: "", assetClass: "Oro",
      quantity: physGold.grams, unit: "g", unitCost: null, price: physGold.pricePerGram18kt || null,
      value: physGoldValue, cost: null, pnl: null, pnlPct: null, ...noTarget,
    });
  }

  // Anche negativa: il patrimonio la conta, e senza la riga le categorie non
  // sommerebbero al totale.
  if (cash !== 0) {
    add("Liquidità", {
      kind: "cash", name: "Liquidità disponibile", isin: "", assetClass: "Liquidità",
      quantity: null, unitCost: null, price: null,
      value: cash, cost: null, pnl: null, pnlPct: null, ...noTarget,
    });
  }

  const categories = [...cats]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => {
      const value = items.reduce((s, p) => s + p.value, 0);
      return {
        name, value, pct: pct(value, grandTotal),
        items: items.map((p) => ({
          ...p,
          category: name,
          pctCategory: value !== 0 ? (p.value / value) * 100 : null,
          pctTotal: pct(p.value, grandTotal),
          drift: p.weight != null && p.target != null ? p.weight - p.target : null,
        })),
      };
    });

  return { grandTotal, categories, etfSubTotal, etfTargetSum, goldOnTotal, startups: su };
};
