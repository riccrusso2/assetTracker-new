import {
  r2, isTotalTargetAsset, calcRebalancing, calcRebalancingTwoLevel,
  calcGrowthAttribution, calcStartupMetrics, calcStartupPortfolio,
  calcDrift, driftThreshold, DRIFT_ALERT_PP,
  startupCashFlows, startupHoldings, calcConcentration,
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
  // L'oro è sottopesato: prima copre il gap (450), poi il resto va pro-quota.
  expect(byId.g.monthlyBuy).toBe(505);
  expect(byId.w.monthlyBuy).toBe(495);
  expect(r2(byId.g.monthlyBuy + byId.w.monthlyBuy)).toBe(1_000);
  // Dopo l'acquisto il peso dell'oro sale dal 5,3% al 9,6%, verso il 10%.
  const goldAfter = (500 + byId.g.monthlyBuy) / (9_500 + 1_000) * 100;
  expect(goldAfter).toBeCloseTo(9.57, 2);
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

test("attribuzione crescita: versamenti vs mercato", () => {
  const snaps = [
    { label: "Gen", assets: [{ id: "a", quantity: 10, price: 100, value: 1000 }] },
    // +5 quote a 110 → versamento 550; mercato: 10 quote × (110−100) = 100
    { label: "Feb", assets: [{ id: "a", quantity: 15, price: 110, value: 1650 }] },
  ];
  const rows = calcGrowthAttribution(snaps);
  expect(rows).toHaveLength(1);
  expect(rows[0].contrib).toBe(550);
  expect(rows[0].market).toBe(100);
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
test("con la banda attiva un asset quasi a target non riceve nulla", () => {
  // "a" è sotto di 1 punto, "b" di 10: con banda 5 tutto il budget va a "b".
  const assets = [
    { name: "a", targetWeight: 50, lastPrice: 100, quantity: 49 },   // 4.900 → 49%
    { name: "b", targetWeight: 50, lastPrice: 100, quantity: 40 },   // 4.000 → 40%
  ];
  const { actions } = calcRebalancing(assets, 8900, 1000, 5);
  expect(actions[0].monthlyBuy).toBe(0);
  expect(actions[1].monthlyBuy).toBe(1000);
  expect(actions[0].inBand).toBe(true);
  expect(actions[1].inBand).toBe(false);
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
