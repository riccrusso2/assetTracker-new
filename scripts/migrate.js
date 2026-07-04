// One-off: carica data/config.json + data/snapshots.json in Supabase.
// Usa la service-role key (bypassa RLS). Da lanciare UNA volta.
//
// Prerequisiti:
//   1. Account creato in Supabase (Authentication → Users → Add user).
//   2. Copia il suo User UID (uuid).
//   3. server/.env compilato (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
//
// Uso:
//   cd server && npm install @supabase/supabase-js
//   MIGRATE_USER_ID=<uuid> node ../scripts/migrate.js
//
// Idempotente: usa upsert, puoi rilanciarlo.

require("dotenv").config({ path: require("path").join(__dirname, "../server/.env") });
const fs   = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const USER_ID = process.env.MIGRATE_USER_ID;
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!USER_ID)                    throw new Error("Manca MIGRATE_USER_ID (uuid utente Supabase)");
if (!SUPABASE_URL)               throw new Error("Manca SUPABASE_URL in server/.env");
if (!SUPABASE_SERVICE_ROLE_KEY)  throw new Error("Manca SUPABASE_SERVICE_ROLE_KEY in server/.env");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const DATA_DIR = path.join(__dirname, "../data");
const readJson = (f, def) => {
  const p = path.join(DATA_DIR, f);
  if (!fs.existsSync(p)) return def;
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

async function main() {
  // ── portfolios: config.json → 1 riga (blob jsonb) ──
  const config = readJson("config.json", null);
  if (config) {
    // Scarta savedAt: lo gestisce il trigger updated_at.
    const { savedAt, ...data } = config;
    const { error } = await supabase
      .from("portfolios")
      .upsert({ user_id: USER_ID, data }, { onConflict: "user_id" });
    if (error) throw error;
    console.log(`✓ portfolio caricato (assets: ${data.assets?.length ?? 0})`);
  } else {
    console.log("· nessun config.json, salto portfolio");
  }

  // ── snapshots: snapshots.json → N righe ──
  const snaps = readJson("snapshots.json", []);
  if (snaps.length) {
    const rows = snaps.map((s) => ({
      user_id:     USER_ID,
      label:       s.label,
      year:        s.year,
      month:       s.month,
      total_value: s.totalValue ?? 0,
      assets:      s.assets ?? [],
    }));
    const { error } = await supabase
      .from("snapshots")
      .upsert(rows, { onConflict: "user_id,year,month" });
    if (error) throw error;
    console.log(`✓ ${rows.length} snapshot caricati`);
  } else {
    console.log("· nessuno snapshot da caricare");
  }

  // ── verifica: rileggi i conteggi ──
  const { count: pCount } = await supabase
    .from("portfolios").select("*", { count: "exact", head: true }).eq("user_id", USER_ID);
  const { count: sCount } = await supabase
    .from("snapshots").select("*", { count: "exact", head: true }).eq("user_id", USER_ID);
  console.log(`\nVerifica DB → portfolios: ${pCount}, snapshots: ${sCount}`);
  if (pCount < 1) throw new Error("Portfolio non presente dopo migrazione");
}

main().catch((e) => { console.error("✗ Migrazione fallita:", e.message); process.exit(1); });
