# DECISIONS

Mini-ADR del progetto. Una voce per decisione: contesto in una riga, decisione, perché.

## Il diff di progetto conserva la provenienza della chat

- **Stato**: ATTIVA.
- **Contesto**: più chat nello stesso progetto possono modificare file diversi o lo stesso path;
  una cache indicizzata solo per progetto sostituiva implicitamente i cambiamenti precedenti.
- **Decisione**: il pannello mostra i cambiamenti prodotti dagli agenti, aggregati per progetto.
  Ogni cambiamento conserva la session key della chat sorgente. Modifiche allo stesso path da chat
  diverse restano separate e il client usa la provenienza per richiedere il relativo diff.
- **Perché**: il pannello deve spiegare cosa ha modificato ciascun agente anche fuori da Git, senza
  perdere informazioni quando più chat condividono la stessa cartella.

## SSE: un solo punto di scrittura

- **Contesto**: il ping keepalive poteva fare `res.write` su una risposta già morta; l'evento
  `error` senza listener diventava uncaught exception e `lifecycle.crash` chiudeva il processo.
- **Decisione**: ogni scrittura su uno stream SSE passa da un helper che controlla
  `res.writableEnded || res.destroyed` prima del `write`, e ogni stream registra
  `res.on("error", () => {})` all'apertura. Vale per tutti gli SSE del progetto
  (`contexts.mjs`, `api-terminals.mjs` e futuri).
- **Perché**: un `error` senza listener abbatte il server (e quindi l'app) senza nulla nei log.

## Feature che consumano l'abbonamento sono opt-in

- **Contesto**: la generazione titoli via Haiku partiva in automatico su tutte le chat, comprese
  le vecchie, senza avviso.
- **Decisione**: ogni feature che manda dati fuori dalla macchina o consuma quota è dietro un
  toggle in Settings, default off; il retroattivo (chat esistenti) richiede un'azione esplicita
  dell'utente, il toggle vale solo per il futuro. Quota OpenAI, titoli Haiku e fallback Luna hanno
  consensi indipendenti. OpenAI usa l'OAuth già gestito da pi solo lato server; token e account ID
  completo non entrano nelle impostazioni o nei payload del browser.
- **Perché**: il primo messaggio di una chat è spesso la cosa più sensibile che contiene, e la
  quota è dell'utente.

## La coda prompt appartiene al context ed è effimera

- **Contesto**: steering e follow-up devono restare cancellabili senza affidarsi alla coda privata
  dell'SDK o confondere due messaggi con lo stesso testo.
- **Decisione**: ogni context possiede una coda in memoria con ID opachi, tipo, testo, allegati e
  byte occupati. La coda segue il context durante un rekey, non sopravvive al riavvio e consegna
  tramite `steer()` e `followUp()` ai confini pubblici del turno. Abort ed errori terminali la
  svuotano. I limiti sono 20 elementi e 32 MiB complessivi.
- **Perché**: il server deve poter annullare un solo elemento, mantenere separate le chat e non
  dipendere da campi privati di pi.

## I marchi dubbi usano il simbolo neutro

- **Contesto**: alcune fonti pubblicano un logo ma richiedono approvazione o vietano modifiche e
  ricolorazioni; Simple Icons non distribuisce più l'icona OpenAI.
- **Decisione**: `public/provider-icons.js` registra fonte, termini e vincolo per ogni provider. Un
  asset di marchio appare solo quando i termini ne consentono chiaramente questo uso. Negli altri
  casi, e nella modalità mono dei marchi non modificabili, la UI usa il simbolo neutro. Gli alias
  passano dalla stessa mappa. OpenAI non dipende da Simple Icons.
- **Perché**: un logo riconoscibile non implica il permesso di incorporarlo o alterarlo.

## Lavoro server scatenato da input utente ha un budget e un abort

- **Contesto**: `/api/search` leggeva tutti i jsonl di tutti i progetti anche per query a vuoto,
  e continuava a scandire dopo che il client aveva già cambiato query.
- **Decisione**: tetto esplicito ai file scansionati (con `truncated: true` nella risposta e
  opzione "ricerca completa" in Settings), interruzione della scansione quando la risposta non ha
  più destinatario (`res.destroyed`), e la ricerca parte su azione esplicita (tasto/Invio), non a
  ogni carattere.
- **Perché**: un campo di testo non deve poter generare lavoro illimitato.

## Clipboard assente ⇒ non sopprimere il menu nativo

- **Contesto**: in LAN (`http://<ip>`, contesto non sicuro) `navigator.clipboard` non esiste e il
  terminale era incopiabile perché `preventDefault()` bloccava anche il menu del browser.
- **Decisione**: quando l'API clipboard non c'è, niente `preventDefault()` sul tasto destro: si
  lascia aprire il menu contestuale del browser.
- **Perché**: il menu del browser è fuori dalla sandbox della pagina e sa copiare la selezione.

## Token CSS letti da JS: risolverli, non assumerli

- **Contesto**: `--teal-dim` è diventata un `color-mix()`; xterm accetta solo hex/`rgb()`, ha
  rifiutato il valore in silenzio e la selezione nel terminale è diventata bianca al 30%.
- **Decisione**: ogni valore letto con `getComputedStyle()` e passato a una libreria esterna passa
  da un helper che lo risolve in `rgba()` (canvas 1×1). Le palette restano libere di usare
  `color-mix()` o altre funzioni CSS.
- **Perché**: il degrado era muto; il formato dei token non deve essere un'assunzione implicita
  sparsa nel codice.

## Precedenze CSS con @layer, non con l'ordine di scrittura

- **Contesto**: il blocco `[data-accent=…]` doveva stare dopo l'ultima palette; l'invariante si è
  rotto due volte (daylight, paseo) senza errori né test.
- **Decisione**: le precedenze fra gruppi di regole si esprimono con `@layer` (`themes`,
  `accents`), mai con la posizione nel file né con un commento.
- **Perché**: aggiungere una palette in fondo è il gesto naturale, e rompeva l'accent picker.
