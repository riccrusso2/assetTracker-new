require("dotenv").config();
const path = require("path");
const fs   = require("fs");
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const dns     = require("dns");
const https   = require("https");
const crypto  = require("crypto");

// Railway/Alpine musl resolver intermittently returns ENOTFOUND for
// api.gold-api.com (no retry on flaky authoritative NS). Resolve that
// host via public DNS; SNI stays the hostname so TLS is unaffected.
const publicResolver = new dns.promises.Resolver();
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);
const goldApiAgent = new https.Agent({
  lookup: (hostname, opts, cb) =>
    publicResolver.resolve4(hostname).then(
      (addrs) =>
        opts && opts.all
          ? cb(null, addrs.map((address) => ({ address, family: 4 })))
          : cb(null, addrs[0], 4),
      (err) => cb(err),
    ),
});

const app = express();

// ── CORS ──────────────────────────────────────────────────────
// `cors()` senza argomenti risponde `Access-Control-Allow-Origin: *` su ogni
// route. L'auth viaggia in un header esplicito e non in un cookie, quindi non
// è un buco CSRF, ma lascia i due proxy prezzi e la route pubblica invocabili
// da qualunque pagina. Con CORS_ORIGIN si restringe all'elenco; senza si resta
// permissivi come prima, per non rompere i deploy già in piedi.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));

app.use(express.json({ limit: "1mb" }));

// Dietro il proxy di Railway/Vercel `req.ip` è l'IP del proxy: senza questo il
// rate limit diventa un contatore unico per tutti. Va acceso solo quando un
// proxy c'è davvero, altrimenti X-Forwarded-For è falsificabile dal client.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));

// ── Log e risposte d'errore ───────────────────────────────────
// L'errore completo resta nei log del server, al client va un messaggio
// generico. Prima `err.message` tornava in chiaro su tutti i percorsi 500,
// route pubbliche comprese: da lì uscivano dettagli di Postgres/PostgREST.
const fail = (res, err, ctx) => {
  console.error(`[${new Date().toISOString()}] ${ctx}:`, err?.stack || err);
  if (!res.headersSent) res.status(500).json({ error: "Errore interno del server" });
};

// ── Rate limit ────────────────────────────────────────────────
// Serve alle route senza auth: `/api/quote` è un proxy verso JustETF che
// chiunque può far girare, e `/api/public/:token` è un oracolo sul token di
// condivisione. Finestra fissa per IP, in memoria.
// ponytail: per istanza, come la cache prezzi. Con più repliche il limite
// effettivo si moltiplica — a quel punto serve uno store condiviso.
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map();
const rateLimit = (name, max) => (req, res, next) => {
  const now = Date.now();
  const key = `${name}:${req.ip}`;
  const hit = rateHits.get(key);
  if (!hit || now - hit.start >= RATE_WINDOW_MS) {
    rateHits.set(key, { start: now, n: 1 });
    return next();
  }
  if (++hit.n > max) {
    res.set("Retry-After", String(Math.ceil((hit.start + RATE_WINDOW_MS - now) / 1000)));
    return res.status(429).json({ error: "Troppe richieste, riprova tra poco" });
  }
  next();
};
// La mappa cresce con gli IP visti: si spazza a ogni finestra.
// unref() perché non deve tenere vivo il processo (i test lo avviano e chiudono).
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, v] of rateHits) if (v.start < cutoff) rateHits.delete(k);
}, RATE_WINDOW_MS).unref();

// ── Modalità ──────────────────────────────────────────────────
// Supabase configurato  → multi-utente (auth JWT + Postgres).
// Env mancanti          → legacy single-user (file JSON), come prima.
// Il fallback garantisce che ogni step resti funzionante.
const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let supabase = null;
let requireAuth = (req, _res, next) => next(); // no-op in legacy

if (useSupabase) {
  supabase    = require("./supabase");
  requireAuth = require("./auth");
  console.log("🔐 Mode: Supabase (multi-user)");
} else {
  console.log("📁 Mode: legacy file (single-user)");
}

// ── Health (pubblico, nessun dato utente) ─────────────────────
// Senza auth di proposito: è il probe del container. Prima puntava su
// /api/snapshots, che in modo Supabase risponde 401 → istanza unhealthy.
app.get("/health", (_req, res) =>
  res.json({ ok: true, mode: useSupabase ? "supabase" : "legacy" }));

// ── Cache prezzi ──────────────────────────────────────────────
// I due proxy sono pubblici e ogni client li interroga a ogni refresh
// (N asset ogni 15 min): un TTL breve taglia le chiamate a monte e riduce
// l'esposizione del proxy aperto.
// ponytail: Map in memoria, muore col processo e vale per istanza. Con più
// repliche serve una cache condivisa (Redis) o un TTL sul CDN.
const PRICE_TTL_MS = 5 * 60_000;
const PRICE_CACHE_MAX = 500;
const priceCache = new Map();
async function cachedPrice(key, fn) {
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.t < PRICE_TTL_MS) return hit.v;
  const v = await fn();
  // Sfratto della voce più vecchia invece di svuotare tutto. Le chiavi
  // arrivano da fuori (l'ISIN è nella query): con `clear()` bastavano ~500
  // richieste con ISIN inventati per buttare via anche il prezzo dell'oro e
  // rimandare a monte ogni richiesta legittima successiva.
  // Map itera in ordine d'inserimento: la prima chiave è la più vecchia.
  priceCache.delete(key);
  while (priceCache.size >= PRICE_CACHE_MAX) {
    priceCache.delete(priceCache.keys().next().value);
  }
  priceCache.set(key, { t: Date.now(), v });
  return v;
}

// ── File fallback (usato solo in legacy) ──────────────────────
const DATA_DIR       = path.join(__dirname, "../data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const CONFIG_FILE    = path.join(DATA_DIR, "config.json");
const SHARE_FILE     = path.join(DATA_DIR, "share.json");

if (!useSupabase) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SNAPSHOTS_FILE)) fs.writeFileSync(SNAPSHOTS_FILE, "[]");
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function readSnapshotsFile() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8")); }
  catch { return []; }
}

// Mappa riga DB → forma attesa dal client (invariata dai tempi dei file).
const toClientSnap = (r) => ({
  label: r.label, month: r.month, year: r.year,
  totalValue: r.total_value, assets: r.assets, savedAt: r.saved_at,
});

// ── Config portafoglio ────────────────────────────────────────
app.get("/api/config", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase
        .from("portfolios").select("data").eq("user_id", req.userId).maybeSingle();
      if (error) throw error;
      return res.json(data?.data ?? null);
    }
    if (!fs.existsSync(CONFIG_FILE)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch (err) {
    fail(res, err, "GET /api/config");
  }
});

app.post("/api/config", requireAuth, async (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || !Array.isArray(cfg.assets))
      return res.status(400).json({ error: "Config non valida" });

    if (useSupabase) {
      const { savedAt, ...data } = cfg; // updated_at lo gestisce il trigger
      const { error } = await supabase
        .from("portfolios").upsert({ user_id: req.userId, data }, { onConflict: "user_id" });
      if (error) throw error;
      return res.json({ ok: true });
    }
    writeJsonAtomic(CONFIG_FILE, { ...cfg, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "POST /api/config");
  }
});

// ── Condivisione read-only ────────────────────────────────────
// Il link pubblico usa un token opaco (192 bit, base64url) e mai lo user_id.
// `enabled` separa "token esistente" da "condivisione attiva": revocare e
// riattivare non cambia lo schema né invalida la logica del client.
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const newToken = () => crypto.randomBytes(24).toString("base64url"); // 32 char

function readShareFile() {
  try { return JSON.parse(fs.readFileSync(SHARE_FILE, "utf8")); }
  catch { return { token: null, enabled: false }; }
}

// Stato corrente della condivisione (solo proprietario).
app.get("/api/share", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase
        .from("portfolios").select("share_token, share_enabled")
        .eq("user_id", req.userId).maybeSingle();
      if (error) throw error;
      const enabled = !!(data?.share_enabled && data?.share_token);
      return res.json({ enabled, token: enabled ? data.share_token : null });
    }
    const s = readShareFile();
    res.json({ enabled: !!(s.enabled && s.token), token: s.enabled ? s.token : null });
  } catch (err) {
    fail(res, err, "GET /api/share");
  }
});

// Attiva la condivisione: riusa il token esistente, altrimenti ne genera uno.
app.post("/api/share", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { data: row, error } = await supabase
        .from("portfolios").select("share_token").eq("user_id", req.userId).maybeSingle();
      if (error) throw error;
      const token = row?.share_token || newToken();
      // Payload senza `data`: l'upsert aggiorna solo le colonne passate,
      // quindi il blob del portafoglio resta intatto.
      const { error: upErr } = await supabase.from("portfolios").upsert(
        { user_id: req.userId, share_token: token, share_enabled: true },
        { onConflict: "user_id" },
      );
      if (upErr) throw upErr;
      return res.json({ enabled: true, token });
    }
    const s = readShareFile();
    const token = s.token || newToken();
    writeJsonAtomic(SHARE_FILE, { token, enabled: true });
    res.json({ enabled: true, token });
  } catch (err) {
    fail(res, err, "POST /api/share");
  }
});

// Revoca: il link smette di funzionare, il token resta per riattivarlo.
app.delete("/api/share", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { error } = await supabase
        .from("portfolios").update({ share_enabled: false }).eq("user_id", req.userId);
      if (error) throw error;
      return res.json({ enabled: false, token: null });
    }
    const s = readShareFile();
    writeJsonAtomic(SHARE_FILE, { token: s.token, enabled: false });
    res.json({ enabled: false, token: null });
  } catch (err) {
    fail(res, err, "DELETE /api/share");
  }
});

// Vista pubblica: nessuna auth, sola lettura, nessun dato oltre al portafoglio.
// Il formato del token è validato prima della query, così un token vuoto o
// malformato non può mai matchare righe con share_token null.
// Il registro movimenti non esce mai dal link pubblico: dice quando e a quanto
// si è comprato e venduto, cioè molto più di quanto si intende condividere
// mostrando il portafoglio. Si toglie qui, non nel frontend, perché il confine
// è l'API.
const publicConfig = (cfg) => {
  if (!cfg || typeof cfg !== "object") return cfg ?? null;
  const { transactions, ...rest } = cfg;
  return rest;
};

app.get("/api/public/:token", rateLimit("public", 60), async (req, res) => {
  const token = req.params.token;
  const notFound = () => res.status(404).json({ error: "Link non valido o non più attivo" });
  if (!TOKEN_RE.test(token)) return notFound();

  try {
    if (useSupabase) {
      const { data: row, error } = await supabase
        .from("portfolios").select("user_id, data, share_enabled")
        .eq("share_token", token).maybeSingle();
      if (error) throw error;
      if (!row || !row.share_enabled) return notFound();

      const { data: snaps, error: snapErr } = await supabase
        .from("snapshots").select("*").eq("user_id", row.user_id)
        .order("year", { ascending: true }).order("month", { ascending: true });
      if (snapErr) throw snapErr;

      // user_id resta lato server: la risposta contiene solo i dati del portafoglio.
      return res.json({ config: publicConfig(row.data), snapshots: (snaps || []).map(toClientSnap) });
    }

    const share = readShareFile();
    if (!share.enabled || !share.token || share.token !== token) return notFound();
    const config = fs.existsSync(CONFIG_FILE)
      ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
      : null;
    res.json({ config: publicConfig(config), snapshots: readSnapshotsFile() });
  } catch (err) {
    fail(res, err, "GET /api/public/:token");
  }
});

// ── JustETF price (pubblico, nessun dato utente) ──────────────
// L'ISIN finisce dentro l'URL a monte e nella chiave di cache: va validato qui
// e non solo nel client, che è solo uno dei possibili chiamanti.
const ISIN_RE = /^[A-Z0-9]{12}$/;

app.get("/api/quote", rateLimit("quote", 60), async (req, res) => {
  const isin = String(req.query.isin || "").trim().toUpperCase();
  if (!isin) return res.status(400).json({ error: "Missing ISIN" });
  if (!ISIN_RE.test(isin)) return res.status(400).json({ error: "ISIN non valido" });

  const url = `https://www.justetf.com/api/etfs/${isin}/quote?locale=it&currency=EUR&isin=${isin}`;
  try {
    res.json(await cachedPrice(`quote:${isin}`, async () => {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`JustETF API error: ${r.status}`);
      return r.json();
    }));
  } catch (err) {
    fail(res, err, `GET /api/quote isin=${isin}`);
  }
});

// ── Gold price (pubblico) ─────────────────────────────────────
app.get("/api/gold-price", rateLimit("gold", 30), async (req, res) => {
  try {
    res.json(await cachedPrice("gold", async () => {
      const r = await fetch("https://api.gold-api.com/price/XAU/EUR", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        agent: goldApiAgent,
      });
      if (!r.ok) throw new Error(`gold-api.com error: ${r.status}`);
      const data = await r.json();

      const spotEurPerTroyOz = data.price;
      const spotEurPerGram   = spotEurPerTroyOz / 31.1035; // 1 troy oz = 31.1035 g
      const price18ktPerGram = spotEurPerGram * 0.75;       // 18kt = 75% oro puro

      return {
        spotEurPerTroyOz: Math.round(spotEurPerTroyOz * 100) / 100,
        spotEurPerGram:   Math.round(spotEurPerGram   * 100) / 100,
        price18ktPerGram: Math.round(price18ktPerGram * 100) / 100,
        updatedAt: data.updatedAt,
      };
    }));
  } catch (err) {
    fail(res, err, "GET /api/gold-price");
  }
});

// ── Snapshots ─────────────────────────────────────────────────
app.get("/api/snapshots", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase
        .from("snapshots").select("*").eq("user_id", req.userId)
        .order("year", { ascending: true }).order("month", { ascending: true });
      if (error) throw error;
      return res.json(data.map(toClientSnap));
    }
    res.json(readSnapshotsFile());
  } catch (err) {
    fail(res, err, "GET /api/snapshots");
  }
});

app.post("/api/snapshot", requireAuth, async (req, res) => {
  try {
    const snap = req.body;
    if (!snap || !snap.label || !Array.isArray(snap.assets))
      return res.status(400).json({ error: "Dati snapshot non validi" });
    // year/month sono la chiave dell'upsert e non erano controllati: in
    // Supabase un mese fuori range diventava un 500 dal check di Postgres, e in
    // legacy `findIndex` con undefined === undefined faceva combaciare la prima
    // riga altrettanto malformata, sovrascrivendo uno snapshot estraneo.
    const year = Number(snap.year), month = Number(snap.month);
    if (!Number.isInteger(year) || year < 1990 || year > 2200 ||
        !Number.isInteger(month) || month < 1 || month > 12)
      return res.status(400).json({ error: "Anno o mese non validi" });

    if (useSupabase) {
      const row = {
        user_id: req.userId, label: snap.label, year, month,
        total_value: snap.totalValue ?? 0, assets: snap.assets,
        // Senza questo l'upsert lascia saved_at al valore del primo insert:
        // la riga viene aggiornata ma sembra vecchia di mesi.
        saved_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("snapshots").upsert(row, { onConflict: "user_id,year,month" });
      if (error) throw error;
      const { count } = await supabase
        .from("snapshots").select("*", { count: "exact", head: true }).eq("user_id", req.userId);
      return res.json({ ok: true, total: count });
    }

    // legacy file: upsert per mese/anno
    const snapshots = readSnapshotsFile();
    const existing  = snapshots.findIndex((s) => s.month === month && s.year === year);
    const entry = { ...snap, year, month, savedAt: new Date().toISOString() };
    if (existing >= 0) snapshots[existing] = entry;
    else snapshots.push(entry);
    snapshots.sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
    writeJsonAtomic(SNAPSHOTS_FILE, snapshots);
    res.json({ ok: true, total: snapshots.length });
  } catch (err) {
    fail(res, err, "POST /api/snapshot");
  }
});

// Si cancella per (anno, mese), la chiave unique dello schema. Prima era per
// label, che unique non è: due snapshot con la stessa etichetta sparivano
// insieme.
app.delete("/api/snapshot/:year/:month", requireAuth, async (req, res) => {
  try {
    const year  = Number(req.params.year);
    const month = Number(req.params.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Anno o mese non validi" });
    }
    if (useSupabase) {
      const { error } = await supabase
        .from("snapshots").delete()
        .eq("user_id", req.userId).eq("year", year).eq("month", month);
      if (error) throw error;
      return res.json({ ok: true });
    }
    writeJsonAtomic(SNAPSHOTS_FILE,
      readSnapshotsFile().filter((s) => !(s.year === year && s.month === month)));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "DELETE /api/snapshot/:year/:month");
  }
});

app.delete("/api/snapshots/all", requireAuth, async (req, res) => {
  try {
    if (useSupabase) {
      const { error } = await supabase.from("snapshots").delete().eq("user_id", req.userId);
      if (error) throw error;
      return res.json({ ok: true });
    }
    writeJsonAtomic(SNAPSHOTS_FILE, []);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "DELETE /api/snapshots/all");
  }
});

// ── Serve React build (solo se presente: locale sì, Railway no) ──
const BUILD_DIR = path.join(__dirname, "../build");
if (fs.existsSync(BUILD_DIR)) {
  app.use(express.static(BUILD_DIR));
  app.get("*", (req, res) => res.sendFile(path.join(BUILD_DIR, "index.html")));
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
