const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new WeakMap();

export function isVisible(element) {
  return !element.hidden && element.dataset.closing !== 'true';
}


export function setVisible(element, visible, kind = 'popover') {
  const previous = animations.get(element);
  previous?.cancel();
  animations.delete(element);
  delete element.dataset.closing;
  element.inert = !visible;
  if (!visible && element.hidden) return;
  element.hidden = false;
  if (!visible) element.dataset.closing = 'true';
  const style = getComputedStyle(document.documentElement);
  const duration = reducedMotion.matches ? 0 : parseFloat(style.getPropertyValue('--duration-panel'));
  const offset = kind === 'sheet' ? 'translateX(18px)' : 'translateY(-4px) scale(.98)';
  const frames = [{ opacity: 0, transform: offset }, { opacity: 1, transform: 'none' }];
  if (!visible) frames.reverse();
  const finish = () => {
    element.hidden = !visible;
    delete element.dataset.closing;
  };
  if (!duration) { finish(); return; }
  const animation = element.animate(frames, { duration, easing: style.getPropertyValue('--ease').trim() });
  animations.set(element, animation);
  animation.finished.then(() => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    finish();
  }).catch(() => {});
}
