import { loadPreferences, setTitleGenerationEnabled, setLunaTitleFallbackEnabled, isTitleGenerationEnabled } from "../../src/storage/preferences.mjs";
import { withFileLock } from "../../src/storage/file-lock.mjs";

const [kind, file, handshake] = process.argv.slice(2);
async function ready() {
  if (handshake === "handshake") {
    const released = new Promise((resolve) => process.once("message", resolve));
    process.send?.("waiting");
    if (await released !== "ready") throw new Error("expected ready handshake");
  }
  process.send?.("ready");
}
if (kind === "hold" || kind === "crash") {
  await withFileLock(file, async () => {
    process.send?.("locked");
    if (kind === "crash") process.exit(22);
    await new Promise((resolve) => process.once("message", resolve));
  });
  process.exit(0);
}
if (kind === "network-check") {
  const { hasAccessToken, lanAccessEnabled } = await import("../../src/http/network.mjs");
  await ready();
  process.on("message", () => process.send?.({ enabled: lanAccessEnabled(), valid: hasAccessToken("fixture-token") }));
} else {
  await loadPreferences();
  await ready();
  process.on("message", async () => {
    try {
      if (kind === "check") {
        process.send?.({ enabled: isTitleGenerationEnabled() });
        return;
      }
      if (kind === "enabled") await setTitleGenerationEnabled(true);
      if (kind === "disabled") await setTitleGenerationEnabled(false);
      if (kind === "luna") await setLunaTitleFallbackEnabled(true);
      process.send?.("saved", () => process.disconnect());
    } catch (error) {
      process.send?.({ error: error.message, code: error.code }, () => process.disconnect());
    }
  });
}
