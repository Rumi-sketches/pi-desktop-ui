// Shared file ingestion and payload formatting for chat and debate composers.
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|log|html?|css|scss|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|sql|xml|svg|vue|svelte|env|gitignore|dockerfile)$/i;

export function readAttachmentFiles(files, { reader, append, report }) {
  for (const file of files) {
    if (!file) continue;
    if (file.type.startsWith('image/')) {
      const r = reader();
      r.onload = () => {
        const url = String(r.result);
        append({ kind: 'image', name: file.name || 'image', url, data: url.split(',')[1], mimeType: file.type });
      };
      r.readAsDataURL(file);
    } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || !file.type) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) { report(`${file.name}: too large (max 512 KB)`); continue; }
      const r = reader();
      r.onload = () => append({ kind: 'file', name: file.name, text: String(r.result) });
      r.readAsText(file);
    } else report(`${file.name}: unsupported type (use text, code or images)`);
  }
}

export function composeAttachments(text, attachments) {
  const images = attachments.filter((item) => item.kind === 'image').map(({ data, mimeType }) => ({ data, mimeType }));
  for (const attachment of attachments.filter((item) => item.kind === 'file')) {
    text += `\n\n--- attached file: ${attachment.name} ---\n\`\`\`\n${attachment.text}\n\`\`\``;
  }
  return { text, images };
}
