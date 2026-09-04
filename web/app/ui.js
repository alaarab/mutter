// Small DOM helpers shared by the views.

export const $ = id => document.getElementById(id);
export const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };

/// Avatar colours: evenly spaced around the wheel at one saturation, same table as Theme.swift.
export const PALETTE = ['#3D9BFF', '#3DDC84', '#FF6B35', '#C084FC', '#2DD4A7', '#FFC53D', '#FF7AA2', '#A8E831'];
export const colorFor = name => { let h = 5381; for (const b of new TextEncoder().encode(name ?? '')) h = ((h * 33) + b) >>> 0; return PALETTE[h % PALETTE.length]; };

/// Initials, like the iOS Avatar: "marcus_k" → MK, "ali" → A.
export const initials = name => {
  const parts = (name ?? '?').trim().split(/[\s_.\-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 1)).toUpperCase();
};

export function avatar(name, size = 'm') {
  const a = el('span', { className: `avatar ${size}`, textContent: initials(name) });
  a.style.background = colorFor(name);
  return a;
}
