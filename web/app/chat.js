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
  code: [],
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
const DROPPED_TAGS = new Set(['script', 'style', 'head', 'template']);
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
export const DEFAULT_IMAGE_LIMIT = 131_072;
const MAX_IMAGE_EDGE = 1280;
const SHRINK_ATTEMPTS = 10;
const SHRINK_FACTOR = 0.72;

function isSafeUrl(attribute, value) {
  const trimmed = value.trim();
  if (attribute === 'href') {
    return /^(https?:|mailto:)/i.test(trimmed);
  }
  return /^(data:image\/|https?:)/i.test(trimmed);
}

export function sanitize(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const fragment = window.document.createDocumentFragment();
  copyChildren(document.body, fragment, false);
  return fragment;
}

function copyChildren(from, into, insideLink) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (insideLink) {
        into.append(node.textContent);
      } else {
        appendLinkified(node.textContent, into);
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
  const allowedAttributes = ALLOWED_TAGS[tag];
  if (!allowedAttributes) {
    copyChildren(node, into, insideLink);
    return;
  }
  const element = document.createElement(tag);
  for (const attribute of allowedAttributes) {
    const value = node.getAttribute(attribute);
    if (value && isSafeUrl(attribute, value)) {
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

function appendLinkified(text, into) {
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
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
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
