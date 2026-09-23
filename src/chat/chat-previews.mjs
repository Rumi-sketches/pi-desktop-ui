import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function decodePreviewImage(data, mimeType) {
  if (!IMAGE_TYPES.has(mimeType) || typeof data !== "string") return null;
  const encoded = data.startsWith(`data:${mimeType};base64,`) ? data.slice(`data:${mimeType};base64,`.length) : data;
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  const signatures = {
    "image/png": bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    "image/jpeg": bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
    "image/gif": ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")),
    "image/webp": bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
  };
  return signatures[mimeType] ? bytes : null;
}

export function createPreviewTools() {
  return [
    defineTool({
      name: "show_html",
      label: "Show HTML",
      description: "Display an HTML mockup directly in this chat, without writing a file. Scripts, forms and external assets are blocked. Maximum 256 KiB UTF-8.",
      promptSnippet: "Show a self-contained HTML/CSS mockup in the chat without creating a file",
      parameters: Type.Object({ html: Type.String({ description: "Complete self-contained HTML with optional inline CSS" }) }),
      async execute(_id, { html }) {
        if (!html || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Error("HTML preview must be non-empty and at most 256 KiB");
        return { content: [{ type: "text", text: "HTML preview available in the chat." }], details: {} };
      },
    }),
    defineTool({
      name: "show_image",
      label: "Show image",
      description: "Display already generated base64 image bytes in this chat, without writing a file. Supports PNG, JPEG, GIF and WebP up to 4 MiB. This tool does not generate images.",
      promptSnippet: "Display an existing base64 PNG, JPEG, GIF or WebP image in the chat",
      parameters: Type.Object({
        mimeType: Type.String({ description: "image/png, image/jpeg, image/gif or image/webp" }),
        data: Type.String({ description: "Base64 bytes or matching data URL" }),
      }),
      async execute(_id, { data, mimeType }) {
        if (!decodePreviewImage(data, mimeType)) throw new Error("Invalid image type, bytes or size (maximum 4 MiB)");
        return { content: [{ type: "text", text: "Image preview available in the chat." }], details: {} };
      },
    }),
  ];
}

export function previewKind(name) {
  return name === "show_html" ? "html" : name === "show_image" ? "image" : null;
}

export function previewFromBranch(branch, callId) {
  for (let i = 0; i < branch.length; i++) {
    const message = branch[i]?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const call = message.content.find((block) => block.type === "toolCall" && block.id === callId && previewKind(block.name));
    if (!call) continue;
    const result = branch.slice(i + 1).find((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === callId);
    if (!result || result.message.isError) return null;
    if (call.name === "show_html") {
      const html = call.arguments?.html;
      return typeof html === "string" && html && Buffer.byteLength(html, "utf8") <= MAX_HTML_BYTES
        ? { kind: "html", html } : null;
    }
    const { data, mimeType } = call.arguments ?? {};
    const bytes = decodePreviewImage(data, mimeType);
    return bytes ? { kind: "image", bytes, mimeType } : null;
  }
  return null;
}
