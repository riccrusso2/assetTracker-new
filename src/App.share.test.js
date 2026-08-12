// Vista condivisa: verifica che il visitatore veda i dati ma nessun comando
// di modifica, e che il proprietario continui ad averli tutti.
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { apiFetch } from "./api";

// jsdom non implementa ResizeObserver, richiesto da recharts.
global.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};

jest.mock("./api");
jest.mock("./supabaseClient", () => ({ supabase: null }));

const TOKEN = "T".repeat(32);

const CONFIG = {
  version: 3,
  totalCash: 2500,
  assets: [{
    id: "a1", name: "MSCI World", identifier: "IE00B4L5Y983",
    quantity: 10, costBasis: 80, lastPrice: 100, targetWeight: 60, assetClass: "ETF",
  }],
  startups: [{ id: "s1", name: "Acme", invested: 1000, fee: 50, status: "active" }],
  assetClasses: ["ETF", "Azione"],
  goldEtf: { id: "gold-etf", name: "Gold", identifier: "", quantity: 0, costBasis: 0, lastPrice: null },
  physGold: { grams: 0, pricePerGram18kt: null, lastUpdated: null },
  settings: {},
};

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  apiFetch.mockImplementation((path) => {
    if (path.startsWith("/api/public/")) return ok({ config: CONFIG, snapshots: [] });
    if (path === "/api/config")    return ok(CONFIG);
    if (path === "/api/snapshots") return ok([]);
    if (path === "/api/gold-price") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    return ok({});
  });
});

describe("vista condivisa (read-only)", () => {
  test("carica il portafoglio dal link pubblico e segnala la sola lettura", async () => {
    render(<App shareToken={TOKEN} />);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/api/public/${TOKEN}`));

    expect((await screen.findAllByText(/sola lettura/i)).length).toBeGreaterThan(0);
    // I dati del proprietario sono visibili.
    expect((await screen.findAllByText(/Patrimonio totale/i)).length).toBeGreaterThan(0);
  });

  test("non usa gli endpoint privati né salva nulla", async () => {
    render(<App shareToken={TOKEN} />);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/api/public/${TOKEN}`));

    // L'auto-save è debounce 1.5s: oltre la soglia non deve partire nulla.
    await new Promise((r) => setTimeout(r, 2000));

    const calls = apiFetch.mock.calls.map(([p, o]) => `${o?.method || "GET"} ${p}`);
    expect(calls.some((c) => c.includes("/api/config"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/snapshot"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/share"))).toBe(false);
    expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
  }, 10000);

  test("nasconde ogni comando di modifica e la tab Impostazioni", async () => {
    render(<App shareToken={TOKEN} />);
    await screen.findAllByText(/sola lettura/i);

    expect(screen.queryByRole("button", { name: /condividi/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /impostazioni/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /snapshot mensile/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aggiorna prezzi/i })).not.toBeInTheDocument();

    // Due nav (tab bar desktop + bottom nav mobile) → due bottoni per tab.
    await userEvent.click(screen.getAllByRole("button", { name: /portafoglio/i })[0]);

    expect(await screen.findByText("MSCI World")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aggiungi asset/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aggiungi startup/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /asset class/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /esporta configurazione/i })).not.toBeInTheDocument();
    // Nessuna riga con azioni di modifica/eliminazione.
    expect(document.querySelectorAll(".row-actions")).toHaveLength(0);
  }, 15000);

  test("link revocato o inesistente → pagina di errore, nessun dato", async () => {
    apiFetch.mockImplementation((path) =>
      path.startsWith("/api/public/")
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "no" }) })
        : ok({}));

    render(<App shareToken={TOKEN} />);

    expect(await screen.findByText(/Portafoglio non disponibile/i)).toBeInTheDocument();
    expect(screen.queryByText("MSCI World")).not.toBeInTheDocument();
  });
});

describe("proprietario autenticato", () => {
  test("mantiene il pulsante Condividi e i comandi di modifica", async () => {
    render(<App session={{ user: { id: "u1", email: "a@b.c" } }} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));

    expect(await screen.findByRole("button", { name: /condividi/i })).toBeInTheDocument();
    expect(screen.queryByText(/sola lettura/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /impostazioni/i })).toHaveLength(2);
  }, 10000);

  // Regressione: un GET /api/config fallito veniva trattato come "nessun
  // portafoglio", lo stato veniva azzerato e l'auto-save sovrascriveva il blob
  // sul server con uno vuoto. Il caricamento fallito non deve mai scrivere.
  test("GET /api/config fallito non innesca nessun salvataggio", async () => {
    apiFetch.mockImplementation((path) => {
      if (path === "/api/config") return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      if (path === "/api/snapshots") return ok([]);
      return ok({});
    });

    render(<App session={{ user: { id: "u1", email: "a@b.c" } }} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/config"));

    // Oltre il debounce di 1,5 s dell'auto-save.
    await new Promise((r) => setTimeout(r, 2200));

    const writes = apiFetch.mock.calls.filter(([, o]) => o?.method && o.method !== "GET");
    expect(writes).toHaveLength(0);
    expect(await screen.findByText(/portafoglio non caricato/i)).toBeInTheDocument();
  }, 10000);
});
