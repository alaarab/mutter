import { applyTheme } from './themes.js';

let sources = [];
let kind = 'screen';
let chosen = null;
const grid = document.getElementById('grid');
const shareButton = document.getElementById('share');

function sourceCard(source) {
  const card = document.createElement('button');
  card.dataset.source = source.id;
  card.className = 'src' + (chosen === source.id ? ' on' : '');
  card.innerHTML = `<img class="thumb" alt=""><span class="name">${source.icon ? '<img alt="">' : ''}<span></span></span>`;
  card.querySelector('.thumb').src = source.thumb;
  if (source.icon) {
    card.querySelector('.name img').src = source.icon;
  }
  card.querySelector('.name span').textContent = source.name;
  card.setAttribute('aria-pressed', String(chosen === source.id));
  card.onclick = () => {
    chosen = source.id;
    shareButton.disabled = false;
    for (const element of grid.children) {
      const selected = element.dataset.source === chosen;
      element.classList.toggle('on', selected);
      element.setAttribute('aria-pressed', String(selected));
    }
  };
  card.ondblclick = () => window.picker.choose(source.id);
  return card;
}

function render() {
  grid.replaceChildren();
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.classList.toggle('on', tab.dataset.kind === kind);
    tab.setAttribute('aria-pressed', String(tab.dataset.kind === kind));
  }
  const visible = sources.filter((source) => source.kind === kind);
  if (!visible.length) {
    grid.innerHTML = '<div class="empty">Nothing to show here.</div>';
    return;
  }
  for (const source of visible) {
    grid.append(sourceCard(source));
  }
}

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => {
    kind = tab.dataset.kind;
    chosen = null;
    shareButton.disabled = true;
    render();
  };
}

window.picker.onSetup(({ sources: list, theme, appearance }) => {
  applyTheme(theme, appearance);
  sources = list;
  if (!sources.some((source) => source.kind === 'screen')) {
    kind = 'window';
  }
  render();
});

shareButton.onclick = () => {
  if (chosen) {
    window.picker.choose(chosen);
  }
};
document.getElementById('cancel').onclick = () => window.close();
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.close();
  }
});
