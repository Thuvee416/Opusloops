// Adapted for the dependency-free Opusloops shell from React Bits' PixelCard effect.
// See REACT_BITS_LICENSE.md for the upstream copyright and license notice.
const FRAME_INTERVAL = 1000 / 60;

export const DOCK_PIXEL_PALETTES = Object.freeze({
  create: Object.freeze({
    activeColor: "#ff718d",
    gap: 6,
    speed: 38,
    colors: Object.freeze(["#ff5c7a", "#ffad42", "#bd6cff"])
  }),
  studio: Object.freeze({
    activeColor: "#d998ff",
    gap: 7,
    speed: 46,
    colors: Object.freeze(["#a96cff", "#ef5cff", "#ff91ca"])
  }),
  mix: Object.freeze({
    activeColor: "#45ffd8",
    gap: 6,
    speed: 32,
    colors: Object.freeze(["#00ffd1", "#43ef93", "#d7ff5c"])
  }),
  projects: Object.freeze({
    activeColor: "#ffba61",
    gap: 7,
    speed: 42,
    colors: Object.freeze(["#ffad42", "#ff755c", "#f15cae"])
  })
});

function effectiveSpeed(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 100) * 0.001;
}

class Pixel {
  constructor(context, width, height, x, y, color, speed, delay) {
    this.context = context;
    this.width = width;
    this.height = height;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.randomBetween(0.1, 0.9) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.32 + 0.08;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = this.randomBetween(this.minSize, this.maxSizeInteger);
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (width + height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
  }

  randomBetween(minimum, maximum) {
    return Math.random() * (maximum - minimum) + minimum;
  }

  draw() {
    if (this.size <= 0) return;
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.context.fillStyle = this.color;
    this.context.fillRect(
      this.x + centerOffset,
      this.y + centerOffset,
      this.size,
      this.size
    );
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (this.size >= this.maxSize) this.isShimmer = true;
    if (this.isShimmer) this.shimmer();
    else this.size = Math.min(this.maxSize, this.size + this.sizeStep);
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) {
      this.size = 0;
      this.isIdle = true;
      return;
    }
    this.size = Math.max(0, this.size - 0.1);
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) this.isReverse = true;
    else if (this.size <= this.minSize) this.isReverse = false;
    this.size += this.isReverse ? -this.speed : this.speed;
  }
}

class PixelDockEntry {
  constructor(button, options, wake, reducedMotion) {
    this.button = button;
    this.options = options;
    this.wake = wake;
    this.reducedMotion = reducedMotion;
    this.canvas = button.querySelector(".pixel-canvas");
    this.context = this.canvas?.getContext("2d", { alpha: true }) || null;
    this.pixels = [];
    this.width = 1;
    this.height = 1;
    this.mode = "idle";
    this.hovered = false;
    this.focused = false;

    this.handlePointerEnter = () => {
      this.hovered = true;
      this.syncEngagement();
    };
    this.handlePointerLeave = () => {
      this.hovered = false;
      this.syncEngagement();
    };
    this.handlePointerDown = () => {
      this.hovered = true;
      this.syncEngagement();
    };
    this.handleFocus = () => {
      this.focused = true;
      this.syncEngagement();
    };
    this.handleBlur = () => {
      this.focused = false;
      this.hovered = false;
      this.syncEngagement();
    };

    button.addEventListener("pointerenter", this.handlePointerEnter, { passive: true });
    button.addEventListener("pointerleave", this.handlePointerLeave, { passive: true });
    button.addEventListener("pointerdown", this.handlePointerDown, { passive: true });
    button.addEventListener("focus", this.handleFocus);
    button.addEventListener("blur", this.handleBlur);
    this.resize();
  }

  get engaged() {
    return this.button.classList.contains("is-active") || this.hovered || this.focused;
  }

  resize() {
    if (!this.canvas || !this.context) return;
    const rect = this.button.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * pixelRatio));
    this.canvas.height = Math.max(1, Math.round(this.height * pixelRatio));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const gap = Math.max(3, Number.parseInt(this.options.gap, 10) || 5);
    const speed = effectiveSpeed(this.options.speed);
    this.pixels = [];
    for (let x = 0; x < this.width; x += gap) {
      for (let y = 0; y < this.height; y += gap) {
        const color = this.options.colors[Math.floor(Math.random() * this.options.colors.length)];
        const dx = x - this.width / 2;
        const dy = y - this.height / 2;
        const delay = Math.sqrt(dx * dx + dy * dy);
        this.pixels.push(new Pixel(this.context, this.width, this.height, x, y, color, speed, delay));
      }
    }

    if (this.reducedMotion) this.drawStatic();
    else {
      this.mode = this.engaged ? "appear" : "idle";
      if (this.mode === "appear") this.wake();
    }
  }

  clear() {
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  drawStatic() {
    this.clear();
    const isActive = this.button.classList.contains("is-active");
    this.pixels.forEach((pixel, index) => {
      if (!isActive && index % 3 !== 0) return;
      pixel.size = isActive ? 1 + (index % 4) * 0.17 : 0.65;
      pixel.draw();
    });
    this.mode = "idle";
  }

  syncEngagement() {
    this.button.classList.toggle("is-pixel-engaged", this.engaged);
    if (this.reducedMotion) {
      this.drawStatic();
      return;
    }
    this.mode = this.engaged ? "appear" : "disappear";
    this.pixels.forEach((pixel) => {
      pixel.isIdle = false;
      if (this.mode === "appear" && pixel.size <= 0) pixel.counter = 0;
    });
    this.wake();
  }

  animate() {
    if (this.mode === "idle") return false;
    this.clear();
    let allIdle = true;
    this.pixels.forEach((pixel) => {
      pixel[this.mode]();
      if (!pixel.isIdle) allIdle = false;
    });
    if (this.mode === "disappear" && allIdle) {
      this.mode = "idle";
      this.clear();
      return false;
    }
    return true;
  }

  destroy() {
    this.button.removeEventListener("pointerenter", this.handlePointerEnter);
    this.button.removeEventListener("pointerleave", this.handlePointerLeave);
    this.button.removeEventListener("pointerdown", this.handlePointerDown);
    this.button.removeEventListener("focus", this.handleFocus);
    this.button.removeEventListener("blur", this.handleBlur);
    this.button.classList.remove("is-pixel-engaged");
    this.clear();
  }
}

class PixelDock {
  constructor(nav, reducedMotion) {
    this.nav = nav;
    this.reducedMotion = reducedMotion;
    this.frame = 0;
    this.lastFrame = 0;
    this.destroyed = false;
    this.entries = [];
    this.wake = this.wake.bind(this);

    nav.querySelectorAll(".nav-item[data-pixel-card]").forEach((button) => {
      const options = DOCK_PIXEL_PALETTES[button.dataset.pixelCard];
      if (options) this.entries.push(new PixelDockEntry(button, options, this.wake, reducedMotion));
    });
    if (this.entries.length !== Object.keys(DOCK_PIXEL_PALETTES).length) {
      throw new Error("PixelCard dock palette mapping is incomplete");
    }

    this.resizeObserver = "ResizeObserver" in window
      ? new ResizeObserver(() => this.entries.forEach((entry) => entry.resize()))
      : null;
    if (this.resizeObserver) this.resizeObserver.observe(nav);
    else {
      this.handleResize = () => this.entries.forEach((entry) => entry.resize());
      window.addEventListener("resize", this.handleResize, { passive: true });
    }

    this.mutationObserver = new MutationObserver((records) => {
      const changedButtons = new Set(records.map((record) => record.target));
      this.entries.forEach((entry) => {
        if (changedButtons.has(entry.button)) entry.syncEngagement();
      });
    });
    this.mutationObserver.observe(nav, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-current"]
    });

    this.entries.forEach((entry) => entry.syncEngagement());
    nav.classList.add("is-pixel-dock-ready");
    nav.dataset.pixelDockState = reducedMotion ? "static" : "ready";
    this.wake();
  }

  wake() {
    if (this.destroyed || this.reducedMotion || this.frame || document.hidden) return;
    const tick = (now) => {
      this.frame = 0;
      if (this.destroyed || document.hidden) return;
      const elapsed = now - this.lastFrame;
      if (elapsed < FRAME_INTERVAL) {
        this.frame = requestAnimationFrame(tick);
        return;
      }
      this.lastFrame = now - (elapsed % FRAME_INTERVAL);
      const animating = this.entries.reduce((active, entry) => entry.animate() || active, false);
      if (animating) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    if (!this.frame) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    if (!this.resizeObserver) window.removeEventListener("resize", this.handleResize);
    this.mutationObserver.disconnect();
    this.entries.forEach((entry) => entry.destroy());
    this.nav.classList.remove("is-pixel-dock-ready");
    this.nav.dataset.pixelDockState = "fallback";
  }
}

let effect = null;
const reducedMotion = typeof window === "undefined"
  ? null
  : window.matchMedia("(prefers-reduced-motion: reduce)");
const forcedColors = typeof window === "undefined"
  ? null
  : window.matchMedia("(forced-colors: active)");

function syncPixelDock() {
  const nav = document.querySelector("[data-pixel-dock]");
  if (!nav) return;
  if (forcedColors?.matches) {
    effect?.destroy();
    effect = null;
    nav.dataset.pixelDockState = "disabled";
    return;
  }
  const needsStaticMode = Boolean(reducedMotion?.matches);
  if (!effect || effect.reducedMotion !== needsStaticMode) {
    effect?.destroy();
    effect = new PixelDock(nav, needsStaticMode);
  }
  if (document.hidden) effect.stop();
  else effect.wake();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncPixelDock, { once: true });
  } else syncPixelDock();
  document.addEventListener("visibilitychange", syncPixelDock);
  reducedMotion?.addEventListener("change", syncPixelDock);
  forcedColors?.addEventListener("change", syncPixelDock);
}
