import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import Auth from "./Auth";
import App from "./App";

// Link pubblico di condivisione: /p/<token>. Niente router dedicato — il
// server serve index.html su qualsiasi path, quindi basta leggere il pathname
// una volta (non cambia senza reload).
const SHARE_PATH_RE = /^\/p\/([A-Za-z0-9_-]{22,64})\/?$/;
const shareToken = SHARE_PATH_RE.exec(window.location.pathname)?.[1] ?? null;

// Decide cosa montare:
//   - Path /p/<token>          → App in sola lettura, senza auth
//   - Supabase non configurato  → App diretta (modalità legacy single-user)
//   - Supabase ok, no sessione  → schermata Auth
//   - Supabase ok, con sessione → App (riceve la session come prop)
export default function AuthGate() {
  const [session, setSession] = useState(null);
  const [ready,   setReady]   = useState(false);

  useEffect(() => {
    if (shareToken || !supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // La vista condivisa precede l'auth: il visitatore non deve mai vedere il login.
  if (shareToken) return <App key={shareToken} shareToken={shareToken} />;
  if (!ready)    return null;             // primo frame: evita flash
  if (!supabase) return <App />;          // legacy: nessuna auth
  if (!session)  return <Auth />;
  // key forza remount al cambio utente: azzera state e cache locale,
  // altrimenti login con altro utente eredita gli asset del precedente.
  return <App key={session.user.id} session={session} />;
}
