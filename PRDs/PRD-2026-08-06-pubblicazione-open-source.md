# PRD BUILD — Pubblicazione open source di pi-web-ui

Data: 2026-08-06
Ordine dei task: OBBLIGATORIO

## Contesto minimo

pi-web-ui è una web UI locale sopra l'SDK pi (`@earendil-works/pi-coding-agent`): server Node
(`server.mjs`) più frontend in un unico file (`public/index.html`). Oggi è uno strumento personale
Windows-only, in italiano, con dati personali nei file e un server privo di autenticazione. Questa
fase lo rende pubblicabile come progetto open source MIT.

Decisioni già prese, da non rimettere in discussione: UI **interamente in inglese**, nessun
selettore lingua; niente pubblicazione su npm; accesso da rete locale **spento di default** e
protetto da token in cookie `HttpOnly`; Node `>=22`; librerie servite in locale invece che da CDN;
archiviazione chat a 24 ore. Il **refactor modulare di `index.html` è rinviato a una fase separata:
non farlo**. Il push su GitHub non fa parte di questa fase: la storia git resta locale.

## Istruzioni operative (non negoziabili)

Devi lavorare **soltanto** all'interno di questa directory:

```
C:\Users\Mimmo\Desktop\Projects\small-projects\pi-web-ui
```

Nessun file fuori da questo path può essere letto, creato o modificato.

1. **Scegli un solo task** fra quelli con `Stato: TODO`.
   Prendi **il primo** in ordine di numerazione: l'ordine è vincolante, saltare avanti è vietato.
   Se il primo TODO dipende da un task BLOCCATO, fermati e termina l'iterazione senza fare nulla.
   Lavorare su più di un task per iterazione è vietato.
2. Per il contesto: leggi la sezione "Contesto minimo", le `Conclusioni` dei task DONE e — solo
   se serve davvero — la storia dei commit.
3. **Prima di scrivere codice**, metti il task in `Stato: IN CORSO` e salva il file. Poi esegui i
   suoi subtask nell'ordine dato, **spuntando la checkbox di ciascuno appena concluso** e salvando
   il file: se l'iterazione muore a metà, la prossima riparte dai subtask non spuntati.
   Niente refactor fuori scope, niente task o subtask inventati.
4. **Gate sui test.** Al termine del task esegui:
   ```
   npm run verify
   ```
   Il gate esiste a partire dal task 1, che lo costruisce. Nessun servizio esterno richiesto.
   - Se fallisce, correggi e riesegui: massimo **3 tentativi**.
   - Al terzo fallimento: **non committare**, `Stato: BLOCCATO`, scrivi in `Conclusioni` cosa hai
     provato e l'ostacolo, termina l'iterazione.
   - **Mai committare con test rossi o codice che non compila.**
5. A suite verde: `Stato: READY TO COMMIT`, compila `Conclusioni` (max 150 parole; fino a 400 se
   BLOCCATO o con ostacoli: sono l'unica memoria che l'iterazione dopo avrà di te).
   Non toccare le sezioni degli altri task.
6. Committa il lavoro (codice, non questo file). Poi recupera l'hash, porta `Stato: DONE` e
   valorizza `Commit`. Solo dopo un commit riuscito un task è DONE.
7. Quando ogni task è `DONE` o `BLOCCATO`, produci come output: `<promise>COMPLETE</promise>`
   Altrimenti non emettere mai quel marcatore.

Stati ammessi: `TODO` · `IN CORSO` · `READY TO COMMIT` · `DONE` · `BLOCCATO`.

---

## Task

### 1. Baseline versionata e gate di verifica

**Stato:** IN CORSO

**Descrizione:** Il progetto non ha né git né test. Crea prima il punto di ritorno, poi il gate che
tutti i task successivi useranno. La baseline va committata **con i file sporchi ancora dentro**:
serve proprio a poter tornare allo stato attuale. Lo script `scripts/verify.mjs` controlla la
sintassi di ogni `.mjs` del progetto (escluso `node_modules`) e poi esegue uno smoke test: avvia
il server su una porta libera scelta dallo script e su host `127.0.0.1`, chiama `GET /api/state`,
pretende HTTP 200, spegne il processo. Exit code diverso da 0 a ogni fallimento.

**File coinvolti:**
- `.gitignore`
- `scripts/verify.mjs` (nuovo)
- `package.json`
- `backup/` (nuova cartella, ignorata da git)

**Strumenti/prerequisiti:** git disponibile a riga di comando. Node >= 22.

**Subtask:**
- [ ] `git init` e `.gitignore` minimo: `node_modules/`, `server.log`, `backup/`, `.sslayer/`
- [ ] Commit di tutto lo stato attuale con messaggio `chore: baseline pre-pubblicazione`
- [ ] Tag `v1.0-baseline` sul commit appena creato
- [ ] `git bundle create backup/v1.0-baseline.bundle --all`
- [ ] Crea `scripts/verify.mjs` come descritto sopra
- [ ] Aggiungi a `package.json` lo script `verify`; sostituisci lo script `test` con `npm run verify`

**Risultato atteso:** `git tag` elenca `v1.0-baseline`; `backup/v1.0-baseline.bundle` esiste e non
è tracciato da git; `npm run verify` termina con exit code 0 e stampa l'esito dei due controlli.

**Avvertenze:** Non usare la porta 3777 nello smoke test: l'utente ha un'istanza attiva su quella
porta e non va disturbata. Il boot del server crea un contesto agente che scrive in
`~/.pi/agent/sessions/`: è un effetto collaterale noto e accettato, non tentare di sopprimerlo.
La baseline contiene dati personali: **non aggiungere mai un remote git in questa fase.**

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 2. Pulizia repo e metadati del pacchetto

**Stato:** TODO

**Descrizione:** Rimuovi dalla repo i file che contengono dati personali o sono materiale morto, e
trasforma `package.json` da scheletro generato in metadati di un pacchetto pubblicabile. `server.mjs`
e `usage-tracker.mjs` sono già puliti da path assoluti e credenziali: non cercarne altrove.
Licenza MIT, autore `Rumi-sketches <rumi.sketches@outlook.com>`, campo `engines` a `>=22`.
Aggiorna la dipendenza `@earendil-works/pi-coding-agent` da `^0.82.0` a `^0.84.0`.

**File coinvolti:**
- `HANDOFF.md`, `public/proto-design.html`, `public/proto-design-2.html`, `public/index.html.bak` (da eliminare)
- `.idea/` (da eliminare)
- `.gitignore`, `package.json`, `package-lock.json`
- `LICENSE` (nuovo)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Elimina i quattro file elencati e la cartella `.idea/`
- [ ] Estendi `.gitignore` con `.idea/`, `*.bak`, `.vscode/`, `.DS_Store`
- [ ] Compila `package.json`: `name`, `description`, `version 1.0.0`, `license: MIT`, `author`, `engines.node: >=22`, `type: module`
- [ ] Crea `LICENSE` con testo MIT, anno 2026, intestatario `Rumi-sketches`
- [ ] Porta la dipendenza dell'SDK a `^0.84.0` ed esegui `npm install`
- [ ] Leggi il CHANGELOG dell'SDK fra 0.82 e 0.84 e correggi eventuali rotture d'API

**Risultato atteso:** i file elencati non esistono più; `git status` è pulito; `npm run verify`
passa con l'SDK 0.84.0 installato; `grep -ri "Mimmo" --exclude-dir=node_modules .` non produce
risultati.

**Avvertenze:** Se il bump dell'SDK rompe delle API, il fix va fatto in questo task: non lasciare
il progetto con una dipendenza aggiornata e un server che non parte.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 3. Blindatura del server contro CSRF e DNS rebinding

**Stato:** TODO

**Descrizione:** Il server accetta oggi qualunque richiesta senza verificare da dove arriva. Poiché
`jsonBody` (`server.mjs:1025`) non controlla il `Content-Type`, un sito web qualsiasi può inviare
POST verso `127.0.0.1:3777` senza preflight CORS e pilotare l'agente. Aggiungi un unico punto di
controllo attraversato da tutte le richieste, prima del routing. Il default di `HOST` passa da
`0.0.0.0` a `127.0.0.1`. Rifiuti con HTTP 403 e corpo JSON `{ error: "forbidden origin" }`.

**File coinvolti:**
- `server.mjs`

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Porta il default di `HOST` (riga 67) a `127.0.0.1`
- [ ] Aggiungi un controllo dell'header `Host`: ammessi solo `localhost` e `127.0.0.1` sulla porta in ascolto
- [ ] Su ogni metodo diverso da GET/HEAD, pretendi `Sec-Fetch-Site: same-origin` oppure un `Origin` che coincide con l'host in ascolto
- [ ] Lascia passare senza `Origin` solo le richieste prive di header `Origin` **e** con `Sec-Fetch-Site: none` (navigazione diretta)
- [ ] Estendi lo smoke test di `scripts/verify.mjs` con un caso negativo: POST con `Origin` estraneo deve dare 403

**Risultato atteso:** `npm run verify` passa, incluso il nuovo caso negativo. Il server risponde
solo su `127.0.0.1`. Una POST con `Origin: https://evil.example` riceve 403. La UI aperta su
`http://localhost:3777` continua a funzionare in tutte le sue parti.

**Avvertenze:** L'SSE su `/api/events` è una GET: non deve essere bloccato. Verifica a mano che
chat, invio prompt, cambio modello e pannello impostazioni funzionino ancora prima di committare.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 4. Accesso da rete locale opzionale, protetto da token

**Stato:** TODO

**Descrizione:** Rendi l'accesso da altri dispositivi una scelta esplicita e autenticata. Nuova
impostazione `lanAccess`, **spenta di default**, salvata lato server accanto agli altri stati della
web UI. Ad attivazione, genera un token con `crypto.randomBytes(32).toString("base64url")` e mostra
in impostazioni l'URL `http://<ip-lan>:3777/?k=<token>`. Il server accetta `?k=` una sola volta:
verifica con `crypto.timingSafeEqual`, imposta un cookie `HttpOnly`, `SameSite=Strict`, `Path=/`, e
reindirizza allo stesso URL **senza** il parametro. Le richieste da `127.0.0.1` restano libere.

**File coinvolti:**
- `server.mjs`
- `public/index.html` (sezione impostazioni)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Persisti `lanAccess` e il token nello stato lato server; genera un token nuovo a ogni attivazione
- [ ] Estendi il controllo del task 3: host non locale ammesso solo se `lanAccess` è attivo e il cookie è valido
- [ ] Implementa la stretta di mano `?k=` → cookie → redirect a URL pulito
- [ ] Aggiungi in impostazioni il toggle, l'URL da copiare, l'IP LAN rilevato e un pulsante "Rigenera token"
- [ ] Scrivi accanto al toggle un avviso esplicito sul rischio di esporre l'agente sulla rete

**Risultato atteso:** con `lanAccess` spento, una richiesta con `Host` pari all'IP LAN riceve 403.
Con l'impostazione attiva e il token corretto la UI si apre da un altro dispositivo e la barra
degli indirizzi non contiene il token. `npm run verify` passa.

**Avvertenze:** Dipende dal task 3, che introduce il punto di controllo da estendere. Il token non
deve mai finire in un log né nella query string dopo la stretta di mano. Attivare `lanAccess`
richiede di rimettere in ascolto il server su `0.0.0.0`: riusa `/api/restart`, già esistente.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 5. Librerie e font serviti in locale

**Stato:** TODO

**Descrizione:** `public/index.html` (righe 11-16) carica marked, highlight.js e i font da jsDelivr
e Google Fonts, senza attributo `integrity`. Per uno strumento locale è insieme un problema di
funzionamento offline, di privacy e di supply chain, su una pagina che pilota un agente. Installa
le librerie come dipendenze e servile dal server. Versioni bersaglio: `marked` 18.x (l'attuale 12
è indietro di sei major), `highlight.js` 11.11.x. Per i font, usa lo stack di sistema già dichiarato
nelle variabili `--font-ui` / `--font-display` / `--font-mono`, eliminando la chiamata a Google.

**File coinvolti:**
- `package.json`
- `server.mjs` (rotta statica per i file di libreria)
- `public/index.html`

**Strumenti/prerequisiti:** rete disponibile per `npm install`.

**Subtask:**
- [ ] `npm i marked@^18 highlight.js@^11.11`
- [ ] Esponi i file necessari dal server sotto un percorso statico dedicato
- [ ] Sostituisci in `index.html` i tag `<script>` e `<link>` verso CDN con i percorsi locali
- [ ] Togli i due `preconnect` e il `link` verso Google Fonts; verifica che i tre stack di font di sistema reggano il layout
- [ ] Verifica il rendering markdown dopo il salto dalla 12 alla 18 di marked: liste, tabelle, blocchi di codice, testo in streaming

**Risultato atteso:** `index.html` non contiene più alcun riferimento a `jsdelivr.net` o
`googleapis.com`. La UI funziona con la rete disattivata. Markdown ed evidenziazione della sintassi
si vedono correttamente nelle risposte dell'agente. `npm run verify` passa.

**Avvertenze:** marked 18 ha cambiato API rispetto alla 12: controlla il punto di rendering
incrementale in `index.html:1228` e dintorni. Se un'opzione non esiste più, adegua la chiamata,
non reintrodurre la versione vecchia.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 6. Avvio con un solo comando

**Stato:** TODO

**Descrizione:** Sostituisci i due script `.vbs` (che fanno scattare gli antivirus e funzionano solo
su Windows) con un launcher in Node puro. `bin/pi-web-ui.mjs` avvia il server, attende che
`/api/state` risponda, apre il browser sull'URL locale e resta in primo piano gestendo Ctrl+C con
uno spegnimento pulito. L'apertura del browser va scritta a mano con `explorer` / `open` /
`xdg-open` secondo `process.platform`: niente dipendenze nuove. Aggiungi lo script opzionale
`scripts/create-shortcut.mjs` che crea lo shortcut sul Desktop su Windows, non invocato in automatico.

**File coinvolti:**
- `bin/pi-web-ui.mjs` (nuovo)
- `scripts/create-shortcut.mjs` (nuovo)
- `package.json`
- `run.vbs`, `stop.vbs` (da eliminare)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Crea `bin/pi-web-ui.mjs` con avvio, attesa della risposta, apertura del browser e spegnimento su SIGINT
- [ ] Aggiungi gli script `start` e `shortcut` a `package.json`
- [ ] Crea `scripts/create-shortcut.mjs`, che esce con un messaggio se la piattaforma non è Windows
- [ ] Elimina `run.vbs` e `stop.vbs`
- [ ] Verifica che `/api/restart` (`server.mjs:1682`) funzioni ancora ora che il padre non è più `cmd.exe`

**Risultato atteso:** `npm start` avvia il server, apre il browser sulla UI e Ctrl+C lo spegne senza
lasciare processi orfani. I due `.vbs` non esistono più. `npm run verify` passa.

**Avvertenze:** `/api/restart` scrive su `server.log` con un descrittore aperto a mano perché il
padre era `cmd.exe` con la redirezione: cambiando launcher quel presupposto cade, verifica che il
riavvio dalla UI funzioni ancora. Se la porta 3777 è occupata, il launcher deve dirlo chiaramente
invece di restare appeso.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 7. Supporto macOS e Linux per le funzioni native

**Stato:** TODO

**Descrizione:** Tre endpoint sono oggi Windows-only. Isolali in un modulo `platform.mjs` con una
funzione per ciascuna operazione e uno switch su `process.platform`. Se il comando previsto non
esiste, la funzione segnala l'indisponibilità invece di lanciare un errore, e la UI nasconde il
pulsante corrispondente. Selettore cartella: PowerShell su Windows (script già presente),
`osascript -e 'choose folder'` su macOS, `zenity --file-selection --directory` su Linux, altrimenti
non disponibile. Apri cartella: `explorer` / `open` / `xdg-open`. Terminale: `cmd start powershell` /
`open -a Terminal` / catena `gnome-terminal`, `konsole`, `xterm`.

**File coinvolti:**
- `platform.mjs` (nuovo)
- `server.mjs` (righe ~104-125, ~1390, ~1398)
- `public/index.html` (pulsanti "Apri in Explorer", terminale, selettore cartella)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Crea `platform.mjs` con `pickFolder`, `openFolder`, `openTerminal` e una funzione che riporta quali sono disponibili
- [ ] Sposta la logica Windows esistente dentro il modulo senza cambiarne il comportamento
- [ ] Aggiungi le varianti macOS e Linux con rilevamento del comando e ritorno di "non disponibile"
- [ ] Esponi le capacità della piattaforma in `GET /api/config` e nascondi nella UI i pulsanti non disponibili
- [ ] Fai sì che il selettore cartella ricada sul campo di testo quando nessun picker nativo esiste

**Risultato atteso:** su Windows le tre funzioni si comportano esattamente come prima. Su una
piattaforma senza i comandi previsti il server non lancia eccezioni e la UI mostra solo i pulsanti
utilizzabili. `npm run verify` passa.

**Avvertenze:** Non è testabile fuori da Windows in questa sessione: il codice per macOS e Linux
deve fallire in modo silenzioso e non bloccante, mai far crollare una richiesta.
Mantieni `windowsHide: true` dove già presente, è innocuo altrove.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 8. Colori dei temi: eliminare i valori scritti a mano

**Stato:** TODO

**Descrizione:** Alcune regole CSS usano colori letterali invece delle variabili di tema, quindi
restano scure anche nel tema chiaro `daylight`. Il caso visibile è la card dei suggerimenti in
`public/index.html:519`, che usa un gradiente `#0d141b → #0a0f15` invece di `var(--card-bg)`. Non
correggere solo quella: sostituisci ogni colore letterale con la variabile corrispondente, o
introduci una variabile nuova definita in tutti e sei i temi quando non ne esiste una adatta.

**File coinvolti:**
- `public/index.html` (blocco `<style>`, righe 17-810)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Correggi `.sugg` (riga 519) usando `var(--card-bg)` e il bordo di tema
- [ ] Correggi gli overlay alle righe 661, 677 e 753, che assumono uno sfondo scuro
- [ ] Correggi `.diffline.add` e la sua controparte per le righe rimosse (righe ~734)
- [ ] Cerca nel blocco `<style>` ogni altro colore esadecimale letterale e valuta se va sostituito
- [ ] Verifica a schermo tutti e sei i temi: chat, sidebar, impostazioni, pannello diff, analytics, lightbox

**Risultato atteso:** con tema `daylight` nessun elemento resta scuro fuori posto, in particolare le
tre card di suggerimento della schermata iniziale. Gli altri cinque temi scuri sono invariati.
`npm run verify` passa.

**Avvertenze:** Le anteprime nelle card di scelta tema e di scelta logo usano di proposito colori
fissi (vedi il commento a riga 385 e la classe `.logo.fixed`): quelle **non** vanno toccate, servono
a mostrare l'aspetto reale di ciascuna opzione.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 9. Archiviazione delle chat come funzione attivabile

**Stato:** TODO

**Descrizione:** Oggi la gestione "chat conclusa" è sempre presente. Trasformala in una funzione
governata da un'unica impostazione `chatArchiving`, **accesa di default**. Quando è spenta,
spariscono tutti i suoi elementi dalla UI e la sidebar torna una lista piatta. Spegnerla **non**
cancella `web-ui-status.json`: nasconde soltanto. Al primissimo avvio in assoluto, e solo allora,
ogni chat non toccata nelle ultime 24 ore passa a stato `done`; subito dopo viene scritto il flag
`firstRunArchivedAt`, che impedisce alla spazzata di ripetersi a ogni riavvio.

**File coinvolti:**
- `server.mjs` (stato chat, righe ~165-180 e ~1426)
- `public/index.html` (righe 265-272, 860-861, 1989, 2016, 2032, 2035)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Aggiungi l'impostazione `chatArchiving` (default acceso) e il flag `firstRunArchivedAt` allo stato lato server
- [ ] Esegui al boot la spazzata a 24 ore, una sola volta, saltandola se il flag esiste o se l'impostazione è spenta
- [ ] A impostazione spenta nascondi: pulsante ✓/↺, filtri "Attive"/"Concluse", gruppo "Concluse", stile spento, etichetta "riaperta", ordinamento delle concluse in fondo
- [ ] Aggiungi in impostazioni il toggle e il pulsante "Archive chats older than 24 hours"
- [ ] Verifica che riaccendere l'impostazione ripristini gli stati salvati in precedenza

**Risultato atteso:** al primo avvio su una installazione senza flag, le chat più vecchie di 24 ore
appaiono spente, in fondo alla lista e restano cliccabili. Un riavvio successivo non archivia più
nulla. Spegnendo l'impostazione la sidebar non mostra più alcuna traccia della funzione.
`npm run verify` passa.

**Avvertenze:** L'età della chat va misurata sull'ultima attività della sessione, non sulla data di
creazione. Il flag va scritto **dopo** che l'archiviazione è andata a buon fine, altrimenti un
errore a metà lascia il lavoro incompiuto e mai più ritentabile.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 10. Attivare provider e modelli dalle impostazioni

**Stato:** TODO

**Descrizione:** Aggiungi un pannello che scrive la lista `enabledModels` in
`~/.pi/agent/settings.json`. Il server la legge già in `pickerModels()` (`server.mjs:953`): manca
solo l'interfaccia per comporla. La lista accetta pattern glob, quindi una spunta su un provider
scrive `<provider>/*` e una spunta su un modello scrive il suo identificativo pieno. Due sezioni:
**Providers** (un'entrata per provider autenticato) e **Models** (un'entrata per modello
disponibile). Lista vuota significa "tutto abilitato", che è il comportamento attuale e va
preservato.

**File coinvolti:**
- `server.mjs` (endpoint impostazioni, righe ~1109-1180)
- `public/index.html` (pannello impostazioni)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Esponi al frontend l'elenco dei provider autenticati e dei modelli, con lo stato attuale di `enabledModels`
- [ ] Costruisci il pannello a due sezioni con le spunte per provider e per modello
- [ ] Al salvataggio scrivi i pattern in `enabledModels` tramite l'endpoint di scrittura impostazioni già esistente
- [ ] Mostra un avviso quando la lista è vuota, spiegando che significa "tutti abilitati"
- [ ] Verifica che il selettore modelli in alto rifletta subito la lista salvata

**Risultato atteso:** spuntando un solo provider, il selettore modelli mostra solo i suoi modelli.
Svuotando la lista tornano tutti. Il file `settings.json` contiene pattern nella forma
`provider/*` o l'identificativo del singolo modello. `npm run verify` passa.

**Avvertenze:** `settings.json` è condiviso con la CLI di pi e con gli altri client: non
riscriverlo per intero, modifica solo la chiave `enabledModels` lasciando intatto il resto.
La maggior parte delle impostazioni viene letta da pi all'avvio: potrebbe servire un riavvio della
sessione perché l'effetto sia visibile.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 11. Memoria: mettere in cache i dati aggregati

**Stato:** TODO

**Descrizione:** `analyticsCache` (`server.mjs:307`) conserva, per ogni file di sessione, l'array
`rows` con una riga per ciascun messaggio dell'assistente, e non svuota mai niente. Su cartelle di
sessione da decine di megabyte sono decine di migliaia di oggetti vivi. Ma quelle righe vengono
aggregate in bucket subito dopo (`server.mjs:395`) e poi buttate: la cache conserva materia prima
già consumata. Metti in cache i **bucket aggregati per file**, non le righe. Aggiungi in più un
tetto massimo di voci con sfratto della meno usata di recente, come cintura di sicurezza.

**File coinvolti:**
- `server.mjs` (righe ~300-470)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Sposta l'aggregazione dentro `scanSessionFile`, in modo che la cache conservi i bucket e non le righe
- [ ] Adegua il codice a valle che oggi consuma `rows`
- [ ] Aggiungi tetto massimo di voci e sfratto della meno usata di recente, senza dipendenze esterne
- [ ] Verifica che i numeri della dashboard analytics siano identici a prima del cambiamento

**Risultato atteso:** la pagina analytics mostra gli stessi totali di prima, per giorno, modello e
progetto. La memoria occupata dalla cache non cresce più in proporzione al numero di messaggi.
`npm run verify` passa.

**Avvertenze:** La chiave di invalidazione basata su `mtimeMs` e `size` funziona e va conservata.
Prima di modificare, annota i totali della dashboard su un periodo noto e riconfrontali dopo: è
l'unico modo per accorgersi di un errore di aggregazione.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 12. Traduzione integrale in inglese

**Stato:** TODO

**Descrizione:** Porta tutto il progetto in inglese: nessun selettore lingua, nessun dizionario,
l'italiano viene rimosso. Rientrano nel task le stringhe visibili della UI, i `title` dei pulsanti,
i messaggi di errore lato server, i commenti in italiano nel codice sorgente, i tre prompt
suggeriti in `public/index.html:1402` e l'attributo `lang` del documento, che passa da `it` a `en`.
Va tradotto anche il testo dei prompt inviati all'agente, non solo l'etichetta che li descrive.

**File coinvolti:**
- `public/index.html`
- `server.mjs`
- `usage-tracker.mjs`
- `pick-folder.ps1`

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Traduci tutte le stringhe visibili di `public/index.html`, attributi `title` compresi
- [ ] Traduci i tre oggetti di `SUGG`, etichetta, descrizione e prompt inviato all'agente
- [ ] Porta `lang="it"` a `lang="en"` nel tag `<html>`
- [ ] Traduci i messaggi di errore rivolti all'utente in `server.mjs` e `usage-tracker.mjs`
- [ ] Traduci i commenti in italiano nei tre file `.mjs` e in `pick-folder.ps1`

**Risultato atteso:** nessuna parola italiana resta nell'interfaccia né nei commenti del codice.
`npm run verify` passa e la UI si apre correttamente in ogni sua schermata.

**Avvertenze:** Questo task viene dopo tutti quelli che aggiungono interfaccia (4, 7, 9, 10),
proprio per non tradurre due volte le stesse stringhe. Attenzione a non tradurre per sbaglio
identificativi, chiavi JSON, nomi di evento o valori di stato come `done` e `reopened`: sono
contratti tecnici, non testo.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---

### 13. README pubblico

**Stato:** TODO

**Descrizione:** Scrivi `README.md` in inglese, rivolto a chi arriva dalla pagina GitHub senza
sapere nulla del progetto. Deve coprire: cos'è pi-web-ui e cosa fa, requisiti (Node >= 22 e pi
configurato), installazione, avvio con `npm start`, elenco delle funzioni, una sezione dedicata
alla sicurezza dell'accesso da rete, una sezione che spiega l'archiviazione delle chat come
strumento per fare ordine nella sidebar, e lo stato del supporto per piattaforma. Gli screenshot
non li puoi produrre: inserisci i riferimenti a `docs/images/` e l'elenco di quelli mancanti.

**File coinvolti:**
- `README.md` (nuovo)
- `docs/images/` (cartella nuova con un file segnaposto)

**Strumenti/prerequisiti:** nessuno.

**Subtask:**
- [ ] Scrivi introduzione, requisiti, installazione e avvio
- [ ] Elenca le funzioni ricavandole dagli endpoint documentati in testa a `server.mjs` e dalla UI
- [ ] Scrivi la sezione sicurezza: perché l'accesso da rete è spento di default, come attivarlo, cosa comporta
- [ ] Scrivi la sezione sull'archiviazione delle chat: cosa succede al primo avvio, il pulsante manuale, come disattivarla
- [ ] Dichiara lo stato per piattaforma: Windows testato, macOS e Linux non verificati
- [ ] Inserisci i riferimenti alle immagini in `docs/images/` e chiudi il README con la licenza MIT

**Risultato atteso:** `README.md` esiste, è interamente in inglese e permette a un estraneo di
installare e avviare il progetto seguendolo dall'alto in basso. Le funzioni descritte corrispondono
a quelle realmente presenti dopo i task precedenti. `npm run verify` passa.

**Avvertenze:** Descrivi il progetto **come è alla fine di questa fase**, non com'era all'inizio:
niente `.vbs`, niente CDN, accesso da rete spento di default. Non promettere supporto macOS e
Linux come verificato: non lo è.

<!-- da compilare dopo l'implementazione -->
**Conclusioni:** —

**Commit:** —

---
