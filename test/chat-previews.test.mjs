import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewTools, decodePreviewImage, previewFromBranch } from "../src/chat/chat-previews.mjs";
import { showChatPreview } from "../public/chat-previews.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const data = png.toString("base64");
const html = '<h1>Demo</h1><script>parent.alert(1)</script>';
const call = (id, name, args) => ({ message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id, isError = false) => ({ message: { role: "toolResult", toolCallId: id, isError } });

test("preview tools validate input without echoing HTML or image data in results", async () => {
  const [showHtml, showImage] = /** @type {any[]} */ (createPreviewTools());
  assert.match((await showHtml.execute("a", { html })).content[0].text, /preview available/);
  assert.match((await showImage.execute("b", { mimeType: "image/png", data })).content[0].text, /preview available/);
  await assert.rejects(showHtml.execute("a", { html: "x".repeat(300_000) }), /at most/);
  await assert.rejects(showImage.execute("b", { mimeType: "image/svg+xml", data }), /Invalid image/);
  await assert.rejects(showImage.execute("b", { mimeType: "image/png", data: "AAAA" }), /Invalid image/);
  assert.deepEqual(decodePreviewImage(`data:image/png;base64,${data}`, "image/png"), png);
});

test("only successful preview calls in the active branch resolve", () => {
  const branch = [call("html", "show_html", { html }), result("html"), call("image", "show_image", { data, mimeType: "image/png" }), result("image")];
  assert.deepEqual(previewFromBranch(branch, "html"), { kind: "html", html });
  assert.deepEqual(previewFromBranch(branch, "image"), { kind: "image", bytes: png, mimeType: "image/png" });
  assert.equal(previewFromBranch(branch.slice(0, 1), "html"), null);
  assert.equal(previewFromBranch([branch[0], result("html", true)], "html"), null);
  assert.equal(previewFromBranch(branch, "another-branch"), null);
  assert.equal(previewFromBranch([call("bad", "show_image", { data: "AAAA", mimeType: "image/png" }), result("bad")], "bad"), null);
});

test("HTML preview loads interactive HTML only in an opaque-origin sandbox after fetching source", async () => {
  const elements = [];
  const documentRef = { createElement(tag) {
    const element = {
      tag, children: [], attributes: {}, isConnected: true,
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      querySelector(selector) { return selector === '.chatPreview' ? this.children.find((node) => node.className === 'chatPreview') : null; },
    };
    elements.push(element);
    return element;
  } };
  const card = documentRef.createElement('div');
  let requested;
  showChatPreview(/** @type {any} */ (card), { name: 'show_html', id: 'call-1' }, 'chat-key', /** @type {any} */ (documentRef), async (url) => {
    requested = url;
    return { ok: true, headers: { get: () => 'text/plain; charset=utf-8' }, text: async () => html };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = elements.find((element) => element.tag === 'iframe');
  assert.equal(requested, '/api/preview?call=call-1&s=chat-key');
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.equal(frame.src, '/api/preview?call=call-1&view=1&s=chat-key');
  assert.equal(frame.srcdoc, undefined);
  assert.equal(elements.find((element) => element.tag === 'pre').textContent, html);
});
