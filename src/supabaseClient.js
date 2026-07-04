import { createClient } from "@supabase/supabase-js";

// Chiavi pubbliche dal build env (Vercel / .env.local).
const url  = process.env.REACT_APP_SUPABASE_URL;
const anon = process.env.REACT_APP_SUPABASE_ANON_KEY;

// Se le env non sono configurate, resta null: l'app gira in modalità
// "legacy" single-user (comportamento attuale con file JSON), così ogni
// step resta funzionante anche prima che Supabase sia pronto.
export const supabase = url && anon ? createClient(url, anon) : null;
