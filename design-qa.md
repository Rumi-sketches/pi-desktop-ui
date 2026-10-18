# Work block design QA

- Source visual: `prototypes/work-block.html`, variant A (one block per stretch of work, interim updates as chapters), approved before implementation.
- Implementation capture: headless Edge driving `npm start` on `http://127.0.0.1:3799/` at 1180 × 820 px. The captures stay in the task output rather than in the workspace.
- States: a finished chat with four blocks (59 steps in the largest, 4 failed tool calls) closed, on peek and fully open, in Paseo and Noir; two new runs with `xiaomi/mimo-v2.6-pro` captured while streaming and after they ended.
- Density normalization: prototype and app were both captured at default density; the prototype uses fake data, so the comparison covers structure, copy and motion rather than content.

## Findings

No actionable P0–P2 differences remain. The summary row keeps the prototype's hierarchy: a spinner or check, one headline, a muted count on the right and a chevron that turns with the level. While a run streams, the headline sweeps with a light shimmer. It follows the latest interim update, falling back to the latest bold reasoning heading and then the running tool. When the run ends it reads `Worked for 24s` with a per-tool breakdown, and failures are counted in the theme's critical colour.

Interim updates first stream as normal text. They leave the flow with a collapse once the next tool call starts, and the final answer stays outside the block. Tool rows put their icon on the step line, use a verb and target (`Ran ls docs`, `Read README.md`) and open on the raw input and output. Error rows are red and open by default.

Variant B ships as the second style, chosen under Settings → Theme → Model work. Updates stay in the chat and each stretch of work between them folds on its own. While a stretch runs, its row names the latest named step: a tool call, running or finished, or a reasoning heading. When the stretch ends, the row names its first heading, its only tool call or a breakdown of its tool calls. The settings preview plays a scripted run through the real work block module in the chosen style.

Two issues found during the live checks were fixed before this record. The finished duration fell back to `1s` because the app clears the run start before settling the view. The live clock also lagged the composer timer by the time to the first event.

## Verification

- Real use: history and live runs in the browser build; the live block followed the update text, absorbed it at the next tool call, and settled when the run ended. In the flow style a live run split at its update, and the same chat rebuilt from history in both styles. The settings preview played in both styles.
- Automated: `npm test` passed, including seven work block tests in `test/chat-view.test.mjs`.
- Not covered: the Electron shell (`npm run app`) was not launched for this record; it serves the same page.

final result: passed
