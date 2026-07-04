import { useState } from "react";
import { supabase } from "./supabaseClient";
import { LogIn, UserPlus, CheckCircle } from "lucide-react";

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
    <div className="app dark" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <form onSubmit={submit} className="section-card" style={{ width: 360, maxWidth: "90vw" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div className="logo-mark">PF</div>
          <h1 className="app-title" style={{ fontSize: 20 }}>Portfolio Tracker</h1>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          {mode === "login" ? "Accedi al tuo portafoglio." : "Crea un nuovo account."}
        </p>

        <label className="field-label">Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            className="field-input" autoComplete="email" />
        </label>
        <label className="field-label">Password
          <input type="password" required minLength={6} value={pw} onChange={(e) => setPw(e.target.value)}
            className="field-input" autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>

        {msg && (
          <p style={{ fontSize: 13, marginTop: 4, color: msg.type === "ok" ? "var(--green)" : "var(--red)" }}>
            {msg.text}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}
          style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
          {mode === "login" ? <LogIn size={15} /> : <UserPlus size={15} />}
          {busy ? "Attendere…" : mode === "login" ? "Accedi" : "Registrati"}
        </button>

        <button type="button" className="btn btn-ghost" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMsg(null); }}
          style={{ width: "100%", justifyContent: "center", marginTop: 8, fontSize: 13 }}>
          {mode === "login" ? "Non hai un account? Registrati" : "Hai già un account? Accedi"}
        </button>
      </form>
    </div>
  );
}
