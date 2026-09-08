const button = document.getElementById('site-appearance');
const choices = ['system', 'light', 'dark'];
let appearance = 'system';
try {
  const saved = localStorage.getItem('mutter-docs-appearance');
  if (choices.includes(saved)) appearance = saved;
} catch {}
function applyAppearance() {
  document.documentElement.dataset.appearance = appearance;
  button.textContent = `Theme: ${appearance}`;
  button.setAttribute('aria-label', `Theme: ${appearance}. Switch to ${choices[(choices.indexOf(appearance) + 1) % choices.length]}.`);
}
button.hidden = false;
applyAppearance();
button.addEventListener('click', () => {
  appearance = choices[(choices.indexOf(appearance) + 1) % choices.length];
  applyAppearance();
  try { localStorage.setItem('mutter-docs-appearance', appearance); } catch {}
});
