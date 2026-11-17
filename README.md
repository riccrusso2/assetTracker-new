# 📊 Portfolio Tracker

Dashboard completa per monitorare investimenti finanziari: ETF, azioni, startup, private equity e liquidità.

---

## 🚀 Avvio rapido con Docker

### Prerequisiti
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installato e avviato

### 1. Scarica il progetto
```bash
git clone <url-del-repo>
cd portfolio-tracker
```

### 2. Avvia con un solo comando
```bash
docker compose up --build --remove-orphans
```

### 3. Apri il browser
```
http://localhost:3000
```

La prima build richiede ~3-5 minuti (scarica dipendenze e compila React).
Le volte successive parte in pochi secondi.

---

## 🛑 Fermare l'app
```bash
docker compose down
```

I dati degli snapshot sono salvati in un **volume Docker** e persistono tra i riavvii.

---

## 💾 Backup dei dati

### Snapshot storici (salvati sul server)
Dalla sezione **Overview → Storico prezzi mensile**, clicca **Esporta** per scaricare un file JSON con tutti gli snapshot.

### Configurazione portafoglio (asset, startup, PE)
Dalla sezione **Portafoglio → Configurazione portafoglio**, clicca **Esporta configurazione** per salvare un JSON locale.

Per ripristinare, usa i rispettivi pulsanti **Importa**.

---

## ✨ Funzionalità

| Funzione | Descrizione |
|---|---|
| 📈 **Prezzi live** | Aggiornamento automatico via JustETF (ISIN europei) |
| 🎯 **Ribilanciamento** | Suggerimenti mensili con budget personalizzabile |
| 📷 **Snapshot mensili** | Traccia l'andamento del portafoglio nel tempo |
| 🔮 **Proiezione** | Simulazione scenari pessimistico/base/ottimistico |
| 🛡️ **Metriche rischio** | CAGR, Volatilità, Max Drawdown, Sharpe, Sortino |
| 🏷️ **Asset class custom** | Crea, rinomina e cancella le categorie liberamente |
| 📊 **Export Excel** | Tutte le posizioni in un `.xlsx`: macro-categorie con % sul patrimonio, posizioni con ISIN, % nella categoria, peso attuale e target, foglio startup |
| 💾 **Backup/Restore** | Esporta e importa tutta la configurazione in JSON |
| 🌙 **Dark/Light mode** | Tema scuro e chiaro |

---

## 📁 Struttura del progetto

```
portfolio-tracker/
├── src/              # Frontend React
│   ├── App.js        # Componente principale
│   └── styles.css    # Stili
├── server/
│   └── server.js     # Backend Express (API + serve frontend)
├── public/           # HTML template
├── data/             # Snapshot JSON (creato automaticamente)
├── Dockerfile        # Build multi-stage
├── docker-compose.yml
└── README.md
```

---

## 🔧 Sviluppo locale (senza Docker)

```bash
# Terminale 1 — Backend
cd server && npm install && node server.js

# Terminale 2 — Frontend (hot reload)
npm install && npm start
```

Il frontend gira su `http://localhost:3000` e fa proxy verso il backend su `localhost:10000`.

---

## ❓ FAQ

**I prezzi non si aggiornano?**
Assicurati di aver inserito un ISIN valido (12 caratteri alfanumerici). I prezzi sono presi da JustETF e coprono principalmente ETF europei.

**Come aggiungo un'azione o crypto?**
Aggiungi l'asset e lascia il prezzo manuale (aggiorna il prezzo attuale modificando l'asset). Per ETF con ISIN valido il prezzo è automatico.

**I dati sono al sicuro se aggiorno Docker?**
Sì. Gli snapshot sono in un volume Docker esterno al container. Esegui `docker compose down` (senza `--volumes`) e i dati restano.
