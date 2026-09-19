import test from "node:test";
import assert from "node:assert/strict";
import { createPullRequestTracker } from "../pull-requests.mjs";

const record = (message) => ({ type: "message", message });
const call = (id, command) => record({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
});
const result = (id, text, isError = false) => record({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  isError,
  content: [{ type: "text", text }],
});

test("tracks every distinct PR created by a chat in chronological order", () => {
  const tracker = createPullRequestTracker();
  for (const entry of [
    call("first", "git push && gh pr create --fill"),
    result("first", "https://github.com/acme/widgets/pull/41\n"),
    call("second", "gh pr create --title 'follow-up'"),
    result("second", "Created https://github.com/acme/widgets/pull/42"),
    result("first", "https://github.com/acme/widgets/pull/41"),
  ]) tracker.accept(entry);

  assert.deepEqual(tracker.values(), [
    { number: 41, url: "https://github.com/acme/widgets/pull/41" },
    { number: 42, url: "https://github.com/acme/widgets/pull/42" },
  ]);
});

test("does not treat quoted, commented, or prefixed text as a gh invocation", () => {
  const tracker = createPullRequestTracker();
  for (const entry of [
    call("quoted", "echo 'gh pr create'; echo done"),
    result("quoted", "https://github.com/acme/widgets/pull/51"),
    call("commented", "# gh pr create --fill\necho done"),
    result("commented", "https://github.com/acme/widgets/pull/52"),
    call("prefixed", "foo-gh pr create --fill"),
    result("prefixed", "https://github.com/acme/widgets/pull/53"),
  ]) tracker.accept(entry);

  assert.deepEqual(tracker.values(), []);
});

test("recognizes gh at the start of an executed shell segment", () => {
  const tracker = createPullRequestTracker();
  tracker.accept(call("assigned", "echo ready && GH_REPO=acme/widgets gh pr create --fill"));
  tracker.accept(result("assigned", "https://github.com/acme/widgets/pull/54"));

  assert.deepEqual(tracker.values(), [
    { number: 54, url: "https://github.com/acme/widgets/pull/54" },
  ]);
});

test("ignores URLs not returned by a successful gh pr create call", () => {
  const tracker = createPullRequestTracker();
  for (const entry of [
    call("list", "gh pr view 7"),
    result("list", "https://github.com/acme/widgets/pull/7"),
    record({ role: "assistant", content: [{ type: "toolCall", id: "other", name: "custom", arguments: { command: "gh pr create --fill" } }] }),
    result("other", "https://github.com/acme/widgets/pull/6"),
    call("failed", "gh pr create --fill"),
    result("failed", "https://github.com/acme/widgets/pull/8", true),
    record({ role: "assistant", content: [{ type: "text", text: "https://github.com/acme/widgets/pull/9" }] }),
  ]) tracker.accept(entry);

  assert.deepEqual(tracker.values(), []);
});
