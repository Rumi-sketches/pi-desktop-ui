const WEB_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const WINDOWS_PROTOCOLS = new Set(["ms-settings:"]);

/**
 * Decide whether a renderer link may leave the desktop window.
 * Keep OS protocols explicit: model output must not be able to invoke an
 * arbitrary registered application.
 *
 * @param {string} target
 * @param {NodeJS.Platform} [platform]
 */
export function isAllowedExternalUrl(target, platform = process.platform) {
  let protocol;
  try {
    protocol = new URL(target).protocol;
  } catch {
    return false;
  }
  return WEB_PROTOCOLS.has(protocol)
    || (platform === "win32" && WINDOWS_PROTOCOLS.has(protocol));
}
