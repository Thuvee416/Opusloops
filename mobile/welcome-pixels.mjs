// Reuse the dock's React Bits pixel shimmer; no WebGL contexts or dependencies.
import { Pixel } from './pixel-dock.mjs?v=3';

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const colors = ['#ff718d', '#ffba61', '#bd6cff', '#45cbaa'];
const entries = [...document.querySelectorAll('[data-pixel-wave], [data-pixel-button]')].map(canvas => ({
  canvas, context: canvas.getContext('2d'), pixels: [], visible: true, width: 0, height: 0
})).filter(entry => entry.context);
let frame = 0;
let last = 0;
let elapsed = 0;

function resize(entry) {
  const { canvas, context } = entry;
  const rect = canvas.getBoundingClientRect();
  entry.width = Math.max(1, rect.width);
  entry.height = Math.max(1, rect.height);
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  canvas.width = entry.width * dpr;
  canvas.height = entry.height * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const wave = canvas.hasAttribute('data-pixel-wave');
  const gap = wave ? 7 : 6;
  entry.pixels = [];
  for (let x = 0; x < entry.width; x += gap) {
    const position = x / entry.width;
    const envelope = Math.pow(Math.sin(position * Math.PI), 1.6);
    const amplitude = wave ? envelope : 1;
    for (let y = 0; y < entry.height; y += gap) {
      if (wave && Math.abs(y - entry.height / 2) > amplitude * entry.height * .44) continue;
      const pixel = new Pixel(context, entry.width, entry.height, x, y, colors[Math.min(3, Math.floor(position * 4))], .035, 0);
      pixel.size = pixel.maxSize;
      pixel.isShimmer = true;
      entry.pixels.push(pixel);
    }
  }
  draw(entry, true);
}

function draw(entry, still = false) {
  entry.context.clearRect(0, 0, entry.width, entry.height);
  const wave = entry.canvas.hasAttribute('data-pixel-wave');
  const time = still ? 0 : elapsed;
  for (const pixel of entry.pixels) {
    let edge = 1;
    if (wave) {
      const position = pixel.x / entry.width;
      const envelope = Math.pow(Math.sin(position * Math.PI), 1.6);
      const crest = .2 + .8 * Math.abs(Math.sin(position * 20 - time * 1.35));
      const height = envelope * crest * entry.height * .44;
      // Fade boundary pixels instead of snapping entire rows on and off.
      edge = Math.max(0, Math.min(1, (height - Math.abs(pixel.y - entry.height / 2)) / 7));
      if (!edge) continue;
    }
    entry.context.globalAlpha = edge;
    if (still) { pixel.size = pixel.maxSize; pixel.draw(); }
    else pixel.drawAnimated(time);
  }
  entry.context.globalAlpha = 1;
}

function tick(now) {
  frame = 0;
  if (document.hidden || motion.matches || !entries.some(entry => entry.visible)) return;
  if (now - last >= 1000 / 30) {
    elapsed += Math.min((now - last) / 1000, .05);
    last = now;
    entries.filter(entry => entry.visible).forEach(entry => draw(entry));
  }
  frame = requestAnimationFrame(tick);
}
function sync() {
  cancelAnimationFrame(frame);
  frame = 0;
  if (motion.matches) entries.forEach(entry => draw(entry, true));
  else if (!document.hidden && entries.some(entry => entry.visible)) { last = performance.now(); frame = requestAnimationFrame(tick); }
}
const sizes = new ResizeObserver(records => {
  records.forEach(record => { const entry = entries.find(item => item.canvas === record.target); if (entry) resize(entry); });
});
const visibility = new IntersectionObserver(records => {
  records.forEach(record => { const entry = entries.find(item => item.canvas === record.target); if (entry) entry.visible = record.isIntersecting; });
  sync();
});
entries.forEach(entry => { resize(entry); sizes.observe(entry.canvas); visibility.observe(entry.canvas); });
document.addEventListener('visibilitychange', sync);
motion.addEventListener('change', sync);
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; });
window.addEventListener('pageshow', sync);
sync();
