// Markdown typed in the composer becomes the HTML that Mumble carries, as
// Mumble's own desktop client does, so every client shows the formatting.
// Plain text comes out exactly as before: escaped, with <br /> for newlines.
// Mutter/Design/ChatMarkdown.swift is the same converter for iOS; both are
// checked against web/test/fixtures/markdown.json.

import { escapeHtml as escapeText } from './chat.js';

const FENCE = /^\s{0,3}```/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const URL = /^https?:\/\/[^\s<>"']+/;
const URL_TRAILING = /[.,;:!?)\]'"]+$/;

export function markdownToHtml(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  // Whether the last thing written was a line of prose, which a following
  // line of prose joins with <br />.
  let afterProse = false;
  const block = (html) => {
    out.push(html);
    afterProse = false;
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (FENCE.test(line)) {
      const code = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index++]);
      }
      index++;
      block(`<pre><code>${escapeText(code.join('\n'))}</code></pre>`);
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (list) {
      const items = [];
      let start = null;
      while (index < lines.length && list.test(lines[index])) {
        const match = lines[index++].match(list);
        start ??= list === NUMBERED ? Number(match[1]) : null;
        items.push(`<li>${inline(match[match.length - 1])}</li>`);
      }
      if (list === BULLET) {
        block(`<ul>${items.join('')}</ul>`);
      } else {
        block(`<ol${start !== null && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>`);
      }
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index++].match(QUOTE)[1]);
      }
      block(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      block(`<h3>${inline(heading[1])}</h3>`);
      index++;
      continue;
    }
    if (afterProse) {
      out.push('<br />');
    }
    out.push(inline(line));
    afterProse = true;
    index++;
  }
  return out.join('');
}

// Inline marks: `code`, **bold**, *italic*, _italic_, ~~strike~~, [text](url)
// and bare http(s) links. Code spans are taken first, so nothing inside them
// is formatted.
function inline(text) {
  let html = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index];
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        html += `<code>${escapeText(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }
    if (char === '[') {
      const match = rest.match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/);
      if (match) {
        html += `<a href="${escapeText(match[2])}">${inline(match[1])}</a>`;
        index += match[0].length;
        continue;
      }
    }
    if (char === 'h' && boundaryBefore(text, index)) {
      const match = rest.match(URL);
      if (match) {
        const url = match[0].replace(URL_TRAILING, '');
        html += `<a href="${escapeText(url)}">${escapeText(url)}</a>`;
        index += url.length;
        continue;
      }
    }
    const span = emphasis(text, index);
    if (span) {
      html += `<${span.tag}>${inline(span.inner)}</${span.tag}>`;
      index = span.end;
      continue;
    }
    html += escapeText(char);
    index++;
  }
  return html;
}

const MARKS = [
  { mark: '**', tag: 'b' },
  { mark: '__', tag: 'b' },
  { mark: '~~', tag: 's' },
  { mark: '*', tag: 'i' },
  { mark: '_', tag: 'i' },
];

function emphasis(text, index) {
  for (const { mark, tag } of MARKS) {
    if (!text.startsWith(mark, index)) {
      continue;
    }
    // Underscores inside words (snake_case) are not emphasis.
    if (mark[0] === '_' && !boundaryBefore(text, index)) {
      continue;
    }
    const open = index + mark.length;
    if (open >= text.length || /\s/.test(text[open]) || text.startsWith(mark[0], open)) {
      continue;
    }
    let close = text.indexOf(mark, open + 1);
    while (close !== -1) {
      const after = close + mark.length;
      const closesWord = !/\s/.test(text[close - 1]) && !(mark.length === 1 && text[after] === mark);
      const underscoreBoundary = mark[0] !== '_' || after >= text.length || !/[\p{L}\p{N}]/u.test(text[after]);
      if (closesWord && underscoreBoundary && !text.slice(open, close).includes('`')) {
        return { tag, inner: text.slice(open, close), end: after };
      }
      close = text.indexOf(mark, close + 1);
    }
  }
  return null;
}

function boundaryBefore(text, index) {
  return index === 0 || !/[\p{L}\p{N}_]/u.test(text[index - 1]);
}
