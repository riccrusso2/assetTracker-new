import {
  calcReturns, calcCAGR, calcVolatility, calcMaxDrawdown, calcSharpe, calcSortino,
  riskQuality, buildHistory, drawdownSeries, allocationOverTime,
  contributionByAsset, monthlyReturnsGrid, benchmarkSeries,
  MIN_OBS_RATIO,
} from "./metrics";

const pos = (name, price, quantity, id = name) => ({ id, name, price, quantity, value: price * quantity });
const snap = (label, year, month, totalValue, assets = []) => ({ label, year, month, totalValue, assets });

// Serie di n mesi che cresce di `rate` al mese, senza versamenti.
const grow = (n, rate) => {
  const out = [];
  let v = 1000;
  for (let i = 0; i < n; i++) {
    out.push(snap(`M${i}`, 2024 + Math.floor(i / 12), (i % 12) + 1, v, [pos("etf", v / 10, 10)]));
    v *= 1 + rate;
  }
  return out;
};

// ====================== rendimenti ======================

test("i versamenti non contano come guadagno", () => {
  // Da 1000 a 2000 mettendoci 900 di tasca: il rendimento è +10%, non +100%.
  const r = calcReturns([{ t: "2026-01-01", v: 1000, cf: 0 }, { t: "2026-02-01", v: 2000, cf: 900 }]);
  expect(r).toEqual([0.1]);
});

test("un mese partito da valore zero viene saltato invece di dividere per zero", () => {
  const r = calcReturns([{ t: "2026-01-01", v: 0, cf: 0 }, { t: "2026-02-01", v: 500, cf: 500 }]);
  expect(r).toEqual([]);
});

test("buildHistory identifica gli asset per nome: cancellare e riaggiungere non falsa i flussi", () => {
  // Stesso asset, stesse quantità, id diverso al secondo mese (cancellato e
  // riaggiunto). Con la chiave sull'id il flusso esterno risulterebbe pari
  // all'intera posizione e il rendimento sparirebbe.
  const hist = buildHistory([
    snap("Gen", 2026, 1, 1000, [pos("Globale", 100, 10, "vecchio-id")]),
    snap("Feb", 2026, 2, 1100, [pos("Globale", 110, 10, "nuovo-id")]),
  ]);
  expect(hist[1].cf).toBe(0);
  expect(calcReturns(hist)).toEqual([0.1]);
});

test("CAGR annualizza la crescita nel tempo effettivamente trascorso", () => {
  const hist = [{ t: "2024-01-01", v: 1000, cf: 0 }, { t: "2025-01-01", v: 1100, cf: 0 },
                { t: "2026-01-01", v: 1210, cf: 0 }];
  expect(calcCAGR(hist)).toBeCloseTo(0.1, 3);
});

test("CAGR non calcolabile con un solo punto o con storia a durata zero", () => {
  expect(calcCAGR([{ t: "2026-01-01", v: 1000 }])).toBeNull();
  expect(calcCAGR([{ t: "2026-01-01", v: 1000 }, { t: "2026-01-01", v: 1100 }])).toBeNull();
});

test("max drawdown misura la buca più profonda, non l'ultima", () => {
  const hist = [
    { t: "2026-01-01", v: 1000, cf: 0 },
    { t: "2026-02-01", v: 1200, cf: 0 },
    { t: "2026-03-01", v: 600,  cf: 0 },   // −50% dal picco
    { t: "2026-04-01", v: 1000, cf: 0 },
  ];
  expect(calcMaxDrawdown(hist)).toBeCloseTo(-0.5, 3);
});

// ====================== soglie di attendibilità ======================

test("volatilità, Sharpe e Sortino tacciono sotto le 12 osservazioni", () => {
  const corta = grow(6, 0.01);      // 5 rendimenti
  expect(calcVolatility(buildHistory(corta))).toBeNull();
  expect(calcSharpe(buildHistory(corta))).toBeNull();
  expect(calcSortino(buildHistory(corta))).toBeNull();
  // …ma le metriche di andamento restano disponibili.
  expect(calcCAGR(buildHistory(corta))).not.toBeNull();
  expect(calcMaxDrawdown(buildHistory(corta))).not.toBeNull();
});

test("con storia sufficiente la volatilità si calcola", () => {
  const lunga = grow(MIN_OBS_RATIO + 2, 0.01);
  expect(calcVolatility(buildHistory(lunga))).not.toBeNull();
});

test("Sortino è nullo senza mesi negativi: non esiste rischio di ribasso da misurare", () => {
  expect(calcSortino(buildHistory(grow(20, 0.01)))).toBeNull();
});

test("riskQuality segnala quanto ci si può fidare del campione", () => {
  expect(riskQuality(5)).toBe("insufficiente");
  expect(riskQuality(18)).toBe("indicativo");
  expect(riskQuality(36)).toBe("solido");
});

// ====================== serie per i grafici ======================

test("la curva di drawdown resta a zero finché si sale e scende dopo il picco", () => {
  const snaps = [
    snap("Gen", 2026, 1, 1000, [pos("etf", 100, 10)]),
    snap("Feb", 2026, 2, 1200, [pos("etf", 120, 10)]),
    snap("Mar", 2026, 3, 900,  [pos("etf", 90, 10)]),
  ];
  const dd = drawdownSeries(snaps);
  expect(dd).toHaveLength(2);
  expect(dd[0]).toEqual({ label: "Feb", dd: 0 });
  expect(dd[1].dd).toBeCloseTo(-25, 1);
});

test("l'allocazione nel tempo è in percentuale e somma 100", () => {
  const rows = allocationOverTime([
    snap("Gen", 2026, 1, 1000, [pos("a", 60, 10), pos("b", 40, 10)]),
  ]);
  expect(rows[0].a + rows[0].b).toBeCloseTo(100, 6);
});

test("il contributo per asset separa il mercato dai versamenti e ordina per euro prodotti", () => {
  // "a" raddoppia il valore solo perché ci è stato versato dentro: non ha
  // prodotto nulla. "b" è cresciuto di prezzo.
  const rows = contributionByAsset([
    snap("Gen", 2026, 1, 2000, [pos("a", 100, 10), pos("b", 100, 10)]),
    snap("Feb", 2026, 2, 3200, [pos("a", 100, 20), pos("b", 120, 10)]),
  ]);
  expect(rows[0]).toEqual({ key: "b", gain: 200 });
  expect(rows[1]).toEqual({ key: "a", gain: 0 });
});

test("il contributo per asset richiede almeno due snapshot", () => {
  expect(contributionByAsset([snap("Gen", 2026, 1, 1000, [pos("a", 100, 10)])])).toEqual([]);
});

test("la griglia dei rendimenti raggruppa per anno e mese", () => {
  const snaps = [
    snap("Dic", 2025, 12, 1000, [pos("etf", 100, 10)]),
    snap("Gen", 2026, 1, 1100, [pos("etf", 110, 10)]),
    snap("Feb", 2026, 2, 1210, [pos("etf", 121, 10)]),
  ];
  const grid = monthlyReturnsGrid(snaps);
  expect(grid).toHaveLength(1);
  expect(grid[0].year).toBe(2026);
  expect(grid[0].months[1]).toBeCloseTo(10, 1);
  expect(grid[0].months[2]).toBeCloseTo(10, 1);
});

// Regressione: un mese a zero non produce rendimento (si dividerebbe per zero),
// quindi la serie dei rendimenti è più corta di quella degli snapshot. Chi
// indicizzava `snapshots[i + 1]` attribuiva ogni rendimento al mese sbagliato.
test("uno snapshot a zero non sposta le etichette dei mesi successivi", () => {
  const snaps = [
    snap("Gen", 2026, 1, 0,    []),
    snap("Feb", 2026, 2, 1000, [pos("etf", 100, 10)]),
    snap("Mar", 2026, 3, 1100, [pos("etf", 110, 10)]),
  ];
  const grid = monthlyReturnsGrid(snaps);
  expect(grid[0].months[3]).toBeCloseTo(10, 1);   // il +10% è di marzo
  expect(grid[0].months[2]).toBeUndefined();      // febbraio non ha un mese prima
  expect(drawdownSeries(snaps).map((d) => d.label)).toEqual(["Mar"]);
  expect(benchmarkSeries(snaps, "etf")).toEqual([]);  // niente prezzo base a gennaio
});

// ====================== benchmark ======================

test("benchmark: patrimonio e riferimento partono entrambi da 100", () => {
  const snaps = [
    snap("Gen", 2026, 1, 1000, [pos("Globale", 100, 10)]),
    snap("Feb", 2026, 2, 1100, [pos("Globale", 110, 10)]),
  ];
  const s = benchmarkSeries(snaps, "globale");
  expect(s[0]).toEqual({ label: "Gen", portfolio: 100, benchmark: 100 });
  expect(s[1].portfolio).toBeCloseTo(110, 1);
  expect(s[1].benchmark).toBeCloseTo(110, 1);
});

test("benchmark: un versamento alza il patrimonio ma non il confronto", () => {
  // Prezzo fermo, quantità raddoppiata: il patrimonio cresce, il rendimento no.
  // È il senso del confronto — misura la bravura, non il risparmio.
  const snaps = [
    snap("Gen", 2026, 1, 1000, [pos("Globale", 100, 10)]),
    snap("Feb", 2026, 2, 2000, [pos("Globale", 100, 20)]),
  ];
  const s = benchmarkSeries(snaps, "globale");
  expect(s[1].portfolio).toBeCloseTo(100, 6);
  expect(s[1].benchmark).toBeCloseTo(100, 6);
});

test("benchmark assente o senza prezzo iniziale: nessuna serie invece di una sbagliata", () => {
  const snaps = [
    snap("Gen", 2026, 1, 1000, [pos("Globale", 100, 10)]),
    snap("Feb", 2026, 2, 1100, [pos("Globale", 110, 10)]),
  ];
  expect(benchmarkSeries(snaps, "inesistente")).toEqual([]);
  expect(benchmarkSeries(snaps, null)).toEqual([]);
  expect(benchmarkSeries([], "globale")).toEqual([]);
});

test("benchmark: un mese in cui il riferimento manca resta un buco, non uno zero", () => {
  const snaps = [
    snap("Gen", 2026, 1, 1000, [pos("Globale", 100, 10)]),
    snap("Feb", 2026, 2, 1100, [pos("Altro", 50, 22)]),
  ];
  expect(benchmarkSeries(snaps, "globale")[1].benchmark).toBeNull();
});

// ====================== proiezione ======================
import { projectionScenarios, depletionYear } from "./metrics";

test("proiezione: senza rendimento il capitale cresce solo dei versamenti", () => {
  const d = projectionScenarios({ start: 1000, monthly: 100, baseReturn: 0, years: 1 });
  expect(d.at(-1).base).toBe(2200);   // 1000 + 12 × 100
});

test("proiezione: la banda pessimistico-ottimistico contiene lo scenario base", () => {
  const d = projectionScenarios({ start: 10000, monthly: 500, baseReturn: 7, years: 10 });
  const last = d.at(-1);
  expect(last.pessimistic).toBeLessThan(last.base);
  expect(last.optimistic).toBeGreaterThan(last.base);
});

test("proiezione: il valore reale sconta l'inflazione e col 2% è nettamente sotto il nominale", () => {
  const d = projectionScenarios({ start: 10000, monthly: 0, baseReturn: 7, years: 20, inflation: 2 });
  const last = d.at(-1);
  expect(last.real).toBeLessThan(last.base);
  // 20 anni al 2%: circa un terzo di potere d'acquisto in meno.
  expect(last.real / last.base).toBeCloseTo(1 / Math.pow(1.02 / 1, 20), 1);
});

test("proiezione: senza inflazione nominale e reale coincidono", () => {
  const d = projectionScenarios({ start: 5000, monthly: 100, baseReturn: 5, years: 5 });
  expect(d.at(-1).real).toBe(d.at(-1).base);
});

test("proiezione: dopo l'inizio dei prelievi si smette di versare e il capitale cala", () => {
  const d = projectionScenarios({
    start: 100000, monthly: 1000, baseReturn: 0, years: 4,
    withdrawAfter: 2, withdrawMonthly: 2000,
  });
  expect(d[2].base).toBe(124000);            // 2 anni di versamenti
  expect(d[4].base).toBe(76000);             // 2 anni di prelievi
});

test("proiezione: il capitale si esaurisce a zero, non va in negativo", () => {
  const d = projectionScenarios({
    start: 10000, monthly: 0, baseReturn: 0, years: 5,
    withdrawAfter: 0, withdrawMonthly: 1000,
  });
  expect(d.at(-1).base).toBe(0);
  expect(Math.min(...d.map((x) => x.base))).toBe(0);
  expect(depletionYear(d)).toBe(1);
});

test("proiezione: senza prelievi il capitale non si esaurisce mai", () => {
  const d = projectionScenarios({ start: 1000, monthly: 100, baseReturn: 5, years: 10 });
  expect(depletionYear(d)).toBeNull();
});

test("proiezione a zero anni: solo il punto di partenza", () => {
  const d = projectionScenarios({ start: 1000, monthly: 100, baseReturn: 7, years: 0 });
  expect(d).toEqual([{ year: 0, base: 1000, pessimistic: 1000, optimistic: 1000, real: 1000 }]);
});
