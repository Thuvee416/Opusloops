const MAX_COLORS = 8;
const TARGET_FRAME_INTERVAL = 1000 / 30;
const THREE_ASSET_VERSION = "1851";

export const DOCK_COLOR_BENDS_PALETTES = Object.freeze({
  create: Object.freeze({
    colors: Object.freeze(["#ff5c7a", "#ffb86b", "#8a5cff"]),
    rotation: 90,
    autoRotate: 2.4,
    speed: 0.18,
    scale: 0.82,
    frequency: 0.9
  }),
  studio: Object.freeze({
    colors: Object.freeze(["#8a5cff", "#ff4fa3", "#ff7a66"]),
    rotation: 38,
    autoRotate: -2,
    speed: 0.21,
    scale: 0.9,
    frequency: 1.05
  }),
  mix: Object.freeze({
    colors: Object.freeze(["#00ffd1", "#2be46e", "#d7ff5c"]),
    rotation: 126,
    autoRotate: 1.7,
    speed: 0.16,
    scale: 0.86,
    frequency: 0.96
  }),
  projects: Object.freeze({
    colors: Object.freeze(["#ffad42", "#ff5cad", "#934cff"]),
    rotation: 164,
    autoRotate: -2.6,
    speed: 0.2,
    scale: 0.94,
    frequency: 1.12
  })
});

const FRAGMENT_SHADER = `
#define MAX_COLORS ${MAX_COLORS}
uniform vec2 uCanvas;
uniform float uTime;
uniform float uSpeed;
uniform vec2 uRot;
uniform int uColorCount;
uniform vec3 uColors[MAX_COLORS];
uniform int uTransparent;
uniform float uScale;
uniform float uFrequency;
uniform float uWarpStrength;
uniform vec2 uPointer;
uniform float uMouseInfluence;
uniform float uParallax;
uniform float uNoise;
uniform int uIterations;
uniform float uIntensity;
uniform float uBandWidth;
uniform float uCornerRadius;
varying vec2 vUv;

float roundedMask(vec2 uv, vec2 size, float radius) {
  vec2 halfSize = size * 0.5;
  vec2 point = abs(uv * size - halfSize) - (halfSize - vec2(radius));
  float distanceToEdge = length(max(point, 0.0)) + min(max(point.x, point.y), 0.0) - radius;
  return 1.0 - smoothstep(-1.0, 1.0, distanceToEdge);
}

void main() {
  float t = uTime * uSpeed;
  vec2 p = vUv * 2.0 - 1.0;
  p += uPointer * uParallax * 0.1;
  vec2 rp = vec2(p.x * uRot.x - p.y * uRot.y, p.x * uRot.y + p.y * uRot.x);
  vec2 q = vec2(rp.x * (uCanvas.x / uCanvas.y), rp.y);
  q /= max(uScale, 0.0001);
  q /= 0.5 + 0.2 * dot(q, q);
  q += 0.2 * cos(t) - 7.56;
  vec2 toward = uPointer - rp;
  q += toward * uMouseInfluence * 0.2;

  for (int j = 0; j < 5; j++) {
    if (j >= uIterations - 1) break;
    vec2 rr = sin(1.5 * (q.yx * uFrequency) + 2.0 * cos(q * uFrequency));
    q += (rr - q) * 0.15;
  }

  vec3 col = vec3(0.0);
  float a = 1.0;

  if (uColorCount > 0) {
    vec2 s = q;
    vec3 sumCol = vec3(0.0);
    float cover = 0.0;
    for (int i = 0; i < MAX_COLORS; ++i) {
      if (i >= uColorCount) break;
      s -= 0.01;
      vec2 r = sin(1.5 * (s.yx * uFrequency) + 2.0 * cos(s * uFrequency));
      float m0 = length(r + sin(5.0 * r.y * uFrequency - 3.0 * t + float(i)) / 4.0);
      float kBelow = clamp(uWarpStrength, 0.0, 1.0);
      float kMix = pow(kBelow, 0.3);
      float gain = 1.0 + max(uWarpStrength - 1.0, 0.0);
      vec2 disp = (r - s) * kBelow;
      vec2 warped = s + disp * gain;
      float m1 = length(warped + sin(5.0 * warped.y * uFrequency - 3.0 * t + float(i)) / 4.0);
      float m = mix(m0, m1, kMix);
      float w = 1.0 - exp(-uBandWidth / exp(uBandWidth * m));
      sumCol += uColors[i] * w;
      cover = max(cover, w);
    }
    col = clamp(sumCol, 0.0, 1.0);
    a = uTransparent > 0 ? cover : 1.0;
  } else {
    vec2 s = q;
    for (int k = 0; k < 3; ++k) {
      s -= 0.01;
      vec2 r = sin(1.5 * (s.yx * uFrequency) + 2.0 * cos(s * uFrequency));
      float m0 = length(r + sin(5.0 * r.y * uFrequency - 3.0 * t + float(k)) / 4.0);
      float kBelow = clamp(uWarpStrength, 0.0, 1.0);
      float kMix = pow(kBelow, 0.3);
      float gain = 1.0 + max(uWarpStrength - 1.0, 0.0);
      vec2 disp = (r - s) * kBelow;
      vec2 warped = s + disp * gain;
      float m1 = length(warped + sin(5.0 * warped.y * uFrequency - 3.0 * t + float(k)) / 4.0);
      float m = mix(m0, m1, kMix);
      col[k] = 1.0 - exp(-uBandWidth / exp(uBandWidth * m));
    }
    a = uTransparent > 0 ? max(max(col.r, col.g), col.b) : 1.0;
  }

  col *= uIntensity;

  if (uNoise > 0.0001) {
    float n = fract(sin(dot(gl_FragCoord.xy + vec2(uTime), vec2(12.9898, 78.233))) * 43758.5453123);
    col += (n - 0.5) * uNoise;
    col = clamp(col, 0.0, 1.0);
  }

  if (uColorCount > 0) {
    vec3 ambient = uColors[0];
    if (uColorCount > 1) {
      float firstBlend = 0.5 + 0.5 * sin(q.x * 0.72 + t * 0.7);
      ambient = mix(ambient, uColors[1], firstBlend);
    }
    if (uColorCount > 2) {
      float secondBlend = 0.5 + 0.5 * cos(q.y * 0.66 - t * 0.55);
      ambient = mix(ambient, uColors[2], secondBlend * 0.58);
    }
    col = max(col, ambient * 0.6);
    a = max(a, 0.78);
  }

  a *= roundedMask(vUv, uCanvas, uCornerRadius);
  vec3 rgb = uTransparent > 0 ? col * a : col;
  gl_FragColor = vec4(rgb, a);
}
`;

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

function hexToVector(THREE, value) {
  const hex = String(value).replace("#", "").trim();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return new THREE.Vector3(0, 0, 0);
  const expanded = hex.length === 3 ? [...hex].map((character) => character + character).join("") : hex;
  return new THREE.Vector3(
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255
  );
}

function makeMaterial(THREE, options) {
  const colors = options.colors.slice(0, MAX_COLORS).map((color) => hexToVector(THREE, color));
  const colorUniforms = Array.from({ length: MAX_COLORS }, (_, index) =>
    colors[index] || new THREE.Vector3(0, 0, 0)
  );
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uCanvas: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uSpeed: { value: options.speed },
      uRot: { value: new THREE.Vector2(1, 0) },
      uColorCount: { value: colors.length },
      uColors: { value: colorUniforms },
      uTransparent: { value: 1 },
      uScale: { value: options.scale },
      uFrequency: { value: options.frequency },
      uWarpStrength: { value: 0.78 },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uMouseInfluence: { value: 0.6 },
      uParallax: { value: 0.35 },
      uNoise: { value: 0.055 },
      uIterations: { value: 1 },
      uIntensity: { value: 1.15 },
      uBandWidth: { value: 4.4 },
      uCornerRadius: { value: 12 }
    },
    premultipliedAlpha: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
}

class DockColorBends {
  constructor(THREE, nav, host) {
    this.THREE = THREE;
    this.nav = nav;
    this.host = host;
    this.destroyed = false;
    this.contextLost = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.startedAt = performance.now();
    this.needsResize = true;
    this.entries = [];

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(this.geometry);
    this.scene.add(this.mesh);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      premultipliedAlpha: true
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.renderer.domElement.tabIndex = -1;
    this.host.append(this.renderer.domElement);

    this.nav.querySelectorAll(".nav-item[data-color-bends]").forEach((button) => {
      const options = DOCK_COLOR_BENDS_PALETTES[button.dataset.colorBends];
      if (!options) return;
      this.entries.push({
        button,
        options,
        material: makeMaterial(THREE, options),
        pointerTarget: new THREE.Vector2(0, 0),
        pointerCurrent: new THREE.Vector2(0, 0)
      });
    });

    if (this.entries.length !== Object.keys(DOCK_COLOR_BENDS_PALETTES).length) {
      throw new Error("ColorBends dock palette mapping is incomplete");
    }
    this.mesh.material.dispose();

    this.handleResize = () => {
      this.needsResize = true;
      if (!document.hidden) this.start();
    };
    this.handlePointer = (event) => {
      const button = event.target.closest?.(".nav-item[data-color-bends]");
      if (!button || !this.nav.contains(button)) return;
      const entry = this.entries.find((candidate) => candidate.button === button);
      if (!entry) return;
      const rect = button.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
      const y = -(((event.clientY - rect.top) / (rect.height || 1)) * 2 - 1);
      entry.pointerTarget.set(x, y);
    };
    this.resetPointers = () => {
      this.entries.forEach((entry) => entry.pointerTarget.set(0, 0));
    };
    this.handleContextLost = (event) => {
      event.preventDefault();
      if (this.destroyed) return;
      this.contextLost = true;
      this.stop();
      this.nav.classList.remove("is-color-bends-ready");
      this.nav.dataset.colorBendsState = "fallback";
    };
    this.handleContextRestored = () => {
      if (this.destroyed) return;
      this.contextLost = false;
      this.needsResize = true;
      this.renderFrame(0, 0);
      this.nav.classList.add("is-color-bends-ready");
      this.nav.dataset.colorBendsState = "ready";
      this.start();
    };

    this.nav.addEventListener("pointermove", this.handlePointer, { passive: true });
    this.nav.addEventListener("pointerdown", this.handlePointer, { passive: true });
    this.nav.addEventListener("pointerleave", this.resetPointers, { passive: true });
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);

    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.nav);
    } else {
      window.addEventListener("resize", this.handleResize, { passive: true });
    }

    this.renderFrame(0, 0);
    this.nav.classList.add("is-color-bends-ready");
    this.nav.dataset.colorBendsState = "ready";
  }

  resize() {
    const width = Math.max(1, this.nav.clientWidth);
    const height = Math.max(1, this.nav.clientHeight);
    this.renderer.setSize(width, height, false);
    this.needsResize = false;
  }

  renderFrame(elapsed, delta) {
    if (this.destroyed) return;
    if (this.needsResize) this.resize();

    const navRect = this.nav.getBoundingClientRect();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, navRect.width, navRect.height);
    this.renderer.clear(true, true, true);
    this.renderer.setScissorTest(true);

    this.entries.forEach((entry) => {
      const rect = entry.button.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const x = rect.left - navRect.left;
      const y = navRect.bottom - rect.bottom;
      const uniforms = entry.material.uniforms;
      const degrees = (entry.options.rotation % 360) + entry.options.autoRotate * elapsed;
      const radians = degrees * Math.PI / 180;
      const amount = Math.min(1, delta * 7);

      entry.pointerCurrent.lerp(entry.pointerTarget, amount);
      uniforms.uCanvas.value.set(width, height);
      uniforms.uTime.value = elapsed;
      uniforms.uRot.value.set(Math.cos(radians), Math.sin(radians));
      uniforms.uPointer.value.copy(entry.pointerCurrent);
      uniforms.uIntensity.value = entry.button.classList.contains("is-active") ? 1.46 : 1.2;
      this.mesh.material = entry.material;
      this.renderer.setViewport(x, y, width, height);
      this.renderer.setScissor(x, y, width, height);
      this.renderer.render(this.scene, this.camera);
    });

    this.renderer.setScissorTest(false);
  }

  start() {
    if (this.destroyed || this.contextLost || this.raf || document.hidden) return;
    const tick = (now) => {
      this.raf = 0;
      if (this.destroyed || document.hidden) return;
      const sinceLastFrame = now - this.lastFrame;
      if (sinceLastFrame >= TARGET_FRAME_INTERVAL) {
        const delta = this.lastFrame ? Math.min(sinceLastFrame / 1000, 0.1) : 0;
        this.lastFrame = now;
        this.renderFrame((now - this.startedAt) / 1000, delta);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    if (!this.resizeObserver) window.removeEventListener("resize", this.handleResize);
    this.nav.removeEventListener("pointermove", this.handlePointer);
    this.nav.removeEventListener("pointerdown", this.handlePointer);
    this.nav.removeEventListener("pointerleave", this.resetPointers);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.entries.forEach((entry) => entry.material.dispose());
    this.geometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.nav.classList.remove("is-color-bends-ready");
    this.nav.dataset.colorBendsState = "fallback";
  }
}

let effect = null;
let loading = null;
let webglAvailable;
const reducedMotion = typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");
const forcedColors = typeof window === "undefined" ? null : window.matchMedia("(forced-colors: active)");

function supportsWebGL() {
  if (webglAvailable !== undefined) return webglAvailable;
  try {
    const probe = document.createElement("canvas");
    const context = probe.getContext("webgl2", { powerPreference: "low-power" })
      || probe.getContext("webgl", { powerPreference: "low-power" });
    webglAvailable = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglAvailable = false;
  }
  return webglAvailable;
}

function eligible() {
  return !document.hidden && !reducedMotion?.matches && !forcedColors?.matches && supportsWebGL();
}

async function startColorBends() {
  if (effect || loading || !eligible()) return;
  const nav = document.querySelector("[data-color-bends-dock]");
  const host = nav?.querySelector(".dock-color-bends");
  if (!nav || !host) return;

  nav.dataset.colorBendsState = "loading";
  loading = import(`./vendor/three.module.min.js?v=${THREE_ASSET_VERSION}`);
  try {
    const THREE = await loading;
    if (!eligible()) return;
    effect = new DockColorBends(THREE, nav, host);
    effect.start();
    const cacheMessage = { type: "CACHE_COLOR_BENDS" };
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage(cacheMessage);
    } else {
      navigator.serviceWorker?.ready
        .then((registration) => registration.active?.postMessage(cacheMessage))
        .catch(() => {});
    }
  } catch {
    nav.classList.remove("is-color-bends-ready");
    nav.dataset.colorBendsState = "fallback";
  } finally {
    loading = null;
  }
}

function syncColorBends() {
  if (reducedMotion?.matches || forcedColors?.matches) {
    effect?.destroy();
    effect = null;
    return;
  }
  if (document.hidden) effect?.stop();
  else if (effect) effect.start();
  else startColorBends();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncColorBends, { once: true });
  else syncColorBends();
  document.addEventListener("visibilitychange", syncColorBends);
  reducedMotion?.addEventListener("change", syncColorBends);
  forcedColors?.addEventListener("change", syncColorBends);
}
