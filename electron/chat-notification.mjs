// Keep the desktop notification limited to a short chat title, never a message body.
export function chatNotificationPayload(payload) {
  const { key, title } = payload ?? {};
  if (typeof key !== "string" || !key || key.length > 4096
      || typeof title !== "string" || !title || title.length > 100 || /[\r\n]/.test(title)) return null;
  return { key, title };
}
