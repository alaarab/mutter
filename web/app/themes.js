import { THEMES, DEFAULT_THEME } from './theme-data.js';

export { THEMES, DEFAULT_THEME };

const systemAppearance = matchMedia('(prefers-color-scheme: light)');
let currentTheme = DEFAULT_THEME;
let currentAppearance = 'system';

export function appearanceForSettings(settings) {
  if (['system', 'light', 'dark'].includes(settings.appearance)) return settings.appearance;
  // Keep the appearance of themes saved before the light/dark selector existed.
  return settings.theme ? (settings.theme === 'paper' ? 'light' : 'dark') : 'system';
}

export function resolveTheme(name, appearance = currentAppearance) {
  const mode = appearance === 'system' ? (systemAppearance.matches ? 'light' : 'dark') : appearance;
  return THEMES[Object.hasOwn(THEMES, name) ? name : DEFAULT_THEME][mode === 'light' ? 'light' : 'dark'];
}

export function applyTheme(name, appearance = currentAppearance) {
  currentTheme = Object.hasOwn(THEMES, name) ? name : DEFAULT_THEME;
  currentAppearance = ['system', 'light', 'dark'].includes(appearance) ? appearance : 'system';
  const colors = resolveTheme(currentTheme, currentAppearance);
  const mode = colors === THEMES[currentTheme].light ? 'light' : 'dark';
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
  root.dataset.theme = currentTheme;
  root.dataset.appearance = mode;
  root.dataset.light = mode === 'light' ? 'on' : 'off';
  root.style.colorScheme = mode;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', colors.bg);
  window.dispatchEvent(new CustomEvent('mutter-theme-change', { detail: { theme: currentTheme, appearance: mode } }));
}

systemAppearance.addEventListener('change', () => {
  if (currentAppearance === 'system') applyTheme(currentTheme);
});

// Resolve the saved palette before the app mounts, avoiding a dark flash on light themes.
let saved = {};
try { saved = JSON.parse(localStorage.getItem('mutter.settings') ?? '{}') ?? {}; } catch {}
applyTheme(saved.theme, appearanceForSettings(saved));
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('theme-ready')));
