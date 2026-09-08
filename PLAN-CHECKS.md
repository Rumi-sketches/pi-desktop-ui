# PLAN-CHECKS.md — check preventivi distillati dai MEETING passati

> Uso: durante `plan-fase` (gate 2) e `to-prd-build`, ogni check va passato contro il piano.
> Check non soddisfatto = decisione da chiudere PRIMA della build, non lasciata al braccio
> né al reviewer. Fonte: MEETING 2026-08-17 → 2026-08-19.

## Lavoro senza tetto

- ❑ Ogni operazione scatenata da input utente (ricerca, click su un bottone che spawna
  processi, generazione titoli) ha un budget dichiarato nel piano: N file/elementi o T ms,
  con `truncated: true` e un messaggio onesto quando si ferma. "Il cap sui risultati" non
  basta se il caso *zero risultati* legge tutto. (08-19b i2)
- ❑ Ogni retry ha un contatore e un backoff decisi nel piano (regola `no-infinite-retry`):
  fallimento permanente → cache negativa, non ritentare; transitorio → pausa. Un test che
  fotografa il retry infinito come comportamento atteso è un bug del test. (08-19b i3)
- ❑ Una richiesta abbandonata dal client si annulla anche sul server (`AbortController` lato
  client, `res.destroyed`/evento `close` lato server): il lavoro il cui risultato nessuno
  leggerà si interrompe, non si butta a fine corsa. (08-19b i5)
- ❑ Le risorse spawnabili senza limite (terminali, processi, upload) hanno un tetto o una UI
  che le rende visibili e chiudibili: il degrado silenzioso della macchina non è accettabile. (08-18 i3)

## Stream e SSE

- ❑ Ogni stream SSE gestisce la **riconnessione**: `EventSource` si riconnette da solo, quindi
  il piano dice cosa succede al replay (offset con `Last-Event-ID`, o `reset` esplicito).
  "Manda tutto dall'inizio" duplica lo schermo. (08-18 i1)
- ❑ Nessuna scrittura su una risposta potenzialmente morta: un solo punto di write con guardia
  `writableEnded/destroyed` + listener `error` vuoto sulla risposta — un `error` senza
  ascoltatori è un'uncaught exception che ammazza il server. Vale per **tutti** gli SSE del
  progetto, non solo per quello nuovo. (08-18 i5)
- ❑ Una risposta che precede uno shutdown/restart parte **prima** che i socket vengano chiusi
  (`afterResponse`): rispondere e chiudere subito è una corsa che il client perde nei casi
  peggiori (LAN, rete lenta). (08-17 i4)

## Fallimenti silenziosi

- ❑ Nessun esito di mutazione ignorato (regola `no-silent-action-failure`): `{ ok: false }`
  scartato dal client, `catch` che ingoia e usa un default — ogni fallimento ha un segnale
  visibile deciso nel piano (riga nel pane, stato disabilitato, toast). (08-18 i2)
- ❑ Gli stati terminali (processo uscito, chat conclusa) arrivano dal canale che li conosce
  (evento push), non dedotti dal fallimento del prossimo input dell'utente. (08-18 i2)
- ❑ Un degrado con fallback muto (libreria che rifiuta un valore e usa il suo default) va
  scovato nel piano: se un parser accetta solo certi formati, il confine che lo alimenta lo
  garantisce, non lo spera. (08-19a i1)

## Ciclo di vita dei processi

- ❑ Ogni politica di crash/uscita copre **tutti** i rami di avvio: CLI e Electron non passano
  dallo stesso entry point — un handler installato in `runCli()` non protegge la finestra.
  Il piano elenca gli entry point e chi installa cosa. (08-17 i1)
- ❑ Su crash o uscita, i processi figli (agent, PTY) vengono abbattuti: niente orfani che
  continuano a scrivere su file che qualcun altro riaprirà. Se il cleanup è async, il piano
  decide il tetto (`Promise.race` + timeout). (08-17 i2, 08-18 fix quit)
- ❑ "Chiudere" e "riavviare" sono casi diversi: una pulizia giusta sul quit può distruggere
  lavoro vivo su un restart volontario (impostazione cambiata → terminali persi). Il piano
  distingue i due percorsi e decide se serve conferma. (08-18 i4)

## Confini e piattaforme

- ❑ Niente path o input utente interpolati in stringhe di shell, su **nessuna** piattaforma:
  il fix su un ramo (Windows) non chiude il ramo gemello (macOS/osascript). Quoting POSIX
  esplicito o niente shell. Il piano elenca i rami di piattaforma toccati. (08-17 i3)
- ❑ La validazione dichiarata come difesa sta davvero sul percorso: un valore che arriva da un
  file scritto da altri (header di sessione, dati esterni) passa dal validatore al confine,
  non "di solito sì". (08-17 i3)
- ❑ Codice specifico di piattaforma: l'ordine delle guardie (validazione vs check piattaforma)
  è deciso in modo che i test passino su tutte le piattaforme, non solo su quella di sviluppo. (08-18 verif.)

## Privacy, costi e default

- ❑ Nessun dato dell'utente lascia la macchina (API esterne, telemetria) senza un'opzione
  esplicita: default **off**, spiegazione accanto al toggle (cosa parte, verso dove, a spese
  di chi), azione separata per il pregresso. Il primo messaggio di una chat è spesso la cosa
  più sensibile che contiene. (08-19b i1)
- ❑ Le feature che consumano quota/abbonamento dichiarano nel piano quando e quanto chiamano
  (trigger, batch, cap), non solo cosa fanno. (08-19b i1/i3)

## Invarianti che si rompono in silenzio

- ❑ Nessun invariante affidato all'ordine di scrittura in un file (cascata CSS, liste
  ordinate a mano): o un costrutto che lo rende strutturale (`@layer`), o un check in
  `verify.mjs` che fallisce forte. Un commento non è una protezione — qui si è già rotto
  due volte senza che nessuno se ne accorgesse. (08-19a i2, DECISIONS candidate)
- ❑ Nessuna assunzione sul formato dei valori al confine JS↔CSS: un token letto con
  `getComputedStyle()` e passato a una libreria va risolto (helper → `rgba()`), le palette
  restano libere di usare `color-mix()`. (08-19a i1)

## Proprietà e significato dei dati

- ❑ Quando uno stato passa da scope risorsa a scope progetto, il piano definisce anche fonte,
  identità e regole di aggregazione. Verificare almeno due risorse dello stesso progetto che
  producono dati sullo stesso identificatore, senza sovrascrittura implicita. (09-07 RF-10)

## Promesse scritte

- ❑ README, `docs/api.md` e i commenti dicono ciò che il codice fa **dopo** la fase: ogni
  promessa toccata dal piano ("rebinds to loopback", "200KB", "il crash porta giù tutto")
  viene riverificata o aggiornata; le Conclusioni dei task non danno per scontato un
  comportamento mai osservato. (08-17 i1 + minori, 08-18 minori)
- ❑ I casi coperti "dal tripwire/dal check" lo sono davvero: se uno scanner esclude i `.md`
  per costruzione, non può essere citato come verifica di un fix al README. (08-17 minori)
