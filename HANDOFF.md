# pi-web-ui — Handoff / Contesto progetto

Web UI locale minimale costruita sopra l'SDK di pi (`@earendil-works/pi-coding-agent`).
Creata il 2026-07-24. **Leggi questo file all'inizio di una nuova chat per riprendere il lavoro.**

## Struttura

```
C:\Users\Mimmo\Desktop\Projects\small projects\pi-web-ui\
├── server.mjs          ← backend Node (SDK pi + SSE + API REST, ~1400 righe)
├── public\index.html   ← frontend (chat streaming, selettori, contatori)
├── pick-folder.ps1     ← folder picker nativo moderno (IFileOpenDialog + FOS_PICKFOLDERS)
├── run.vbs             ← launcher nascosto (usato dallo shortcut Desktop)
├── server.log          ← output del server quando avviato da run.vbs (gitignored)
├── stop.vbs            ← stopper (API /api/shutdown, fallback kill del node server.mjs)
├── package.json        ← dipendenza: @earendil-works/pi-coding-agent (locale, v0.82.0)
└── HANDOFF.md          ← questo file
```

- **Shortcut avvio:** `C:\Users\Mimmo\Desktop\pi-web-ui.lnk` → `wscript run.vbs` (avvia server se non attivo, attende che risponda, apre http://localhost:3777). Path relativi allo script; il server viene lanciato via `cmd /c node server.mjs > server.log 2>&1` (senza `cmd` il `WshShell.Run "node ..."` falliva silenziosamente); se non si avvia entro ~20s mostra un MsgBox con il path del log
- **Shortcut stop:** `C:\Users\Mimmo\Desktop\pi-web-ui STOP.lnk` → `wscript stop.vbs`
- **Stop dalla UI:** bottone ⏻ nella topbar (conferma → `POST /api/shutdown`)
- **Avvio manuale:** `cd C:\Users\Mimmo\Desktop\Projects\small projects\pi-web-ui && node server.mjs` → http://localhost:3777 (Ctrl+C per fermare: gestiti SIGINT/SIGTERM/SIGHUP)

## Funzionalità attuali

- Chat con streaming SSE (testo, thinking, tool call)
- Selettore modelli filtrato: solo provider con auth valida (`ModelRuntime.checkAuth`)
- Selettore thinking level (off/low/high/max — per K3 funzionano solo low/high/max)
- Scelta della working directory **prima** che la chat inizi (`POST /api/cwd`)
- Contatori: token input/output, costo $, n. richieste (da `message_end` usage)
- Barra utilizzo contesto (used/contextWindow, soglie 60%/85%)
- Markdown rendering + syntax highlighting nei messaggi assistant (marked + highlight.js via CDN, re-render incrementale durante lo streaming)
- Sessioni persistenti su file (`SessionManager.continueRecent/create/open`, salvate in `~/.pi/agent/sessions/<cwd>/`): selettore sessioni + bottone nuova sessione, `continueRecent` all'avvio. API: `GET /api/sessions`, `POST /api/session {action:new|open|continue, path?}`
- Pannello diff file modificati: traccia `edit`/`write` da `tool_execution_start.args`, pannello laterale con lista file + diff a hunk (rosso/verde). API: `GET /api/files`, `GET /api/files/diff?path=`. Reset su cambio cwd/sessione
- Shutdown pulito: `POST /api/shutdown` → abort run in corso, chiude client SSE, `server.close()` + hard exit dopo 1.5s
- Upload immagini nel prompt: bottone 🖼 + file picker + incolla (paste) + anteprima. Inviate come `ImageContent[]` (`{type:'image',data:base64,mimeType}`) a `session.prompt(text,{images})`. `POST /api/prompt` accetta `{text, images}`

## Config pi condivisa (usata da CLI, pi-gui e questa web UI)

Tutto in `C:\Users\Mimmo\.pi\agent\`:

| File | Scopo |
|---|---|
| `auth.json` | OAuth Kimi (`kimi-coding`, token ~30 min) + OAuth Anthropic |
| `models.json` | Registra `k3` e `k3-256k` (provider kimi-coding) + `apiKey` come comando shell `!python ...kimi-token.py` |
| `kimi-token.py` | Stampa token fresco su stdout; fa refresh OAuth automatico se in scadenza (endpoint `https://auth.kimi.com/api/oauth/token`, client_id `17e5f671-...`). Risolve il problema della GUI pi-gui che non supporta OAuth Kimi |
| `settings.json` | default: `kimi-coding/k3-256k`, thinking `low`, pacchetto `npm:@gotgenes/pi-anthropic-auth` installato |

## Stato di pi-gui (app Electron separata, parallela)

- Installata come portable in `C:\Users\Mimmo\AppData\Local\Programs\pi-gui\pi-gui.exe` + shortcut menu Start
- Bundla SDK 0.80.6 (senza OAuth Kimi, aggiunto in pi 0.82.0) → per questo serve `kimi-token.py` via models.json
- Bug noti: non filtra thinking level null (issue #51 correlata), modelli da models.json ora visibili grazie alla nostra registrazione esplicita

## Redesign UI (2026-07-26)

`public/index.html` riscritto (design ispirato a reference dark/minimal):

- **Sidebar sinistra** (togglabile): brand π, "Nuova chat", ricerca full-text sulle sessioni, **filtro progetto/path** (`Progetto corrente` / `Tutti i progetti` / singolo path) + ordinamento (recenti/vecchie/n. messaggi), lista chat con badge progetto, footer con "Modifiche N" e ⏻ spegni server
- **Bottoni chiariti**: niente più "cambia directory"/"stop" ambigui →
  - chip **cartella di lavoro** in topbar con popover (input path + `Sfoglia…` + `Imposta cartella` + `Apri in Explorer`)
  - **"Interrompi risposta"** (abort run) visibile solo mentre l'agente sta rispondendo, con pulse indicator
  - ⏻ nel footer sidebar = spegni server (con conferma esplicita)
- **Model picker custom** (non `<select>`): logo del provider inline SVG (anthropic/openai/google/kimi/moonshot/deepseek/xai/mistral/meta/ollama/groq/openrouter + fallback), raggruppato per provider, mostra id + `reasoning` + context window
- **Menu effort dinamico**: il server calcola i livelli supportati per modello (`supportedThinkingLevels()`, replica di `getSupportedThinkingLevels` di pi-ai: `reasoning` + `thinkingLevelMap`). Esposti da `GET /api/state`, `GET /api/models` (anche per-modello) e restituiti da `POST /api/model|thinking`; la UI mostra solo quelli disponibili e riallinea la selezione al cambio modello
- **Niente box sui messaggi**: turni con etichetta "Tu"/"pi" e testo nudo; i riquadri restano solo su code block, tabelle, quote, diff e allegati
- **Drag & drop** su tutta la finestra (overlay): immagini → `ImageContent`, file di testo (<512 KB, whitelist estensioni) → appesi al prompt come blocco ``` con nome file; funziona anche con picker e paste
- Composer arrotondato con auto-grow, hint tasti, stato vuoto "Cosa costruiamo oggi?"

### Iterazione 2 (stesso giorno)

- **Layout in stile reference**: rail icone a sinistra (58px, logo teal, Chat / Impostazioni / File modificati / Spegni) + sidebar chat collassabile + main con sfondo a griglia e glow radiale teal; palette near-black + accento `#2fe0c0`
- **Chat allineata a sinistra** (anche i prompt utente): ogni turno è `avatar + nome + testo`, nessun bubble
- **Tasti invertiti come richiesto**: `Invio` = a capo, `Shift+Invio` = invia
- **Fix sidebar "morta"**: ogni chiamata passa da `api()`/`post()` che mostra gli errori in toast; dopo `nuova chat`/`apri chat`/`cambia cartella` la UI fa `refreshAll()` senza dipendere dall'evento SSE; EventSource con indicatore di connessione + reconnect watchdog (5s); overlay drag&drop non può più restare bloccato sopra la UI (`dragend`/`blur` lo chiudono)
- **Fix "Apri cartella"**: prima svuotava solo la chat; ora valida la risposta, ricarica history/sessioni/progetti/modelli e mostra conferma
- **Nuova pagina Impostazioni** (`/api/config`): sessione corrente, griglia modelli con logo/context/effort/prezzi e filtri (ricerca, solo autenticati, solo reasoning — sono 1100+ modelli registrati), stato auth per provider (OAuth incluso), opzioni di pi da `SettingsManager`, tool attivi, percorsi, dump raw di `settings.json` e `models.json`. Clic su una card = cambio modello
- Hero con suggerimenti cliccabili quando la chat è vuota

### Iterazione 3

- **Pagina impostazioni**: mostra per prime le impostazioni di pi (`GET /api/settings`), lo schema è **parsato da `node_modules/@earendil-works/pi-coding-agent/docs/settings.md`** (14 sezioni, ~55 chiavi con tipo, default e descrizione ufficiale). Ogni campo editabile ha il controllo giusto (toggle / select con opzioni / number / text) e **salva subito** in `~/.pi/agent/settings.json` via `POST /api/settings {key,value}` (supporta chiavi annidate tipo `compaction.reserveTokens`, `value:null` cancella la chiave e ripulisce gli oggetti rimasti vuoti). Le opzioni di `defaultProvider`/`defaultModel` vengono iniettate dal runtime (provider autenticati / modelli reali). Badge "salvato · riavvia" perché pi legge la maggior parte dei valori all'avvio; `defaultThinkingLevel` viene applicato a caldo
- **6 temi web UI** (`data-theme` su `<html>` + variabili CSS, scelta in localStorage): `noir` (default), `violet`, `ember`, `nord`, `rose`, `daylight` (chiaro). Selettore a swatch nella pagina impostazioni
- **Tool call espandibili**: il server ora invia `toolCallId`, `args` sanitizzati, un `summary` di una riga (per bash = il comando) e l'output via `tool_execution_update`/`end` (troncato a 20k). In chat ogni tool è una card cliccabile: header `⚙ bash — echo ciao`, corpo con **Richiesta** (args JSON) e **Output** in streaming; gli errori si aprono da soli
- Consolidata la doppia implementazione di `/api/settings` (rimasta quella basata sui doc dell'SDK)

Backend (`server.mjs`): `GET /api/sessions?scope=all|cwd` (usa `SessionManager.listAll()`, ritorna anche `cwd` per sessione) e `POST /api/session {action:'open', path, cwd}` che segue la working directory della sessione aperta (broadcast `cwd` + `session`).

## Limiti reali account (claude.ai / kimi.com) — 2026-07-26

Barra sotto la topbar con l'utilizzo **reale** dell'account (non stimato), letto direttamente dagli endpoint interni non documentati che i due siti usano per i propri pannelli "usage". Necessario perché l'uso avviene anche da altri dispositivi (i log locali `~/.pi` / `~/.claude` non basterebbero).

- **Modulo**: `usage-tracker.mjs` — `fetchAnthropicUsage()`, `fetchKimiUsage()`, cache 45s, credenziali in `~/.pi/agent/web-usage.json` (fuori dal repo, contiene segreti)
- **Endpoint**: `GET /api/usage` (entrambi i provider), `GET/POST/DELETE /api/usage/config` (stato/salva/rimuovi credenziali, mai esposte in GET)
- **Anthropic**: `GET https://claude.ai/api/organizations/{orgId}/usage` con header `Cookie` completo (sessionKey + cf_clearance ecc.). **Importante**: claude.ai è dietro Cloudflare bot-management che fa fingerprint del TLS/HTTP2 handshake — il `fetch()` nativo di Node (undici) viene **sempre bloccato con 403** anche con cookie perfettamente validi, mentre l'handshake di `curl` passa. Soluzione: la chiamata gira tramite `execFile("curl", ...)` invece di `fetch()`. Risposta usata: `five_hour.utilization`/`resets_at`, `limits[0].severity`
- **Kimi**: `POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages` con `Authorization: Bearer <jwt da cookie kimi-auth>` e body `{"scope":["FEATURE_CODING"]}` (proto/connect-rpc, campo `scope` enum repeated, deve contenere almeno un valore). Nessun blocco Cloudflare qui, `fetch()` nativo funziona. Risposta: `usages[].detail.{limit,used,remaining,resetTime}` + `totalQuota` a livello root
- **UI**: sezione Impostazioni per incollare org id + cookie (Claude) e bearer token (Kimi), salvataggio immediato, badge configurato/non configurato; barra sotto la topbar (nascosta se nessun provider configurato) con percentuale, colore per soglia/severity, countdown fino al reset; poll ogni 30s
- Le credenziali (cookie di sessione claude.ai, JWT kimi-auth) vanno **rinnovate manualmente** quando scadono/si fa logout — si riprendono da DevTools → Network sulle rispettive pagine di utilizzo

## Multi-chat parallele (2026-07-26)

Prima il server era **single-session**: una sola `session` globale + `broadcast()` a tutti i client SSE. Conseguenze: tutte le schede del browser erano sincronizzate sulla stessa chat, e cambiare chat faceva `session.dispose()` → il run in corso moriva (da qui il `confirm()` "cambiare chat la interrompe").

Ora il server tiene **un contesto agente per chat aperta**, chiavato sul path del file di sessione:

- `contexts: Map<sessionFile, ctx>` — ogni ctx ha `{ session, cwd, chat (usage), context, files, clients, live, running }`. `totals` resta globale (tutte le chat)
- **Scoping**: ogni scheda dichiara la propria chat con `?s=<sessionFile>` (o header `x-pi-session`); `useContext(key)` risolve il ctx, lo carica pigramente se non è in memoria (riavvio server / chat aperta altrove) e fa fallback su `continueRecent`
- **SSE**: `/api/events?s=<key>` iscrive la scheda *solo* al suo ctx. Eventi globali (`kind:'running'`, `kind:'sessions'`, tag `scope:'global'`) vanno a tutti per i badge in sidebar. Alla connessione il server manda `kind:'attached'` con key/cwd/running
- **Niente dispose sul cambio chat**: un run continua in background; i contesti inattivi (0 client, non in esecuzione) vengono liberati dopo 30 min da un GC
- **Buffer live per ctx**: testo/thinking/tool card in streaming dall'ultimo `message_end`. `GET /api/history` ritorna `{messages, live, streaming}`, così rientrando in una chat occupata rivedi il turno in corso e lo streaming prosegue. Al `message_end` il buffer testuale viene svuotato (il messaggio è già persistito) e restano solo le tool call ancora in esecuzione → nessuna duplicazione
- `cwd`, file modificati e contatori della chat sono **per contesto** (prima erano globali e cambiavano sotto i piedi a tutte le schede)
- `POST /api/cwd` e `POST /api/session` non "spostano" più lo stato globale: creano/riusano un contesto e ne restituiscono la `key`, che la scheda adotta
- `GET /api/sessions` ritorna anche `running: string[]` e `open: string[]`

Frontend (`public/index.html`):

- La scheda memorizza la propria chat in `sessionStorage` + hash URL (`#s=<path>`), quindi **schede diverse = chat diverse**; duplicando una scheda si riapre la stessa chat
- `api()` accoda automaticamente `s=` a ogni chiamata `/api/*` e adotta la `key` presente nelle risposte (riconnettendo l'EventSource quando cambia)
- Rimosso il `confirm()` sul cambio chat. In sidebar le chat che stanno lavorando hanno un **pallino pulsante + "in esecuzione"**, e al termine di un run in background arriva un toast
- `loadHistory()` ricostruisce anche il turno in corso dal buffer `live`

**Nota**: due schede sulla stessa chat restano volutamente sincronizzate (è lo stesso ctx, un solo agente sul file di sessione).

## Cartella di lavoro, preferiti e schede (2026-07-26)

- **La cartella si sceglie solo a chat non iniziata.** Modello mentale: una chat "vuota" non esiste, è solo la home — nasce col primo prompt (`SessionManager.create()` non scrive nulla su disco finché non arriva il primo entry). Quindi `POST /api/cwd` non fa più `mode:'continue'` (che ti spediva sull'ultima chat del progetto: era quello il comportamento "strano" del vecchio bottone *Apri cartella*), ma crea un contesto vuoto `mode:'new'` nella cartella scelta. Se la chat ha già messaggi il server risponde 400 e la UI mette il popover in sola lettura (`setChatStarted()` da `/api/history` + evento `status`)
- **`Apri in Explorer`** (`POST /api/open-explorer`): apre la cwd della chat in Esplora risorse via `explorer.exe` — il suo exit code 1 va ignorato, lo restituisce anche quando funziona (delega a un'istanza già attiva)
- **`Sfoglia…`**: `pick-folder.ps1` usa **IFileOpenDialog con FOS_PICKFOLDERS** (stesso dialog moderno di "Allega file", in modalità cartelle) invece del vecchio `FolderBrowserDialog` inline. L'attributo chiave è l'owner: `dlg.Show(GetForegroundWindow())` — senza finestra proprietaria il dialog si apriva **dietro** il browser. Lanciato con `powershell -NoProfile -STA -ExecutionPolicy Bypass -File`; l'ordine dei metodi nelle interfacce COM **deve** rispettare la vtable (IModalWindow → IFileDialog → IFileOpenDialog), altrimenti crash a runtime
- **Chat preferite**: cuoricino su ogni chat in sidebar, `POST /api/favorites {path,favorite}`, persistite in `~/.pi/agent/web-ui-favorites.json` (server-side ⇒ uguali in ogni scheda/browser del PC); `GET /api/sessions` espone `favorite` per sessione. I preferiti stanno sempre in cima e tra loro sono ordinati per data, in qualunque vista/ordinamento
- **Rotellina / Ctrl+click** su una chat in sidebar = apri in una **nuova scheda** (`window.open('#s=<path>')`, sfrutta il binding per-scheda già esistente); bloccato l'autoscroll del tasto centrale

## Nuove feature (2026-07-27)

- **Contatore per-modello (toggle)**: cambiare LLM a metà chat è tracciato. `ctx.chatByModel` (chiave `provider/model`) accumula token/costo/richieste sia live (`message_end`, modello preso dal messaggio) sia in riapertura (`replayChatUsage`, il file sessione ha già il modello per messaggio). Esposto in `/api/state` e SSE `usage`. In UI `#stats` è un bottone: click → popover con una riga per LLM usato nella chat + totale. La dashboard "Analisi costi" era già per-modello (bucket giorno × modello × progetto da `scanSessionFile`)
- **Turni assistant con logo + nome modello** al posto di "π"/"pi": `agent_start` salva `ctx.turnModel` e lo manda nell'evento `status`; `/api/history` include `provider`/`model` per messaggio assistant + `turnModel` per il turno live. `newTurn(role, model)` renderizza avatar = logo provider, `.who` = nome modello + provider
- **Composer liste automatiche**: `*␣` a inizio riga → `•␣` (keydown su spazio, solo se la riga è solo `*`); `Invio` in una lista (`•`/`-`/`+`/`1.`) prosegue col marcatore o il numero incrementato (`continueList()`); `Invio` su voce vuota esce dalla lista
- **Git chip in topbar**: `GET /api/git` esegue `git status --porcelain=v1 --branch` nella cwd del contesto (branch, staged/unstaged/untracked, ahead/behind; cache 5s per cwd; `{repo:false}` fuori dai repo → chip nascosta). Refresh a fine run (`status` idle), al cambio contesto e poll 20s
- **Sidebar impostazioni**: in vista Impostazioni la sidebar (`#sidebar.mode-settings`) nasconde lista chat/filtri e mostra `#settingsNav` con le sezioni (id `sec-*` iniettati nel template di `renderSettings` + card `#analytics`), scroll-to e scroll-spy
- **Layout**: sidebar 274→230px; `#chat`/`#composer` max-width 780→960px, e con sidebar chiusa 1150px (classe `body.sb-closed`, gestita da `setSidebarCollapsed()`)

## Prossime funzionalità candidate

- Nessuna nota al momento

## Note tecniche

- L'SDK legge automaticamente `~/.pi/agent` (auth, models.json, skills, estensioni)
- Eventi SDK usati: `message_update` (text_delta/thinking_delta), `tool_execution_start/end`, `message_end` (usage), `agent_start/end`
- Docs SDK: `C:\Users\Mimmo\Desktop\Projects\small projects\pi-web-ui\node_modules\@earendil-works\pi-coding-agent\docs\sdk.md`
- Esempi: `...\examples\sdk\01-minimal.ts` … `13-session-runtime.ts`
