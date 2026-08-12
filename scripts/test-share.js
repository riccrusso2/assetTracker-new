#!/usr/bin/env node
/*
 * Test end-to-end della condivisione read-only.
 *
 *   node scripts/test-share.js
 *
 * Avvia il server vero (nessun mock di Express) in entrambe le modalità:
 *   - legacy   → file JSON, requireAuth no-op
 *   - supabase → stub in-memory del client Postgres + auth
 * e verifica il flusso completo più i controlli di autorizzazione.
 *
 * Niente framework: assert + due processi figli, uno per modalità.
 */
const assert = require("assert");
const path   = require("path");
const fs     = require("fs");

const SERVER   = path.join(__dirname, "../server/server.js");
const SUPA_MOD = path.join(__dirname, "../server/supabase.js");
const SHARE_FILE = path.join(__dirname, "../data/share.json");

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

// ── Stub Supabase in-memory ───────────────────────────────────
// Riproduce solo le catene usate da server.js. Il filtro .eq() è applicato
// davvero: se il server dimenticasse un filtro user_id il test lo vedrebbe.
function makeStub() {
  const db = {
    portfolios: [
      { user_id: USER_A, data: { version: 4, totalCash: 1000, assets: [{ id: "x", name: "ETF A" }],
          transactions: [{ id: "t1", date: "2026-01-10", assetKey: "etf-a", type: "buy",
                           quantity: 10, price: 100, fee: 5 }] },
        share_token: null, share_enabled: false },
      { user_id: USER_B, data: { version: 3, totalCash: 7, assets: [{ id: "y", name: "ETF B" }] },
        share_token: null, share_enabled: false },
    ],
    snapshots: [
      { id: "s1", user_id: USER_A, label: "Gen 2026", year: 2026, month: 1,
        total_value: 1000, assets: [], saved_at: "2026-01-31T00:00:00Z" },
      { id: "s2", user_id: USER_B, label: "Gen 2026", year: 2026, month: 1,
        total_value: 7, assets: [], saved_at: "2026-01-31T00:00:00Z" },
    ],
  };

  const builder = (table) => {
    const q = { table, op: null, payload: null, conflict: null, filters: [], head: false };
    const rows = () => db[q.table].filter((r) => q.filters.every(([c, v]) => r[c] === v));

    const run = () => {
      if (q.op === "select") {
        const found = rows();
        return { data: q.head ? null : found, count: found.length, error: null };
      }
      if (q.op === "upsert") {
        const key = q.conflict.split(",");
        const idx = db[q.table].findIndex((r) => key.every((k) => r[k] === q.payload[k]));
        if (idx >= 0) db[q.table][idx] = { ...db[q.table][idx], ...q.payload };
        else db[q.table].push({ data: {}, share_token: null, share_enabled: false, ...q.payload });
        return { data: null, error: null };
      }
      if (q.op === "update") {
        rows().forEach((r) => Object.assign(r, q.payload));
        return { data: null, error: null };
      }
      if (q.op === "delete") {
        const doomed = new Set(rows());
        db[q.table] = db[q.table].filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
      throw new Error(`stub: op non gestita (${q.op})`);
    };

    const api = {
      select: (_cols, opts) => { q.op = "select"; q.head = !!opts?.head; return api; },
      upsert: (payload, opts) => { q.op = "upsert"; q.payload = payload; q.conflict = opts?.onConflict; return api; },
      update: (payload) => { q.op = "update"; q.payload = payload; return api; },
      delete: () => { q.op = "delete"; return api; },
      eq: (col, val) => { q.filters.push([col, val]); return api; },
      order: () => api,
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return api;
  };

  return {
    __db: db,
    from: builder,
    auth: {
      getUser: async (token) => {
        const map = { "tok-A": USER_A, "tok-B": USER_B };
        return map[token]
          ? { data: { user: { id: map[token] } }, error: null }
          : { data: null, error: { message: "invalid" } };
      },
    },
  };
}

// ── Boot del server nel processo figlio ───────────────────────
async function boot(mode, port) {
  process.env.PORT = String(port);
  let stub = null;
  if (mode === "supabase") {
    process.env.SUPABASE_URL = "http://stub.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
    stub = makeStub();
    // Inietta lo stub prima che server.js richieda il modulo reale.
    require.cache[require.resolve(SUPA_MOD)] = {
      id: SUPA_MOD, filename: SUPA_MOD, loaded: true, exports: stub, children: [], paths: [],
    };
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  require(SERVER);
  // listen è sincrono nell'accettare connessioni solo dopo il tick successivo.
  await new Promise((r) => setTimeout(r, 300));
  return stub;
}

const base = (port) => `http://127.0.0.1:${port}`;
async function req(port, path, opts = {}) {
  const res = await fetch(base(port) + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const auth = (tok) => ({ Authorization: `Bearer ${tok}` });
const json = (tok, payload) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(tok ? auth(tok) : {}) },
  body: JSON.stringify(payload),
});

// ── Scenario: modalità Supabase (multi-utente) ────────────────
async function runSupabase(port) {
  console.log("\n▶ Modalità Supabase (multi-utente)");
  const stub = await boot("supabase", port);

  // 1. Il proprietario genera il link
  const created = await req(port, "/api/share", { method: "POST", headers: auth("tok-A") });
  check("POST /api/share autenticato crea il link", () => {
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.enabled, true);
    assert.match(created.body.token, /^[A-Za-z0-9_-]{22,64}$/);
  });
  const token = created.body.token;

  check("il token non è lo user_id né lo contiene", () => {
    assert.notStrictEqual(token, USER_A);
    assert.ok(!token.includes(USER_A.slice(0, 8)));
  });

  check("il token ha almeno 128 bit di entropia", () => {
    // 24 byte casuali → 32 char base64url.
    assert.ok(token.length >= 32, `token troppo corto: ${token.length}`);
  });

  const again = await req(port, "/api/share", { method: "POST", headers: auth("tok-A") });
  check("una seconda POST riusa lo stesso token", () =>
    assert.strictEqual(again.body.token, token));

  check("l'upsert della condivisione non tocca il blob del portafoglio", () => {
    const row = stub.__db.portfolios.find((r) => r.user_id === USER_A);
    assert.strictEqual(row.data.totalCash, 1000);
    assert.strictEqual(row.data.assets.length, 1);
  });

  // 2. Visitatore anonimo apre il link
  const pub = await req(port, `/api/public/${token}`);
  check("GET /api/public/<token> senza login restituisce il portafoglio", () => {
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(pub.body.config.totalCash, 1000);
    assert.strictEqual(pub.body.snapshots.length, 1);
  });

  check("la risposta pubblica non espone user_id né altri dati sensibili", () => {
    const raw = JSON.stringify(pub.body);
    assert.ok(!raw.includes(USER_A), "user_id presente nella risposta");
    assert.ok(!raw.includes("share_token"), "share_token presente nella risposta");
    assert.ok(!raw.includes("user_id"), "chiave user_id presente nella risposta");
  });

  check("il registro movimenti non esce dal link pubblico", () => {
    assert.ok(!("transactions" in pub.body.config), "transactions presente nella risposta");
    assert.ok(!JSON.stringify(pub.body).includes("assetKey"), "movimenti trapelati");
    // …ma il resto del portafoglio deve esserci ancora.
    assert.strictEqual(pub.body.config.assets.length, 1);
  });

  check("togliere i movimenti dalla risposta non li cancella dal database", () => {
    const row = stub.__db.portfolios.find((r) => r.user_id === USER_A);
    assert.strictEqual(row.data.transactions.length, 1);
  });

  check("gli snapshot condivisi sono solo quelli del proprietario", () => {
    assert.deepStrictEqual(pub.body.snapshots.map((s) => s.totalValue), [1000]);
  });

  // 3. Il visitatore non può scrivere: ogni rotta di modifica è protetta
  const writes = [
    ["POST   /api/config",        () => req(port, "/api/config", json(null, { assets: [] }))],
    ["POST   /api/snapshot",      () => req(port, "/api/snapshot", json(null, { label: "X", assets: [], year: 2026, month: 2 }))],
    ["DELETE /api/snapshot/:y/:m", () => req(port, "/api/snapshot/2026/1", { method: "DELETE" })],
    ["DELETE /api/snapshots/all", () => req(port, "/api/snapshots/all", { method: "DELETE" })],
    ["POST   /api/share",         () => req(port, "/api/share", { method: "POST" })],
    ["DELETE /api/share",         () => req(port, "/api/share", { method: "DELETE" })],
    ["GET    /api/config",        () => req(port, "/api/config")],
    ["GET    /api/snapshots",     () => req(port, "/api/snapshots")],
    ["GET    /api/share",         () => req(port, "/api/share")],
  ];
  for (const [name, call] of writes) {
    const r = await call();
    check(`${name} senza token → 401`, () => assert.strictEqual(r.status, 401));
  }

  // Nemmeno con il token di condivisione al posto del JWT.
  const withShareToken = await req(port, "/api/config", json(token, { assets: [] }));
  check("il token di condivisione non vale come JWT (POST /api/config → 401)", () =>
    assert.strictEqual(withShareToken.status, 401));

  check("nessuna scrittura è passata: il portafoglio è intatto", () => {
    const row = stub.__db.portfolios.find((r) => r.user_id === USER_A);
    assert.strictEqual(row.data.assets.length, 1);
    assert.strictEqual(stub.__db.snapshots.length, 2);
  });

  // 4. Un altro utente autenticato non vede i dati di A
  const bConfig = await req(port, "/api/config", { headers: auth("tok-B") });
  check("un altro utente autenticato vede solo il proprio portafoglio", () => {
    assert.strictEqual(bConfig.status, 200);
    assert.strictEqual(bConfig.body.totalCash, 7);
  });

  const bShare = await req(port, "/api/share", { headers: auth("tok-B") });
  check("un altro utente non ottiene il token di condivisione di A", () => {
    assert.strictEqual(bShare.body.enabled, false);
    assert.strictEqual(bShare.body.token, null);
  });

  // 5. Token inesistenti / malformati / vuoti
  const guesses = [
    ["token inesistente ma ben formato", "a".repeat(32)],
    ["token corto",                      "abc"],
    ["token con caratteri non ammessi",   "../../etc/passwd"],
    ["token 'null'",                      "null"],
    ["token 'undefined'",                 "undefined"],
  ];
  for (const [name, t] of guesses) {
    const r = await req(port, `/api/public/${encodeURIComponent(t)}`);
    check(`GET /api/public con ${name} → 404`, () => assert.strictEqual(r.status, 404));
  }

  check("nessun portafoglio con share_token null è raggiungibile", () => {
    // USER_B non ha mai condiviso: la sua riga ha share_token null.
    const row = stub.__db.portfolios.find((r) => r.user_id === USER_B);
    assert.strictEqual(row.share_token, null);
  });

  // 6. Revoca
  const revoked = await req(port, "/api/share", { method: "DELETE", headers: auth("tok-A") });
  check("DELETE /api/share disattiva la condivisione", () => {
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual(revoked.body.enabled, false);
  });

  const afterRevoke = await req(port, `/api/public/${token}`);
  check("dopo la revoca il vecchio link → 404", () =>
    assert.strictEqual(afterRevoke.status, 404));

  const reEnabled = await req(port, "/api/share", { method: "POST", headers: auth("tok-A") });
  check("riattivando si torna allo stesso token", () =>
    assert.strictEqual(reEnabled.body.token, token));

  const afterReEnable = await req(port, `/api/public/${token}`);
  check("riattivato, il link torna a funzionare", () =>
    assert.strictEqual(afterReEnable.status, 200));
}

// ── Scenario: modalità legacy (file JSON) ─────────────────────
async function runLegacy(port) {
  console.log("\n▶ Modalità legacy (file JSON, single-user)");
  const existed = fs.existsSync(SHARE_FILE);
  const backup  = existed ? fs.readFileSync(SHARE_FILE) : null;

  try {
    await boot("legacy", port);

    const created = await req(port, "/api/share", { method: "POST" });
    check("POST /api/share genera il token anche in legacy", () => {
      assert.strictEqual(created.status, 200);
      assert.match(created.body.token, /^[A-Za-z0-9_-]{22,64}$/);
    });
    const token = created.body.token;

    const pub = await req(port, `/api/public/${token}`);
    check("GET /api/public/<token> legge config e snapshot dai file", () => {
      assert.strictEqual(pub.status, 200);
      assert.ok("config" in pub.body);
      assert.ok(Array.isArray(pub.body.snapshots));
    });

    const bad = await req(port, `/api/public/${"z".repeat(32)}`);
    check("token sbagliato → 404 anche in legacy", () =>
      assert.strictEqual(bad.status, 404));

    await req(port, "/api/share", { method: "DELETE" });
    const afterRevoke = await req(port, `/api/public/${token}`);
    check("revoca efficace anche in legacy", () =>
      assert.strictEqual(afterRevoke.status, 404));
  } finally {
    if (backup) fs.writeFileSync(SHARE_FILE, backup);
    else if (fs.existsSync(SHARE_FILE)) fs.unlinkSync(SHARE_FILE);
  }
}

// ── Runner ────────────────────────────────────────────────────
async function main() {
  const mode = process.env.TEST_MODE;
  if (mode === "supabase") return runSupabase(4711);
  if (mode === "legacy")   return runLegacy(4712);

  // Ogni modalità in un processo separato: server.js si può caricare una volta sola.
  const { spawnSync } = require("child_process");
  let failed = false;
  for (const m of ["supabase", "legacy"]) {
    const r = spawnSync(process.execPath, [__filename], {
      stdio: "inherit",
      env: { ...process.env, TEST_MODE: m },
    });
    if (r.status !== 0) failed = true;
  }
  console.log(failed ? "\n✗ Alcuni test sono falliti" : "\n✓ Tutti i test della condivisione sono passati");
  process.exit(failed ? 1 : 0);
}

main().then(
  () => { if (process.env.TEST_MODE) { console.log(`  → ${passed} assert ok`); process.exit(process.exitCode || 0); } },
  (e) => { console.error(e); process.exit(1); },
);
