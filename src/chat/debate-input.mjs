import { DebateError, parseDebateCycle } from '../../public/debate-contract.js';
import { composeAttachments, MAX_TEXT_ATTACHMENT_BYTES } from '../../public/attachments.js';
import { normalizePromptInput, PromptQueueError, PROMPT_QUEUE_MAX_BYTES } from './prompt-queue.mjs';

/** Private input plus a metadata-only projection. Never return input through HTTP/SSE. */
export function prepareDebateCycle(value, attachments = []) {
  const cycle = parseDebateCycle(value);
  if (!Array.isArray(attachments)) throw new DebateError('invalid_attachments', 'Attachments must be an array.');
  const files = attachments.map((item) => {
    if (!item || typeof item.name !== 'string' || !item.name.trim()) throw new DebateError('invalid_attachment', 'Every attachment needs a name.');
    if (item.kind === 'file' && typeof item.text === 'string') {
      if (Buffer.byteLength(item.text, 'utf8') > MAX_TEXT_ATTACHMENT_BYTES) throw new DebateError('attachment_too_large', 'Text attachments must not exceed 512 KB.', 413);
      return { kind: 'file', name: item.name, text: item.text };
    }
    if (item.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mimeType)) {
      return { kind: 'image', name: item.name, mimeType: item.mimeType, data: item.data };
    }
    throw new DebateError('invalid_attachment', 'Use text, code, PNG, JPEG, GIF or WebP attachments.');
  });
  let normalized;
  try { normalized = normalizePromptInput(composeAttachments(cycle.prompt, files)); }
  catch (error) {
    if (error instanceof PromptQueueError) throw new DebateError(error.code, error.message, error.status);
    throw error;
  }
  if (normalized.bytes > PROMPT_QUEUE_MAX_BYTES) throw new DebateError('attachments_too_large', 'Prompt and attachments exceed 32 MB.', 413);
  let imageIndex = 0;
  const metadata = files.map((item) => {
    const bytes = item.kind === 'file' ? Buffer.byteLength(item.text, 'utf8') : normalized.images[imageIndex++].bytes;
    return { kind: item.kind, name: item.name, bytes };
  });
  return { ...cycle, input: { text: normalized.text, images: normalized.images.map(({ data, mimeType }) => ({ data, mimeType })) }, attachments: metadata };
}

/** Persisted private inputs are validated without copying attachment bytes into public objects. */
export function validateCycleInput(cycle) {
  const normalized = normalizePromptInput(cycle.input);
  if (normalized.bytes > PROMPT_QUEUE_MAX_BYTES || !Array.isArray(cycle.attachments)
      || cycle.attachments.some((item) => !item || !['file', 'image'].includes(item.kind)
        || typeof item.name !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes < 0)) {
    throw new DebateError('invalid_checkpoint', 'Invalid saved attachments.', 409);
  }
  return { ...parseDebateCycle(cycle), input: { text: normalized.text, images: normalized.images.map(({ data, mimeType }) => ({ data, mimeType })) },
    attachments: cycle.attachments.map(({ name, kind, bytes }) => ({ name, kind, bytes })) };
}
