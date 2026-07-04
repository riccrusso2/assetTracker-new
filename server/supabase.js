// Client Supabase lato server con service-role key.
// Bypassa RLS: il backend è codice fidato e filtra sempre per req.userId.
// La service-role key NON deve mai finire nel browser.
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

module.exports = supabase;
