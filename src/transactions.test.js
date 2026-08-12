import {
  txCashFlow, deriveHolding, holdingFor, groupByAsset,
  portfolioRealized, portfolioCashFlows, xirr,
} from "./transactions";

const buy  = (date, quantity, price, fee = 0) => ({ date, type: "buy",  quantity, price, fee });
const sell = (date, quantity, price, fee = 0) => ({ date, type: "sell", quantity, price, fee });
const div  = (date, amount, fee = 0)          => ({ date, type: "dividend", amount, fee });

// ====================== deriveHolding ======================

test("acquisti: la commissione entra nel costo, quindi nel PMC", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100, 5)]);
  expect(h.quantity).toBe(10);
  expect(h.cost).toBe(1005);
  expect(h.costBasis).toBe(100.5);
  expect(h.realized).toBe(0);
});

test("più acquisti a prezzi diversi: PMC medio ponderato", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100), buy("2026-03-10", 10, 120)]);
  expect(h.quantity).toBe(20);
  expect(h.costBasis).toBe(110);
});

test("vendita parziale: realizza sul PMC e lascia il resto in posizione", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100), sell("2026-06-10", 4, 150)]);
  expect(h.quantity).toBe(6);
  expect(h.realized).toBe(200);      // 4 × (150 − 100)
  expect(h.cost).toBe(600);          // le 6 restanti sempre a 100
  expect(h.costBasis).toBe(100);     // vendere non muove il PMC
});

test("vendita totale: posizione azzerata, PMC a zero, realizzato completo", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100, 5), sell("2026-06-10", 10, 150, 5)]);
  expect(h.quantity).toBe(0);
  expect(h.cost).toBe(0);
  expect(h.costBasis).toBe(0);
  expect(h.realized).toBe(490);      // 1500 − 5 − 1005
});

test("vendita in perdita: realizzato negativo", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100), sell("2026-06-10", 10, 80)]);
  expect(h.realized).toBe(-200);
});

test("i movimenti si ordinano per data, non per posizione nell'array", () => {
  const disordinati = [sell("2026-06-10", 5, 150), buy("2026-01-10", 10, 100)];
  expect(deriveHolding(disordinati)).toEqual(deriveHolding([...disordinati].reverse()));
  expect(deriveHolding(disordinati).realized).toBe(250);
});

test("vendita superiore al posseduto: si vende solo ciò che c'è, niente quantità negative", () => {
  // Input sporco (import sbagliato, doppio inserimento): senza clamp la
  // quantità andrebbe sotto zero e da lì ogni valore derivato.
  const h = deriveHolding([buy("2026-01-10", 5, 100), sell("2026-06-10", 8, 120)]);
  expect(h.quantity).toBe(0);
  expect(h.cost).toBe(0);
  expect(h.realized).toBe(100);      // realizza solo sulle 5 possedute
});

test("dividendo: non tocca quantità né costo, alimenta income al netto delle spese", () => {
  const h = deriveHolding([buy("2026-01-10", 10, 100), div("2026-04-10", 50, 2)]);
  expect(h.quantity).toBe(10);
  expect(h.costBasis).toBe(100);
  expect(h.realized).toBe(0);
  expect(h.income).toBe(48);
});

test("registro vuoto o assente: posizione a zero, nessun crash", () => {
  expect(deriveHolding([]).quantity).toBe(0);
  expect(deriveHolding(undefined).costBasis).toBe(0);
});

test("le quantità frazionarie non vengono arrotondate", () => {
  const h = deriveHolding([buy("2026-01-10", 94.164474, 135.54)]);
  expect(h.quantity).toBe(94.164474);
});

// ====================== holdingFor ======================

test("asset senza movimenti: valgono i campi inseriti a mano", () => {
  const a = { name: "Globale", quantity: 10, costBasis: 100 };
  const h = holdingFor(a, []);
  expect(h.fromTx).toBe(false);
  expect(h.quantity).toBe(10);
  expect(h.costBasis).toBe(100);
  expect(h.cost).toBe(1000);
});

test("asset con movimenti: vincono i movimenti sui campi a mano", () => {
  const a = { name: "Globale", quantity: 999, costBasis: 1 };   // valore stantio
  const h = holdingFor(a, [{ ...buy("2026-01-10", 10, 100), assetKey: "globale" }]);
  expect(h.fromTx).toBe(true);
  expect(h.quantity).toBe(10);
  expect(h.costBasis).toBe(100);
});

test("i movimenti di un altro asset non contano", () => {
  const a = { name: "Globale", quantity: 7, costBasis: 50 };
  const h = holdingFor(a, [{ ...buy("2026-01-10", 10, 100), assetKey: "oro" }]);
  expect(h.fromTx).toBe(false);
  expect(h.quantity).toBe(7);
});

test("holdingFor usa snapKey: l'id non c'entra", () => {
  const a = { id: "xyz123", name: "MSCI World ETF", quantity: 0, costBasis: 0 };
  const h = holdingFor(a, [{ ...buy("2026-01-10", 3, 200), assetKey: "msci-world-etf" }]);
  expect(h.fromTx).toBe(true);
  expect(h.quantity).toBe(3);
});

// ====================== aggregati ======================

test("groupByAsset separa i movimenti per chiave", () => {
  const g = groupByAsset([
    { ...buy("2026-01-10", 1, 10), assetKey: "a" },
    { ...buy("2026-02-10", 2, 10), assetKey: "b" },
    { ...sell("2026-03-10", 1, 20), assetKey: "a" },
  ]);
  expect(Object.keys(g).sort()).toEqual(["a", "b"]);
  expect(g.a).toHaveLength(2);
});

test("portfolioRealized somma il realizzato di ogni asset, non li mescola", () => {
  // Mescolare i movimenti di due asset in un unico deriveHolding darebbe un PMC
  // senza senso: il totale deve nascere per asset e poi sommarsi.
  const txs = [
    { ...buy("2026-01-10", 10, 100), assetKey: "a" },
    { ...sell("2026-06-10", 10, 150), assetKey: "a" },   // +500
    { ...buy("2026-01-10", 10, 10), assetKey: "b" },
    { ...sell("2026-06-10", 10, 8), assetKey: "b" },     // −20
    { ...div("2026-04-10", 30), assetKey: "a" },
  ];
  const p = portfolioRealized(txs);
  expect(p.realized).toBe(480);
  expect(p.income).toBe(30);
});

// ====================== flussi e XIRR ======================

test("segno dei flussi: l'acquisto esce, vendita e dividendo entrano", () => {
  expect(txCashFlow(buy("2026-01-10", 10, 100, 5))).toBe(-1005);
  expect(txCashFlow(sell("2026-06-10", 10, 150, 5))).toBe(1495);
  expect(txCashFlow(div("2026-04-10", 50, 2))).toBe(48);
});

test("i flussi chiudono col valore attuale come incasso finale", () => {
  const flows = portfolioCashFlows(
    [{ ...buy("2026-01-10", 10, 100), assetKey: "a" }], 1500, "2026-08-12");
  expect(flows).toEqual([
    { date: "2026-01-10", amount: -1000 },
    { date: "2026-08-12", amount: 1500 },
  ]);
});

test("senza posizione residua i flussi sono i soli movimenti", () => {
  const flows = portfolioCashFlows([{ ...sell("2026-06-10", 10, 150), assetKey: "a" }], 0, "2026-08-12");
  expect(flows).toHaveLength(1);
});

test("XIRR: +10% su un anno esatto", () => {
  const r = xirr([
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 1100 },
  ]);
  expect(r).toBeCloseTo(0.1, 3);
});

test("XIRR: due versamenti a distanza di un anno", () => {
  // 1000 investiti per 2 anni + 1000 per 1 anno, valore finale 2310:
  // al 10% annuo 1000×1.21 + 1000×1.1 = 2310.
  const r = xirr([
    { date: "2024-01-01", amount: -1000 },
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 2310 },
  ]);
  expect(r).toBeCloseTo(0.1, 2);
});

test("XIRR distingue quando è entrato l'euro: stesso profitto, rendimento diverso", () => {
  // Stessi 2000 investiti e stessi 2200 finali, ma nel secondo caso metà del
  // capitale ha lavorato solo un anno → rendimento annualizzato più alto.
  const presto = xirr([
    { date: "2024-01-01", amount: -2000 },
    { date: "2026-01-01", amount: 2200 },
  ]);
  const tardi = xirr([
    { date: "2024-01-01", amount: -1000 },
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 2200 },
  ]);
  expect(tardi).toBeGreaterThan(presto);
});

test("XIRR: perdita → rendimento negativo", () => {
  const r = xirr([
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 800 },
  ]);
  expect(r).toBeLessThan(0);
  expect(r).toBeCloseTo(-0.2, 2);
});

test("XIRR non calcolabile: flussi tutti dello stesso segno, uno solo, o nessuno", () => {
  expect(xirr([])).toBeNull();
  expect(xirr([{ date: "2026-01-01", amount: -1000 }])).toBeNull();
  expect(xirr([
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: -500 },
  ])).toBeNull();
});

test("XIRR con data non valida non esplode", () => {
  expect(xirr([
    { date: "non-una-data", amount: -1000 },
    { date: "2026-01-01", amount: 1100 },
  ])).toBeNull();
});

test("XIRR su una perdita quasi totale resta dentro l'intervallo di ricerca", () => {
  const r = xirr([
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 1 },
  ]);
  expect(r).toBeLessThan(-0.9);
  expect(Number.isFinite(r)).toBe(true);
});
