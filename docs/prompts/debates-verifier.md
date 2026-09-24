# Prompt per verificatore indipendente

Lavora in `C:/Users/Mimmo/Desktop/Projects/small-projects/pi-desktop-ui`, in un contesto
nuovo. Valuta la funzione Debates senza modificare il codice. Leggi le istruzioni del
repository, ma non usare report del builder o del reviewer come prova e non leggere
l'altro prompt di review. Non delegare e non avviare Ralph.

## Problema e obiettivi

L'utente vuole esplorare un'idea facendo conversare due agenti dalla UI desktop, mantenendo
anche la modalità browser. Deve poter scegliere prompt, modello ed effort di ciascun agente,
uguali o diversi, e il numero di risposte per agente.

1. **Confronto fedele al protocollo.** A1 e B1 sono opinioni indipendenti. Poi A riceve B1
   e produce A2; B riceve A1 e A2 insieme e produce B2. Lo scambio prosegue alternato.
   N round significa esattamente N risposte di A e N di B, incluse apertura e conclusioni.
   Prima dell'ultima risposta ogni agente deve sapere che è l'ultima e ricevere la richiesta
   di dare una risposta completa e autosufficiente, come prima risposta al prompt, integrando
   tutte le proposte ancora valide e le correzioni. Un elenco delle sole novità non basta.
   B legge la conclusione di A.
2. **Controllo dalla UI.** Configurazione, progresso, interruzione, ripresa, storico e due
   conclusioni sono utilizzabili senza terminali o copia-incolla manuale fra chat.
   Debates ha una voce accanto a Chat e Settings, con elenco separato. I messaggi mostrano
   modello ed effort all'utente. Si possono allegare file di testo/codice e immagini.
   Cambio vista e reload non fermano il confronto né confondono messaggi o allegati fra chat.
   Dopo il completamento si può avviare un nuovo ciclo con nuovo prompt, allegati e numero
   di round deciso ogni volta, mantenendo il contesto precedente di entrambi gli agenti.
3. **Conservazione del lavoro.** Una risposta salvata non viene rigenerata dopo una ripresa.
   Un errore, un output troncato o uno stop non consegnano una risposta incompleta al peer.
   Il riavvio non riparte da solo. È ammesso dover ripetere una chiamata interrotta prima
   del salvataggio: non è promessa l'esecuzione unica lato provider.
4. **Isolamento.** A e B hanno storici propri e vedono il peer soltanto come A/B, non il
   modello o l'effort. Gli stessi metadati restano visibili all'utente. Gli agenti possono
   leggere ed esplorare il progetto con read, grep, find e ls, ma non scrivere o usare shell.
   Non sono caricati automaticamente skill, estensioni o istruzioni di progetto. Il contesto
   conservato comprende le letture effettuate e le conclusioni del ciclo precedente.
5. **Coesistenza e sicurezza.** Electron e browser non eseguono contemporaneamente lo
   stesso confronto. Stop e shutdown rilasciano il lavoro. Output dei modelli e dati
   persistiti non devono esporre credenziali, eseguire script nella UI o danneggiare le
   normali funzioni di chat, progetti e terminali.

## Vincoli

Nessuna nuova dipendenza runtime, backend remoto, telemetria, compattazione automatica o
rigenerazione automatica dei turni falliti. Nessun limite di lunghezza aggiuntivo imposto
alle risposte; i limiti del provider restano validi. Gli allegati supportati sono testo/codice
fino a 512 KB per file e immagini PNG/JPEG/GIF/WebP; PDF e altri binari non sono supportati.
Fuori ambito: strumenti di scrittura, shell, web, interventi umani a metà ciclo, terzo agente
giudice e cambio modello durante il confronto.
Le statistiche dei confronti non sono incluse nell'analytics delle normali sessioni.

Scegli autonomamente come verificare questi obiettivi. Leggi codice e test, ma non assumere
che gli assert esistenti descrivano correttamente il contratto. Usa prove riproducibili e,
quando disponibile, la UI reale. Lavora con dati e provider simulati in directory temporanee;
non effettuare chiamate reali a pagamento senza consenso. Distingui ciò che tali simulazioni
provano dalla compatibilità effettiva con i provider.

Consegna una valutazione per ogni obiettivo: soddisfatto, parziale, non soddisfatto o non
verificato, con prove e limiti. Per ogni difetto indica impatto, riproduzione, comportamento
atteso e osservato. Non applicare fix e non dichiarare tutto corretto sulla sola base dei test.
