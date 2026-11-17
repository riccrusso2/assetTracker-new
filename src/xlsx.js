// xlsx.js — Export Excel del portafoglio.
//
// Due parti: un writer .xlsx minimale e il layout dei fogli del portafoglio.
// I numeri arrivano già calcolati da `portfolioBreakdown` (rebalance.js): qui
// non c'è logica finanziaria, solo la disposizione nelle celle.
//
// Niente dipendenze: le librerie mature pesano centinaia di kB per scrivere tre
// tabelle, e `xlsx` (SheetJS) su npm è ferma a una versione con vulnerabilità
// note. Al writer serve poco: stringhe inline, numeri, stili di cella, larghezze
// di colonna, riquadri bloccati e filtro automatico, in uno zip senza
// compressione (metodo "store", che Excel legge senza problemi).
//
// Le percentuali si scrivono come frazioni (0,605) col formato "0,00%": restano
// numeri, quindi si possono ordinare, sommare e riusare in altre formule.

// ====================== WRITER ======================
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN  = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG   = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT    = "http://schemas.openxmlformats.org/package/2006/content-types";

// TextEncoder manca nell'ambiente jsdom dei test: stesso risultato a mano.
// Un surrogato spaiato diventa U+FFFD, come fa TextEncoder.
export const utf8 = (str) => {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = str.charCodeAt(i + 1);
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Zip "store": header locale + dati per ogni file, poi la directory centrale.
// Bit 11 dei flag = nomi in UTF-8.
const zip = (files, date) => {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9)
    | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nm  = utf8(name);
    const crc = crc32(data);
    const loc = new Uint8Array(30 + nm.length);
    const lv  = new DataView(loc.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nm.length, true);
    lv.setUint16(28, 0, true);
    loc.set(nm, 30);
    parts.push(loc, data);

    const cen = new Uint8Array(46 + nm.length);
    const cv  = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nm.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nm, 46);
    central.push(cen);
    offset += loc.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev  = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
};

// Caratteri di controllo esclusi: un nome incollato con un \x0B renderebbe il
// file illeggibile per Excel, che rifiuta l'XML invece di saltare la cella.
const esc = (s) => String(s)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Numero seriale di Excel (giorni dal 30/12/1899) dell'ora locale.
const excelSerial = (d) =>
  (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
    - Date.UTC(1899, 11, 30)) / 864e5;

// Formati numerici. 10 e 14 sono predefiniti di Excel ("0.00%" e la data
// breve, che segue la lingua del sistema: gg/mm/aaaa su un Excel italiano).
// Separatori di migliaia e decimali li sceglie Excel dal locale.
const FORMATS = {
  general:   { id: 0 },
  pct:       { id: 10 },
  date:      { id: 14 },
  eur:       { id: 164, code: '#,##0.00\\ "€"' },
  price:     { id: 165, code: '#,##0.00##\\ "€"' },
  eurSigned: { id: 166, code: '+#,##0.00\\ "€";-#,##0.00\\ "€";0.00\\ "€"' },
  pctSigned: { id: 167, code: "+0.00%;-0.00%;0.00%" },
  ptSigned:  { id: 168, code: "+0.00;-0.00;0.00" },
};

const FONTS = [
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>',
  '<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>',
];
const solid = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  solid("FFE5E7EB"),   // intestazioni
  solid("FFF3F4F6"),   // righe di categoria
];
const line = (side) => `<${side} style="thin"><color rgb="FF9CA3AF"/></${side}>`;
const BORDERS = [
  "<border><left/><right/><top/><bottom/><diagonal/></border>",
  `<border><left/><right/><top/>${line("bottom")}<diagonal/></border>`,
  `<border><left/><right/>${line("top")}<bottom/><diagonal/></border>`,
];

// Ogni combinazione di stile usata diventa un `xf`; l'indice 0 è lo stile base.
const styleRegistry = () => {
  const xfs  = [{ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, indent: 0, wrap: false }];
  const keys = new Map([["0|0|0|0|0|false", 0]]);
  const idOf = (st = {}) => {
    const x = {
      numFmtId: (FORMATS[st.fmt] || FORMATS.general).id,
      fontId:   st.title ? 2 : st.note ? 3 : st.bold ? 1 : 0,
      fillId:   st.fill === "header" ? 2 : st.fill === "cat" ? 3 : 0,
      borderId: st.border === "bottom" ? 1 : st.border === "top" ? 2 : 0,
      indent:   st.indent || 0,
      wrap:     !!st.wrap,
    };
    const key = [x.numFmtId, x.fontId, x.fillId, x.borderId, x.indent, x.wrap].join("|");
    if (!keys.has(key)) { keys.set(key, xfs.length); xfs.push(x); }
    return keys.get(key);
  };
  return { idOf, xfs };
};

const xfXml = (x) => {
  const align = x.indent || x.wrap
    ? `<alignment${x.indent ? ` horizontal="left" indent="${x.indent}"` : ""}${x.wrap ? ' vertical="top" wrapText="1"' : ""}/>`
    : "";
  const attrs = `numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0"`
    + (x.numFmtId ? ' applyNumberFormat="1"' : "")
    + (x.fontId ? ' applyFont="1"' : "")
    + (x.fillId ? ' applyFill="1"' : "")
    + (x.borderId ? ' applyBorder="1"' : "")
    + (align ? ' applyAlignment="1"' : "");
  return align ? `<xf ${attrs}>${align}</xf>` : `<xf ${attrs}/>`;
};

const stylesXml = (xfs) => {
  const custom = Object.values(FORMATS).filter((f) => f.code);
  return XML_HEAD + `<styleSheet xmlns="${NS_MAIN}">`
    + `<numFmts count="${custom.length}">${custom.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${esc(f.code)}"/>`).join("")}</numFmts>`
    + `<fonts count="${FONTS.length}">${FONTS.join("")}</fonts>`
    + `<fills count="${FILLS.length}">${FILLS.join("")}</fills>`
    + `<borders count="${BORDERS.length}">${BORDERS.join("")}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.map(xfXml).join("")}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + "</styleSheet>";
};

// Una cella è un valore semplice (stringa, numero, Date, booleano, null) o un
// oggetto `{ v, fmt, bold, title, note, fill, border, indent, wrap }`.
const cellXml = (raw, ref, idOf) => {
  const cell = raw !== null && typeof raw === "object" && !(raw instanceof Date) ? raw : { v: raw };
  let { v } = cell;
  let st = cell;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) v = null;
    else { if (!cell.fmt) st = { ...cell, fmt: "date" }; v = excelSerial(v); }
  }
  const s = idOf(st);
  const sAttr = s ? ` s="${s}"` : "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "string" && v !== "") {
    return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }
  // Cella vuota: la si scrive solo se ha uno stile (sfondo, bordo).
  return s ? `<c r="${ref}"${sAttr}/>` : "";
};

const sheetXml = (sheet, idOf, first) => {
  const freeze = sheet.freeze || 0;
  const sel = first ? ' tabSelected="1"' : "";
  const view = freeze > 0
    ? `<sheetView workbookViewId="0"${sel}><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>`
      + `<selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/></sheetView>`
    : `<sheetView workbookViewId="0"${sel}/>`;
  const cols = (sheet.cols || []).length
    ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rows = (sheet.rows || []).map((row, r) => {
    const cells = (row || []).map((c, i) => cellXml(c, `${colName(i)}${r + 1}`, idOf)).join("");
    return cells ? `<row r="${r + 1}">${cells}</row>` : "";
  }).join("");
  // In stampa (o "Salva come PDF") orizzontale e adattato alla larghezza: le
  // tabelle hanno 9-16 colonne e altrimenti si spezzano su più pagine.
  return XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<sheetViews>${view}</sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + cols
    + `<sheetData>${rows}</sheetData>`
    + (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "")
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    + "</worksheet>";
};

// Nome di foglio valido per Excel: niente []:*?/\, al massimo 31 caratteri.
const sheetName = (n, i) => (String(n || "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Foglio${i + 1}`);

const workbookXml = (sheets) => {
  const quoted = (n) => `'${n.replace(/'/g, "''")}'`;
  const abs = (ref) => ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
  const defs = sheets.map((s, i) => (s.autoFilter
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`${quoted(s.name)}!${abs(s.autoFilter)}`)}</definedName>`
    : "")).join("");
  return XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<bookViews><workbookView activeTab="0"/></bookViews>'
    + `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>`
    + (defs ? `<definedNames>${defs}</definedNames>` : "")
    + "</workbook>";
};

const contentTypesXml = (n) => XML_HEAD + `<Types xmlns="${NS_CT}">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + Array.from({ length: n }, (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
  + "</Types>";

const ROOT_RELS = XML_HEAD + `<Relationships xmlns="${NS_PKG}">`
  + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
  + "</Relationships>";

const workbookRelsXml = (n) => XML_HEAD + `<Relationships xmlns="${NS_PKG}">`
  + Array.from({ length: n }, (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
  + `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
  + "</Relationships>";

// `sheets`: [{ name, rows: [[cella]], cols?: [larghezza], freeze?: n righe,
// autoFilter?: "A1:P20" }]. Restituisce i byte del file .xlsx.
export const buildXlsx = (sheets, { date = new Date() } = {}) => {
  const named = sheets.map((s, i) => ({ ...s, name: sheetName(s.name, i) }));
  const { idOf, xfs } = styleRegistry();
  // I fogli prima degli stili: è scrivendo le celle che si registrano gli xf.
  const sheetParts = named.map((s, i) => sheetXml(s, idOf, i === 0));
  const files = [
    ["[Content_Types].xml", contentTypesXml(named.length)],
    ["_rels/.rels", ROOT_RELS],
    ["xl/workbook.xml", workbookXml(named)],
    ["xl/_rels/workbook.xml.rels", workbookRelsXml(named.length)],
    ["xl/styles.xml", stylesXml(xfs)],
    ...sheetParts.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  return zip(files.map(([name, xml]) => ({ name, data: utf8(xml) })), date);
};

export const downloadXlsx = (filename, sheets) => {
  const blob = new Blob([buildXlsx(sheets)], { type: XLSX_MIME });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revocato subito, alcuni browser annullano il download ancora in corso.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// ====================== LAYOUT DEL PORTAFOGLIO ======================
const pad = (n) => String(n).padStart(2, "0");

// Data locale, non toISOString(): dopo mezzanotte in Italia l'UTC è ancora
// il giorno prima e il file prenderebbe la data sbagliata.
export const exportFileName = (d = new Date()) =>
  `portafoglio_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`;

const STATUS_LABEL = { active: "Attiva", exit: "Exit", failed: "Fallita" };

// "2024-03-15" → Date locale, così in Excel è una data vera e non un testo.
const dateCell = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : (s || null);
};

const num = (n) => String(n).replace(".", ",");

// Fogli del file: Riepilogo (macro-categorie con le loro posizioni), Dettaglio
// (una riga per posizione, filtrabile) e Startup (tutte, concluse comprese).
// `b` è il risultato di portfolioBreakdown.
export const portfolioSheets = (b, { exportedAt = new Date() } = {}) => {
  const d = exportedAt;
  const when = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Le percentuali di portfolioBreakdown sono in punti (60,5): in cella frazioni.
  const P   = (v, st = {}) => ({ v: v == null ? null : v / 100, fmt: "pct", ...st });
  const PS  = (v, st = {}) => ({ v: v == null ? null : v / 100, fmt: "pctSigned", ...st });
  const E   = (v, st = {}) => ({ v, fmt: "eur", ...st });
  const ES  = (v, st = {}) => ({ v, fmt: "eurSigned", ...st });
  const PT  = (v, st = {}) => ({ v, fmt: "ptSigned", ...st });
  const PR  = (v, st = {}) => ({ v, fmt: "price", ...st });
  const hdr = (labels) => labels.map((v) => ({ v, bold: true, fill: "header", border: "bottom" }));
  // Riga a larghezza fissa con uno stile comune, valori nelle colonne date.
  const styledRow = (width, st, values) =>
    Array.from({ length: width }, (_, i) => {
      const v = values[i];
      return v !== null && typeof v === "object" ? { ...st, ...v } : { v: v ?? null, ...st };
    });
  const totalStyle = { bold: true, border: "top" };
  const cats = b.categories || [];

  // ---- Riepilogo ----
  const SUM_COLS = ["Voce", "ISIN", "Valore (€)", "% nella categoria", "% sul patrimonio",
    "Peso attuale", "Target", "Scostamento (pt)", "Base del target"];
  const summary = [
    [{ v: "Portafoglio — composizione del patrimonio", title: true }],
    [{ v: `Esportato da AssetTracker il ${when}`, note: true }],
    [{ v: "Patrimonio totale", bold: true }, null, E(b.grandTotal, { bold: true })],
    [],
    hdr(SUM_COLS),
  ];
  const SUM_HEAD = summary.length;
  for (const c of cats) {
    summary.push(styledRow(SUM_COLS.length, { bold: true, fill: "cat" },
      { 0: c.name, 2: E(c.value), 4: P(c.pct) }));
    for (const p of c.items) {
      summary.push([
        { v: p.name, indent: 1 }, p.isin || null, E(p.value),
        P(p.pctCategory), P(p.pctTotal), P(p.weight), P(p.target), PT(p.drift), p.targetBase,
      ]);
    }
  }
  summary.push(styledRow(SUM_COLS.length, totalStyle,
    { 0: "Totale", 2: E(b.grandTotal), 4: P(b.grandTotal ? 100 : null) }));

  const items = cats.flatMap((c) => c.items);
  const notes = [
    "Peso attuale e Target sono misurati sulla stessa base, indicata in «Base del target»: "
      + "il sotto-portafoglio ETF per gli asset quotati, il patrimonio totale per oro e crypto.",
  ];
  if (b.etfTargetSum > 0 && b.etfTargetSum !== 100) {
    notes.push(`I target del sotto-portafoglio ETF sommano a ${num(b.etfTargetSum)}%: `
      + "qui sono normalizzati a 100, come nel ribilanciamento.");
  }
  if (b.goldOnTotal && items.some((p) => p.kind === "goldEtf") && items.some((p) => p.kind === "physGold")) {
    notes.push("Il target dell'oro vale per ETF e oro fisico insieme: "
      + "il peso attuale sulla riga dell'ETF oro li comprende entrambi.");
  }
  const closed = b.startups?.closed?.length || 0;
  if (closed > 0) {
    notes.push(closed === 1
      ? "Una startup conclusa è uscita dal patrimonio: è nel foglio Startup con le altre."
      : `${closed} startup concluse sono uscite dal patrimonio: sono nel foglio Startup con le altre.`);
  }
  notes.push("Valori ai prezzi dell'ultimo aggiornamento; le startup attive alla valutazione dichiarata, "
    + "al costo dove manca.");
  summary.push([]);
  notes.forEach((t) => summary.push([{ v: t, note: true }]));

  // ---- Dettaglio ----
  const DET_COLS = ["Categoria", "Nome", "ISIN", "Quantità", "Prezzo medio di carico", "Prezzo attuale",
    "Valore (€)", "Costo (€)", "P&L (€)", "P&L %", "% nella categoria", "% sul patrimonio",
    "Peso attuale", "Target", "Scostamento (pt)", "Base del target"];
  const detail = [hdr(DET_COLS)];
  for (const c of cats) {
    for (const p of c.items) {
      detail.push([
        c.name, p.kind === "physGold" ? `${p.name} (grammi)` : p.name, p.isin || null,
        p.quantity ?? null, PR(p.unitCost), PR(p.price),
        E(p.value), E(p.cost), ES(p.pnl), PS(p.pnlPct),
        P(p.pctCategory), P(p.pctTotal), P(p.weight), P(p.target), PT(p.drift), p.targetBase,
      ]);
    }
  }
  const detRows = detail.length;
  detail.push([]);
  detail.push(styledRow(DET_COLS.length, totalStyle,
    { 0: "Totale", 6: E(b.grandTotal), 11: P(b.grandTotal ? 100 : null) }));

  const sheets = [
    { name: "Riepilogo", rows: summary, freeze: SUM_HEAD,
      cols: [40, 16, 15, 17, 16, 13, 10, 16, 36] },
    { name: "Dettaglio", rows: detail, freeze: 1,
      autoFilter: detRows > 1 ? `A1:${colName(DET_COLS.length - 1)}${detRows}` : undefined,
      cols: [13, 36, 15, 11, 21, 15, 15, 15, 15, 10, 17, 16, 13, 10, 16, 36] },
  ];

  // ---- Startup: tutte, anche concluse ----
  const su = b.startups;
  if (su?.rows?.length) {
    const ST_COLS = ["Nome", "Stato", "Data investimento", "Investito (€)", "Commissioni (€)",
      "Costo totale (€)", "Valore / Recuperato (€)", "P&L (€)", "ROI %", "Data exit", "Nel patrimonio", "Note"];
    const rows = [hdr(ST_COLS)];
    for (const s of su.rows) {
      // Come in tabella: P&L di un'attiva solo se ha una valutazione dichiarata.
      const valued = !s.closed && s.currentValue != null;
      rows.push([
        s.name || "", STATUS_LABEL[s.status] || s.status, dateCell(s.date),
        E(s.invested), E(s.fee), E(s.totalCost),
        E(s.closed ? s.recovered : s.value),
        ES(s.closed ? s.pnl : valued ? s.unrealPnl : null),
        PS(s.closed ? s.roiPct : valued ? s.unrealRoiPct : null),
        s.closed ? dateCell(s.exitDate) : null,
        s.closed ? "No" : "Sì",
        s.exitNotes || null,
      ]);
    }
    const stRows = rows.length;
    rows.push([]);
    [
      ["Capitale investito",       E(su.investedTot)],
      ["Commissioni",              E(su.feesTot)],
      ["Abbonamento piattaforma",  E(su.subscription)],
      ["Esborso totale",           E(su.totalOutlay)],
      ["Recuperato da exit",       E(su.recoveredTot)],
      ["Valore startup attive",    E(su.activeValue)],
      [su.allClosed ? "Risultato finale" : "P&L complessivo", ES(su.pnlOverall, { bold: true })],
      [su.allClosed ? "ROI finale" : "ROI complessivo",       PS(su.roiOverallPct, { bold: true })],
    ].forEach(([label, cell]) => rows.push([{ v: label, bold: true }, cell]));
    sheets.push({
      name: "Startup", rows, freeze: 1,
      autoFilter: `A1:${colName(ST_COLS.length - 1)}${stRows}`,
      cols: [30, 15, 17, 14, 15, 16, 22, 14, 10, 12, 14, 40],
    });
  }
  return sheets;
};
