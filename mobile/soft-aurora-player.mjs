// Adapted for the dependency-free Opusloops shell from React Bits' SoftAurora effect.
// See REACT_BITS_LICENSE.md for the upstream copyright and license notice.
const FRAME_INTERVAL = 1000 / 24;
const MAX_DEVICE_PIXEL_RATIO = 1;

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uBrightness;
uniform vec3 uColor1;
uniform vec3 uColor2;

out vec4 fragColor;

#define TAU 6.28318530718

vec2 hash22(vec2 point) {
  point = vec2(
    dot(point, vec2(127.1, 311.7)),
    dot(point, vec2(269.5, 183.3))
  );
  return -1.0 + 2.0 * fract(sin(point) * 43758.5453123);
}

float gradientNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 smoothLocal = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);

  float bottomLeft = dot(hash22(cell), local);
  float bottomRight = dot(hash22(cell + vec2(1.0, 0.0)), local - vec2(1.0, 0.0));
  float topLeft = dot(hash22(cell + vec2(0.0, 1.0)), local - vec2(0.0, 1.0));
  float topRight = dot(hash22(cell + vec2(1.0, 1.0)), local - vec2(1.0, 1.0));

  return 0.5 + 0.5 * mix(
    mix(bottomLeft, bottomRight, smoothLocal.x),
    mix(topLeft, topRight, smoothLocal.x),
    smoothLocal.y
  );
}

float softNoise(vec2 point) {
  float first = gradientNoise(point);
  float second = gradientNoise(point * 2.03 + vec2(11.7, 4.9));
  return first * 0.82 + second * 0.18;
}

float auroraBand(vec2 uv, float time, float phase, float verticalOffset) {
  float noiseValue = softNoise(vec2(uv.x * 3.15 + time * 0.075 + phase, uv.y * 1.2 + time * 0.035));
  float wave = sin(uv.x * TAU * 0.72 + time * 0.21 + phase) * 0.055;
  float center = verticalOffset + wave + (noiseValue - 0.5) * 0.42;
  float distanceToBand = abs(uv.y - center);
  float broadGlow = 1.0 - smoothstep(0.06, 0.53, distanceToBand);
  return broadGlow * broadGlow;
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  float firstBand = auroraBand(uv, uTime, 0.0, 0.42);
  float secondBand = auroraBand(uv, uTime * 0.91, 2.37, 0.57);
  float firstPhase = 0.78 + 0.22 * cos(uv.x * TAU * 0.62 + uTime * 0.12);
  float secondPhase = 0.75 + 0.25 * cos(uv.x * TAU * 0.48 - uTime * 0.09 + 1.4);

  vec3 color = uColor1 * firstBand * firstPhase;
  color += uColor2 * secondBand * secondPhase * 0.82;
  color *= uBrightness;

  float alpha = clamp((firstBand + secondBand * 0.82) * 0.58, 0.0, 0.82);
  fragColor = vec4(color * alpha, alpha);
}
`;

const PLAYER_COLORS = Object.freeze({
  warmWhite: new Float32Array([244 / 255, 243 / 255, 240 / 255]),
  rose: new Float32Array([255 / 255, 113 / 255, 141 / 255])
});

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create SoftAurora shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown SoftAurora shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragment = null;
  let program = null;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error("Unable to create SoftAurora program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unknown SoftAurora link error");
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

class PlayerSoftAuroraRenderer {
  constructor(player) {
    this.player = player;
    this.canvas = player.querySelector(".persistent-player-aurora-canvas");
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.forcedColorsQuery = window.matchMedia("(forced-colors: active)");
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.vertexArray = null;
    this.locations = {};
    this.frame = 0;
    this.lastFrameTime = 0;
    this.lastAdvanceTime = 0;
    this.effectTime = 0;
    this.contextLost = false;
    this.destroyed = false;
    this.intersecting = !("IntersectionObserver" in window);

    if (!this.canvas) return;

    this.handleContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stop("stopped");
      this.releaseContextResources({ deleteObjects: false });
      this.player.dataset.softAuroraState = "fallback";
    };
    this.handleContextRestored = () => {
      this.contextLost = false;
      this.initializeContext();
      this.syncMode();
    };
    this.handleVisibility = () => this.syncMode();
    this.handlePreferenceChange = () => this.syncMode();
    this.handleResize = () => {
      if (!this.resizeCanvas()) return;
      if (!this.shouldAnimate()) this.render();
    };

    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    document.addEventListener("visibilitychange", this.handleVisibility);
    if (this.motionQuery.addEventListener) {
      this.motionQuery.addEventListener("change", this.handlePreferenceChange);
      this.forcedColorsQuery.addEventListener("change", this.handlePreferenceChange);
    } else {
      this.motionQuery.addListener?.(this.handlePreferenceChange);
      this.forcedColorsQuery.addListener?.(this.handlePreferenceChange);
    }

    this.resizeObserver = "ResizeObserver" in window
      ? new ResizeObserver(this.handleResize)
      : null;
    if (this.resizeObserver) this.resizeObserver.observe(player);
    else window.addEventListener("resize", this.handleResize, { passive: true });

    this.intersectionObserver = "IntersectionObserver" in window
      ? new IntersectionObserver(([entry]) => {
        this.intersecting = Boolean(entry?.isIntersecting);
        this.syncMode();
      })
      : null;
    this.intersectionObserver?.observe(player);

    this.mutationObserver = new MutationObserver(() => this.syncMode());
    this.mutationObserver.observe(player, {
      attributes: true,
      attributeFilter: ["hidden", "data-playback-state"]
    });

    this.syncMode();
  }

  playbackIsActive() {
    return this.player.dataset.playbackState === "playing";
  }

  playerIsVisible() {
    return !this.player.hidden && this.intersecting && !document.hidden;
  }

  canRender() {
    return Boolean(
      this.gl &&
      this.program &&
      this.buffer &&
      this.vertexArray &&
      !this.contextLost &&
      !this.forcedColorsQuery.matches &&
      this.playerIsVisible()
    );
  }

  shouldAnimate() {
    return this.canRender() && !this.motionQuery.matches && this.playbackIsActive();
  }

  initializeContext() {
    if (this.contextLost || this.forcedColorsQuery.matches || this.destroyed) return false;
    try {
      const gl = this.canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: "low-power"
      });
      if (!gl) throw new Error("WebGL2 is unavailable");

      this.releaseContextResources();
      this.gl = gl;
      this.program = createProgram(gl);
      this.buffer = gl.createBuffer();
      this.vertexArray = gl.createVertexArray();
      if (!this.buffer || !this.vertexArray) throw new Error("Unable to allocate SoftAurora geometry");

      gl.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.locations = Object.fromEntries(
        ["uResolution", "uTime", "uBrightness", "uColor1", "uColor2"]
          .map((name) => [name, gl.getUniformLocation(this.program, name)])
      );
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      this.resizeCanvas();
      this.player.dataset.softAuroraState = this.motionQuery.matches ? "static" : "ready";
      return true;
    } catch {
      this.releaseContextResources();
      this.player.dataset.softAuroraState = "fallback";
      return false;
    }
  }

  releaseContextResources({ deleteObjects = true } = {}) {
    if (deleteObjects && this.gl) {
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

  resizeCanvas() {
    if (!this.gl) return false;
    const bounds = this.player.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    const width = Math.max(1, Math.floor(bounds.width * ratio));
    const height = Math.max(1, Math.floor(bounds.height * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  render() {
    if (!this.canRender()) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform2f(this.locations.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.locations.uTime, this.effectTime);
    gl.uniform1f(this.locations.uBrightness, 0.56);
    gl.uniform3fv(this.locations.uColor1, PLAYER_COLORS.warmWhite);
    gl.uniform3fv(this.locations.uColor2, PLAYER_COLORS.rose);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  start() {
    if (this.frame || !this.shouldAnimate()) return;
    this.player.dataset.softAuroraMotion = "playing";
    this.lastFrameTime = 0;
    this.lastAdvanceTime = 0;
    this.frame = requestAnimationFrame((time) => this.animate(time));
  }

  stop(motion = "paused") {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrameTime = 0;
    this.lastAdvanceTime = 0;
    this.player.dataset.softAuroraMotion = motion;
  }

  animate(time) {
    this.frame = 0;
    if (!this.shouldAnimate()) {
      this.syncMode();
      return;
    }

    const frameElapsed = time - this.lastFrameTime;
    if (!this.lastFrameTime || frameElapsed >= FRAME_INTERVAL) {
      if (this.lastAdvanceTime) {
        this.effectTime += Math.min(0.1, Math.max(0, time - this.lastAdvanceTime) * 0.001);
      }
      this.lastAdvanceTime = time;
      this.lastFrameTime = this.lastFrameTime
        ? time - (frameElapsed % FRAME_INTERVAL)
        : time;
      this.render();
    }
    this.frame = requestAnimationFrame((nextTime) => this.animate(nextTime));
  }

  syncMode() {
    if (this.destroyed || !this.canvas) return;

    if (this.forcedColorsQuery.matches) {
      this.stop("stopped");
      this.releaseContextResources();
      this.player.dataset.softAuroraState = "disabled";
      return;
    }

    if (!this.playerIsVisible()) {
      this.stop("stopped");
      return;
    }

    if (!this.gl && !this.contextLost && !this.initializeContext()) return;
    if (!this.canRender()) {
      this.stop("stopped");
      return;
    }

    if (this.motionQuery.matches) {
      this.stop("paused");
      this.player.dataset.softAuroraState = "static";
      this.render();
      return;
    }

    this.player.dataset.softAuroraState = "ready";
    if (this.playbackIsActive()) this.start();
    else {
      this.stop("paused");
      this.render();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop("stopped");
    this.resizeObserver?.disconnect();
    if (!this.resizeObserver) window.removeEventListener("resize", this.handleResize);
    this.intersectionObserver?.disconnect();
    this.mutationObserver.disconnect();
    document.removeEventListener("visibilitychange", this.handleVisibility);
    if (this.motionQuery.removeEventListener) {
      this.motionQuery.removeEventListener("change", this.handlePreferenceChange);
      this.forcedColorsQuery.removeEventListener("change", this.handlePreferenceChange);
    } else {
      this.motionQuery.removeListener?.(this.handlePreferenceChange);
      this.forcedColorsQuery.removeListener?.(this.handlePreferenceChange);
    }
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.releaseContextResources();
  }
}

if (typeof document !== "undefined") {
  const initialize = () => {
    const player = document.querySelector("#persistent-player");
    if (player) new PlayerSoftAuroraRenderer(player);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else initialize();
}
