const PALETTE = ['#6E8BC7', '#6FB08A', '#C4885E', '#9B87C4', '#5FA6A0', '#C0A96A', '#C08192', '#8FA96B'];

export function $(id) {
  return document.getElementById(id);
}

export function el(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
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
  return PALETTE[hash % PALETTE.length];
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
