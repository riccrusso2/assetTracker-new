// L'export Excel deve dire gli stessi numeri della dashboard. portfolioBreakdown
// replica le basi di App.js: questo test le confronta davvero, leggendo la
// "Asset allocation" a schermo e le righe di categoria del file.
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { apiFetch } from "./api";
import { downloadXlsx } from "./xlsx";

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

jest.mock("./api");
jest.mock("./supabaseClient", () => ({ supabase: null }));
// Il file vero lo verifica xlsx.test.js: qui interessa cosa ci finisce dentro.
jest.mock("./xlsx", () => ({ ...jest.requireActual("./xlsx"), downloadXlsx: jest.fn() }));

const CONFIG = {
  version: 5,
  totalCash: 3000,
  assets: [
    // Quantità salvata 0: quella vera (12) viene dai movimenti.
    { id: "a1", name: "Globale", identifier: "IE00B4L5Y983", quantity: 0, costBasis: 0,
      lastPrice: 120, targetWeight: 100, assetClass: "ETF" },
    { id: "a2", name: "Bitcoin ETP", identifier: "", quantity: 1, costBasis: 400,
      lastPrice: 500, targetWeight: 5, assetClass: "Crypto", targetOnTotal: true },
  ],
  startups: [{ id: "s1", name: "Alfa", invested: 1000, fee: 20 }],
  assetClasses: ["ETF", "Crypto"],
  goldEtf: { id: "gold-etf", name: "Gold ETF", identifier: "IE00B4ND3602", quantity: 4, costBasis: 150,
             lastPrice: 175, targetWeight: 10, assetClass: "Oro" },
  physGold: { grams: 5, pricePerGram18kt: 60, lastUpdated: null },
  settings: {},
  transactions: [
    { id: "t1", date: "2026-01-15", assetKey: "globale", type: "buy", quantity: 10, price: 100, fee: 5 },
    { id: "t2", date: "2026-03-10", assetKey: "globale", type: "buy", quantity: 5, price: 110, fee: 5 },
    { id: "t3", date: "2026-05-10", assetKey: "globale", type: "sell", quantity: 3, price: 90, fee: 5 },
  ],
  cashflow: [],
};

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const val = (c) => (c !== null && typeof c === "object" && !(c instanceof Date) ? c.v : c);

beforeEach(() => {
  jest.clearAllMocks();
  window.location.hash = "";
  apiFetch.mockImplementation((path) => {
    if (path === "/api/config")    return ok(CONFIG);
    if (path === "/api/snapshots") return ok([]);
    return ok({});
  });
});

const exportAndRead = async () => {
  await userEvent.click(await screen.findByRole("button", { name: /Esporta Excel/i }));
  expect(downloadXlsx).toHaveBeenCalledTimes(1);
  const [filename, sheets] = downloadXlsx.mock.calls[0];
  return { filename, sheets };
};

test("le percentuali per categoria del file sono quelle dell'Overview", async () => {
  render(<App session={{ user: { id: "u1", email: "a@b.c" } }} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  // Attende il caricamento: la legenda compare con i dati del server.
  await screen.findByText("Liquidità", { selector: ".alloc-name" });

  const onScreen = Object.fromEntries([...document.querySelectorAll(".alloc-row")].map((r) => [
    r.querySelector(".alloc-name").textContent,
    r.querySelector(".alloc-pct").textContent.replace("%", ""),
  ]));

  const { filename, sheets } = await exportAndRead();
  expect(filename).toMatch(/^portafoglio_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const summary = sheets.find((s) => s.name === "Riepilogo");
  const inFile = Object.fromEntries(summary.rows
    .filter((r) => r?.[0]?.fill === "cat")
    .map((r) => [val(r[0]), (r[4].v * 100).toFixed(1)]));

  expect(Object.keys(inFile)).toEqual(["ETF", "Crypto", "Startup", "Oro", "Liquidità"]);
  expect(inFile).toEqual(onScreen);
  expect(await screen.findByRole("status")).toHaveTextContent(/Excel/);
});

test("le quantità esportate vengono dal registro movimenti", async () => {
  render(<App session={{ user: { id: "u1", email: "a@b.c" } }} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  await screen.findByText("Liquidità", { selector: ".alloc-name" });

  const { sheets } = await exportAndRead();
  const detail  = sheets.find((s) => s.name === "Dettaglio");
  const globale = detail.rows.find((r) => val(r?.[1]) === "Globale");
  expect(val(globale[2])).toBe("IE00B4L5Y983");
  expect(val(globale[3])).toBe(12);                // 10 + 5 − 3
  expect(globale[6].v).toBeCloseTo(1440, 6);       // 12 × 120
  // L'unico ETF del sotto-portafoglio ha target 100% e pesa il 100%.
  expect(globale[12].v).toBeCloseTo(1, 9);
  expect(globale[13].v).toBeCloseTo(1, 9);
});

test("nella vista condivisa l'export c'è ed esporta il portafoglio a schermo", async () => {
  apiFetch.mockImplementation((path) => {
    if (path.startsWith("/api/public/")) {
      const { transactions, cashflow, ...safe } = CONFIG;   // come fa il server
      return ok({ config: safe, snapshots: [] });
    }
    return ok({});
  });
  render(<App shareToken={"T".repeat(32)} />);
  await screen.findByText("Liquidità", { selector: ".alloc-name" });

  const { sheets } = await exportAndRead();
  expect(sheets.map((s) => s.name)).toEqual(["Riepilogo", "Dettaglio", "Startup"]);
});

test("senza dati il bottone non compare", async () => {
  apiFetch.mockImplementation((path) => (path === "/api/config" ? ok(null) : ok([])));
  render(<App session={{ user: { id: "u1", email: "a@b.c" } }} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  expect(await screen.findByText(/Benvenuto in AssetTracker/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Esporta Excel/i })).not.toBeInTheDocument();
});
