import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'design/themes.json'), 'utf8'));
const checking = process.argv.includes('--check');
const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16));
const hex = (values) => '#' + values.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
const mix = (a, b, amount) => hex(rgb(a).map((value, index) => value * amount + rgb(b)[index] * (1 - amount)));
const luminance = (color) => rgb(color).map((value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

// Preserve the palette's hue while making small text readable on every surface.
function readable(color, surfaces, target, light) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(light ? '#000000' : '#FFFFFF', color, step / 100);
    if (surfaces.every((surface) => contrast(candidate, surface) >= target)) return candidate;
  }
  throw new Error(`No readable foreground for ${color}`);
}

const themes = Object.fromEntries(Object.entries(source.themes).map(([name, theme]) => {
  const variants = Object.fromEntries(['light', 'dark'].map((mode) => {
    const light = mode === 'light';
    const colors = { ...theme[mode], ...source.semantics[mode] };
    const surfaces = [colors.bg, colors.surface, colors.elevated, colors.sunken];
    for (const role of ['ink', 'body', 'muted', 'accent', 'speaking', 'danger', 'warn', 'whisper']) {
      colors[role] = readable(colors[role], surfaces, role === 'ink' ? 7 : 4.8, light);
    }
    colors.accentActive = mix(colors.accent, colors.ink, 0.84);
    colors.onAccent = colors.onStatus;
    colors.online = colors.speaking;
    colors.away = colors.warn;
    colors.busy = colors.danger;
    colors.streaming = colors.whisper;
    colors.invisible = colors.muted;
    colors.onAvatar = colors.ink;
    colors.surfaceHighlight = mix(colors.ink, colors.surface, 0.04);
    colors.shadow = light ? '#433D50' : '#000000';
    colors.media = '#000000';
    colors.onMedia = '#FFFFFF';
    for (let index = 0; index < 6; index++) {
      colors[`avatar${index}`] = mix(mix(colors.accent, colors.secondary, index / 5), colors.surface, light ? 0.18 : 0.24);
    }
    for (const fill of ['accent', 'accentActive', 'speaking', 'danger', 'warn', 'whisper']) {
      const foreground = fill.startsWith('accent') ? colors.onAccent : colors.onStatus;
      if (contrast(foreground, colors[fill]) < 4.5) throw new Error(`${name}/${mode}: ${fill} button contrast`);
    }
    for (let index = 0; index < 6; index++) {
      if (contrast(colors.onAvatar, colors[`avatar${index}`]) < 4.5) throw new Error(`${name}/${mode}: avatar contrast`);
    }
    return [mode, colors];
  }));
  return [name, { title: theme.title, description: theme.description, ...variants }];
}));

const notice = 'Generated from design/themes.json by scripts/generate-themes.mjs. Do not edit.';
const cssName = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const defaults = themes[source.defaultTheme].dark;
const colorKeys = Object.keys(defaults);
const tokens = (colors) => Object.entries(colors).map(([key, value]) => `  --${cssName(key)}: ${value};`).join('\n');
const motionCSS = Object.entries(source.motion).filter(([key]) => key !== 'ease').map(([key, value]) => `  --duration-${key}: ${value}ms;`).join('\n');
const radiusCSS = Object.entries(source.radii).map(([key, value]) => `  --radius-${key}: ${value}px;`).join('\n');
const css = `/* ${notice} */
${colorKeys.map((key) => `@property --${cssName(key)} { syntax: '<color>'; inherits: true; initial-value: ${defaults[key]}; }`).join('\n')}

:root {
${tokens(defaults)}
${motionCSS}
${radiusCSS}
  --ease: cubic-bezier(${source.motion.ease.join(', ')});
  --t: var(--duration-fast) var(--ease);
  --t-move: var(--duration-standard) var(--ease);
  --shadow-strength: 28%;
  --ambient-strength: 10%;
  --edge: color-mix(in srgb, var(--ink) 8%, transparent);
  --hover: color-mix(in srgb, var(--ink) 6%, transparent);
  --active: color-mix(in srgb, var(--accent) 12%, var(--surface));
  --sheen: linear-gradient(155deg, color-mix(in srgb, var(--ink) 4%, transparent), transparent 65%);
  --ambient: radial-gradient(ellipse at 5% 0%, color-mix(in srgb, var(--accent) var(--ambient-strength), transparent), transparent 65%), radial-gradient(ellipse at 100% 100%, color-mix(in srgb, var(--secondary) var(--ambient-strength), transparent), transparent 65%);
  --control-fill: linear-gradient(155deg, var(--accent), var(--accent-active));
  --shadow-small: 0 4px 14px color-mix(in srgb, var(--shadow) var(--shadow-strength), transparent);
  --shadow-floating: 0 14px 40px color-mix(in srgb, var(--shadow) var(--shadow-strength), transparent);
  --media-overlay: color-mix(in srgb, var(--media) 65%, transparent);
  --backdrop: color-mix(in srgb, var(--bg) 78%, transparent);
}

:root[data-light='on'] {
  --shadow-strength: 12%;
  --ambient-strength: 6%;
}

:root.theme-ready {
  transition-property: ${colorKeys.map((key) => `--${cssName(key)}`).join(', ')};
  transition-duration: var(--duration-theme);
  transition-timing-function: var(--ease);
}

@media (prefers-reduced-motion: reduce) {
  :root { --duration-fast: 0ms; --duration-standard: 0ms; --duration-panel: 0ms; --duration-theme: 0ms; }
}
`;

const uint = (value) => `0x${value.slice(1)}`;
const swiftColors = (colors) => `ThemeColors(\n${Object.entries(colors).map(([key, value]) => `                ${key}: ${uint(value)}`).join(',\n')}\n            )`;
const swift = `// ${notice}
import Foundation

struct ThemeColors {
${colorKeys.map((key) => `    var ${key}: UInt32`).join('\n')}
    var avatars: [UInt32] { [${Array.from({ length: 6 }, (_, index) => `avatar${index}`).join(', ')}] }
}

struct ThemePalette {
    var light: ThemeColors
    var dark: ThemeColors
}

enum ThemeStyle: String, CaseIterable, Codable, Identifiable {
    case ${Object.keys(themes).join(', ')}
    var id: String { rawValue }
    static let defaultStyle: ThemeStyle = .${source.defaultTheme}
    var title: String {
        switch self {
${Object.entries(themes).map(([name, theme]) => `        case .${name}: return ${JSON.stringify(theme.title)}`).join('\n')}
        }
    }
    var subtitle: String {
        switch self {
${Object.entries(themes).map(([name, theme]) => `        case .${name}: return ${JSON.stringify(theme.description)}`).join('\n')}
        }
    }
    var palette: ThemePalette { ThemeCatalog.palettes[self]! }
}

enum ThemeCatalog {
    static let palettes: [ThemeStyle: ThemePalette] = [
${Object.entries(themes).map(([name, theme]) => `        .${name}: ThemePalette(\n            light: ${swiftColors(theme.light)},\n            dark: ${swiftColors(theme.dark)}\n        )`).join(',\n')}
    ]
}

enum DesignMotion {
${Object.entries(source.motion).filter(([key]) => key !== 'ease').map(([key, value]) => `    static let ${key}: Double = ${value / 1000}`).join('\n')}
    static let curve: [Double] = [${source.motion.ease.join(', ')}]
}

enum DesignRadius {
${Object.entries(source.radii).map(([key, value]) => `    static let ${key}: Double = ${value}`).join('\n')}
}
`;

const outputs = {
  'web/app/theme-data.js': `// ${notice}\nexport const DEFAULT_THEME = ${JSON.stringify(source.defaultTheme)};\nexport const THEMES = ${JSON.stringify(themes, null, 2)};\n`,
  'web/app/tokens.css': css,
  'Mutter/Shared/ThemeCatalog.swift': swift,
};
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web/app/manifest.webmanifest'), 'utf8'));
outputs['web/app/manifest.webmanifest'] = JSON.stringify({ ...manifest, background_color: defaults.bg, theme_color: defaults.bg }, null, 2) + '\n';
for (const [name, role] of [['AccentColor', 'accent'], ['LaunchBackground', 'bg']]) {
  outputs[`Mutter/Resources/Assets.xcassets/${name}.colorset/Contents.json`] = JSON.stringify({
    colors: ['light', 'dark'].map((mode) => ({
      idiom: 'universal',
      ...(mode === 'dark' ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}),
      color: {
        'color-space': 'srgb',
        components: Object.fromEntries([...rgb(themes[source.defaultTheme][mode][role]).map((value, index) => [['red', 'green', 'blue'][index], (value / 255).toFixed(3)]), ['alpha', '1.000']]),
      },
    })),
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n';
}
for (const [relative, contents] of Object.entries(outputs)) {
  const file = path.join(root, relative);
  if (checking) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents) throw new Error(`${relative} is stale. Run node scripts/generate-themes.mjs`);
  } else {
    fs.writeFileSync(file, contents);
  }
}
console.log(`${checking ? 'Checked' : 'Generated'} ${Object.keys(themes).length} themes, both appearances; text, status and button contrast pass.`);
