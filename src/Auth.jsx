import { useState } from "react";
import { supabase } from "./supabaseClient";
import { LogIn, UserPlus, LineChart, Target, Share2 } from "lucide-react";

// Schermata login / registrazione. Usata solo quando Supabase è configurato
// e non c'è sessione attiva (vedi AuthGate).
export default function Auth() {
  const [mode,  setMode]  = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [pw,    setPw]    = useState("");
  const [msg,   setMsg]   = useState(null);
  const [busy,  setBusy]  = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { error } =
        mode === "login"
          ? await supabase.auth.signInWithPassword({ email, password: pw })
          : await supabase.auth.signUp({ email, password: pw });
      if (error) throw error;
      // Login riuscito → onAuthStateChange nel gate monta l'app.
      // Signup con conferma email disattivata → auto-login, idem.
      if (mode === "signup") {
        setMsg({ type: "ok", text: "Account creato. Se non entri subito, controlla l'email di conferma." });
      }
    } catch (err) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth__aside">
        <div className="brand">
          <span className="mark" aria-hidden="true">A</span>
          <span className="brand__name">AssetTracker</span>
        </div>
        <div>
          <p className="auth__claim">Patrimonio, portafoglio e bilancio mensile in un solo posto.</p>
          <p className="auth__lead">
            ETF, oro, Bitcoin, startup e liquidità con prezzi aggiornati, snapshot mensili
            e il budget da investire calcolato dalle tue entrate e spese.
          </p>
        </div>
        <div className="auth__points">
          <div className="auth__point"><LineChart/> Rendimento, rischio e fisco dallo storico mensile</div>
          <div className="auth__point"><Target/> Ribilanciamento del budget verso i pesi target</div>
          <div className="auth__point"><Share2/> Link di sola lettura da condividere</div>
        </div>
      </aside>

      <main className="auth__main">
        <form onSubmit={submit} className="auth__form">
          <div className="brand mobile-brand">
            <span className="mark" aria-hidden="true">A</span>
            <span className="brand__name">AssetTracker</span>
          </div>
          <h1 className="auth__title">{mode === "login" ? "Accedi" : "Crea un account"}</h1>
          <p className="auth__sub">
            {mode === "login" ? "Accedi al tuo portafoglio." : "Crea un nuovo account."}
          </p>

          <label className="field-label">Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="field-input" autoComplete="email" />
          </label>
          <label className="field-label">Password
            <input type="password" required minLength={6} value={pw} onChange={(e) => setPw(e.target.value)}
              className="field-input" autoComplete={mode === "login" ? "current-password" : "new-password"} />
            {mode === "signup" && <span className="field-hint">Almeno 6 caratteri.</span>}
          </label>

          {msg && (
            <p className={`auth__msg ${msg.type === "ok" ? "auth__msg--ok" : "auth__msg--err"}`} role="alert">
              {msg.text}
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            {busy ? "Attendere…" : mode === "login" ? "Accedi" : "Registrati"}
          </button>

          <p className="auth__switch">
            {mode === "login" ? "Non hai un account? " : "Hai già un account? "}
            <button type="button" className="text-btn" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMsg(null); }}>
              {mode === "login" ? "Registrati" : "Accedi"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
