// ui.js — pezzi di sola presentazione condivisi da App.js.
// Qui non c'è logica finanziaria: ricevono numeri già calcolati e li mostrano.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// ---- Cifra grande con i decimali attenuati ----
// Riceve la stringa già formattata (fmt di App.js) e separa la parte intera dal
// resto: "55.590,00 €" → "55.590" + ",00 €". Il valore letto resta identico.
export const Money = ({ text, className = "" }) => {
  const s = String(text ?? "");
  const i = s.lastIndexOf(",");
  if (i < 0) return <span className={className}>{s}</span>;
  return (
    <span className={className}>
      {s.slice(0, i)}<span className="money-frac">{s.slice(i)}</span>
    </span>
  );
};

// ---- Indicatore che scorre sotto la voce attiva ----
// Sidebar, bottom nav e selettore di periodo: un solo elemento si sposta per
// transform da una voce all'altra (references/motion.md, Tabs). `activeKey`
// cambia → si misura la voce `.active` dentro il contenitore e si scrivono le
// sue coordinate come variabili CSS. Al primo posizionamento non anima.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export const useSlidingIndicator = (activeKey) => {
  const containerRef = useRef(null);
  const indRef = useRef(null);
  const placed = useRef(false);

  useIsoLayoutEffect(() => {
    const box = containerRef.current, ind = indRef.current;
    if (!box || !ind) return undefined;
    const place = (animate) => {
      const el = box.querySelector(".active");
      if (!el || !el.offsetWidth) { box.classList.remove("has-ind"); return; }
      ind.classList.toggle("is-jump", !animate);
      ind.style.setProperty("--x", `${el.offsetLeft}px`);
      ind.style.setProperty("--y", `${el.offsetTop}px`);
      ind.style.setProperty("--w", `${el.offsetWidth}px`);
      ind.style.setProperty("--h", `${el.offsetHeight}px`);
      box.classList.add("has-ind");
    };
    place(placed.current);
    placed.current = true;
    // Al ridimensionamento la voce cambia misura: si riposiziona senza scorrere.
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box);
    return () => ro.disconnect();
  }, [activeKey]);

  return { containerRef, indRef };
};

// ---- Entrata una volta per visita ----
// Vero per ~1,2 s dal primo montaggio: le classi d'entrata valgono solo in
// quella finestra, così cambiando tab niente si rianima (motion.md).
export const useEntrance = (ms = 1200) => {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return entering;
};

// ---- Chrome dei grafici Recharts ----
// Griglia a filetto pieno (mai tratteggiata), assi recessivi, tacche senza
// trattino: il dato è l'unica cosa che alza la voce (skill dataviz).
export const GRID = { stroke: "var(--chart-grid)", vertical: false };
export const GRID_V = { stroke: "var(--chart-grid)", horizontal: false };
export const X_AXIS = {
  stroke: "var(--chart-axis)", tickLine: false, tick: { fontSize: 12 }, tickMargin: 8, minTickGap: 16,
};
export const Y_AXIS = {
  stroke: "var(--chart-axis)", tickLine: false, axisLine: false, tick: { fontSize: 12 }, tickMargin: 6,
};
export const CURSOR_LINE = { stroke: "var(--line-strong)", strokeWidth: 1 };
export const CURSOR_BAND = { fill: "var(--chart-grid)" };
export const ACTIVE_DOT = { r: 4, strokeWidth: 2, stroke: "var(--card)" };
export const BAR_MAX = 24;          // barre mai più spesse di 24px
export const ANIM_MS = 700;         // le serie si disegnano una volta, poi stanno ferme

// Euro in forma breve per gli assi: 0 · 950 · 12k · 1,2M (una sola forma per asse).
export const axisEuro = (v) => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".", ",")}M`;
  if (a >= 10_000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace(".", ",")}k`;
  return `${Math.round(v)}`;
};

// ---- Etichetta leggibile dentro un colore ----
// Bianco o quasi-nero, quello col contrasto più alto sul riempimento.
const lum = (hex) => {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const inkOn = (hex) => {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return "#ffffff";
  const L = lum(hex);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / (0.0045 + 0.05)) ? "#ffffff" : "#0b0b0b";
};

// ---- Barra segmentata: un intero diviso in parti ----
// Sostituisce la torta (skill dataviz, Part-to-whole): blocchi proporzionali con
// 2px di stacco, la quota stampata dentro solo quando ci sta. Nome, importo e
// quota di ogni parte stanno nel title e nell'aria-label; l'elenco sotto ripete
// i numeri, quindi niente resta solo nel colore.
export const SegmentedBar = ({ items, total, colorOf, fmtValue, label }) => {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const parts = items.filter((d) => d.value > 0);
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const summary = parts.map((d) => `${d.name} ${pct(d.value).toFixed(1)}%`).join(", ");
  return (
    <div className="seg-bar" ref={ref} role="img" aria-label={`${label}: ${summary}`}>
      {parts.map((d) => {
        const p = pct(d.value);
        const text = `${p.toFixed(1).replace(".", ",")}%`;
        const fits = width > 0 && (p / 100) * width - 16 >= text.length * 7.4;
        const bg = colorOf(d);
        return (
          <div key={d.name} className="seg-bar__part"
            style={{ flexGrow: d.value, flexBasis: 0, background: bg, color: inkOn(bg) }}
            title={`${d.name}: ${fmtValue(d.value)} · ${text}`}>
            {fits && <span>{text}</span>}
          </div>
        );
      })}
    </div>
  );
};
