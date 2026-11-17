import {
  r2, isTotalTargetAsset, calcRebalancing, calcRebalancingTwoLevel,
  calcStartupMetrics, calcStartupPortfolio,
  calcDrift, driftThreshold, DRIFT_ALERT_PP,
  startupCashFlows, startupHoldings, calcConcentration,
  portfolioBreakdown, TARGET_BASE,
} from "./rebalance";
import { xirr } from "./transactions";

test("Bitcoin (Crypto) e ETF oro hanno per default il target sul patrimonio totale", () => {
  expect(isTotalTargetAsset({ assetClass: "Crypto" })).toBe(true);
  expect(isTotalTargetAsset({ assetClass: "Oro" })).toBe(true);   // config oro pre-esistenti
  expect(isTotalTargetAsset({ assetClass: "ETF" })).toBe(false);
  expect(isTotalTargetAsset({ assetClass: "ETF", targetOnTotal: true })).toBe(true);
  expect(isTotalTargetAsset({ assetClass: "Crypto", targetOnTotal: false })).toBe(false);
  expect(isTotalTargetAsset({ assetClass: "Oro", targetOnTotal: false })).toBe(false);
});

test("oro col target sul sotto-portafoglio ETF: 90/10 indipendente dalla liquidità", () => {
  // Patrimonio 100k di cui 90k di liquidità: se l'oro avesse il target sul totale
  // sarebbe cronicamente sottopesato e mangerebbe tutto il budget (livello 1).
  // Con il target ETF-relative l'oro entra nel livello 2 insieme al globale.
  const etf = [
    { id: "w", name: "Globale", targetWeight: 90, lastPrice: 100, quantity: 90 },  // 9.000
    { id: "g", name: "ETF Oro", targetWeight: 10, lastPrice: 50,  quantity: 10 },  //   500 → sotto
  ];
  const { itemBuys, etfBudget, etfRebalance } =
    calcRebalancingTwoLevel(etf, [], 100_000, 9_500, 1_000);

  expect(itemBuys).toHaveLength(0);
  expect(etfBudget).toBe(1_000);        // niente livello 1: il budget resta agli ETF

  const byId = Object.fromEntries(etfRebalance.actions.map((a) => [a.id, a]));
  expect(byId.g.tgtW).toBeCloseTo(10, 6);   // target sui soli ETF, non sul patrimonio
  expect(byId.g.curW).toBeCloseTo(5.26, 2);
  // Il fabbisogno si misura sul portafoglio POST budget (10.500): oro 550,
  // globale 450. Sommano al budget, quindi entrambi arrivano esatti al target.
  expect(byId.g.monthlyBuy).toBe(550);
  expect(byId.w.monthlyBuy).toBe(450);
  expect(r2(byId.g.monthlyBuy + byId.w.monthlyBuy)).toBe(1_000);
  const goldAfter = (500 + byId.g.monthlyBuy) / (9_500 + 1_000) * 100;
  expect(goldAfter).toBeCloseTo(10, 6);
});

test("target 4% su patrimonio 100k → obiettivo 4.000€, non 4% degli ETF", () => {
  // Patrimonio totale 100.000 (di cui ETF 50.000), Bitcoin vale 1.000, target 4%
  const grandTotal = 100_000;
  const etfTotal = 50_000;
  const budget = 1_000;
  const items = [
    { id: "btc", name: "Bitcoin ETP", targetPct: 4, currentVal: 1_000, price: 5 },
  ];
  const { itemBuys, etfBudget } = calcRebalancingTwoLevel([], items, grandTotal, etfTotal, budget);

  // Obiettivo: 4% × (100.000 + 1.000) = 4.040 → fabbisogno 3.040, ma budget 1.000
  expect(itemBuys[0].buy).toBe(1000);
  expect(itemBuys[0].currentPct).toBe(1);
  expect(etfBudget).toBe(0);
});

test("oro e Bitcoin sopra target → tutto il budget agli ETF", () => {
  const items = [
    { id: "gold", name: "Oro", targetPct: 10, currentVal: 15_000, price: 70 },
    { id: "btc", name: "Bitcoin ETP", targetPct: 4, currentVal: 8_000, price: 5 },
  ];
  const etf = [{ id: "a", name: "A", targetWeight: 100, lastPrice: 10, quantity: 100 }];
  const { itemBuys, etfBudget, etfRebalance } =
    calcRebalancingTwoLevel(etf, items, 100_000, 1_000, 500);

  expect(itemBuys.every((x) => x.buy === 0)).toBe(true);
  expect(etfBudget).toBe(500);
  const totBuy = r2(etfRebalance.actions.reduce((a, x) => a + x.monthlyBuy, 0));
  expect(totBuy).toBe(500);
});

test("fabbisogno oltre budget → ripartizione proporzionale", () => {
  const items = [
    { id: "gold", name: "Oro", targetPct: 10, currentVal: 0, price: 70 },   // need 10% × 101k = 10.100
    { id: "btc", name: "Bitcoin", targetPct: 5, currentVal: 0, price: 5 },  // need 5%  × 101k = 5.050
  ];
  const { itemBuys, etfBudget } = calcRebalancingTwoLevel([], items, 100_000, 0, 1_000);
  // 2:1 → 666.67 / 333.33
  expect(itemBuys[0].buy).toBeCloseTo(666.67, 1);
  expect(itemBuys[1].buy).toBeCloseTo(333.33, 1);
  expect(etfBudget).toBe(0);
});

test("calcRebalancing buy-only alloca tutto il budget e non vende", () => {
  const assets = [
    { id: "a", name: "A", targetWeight: 60, lastPrice: 100, quantity: 10 }, // 1.000, sotto target
    { id: "b", name: "B", targetWeight: 40, lastPrice: 100, quantity: 15 }, // 1.500, sopra target
  ];
  const { actions } = calcRebalancing(assets, 2_500, 500);
  const tot = r2(actions.reduce((s, x) => s + x.monthlyBuy, 0));
  expect(tot).toBe(500);
  expect(actions.every((x) => x.monthlyBuy >= 0)).toBe(true);
});

// ====================== STARTUP LIFECYCLE ======================

test("startup senza status (config vecchia) vale come attiva, senza P&L", () => {
  const s = calcStartupMetrics({ name: "Legacy", invested: 5000, fee: 300 });
  expect(s.status).toBe("active");
  expect(s.totalCost).toBe(5300);
  expect(s.closed).toBe(false);
  expect(s.recovered).toBeNull();
  expect(s.pnl).toBeNull();
  expect(s.roiPct).toBeNull();
});

test("exit: P&L e ROI si calcolano sul costo totale, commissioni incluse", () => {
  const s = calcStartupMetrics({ name: "Exit", invested: 5000, fee: 500, status: "exit", exitAmount: 8000 });
  expect(s.totalCost).toBe(5500);
  expect(s.recovered).toBe(8000);
  expect(s.pnl).toBe(2500);
  expect(s.roiPct).toBeCloseTo(45.45, 2);
});

test("fallita: valore finale 0, perdita pari al costo totale", () => {
  const s = calcStartupMetrics({ name: "Bust", invested: 4000, fee: 200, status: "failed" });
  expect(s.recovered).toBe(0);
  expect(s.pnl).toBe(-4200);
  expect(s.roiPct).toBe(-100);
});

test("riepilogo: P&L e ROI solo sulle concluse, le attive restano al costo", () => {
  const p = calcStartupPortfolio([
    { id: "a", invested: 10_000, fee: 500 },                                     // attiva
    { id: "b", invested: 5_000,  fee: 250, status: "exit", exitAmount: 9_000 },  // exit +3.750
    { id: "c", invested: 3_000,  fee: 150, status: "failed" },                   // fallita −3.150
  ]);
  expect(p.investedTot).toBe(18_000);
  expect(p.feesTot).toBe(900);
  expect(p.costTot).toBe(18_900);
  expect(p.activeVal).toBe(10_000);       // solo la attiva entra nel patrimonio
  expect(p.recoveredTot).toBe(9_000);
  expect(p.failedLoss).toBe(3_150);
  expect(p.closedCost).toBe(8_400);       // 5.250 + 3.150
  expect(p.pnlTot).toBe(600);             // 9.000 − 8.400 → capitale rientrato
  expect(p.roiPct).toBeCloseTo(7.14, 2);
});

test("riepilogo senza startup concluse: ROI non calcolabile", () => {
  const p = calcStartupPortfolio([{ id: "a", invested: 1000, fee: 50 }]);
  expect(p.closed).toHaveLength(0);
  expect(p.roiPct).toBeNull();
  expect(p.pnlTot).toBe(0);
});

// ------ Bilancio complessivo: capitale + commissioni + abbonamento ------

test("attiva con valutazione attuale: P&L non realizzato sul costo totale", () => {
  const s = calcStartupMetrics({ name: "Up", invested: 5000, fee: 500, currentValue: 7700 });
  expect(s.value).toBe(7700);
  expect(s.unrealPnl).toBe(2200);
  expect(s.unrealRoiPct).toBeCloseTo(40, 2);
  expect(s.pnl).toBeNull();        // non è realizzato
});

test("attiva senza valutazione: vale il capitale investito, sotto di una commissione", () => {
  const s = calcStartupMetrics({ name: "Flat", invested: 5000, fee: 500 });
  expect(s.currentValue).toBeNull();
  expect(s.value).toBe(5000);
  expect(s.unrealPnl).toBe(-500);
});

test("complessivo: abbonamento e commissioni pesano sul ROI totale", () => {
  const p = calcStartupPortfolio([
    { id: "a", invested: 10_000, fee: 500, currentValue: 12_000 },                // attiva rivalutata
    { id: "b", invested: 5_000,  fee: 250, status: "exit", exitAmount: 9_000 },   // exit
    { id: "c", invested: 3_000,  fee: 150, status: "failed" },                    // fallita
  ], 468);
  expect(p.subscription).toBe(468);
  expect(p.activeVal).toBe(10_000);      // patrimonio: sempre a costo
  expect(p.activeValue).toBe(12_000);    // statistiche: a valutazione
  expect(p.totalOutlay).toBe(19_368);    // 18.000 + 900 + 468
  expect(p.totalValue).toBe(21_000);     // 9.000 recuperati + 12.000 attivi
  expect(p.pnlOverall).toBe(1_632);
  expect(p.roiOverallPct).toBeCloseTo(8.43, 2);
  expect(p.pnlTot).toBe(600);            // il realizzato non cambia
  expect(p.allClosed).toBe(false);
});

test("tutte concluse: complessivo e realizzato-netto danno lo stesso verdetto finale", () => {
  const p = calcStartupPortfolio([
    { id: "b", invested: 5_000, fee: 250, status: "exit", exitAmount: 9_000 },
    { id: "c", invested: 3_000, fee: 150, status: "failed" },
  ], 468);
  expect(p.allClosed).toBe(true);
  expect(p.activeValue).toBe(0);
  expect(p.pnlOverall).toBe(132);                 // 600 realizzati − 468 di abbonamento
  expect(p.pnlRealizedNet).toBe(p.pnlOverall);
  expect(p.roiOverallPct).toBeCloseTo(p.roiRealizedNetPct, 6);
  expect(p.roiOverallPct).toBeCloseTo(1.49, 2);
});

test("totali di colonna: valore e P&L sommano le righe, abbonamento escluso", () => {
  const p = calcStartupPortfolio([
    { id: "a", invested: 10_000, fee: 500, currentValue: 12_000 },
    { id: "b", invested: 5_000,  fee: 250, status: "exit", exitAmount: 9_000 },
    { id: "c", invested: 3_000,  fee: 150, status: "failed" },
  ], 468);
  expect(p.costTot).toBe(18_900);
  expect(p.totalValue).toBe(21_000);
  expect(p.pnlNoSub).toBe(2_100);                     // 21.000 − 18.900, senza abbonamento
  expect(p.pnlNoSub - p.subscription).toBe(p.pnlOverall);
  expect(p.roiNoSubPct).toBeCloseTo(11.11, 2);
});

test("abbonamento omesso: retrocompatibile col calcolo precedente", () => {
  const rows = [{ id: "b", invested: 5_000, fee: 250, status: "exit", exitAmount: 9_000 }];
  const p = calcStartupPortfolio(rows);
  expect(p.subscription).toBe(0);
  expect(p.allClosed).toBe(true);
  expect(p.pnlOverall).toBe(p.pnlTot);
  expect(p.roiOverallPct).toBeCloseTo(p.roiPct, 6);
});

// ====================== bande di tolleranza ======================
test("con la banda attiva chi è quasi a target passa per ultimo", () => {
  // Sul totale post budget (9.900) "a" ha un fabbisogno di 50 (0,5 punti, dentro
  // la banda) e "b" di 950 (9,6 punti, fuori): "b" viene servito per primo e si
  // prende quasi tutto. Il residuo copre comunque "a", perché la banda è una
  // priorità e non un'esclusione: escluderlo del tutto significava, con un
  // budget grande, lasciare a zero un asset che il budget rendeva sottopesato.
  const assets = [
    { name: "a", targetWeight: 50, lastPrice: 100, quantity: 49 },   // 4.900 → 49%
    { name: "b", targetWeight: 50, lastPrice: 100, quantity: 40 },   // 4.000 → 40%
  ];
  const { actions } = calcRebalancing(assets, 8900, 1000, 5);
  expect(actions[0].monthlyBuy).toBe(50);
  expect(actions[1].monthlyBuy).toBe(950);
  expect(actions[0].inBand).toBe(true);
  expect(actions[1].inBand).toBe(false);
});

test("un asset sopra target riceve comunque, se il budget lo rende sottopesato", () => {
  // Regressione: la banda si misurava sul peso ATTUALE, quindi chi era sopra
  // target restava escluso da ogni fase qualunque fosse il budget. Con banda 2
  // e un budget di 1M il 60/40 finiva 5,6% / 94,4%.
  const assets = [
    { name: "a", targetWeight: 60, lastPrice: 100, quantity: 620 },  // 62.000 → 62%
    { name: "b", targetWeight: 40, lastPrice: 100, quantity: 380 },  // 38.000 → 38%
  ];
  const { actions } = calcRebalancing(assets, 100_000, 1_000_000, 2);
  const peso = (x) => (x.lastPrice * x.quantity + x.monthlyBuy) / 1_100_000 * 100;
  expect(peso(actions[0])).toBeCloseTo(60, 6);
  expect(peso(actions[1])).toBeCloseTo(40, 6);
});

test("livello 1: oro sopra target riceve quando il budget lo diluisce sotto", () => {
  // Il caso che ha fatto emergere il bug: oro al 13% con target 10%. Fino a
  // 30.000 di budget resta sopra target e non prende nulla; oltre, il PAC lo
  // porterebbe sotto e deve comprare.
  const items = () => [{ id: "g", name: "Oro", targetPct: 10, currentVal: 13_000, price: 200 }];
  const etf = () => [{ id: "w", name: "W", targetWeight: 100, lastPrice: 100, quantity: 600 }];

  const sotto = calcRebalancingTwoLevel(etf(), items(), 100_000, 60_000, 10_000);
  expect(sotto.itemBuys[0].buy).toBe(0);          // 13.000 > 10% di 110.000

  const sopra = calcRebalancingTwoLevel(etf(), items(), 100_000, 60_000, 100_000);
  expect(sopra.itemBuys[0].buy).toBe(7_000);      // 10% di 200.000 = 20.000
  expect((13_000 + sopra.itemBuys[0].buy) / 200_000 * 100).toBeCloseTo(10, 6);
});

test("asset senza prezzo non assorbe budget che non può essere speso", () => {
  const assets = [
    { name: "quotato",  targetWeight: 60, lastPrice: 100,  quantity: 10 },
    { name: "no-prezzo", targetWeight: 40, lastPrice: null, quantity: 0 },
  ];
  const { actions } = calcRebalancing(assets, 1_000, 500);
  expect(actions[0].monthlyBuy).toBe(500);
  expect(actions[1].monthlyBuy).toBe(0);
});

test("portafoglio ancora vuoto: il budget si ripartisce ai pesi target", () => {
  const assets = [
    { name: "a", targetWeight: 60, lastPrice: 100, quantity: 0 },
    { name: "b", targetWeight: 40, lastPrice: 50,  quantity: 0 },
  ];
  const { actions } = calcRebalancing(assets, 0, 1_000);
  expect(actions.map((a) => a.monthlyBuy)).toEqual([600, 400]);
});

test("nessun target impostato: nessun acquisto, non tutto sul primo asset", () => {
  const assets = [
    { name: "a", targetWeight: 0, lastPrice: 100, quantity: 10 },
    { name: "b", targetWeight: 0, lastPrice: 100, quantity: 10 },
  ];
  const { actions } = calcRebalancing(assets, 2_000, 1_000);
  expect(actions.map((a) => a.monthlyBuy)).toEqual([0, 0]);
});

test("se nessuno esce dalla banda il budget si distribuisce ai pesi target, non resta fermo", () => {
  const assets = [
    { name: "a", targetWeight: 60, lastPrice: 100, quantity: 60 },
    { name: "b", targetWeight: 40, lastPrice: 100, quantity: 40 },
  ];
  const { actions } = calcRebalancing(assets, 10000, 1000, 5);
  expect(actions[0].monthlyBuy).toBe(600);
  expect(actions[1].monthlyBuy).toBe(400);
});

test("banda a zero: comportamento identico a prima", () => {
  const assets = [
    { name: "a", targetWeight: 50, lastPrice: 100, quantity: 49 },
    { name: "b", targetWeight: 50, lastPrice: 100, quantity: 40 },
  ];
  expect(calcRebalancing(assets, 8900, 1000, 0).actions.map((a) => a.monthlyBuy))
    .toEqual(calcRebalancing(assets, 8900, 1000).actions.map((a) => a.monthlyBuy));
});

test("la banda vale anche al livello 1 (oro, Bitcoin)", () => {
  const items = [{ id: "g", name: "Oro", targetPct: 10, currentVal: 950, price: 50 }]; // 9,5% su 10.000
  const etf = [{ name: "w", targetWeight: 100, lastPrice: 100, quantity: 90 }];
  const senza = calcRebalancingTwoLevel(etf, items, 10000, 9000, 1000, 0);
  const con   = calcRebalancingTwoLevel(etf, items, 10000, 9000, 1000, 5);
  expect(senza.itemBuys[0].buy).toBeGreaterThan(0);
  expect(con.itemBuys[0].buy).toBe(0);
  expect(con.etfBudget).toBe(1000);
});

// ====================== deriva dai target ======================

describe("calcDrift", () => {
  const p = (name, actualPct, targetPct) => ({ name, actualPct, targetPct });

  // Regressione: la deriva era la SOMMA degli scostamenti assoluti, quindi
  // cresceva col numero di posizioni. Sul portafoglio reale (6 ETF, scostamento
  // massimo 2,6 punti) la somma valeva 5,8 e superava la soglia fissa di 5:
  // l'allarme era permanentemente acceso su un portafoglio in ordine.
  test("riporta il massimo scostamento, non la somma", () => {
    const d = calcDrift([
      p("A", 53.6, 51), p("B", 13.8, 14), p("C", 7.3, 9),
      p("D", 8.2, 8),   p("E", 8.6, 8),   p("F", 8.5, 8),
    ]);
    expect(d.max).toBe(2.6);
    expect(d.sum).toBe(5.8);
    expect(d.worst.name).toBe("A");
  });

  // Il nocciolo della regressione: aggiungere righe che oscillano attorno al
  // proprio target lascia il portafoglio altrettanto in ordine, ma gonfia la
  // somma degli scostamenti assoluti. Con la soglia applicata alla somma,
  // diversificare faceva scattare l'allarme.
  test("posizioni piccole in bolla non peggiorano la deriva", () => {
    const base = [p("Grande", 52, 50), p("Media", 30, 30), p("Piccola", 18, 20)];
    const piuRighe = [
      ...base,
      p("N1", 5.5, 5), p("N2", 4.5, 5), p("N3", 5.4, 5), p("N4", 4.6, 5),
    ];
    expect(calcDrift(piuRighe).max).toBe(calcDrift(base).max);      // 2 punti in entrambi
    expect(calcDrift(piuRighe).sum).toBeGreaterThan(calcDrift(base).sum);
    // Con la vecchia misura (somma) e la soglia di 5 il secondo portafoglio
    // sarebbe risultato in allarme e il primo no, a parità di ordine.
    expect(calcDrift(base).sum).toBeLessThan(DRIFT_ALERT_PP);
    expect(calcDrift(piuRighe).sum).toBeGreaterThan(DRIFT_ALERT_PP);
    expect(calcDrift(piuRighe).max).toBeLessThan(DRIFT_ALERT_PP);
  });

  test("il peggiore è il più lontano in valore assoluto, anche se sottopeso", () => {
    const d = calcDrift([p("sopra", 12, 10), p("sotto", 1, 9)]);
    expect(d.worst.name).toBe("sotto");
    expect(d.max).toBe(8);
    expect(d.worst.delta).toBe(-8);
  });

  test("nessuna posizione valida: deriva zero e nessun peggiore", () => {
    expect(calcDrift([])).toEqual({ max: 0, sum: 0, worst: null });
    expect(calcDrift([{ name: "x" }, null])).toEqual({ max: 0, sum: 0, worst: null });
  });

  test("la soglia è la banda dichiarata dall'utente, altrimenti il default", () => {
    expect(driftThreshold(0)).toBe(DRIFT_ALERT_PP);
    expect(driftThreshold(undefined)).toBe(DRIFT_ALERT_PP);
    expect(driftThreshold(2)).toBe(2);
  });
});

// ====================== durata e IRR del book startup ======================

describe("startupCashFlows / startupHoldings", () => {
  const ASOF = "2026-01-01";

  test("i flussi sono l'esborso all'ingresso e l'incasso all'uscita", () => {
    const flows = startupCashFlows([
      { id: "a", name: "Exit", invested: 300, fee: 24, status: "exit",
        exitAmount: 900, date: "2022-01-01", exitDate: "2025-01-01" },
    ], ASOF);
    expect(flows).toEqual([
      { date: "2022-01-01", amount: -324 },
      { date: "2025-01-01", amount: 900 },
    ]);
    // 324 → 900 in tre anni ≈ +40,6% annuo.
    expect(xirr(flows) * 100).toBeCloseTo(40.6, 0);
  });

  test("una attiva vale alla data di riferimento, una fallita non incassa nulla", () => {
    const attiva = startupCashFlows(
      [{ id: "a", name: "A", invested: 100, fee: 0, status: "active", date: "2025-01-01" }], ASOF);
    expect(attiva).toEqual([
      { date: "2025-01-01", amount: -100 },
      { date: ASOF, amount: 100 },
    ]);
    const fallita = startupCashFlows(
      [{ id: "b", name: "B", invested: 100, fee: 0, status: "failed", date: "2025-01-01" }], ASOF);
    // Solo l'uscita: xirr su un flusso di solo segno negativo restituisce null,
    // ed è corretto — non esiste un tasso che spieghi una perdita totale.
    expect(fallita).toEqual([{ date: "2025-01-01", amount: -100 }]);
    expect(xirr(fallita)).toBeNull();
  });

  test("le posizioni senza data restano fuori e vengono contate", () => {
    const su = [
      { id: "a", name: "Con data", invested: 300, fee: 24, date: "2024-01-01" },
      { id: "b", name: "Senza data", invested: 300, fee: 24 },
    ];
    expect(startupCashFlows(su, ASOF)).toHaveLength(2);   // solo quelle di "a"
    const h = startupHoldings(su, ASOF);
    expect(h.withDate).toBe(1);
    expect(h.missingDate).toBe(1);
  });

  test("la durata media è ponderata per capitale, non per numero di righe", () => {
    const h = startupHoldings([
      { id: "a", name: "Piccola", invested: 100, fee: 0, date: "2024-01-01" },  // 2 anni
      { id: "b", name: "Grande",  invested: 900, fee: 0, date: "2025-01-01" },  // 1 anno
    ], "2026-01-01");
    // Media semplice = 1,5. Ponderata = (2×100 + 1×900)/1000 = 1,1.
    expect(h.avgYears).toBeCloseTo(1.1, 1);
  });

  test("la più vecchia ancora aperta è quella che dice da quanto il capitale è fermo", () => {
    const h = startupHoldings([
      { id: "a", name: "Vecchia aperta", invested: 300, fee: 0, date: "2020-01-01" },
      { id: "b", name: "Vecchissima chiusa", invested: 300, fee: 0, status: "exit",
        exitAmount: 100, date: "2015-01-01", exitDate: "2019-01-01" },
    ], "2026-01-01");
    expect(h.oldest.name).toBe("Vecchia aperta");
    expect(h.oldest.years).toBeCloseTo(6, 0);
  });

  test("book senza date: nessuna durata invece di un numero inventato", () => {
    const h = startupHoldings([{ id: "a", name: "X", invested: 300, fee: 0 }], ASOF);
    expect(h.avgYears).toBeNull();
    expect(h.missingDate).toBe(1);
  });
});

// ====================== concentrazione ======================

describe("calcConcentration", () => {
  test("misura il peso della prima e delle prime tre posizioni sul patrimonio", () => {
    // Il portafoglio reale: un ETF da solo vale più della metà del quotato.
    const c = calcConcentration([
      { name: "FTSE All-World", value: 15_874 },
      { name: "MSCI World",     value: 4_023 },
      { name: "EM IMI",         value: 2_128 },
      { name: "Quality",        value: 2_441 },
    ], 24_466);
    expect(c.top1).toBeCloseTo(64.9, 1);
    expect(c.top1Name).toBe("FTSE All-World");
    expect(c.top3).toBeCloseTo(91.3, 1);   // le tre maggiori, non le prime tre in ordine di lista
    expect(c.count).toBe(4);
  });

  test("la base è il patrimonio: la liquidità diluisce la concentrazione", () => {
    const pos = [{ name: "Unico", value: 5_000 }];
    expect(calcConcentration(pos, 5_000).top1).toBe(100);
    expect(calcConcentration(pos, 10_000).top1).toBe(50);
  });

  test("senza posizioni o senza patrimonio non inventa un numero", () => {
    expect(calcConcentration([], 1000).top1).toBeNull();
    expect(calcConcentration([{ name: "a", value: 10 }], 0).top1).toBeNull();
    // Le posizioni a zero o non numeriche non contano.
    expect(calcConcentration([{ name: "a", value: 0 }, { name: "b" }], 100).top1).toBeNull();
  });
});

// ====================== composizione del patrimonio (export) ======================

describe("portfolioBreakdown", () => {
  // Il portafoglio dell'esempio reale: ETF 35.970,72 · Crypto 1.283,16 ·
  // Startup 4.500 · Oro 7.005,69 · Liquidità 10.670 → 60,5 / 2,2 / 7,6 / 11,8 / 18,0 %.
  const REAL = {
    assets: [
      { id: "a1", name: "FTSE All-World", identifier: "IE00BK5BQT80", quantity: 150, costBasis: 120,
        lastPrice: 140, targetWeight: 60, assetClass: "ETF" },
      { id: "a2", name: "Bitcoin ETP", identifier: "GB00BJYDH287", quantity: 2, costBasis: 700,
        lastPrice: 641.58, targetWeight: 2, assetClass: "Crypto" },
      { id: "a3", name: "MSCI World", identifier: "IE00B4L5Y983", quantity: 120, costBasis: 95,
        lastPrice: 100.5, targetWeight: 30, assetClass: "ETF" },
      { id: "a4", name: "EM IMI", identifier: "IE00BKM4GZ66", quantity: 80, costBasis: 30,
        lastPrice: 36.384, targetWeight: 10, assetClass: "ETF" },
    ],
    goldEtf: { id: "gold-etf", name: "Physical Gold", identifier: "IE00B4ND3602", quantity: 25,
               costBasis: 180, lastPrice: 200.5, targetWeight: 10, assetClass: "Oro" },
    physGold: { grams: 10, pricePerGram18kt: 199.319 },
    startups: [
      { id: "s1", name: "Alfa", invested: 3000, fee: 60, date: "2023-05-10" },
      { id: "s2", name: "Beta", invested: 1000, fee: 20, currentValue: 1500 },
      { id: "s3", name: "Gamma", invested: 500, fee: 10, status: "failed" },
    ],
    totalCash: 10670,
  };

  test("macro-categorie nell'ordine e con le percentuali della Overview", () => {
    const b = portfolioBreakdown(REAL);
    expect(b.grandTotal).toBeCloseTo(59429.57, 2);
    expect(b.categories.map((c) => c.name)).toEqual(["ETF", "Crypto", "Startup", "Oro", "Liquidità"]);
    expect(b.categories.map((c) => r2(c.value))).toEqual([35970.72, 1283.16, 4500, 7005.69, 10670]);
    expect(b.categories.map((c) => c.pct.toFixed(1))).toEqual(["60.5", "2.2", "7.6", "11.8", "18.0"]);
    // Valori non arrotondati: le categorie sommano esattamente al patrimonio.
    expect(b.categories.reduce((s, c) => s + c.value, 0)).toBeCloseTo(b.grandTotal, 9);
    expect(b.categories.reduce((s, c) => s + c.pct, 0)).toBeCloseTo(100, 9);
  });

  test("ogni ETF ha ISIN, peso nella categoria, peso attuale e target sulla stessa base", () => {
    const etf = portfolioBreakdown(REAL).categories.find((c) => c.name === "ETF");
    expect(etf.items.map((p) => p.isin)).toEqual(["IE00BK5BQT80", "IE00B4L5Y983", "IE00BKM4GZ66"]);
    expect(etf.items.reduce((s, p) => s + p.pctCategory, 0)).toBeCloseTo(100, 9);
    const ftse = etf.items[0];
    expect(ftse.value).toBeCloseTo(21000, 6);
    expect(ftse.pctCategory).toBeCloseTo((21000 / 35970.72) * 100, 6);
    expect(ftse.pctTotal).toBeCloseTo((21000 / 59429.57) * 100, 6);
    // Il sotto-portafoglio ETF coincide qui con la categoria ETF.
    expect(ftse.weight).toBeCloseTo(ftse.pctCategory, 9);
    expect(ftse.target).toBe(60);
    expect(ftse.targetBase).toBe(TARGET_BASE.etf);
    expect(ftse.drift).toBeCloseTo(ftse.weight - 60, 9);
    expect(ftse.pnl).toBeCloseTo(3000, 6);
    expect(ftse.pnlPct).toBeCloseTo(16.6667, 3);
  });

  test("crypto e oro hanno il target sul patrimonio; l'oro conta ETF + fisico", () => {
    const b = portfolioBreakdown(REAL);
    const btc = b.categories.find((c) => c.name === "Crypto").items[0];
    expect(btc.targetBase).toBe(TARGET_BASE.total);
    expect(btc.weight).toBeCloseTo(btc.pctTotal, 9);
    expect(btc.target).toBe(2);

    const oro = b.categories.find((c) => c.name === "Oro");
    expect(oro.items.map((p) => p.kind)).toEqual(["goldEtf", "physGold"]);
    const [etf, fisico] = oro.items;
    expect(etf.isin).toBe("IE00B4ND3602");
    expect(etf.value).toBeCloseTo(5012.5, 6);
    expect(fisico.value).toBe(1993.19);
    expect(fisico.quantity).toBe(10);
    expect(etf.pctCategory + fisico.pctCategory).toBeCloseTo(100, 9);
    // Il peso confrontato col target è quello della UI: (ETF + fisico) / patrimonio.
    expect(etf.weight).toBeCloseTo(oro.pct, 9);
    expect(etf.target).toBe(10);
    expect(etf.targetBase).toBe(TARGET_BASE.gold);
    expect(fisico.target).toBeNull();
  });

  test("nel patrimonio solo le startup attive; P&L solo dove c'è una valutazione", () => {
    const b = portfolioBreakdown(REAL);
    const su = b.categories.find((c) => c.name === "Startup");
    expect(su.items.map((p) => p.name)).toEqual(["Alfa", "Beta"]);
    expect(su.items[0].value).toBe(3000);
    expect(su.items[0].pnl).toBeNull();         // al costo: niente P&L inventato
    expect(su.items[1].value).toBe(1500);
    expect(su.items[1].pnl).toBe(480);          // 1500 − (1000 + 20)
    expect(su.items[0].target).toBeNull();
    // La fallita resta nel riepilogo startup per il foglio dedicato.
    expect(b.startups.closed.map((s) => s.name)).toEqual(["Gamma"]);
  });

  test("target ETF che non sommano a 100 sono normalizzati come nel ribilanciamento", () => {
    const b = portfolioBreakdown({
      assets: [
        { name: "A", quantity: 6, lastPrice: 100, targetWeight: 48, assetClass: "ETF" },
        { name: "B", quantity: 4, lastPrice: 100, targetWeight: 32, assetClass: "ETF" },
      ],
    });
    expect(b.etfTargetSum).toBe(80);
    const [a, bb] = b.categories[0].items;
    expect([a.target, bb.target]).toEqual([60, 40]);
    // Posizioni esattamente 60/40: a target, nessuno scostamento.
    expect(a.drift).toBeCloseTo(0, 9);
    expect(bb.drift).toBeCloseTo(0, 9);
  });

  test("ETF oro col target sul sotto-portafoglio ETF: il fisico resta fuori dalla base", () => {
    const b = portfolioBreakdown({
      assets: [{ name: "Globale", quantity: 90, lastPrice: 100, targetWeight: 90, assetClass: "ETF" }],
      goldEtf: { name: "Oro ETF", identifier: "IE00B4ND3602", quantity: 10, lastPrice: 100,
                 targetWeight: 10, assetClass: "Oro", targetOnTotal: false },
      physGold: { grams: 100, pricePerGram18kt: 50 },
      totalCash: 5000,
    });
    expect(b.goldOnTotal).toBe(false);
    expect(b.etfSubTotal).toBe(10000);
    const [etfOro] = b.categories.find((c) => c.name === "Oro").items;
    expect(etfOro.weight).toBeCloseTo(10, 9);
    expect(etfOro.target).toBe(10);
    expect(etfOro.targetBase).toBe(TARGET_BASE.etf);
    const globale = b.categories.find((c) => c.name === "ETF").items[0];
    expect(globale.weight).toBeCloseTo(90, 9);     // 9000 / 10000, non sul patrimonio
  });

  test("esporta anche gli asset a zero, senza alterare l'ordine delle categorie", () => {
    const b = portfolioBreakdown({
      assets: [
        { name: "Tracker", quantity: 0, lastPrice: 50, assetClass: "Bond" },
        { name: "Senza prezzo", quantity: 3, lastPrice: null, assetClass: "ETF" },
        { name: "Globale", quantity: 1, lastPrice: 100, assetClass: "ETF" },
      ],
    });
    expect(b.categories.map((c) => c.name)).toEqual(["ETF", "Bond"]);
    expect(b.categories[0].items.map((p) => p.name)).toEqual(["Senza prezzo", "Globale"]);
    expect(b.categories[1].value).toBe(0);
    expect(b.categories[1].items[0].pctCategory).toBeNull();   // 0 su 0 non è 0%
  });

  test("portafoglio vuoto: nessuna categoria e nessuna percentuale inventata", () => {
    const b = portfolioBreakdown({});
    expect(b.grandTotal).toBe(0);
    expect(b.categories).toEqual([]);
  });

  test("la liquidità negativa resta, altrimenti le categorie non sommano al totale", () => {
    const b = portfolioBreakdown({
      assets: [{ name: "Globale", quantity: 10, lastPrice: 100, assetClass: "ETF" }],
      totalCash: -200,
    });
    expect(b.grandTotal).toBe(800);
    expect(b.categories.map((c) => c.pct)).toEqual([125, -25]);
  });
});
