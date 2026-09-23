// React Bits Scanner shader, adapted to the dependency-free static shell.
// Upstream attribution: REACT_BITS_LICENSE.md. Native WebGL2 avoids adding a React runtime.
const vertex = "#version 300 es\nin vec2 position;\nvoid main() {\n  gl_Position = vec4(position, 0.0, 1.0);\n}\n";
const fragment = "#version 300 es\nprecision highp float;\nuniform vec2 iResolution;\nuniform float iTime;\nuniform float uSpeed;\nuniform float uSweepSpeed;\nuniform float uSweepWidth;\nuniform float uSweepFalloff;\nuniform float uScale;\nuniform float uFrequency;\nuniform float uRipple;\nuniform float uBandDensity;\nuniform float uLineSharpness;\nuniform float uGlow;\nuniform float uColorSpread;\nuniform float uBrightness;\nuniform float uContrast;\nuniform float uSoftness;\nuniform float uVignette;\nuniform float uOpacity;\nuniform float uScanline;\nuniform float uGrain;\nuniform float uGrainIntensity;\nuniform float uDirection;\nuniform vec2 uMouse;\nuniform float uMouseEnabled;\nuniform float uMouseRadius;\nuniform float uMouseStrength;\nuniform float uMouseActive;\nuniform vec3 uColor1;\nuniform vec3 uColor2;\nuniform vec3 uColor3;\nout vec4 fragColor;\n\nconst float TAU = 6.2831853;\n\nfloat signalField(vec2 p, float t) {\n  float w = sin(p.x * 1.3 + t * 0.7);\n  w += sin(p.y * 1.7 - t * 0.52) * 0.8;\n  w += sin((p.x + p.y) * 0.9 + t * 0.91) * 0.6;\n  w += sin((p.x - p.y) * 1.53 - t * 0.63) * 0.42;\n  return w * 0.35;\n}\n\nvec3 palette(float f) {\n  f = clamp(f, 0.0, 1.0);\n  f = pow(f, uContrast);\n  vec3 c = mix(uColor1, uColor2, smoothstep(0.08, 0.6, f));\n  return mix(c, uColor3, smoothstep(0.68, 1.0, f));\n}\n\nfloat scanBand(float x, float aa, float sharp) {\n  float v = mix(0.5, 0.5 + 0.5 * cos(x * TAU), aa);\n  return pow(v, sharp);\n}\n\nvoid main() {\n  float aspect = iResolution.x / iResolution.y;\n  vec2 uv0 = (gl_FragCoord.xy * 2.0 - iResolution.xy) / iResolution.y;\n  vec2 p = uv0 / max(uScale, 0.001);\n\n  float t = iTime * uSpeed;\n\n  float mouseBoost = 0.0;\n  if (uMouseEnabled > 0.5) {\n    vec2 mUv = vec2((uMouse.x * 2.0 - 1.0) * aspect, uMouse.y * 2.0 - 1.0);\n    vec2 md = uv0 - mUv;\n    float r = max(uMouseRadius, 0.001);\n    mouseBoost = exp(-dot(md, md) / (r * r)) * uMouseStrength * uMouseActive;\n  }\n\n  float axis;\n  if (uDirection < 0.5) axis = p.y;\n  else if (uDirection < 1.5) axis = p.x;\n  else axis = (p.x + p.y) * 0.70710678;\n\n  float sig = signalField(p * uFrequency, t);\n  float coord = axis + sig * uRipple;\n\n  float phase = coord / max(uSweepWidth, 0.05) - t * uSweepSpeed;\n  float sweep = pow(0.5 + 0.5 * cos(phase * TAU), max(uSweepFalloff, 0.1));\n\n  float lc = coord * uBandDensity;\n  float aa = 1.0 / (1.0 + uSoftness * fwidth(lc) * 3.0);\n  aa = clamp(aa * (1.0 + mouseBoost * 0.6), 0.0, 1.0);\n\n  float bodyBase = clamp(0.5 + 0.5 * sig, 0.0, 1.0);\n  float body = bodyBase * bodyBase * uGlow * sweep;\n\n  float sharp = max(uLineSharpness, 0.1);\n  float split = uColorSpread * 0.16;\n  float fr = clamp(scanBand(lc + split, aa, sharp) * sweep + body, 0.0, 1.0);\n  float fg = clamp(scanBand(lc, aa, sharp) * sweep + body, 0.0, 1.0);\n  float fb = clamp(scanBand(lc - split, aa, sharp) * sweep + body, 0.0, 1.0);\n\n  vec3 col = vec3(palette(fr).r, palette(fg).g, palette(fb).b);\n\n  float inten = (fr + fg + fb) * 0.3333333 * uBrightness;\n  inten *= 1.0 + mouseBoost * 0.9;\n\n  if (uScanline > 0.5) {\n    inten *= 1.0 - 0.18 * (0.5 + 0.5 * cos(gl_FragCoord.y * 1.7));\n  }\n\n  if (uGrain > 0.5) {\n    float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453);\n    inten += (g - 0.5) * uGrainIntensity;\n  }\n\n  inten *= clamp(1.0 - uVignette * smoothstep(0.55, 1.65, length(uv0)), 0.0, 1.0);\n  inten = clamp(inten, 0.0, 1.0);\n\n  float a = clamp(inten * uOpacity, 0.0, 1.0);\n  fragColor = vec4(clamp(col, 0.0, 1.0) * a, a);\n}\n";

const canvas = document.querySelector('[data-scanner]');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let gl, program, buffer, vao, timeLocation, mouseLocation, activeLocation;
let frame = 0, last = 0, elapsed = 0, visible = true, lost = false;
let target = [.5, .5], mouse = [.5, .5], active = 0, targetActive = 0;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Scanner shader unavailable'); }
  return shader;
}
function init() {
  gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) { canvas.dataset.scannerState = 'fallback'; return; }
  let vs, fs;
  try {
    vs = compile(gl.VERTEX_SHADER, vertex); fs = compile(gl.FRAGMENT_SHADER, fragment);
    program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Scanner unavailable');
    gl.useProgram(program);
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const values = {
      uSpeed:.5, uSweepSpeed:.25, uSweepWidth:1.6, uSweepFalloff:6,
      uScale:1.5, uFrequency:2, uRipple:.22, uBandDensity:11, uLineSharpness:5.5,
      uGlow:.22, uColorSpread:.7, uBrightness:1, uContrast:1.15, uSoftness:1.4,
      uVignette:.45, uOpacity:1, uScanline:1, uGrain:1, uGrainIntensity:.035,
      uDirection:0, uMouseEnabled:1, uMouseRadius:.5, uMouseStrength:.5
    };
    for (const [name, value] of Object.entries(values)) gl.uniform1f(gl.getUniformLocation(program, name), value);
    gl.uniform3f(gl.getUniformLocation(program, 'uColor1'), .322, .153, 1);
    gl.uniform3f(gl.getUniformLocation(program, 'uColor2'), 1, .624, .988);
    gl.uniform3f(gl.getUniformLocation(program, 'uColor3'), 1, 1, 1);
    timeLocation = gl.getUniformLocation(program, 'iTime');
    mouseLocation = gl.getUniformLocation(program, 'uMouse');
    activeLocation = gl.getUniformLocation(program, 'uMouseActive');
    canvas.dataset.scannerState = 'ready';
    resize(); sync();
  } catch {
    if (buffer) gl.deleteBuffer(buffer);
    if (vao) gl.deleteVertexArray(vao);
    if (program) gl.deleteProgram(program);
    program = null;
    canvas.dataset.scannerState = 'fallback';
  } finally {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
  }
}
function render() {
  if (!program || lost) return;
  gl.uniform1f(timeLocation, elapsed);
  gl.uniform2f(mouseLocation, mouse[0], mouse[1]);
  gl.uniform1f(activeLocation, motion.matches ? 0 : active);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function resize() {
  if (!program || lost) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 1.25);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(gl.getUniformLocation(program, 'iResolution'), canvas.width, canvas.height);
  render();
}
function tick(now) {
  frame = 0;
  if (document.hidden || motion.matches || !visible || lost || !program) return;
  if (now - last >= 1000 / 30) {
    elapsed += Math.min((now - last) / 1000, .05); last = now;
    mouse = mouse.map((v, i) => v + (target[i] - v) * .12);
    active += (targetActive - active) * .12;
    render();
  }
  frame = requestAnimationFrame(tick);
}
function sync() {
  cancelAnimationFrame(frame); frame = 0;
  if (!program || lost) return;
  render();
  if (!document.hidden && !motion.matches && visible) { last = performance.now(); frame = requestAnimationFrame(tick); }
}
if (canvas) {
  init();
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(canvas);
  document.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    target = [(e.clientX-r.left)/r.width, 1-(e.clientY-r.top)/r.height]; targetActive = 1;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { targetActive = 0; });
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pageshow', sync);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; cancelAnimationFrame(frame); frame = 0; canvas.dataset.scannerState = 'fallback'; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; init(); });
}
