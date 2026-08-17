// The one place where the product is named. Everything that prints, titles a
// window or names a file on the user's desktop reads from here, so the app
// never speaks about itself with two different names again.
//
// PRODUCT_ID  — machine-facing: log prefixes, the launcher's filename, the npm
//               package name. Lowercase, hyphenated, safe in a path.
// PRODUCT_NAME — human-facing: the window title and the texts the user reads.
//
// What is NOT named here, and must never be renamed, are the *persisted* names:
// the `web-ui-*.json` stores, the `pi_web_ui_access` cookie and the
// `PI_WEB_UI_AGENT_DIR` / `PI_WEB_UI_TEST` env vars. They are on disk and in
// live installations; changing them would silently orphan someone's settings.
// See the comment in session-store.mjs.

export const PRODUCT_ID = "pi-desktop-ui";
export const PRODUCT_NAME = "pi desktop ui";
