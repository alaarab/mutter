function svg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const MARK =
  '<svg viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="54" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6" aria-hidden="true"><path d="M128 370L128 230C128 140 200 140 256 290C312 140 384 140 384 230L384 370"/></svg>';

export const ICON = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff: svg('<path d="M15 9.5V6a3 3 0 0 0-6 0v1M9 12a3 3 0 0 0 5.2 2M5 11a7 7 0 0 0 11.6 5.2M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/>'),
  headphones: svg('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="4" y="14" width="4" height="6" rx="1.5"/><rect x="16" y="14" width="4" height="6" rx="1.5"/>'),
  headphonesOff: svg('<path d="M4 14v-2a8 8 0 0 1 13.5-5.8M20 12v2"/><rect x="4" y="14" width="4" height="6" rx="1.5"/><path d="M16 15.5A1.5 1.5 0 0 1 17.5 14H20v6h-2.5a1.5 1.5 0 0 1-1.5-1.5zM4 4l16 16"/>'),
  screen: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  screenOff: svg('<path d="M7 4h12a2 2 0 0 1 2 2v8M3 6v8a2 2 0 0 0 2 2h11M8 20h8M12 16v4M4 4l16 16"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  leave: svg('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 16l4-4-4-4M19 12H9"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 9"/>'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  join: svg('<path d="M13 5l7 7-7 7M20 12H4"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  message: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  volume: svg('<path d="M4 10v4h3l4 3V7L7 10H4zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>'),
  volumeOff: svg('<path d="M4 10v4h3l4 3V7L7 10H4zM16 9l4 6M20 9l-4 6"/>'),
  star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none"/>'),
  warn: svg('<path d="M12 3l10 18H2zM12 10v4M12 17.5h.01"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  server: svg('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>'),
  channels: svg('<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><rect x="3" y="10" width="18" height="4.5" rx="1.5"/><rect x="3" y="16" width="18" height="4.5" rx="1.5"/>'),
  quote: svg('<path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4.5-5.8"/>'),
  check: svg('<path d="M5 12l5 5L20 7"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>'),
  userPlus: svg('<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M18 8v6M15 11h6"/>'),
  userMinus: svg('<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M15 11h6"/>'),
};
