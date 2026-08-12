// Fiscalità italiana sui movimenti — pura, testabile in Jest.
//
// Il punto che rende questo modulo necessario e non un dettaglio: in Italia le
// plusvalenze da ETF armonizzati sono "redditi di capitale" e le minusvalenze
// da ETF sono "redditi diversi". Due categorie che non si compensano tra loro:
// si può chiudere l'anno con un guadagno e una perdita di pari importo sullo
// stesso ETF e pagare comunque l'imposta piena sul guadagno. Un conto che
// sommasse guadagni e perdite darebbe un numero sbagliato per difetto.
//
// ponytail: si modella ciò che serve al regime amministrato di un investitore
// retail (ETF, azioni, ETC, crypto). Fuori restano dividendi esteri con
// credito d'imposta, ETF non armonizzati e regime dichiarativo.

import { r2 } from "./rebalance";

export const DEFAULT_TAX = {
  rate: 26,            // aliquota ordinaria su capital gain
  rateBonds: 12.5,     // titoli di Stato ed equiparati (white list)
  bollo: 0.2,          // bollo titoli annuo sul controvalore
  lossYears: 4,        // anni di riporto delle minusvalenze oltre quello di realizzo
};

// "capital": redditi di capitale — la plusvalenza è tassata piena, la
//            minusvalenza finisce comunque nello zainetto (ETF armonizzati).
// "diverse": redditi diversi — plusvalenze e minusvalenze si compensano
//            (azioni, ETC/ETN sull'oro, certificati, crypto).
export const taxCategory = (asset) =>
  asset?.taxCategory ?? (asset?.assetClass === "ETF" ? "capital" : "diverse");

export const taxRateFor = (asset, tax = DEFAULT_TAX) =>
  (asset?.taxClass === "bonds" ? tax.rateBonds : tax.rate) / 100;

const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
const num = (v) => Number(v) || 0;
const yearOf = (d) => Number((d || "").slice(0, 4));

// Plusvalenze e minusvalenze realizzate lotto per lotto, in LIFO: è il criterio
// che gli intermediari italiani applicano in regime amministrato, e dà un
// risultato diverso dal costo medio usato altrove nella dashboard per mostrare
// la performance.
export const realizedLots = (txs) => {
  // Una coda di lotti per asset: mescolarle farebbe pagare la vendita di un
  // titolo col costo d'acquisto di un altro.
  const byAsset = {};
  const sales = [];

  for (const tx of [...(txs || [])].sort(byDate)) {
    const q = num(tx.quantity), p = num(tx.price), fee = num(tx.fee);
    const lots = (byAsset[tx.assetKey] ??= []);   // { quantity, unitCost }, si consuma dal fondo
    if (tx.type === "buy" && q > 0) {
      lots.push({ quantity: q, unitCost: p + fee / q });
    } else if (tx.type === "sell" && q > 0) {
      let left = q, cost = 0;
      while (left > 0 && lots.length) {
        const lot = lots[lots.length - 1];          // LIFO: l'ultimo comprato
        const take = Math.min(left, lot.quantity);
        cost += take * lot.unitCost;
        lot.quantity -= take;
        left -= take;
        if (lot.quantity <= 1e-9) lots.pop();
      }
      const sold = q - left;                         // niente vendite allo scoperto
      if (sold > 0) {
        sales.push({
          date: tx.date, year: yearOf(tx.date), assetKey: tx.assetKey,
          quantity: sold, proceeds: r2(sold * p - fee), cost: r2(cost),
          gain: r2(sold * p - fee - cost),
        });
      }
    }
  }
  return sales;
};

// Conto fiscale anno per anno, con lo zainetto delle minusvalenze che scorre.
// assetByKey serve solo a sapere la categoria di ogni strumento.
export const taxReport = (txs, assetByKey = {}, tax = DEFAULT_TAX) => {
  const sales = realizedLots(txs).map((s) => ({
    ...s,
    category: taxCategory(assetByKey[s.assetKey]),
    rate: taxRateFor(assetByKey[s.assetKey], tax),
  }));
  if (!sales.length) return { years: [], pool: [], expiring: 0, totalTax: 0, totalNet: 0 };

  const years = [...new Set(sales.map((s) => s.year))].sort((a, b) => a - b);
  let pool = [];        // { year, amount } minusvalenze ancora spendibili
  const rows = [];

  for (const year of years) {
    // Scadute: una minusvalenza si usa entro il quarto anno successivo a quello
    // in cui è stata realizzata.
    pool = pool.filter((l) => year - l.year <= tax.lossYears);

    const ofYear = sales.filter((s) => s.year === year);
    // ponytail: un'aliquota per anno. Se in uno stesso anno si mescolano titoli
    // di Stato al 12,5% e strumenti ordinari si applica il 26% a tutto — per
    // separarli servirebbe tenere due contabilità parallele, e i due mondi
    // hanno comunque regole di compensazione diverse.
    const rate = ofYear.every((s) => s.rate === ofYear[0].rate) ? ofYear[0].rate : tax.rate / 100;

    // Le minusvalenze finiscono tutte nello zainetto, da qualunque categoria
    // arrivino; le plusvalenze si compensano solo se sono redditi diversi.
    const losses     = ofYear.filter((s) => s.gain < 0);
    const gainsDiv   = ofYear.filter((s) => s.gain > 0 && s.category === "diverse");
    const gainsCap   = ofYear.filter((s) => s.gain > 0 && s.category === "capital");

    const lossTot    = r2(-losses.reduce((a, s) => a + s.gain, 0));
    const divTot     = r2(gainsDiv.reduce((a, s) => a + s.gain, 0));
    const capTot     = r2(gainsCap.reduce((a, s) => a + s.gain, 0));

    // Compensazione: prima le perdite dell'anno stesso, poi lo zainetto più
    // vecchio (che è quello che scade prima).
    let residualGain = divTot;
    let usedThisYear = Math.min(residualGain, lossTot);
    residualGain = r2(residualGain - usedThisYear);
    let carried = r2(lossTot - usedThisYear);

    let usedFromPool = 0;
    pool.sort((a, b) => a.year - b.year);
    for (const lot of pool) {
      if (residualGain <= 0) break;
      const take = Math.min(lot.amount, residualGain);
      lot.amount = r2(lot.amount - take);
      residualGain = r2(residualGain - take);
      usedFromPool = r2(usedFromPool + take);
    }
    pool = pool.filter((l) => l.amount > 0.005);
    if (carried > 0) pool.push({ year, amount: carried });

    const taxable = r2(capTot + residualGain);
    const taxDue  = r2(taxable * rate);

    rows.push({
      year,
      capitalGains: capTot,          // plusvalenze non compensabili (ETF)
      diverseGains: divTot,          // plusvalenze compensabili
      losses: lossTot,
      offset: r2(usedThisYear + usedFromPool),
      taxable, tax: taxDue,
      net: r2(capTot + divTot - lossTot - taxDue),
    });
  }

  const lastYear = years.at(-1);
  return {
    years: rows,
    pool: pool.map((l) => ({ ...l, expiresAfter: l.year + tax.lossYears })),
    // Quanto si perde se entro fine anno non si realizza una plusvalenza
    // compensabile: l'unica informazione di questo modulo su cui si può agire.
    expiring: r2(pool.filter((l) => l.year + tax.lossYears <= lastYear).reduce((a, l) => a + l.amount, 0)),
    totalTax: r2(rows.reduce((a, y) => a + y.tax, 0)),
    totalNet: r2(rows.reduce((a, y) => a + y.net, 0)),
  };
};

// Bollo titoli: 0,2% annuo sul controvalore. Stima, non liquidazione: gli
// intermediari lo calcolano pro rata sulle giacenze.
export const bolloTitoli = (value, tax = DEFAULT_TAX) => r2((value || 0) * (tax.bollo / 100));

// Imposta latente sulle posizioni ancora aperte: quanto resterebbe vendendo
// tutto oggi. Il patrimonio lordo non è quello che si porta a casa.
export const latentTax = (positions, tax = DEFAULT_TAX) => {
  let gain = 0, taxDue = 0;
  for (const p of positions || []) {
    const g = (p.value || 0) - (p.cost || 0);
    gain += g;
    if (g > 0) taxDue += g * taxRateFor(p.asset, tax);   // le perdite latenti non scontano nulla
  }
  return { latentGain: r2(gain), latentTax: r2(taxDue) };
};
