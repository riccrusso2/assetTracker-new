# Migrazione Portfolio Tracker → SaaS multi-utente

Documento di handoff per continuare il lavoro in un'altra sessione.
Descrive **obiettivo**, **cosa è stato fatto (Fasi 1–8)**, **cosa manca (Fasi 9–12)**,
decisioni architetturali, file toccati e come testare.

---

## 1. Obiettivo

Trasformare una dashboard di investimenti (React + Node.js + file JSON, single-user
locale) in un prodotto SaaS web multi-utente, mantenendo il progetto **funzionante
e compilabile ad ogni step**, senza riscritture del cuore applicativo.

Caratteristiche finali volute:
- App web professionale, ogni utente ha il proprio account e vede solo i propri dati.
- Nessun file JSON modificabile a mano.
- Dati in PostgreSQL via **Supabase**; auth via **Supabase Auth**; **RLS** attiva.
- Onboarding iniziale + pagina Settings configurabile via UI.
- Deploy frontend su **Vercel**, backend su **Railway** (o Render).
- Architettura pronta per **Stripe** in futuro. Tutti servizi in **free tier** (fase test).

Modalità di lavoro concordata: piccoli commit logici, uno step alla volta, conferma
dell'utente prima di procedere allo step successivo. Codice completo (no pseudocodice).

---

## 2. Architettura target

```
Browser (React su Vercel)
  ├─ 1. Auth diretta con supabase-js (login/signup) → ottiene JWT
  └─ 2. Chiamate API con header Authorization: Bearer <JWT>
        ↓
Backend Node/Express (Railway)
  ├─ middleware verifica JWT (supabase.auth.getUser) → req.userId
  ├─ query Postgres via service-role key, sempre filtrate per user_id
  └─ proxy prezzi JustETF / gold-api (pubblici, invariati)
        ↓
Supabase (Postgres + Auth + RLS)
```

**Decisione dati (presa e confermata dall'utente):** il config del portafoglio è
salvato come **singola colonna JSONB per utente** (non normalizzato). Stessa forma
dell'attuale `config.json` → rischio migrazione ~zero. Gli snapshot invece sono
righe in tabella dedicata (erano già una lista di record). Normalizzazione piena
scartata (YAGNI, viola "non riscrivere").

**Principio chiave usato ovunque: fallback simmetrico.**
- Se le env Supabase NON sono configurate → frontend e backend girano in modalità
  "legacy" single-user con file JSON (comportamento originale).
- Se le env SONO configurate → auth JWT + Postgres + isolamento per utente.
- Questo garantisce che ogni fase resti funzionante senza bisogno delle chiavi.

---

## 3. Stato attuale della roadmap

| Fase | Descrizione | Stato |
|------|-------------|-------|
| 1 | Analisi completa del progetto | ✅ Fatto |
| 2 | Progettazione nuova architettura | ✅ Fatto |
| 3 | Schema PostgreSQL | ✅ Fatto (SQL scritto) |
| 4 | Configurazione Supabase | ✅ Guida + `.env.example` scritti (setup dashboard da fare dall'utente) |
| 5 | Migrazione dati JSON → DB | ✅ Script scritto (da lanciare quando l'utente ha account+chiavi) |
| 6 | Supabase Auth (frontend) | ✅ Fatto |
| 7 | Adeguamento API Node | ✅ Fatto |
| 8 | Aggiornamento frontend React | ✅ Fatto |
| 9 | Onboarding primo avvio | ✅ Fatto (CTA welcome apre il modale primo asset) |
| 10 | Pagina Settings | ✅ Fatto (tab Impostazioni; valori per-utente nel blob) |
| 11 | Testing completo | ⬜ DA FARE (richiede setup cloud + test manuale e2e) |
| 12 | Deploy (Vercel + Railway) | ⬜ DA FARE (richiede account cloud) |

**Nota:** i passaggi manuali su dashboard Supabase (creare progetto, eseguire lo
schema SQL, prendere le chiavi, creare l'account, lanciare lo script di migrazione)
NON risultano ancora eseguiti/confermati dall'utente. Il codice è pronto; le env e
il setup cloud vanno completati per testare il path autenticato end-to-end.

---

## 4. Cosa è stato fatto — dettaglio per file

### Nuovi file
| File | Ruolo |
|------|-------|
| `supabase/schema.sql` | Tabelle `portfolios` (user_id PK + `data jsonb`) e `snapshots` (righe, UNIQUE(user_id,year,month)); trigger `updated_at`; RLS su tutte le operazioni. Idempotente. |
| `.env.example` | Template env frontend (REACT_APP_SUPABASE_URL/ANON_KEY, REACT_APP_API_URL). |
| `server/.env.example` | Template env backend (SUPABASE_URL, SERVICE_ROLE_KEY, JWT_SECRET, PORT). |
| `scripts/migrate.js` | One-off: carica `data/config.json` + `data/snapshots.json` in Supabase sotto un `user_id`. Upsert idempotente, con auto-verifica conteggi. |
| `src/supabaseClient.js` | Client browser; `null` se env mancanti (→ legacy). |
| `src/Auth.jsx` | Schermata login/registrazione (riusa le classi CSS esistenti). |
| `src/AuthGate.jsx` | Decide cosa montare: legacy `App` / schermata `Auth` / `App` con session. |
| `src/api.js` | `apiFetch(path, opts)`: aggiunge base URL (REACT_APP_API_URL) + header Authorization dal token di sessione. |
| `server/supabase.js` | Client service-role (bypassa RLS, solo lato server). |
| `server/auth.js` | Middleware `requireAuth`: verifica JWT con `supabase.auth.getUser(token)`, setta `req.userId`. |

### File modificati
| File | Modifica |
|------|----------|
| `src/index.js` | Monta `<AuthGate />` invece di `<App />`. |
| `src/App.js` | Firma `App({ session })`; 11 `fetch("/api/...")` → `apiFetch`; bottone logout in header con email utente; import di `apiFetch`, `supabase`, icona `LogOut`. |
| `server/server.js` | Riscritto con doppio path: se `useSupabase` → auth + query Postgres; altrimenti → file JSON legacy. Proxy prezzi invariati. Serve `build/` solo se la cartella esiste. `require("dotenv").config()`. |
| `package.json` (root) | +`@supabase/supabase-js`. |
| `server/package.json` | +`@supabase/supabase-js`, +`dotenv`. |

### Endpoint backend (contratto invariato per il client)
- `GET/POST /api/config` — richiede JWT in modalità Supabase; legge/scrive il blob per utente.
- `GET /api/snapshots`, `POST /api/snapshot`, `DELETE /api/snapshot/:label`, `DELETE /api/snapshots/all` — richiedono JWT; scoped per utente. `toClientSnap()` rimappa le colonne DB (`total_value`→`totalValue`, `saved_at`→`savedAt`) alla forma attesa dal frontend.
- `GET /api/quote?isin=`, `GET /api/gold-price` — **pubblici**, invariati (nessun dato utente).

---

## 5. Modello dati (riferimento)

Blob `portfolios.data` (JSONB) = stessa forma di `config.json`:
```
{ version, totalCash, assets[], startups[], assetClasses[], goldEtf, physGold }
```
- `assets[]`: `{id, name, identifier(ISIN), quantity, costBasis, targetWeight, assetClass, currency, targetOnTotal, lastPrice, lastUpdated}`
- `startups[]`: `{id, name, invested, fee}`
- `goldEtf`: `{id, name, identifier, quantity, costBasis, lastPrice, lastUpdated, targetWeight, assetClass, manual}`
- `physGold`: `{grams, pricePerGram18kt, lastUpdated, manualOverride}`

Righe `snapshots`: `{id, user_id, label, year, month, total_value, assets jsonb, saved_at}`
dove `assets = [{id, name, price, quantity, value}]`.

---

## 6. Come completare il setup cloud (prerequisito per testare il path auth)

1. Crea progetto Supabase (regione EU/Frankfurt).
2. SQL Editor → incolla ed esegui `supabase/schema.sql`. Verifica tabelle `portfolios` e `snapshots`.
3. Settings → API: copia Project URL, `anon` key, `service_role` key. Settings → API → JWT: copia JWT Secret.
4. Authentication → Settings → **disattiva "Confirm email"** in fase test (login immediato).
5. `cp .env.example .env.local` (frontend) e `cp server/.env.example server/.env` (backend); riempi i valori.
6. Migrazione dati:
   - Authentication → Users → Add user (email+password), copia lo **User UID**.
   - `cd server && npm install @supabase/supabase-js dotenv` (se non già fatto).
   - Dalla root: `MIGRATE_USER_ID=<uuid> node scripts/migrate.js`.
   - Output atteso: portfolio + N snapshot caricati, verifica conteggi OK.

**Sicurezza:** `service_role` key e JWT secret sono segreti → solo `server/.env` (git-ignored),
mai nel browser, mai committati, mai incollati in chat.

---

## 7. Come testare

**Legacy (senza env, stato di default):**
```
npm run build && npm start        # server su :10000, serve anche il build
# App parte senza login, legge i file JSON. Deve funzionare come prima.
```

**Auth (con env configurate):**
```
# backend: cd server && node server.js  → deve loggare "🔐 Mode: Supabase (multi-user)"
# frontend: npm start (con .env.local)   → deve comparire la schermata di login
# login → dashboard con i dati migrati; logout in alto a destra.
```
Verifica isolamento: crea un secondo utente, controlla che NON veda i dati del primo.

Build verificato compilante (solo warning ESLint preesistenti su exhaustive-deps in App.js,
NON introdotti da questa migrazione).

---

## 8. Cosa manca — Fasi 9–12

### Fase 9 — Onboarding ✅ FATTO
La welcome-card (`renderOverview`, ramo `isEmpty`) resta, ma il CTA "Inizia ad
aggiungere asset" ora apre direttamente il modale primo asset (`setAssetModal({})`)
oltre a spostarsi sulla tab Portafoglio. Nessuna nuova logica dati; l'auto-save crea
la riga `portfolios` alla prima modifica. Wizard multi-step completo scartato (YAGNI):
il modale esistente copre l'inserimento guidato.

### Fase 10 — Pagina Settings ✅ FATTO
- Nuova tab **"Impostazioni"** (`renderSettings`), voce in `TABS`.
- `STARTUP_ABBONAMENTO` rimosso; introdotto `settings` per-utente (`DEFAULT_SETTINGS`,
  `STORAGE_KEYS.SETTINGS`), salvato nel blob `config.data` (nessuna modifica backend:
  il blob è pass-through).
- Campi editabili: abbonamento startup, budget mensile default, e i 3 default proiezione
  (rendimento %, investimento mensile, anni). Modificare un default aggiorna anche il
  controllo live corrispondente.
- Load: `cfg.settings` viene mergiato su `DEFAULT_SETTINGS` e fa da seed ai controlli
  proiezione/budget. Save: `settings` incluso nel POST `/api/config` + nelle deps auto-save.
- Gestione asset class già coperta dal modale esistente (rimando nella tab).

### Fase 11 — Testing completo
- Test manuale end-to-end del path auth (login, isolamento multi-utente, RLS).
- Verificare i due proxy prezzi in prod (CORS con dominio Vercel).
- `src/rebalance.test.js` (Jest) esiste già per la logica pura → deve restare verde.
- Controllare i warning `react-hooks/exhaustive-deps` in `App.js` (righe ~812, 845, 1035, 1195):
  preesistenti, non bloccanti, ma da valutare.

### Fase 12 — Deploy
- **Frontend su Vercel:** collega repo, imposta le 3 env `REACT_APP_*`, build command `react-scripts build`, output `build/`.
- **Backend su Railway:** deploy della cartella `server/` (o repo con start `node server/server.js`), imposta env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `PORT`. Su Railway non c'è `build/` → il serve statico viene saltato (previsto).
- Impostare `REACT_APP_API_URL` (Vercel) = URL pubblico Railway.
- Riabilitare "Confirm email" su Supabase prima di aprire a utenti reali.
- Note free tier: Render free va in sleep dopo 15 min inattività; Railway ha ~5$ credito/mese; Supabase free = 500MB DB. Sufficiente per fase test.

---

## 9. Gotcha / punti d'attenzione

- **Transizione 7↔8:** con env Supabase attive, il backend esige il token e il frontend
  lo manda: è un cutover accoppiato. Senza env, tutto resta legacy. Non esiste uno stato
  intermedio rotto finché non si attivano le env a metà.
- **`localStorage`** non è più la fonte di verità: resta cache offline + storage token
  (gestito da supabase-js). Le chiavi `pf.*` sono cache read-through.
- **Path relativi:** tutte le chiamate passano ora da `apiFetch`, quindi in prod servono
  `REACT_APP_API_URL` corretto, altrimenti il frontend Vercel chiamerebbe se stesso.
- **`getUser` per richiesta:** una chiamata di rete a Supabase Auth per ogni richiesta API
  autenticata. Ok a bassa scala; se in futuro serve throughput, passare a verifica firma
  JWT locale (attenzione all'algoritmo: HS256 secret vs signing key asimmetriche).
- **`rebalance.js`** (logica pura) e tutti i calcoli/grafici sono **intatti**: la migrazione
  ha aggiunto un guscio auth + swap dello storage, senza toccare il dominio.
- **Server già in esecuzione su :10000** durante lo sviluppo: attenzione a conflitti di porta
  quando si testa (usare PORT diverso o killare il processo).
