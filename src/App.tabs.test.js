// Test di fumo su tutte le tab, con un portafoglio realistico: movimenti,
// storico con un buco, vendita in perdita. Serve perché ogni tab si monta solo
// quando la si apre — un errore di render in Analisi o Movimenti non si vede
// finché non ci si clicca sopra.
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { apiFetch } from "./api";

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

jest.mock("./api");
jest.mock("./supabaseClient", () => ({ supabase: null }));

const CONFIG = {
  version: 4,
  totalCash: 3000,
  assets: [
    { id: "a1", name: "Globale", identifier: "IE00B4L5Y983", quantity: 0, costBasis: 0,
      lastPrice: 120, targetWeight: 90, assetClass: "ETF" },
    { id: "a2", name: "Bitcoin ETP", identifier: "", quantity: 1, costBasis: 400,
      lastPrice: 500, targetWeight: 5, assetClass: "Crypto", targetOnTotal: true },
  ],
  startups: [],
  assetClasses: ["ETF", "Crypto"],
  goldEtf: { id: "gold-etf", name: "Gold ETF", identifier: "", quantity: 0, costBasis: 0, lastPrice: null,
             targetWeight: 0, assetClass: "Oro" },
  physGold: { grams: 0, pricePerGram18kt: null, lastUpdated: null },
  settings: { benchmarkKey: "globale", inflation: 2, rebalanceBand: 0 },
  transactions: [
    { id: "t1", date: "2026-01-15", assetKey: "globale", type: "buy", quantity: 10, price: 100, fee: 5 },
    { id: "t2", date: "2026-03-10", assetKey: "globale", type: "buy", quantity: 5, price: 110, fee: 5 },
    { id: "t3", date: "2026-05-10", assetKey: "globale", type: "sell", quantity: 3, price: 90, fee: 5 },
    { id: "t4", date: "2026-04-01", assetKey: "globale", type: "dividend", amount: 40, fee: 4 },
  ],
};

// Gen, Feb, Apr, Mag: manca marzo, il caso che nella realtà si risolveva a mano.
const SNAPSHOTS = [
  { label: "Gen 2026", year: 2026, month: 1, totalValue: 4500,
    assets: [{ id: "a1", name: "Globale", price: 100, quantity: 10, value: 1000 }] },
  { label: "Feb 2026", year: 2026, month: 2, totalValue: 4700,
    assets: [{ id: "a1", name: "Globale", price: 105, quantity: 10, value: 1050 }] },
  { label: "Apr 2026", year: 2026, month: 4, totalValue: 5200,
    assets: [{ id: "a1", name: "Globale", price: 115, quantity: 15, value: 1725 }] },
  { label: "Mag 2026", year: 2026, month: 5, totalValue: 5000,
    assets: [{ id: "a1", name: "Globale", price: 90, quantity: 12, value: 1080 }] },
];

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  apiFetch.mockImplementation((path) => {
    if (path === "/api/config")    return ok(CONFIG);
    if (path === "/api/snapshots") return ok(SNAPSHOTS);
    return ok({});
  });
});

// user-event v13: niente setup(), si chiama direttamente.
const openTab = async (name) => {
  const buttons = await screen.findAllByRole("button", { name: new RegExp(name, "i") });
  await userEvent.click(buttons[0]);
};

test("ogni tab si monta senza errori con un portafoglio completo", async () => {
  render(<App />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));

  for (const tab of ["Portafoglio", "Movimenti", "Analisi", "Proiezione", "Ribilanciamento", "Impostazioni"]) {
    await openTab(tab);
    expect(document.querySelector(".tab-content")).toBeInTheDocument();
  }
});

test("Movimenti mostra il registro e i risultati che ne derivano", async () => {
  render(<App />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  await openTab("Movimenti");

  expect(await screen.findByText(/4 registrati/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Acquisto/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Vendita/)).toBeInTheDocument();
  expect(screen.getByText(/Dividendo/)).toBeInTheDocument();
  expect(screen.getAllByText(/^XIRR$/).length).toBeGreaterThan(0);
});

test("la posizione mostrata viene dai movimenti, non dai campi salvati", async () => {
  // A config l'asset ha quantity 0; i movimenti dicono 10 + 5 − 3 = 12.
  render(<App />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  await openTab("Portafoglio");

  const row = (await screen.findAllByText("Globale"))[0].closest("tr");
  expect(row).toHaveTextContent("12");
});

test("Analisi segnala il mese mancante nella serie", async () => {
  render(<App />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  await openTab("Analisi");

  expect(await screen.findByText(/Mancano 1 mesi/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Mar 2026/).length).toBeGreaterThan(0);
});

test("Analisi calcola il fisco e mostra la regola degli ETF", async () => {
  render(<App />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));
  await openTab("Analisi");

  expect(await screen.findByText(/Imposta latente/i)).toBeInTheDocument();
  expect(screen.getByText(/Zainetto fiscale/i)).toBeInTheDocument();
  // Il criterio è dichiarato in chiaro: è diverso dal PMC usato altrove.
  expect(screen.getByText(/LIFO/)).toBeInTheDocument();
  // La vendita a 90 di lotti comprati a 110 è in perdita: niente da tassare,
  // ma la minusvalenza resta nello zainetto.
  expect(screen.getByText(/usabile fino al/i)).toBeInTheDocument();
});

test("la vista condivisa non mostra la tab Movimenti", async () => {
  apiFetch.mockImplementation((path) => {
    if (path.startsWith("/api/public/")) {
      const { transactions, ...safe } = CONFIG;   // come fa il server
      return ok({ config: safe, snapshots: SNAPSHOTS });
    }
    return ok({});
  });
  render(<App shareToken={"T".repeat(32)} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());

  expect(screen.queryByRole("button", { name: /Movim/i })).not.toBeInTheDocument();
});
