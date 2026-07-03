const path = require("path");
const fs   = require("fs");
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// ── Data directory ────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, "../data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const CONFIG_FILE    = path.join(DATA_DIR, "config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SNAPSHOTS_FILE)) fs.writeFileSync(SNAPSHOTS_FILE, "[]");

// Atomic write: temp file + rename, so a crash mid-write never corrupts data
function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readSnapshots() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8")); }
  catch { return []; }
}

function writeSnapshots(data) {
  writeJsonAtomic(SNAPSHOTS_FILE, data);
}

// ── Portfolio config persistence ──────────────────────────────
// The whole portfolio state (assets, cash, gold, startups) lives in
// data/config.json — the client auto-saves it, no manual export needed.
app.get("/api/config", (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/config", (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || !Array.isArray(cfg.assets))
      return res.status(400).json({ error: "Config non valida" });
    writeJsonAtomic(CONFIG_FILE, { ...cfg, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── JustETF price endpoint ────────────────────────────────────
app.get("/api/quote", async (req, res) => {
  const isin = req.query.isin;
  if (!isin) return res.status(400).json({ error: "Missing ISIN" });

  const url = `https://www.justetf.com/api/etfs/${isin}/quote?locale=it&currency=EUR&isin=${isin}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`JustETF API error: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gold price endpoint ───────────────────────────────────────
// Calls gold-api.com for XAU/EUR spot price (per troy oz)
// Returns: spotEurPerTroyOz, spotEurPerGram, price18ktPerGram
app.get("/api/gold-price", async (req, res) => {
  try {
    const r = await fetch("https://api.gold-api.com/price/XAU/EUR", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`gold-api.com error: ${r.status}`);
    const data = await r.json();

    // data.price = EUR per troy oz (XAU standard)
    const spotEurPerTroyOz = data.price;
    // 1 troy oz = 31.1035 g  →  price per pure gram (24kt)
    const spotEurPerGram = spotEurPerTroyOz / 31.1035;
    // 18kt = 75% pure gold
    const price18ktPerGram = spotEurPerGram * 0.75;

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

// ── GET /api/snapshots ────────────────────────────────────────
app.get("/api/snapshots", (req, res) => {
  try { res.json(readSnapshots()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/snapshot ────────────────────────────────────────
app.post("/api/snapshot", (req, res) => {
  try {
    const snap = req.body;
    if (!snap || !snap.label || !snap.assets)
      return res.status(400).json({ error: "Dati snapshot non validi" });

    const snapshots = readSnapshots();
    const existing  = snapshots.findIndex(
      (s) => s.month === snap.month && s.year === snap.year
    );
    const entry = { ...snap, savedAt: new Date().toISOString() };

    if (existing >= 0) snapshots[existing] = entry;
    else snapshots.push(entry);

    snapshots.sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month
    );

    writeSnapshots(snapshots);
    res.json({ ok: true, total: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/snapshot/:label ───────────────────────────────
app.delete("/api/snapshot/:label", (req, res) => {
  try {
    const label     = decodeURIComponent(req.params.label);
    const snapshots = readSnapshots().filter((s) => s.label !== label);
    writeSnapshots(snapshots);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/snapshots/all ─────────────────────────────────
app.delete("/api/snapshots/all", (req, res) => {
  try {
    writeSnapshots([]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve React frontend ──────────────────────────────────────
app.use(express.static(path.join(__dirname, "../build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../build", "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));