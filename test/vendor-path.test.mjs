/**
 * vendorFilePath() decides which files under node_modules the browser may pull
 * through /vendor/. Everything it rejects becomes a 404, so the interesting
 * cases are the ones that must return null.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_ROUTES, vendorFilePath } from "../http.mjs";

const VENDOR_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules");

test("the provider icon module is a served page asset", async () => {
  const route = PAGE_ROUTES.find(([method, pathname]) => method === "GET" && pathname === "/provider-icons.js");
  assert.ok(route);
  let status;
  let headers;
  let body;
  const res = {
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = value; },
  };
  const handler = /** @type {(bag: any) => Promise<void>} */ (route[2]);
  await handler({ res, url: new URL("http://localhost/provider-icons.js") });
  assert.equal(status, 200);
  assert.equal(headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.match(body.toString("utf8"), /export function providerIcon/);
});

test("vendorFilePath: an allowed asset resolves inside node_modules", () => {
  assert.equal(vendorFilePath("/vendor/marked/lib/marked.esm.js"), path.join(VENDOR_ROOT, "marked/lib/marked.esm.js"));
  assert.equal(
    vendorFilePath("/vendor/@lobehub/icons-static-svg/icons/openai.svg"),
    path.join(VENDOR_ROOT, "@lobehub/icons-static-svg/icons/openai.svg"),
  );
});

test("vendorFilePath: a percent-escape is decoded, not passed through", () => {
  assert.equal(
    vendorFilePath("/vendor/@highlightjs/cdn-assets/styles/github%2Ddark.css"),
    path.join(VENDOR_ROOT, "@highlightjs/cdn-assets/styles/github-dark.css"),
  );
});

test("vendorFilePath: a malformed percent-escape is rejected instead of throwing", () => {
  assert.equal(vendorFilePath("/vendor/marked/lib/%ZZ.js"), null);
  assert.equal(vendorFilePath("/vendor/marked/lib/marked%.js"), null);
});

test("vendorFilePath: a path outside the allow-list is rejected", () => {
  assert.equal(vendorFilePath("/vendor/express/index.js"), null);
});

// The `highlight.js` package is CommonJS behind ES shims: serving it would give
// the page a module that cannot load. Only the cdn-assets build is allowed.
test("vendorFilePath: the CommonJS highlight.js package stays unreachable", () => {
  assert.equal(vendorFilePath("/vendor/highlight.js/es/common.js"), null);
  assert.equal(vendorFilePath("/vendor/highlight.js/lib/common.js"), null);
});

test("vendorFilePath: an extension outside the served types is rejected", () => {
  assert.equal(vendorFilePath("/vendor/marked/package.json"), null);
});

test("vendorFilePath: traversal cannot escape node_modules", () => {
  assert.equal(vendorFilePath("/vendor/marked/lib/../../../secret.js"), null);
  assert.equal(vendorFilePath("/vendor/marked/lib/..%2F..%2F..%2Fsecret.js"), null);
});
