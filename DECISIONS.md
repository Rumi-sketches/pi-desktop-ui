# DECISIONS

Mini-ADR del progetto. Una voce per decisione: contesto in una riga, decisione, perché.

## SSE: un solo punto di scrittura

- **Contesto**: il ping keepalive poteva fare `res.write` su una risposta già morta; l'evento
  `error` senza listener diventava uncaught exception e `lifecycle.crash` chiudeva il processo.
- **Decisione**: ogni scrittura su uno stream SSE passa da un helper che controlla
  `res.writableEnded || res.destroyed` prima del `write`, e ogni stream registra
  `res.on("error", () => {})` all'apertura. Vale per tutti gli SSE del progetto
  (`contexts.mjs`, `api-terminals.mjs` e futuri).
- **Perché**: un `error` senza listener abbatte il server (e quindi l'app) senza nulla nei log.
