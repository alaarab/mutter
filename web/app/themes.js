import { THEMES, DEFAULT_THEME } from './theme-data.js';
import { appearanceForSettings, themeName } from './preferences.js';

export { THEMES, DEFAULT_THEME, appearanceForSettings };

const systemAppearance = matchMedia('(prefers-color-scheme: light)');
let currentTheme = DEFAULT_THEME;
let currentAppearance = 'system';

export function resolveTheme(name, appearance = currentAppearance) {
  const mode = appearance === 'system' ? (systemAppearance.matches ? 'light' : 'dark') : appearance;
  return THEMES[themeName(name)][mode === 'light' ? 'light' : 'dark'];
}

export function applyTheme(name, appearance = currentAppearance) {
  currentTheme = themeName(name);
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


let saved = {};
try { saved = JSON.parse(localStorage.getItem('mutter.settings') ?? '{}') ?? {}; } catch {}
applyTheme(saved.theme, appearanceForSettings(saved));
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('theme-ready')));
