import {
  r2, isTotalTargetAsset, calcRebalancing, calcRebalancingTwoLevel,
  calcGrowthAttribution, calcStartupMetrics, calcStartupPortfolio,
} from "./rebalance";

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
