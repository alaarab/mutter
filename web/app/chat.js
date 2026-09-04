// Chat rendering. Mumble messages are HTML, so everything inbound goes through a whitelist
// before it touches the DOM. Images are sent the way desktop Mumble does: inline data URIs,
// shrunk until they fit the server's image message limit.

import { el, avatar } from './ui.js';

const ALLOWED = {
  a: ['href'], img: ['src', 'alt'], b: [], strong: [], i: [], em: [], u: [], s: [], br: [], p: [], span: [], div: [],
  ul: [], ol: [], li: [], pre: [], code: [], blockquote: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  table: [], thead: [], tbody: [], tr: [], td: [], th: [],
};
const safeUrl = (attr, v) => attr === 'href' ? /^(https?:|mailto:)/i.test(v.trim()) : /^(data:image\/|https?:)/i.test(v.trim());
const URL_RE = /https?:\/\/[^\s<>"']+/g;

export function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  copy(doc.body, frag, false);
  return frag;
}

function copy(from, to, inLink) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) { inLink ? to.append(node.textContent) : linkify(node.textContent, to); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.localName;
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'template') continue;
    const attrs = ALLOWED[tag];
    if (!attrs) { copy(node, to, inLink); continue; }          // unknown tag: keep the text, drop the tag
    const el = document.createElement(tag);
    for (const a of attrs) { const v = node.getAttribute(a); if (v && safeUrl(a, v)) el.setAttribute(a, v); }
    if (tag === 'a') {
      if (!el.getAttribute('href')) { copy(node, to, inLink); continue; }
      el.target = '_blank'; el.rel = 'noopener noreferrer';
    }
    if (tag === 'img') {
      const src = el.getAttribute('src');
      if (!src) continue;
      if (/^data:/i.test(src)) el.setAttribute('src', normaliseDataUri(src));
      el.alt ||= 'image';
    }
    copy(node, el, inLink || tag === 'a');
    to.append(el);
  }
}

// Desktop Mumble percent-encodes the base64 and breaks it into lines; make it plain again.
function normaliseDataUri(src) {
  const compact = src.replace(/\s+/g, '');
  try { return decodeURIComponent(compact); } catch { return compact; }
}

function linkify(text, to) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) to.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    to.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) to.append(text.slice(last));
}

export const plainText = html => (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
export const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/// One chat message, laid out like the iOS chat: avatar, name + scope pill + time, bubble; own
/// messages are accent bubbles on the right. Consecutive messages from the same person within
/// three minutes share one header. `ctx`: { myChannelId, channels, onImage, prev }.
export function renderMessage(m, ctx) {
  const root = el('div', { className: 'msg' });
  root.dataset.id = m.id;
  if (m.scope?.system) {
    root.classList.add('system');
    root.append(sanitize(m.html));
    return root;
  }
  const p = ctx.prev;
  const cont = p && !p.scope?.system && p.own === m.own && p.senderSession === m.senderSession && scopeKey(p.scope) === scopeKey(m.scope) && m.date - p.date < 180_000;
  root.classList.toggle('own', !!m.own);
  root.classList.toggle('cont', !!cont);
  const time = el('time', { textContent: m.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  const col = el('div', { className: 'col' });
  if (!cont) {
    const head = el('div', { className: 'head' });
    if (!m.own) head.append(el('span', { className: 'who', textContent: m.senderName ?? '…' }));
    const tag = scopeTag(m.scope, ctx);
    if (tag) head.append(el('span', { className: `tag${m.scope?.sessions?.length ? ' dm' : ''}`, textContent: tag }));
    head.append(time);
    col.append(head);
  }
  const bubble = el('div', { className: 'bubble' });
  bubble.append(sanitize(m.html));
  for (const img of bubble.querySelectorAll('img')) img.addEventListener('click', () => ctx.onImage?.(img.src));
  if (cont) bubble.title = time.textContent;
  col.append(bubble);
  if (!m.own) root.append(cont ? el('span', { className: 'avatar m spacer' }) : avatar(m.senderName));
  root.append(col);
  return root;
}

const scopeKey = s => s?.sessions?.length ? `dm:${s.sessions.join(',')}` : s?.treeId !== undefined ? `tree:${s.treeId}` : `ch:${s?.channelId ?? 0}`;

function scopeTag(scope, ctx) {
  if (!scope) return null;
  if (scope.sessions?.length) return 'DM';
  if (scope.treeId !== undefined) return `#${ctx.channels.get(scope.treeId)?.name ?? 'channel'} +`;
  if (scope.channelId !== undefined && scope.channelId !== ctx.myChannelId) return `#${ctx.channels.get(scope.channelId)?.name ?? 'channel'}`;
  return null;
}

/// Shrinks an image until the `<img>` fits in `maxChars` (the server's image limit).
///
/// murmur runs any message longer than textmessagelength through a strict XML parser
/// (Server::isTextAllowed) and silently drops what doesn't parse, so the tag must be
/// well-formed XHTML — `<img … />`, never `<img …>`.
export async function imageToHtml(file, maxChars = 131_072) {
  const bmp = await createImageBitmap(file);
  try {
    let long = Math.min(1280, Math.max(bmp.width, bmp.height));
    for (let attempt = 0; attempt < 10; attempt++) {
      const scale = long / Math.max(bmp.width, bmp.height);
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: attempt < 3 ? 0.85 : 0.72 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const html = `<img src="data:image/jpeg;base64,${btoa(b64)}" />`;
      if (html.length < maxChars) return html;
      long = Math.round(long * 0.72);
    }
  } finally { bmp.close(); }
  throw new Error('Image too large for this server');
}

/// Full-screen image viewer; click or Escape closes.
export function openViewer(src) {
  const v = document.getElementById('viewer');
  v.querySelector('img').src = src;
  v.hidden = false;
}
