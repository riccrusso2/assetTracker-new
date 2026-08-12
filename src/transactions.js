// Registro movimenti — puro, testabile in Jest.
//
// Prima di questo modulo la posizione era uno stato inserito a mano (quantità +
// prezzo medio di carico): da lì non si ricava né il P&L realizzato di una
// vendita né il rendimento ponderato per i flussi. Qui la posizione diventa la
// somma dei movimenti, e i movimenti sono anche i flussi di cassa per l'XIRR.
//
// Retrocompatibile: un asset senza movimenti continua a valere quello che dicono
// i suoi campi (vedi holdingFor). Il registro si adotta un asset alla volta.

import { r2, snapKey } from "./rebalance";

// deposit/withdraw non ci sono: la liquidità è un totale gestito a mano
// (totalCash) e non entra in nessun calcolo di questo modulo.
export const TX_TYPES = ["buy", "sell", "dividend"];

export const TX_LABELS = {
  buy:      "Acquisto",
  sell:     "Vendita",
  dividend: "Dividendo",
};

// Identità dell'asset a cui il movimento appartiene: la stessa chiave degli
// snapshot, non l'id. Rinominare un asset stacca i suoi movimenti — è il
// compromesso già accettato per lo storico (vedi snapKey in rebalance.js).
export const txKey = snapKey;

const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
const num = (v) => Number(v) || 0;

// Flusso di cassa dal punto di vista del portafoglio: negativo = esborso.
export const txCashFlow = (tx) => {
  const gross = num(tx.quantity) * num(tx.price);
  const fee   = num(tx.fee);
  if (tx.type === "buy")      return r2(-(gross + fee));
  if (tx.type === "sell")     return r2(gross - fee);
  if (tx.type === "dividend") return r2(num(tx.amount) - fee);
  return 0;
};

// Posizione e risultati a partire dai soli movimenti di UN asset.
// Costo medio ponderato (PMC), coerente con ciò che la dashboard ha sempre
// mostrato.
// ponytail: il regime amministrato italiano calcola le plusvalenze in LIFO, non
// a costo medio. Finché il dato serve solo a mostrare il risultato la
// differenza non conta; quando arriverà src/tax.js servirà tenere i lotti.
export const deriveHolding = (txs) => {
  let quantity = 0, cost = 0, realized = 0, income = 0, fees = 0;

  for (const tx of [...(txs || [])].sort(byDate)) {
    const q = num(tx.quantity), p = num(tx.price), fee = num(tx.fee);
    fees += fee;

    if (tx.type === "buy") {
      quantity += q;
      cost     += q * p + fee;
    } else if (tx.type === "sell") {
      // Non si vende più di quanto si possiede: senza il clamp una vendita
      // eccedente renderebbe negativi quantità e costo, e da lì ogni derivato.
      const sold = Math.min(q, quantity);
      const avg  = quantity > 0 ? cost / quantity : 0;
      realized += sold * p - fee - avg * sold;
      cost     -= avg * sold;
      quantity -= sold;
    } else if (tx.type === "dividend") {
      income += num(tx.amount) - fee;
    }
  }

  return {
    quantity,                                          // non arrotondata: le quote hanno 6 decimali
    cost:      r2(cost),
    // Nemmeno il PMC si arrotonda: con quantità frazionarie un prezzo medio a
    // due decimali non ricostruisce più il costo (≈1 € su 30k) e la
    // performance a schermo ne risente. La formattazione è compito della UI.
    costBasis: quantity > 0 ? cost / quantity : 0,
    realized:  r2(realized),
    income:    r2(income),
    fees:      r2(fees),
  };
};

export const groupByAsset = (txs) => {
  const map = {};
  for (const tx of txs || []) (map[tx.assetKey] ??= []).push(tx);
  return map;
};

// La posizione di un asset: i movimenti se ci sono, altrimenti i campi inseriti
// a mano. `fromTx` dice quale delle due, così la UI sa se quantità e PMC sono
// ancora modificabili.
export const holdingFor = (asset, txs) => {
  const own = (txs || []).filter((t) => t.assetKey === txKey(asset));
  if (!own.length) {
    return {
      quantity: asset.quantity || 0, cost: r2((asset.quantity || 0) * (asset.costBasis || 0)),
      costBasis: asset.costBasis || 0,
      realized: 0, income: 0, fees: 0, fromTx: false,
    };
  }
  return { ...deriveHolding(own), fromTx: true };
};

// Totali di portafoglio sui soli movimenti (gli asset senza restano fuori:
// non hanno un realizzato da sommare).
export const portfolioRealized = (txs) => {
  const rows = Object.values(groupByAsset(txs)).map(deriveHolding);
  return {
    realized: r2(rows.reduce((a, h) => a + h.realized, 0)),
    income:   r2(rows.reduce((a, h) => a + h.income, 0)),
    fees:     r2(rows.reduce((a, h) => a + h.fees, 0)),
  };
};

// Flussi per l'XIRR: ogni movimento più il valore attuale come incasso finale
// (la posizione che si potrebbe liquidare oggi).
export const portfolioCashFlows = (txs, currentValue, asOf) => {
  const flows = [...(txs || [])]
    .sort(byDate)
    .map((tx) => ({ date: tx.date, amount: txCashFlow(tx) }))
    .filter((f) => f.date && f.amount !== 0);
  if (currentValue > 0) flows.push({ date: asOf, amount: r2(currentValue) });
  return flows;
};

const npv = (flows, rate) =>
  flows.reduce((acc, f) => acc + f.amount / Math.pow(1 + rate, f.years), 0);

// Tasso interno di rendimento su flussi a date irregolari: il rendimento
// annualizzato dell'investitore, che a differenza del CAGR sul patrimonio tiene
// conto di quando è entrato ogni euro.
// ponytail: bisezione su [-99,99%, +1000%]. Newton converge in meno passi ma
// diverge sui flussi con più cambi di segno; qui i flussi sono poche decine e
// 200 dimezzamenti costano nulla.
export const xirr = (flows) => {
  if (!flows || flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  const t0 = new Date(flows[0].date).getTime();
  if (Number.isNaN(t0)) return null;
  const fs = flows.map((f) => ({
    amount: f.amount,
    years: (new Date(f.date).getTime() - t0) / (365.25 * 864e5),
  }));
  if (fs.some((f) => Number.isNaN(f.years))) return null;

  let lo = -0.9999, hi = 10;
  const flo = npv(fs, lo);
  if (flo * npv(fs, hi) > 0) return null;   // nessuna radice nell'intervallo

  let sLo = Math.sign(flo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm  = npv(fs, mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (sLo * Math.sign(fm) < 0) hi = mid;
    else { lo = mid; sLo = Math.sign(fm); }
  }
  return (lo + hi) / 2;
};
