import {
  r2, isTotalTargetAsset, calcRebalancing, calcRebalancingTwoLevel,
  calcGrowthAttribution,
} from "./rebalance";

test("Bitcoin (Crypto) è un asset a target sul patrimonio totale", () => {
  expect(isTotalTargetAsset({ assetClass: "Crypto" })).toBe(true);
  expect(isTotalTargetAsset({ assetClass: "ETF" })).toBe(false);
  expect(isTotalTargetAsset({ assetClass: "ETF", targetOnTotal: true })).toBe(true);
  expect(isTotalTargetAsset({ assetClass: "Crypto", targetOnTotal: false })).toBe(false);
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
