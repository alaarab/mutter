const ALLOWED_TAGS = {
  a: ['href'],
  img: ['src', 'alt'],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  br: [],
  p: [],
  span: [],
  div: [],
  ul: [],
  ol: [],
  li: [],
  pre: [],
  code: ['class'],
  blockquote: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  td: [],
  th: [],
};
// The fence language Mutter's Markdown puts on code blocks; any other class is dropped.
export const CODE_LANGUAGE_CLASS = /^language-[a-z0-9+#-]{1,20}$/;
const DROPPED_TAGS = new Set(['script', 'style', 'head', 'template']);
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
export const DEFAULT_IMAGE_LIMIT = 131_072;
const MAX_IMAGE_EDGE = 1280;
const SHRINK_ATTEMPTS = 10;
const SHRINK_FACTOR = 0.72;
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const DATA_URI_PREFIX_CHARS = 100;

function isSafeUrl(attribute, value) {
  const trimmed = value.trim();
  if (attribute === 'href') {
    return /^(https?:|mailto:)/i.test(trimmed);
  }
  return /^https?:/i.test(trimmed) || RASTER_DATA_IMAGE.test(normaliseDataUri(trimmed.slice(0, DATA_URI_PREFIX_CHARS)));
}

export function sanitize(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();
  copyChildren(template.content, fragment, false);
  return fragment;
}

function copyChildren(from, into, insideLink) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (insideLink) {
        into.append(node.textContent);
      } else {
        linkify(node.textContent, into);
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    copyElement(node, into, insideLink);
  }
}

function copyElement(node, into, insideLink) {
  const tag = node.localName;
  if (DROPPED_TAGS.has(tag)) {
    return;
  }
  const allowedAttributes = Object.hasOwn(ALLOWED_TAGS, tag) ? ALLOWED_TAGS[tag] : undefined;
  if (!allowedAttributes) {
    copyChildren(node, into, insideLink);
    return;
  }
  if (tag === 'img' && /^https?:/i.test(node.getAttribute('src')?.trim() ?? '')) {
    const source = node.getAttribute('src').trim();
    let url;
    try { url = new URL(source); } catch { return; }
    if (url.username || url.password) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-load';
    button.textContent = `Load image · ${url.hostname}`;
    button.title = 'Loading shares your network address with this image host';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const image = document.createElement('img');
      image.alt = node.getAttribute('alt') || 'image';
      image.referrerPolicy = 'no-referrer';
      image.src = source;
      button.replaceWith(image);
    }, { once: true });
    into.append(button);
    return;
  }
  const element = document.createElement(tag);
  for (const attribute of allowedAttributes) {
    const value = node.getAttribute(attribute);
    if (attribute === 'class') {
      if (value && CODE_LANGUAGE_CLASS.test(value)) element.className = value;
    } else if (value && (attribute === 'alt' || isSafeUrl(attribute, value))) {
      element.setAttribute(attribute, value);
    }
  }
  if (tag === 'a') {
    if (!element.getAttribute('href')) {
      copyChildren(node, into, insideLink);
      return;
    }
    element.target = '_blank';
    element.rel = 'noopener noreferrer';
  }
  if (tag === 'img') {
    const source = element.getAttribute('src');
    if (!source) {
      return;
    }
    if (/^data:/i.test(source)) {
      element.setAttribute('src', normaliseDataUri(source));
    }
    element.alt ||= 'image';
  }
  copyChildren(node, element, insideLink || tag === 'a');
  into.append(element);
}

function normaliseDataUri(source) {
  const compact = source.replace(/\s+/g, '');
  try {
    return decodeURIComponent(compact);
  } catch {
    return compact;
  }
}

export function linkify(text, into) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) {
      into.append(text.slice(last, match.index));
    }
    const link = document.createElement('a');
    link.href = match[0];
    link.textContent = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    into.append(link);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    into.append(text.slice(last));
  }
}

export function plainText(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const text = template.content.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

const BLOCK_TAGS = new Set(['p', 'div', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// A message as text for the clipboard: line breaks, list items and code
// blocks keep their lines, where plainText folds everything onto one.
export function messageText(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  let text = '';
  const walk = (node, inPre) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += inPre ? child.textContent : child.textContent.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const tag = child.localName;
      if (tag === 'br') {
        text += '\n';
      } else if (tag === 'img') {
        text += '[image]';
      } else if (BLOCK_TAGS.has(tag)) {
        if (text && !text.endsWith('\n')) text += '\n';
        if (tag === 'li') text += child.parentElement?.localName === 'ol' ? `${[...child.parentElement.children].indexOf(child) + Number(child.parentElement.getAttribute('start') ?? 1)}. ` : '- ';
        if (tag === 'blockquote') text += '> ';
        walk(child, inPre || tag === 'pre');
        if (!text.endsWith('\n')) text += '\n';
      } else if (!['script', 'style', 'template'].includes(tag)) {
        walk(child, inPre);
      }
    }
  };
  walk(template.content, false);
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

export function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function renderJpeg(bitmap, longestEdge, quality) {
  const scale = longestEdge / Math.max(bitmap.width, bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function imageToHtml(file, maxChars = DEFAULT_IMAGE_LIMIT) {
  const bitmap = await createImageBitmap(file);
  try {
    let longestEdge = Math.min(MAX_IMAGE_EDGE, Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt++) {
      const quality = attempt < 3 ? 0.85 : 0.72;
      const bytes = await renderJpeg(bitmap, longestEdge, quality);
      const html = `<img src="data:image/jpeg;base64,${bytesToBase64(bytes)}" />`;
      if (html.length < maxChars) {
        return html;
      }
      longestEdge = Math.round(longestEdge * SHRINK_FACTOR);
    }
  } finally {
    bitmap.close();
  }
  throw new Error('Image too large for this server');
}

export function openViewer(source) {
  const viewer = document.getElementById('viewer');
  viewer.querySelector('img').src = source;
  viewer.hidden = false;
}
