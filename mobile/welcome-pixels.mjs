// Original React Bits PixelCard appear / random shimmer / disappear behavior.
import { Pixel } from './pixel-dock.mjs?v=3';
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const colors = ['#fecdd3', '#fda4af', '#e11d48'];
let frame = 0, last = 0;
const entries = [...document.querySelectorAll('[data-pixel-button]')].map(canvas => ({
  canvas, host: canvas.parentElement, context: canvas.getContext('2d'), pixels: [],
  width: 1, height: 1, visible: true, hovered: false, focused: false, mode: 'idle'
})).filter(entry => entry.context);
function drawStatic(entry) {
  entry.context.clearRect(0, 0, entry.width, entry.height);
  entry.pixels.forEach((pixel, i) => { pixel.size = i % 3 ? .5 : 1.4; pixel.draw(); });
}
function resize(entry) {
  const rect = entry.host.getBoundingClientRect();
  entry.width = Math.max(1, rect.width); entry.height = Math.max(1, rect.height);
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  entry.canvas.width = entry.width * dpr; entry.canvas.height = entry.height * dpr;
  entry.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  entry.pixels = [];
  for (let x = 0; x < entry.width; x += 6) for (let y = 0; y < entry.height; y += 6) {
    const delay = Math.hypot(x-entry.width/2, y-entry.height/2);
    entry.pixels.push(new Pixel(entry.context, entry.width, entry.height, x, y, colors[Math.floor(Math.random()*colors.length)], .08, delay));
  }
  engage(entry);
}
function engage(entry) {
  entry.mode = entry.hovered || entry.focused ? 'appear' : 'disappear';
  if (motion.matches) drawStatic(entry);
  sync();
}
function tick(now) {
  frame = 0;
  if (document.hidden || motion.matches) return;
  if (now-last >= 1000/60) {
    last = now;
    entries.filter(entry => entry.visible && entry.mode !== 'idle').forEach(entry => {
      entry.context.clearRect(0, 0, entry.width, entry.height);
      entry.pixels.forEach(pixel => pixel[entry.mode]());
      if (entry.mode === 'disappear' && entry.pixels.every(pixel => pixel.isIdle)) entry.mode = 'idle';
    });
  }
  if (entries.some(entry => entry.visible && entry.mode !== 'idle')) frame = requestAnimationFrame(tick);
}
function sync() {
  cancelAnimationFrame(frame); frame = 0;
  if (motion.matches) entries.forEach(drawStatic);
  else if (!document.hidden && entries.some(entry => entry.visible && entry.mode !== 'idle')) frame = requestAnimationFrame(tick);
}
const sizes = new ResizeObserver(records => records.forEach(record => {
  const entry = entries.find(item => item.host === record.target); if (entry) resize(entry);
}));
const visibility = new IntersectionObserver(records => {
  records.forEach(record => { const entry = entries.find(item => item.host === record.target); if (entry) entry.visible = record.isIntersecting; }); sync();
});
entries.forEach(entry => {
  for (const event of ['pointerenter', 'pointerdown']) entry.host.addEventListener(event, () => { entry.hovered = true; engage(entry); }, { passive: true });
  for (const event of ['pointerleave', 'pointercancel']) entry.host.addEventListener(event, () => { entry.hovered = false; engage(entry); }, { passive: true });
  entry.host.addEventListener('focus', () => { entry.focused = true; engage(entry); });
  entry.host.addEventListener('blur', () => { entry.focused = false; entry.hovered = false; engage(entry); });
  resize(entry); sizes.observe(entry.host); visibility.observe(entry.host);
});
document.addEventListener('visibilitychange', sync);
motion.addEventListener('change', () => entries.forEach(engage));
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; });
window.addEventListener('pageshow', sync);
