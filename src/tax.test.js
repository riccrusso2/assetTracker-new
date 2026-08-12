import {
  DEFAULT_TAX, taxCategory, taxRateFor, realizedLots, taxReport,
  bolloTitoli, latentTax,
} from "./tax";

const buy  = (date, quantity, price, fee = 0, assetKey = "a") =>
  ({ date, type: "buy", quantity, price, fee, assetKey });
const sell = (date, quantity, price, fee = 0, assetKey = "a") =>
  ({ date, type: "sell", quantity, price, fee, assetKey });

// ====================== LIFO ======================

test("le plusvalenze si calcolano in LIFO, non a costo medio", () => {
  // Due lotti: 10 a 100, 10 a 200. Vendendone 10 a 250:
  //   LIFO       → costo 200 → plus 500
  //   costo medio→ costo 150 → plus 1000
  // Il regime amministrato italiano usa il primo.
  const sales = realizedLots([buy("2026-01-10", 10, 100), buy("2026-02-10", 10, 200),
                              sell("2026-06-10", 10, 250)]);
  expect(sales).toHaveLength(1);
  expect(sales[0].cost).toBe(2000);
  expect(sales[0].gain).toBe(500);
});

test("la commissione d'acquisto entra nel costo del lotto, quella di vendita riduce l'incasso", () => {
  const [s] = realizedLots([buy("2026-01-10", 10, 100, 10), sell("2026-06-10", 10, 150, 5)]);
  expect(s.cost).toBe(1010);
  expect(s.proceeds).toBe(1495);
  expect(s.gain).toBe(485);
});

test("una vendita che attraversa più lotti li consuma dal più recente", () => {
  const [s] = realizedLots([buy("2026-01-10", 10, 100), buy("2026-02-10", 5, 200),
                            sell("2026-06-10", 10, 300)]);
  // 5 dal lotto a 200 + 5 da quello a 100 = 1500
  expect(s.cost).toBe(1500);
  expect(s.gain).toBe(1500);
});

test("non si vende più di quanto si possiede", () => {
  const [s] = realizedLots([buy("2026-01-10", 5, 100), sell("2026-06-10", 8, 150)]);
  expect(s.quantity).toBe(5);
  expect(s.gain).toBe(250);
});

test("senza vendite non c'è nulla da tassare", () => {
  expect(realizedLots([buy("2026-01-10", 10, 100)])).toEqual([]);
  expect(realizedLots([])).toEqual([]);
  expect(taxReport([]).years).toEqual([]);
});

// ====================== categorie ======================

test("gli ETF producono redditi di capitale, il resto redditi diversi", () => {
  expect(taxCategory({ assetClass: "ETF" })).toBe("capital");
  expect(taxCategory({ assetClass: "Azione" })).toBe("diverse");
  expect(taxCategory({ assetClass: "Crypto" })).toBe("diverse");
  expect(taxCategory({ assetClass: "Oro" })).toBe("diverse");
  expect(taxCategory({ assetClass: "ETF", taxCategory: "diverse" })).toBe("diverse");
  expect(taxCategory(undefined)).toBe("diverse");
});

test("i titoli di Stato scontano il 12,5%", () => {
  expect(taxRateFor({ taxClass: "bonds" })).toBeCloseTo(0.125, 6);
  expect(taxRateFor({ assetClass: "ETF" })).toBeCloseTo(0.26, 6);
});

// ====================== la regola che conta ======================

test("una minusvalenza su ETF non compensa una plusvalenza su ETF", () => {
  // Il caso che rende il modulo necessario: +1000 e −1000 nello stesso anno,
  // sugli stessi strumenti, e si paga comunque 260 € di imposta.
  const txs = [
    buy("2026-01-10", 10, 100, 0, "etf-a"), sell("2026-06-10", 10, 200, 0, "etf-a"),  // +1000
    buy("2026-01-10", 10, 200, 0, "etf-b"), sell("2026-06-10", 10, 100, 0, "etf-b"),  // −1000
  ];
  const meta = { "etf-a": { assetClass: "ETF" }, "etf-b": { assetClass: "ETF" } };
  const rep = taxReport(txs, meta);

  expect(rep.years[0].capitalGains).toBe(1000);
  expect(rep.years[0].taxable).toBe(1000);
  expect(rep.totalTax).toBe(260);
  // La minusvalenza non è persa: resta spendibile su futuri redditi diversi.
  expect(rep.pool).toEqual([{ year: 2026, amount: 1000, expiresAfter: 2030 }]);
});

test("su azioni invece plusvalenze e minusvalenze si compensano nello stesso anno", () => {
  const txs = [
    buy("2026-01-10", 10, 100, 0, "az-a"), sell("2026-06-10", 10, 200, 0, "az-a"),  // +1000
    buy("2026-01-10", 10, 200, 0, "az-b"), sell("2026-06-10", 10, 100, 0, "az-b"),  // −1000
  ];
  const meta = { "az-a": { assetClass: "Azione" }, "az-b": { assetClass: "Azione" } };
  const rep = taxReport(txs, meta);
  expect(rep.years[0].taxable).toBe(0);
  expect(rep.totalTax).toBe(0);
  expect(rep.pool).toEqual([]);
});

// ====================== zainetto ======================

test("la minusvalenza di un anno compensa la plusvalenza di un anno successivo", () => {
  const txs = [
    buy("2024-01-10", 10, 200, 0, "az"), sell("2024-06-10", 10, 100, 0, "az"),   // −1000 nel 2024
    buy("2026-01-10", 10, 100, 0, "az"), sell("2026-06-10", 10, 180, 0, "az"),   // +800 nel 2026
  ];
  const rep = taxReport(txs, { az: { assetClass: "Azione" } });
  expect(rep.years.map((y) => y.year)).toEqual([2024, 2026]);
  expect(rep.years[1].offset).toBe(800);
  expect(rep.years[1].taxable).toBe(0);
  expect(rep.pool[0].amount).toBe(200);      // residuo ancora spendibile
});

test("oltre il quarto anno successivo la minusvalenza è persa", () => {
  const txs = [
    buy("2020-01-10", 10, 200, 0, "az"), sell("2020-06-10", 10, 100, 0, "az"),   // −1000 nel 2020
    buy("2026-01-10", 10, 100, 0, "az"), sell("2026-06-10", 10, 200, 0, "az"),   // +1000 nel 2026
  ];
  const rep = taxReport(txs, { az: { assetClass: "Azione" } });
  const y2026 = rep.years.find((y) => y.year === 2026);
  expect(y2026.offset).toBe(0);
  expect(y2026.taxable).toBe(1000);
  expect(rep.pool).toEqual([]);              // quella del 2020 è uscita di scena
});

test("al limite dei quattro anni la minusvalenza è ancora spendibile", () => {
  const txs = [
    buy("2022-01-10", 10, 200, 0, "az"), sell("2022-06-10", 10, 100, 0, "az"),
    buy("2026-01-10", 10, 100, 0, "az"), sell("2026-06-10", 10, 200, 0, "az"),
  ];
  const rep = taxReport(txs, { az: { assetClass: "Azione" } });
  expect(rep.years.find((y) => y.year === 2026).taxable).toBe(0);
});

test("si consuma per prima la minusvalenza più vecchia, che è quella che scade prima", () => {
  const txs = [
    buy("2023-01-10", 10, 200, 0, "az"), sell("2023-06-10", 10, 150, 0, "az"),   // −500 (2023)
    buy("2024-01-10", 10, 200, 0, "az"), sell("2024-06-10", 10, 150, 0, "az"),   // −500 (2024)
    buy("2026-01-10", 10, 100, 0, "az"), sell("2026-06-10", 10, 150, 0, "az"),   // +500 (2026)
  ];
  const rep = taxReport(txs, { az: { assetClass: "Azione" } });
  expect(rep.pool).toEqual([{ year: 2024, amount: 500, expiresAfter: 2028 }]);
});

test("expiring dice quanto scade se non si realizza nulla", () => {
  const txs = [
    buy("2022-01-10", 10, 200, 0, "az"), sell("2022-06-10", 10, 100, 0, "az"),   // −1000 (2022)
    buy("2026-01-10", 10, 100, 0, "az"), sell("2026-06-10", 10, 100, 0, "az"),   // 0, apre il 2026
  ];
  const rep = taxReport(txs, { az: { assetClass: "Azione" } });
  expect(rep.expiring).toBe(1000);           // il 2022 scade dopo il 2026
});

// ====================== bollo e imposta latente ======================

test("il bollo titoli è lo 0,2% del controvalore", () => {
  expect(bolloTitoli(50000)).toBe(100);
  expect(bolloTitoli(0)).toBe(0);
  expect(bolloTitoli(50000, { ...DEFAULT_TAX, bollo: 0 })).toBe(0);
});

test("l'imposta latente conta i guadagni non realizzati e ignora le perdite non realizzate", () => {
  const { latentGain, latentTax: due } = latentTax([
    { value: 2000, cost: 1000, asset: { assetClass: "ETF" } },   // +1000 → 260
    { value: 500,  cost: 1000, asset: { assetClass: "ETF" } },   // −500  → nulla da pagare
  ]);
  expect(latentGain).toBe(500);
  expect(due).toBe(260);
});

test("nessuna posizione: nessuna imposta latente", () => {
  expect(latentTax([])).toEqual({ latentGain: 0, latentTax: 0 });
  expect(latentTax(undefined).latentTax).toBe(0);
});
