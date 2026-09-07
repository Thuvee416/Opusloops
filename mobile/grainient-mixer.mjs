const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 iResolution;
uniform vec2 uViewportOrigin;
uniform float iTime;
uniform float uTimeSpeed;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpSpeed;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2 uCenterOffset;
uniform float uZoom;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform float uLevel;
uniform float uMuted;
uniform float uInteraction;
uniform float uPhase;
uniform float uCornerRadius;

out vec4 fragColor;

#define S(a,b,t) smoothstep(a,b,t)

mat2 Rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37)));
  return fract(sin(p) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float n = mix(
    mix(
      dot(-1.0 + 2.0 * hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
      dot(-1.0 + 2.0 * hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)),
      u.x
    ),
    mix(
      dot(-1.0 + 2.0 * hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
      dot(-1.0 + 2.0 * hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)),
      u.x
    ),
    u.y
  );
  return 0.5 + 0.5 * n;
}

float roundedMask(vec2 point, vec2 size, float radius) {
  vec2 centered = point - size * 0.5;
  vec2 edge = abs(centered) - (size * 0.5 - vec2(radius));
  float distanceToEdge = length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0) - radius;
  return 1.0 - smoothstep(-1.25, 1.25, distanceToEdge);
}

void mainImage(out vec4 outputColor, vec2 coordinate) {
  float t = iTime * uTimeSpeed + uPhase;
  vec2 uv = coordinate / iResolution.xy;
  float ratio = iResolution.x / iResolution.y;
  vec2 transformedUv = uv - 0.5 + uCenterOffset;
  transformedUv /= max(uZoom, 0.001);

  float degree = noise(vec2(t * 0.1 + uPhase, transformedUv.x * transformedUv.y) * uNoiseScale);
  transformedUv.y *= 1.0 / ratio;
  transformedUv *= Rot(radians((degree - 0.5) * uRotationAmount + 180.0));
  transformedUv.y *= ratio;

  float warpStrength = max(uWarpStrength, 0.001);
  float amplitude = uWarpAmplitude / warpStrength;
  float warpTime = t * uWarpSpeed;
  transformedUv.x += sin(transformedUv.y * uWarpFrequency + warpTime) / amplitude;
  transformedUv.y += sin(transformedUv.x * (uWarpFrequency * 1.5) + warpTime) / (amplitude * 0.5);

  float balance = uColorBalance;
  float softness = max(uBlendSoftness, 0.0);
  float blendX = (transformedUv * Rot(radians(uBlendAngle))).x;
  float edge0 = -0.3 - balance - softness;
  float edge1 = 0.2 - balance + softness;
  float verticalLow = -0.3 - balance - softness;
  float verticalHigh = 0.5 - balance + softness;
  vec3 layer1 = mix(uColor3, uColor2, S(edge0, edge1, blendX));
  vec3 layer2 = mix(uColor2, uColor1, S(edge0, edge1, blendX));
  vec3 color = mix(layer1, layer2, 1.0 - S(verticalLow, verticalHigh, transformedUv.y));

  vec2 grainUv = uv * max(uGrainScale, 0.001);
  float grain = fract(sin(dot(grainUv, vec2(12.9898, 78.233))) * 43758.5453);
  color += (grain - 0.5) * uGrainAmount;

  color = (color - 0.5) * uContrast + 0.5;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSaturation);
  color = pow(max(color, 0.0), vec3(1.0 / max(uGamma, 0.001)));
  color = clamp(color, 0.0, 1.0);

  float levelPresence = 0.28 + uLevel * 0.72;
  color = mix(uColor3 * 0.34, color, levelPresence);
  color *= 0.46 + uLevel * 0.54;
  color = mix(color, vec3(dot(color, vec3(0.333333))), uMuted * 0.78);
  color *= mix(1.0, 0.48, uMuted);
  color *= 1.0 + uInteraction * 0.1;

  float alpha = roundedMask(coordinate, iResolution, uCornerRadius) * mix(0.86, 0.58, uMuted);
  outputColor = vec4(color * alpha, alpha);
}

void main() {
  vec2 localCoordinate = gl_FragCoord.xy - uViewportOrigin;
  vec4 color = vec4(0.0);
  mainImage(color, localCoordinate);
  fragColor = color;
}
`;

const FRAME_INTERVAL = 1000 / 30;
const MAX_DEVICE_PIXEL_RATIO = 1.25;
const PALETTE_ACCENTS = [
  "#ff6b9d",
  "#ffad42",
  "#4de3c2",
  "#c79cff",
  "#ff876f",
  "#d8e66b",
  "#79a8ff",
  "#f083d1",
  "#b7b3aa"
];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validHex(value) {
  const match = String(value || "").trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  return match ? `#${match[1]}` : "#4de3c2";
}

function hexToRgb(value) {
  const hex = validHex(value).slice(1);
  const expanded = hex.length === 3 ? hex.split("").map((part) => part + part).join("") : hex;
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255);
}

function mixColor(left, right, amount) {
  return left.map((component, index) => component + (right[index] - component) * amount);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create Grainient shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown Grainient shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create Grainient program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown Grainient link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

class MixerGrainientRenderer {
  constructor(surface) {
    this.surface = surface;
    this.mixer = surface.querySelector(".mixer");
    this.canvas = surface.querySelector(".mixer-grainient-canvas");
    this.mixView = surface.closest("[data-view]");
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.forcedColorsQuery = window.matchMedia("(forced-colors: active)");
    this.gl = null;
    this.program = null;
    this.locations = {};
    this.buffer = null;
    this.vertexArray = null;
    this.frame = 0;
    this.lastFrameTime = 0;
    this.startedAt = performance.now();
    this.surfaceVisible = false;
    this.contextLost = false;
    this.paletteCache = new WeakMap();
    this.maximumViewport = [4096, 4096];

    if (!this.mixer || !this.canvas) return;

    this.handleContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stop();
      this.surface.dataset.grainientState = "fallback";
    };
    this.handleContextRestored = () => {
      this.contextLost = false;
      this.initializeContext();
      this.queueDraw();
    };
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.queueDraw());
    this.resizeObserver.observe(this.surface);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.surfaceVisible = Boolean(entry?.isIntersecting);
      this.surfaceVisible ? this.queueDraw() : this.stop();
    });
    this.intersectionObserver.observe(this.surface);
    this.mutationObserver = new MutationObserver((records) => {
      if (records.some((record) =>
        record.type === "childList" || ["data-mix-color", "data-mix-index"].includes(record.attributeName)
      )) this.paletteCache = new WeakMap();
      this.queueDraw();
    });
    this.mutationObserver.observe(this.mixer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-mix-color", "data-mix-index", "data-mix-level", "data-mix-muted"]
    });
    if (this.mixView) {
      this.viewObserver = new MutationObserver(() => this.queueDraw());
      this.viewObserver.observe(this.mixView, { attributes: true, attributeFilter: ["class"] });
    }

    this.handleVisibility = () => (document.hidden ? this.stop() : this.queueDraw());
    this.handleMotionChange = () => {
      this.stop();
      this.queueDraw();
    };
    this.handleForcedColorsChange = () => {
      this.stop();
      if (this.forcedColorsQuery.matches) {
        this.surface.dataset.grainientState = "disabled";
        return;
      }
      if (!this.gl) this.initializeContext();
      else this.surface.dataset.grainientState = "ready";
      this.queueDraw();
    };
    this.handleViewportChange = () => this.queueDraw();
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("resize", this.handleViewportChange, { passive: true });
    window.addEventListener("orientationchange", this.handleViewportChange, { passive: true });
    this.motionQuery.addEventListener?.("change", this.handleMotionChange);
    this.forcedColorsQuery.addEventListener?.("change", this.handleForcedColorsChange);

    if (this.forcedColorsQuery.matches) this.surface.dataset.grainientState = "disabled";
    else this.initializeContext();
    this.queueDraw();
  }

  initializeContext() {
    if (this.contextLost) return;
    try {
      const gl = this.canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: "high-performance"
      });
      if (!gl) throw new Error("WebGL2 is unavailable");
      this.gl = gl;
      this.program = createProgram(gl);
      this.buffer = gl.createBuffer();
      this.vertexArray = gl.createVertexArray();
      gl.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.locations = Object.fromEntries([
        "iResolution", "uViewportOrigin", "iTime", "uTimeSpeed", "uColorBalance",
        "uWarpStrength", "uWarpFrequency", "uWarpSpeed", "uWarpAmplitude", "uBlendAngle",
        "uBlendSoftness", "uRotationAmount", "uNoiseScale", "uGrainAmount", "uGrainScale",
        "uContrast", "uGamma", "uSaturation", "uCenterOffset", "uZoom", "uColor1", "uColor2",
        "uColor3", "uLevel", "uMuted", "uInteraction", "uPhase", "uCornerRadius"
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]));
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      this.maximumViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      this.surface.dataset.grainientState = "ready";
    } catch {
      this.releaseContextResources();
      this.surface.dataset.grainientState = "fallback";
    }
  }

  releaseContextResources() {
    if (this.gl) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.vertexArray) this.gl.deleteVertexArray(this.vertexArray);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.buffer = null;
    this.vertexArray = null;
    this.program = null;
    this.locations = {};
    this.gl = null;
  }

  tiles() {
    return [...this.mixer.querySelectorAll(".mixer-tile")];
  }

  hasMovingTile() {
    return this.tiles().some((tile) => tile.dataset.mixMuted !== "true" && Number(tile.dataset.mixLevel) > 0);
  }

  canDraw() {
    return Boolean(
      this.gl &&
      this.program &&
      !this.contextLost &&
      !document.hidden &&
      !this.forcedColorsQuery.matches &&
      this.surfaceVisible &&
      this.mixView?.classList.contains("is-active")
    );
  }

  shouldAnimate() {
    return this.canDraw() && !this.motionQuery.matches && this.hasMovingTile();
  }

  queueDraw() {
    if (!this.gl || this.contextLost || !this.canDraw()) return;
    if (this.motionQuery.matches || !this.hasMovingTile()) {
      this.stop();
      this.render(performance.now(), { includeOffscreen: true });
      return;
    }
    if (!this.frame) this.frame = requestAnimationFrame((time) => this.animate(time));
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrameTime = 0;
  }

  animate(time) {
    this.frame = 0;
    if (!this.shouldAnimate()) return;
    if (!this.lastFrameTime || time - this.lastFrameTime >= FRAME_INTERVAL) {
      this.render(time);
      this.lastFrameTime = time;
    }
    this.frame = requestAnimationFrame((nextTime) => this.animate(nextTime));
  }

  syncCanvasSize() {
    const bounds = this.surface.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return null;
    const gl = this.gl;
    const safeRatio = Math.min(
      window.devicePixelRatio || 1,
      MAX_DEVICE_PIXEL_RATIO,
      this.maximumViewport[0] / bounds.width,
      this.maximumViewport[1] / bounds.height
    );
    const width = Math.max(1, Math.floor(bounds.width * safeRatio));
    const height = Math.max(1, Math.floor(bounds.height * safeRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return {
      bounds,
      ratioX: width / bounds.width,
      ratioY: height / bounds.height,
      width,
      height
    };
  }

  paletteFor(tile) {
    const color = validHex(tile.dataset.mixColor);
    const index = Math.max(0, Math.trunc(Number(tile.dataset.mixIndex) || 0));
    const key = `${color}:${index}`;
    const cached = this.paletteCache.get(tile);
    if (cached?.key === key) return cached;
    const base = hexToRgb(color);
    const companion = hexToRgb(PALETTE_ACCENTS[(index + 3) % PALETTE_ACCENTS.length]);
    const palette = {
      key,
      light: mixColor(base, [1, 0.96, 0.93], 0.22),
      accent: mixColor(base, companion, 0.34),
      dark: mixColor(base, [0.004, 0.003, 0.008], 0.84)
    };
    this.paletteCache.set(tile, palette);
    return palette;
  }

  render(time, { includeOffscreen = false } = {}) {
    if (!this.canDraw()) return;
    const sizing = this.syncCanvasSize();
    if (!sizing) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sizing.width, sizing.height);
    gl.scissor(0, 0, sizing.width, sizing.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);

    const elapsed = Math.max(0, time - this.startedAt) * 0.001;
    this.tiles().forEach((tile) => {
      const tileBounds = tile.getBoundingClientRect();
      if (!includeOffscreen && (tileBounds.bottom < 0 || tileBounds.top > window.innerHeight)) return;
      const left = Math.round((tileBounds.left - sizing.bounds.left) * sizing.ratioX);
      const top = Math.round((tileBounds.top - sizing.bounds.top) * sizing.ratioY);
      const width = Math.max(1, Math.round(tileBounds.width * sizing.ratioX));
      const height = Math.max(1, Math.round(tileBounds.height * sizing.ratioY));
      const bottom = sizing.height - top - height;
      if (left + width <= 0 || bottom + height <= 0 || left >= sizing.width || bottom >= sizing.height) return;

      const clippedLeft = Math.max(0, left);
      const clippedBottom = Math.max(0, bottom);
      const clippedRight = Math.min(sizing.width, left + width);
      const clippedTop = Math.min(sizing.height, bottom + height);
      gl.viewport(left, bottom, width, height);
      gl.scissor(clippedLeft, clippedBottom, clippedRight - clippedLeft, clippedTop - clippedBottom);

      const level = clamp(Number(tile.dataset.mixLevel) || 0, 0, 1);
      const muted = tile.dataset.mixMuted === "true";
      const index = Math.max(0, Math.trunc(Number(tile.dataset.mixIndex) || 0));
      const interaction = tile.classList.contains("is-adjusting") ? 1 : tile.classList.contains("is-active") ? 0.55 : 0;
      const palette = this.paletteFor(tile);
      gl.uniform2f(this.locations.iResolution, width, height);
      gl.uniform2f(this.locations.uViewportOrigin, left, bottom);
      gl.uniform1f(this.locations.iTime, elapsed);
      gl.uniform1f(this.locations.uTimeSpeed, muted || level === 0 ? 0 : 0.07 + level * 0.2);
      gl.uniform1f(this.locations.uColorBalance, -0.06 + level * 0.08);
      gl.uniform1f(this.locations.uWarpStrength, muted ? 0.18 : 0.3 + level * 1.08);
      gl.uniform1f(this.locations.uWarpFrequency, 3.7 + (index % 4) * 0.43);
      gl.uniform1f(this.locations.uWarpSpeed, 0.68 + level * 1.22);
      gl.uniform1f(this.locations.uWarpAmplitude, 62 - level * 24);
      gl.uniform1f(this.locations.uBlendAngle, -24 + (index % 5) * 31);
      gl.uniform1f(this.locations.uBlendSoftness, 0.08);
      gl.uniform1f(this.locations.uRotationAmount, 130 + level * 300);
      gl.uniform1f(this.locations.uNoiseScale, 1.75 + (index % 3) * 0.24);
      gl.uniform1f(this.locations.uGrainAmount, 0.035);
      gl.uniform1f(this.locations.uGrainScale, 2.15);
      gl.uniform1f(this.locations.uContrast, 1.18 + level * 0.28);
      gl.uniform1f(this.locations.uGamma, 1.04);
      gl.uniform1f(this.locations.uSaturation, muted ? 0.22 : 0.78 + level * 0.28);
      gl.uniform2f(this.locations.uCenterOffset, ((index % 3) - 1) * 0.035, ((index % 2) - 0.5) * 0.04);
      gl.uniform1f(this.locations.uZoom, 0.9 + (index % 2) * 0.05);
      gl.uniform3fv(this.locations.uColor1, palette.light);
      gl.uniform3fv(this.locations.uColor2, palette.accent);
      gl.uniform3fv(this.locations.uColor3, palette.dark);
      gl.uniform1f(this.locations.uLevel, level);
      gl.uniform1f(this.locations.uMuted, muted ? 1 : 0);
      gl.uniform1f(this.locations.uInteraction, interaction);
      gl.uniform1f(this.locations.uPhase, index * 1.731);
      gl.uniform1f(this.locations.uCornerRadius, 18 * Math.min(sizing.ratioX, sizing.ratioY));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    gl.bindVertexArray(null);
  }
}

const surface = document.querySelector("[data-grainient-mixer]");
if (surface) new MixerGrainientRenderer(surface);
