import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import Auth from "./Auth";
import App from "./App";

// Decide cosa montare:
//   - Supabase non configurato  → App diretta (modalità legacy single-user)
//   - Supabase ok, no sessione  → schermata Auth
//   - Supabase ok, con sessione → App (riceve la session come prop)
export default function AuthGate() {
  const [session, setSession] = useState(null);
  const [ready,   setReady]   = useState(false);

  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready)    return null;             // primo frame: evita flash
  if (!supabase) return <App />;          // legacy: nessuna auth
  if (!session)  return <Auth />;
  // key forza remount al cambio utente: azzera state e cache locale,
  // altrimenti login con altro utente eredita gli asset del precedente.
  return <App key={session.user.id} session={session} />;
}
