import { supabase } from "./supabaseClient";

// Base URL del backend. In prod = URL Railway (REACT_APP_API_URL).
// Vuoto in locale → path relativo, il server serve anche il build.
const API_URL = process.env.REACT_APP_API_URL || "";

// fetch con base URL + header Authorization dal token di sessione Supabase.
// In modalità legacy (supabase null) si comporta come un fetch normale.
export async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${API_URL}${path}`, { ...options, headers });
}
