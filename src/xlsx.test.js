import {
  buildXlsx, crc32, utf8, colName, portfolioSheets, exportFileName,
} from "./xlsx";
import { portfolioBreakdown } from "./rebalance";

// ---- Lettura dello zip "store" prodotto dal writer ----
// Ricontrolla header, offset e CRC di ogni file: un byte sbagliato qui è un
// file che Excel rifiuta di aprire.
const decode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return decodeURIComponent(escape(s));
};

const unzip = (bytes) => {
  const dv   = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc     = dv.getUint32(p + 16, true);
    const size    = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const offset  = dv.getUint32(p + 42, true);
    const name    = decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(dv.getUint32(offset, true)).toBe(0x04034b50);
    const start = offset + 30 + dv.getUint16(offset + 26, true) + dv.getUint16(offset + 28, true);
    const data  = bytes.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files[name] = decode(data);
    p += 46 + nameLen;
  }
  return files;
};

const wellFormed = (xml) => {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagName("parsererror").length === 0;
};

// ====================== writer ======================

test("crc32 e utf8 sui valori di riferimento", () => {
  expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  expect([...utf8("€")]).toEqual([0xe2, 0x82, 0xac]);
  expect(utf8("😀").length).toBe(4);
});

test("colName converte l'indice in lettere di colonna", () => {
  expect([0, 15, 25, 26, 701, 702].map(colName)).toEqual(["A", "P", "Z", "AA", "ZZ", "AAA"]);
});

test("il file contiene le parti richieste da Excel, tutte XML ben formato", () => {
  const files = unzip(buildXlsx([
    { name: "Uno", rows: [["a"]] },
    { name: "Due", rows: [[1]], autoFilter: "A1:A1" },
  ]));
  expect(Object.keys(files)).toEqual([
    "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
    "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
  ]);
  expect(wellFormed("<a><b></a>")).toBe(false);   // il controllo non è vacuo
  Object.values(files).forEach((xml) => expect(wellFormed(xml)).toBe(true));
  expect(files["[Content_Types].xml"]).toContain("/xl/worksheets/sheet2.xml");
  expect(files["xl/workbook.xml"]).toContain('<sheet name="Due" sheetId="2" r:id="rId2"/>');
  // Il filtro del secondo foglio ha il suo nome definito, con riferimenti assoluti.
  expect(files["xl/workbook.xml"]).toContain('localSheetId="1"');
  expect(files["xl/workbook.xml"]).toContain("'Due'!$A$1:$A$1");
  expect(files["xl/_rels/workbook.xml.rels"]).toContain('Id="rId3"');   // gli stili dopo i fogli
});

test("testi con caratteri speciali restano testo, numeri restano numeri", () => {
  const files = unzip(buildXlsx([{ name: "Test", rows: [
    ["Azioni & <bond> \"globali\"\u000B", 1234.5, null, "", { v: 0.605, fmt: "pct" }],
    [],
    [new Date(2024, 2, 15), true, NaN, Infinity],
  ] }]));
  const xml = files["xl/worksheets/sheet1.xml"];
  expect(wellFormed(xml)).toBe(true);
  expect(xml).toContain("Azioni &amp; &lt;bond&gt; &quot;globali&quot;</t>");
  expect(xml).toContain('<c r="B1"><v>1234.5</v></c>');
  expect(xml).toMatch(/<c r="E1" s="\d+"><v>0.605<\/v><\/c>/);
  // Celle vuote senza stile e righe vuote non si scrivono.
  expect(xml).not.toContain('r="C1"');
  expect(xml).not.toContain('<row r="2"');
  // Data → seriale di Excel (15/03/2024 = 45366) col formato data.
  expect(xml).toMatch(/<c r="A3" s="\d+"><v>45366<\/v><\/c>/);
  expect(xml).toContain('<c r="B3" t="b"><v>1</v></c>');
  // NaN e Infinity non sono numeri validi in XLSX: cella vuota.
  expect(xml).not.toContain('r="C3"');
  expect(xml).not.toContain('r="D3"');
});

test("ogni stile usato dalle celle esiste in styles.xml", () => {
  const files = unzip(buildXlsx([{ name: "S", rows: [
    [{ v: "x", bold: true, fill: "header", border: "bottom" }, { v: 1, fmt: "eur" }],
    [{ v: "y", indent: 1 }, { v: 2, fmt: "eur" }, { v: 0.1, fmt: "pctSigned", bold: true }],
  ] }]));
  const styles = files["xl/styles.xml"];
  const count  = +/<cellXfs count="(\d+)"/.exec(styles)[1];
  expect(styles.match(/<cellXfs[\s\S]*<\/cellXfs>/)[0].match(/<xf /g)).toHaveLength(count);
  const used = [...files["xl/worksheets/sheet1.xml"].matchAll(/ s="(\d+)"/g)].map((m) => +m[1]);
  expect(Math.max(...used)).toBeLessThan(count);
  // Due celle "eur" identiche condividono lo stesso xf.
  expect(count).toBe(5);   // base + header + eur + indent + pctSigned grassetto
  expect(styles).toContain('formatCode="#,##0.00\\ &quot;€&quot;"');
});

test("nomi di foglio non validi per Excel vengono ripuliti", () => {
  const files = unzip(buildXlsx([{ name: "Q1/Q2: [bozza]?" + "x".repeat(40), rows: [] }]));
  const name = /<sheet name="([^"]*)"/.exec(files["xl/workbook.xml"])[1];
  expect(name).not.toMatch(/[[\]:*?/\\]/);
  expect(name.length).toBeLessThanOrEqual(31);
});

test("il nome del file usa la data locale", () => {
  expect(exportFileName(new Date(2026, 0, 1, 0, 30))).toBe("portafoglio_2026-01-01.xlsx");
});

// ====================== layout del portafoglio ======================

const REAL = {
  assets: [
    { name: "FTSE All-World", identifier: "IE00BK5BQT80", quantity: 150, costBasis: 120,
      lastPrice: 140, targetWeight: 60, assetClass: "ETF" },
    { name: "Bitcoin ETP", identifier: "GB00BJYDH287", quantity: 2, costBasis: 700,
      lastPrice: 641.58, targetWeight: 2, assetClass: "Crypto" },
    { name: "MSCI World", identifier: "IE00B4L5Y983", quantity: 120, costBasis: 95,
      lastPrice: 100.5, targetWeight: 30, assetClass: "ETF" },
    { name: "EM IMI", identifier: "IE00BKM4GZ66", quantity: 80, costBasis: 30,
      lastPrice: 36.384, targetWeight: 10, assetClass: "ETF" },
  ],
  goldEtf: { name: "Physical Gold", identifier: "IE00B4ND3602", quantity: 25,
             costBasis: 180, lastPrice: 200.5, targetWeight: 10, assetClass: "Oro" },
  physGold: { grams: 10, pricePerGram18kt: 199.319 },
  startups: [
    { name: "Alfa", invested: 3000, fee: 60, date: "2023-05-10" },
    { name: "Beta", invested: 1000, fee: 20, currentValue: 1500 },
    { name: "Gamma", invested: 500, fee: 10, status: "failed", exitDate: "2025-02-01" },
  ],
  totalCash: 10670,
  subscription: 468,
};

const sheetsOf = (cfg) => portfolioSheets(portfolioBreakdown(cfg), { exportedAt: new Date(2026, 10, 17, 21, 18) });
const val = (c) => (c !== null && typeof c === "object" && !(c instanceof Date) ? c.v : c);

test("tre fogli: Riepilogo, Dettaglio, Startup", () => {
  expect(sheetsOf(REAL).map((s) => s.name)).toEqual(["Riepilogo", "Dettaglio", "Startup"]);
  // Senza startup il foglio dedicato non c'è.
  expect(sheetsOf({ ...REAL, startups: [] }).map((s) => s.name)).toEqual(["Riepilogo", "Dettaglio"]);
});

test("il Riepilogo mette ogni macro-categoria con le sue posizioni sotto", () => {
  const [summary] = sheetsOf(REAL);
  expect(val(summary.rows[1][0])).toBe("Esportato da AssetTracker il 17/11/2026 21:18");
  const body = summary.rows.slice(summary.freeze);
  const names = body.map((r) => val(r?.[0])).filter(Boolean);
  expect(names.slice(0, 14)).toEqual([
    "ETF", "FTSE All-World", "MSCI World", "EM IMI",
    "Crypto", "Bitcoin ETP",
    "Startup", "Alfa", "Beta",
    "Oro", "Physical Gold", "Oro fisico 18kt",
    "Liquidità", "Liquidità disponibile",
  ]);
  // Righe di categoria: % sul patrimonio come frazione, formattata a %.
  const catRows = body.filter((r) => r?.[0]?.fill === "cat");
  expect(catRows.map((r) => (r[4].v * 100).toFixed(1))).toEqual(["60.5", "2.2", "7.6", "11.8", "18.0"]);
  expect(catRows.every((r) => r[4].fmt === "pct")).toBe(true);
  // Riga ETF: ISIN, % nella categoria, target come frazione.
  const ftse = body.find((r) => val(r?.[0]) === "FTSE All-World");
  expect(val(ftse[1])).toBe("IE00BK5BQT80");
  expect(ftse[3].v).toBeCloseTo(21000 / 35970.72, 9);
  expect(ftse[6].v).toBeCloseTo(0.6, 9);
  expect(val(ftse[8])).toBe("Sotto-portafoglio ETF");
  // Totale: patrimonio e 100%.
  const tot = body.find((r) => val(r?.[0]) === "Totale");
  expect(tot[2].v).toBeCloseTo(59429.57, 6);
  expect(tot[4].v).toBe(1);
});

test("il Dettaglio ha una riga per posizione e il filtro sulle sole righe dati", () => {
  const [, detail] = sheetsOf(REAL);
  const data = detail.rows.slice(1).filter((r) => r.length && val(r[0]) !== "Totale");
  expect(data).toHaveLength(9);    // 3 ETF + 1 crypto + 2 startup attive + 2 oro + liquidità
  expect(detail.autoFilter).toBe("A1:P10");
  const gold = data.find((r) => val(r[1]) === "Oro fisico 18kt (grammi)");
  expect(val(gold[0])).toBe("Oro");
  expect(val(gold[3])).toBe(10);
  expect(gold[13].v).toBeNull();   // nessun target sull'oro fisico
});

test("il foglio Startup elenca anche le concluse, fuori dal patrimonio", () => {
  const st = sheetsOf(REAL)[2];
  const gamma = st.rows.find((r) => val(r?.[0]) === "Gamma");
  expect(val(gamma[1])).toBe("Fallita");
  expect(val(gamma[10])).toBe("No");
  expect(val(gamma[9])).toEqual(new Date(2025, 1, 1));
  const alfa = st.rows.find((r) => val(r?.[0]) === "Alfa");
  expect(val(alfa[2])).toEqual(new Date(2023, 4, 10));
  expect(alfa[7].v).toBeNull();    // nessuna valutazione: niente P&L
  const outlay = st.rows.find((r) => val(r?.[0]) === "Esborso totale");
  expect(outlay[1].v).toBe(4500 + 90 + 468);
});

test("l'intero export produce un file valido", () => {
  const files = unzip(buildXlsx(sheetsOf(REAL)));
  Object.values(files).forEach((xml) => expect(wellFormed(xml)).toBe(true));
  expect(files["xl/worksheets/sheet3.xml"]).toContain("Gamma");
});
