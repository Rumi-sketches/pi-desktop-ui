import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PromptQueue,
  PromptQueueError,
  createPromptQueueController,
  normalizePromptInput,
  queuedExtensionCommand,
} from "../prompt-queue.mjs";

function ids() {
  let value = 0;
  return () => `opaque-${++value}`;
}

const prompt = (text, type = "steer", images) => normalizePromptInput({ text, type, images });

function assertQueueError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PromptQueueError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

describe("the context prompt queue", () => {
  test("equal texts receive different opaque ids and one can be cancelled selectively", () => {
    const queue = new PromptQueue({ idFactory: ids() });
    const first = queue.enqueue(prompt("same"));
    const second = queue.enqueue(prompt("same"));

    assert.notEqual(first.id, second.id);
    assert.equal(queue.cancel(first.id).id, first.id);
    assert.deepEqual(queue.publicItems().map((item) => item.id), [second.id]);
    assertQueueError(() => queue.cancel(first.id), 409, "queued_prompt_removed");
  });

  test("counts utf8 text and decoded attachments but never exposes base64", () => {
    const queue = new PromptQueue({ idFactory: ids() });
    const imageData = Buffer.from("four").toString("base64");
    const item = queue.enqueue(prompt("è", "followUp", [{ data: imageData, mimeType: "image/png" }]));

    assert.equal(item.bytes, 6);
    assert.equal(queue.bytes, 6);
    assert.deepEqual(item.attachments, [{ mimeType: "image/png", bytes: 4 }]);
    assert.equal(JSON.stringify(queue.publicItems()).includes(imageData), false);
  });

  test("rejects malformed prompt payloads with specific causes", () => {
    assertQueueError(() => normalizePromptInput({ text: "x", type: "later" }), 400, "invalid_queue_type");
    assertQueueError(() => normalizePromptInput({ text: "", images: [] }), 400, "empty_prompt");
    assertQueueError(
      () => normalizePromptInput({ text: "x", images: [{ data: "not base64", mimeType: "image/png" }] }),
      400,
      "invalid_attachment",
    );
  });

  test("enforces item and aggregate byte limits independently", () => {
    const itemQueue = new PromptQueue({ idFactory: ids(), maxItems: 2 });
    itemQueue.enqueue(prompt("a"));
    itemQueue.enqueue(prompt("b"));
    assertQueueError(() => itemQueue.enqueue(prompt("c")), 409, "queue_item_limit");

    const byteQueue = new PromptQueue({ idFactory: ids(), maxBytes: 4 });
    byteQueue.enqueue(prompt("abc"));
    assertQueueError(() => byteQueue.enqueue(prompt("de")), 413, "queue_byte_limit");
  });

  test("dispatch preserves type order and marks ids as no longer cancellable", () => {
    const queue = new PromptQueue({ idFactory: ids() });
    const first = queue.enqueue(prompt("first"));
    const later = queue.enqueue(prompt("later", "followUp"));
    const second = queue.enqueue(prompt("second"));

    assert.deepEqual(queue.take("steer", 1).map((item) => item.id), [first.id]);
    assert.deepEqual(queue.publicItems().map((item) => item.id), [later.id, second.id]);
    assertQueueError(() => queue.cancel(first.id), 409, "queued_prompt_delivered");
  });

  test("recognizes extension commands without rejecting skills, templates or unknown slash text", () => {
    const commands = [
      { name: "reload", source: "extension" },
      { name: "review", source: "prompt" },
      { name: "skill:doctor", source: "skill" },
    ];
    assert.equal(queuedExtensionCommand("/reload now", commands)?.name, "reload");
    assert.equal(queuedExtensionCommand("/review now", commands), null);
    assert.equal(queuedExtensionCommand("/skill:doctor", commands), null);
    assert.equal(queuedExtensionCommand("/unknown", commands), null);
  });

  test("concurrent enqueue and cancellation calls cannot duplicate or lose another item", async () => {
    const queue = new PromptQueue({ idFactory: ids() });
    const inserted = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => queue.enqueue(prompt(`p${i}`)))));
    await Promise.all(inserted.filter((_, i) => i % 2 === 0).map((item) => Promise.resolve().then(() => queue.cancel(item.id))));
    assert.deepEqual(queue.publicItems().map((item) => item.id), inserted.filter((_, i) => i % 2 === 1).map((item) => item.id));
    assert.equal(new Set(inserted.map((item) => item.id)).size, 20);
  });
});

describe("delivery at public session boundaries", () => {
  function harness({ steeringMode = "one-at-a-time", followUpMode = "one-at-a-time" } = {}) {
    const delivered = [];
    const events = [];
    const session = {
      steeringMode,
      followUpMode,
      steer(text, images) { delivered.push({ type: "steer", text, images }); },
      followUp(text, images) { delivered.push({ type: "followUp", text, images }); },
    };
    const controller = createPromptQueueController({ session, emit: (event) => events.push(event), idFactory: ids() });
    return { controller, delivered, events };
  }

  test("steering is handed off at the first successful turn_end, before any later boundary", async () => {
    const { controller, delivered, events } = harness();
    controller.enqueue(prompt("redirect"));
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "toolUse" } });

    assert.deepEqual(delivered, [{ type: "steer", text: "redirect", images: undefined }]);
    assert.equal(controller.publicItems().length, 0);
    assert.equal(events.at(-1).action, "dispatch");
  });

  test("a cancelled duplicate never reaches the model", () => {
    const { controller, delivered } = harness();
    const cancelled = controller.enqueue(prompt("same"));
    controller.enqueue(prompt("same"));
    controller.cancel(cancelled.id);
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "toolUse" } });
    assert.deepEqual(delivered.map((item) => item.text), ["same"]);
  });

  test("follow-ups wait for a final agent_end and all-mode hands off the whole type", () => {
    const { controller, delivered } = harness({ followUpMode: "all" });
    controller.enqueue(prompt("one", "followUp"));
    controller.enqueue(prompt("steer stays", "steer"));
    controller.enqueue(prompt("two", "followUp"));
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "error" } });
    controller.onSessionEvent({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    assert.deepEqual(delivered, []);

    controller.onSessionEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    assert.deepEqual(delivered.map((item) => item.text), ["steer stays", "one", "two"]);
    assert.deepEqual(controller.publicItems(), []);
  });

  test("abort and terminal errors discard pending work instead of starting another model call", () => {
    for (const stopReason of ["aborted", "error"]) {
      const { controller, delivered, events } = harness();
      controller.enqueue(prompt("never delivered"));
      controller.enqueue(prompt("also never", "followUp"));
      controller.onSessionEvent({ type: "turn_end", message: { stopReason } });
      controller.onSessionEvent({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason }],
      });
      assert.deepEqual(delivered, []);
      assert.deepEqual(controller.publicItems(), []);
      assert.equal(events.at(-1).action, stopReason === "aborted" ? "aborted" : "error");
    }
  });

  test("attachments reach the SDK while queue SSE payloads remain metadata-only", () => {
    const { controller, delivered, events } = harness();
    const data = Buffer.from("image").toString("base64");
    controller.enqueue(prompt("look", "steer", [{ data, mimeType: "image/png" }]));
    assert.equal(JSON.stringify(events).includes(data), false);
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "toolUse" } });
    assert.equal(delivered[0].images[0].data, data);
  });

  test("skill and prompt-template invocations reach the public SDK methods unchanged", () => {
    const { controller, delivered } = harness({ steeringMode: "all" });
    controller.enqueue(prompt("/skill:doctor inspect"));
    controller.enqueue(prompt("/review current branch"));
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "toolUse" } });
    assert.deepEqual(delivered.map((item) => item.text), ["/skill:doctor inspect", "/review current branch"]);
  });

  test("the context-owned queue survives a draft-to-session rekey", () => {
    let key = "draft:C:/project";
    const events = [];
    const delivered = [];
    const session = {
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      steer(text) { delivered.push(text); },
      followUp() {},
    };
    const controller = createPromptQueueController({
      session,
      idFactory: ids(),
      emit: (event) => events.push({ ...event, key }),
    });
    controller.enqueue(prompt("survives"));
    key = "C:/sessions/chat.jsonl";
    controller.onSessionEvent({ type: "turn_end", message: { stopReason: "toolUse" } });
    assert.deepEqual(delivered, ["survives"]);
    assert.equal(events.at(-1).key, key);
  });
});
