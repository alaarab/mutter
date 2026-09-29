export function $(id) {
  return document.getElementById(id);
}

export function el(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

const rowCaches = new WeakMap();

export function keyedRows(container) {
  const previous = rowCaches.get(container) ?? new Map();
  const next = new Map();
  const rows = [];
  return {
    add(key, signature, build) {
      const cached = previous.get(key);
      const element = cached?.rowSignature === signature ? cached : build();
      element.rowSignature = signature;
      next.set(key, element);
      rows.push(element);
    },
    get size() {
      return rows.length;
    },
    commit() {
      rowCaches.set(container, next);
      const kept = new Set(rows);
      let current = container.firstChild;
      for (const row of rows) {
        while (current && !kept.has(current)) {
          const following = current.nextSibling;
          current.remove();
          current = following;
        }
        if (row === current) {
          current = current.nextSibling;
          continue;
        }
        container.insertBefore(row, current);
      }
      while (current) {
        const following = current.nextSibling;
        current.remove();
        current = following;
      }
    },
  };
}

export function activate(element, handler) {
  element.onclick = () => handler();
  element.oncontextmenu = (event) => {
    event.preventDefault();
    handler();
  };
}

export function clickWithoutBubbling(button, action) {
  button.onclick = (event) => {
    event.stopPropagation();
    action();
  };
}

export function colorFor(name) {
  let hash = 5381;
  for (const byte of new TextEncoder().encode(name ?? '')) {
    hash = (hash * 33 + byte) >>> 0;
  }
  return `var(--avatar${hash % 6})`;
}

export function initials(name) {
  const parts = (name ?? '?').trim().split(/[\s_.\-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 1);
  return letters.toUpperCase();
}

export function avatar(name, size = 'm') {
  const element = el('span', { className: `avatar ${size}`, textContent: initials(name) });
  element.style.background = colorFor(name);
  return element;
}
