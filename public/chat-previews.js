import { withSessionKey } from './transport.js';

const PREVIEW_TOOLS = { show_html: 'html', show_image: 'image' };

/**
 * Add a finished tool's preview without embedding its input in the event stream.
 * @param {HTMLElement} card
 * @param {{name:string, id?:string, isError?:boolean}} event
 * @param {string|null} key
 * @param {Document} documentRef
 * @param {(url:string)=>Promise<{ok:boolean, headers:{get:(name:string)=>string|null}, text:()=>Promise<string>}>} fetchRef
 */
export function showChatPreview(card, event, key, documentRef, fetchRef = fetch) {
  const kind = PREVIEW_TOOLS[event.name];
  if (!kind || !event.id || event.isError || card.querySelector('.chatPreview')) return;
  const container = documentRef.createElement('div');
  container.className = 'chatPreview';
  const url = withSessionKey(`/api/preview?call=${encodeURIComponent(event.id)}`, key);
  if (kind === 'image') {
    const image = documentRef.createElement('img');
    image.alt = 'Image generated in chat';
    image.src = url;
    container.appendChild(image);
  } else {
    const frame = documentRef.createElement('iframe');
    frame.title = 'HTML preview (isolated)';
    // Scripts can drive buttons inside the frame, but the frame has an opaque
    // origin and cannot access its parent, cookies, forms or popups.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    container.appendChild(frame);
    const source = documentRef.createElement('details');
    const toggle = documentRef.createElement('summary');
    toggle.textContent = 'HTML source';
    const code = documentRef.createElement('pre');
    source.append(toggle, code);
    container.appendChild(source);
    fetchRef(url).then((response) => {
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain')) throw new Error('Preview unavailable');
      return response.text();
    }).then((html) => {
      if (!container.isConnected) return;
      code.textContent = html;
      frame.src = withSessionKey(`/api/preview?call=${encodeURIComponent(event.id)}&view=1`, key);
    }).catch(() => {
      if (container.isConnected) container.textContent = 'Preview unavailable';
    });
  }
  card.appendChild(container);
}
