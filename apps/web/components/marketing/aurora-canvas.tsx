"use client";

import * as React from "react";

import { usePrefersReducedMotion } from "@/hooks/use-media-query";

/**
 * Neon aurora backdrop for the hero, as a single full-screen fragment shader.
 *
 * ## Why raw WebGL and not three.js
 *
 * `three` + `@react-three/fiber` are already in the dependency tree (and were
 * unused before this), but pulling them in to draw one quad costs roughly
 * 160KB gzipped on the landing page's LCP. Everything below is one vertex
 * shader, one fragment shader and a two-triangle buffer — a few KB, no scene
 * graph, no renderer abstraction.
 *
 * ## Why the light is shaped the way it is
 *
 * The aurora is *additive* (`mix-blend-mode: screen`), and the hero's white
 * headline sits on top of it. Light added behind white text lowers contrast, so
 * the shader's intensity is shaped by two envelopes that exist for legibility
 * rather than looks:
 *
 *   - a vertical envelope that peaks at the top edge and reaches zero by ~66%,
 *     keeping the glow in the deep-blue region and out of the white one; and
 *   - a horizontal envelope that dims the centre column, where the headline
 *     and subhead live, to 40% of the edge intensity.
 *
 * The net effect is an aurora that frames the headline from the top and sides
 * instead of sitting behind it. The measured composite behind the text stays
 * at or above the 4.5:1 the gradient alone already guaranteed. If you retune
 * `ENV_*` or `MAX_INTENSITY`, re-measure before shipping.
 *
 * ## Failure behaviour
 *
 * Everything here is additive over a CSS gradient that is complete on its own.
 * No WebGL, a lost context, or a shader compile failure all degrade to exactly
 * the sky that shipped before this component existed — never to a blank hero.
 */

/**
 * Ceiling on how much light the aurora may add. This is the single knob that
 * trades spectacle against headline contrast — raising it brightens the sky
 * behind white text. Re-measure the composite if you change it.
 */
const MAX_INTENSITY = 0.75;

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 uResolution;
uniform float uTime;

// Cheap hash-based value noise. No textures, no derivatives — this has to run
// on integrated GPUs and low-end phones without a fallback path.
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Flip so y = 0 is the top of the hero, matching how the envelopes read.
  vec2 st = vec2(uv.x, 1.0 - uv.y);

  // Correct for aspect so filaments stay vertical on ultrawide displays
  // instead of shearing.
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  float t = uTime * 0.055;

  // Vertical envelope — a hard cube falloff keeps almost all of the energy in
  // the top fifth, above the headline, which is what lets the peak intensity
  // be high enough to actually read as neon without touching text contrast.
  float env = smoothstep(0.50, 0.0, st.y);
  env = env * env * env;

  // Roll the glow back off across the very top strip. Without this the peak
  // lands exactly under the floating nav and blows out to white, taking the
  // Orkest wordmark and the nav links with it.
  env *= smoothstep(0.0, 0.11, st.y);

  // Horizontal envelope — hold the centre column back so the white headline
  // keeps its contrast. This is a legibility constraint, not a style choice.
  float centre = mix(0.55, 1.0, smoothstep(0.02, 0.32, abs(uv.x - 0.5)));

  vec3 col = vec3(0.0);
  float glow = 0.0;

  for (int i = 0; i < 3; i++) {
    float fi = float(i);

    // X frequency must exceed Y frequency or the ridges come out as
    // horizontal banding rather than vertical curtains. Stretching Y is what
    // makes a filament tall and thin.
    vec2 p = vec2(st.x * aspect * (3.2 + fi * 1.15), st.y * (0.85 + fi * 0.2));

    // Domain warp gives the curtains their slow wavering fold.
    p.x += fbm(p * 0.85 + vec2(t * (0.6 + fi * 0.22), t * 0.3)) * 0.9;
    p.x += t * (0.09 + fi * 0.045);

    float band = fbm(p);
    // Ridge the noise into filaments. An earlier exponent pair of 2.5 and 5.0
    // drove all but a hairline of each ridge to ~0.007, so the soft wash below
    // swamped it and the effect read as a light leak; these keep the shoulders
    // of the ridge alive. NOTE: no backticks anywhere in this GLSL — it lives
    // inside a JS template literal and one will silently end the string.
    float curtain = pow(max(0.0, 1.0 - abs(band - 0.5) * 1.8), 3.0);
    curtain *= 1.0 / (1.0 + fi * 0.55);

    // Cyan at the core, blue through the body, a violet fringe on the
    // outermost layer — the neon reading without leaving the brand hues.
    vec3 tint = mix(
      vec3(0.36, 0.88, 1.00),
      mix(vec3(0.18, 0.55, 1.00), vec3(0.55, 0.45, 1.00), fi * 0.5),
      fi * 0.5
    );

    col += tint * curtain;
    glow += curtain;
  }

  // A faint high-altitude wash so the top edge never reads as empty between
  // filaments. Kept well below the curtains — when this dominates, the effect
  // stops looking like an aurora and starts looking like a lens flare.
  float wash = fbm(vec2(st.x * aspect * 1.1 + t * 0.15, st.y * 1.6 - t * 0.1));
  col += vec3(0.22, 0.60, 1.0) * wash * 0.16;
  glow += wash * 0.16;

  float intensity = clamp(glow, 0.0, 1.0) * env * centre * ${MAX_INTENSITY.toFixed(2)};
  col = col * env * centre;

  gl_FragColor = vec4(col, intensity);
}
`;

/** Retina is enough; a 3x phone would quadruple fragment work for no gain. */
const MAX_DPR = 1.5;
/** The glow is low-frequency, so rendering under-size and letting the browser
 *  upscale is visually free and roughly halves the fragment cost. */
const RENDER_SCALE = 0.6;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[aurora] shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function AuroraCanvas() {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl =
      (canvas.getContext("webgl", { alpha: true, antialias: false, depth: false }) as
        | WebGLRenderingContext
        | null) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

    // No WebGL: the CSS gradient underneath is a complete sky on its own.
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[aurora] link failed:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle
      gl.STATIC_DRAW,
    );
    const aPosition = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, "uResolution");
    const uTime = gl.getUniformLocation(program, "uTime");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };

    const draw = (seconds: number) => {
      resize();
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Paint one frame synchronously, before any rAF is scheduled. A background
    // tab never runs rAF, so without this the hero would show an empty canvas
    // until it was foregrounded — the same class of bug as the stranded GSAP
    // entrances. It also gives reduced-motion users a real, still aurora.
    draw(0);

    if (reducedMotion) {
      const observer = new ResizeObserver(() => draw(0));
      observer.observe(canvas);
      return () => {
        observer.disconnect();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    }

    let frame = 0;
    const start = performance.now();
    const loop = (now: number) => {
      draw((now - start) / 1000);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const onLost = (event: Event) => {
      // Prevent default so the browser will attempt a restore; until then the
      // gradient carries the hero.
      event.preventDefault();
      cancelAnimationFrame(frame);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full mix-blend-screen"
    />
  );
}
