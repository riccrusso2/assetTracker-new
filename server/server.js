require("dotenv").config();
const path = require("path");
const fs   = require("fs");
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const dns     = require("dns");
const https   = require("https");

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
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

// ── File fallback (usato solo in legacy) ──────────────────────
const DATA_DIR       = path.join(__dirname, "../data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const CONFIG_FILE    = path.join(DATA_DIR, "config.json");

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── JustETF price (pubblico, nessun dato utente) ──────────────
app.get("/api/quote", async (req, res) => {
  const isin = req.query.isin;
  if (!isin) return res.status(400).json({ error: "Missing ISIN" });

  const url = `https://www.justetf.com/api/etfs/${isin}/quote?locale=it&currency=EUR&isin=${isin}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`JustETF API error: ${r.status}`);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gold price (pubblico) ─────────────────────────────────────
app.get("/api/gold-price", async (req, res) => {
  try {
    const r = await fetch("https://api.gold-api.com/price/XAU/EUR", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      agent: goldApiAgent,
    });
    if (!r.ok) throw new Error(`gold-api.com error: ${r.status}`);
    const data = await r.json();

    const spotEurPerTroyOz = data.price;
    const spotEurPerGram   = spotEurPerTroyOz / 31.1035; // 1 troy oz = 31.1035 g
    const price18ktPerGram = spotEurPerGram * 0.75;       // 18kt = 75% oro puro

    res.json({
      spotEurPerTroyOz: Math.round(spotEurPerTroyOz * 100) / 100,
      spotEurPerGram:   Math.round(spotEurPerGram   * 100) / 100,
      price18ktPerGram: Math.round(price18ktPerGram * 100) / 100,
      updatedAt: data.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/snapshot", requireAuth, async (req, res) => {
  try {
    const snap = req.body;
    if (!snap || !snap.label || !snap.assets)
      return res.status(400).json({ error: "Dati snapshot non validi" });

    if (useSupabase) {
      const row = {
        user_id: req.userId, label: snap.label, year: snap.year, month: snap.month,
        total_value: snap.totalValue ?? 0, assets: snap.assets,
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
    const existing  = snapshots.findIndex((s) => s.month === snap.month && s.year === snap.year);
    const entry = { ...snap, savedAt: new Date().toISOString() };
    if (existing >= 0) snapshots[existing] = entry;
    else snapshots.push(entry);
    snapshots.sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
    writeJsonAtomic(SNAPSHOTS_FILE, snapshots);
    res.json({ ok: true, total: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/snapshot/:label", requireAuth, async (req, res) => {
  try {
    const label = decodeURIComponent(req.params.label);
    if (useSupabase) {
      const { error } = await supabase
        .from("snapshots").delete().eq("user_id", req.userId).eq("label", label);
      if (error) throw error;
      return res.json({ ok: true });
    }
    writeJsonAtomic(SNAPSHOTS_FILE, readSnapshotsFile().filter((s) => s.label !== label));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
