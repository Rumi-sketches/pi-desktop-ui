# Prompt per reviewer e fixer

Lavora in `C:/Users/Mimmo/Desktop/Projects/small-projects/pi-desktop-ui`.
Esegui una review con fix della funzione Debates, in questo contesto separato dal builder.
Leggi le istruzioni del repository e usa la skill code-review con il riferimento my-code-rules.
Non avviare altri agenti, Ralph o pipeline. Non fare commit o pubblicazioni.

La base precedente alla feature è `7b20b3e`. Esamina il diff rispetto a quella base e i file
nuovi non tracciati: il solo `git diff` non li include. Controlla prima lo stato del repository
e non modificare lavoro successivo estraneo alla feature.

## Contratto concordato

- Dalla UI si impostano prompt, modello ed effort indipendenti di A e B e N round, minimo 2.
  N significa N risposte ciascuno, comprese apertura e conclusione. Nessun limite aggiuntivo
  alla lunghezza delle risposte; restano i limiti tecnici del provider.
- A1 e B1 sono indipendenti. A riceve B1 e produce A2. B riceve A1+A2 nello stesso invio
  e produce B2. Poi si alternano B2→A3→B3→A4→B4 e così via. Prima della risposta N,
  ciascuno riceve l'avviso finale: risposta completa e autosufficiente al prompt, aggiornata
  dopo il confronto, con tutte le proposte ancora valide. Non basta un resoconto delle novità.
- Gli agenti vedono identità A/B e soltanto il testo della risposta del peer. Modelli ed
  effort reali sono visibili su ogni risposta. Sono disponibili esclusivamente read, grep,
  find e ls nella cartella del progetto, con controllo dei percorsi reali. Nessuna scrittura,
  shell o estensione. Istruzioni di progetto e skill non vengono caricate automaticamente.
- Debates ha una voce di navigazione accanto a Chat e Settings e una sidebar separata.
  Entrambi gli agenti ricevono gli allegati di testo/codice o immagini del prompt iniziale.
- Dopo il completamento si può inviare un nuovo prompt, con nuovi allegati e numero di round
  scelto per quel ciclo. Rimangono gli storici distinti, incluse le letture dei file; la nuova
  apertura include la precedente conclusione del peer. Il token previousCycle impedisce doppi
  avvii tardivi. Resume recupera invece il ciclo corrente. I vecchi record v1 restano leggibili.
- Risposte complete salvate prima dell'inoltro. Troncamenti, errori, risposte vuote e abort
  non avanzano il turno. Stop, reload, crash e ripresa non devono duplicare turni salvati.
  Nessuna ripresa, rigenerazione o compattazione automatica.
- Electron e browser condividono l'archivio ma un solo processo esegue ciascun confronto.
  Chiusura e riavvio devono rilevare il lavoro attivo e rilasciarlo.
- Architettura coerente col repository: SDK e servizi esistenti, handler in api-chat,
  persistenza in storage, selezione nella navigazione corrente, app.js/server.mjs come
  collegamenti. Nessuna dipendenza runtime nuova, credenziale esposta o framework parallelo.

## Review

Verifica soprattutto confini asincroni: doppio avvio, risposta contro stop, salvataggio
fallito, inizializzazione contro shutdown, apertura parallela parzialmente fallita,
riconnessione SSE, risposte HTTP obsolete e proprietà del confronto fra processi.
Controlla il recupero degli storici SDK con metadati del provider e risultati dei tool senza
inoltrarli al peer. Verifica il blocco di scrittura/shell, traversal e symlink esterni, la
separazione degli allegati fra compositori, la mancata esposizione dei payload negli eventi
pubblici e il conteggio dei round quando cambia fra cicli.
Valuta errori, validazione dei file persistiti e degli input, paginazione, risorse rilasciate,
sanificazione del Markdown, regressioni su chat, terminali e tab di progetto.

Esegui `npm test`. Puoi usare anche
`npx --no-install electron scripts/check-debates-ui.mjs`: il test usa stato isolato e un
provider simulato. Aggiungi regressioni per i difetti corretti. Non chiamare provider reali
né usare credenziali o sessioni personali per i test senza consenso specifico.

Correggi i difetti pertinenti con modifiche mirate, non refactor generali o workaround.
Se serve cambiare il contratto o aggiungere dipendenze, fermati e proponi la decisione.
Consegna in chat: problemi trovati con severità e posizione, fix applicati, prove eseguite,
problemi residui e limiti. Una suite verde non basta a dichiarare la feature corretta.
