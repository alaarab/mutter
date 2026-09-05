export const THEMES = {
  carbon: {
    title: 'Carbon',
    accent: '#EDEDF0',
    accentActive: '#CFCFD4',
    onAccent: '#0A0A0B',
    bg: '#08080A',
    surface: '#111113',
    elevated: '#1A1A1D',
    sunken: '#050506',
    separator: '#242427',
    ink: '#FAFAFA',
    body: '#B9B9BC',
    muted: '#7C7C80',
    glow: '0%',
  },
  graphite: {
    title: 'Graphite',
    accent: '#7C7CFF',
    accentActive: '#5F5FE0',
    onAccent: '#FFFFFF',
    bg: '#0B0B0D',
    surface: '#131316',
    elevated: '#1B1B20',
    sunken: '#08080A',
    separator: '#26262C',
    ink: '#F4F4F6',
    body: '#B5B5BE',
    muted: '#7B7B85',
    glow: '14%',
  },
  midnight: {
    title: 'Midnight',
    accent: '#3D9BFF',
    accentActive: '#1C77DB',
    onAccent: '#FFFFFF',
    bg: '#0B0F17',
    surface: '#151B26',
    elevated: '#1E2633',
    sunken: '#070A10',
    separator: '#232C3A',
    ink: '#EAF1FA',
    body: '#C3CFDE',
    muted: '#7C8B9E',
    glow: '18%',
  },
  slate: {
    title: 'Slate',
    accent: '#7AA2F7',
    accentActive: '#5A82D8',
    onAccent: '#0A0E16',
    bg: '#0D0F13',
    surface: '#161A20',
    elevated: '#1F242B',
    sunken: '#090A0D',
    separator: '#272D35',
    ink: '#EDF1F6',
    body: '#B2BCC7',
    muted: '#79838F',
    glow: '16%',
  },
  moss: {
    title: 'Moss',
    accent: '#4FB477',
    accentActive: '#3A9560',
    onAccent: '#04120A',
    bg: '#0A0B0A',
    surface: '#131614',
    elevated: '#1C201D',
    sunken: '#070807',
    separator: '#262B27',
    ink: '#EFF3EF',
    body: '#B5BEB6',
    muted: '#7B857C',
    glow: '14%',
  },
  plum: {
    title: 'Plum',
    accent: '#D96A9E',
    accentActive: '#B84C7E',
    onAccent: '#17070F',
    bg: '#0C0A0D',
    surface: '#161318',
    elevated: '#201C23',
    sunken: '#08070A',
    separator: '#2A2530',
    ink: '#F3F0F5',
    body: '#BDB6C3',
    muted: '#837C8A',
    glow: '14%',
  },
  paper: {
    title: 'Paper',
    accent: '#C2603E',
    accentActive: '#A44D2F',
    onAccent: '#FFFFFF',
    bg: '#F6F5F2',
    surface: '#FFFFFF',
    elevated: '#EDEBE6',
    sunken: '#E9E7E1',
    separator: '#DDDAD3',
    ink: '#1A1918',
    body: '#4C4A46',
    muted: '#85817B',
    glow: '0%',
    light: true,
  },
};

export const DEFAULT_THEME = 'carbon';

const NON_COLOR_KEYS = new Set(['title', 'light']);

function cssVariableName(key) {
  return `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

export function applyTheme(name) {
  const theme = THEMES[name] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    if (!NON_COLOR_KEYS.has(key)) {
      root.style.setProperty(cssVariableName(key), value);
    }
  }
  root.dataset.theme = name;
  root.dataset.light = theme.light ? 'on' : 'off';
  root.style.colorScheme = theme.light ? 'light' : 'dark';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme.surface);
}
