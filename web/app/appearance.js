import { THEMES, applyTheme, resolveTheme } from './themes.js';
import { el } from './ui.js';

export function mountAppearance({ container, selector, description, settings, save }) {
  const cards = new Map();

  function choose(key, value) {
    settings[key] = value;
    save();
    applyTheme(settings.theme, settings.appearance);
  }

  for (const button of selector.querySelectorAll('button')) {
    button.onclick = () => choose('appearance', button.dataset.value);
  }

  for (const [name, theme] of Object.entries(THEMES)) {
    const preview = el('span', { className: 'theme-preview' },
      el('span', { className: 'preview-rail' }),
      el('span', { className: 'preview-sidebar' }),
      el('span', { className: 'preview-chat' }, el('i'), el('i'), el('i')));
    preview.setAttribute('aria-hidden', 'true');
    const card = el('button', { type: 'button', className: 'theme-card', title: theme.description }, preview,
      el('span', { className: 'theme-name', textContent: theme.title }));
    card.dataset.theme = name;
    card.onclick = () => choose('theme', name);
    cards.set(name, card);
    container.append(card);
  }

  function render() {
    for (const button of selector.querySelectorAll('button')) {
      const selected = button.dataset.value === settings.appearance;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    for (const [name, card] of cards) {
      const palette = resolveTheme(name, settings.appearance);
      for (const role of ['bg', 'surface', 'elevated', 'accent', 'secondary', 'separator']) {
        card.style.setProperty(`--preview-${role}`, palette[role]);
      }
      card.classList.toggle('on', settings.theme === name);
      card.setAttribute('aria-pressed', String(settings.theme === name));
    }
    description.textContent = THEMES[settings.theme].description;
  }

  window.addEventListener('mutter-theme-change', render);
  render();
  return { render };
}
