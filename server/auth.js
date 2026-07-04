// Middleware: verifica il JWT utente e mette l'uuid in req.userId.
// Usa supabase.auth.getUser(token): valida col server Auth, quindi funziona
// sia con firma HS256 (secret condiviso) sia con signing key asimmetriche —
// nessuna assunzione sull'algoritmo.
const supabase = require("./supabase");

module.exports = async function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token mancante" });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Token non valido" });
    req.userId = data.user.id;
    next();
  } catch {
    return res.status(401).json({ error: "Token non valido" });
  }
};
