// Chat rendering. Mumble messages are HTML, so everything inbound goes through a whitelist
// before it touches the DOM. Images are sent the way desktop Mumble does: inline data URIs,
// shrunk until they fit the server's image message limit.

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

/// One chat bubble. `ctx`: { myChannelId, channels, onImage }.
export function renderMessage(m, ctx) {
  const el = document.createElement('div');
  el.dataset.id = m.id;
  if (m.scope?.system) {
    el.className = 'msg system';
    el.append(sanitize(m.html));
    return el;
  }
  el.className = `msg${m.own ? ' own' : ''}`;
  const head = document.createElement('div');
  head.className = 'head';
  const who = document.createElement('span'); who.className = 'who'; who.textContent = m.senderName ?? '…';
  head.append(who);
  const tag = scopeTag(m.scope, ctx);
  if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; head.append(t); }
  const time = document.createElement('time'); time.textContent = m.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); head.append(time);
  const body = document.createElement('div');
  body.className = 'text';
  body.append(sanitize(m.html));
  for (const img of body.querySelectorAll('img')) img.addEventListener('click', () => ctx.onImage?.(img.src));
  el.append(head, body);
  return el;
}

function scopeTag(scope, ctx) {
  if (!scope) return null;
  if (scope.sessions?.length) return 'direct';
  if (scope.treeId !== undefined) return `${ctx.channels.get(scope.treeId)?.name ?? 'channel'} + below`;
  if (scope.channelId !== undefined && scope.channelId !== ctx.myChannelId) return ctx.channels.get(scope.channelId)?.name ?? 'channel';
  return null;
}

/// Shrinks an image until `<img src="data:…">` fits in `maxChars` (the server's image limit).
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
      const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      const html = `<img src="${url}">`;
      if (html.length <= maxChars) return html;
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
