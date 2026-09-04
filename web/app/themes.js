// The five palettes from Theme.swift, as CSS custom properties. Same hex values, same names.
export const THEMES = {
  midnight: { title: 'Midnight', accent: '#3D9BFF', accentActive: '#1C77DB', bg: '#0B0F17', surface: '#151B26', elevated: '#1E2633', sunken: '#070A10', separator: '#232C3A', ink: '#EAF1FA', body: '#C3CFDE', muted: '#7C8B9E' },
  ultra:    { title: 'Ultra',    accent: '#A8E831', accentActive: '#7FB513', bg: '#0B0B0C', surface: '#17181A', elevated: '#212328', sunken: '#060607', separator: '#2A2C31', ink: '#F2F3F0', body: '#CBCEC6', muted: '#878B84' },
  ember:    { title: 'Ember',    accent: '#FF6B35', accentActive: '#D9481A', bg: '#14100E', surface: '#1F1916', elevated: '#2B221D', sunken: '#0D0A08', separator: '#362B25', ink: '#FBF1EA', body: '#DCCCC0', muted: '#9C8B7E' },
  orchid:   { title: 'Orchid',   accent: '#C084FC', accentActive: '#9333EA', bg: '#120E18', surface: '#1C1626', elevated: '#271E33', sunken: '#0B0810', separator: '#322845', ink: '#F3EDFB', body: '#D4C8E4', muted: '#94869F' },
  mint:     { title: 'Mint',     accent: '#2DD4A7', accentActive: '#0E9C79', bg: '#08120F', surface: '#121D1A', elevated: '#1B2724', sunken: '#050C0A', separator: '#24332F', ink: '#E9F7F2', body: '#C2D6D0', muted: '#7E948E' },
};

export function applyTheme(name) {
  const t = THEMES[name] ?? THEMES.midnight;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(t)) if (k !== 'title') root.setProperty(`--${k === 'accentActive' ? 'accent-active' : k}`, v);
  document.documentElement.dataset.theme = name;
}
