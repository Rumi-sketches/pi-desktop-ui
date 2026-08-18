import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  SCROLLBACK_CAP,
  capScrollback,
  closeAllTerminals,
  countLiveTerminals,
  closeTerminal,
  createTerminal,
  getScrollback,
  getScrollbackSince,
  getTerminal,
  isTerminalKind,
  listTerminals,
  resize,
  setTerminalsChangedListener,
  subscribe,
  terminateTerminalsForChat,
  writeTo,
} from "../terminals.mjs";

// These tests spawn real PowerShell processes. Every one of them registers its
// cleanup with t.after() BEFORE anything can fail, so a red assertion never
// leaves an orphan behind.
const WINDOWS = process.platform === "win32";
const skip = WINDOWS ? false : "node-pty terminals are spawned as PowerShell: Windows only";

/** Poll until `check` is true, or give up. */
async function waitFor(check, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

test("capScrollback: keeps the tail once the cap is passed", () => {
  const short = "x".repeat(10);
  assert.equal(capScrollback(short), short);

  const exact = "x".repeat(SCROLLBACK_CAP);
  assert.equal(capScrollback(exact).length, SCROLLBACK_CAP);

  const over = "HEAD" + "x".repeat(SCROLLBACK_CAP) + "TAIL";
  const capped = capScrollback(over);
  assert.equal(capped.length, SCROLLBACK_CAP);
  assert.ok(!capped.includes("HEAD"), "the head must be the part that is dropped");
  assert.ok(capped.endsWith("TAIL"), "the newest output must survive");
});

test("isTerminalKind: only pi and shell", () => {
  assert.equal(isTerminalKind("pi"), true);
  assert.equal(isTerminalKind("shell"), true);
  assert.equal(isTerminalKind("bash"), false);
  assert.equal(isTerminalKind(""), false);
});

test("createTerminal: refuses a kind outside the whitelist", { skip }, () => {
  assert.throws(() => createTerminal({ kind: /** @type {any} */ ("bash"), cwd: os.tmpdir() }), /unknown terminal kind/);
});

test("a shell terminal produces output, echoes input, and is listed", { skip }, async (t) => {
  const info = createTerminal({ kind: "shell", cwd: os.tmpdir() });
  t.after(() => closeTerminal(info.id));

  assert.equal(info.kind, "shell");
  assert.equal(info.exited, null);
  assert.ok(info.id);

  assert.ok(
    listTerminals().some((row) => row.id === info.id),
    "the new terminal must show up in listTerminals()",
  );
  assert.equal(getTerminal(info.id)?.id, info.id);

  assert.ok(await waitFor(() => (getScrollback(info.id) ?? "").length > 0), "the shell printed nothing");

  // A subscriber sees the live output, and only what comes after it attached.
  let live = "";
  const unsubscribe = subscribe(info.id, (data) => (live += data));
  assert.ok(unsubscribe, "subscribe() must return a detach function for a known id");
  t.after(() => unsubscribe?.());

  assert.equal(writeTo(info.id, "echo PI_TERMINAL_MARKER\r"), true);
  assert.ok(
    await waitFor(() => live.includes("PI_TERMINAL_MARKER")),
    `the echoed marker never came back (saw: ${JSON.stringify(live.slice(-200))})`,
  );
  assert.ok(getScrollback(info.id)?.includes("PI_TERMINAL_MARKER"), "the scrollback must hold the same output");

  // Detaching really detaches.
  unsubscribe?.();
  const before = live.length;
  writeTo(info.id, "echo AFTER_UNSUBSCRIBE\r");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(live.length, before, "an unsubscribed viewer must stop receiving chunks");

  assert.equal(resize(info.id, 100, 40), true);

  assert.equal(closeTerminal(info.id), true);
  assert.equal(getTerminal(info.id), null);
  assert.ok(!listTerminals().some((row) => row.id === info.id), "a closed terminal must leave the list");
  assert.equal(closeTerminal(info.id), false, "closing twice is not an error, just a no-op");
});

test("unknown ids answer without throwing", { skip }, () => {
  assert.equal(getTerminal("nope"), null);
  assert.equal(getScrollback("nope"), null);
  assert.equal(writeTo("nope", "x"), false);
  assert.equal(resize("nope", 80, 24), false);
  assert.equal(subscribe("nope", () => {}), null);
  assert.equal(closeTerminal("nope"), false);
});

test("a process that exits keeps its row, marked with the exit code", { skip }, async (t) => {
  const info = createTerminal({ kind: "shell", cwd: os.tmpdir() });
  t.after(() => closeTerminal(info.id));

  let changes = 0;
  setTerminalsChangedListener(() => (changes += 1));
  t.after(() => setTerminalsChangedListener(null));

  writeTo(info.id, "exit 3\r");
  assert.ok(await waitFor(() => getTerminal(info.id)?.exited !== null), "the shell never reported its exit");

  const row = getTerminal(info.id);
  assert.equal(row?.exited, 3, "the exit code must be the one the shell returned");
  assert.ok(
    listTerminals().some((entry) => entry.id === info.id),
    "an exited terminal stays listed until it is closed explicitly",
  );
  assert.equal(writeTo(info.id, "echo late\r"), false, "a dead terminal takes no input");
  assert.equal(resize(info.id, 90, 30), false, "a dead terminal takes no resize");
  assert.ok(changes >= 1, "the exit must notify the listener");

  const changesBeforeClose = changes;
  assert.equal(closeTerminal(info.id), true);
  assert.equal(changes, changesBeforeClose + 1, "closing must notify the listener too");
});

// Concluding a chat is not closing its terminals: the process stops, the row
// and its scrollback stay, so the pane can be reopened and read.
test("terminateTerminalsForChat: switches off one chat's terminals, keeps the rows", { skip }, async (t) => {
  const mine = createTerminal({ kind: "shell", cwd: os.tmpdir(), chatKey: "chat-A" });
  const other = createTerminal({ kind: "shell", cwd: os.tmpdir(), chatKey: "chat-B" });
  t.after(() => {
    closeTerminal(mine.id);
    closeTerminal(other.id);
  });
  assert.equal(getTerminal(mine.id)?.chatKey, "chat-A", "a terminal remembers the chat it was opened from");

  // The viewer of an open pane hears the death directly, without typing.
  let exits = 0;
  const unsubscribe = subscribe(mine.id, () => {}, () => (exits += 1));
  t.after(() => unsubscribe?.());

  assert.equal(terminateTerminalsForChat("chat-A"), 1);
  assert.ok(await waitFor(() => getTerminal(mine.id)?.exited !== null), "the terminal of the chat never died");
  assert.equal(getTerminal(other.id)?.exited, null, "another chat's terminal must not be touched");
  assert.notEqual(getScrollback(mine.id), null, "the row and its scrollback survive the process");
  assert.equal(writeTo(mine.id, "echo late\r"), false, "what is left is read-only");
  assert.equal(exits, 1, "the viewer must be told the process died, exactly once");
  assert.equal(terminateTerminalsForChat("chat-A"), 0, "a terminal already off is not switched off twice");
  assert.equal(terminateTerminalsForChat(""), 0, "no chat key, nothing to switch off");
});

// What a restart asks before it warns the user: only the processes still
// running are something to lose, an exited row is not.
test("countLiveTerminals: counts the processes, not the rows", { skip }, async (t) => {
  const before = countLiveTerminals();
  const info = createTerminal({ kind: "shell", cwd: os.tmpdir() });
  t.after(() => closeTerminal(info.id));
  assert.equal(countLiveTerminals(), before + 1, "a fresh terminal is a live one");

  writeTo(info.id, "exit 0\r");
  assert.ok(await waitFor(() => getTerminal(info.id)?.exited !== null), "the shell never reported its exit");
  assert.ok(
    listTerminals().some((entry) => entry.id === info.id),
    "the row is still there: it is the process that is gone",
  );
  assert.equal(countLiveTerminals(), before, "an exited terminal must not be counted");

  assert.equal(closeTerminal(info.id), true);
  assert.equal(countLiveTerminals(), before, "closing the row changes nothing either");
});

test("the scrollback of a noisy terminal stays at the cap", { skip }, async (t) => {
  const info = createTerminal({ kind: "shell", cwd: os.tmpdir() });
  t.after(() => closeTerminal(info.id));

  // ~300KB in one write: well past the 200KB cap.
  writeTo(info.id, "Write-Host ('x' * 300000)\r");
  assert.ok(
    await waitFor(() => (getScrollback(info.id) ?? "").length >= SCROLLBACK_CAP),
    "the terminal never printed enough to reach the cap",
  );
  // Let the rest of the burst land, then check nothing grew past the cap.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(getScrollback(info.id)?.length, SCROLLBACK_CAP, "the scrollback must be trimmed to the cap");

  // The only place the "too old to resume" branch is real: the head of this
  // output has been dropped, so offset 0 cannot be honoured and the viewer is
  // sent the window it can still have, marked as a reset.
  const stale = getScrollbackSince(info.id, 0);
  assert.equal(stale?.reset, true, "an offset older than the scrollback must reset the viewer");
  assert.equal(stale?.data.length, SCROLLBACK_CAP, "a reset carries the whole window that is left");
  assert.ok(stale.offset > SCROLLBACK_CAP, "the offset counts everything printed, cap or no cap");

  // An offset inside the window is resumed from exactly.
  const resumed = getScrollbackSince(info.id, stale.offset - 10);
  assert.equal(resumed?.reset, false);
  assert.equal(resumed?.data, getScrollback(info.id)?.slice(-10), "a resume must return the tail, and only it");
  assert.equal(getScrollbackSince(info.id, stale.offset)?.data, "", "a viewer that is up to date gets nothing");
  assert.equal(getScrollbackSince("nope", 0), null);
});

test("closeAllTerminals: empties the registry", { skip }, () => {
  createTerminal({ kind: "shell", cwd: os.tmpdir() });
  createTerminal({ kind: "shell", cwd: os.tmpdir() });
  assert.ok(listTerminals().length >= 2);
  closeAllTerminals();
  assert.deepEqual(listTerminals(), []);
});
