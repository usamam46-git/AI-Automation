"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The AI core — the reasoning nucleus at the centre of the scene.
 *
 * ## Why it is built out of points rather than as a glowing orb
 *
 * The obvious version of this is an emissive sphere with bloom, which is what
 * every AI landing page ships and which says nothing about the product. This
 * core is instead made of the *same substance as the rest of the world*: nodes
 * and the light between them, just at very high density. The metaphor is then
 * coherent — the core is a workflow graph dense enough to look like a body —
 * and it reads as computational rather than magical.
 *
 * Four layers, back to front:
 *
 *   1. `glow`  — a camera-facing additive disc. This is what stands in for a
 *                bloom pass, and is the reason `@react-three/postprocessing`
 *                is not a dependency (see the note in the scene root).
 *   2. `body`  — a dark icosahedron with a fresnel rim. It occludes the points
 *                behind it, which is what gives the core volume instead of
 *                reading as a flat sprite.
 *   3. `shell` — ~2200 points on a Fibonacci sphere, radius modulated by a
 *                cheap trig field so the surface breathes, with sparse
 *                per-point flicker standing in for computation.
 *   4. `halo`  — a second, wider and slower point layer, so the core has an
 *                atmosphere rather than a hard edge.
 *
 * ## Ignition
 *
 * `intensity` is driven by scroll: the core is dormant through scene 1 (the
 * world is disconnected, nothing is reasoning yet) and ignites as scene 2
 * begins. At `intensity: 0` it is very nearly invisible, which is what lets
 * scene 1 be honestly empty.
 *
 * ## GLSL note
 *
 * The shaders below live in JS template literals, so **no backtick may appear
 * anywhere in the GLSL, including in comments** — one silently ends the string
 * and the route fails to parse. This has bitten this repo before, in
 * `aurora-canvas.tsx`.
 */

const SHELL_COUNT = 3400;
const HALO_COUNT = 900;

/** Deterministic per-point jitter. Avoids `Math.random()` so a given build
 *  always produces the same core — reproducible screenshots, reviewable diffs. */
function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Points spread evenly over a unit sphere (golden-angle spiral). */
function fibonacciSphere(count: number): { positions: Float32Array; seeds: Float32Array } {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(count - 1, 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    positions[i * 3] = Math.cos(theta) * radius;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(theta) * radius;
    seeds[i] = hash(i);
  }

  return { positions, seeds };
}

/**
 * Precision must be declared identically in both stages of every program here.
 *
 * A vertex shader defaults to `highp` and a fragment shader to `mediump`, so a
 * uniform or varying named in both — `uIntensity`, `vGlow`, `vUv` — links with
 * mismatched precision and the program fails `VALIDATE_STATUS` with nothing
 * drawn and only a console warning to show for it. `highp` rather than
 * `mediump` in both because scene coordinates reach ~80 units, where mediump's
 * ~0.03-unit resolution is coarse enough to make the field visibly jitter.
 */
const PRECISION = `precision highp float;`;

const POINT_VERTEX = `
${PRECISION}

attribute float aSeed;

uniform float uTime;
uniform float uIntensity;
uniform float uRadius;
uniform float uBreath;
uniform float uSize;

varying float vGlow;
varying float vDepth;

// Smooth, cheap pseudo-noise. Real value noise is overkill for a surface that
// only has to waver; three sines cost a fraction of it and never band.
float wobble(vec3 p, float t) {
  return sin(p.x * 3.1 + t) * sin(p.y * 2.7 - t * 0.8) * sin(p.z * 3.4 + t * 0.6);
}

void main() {
  vec3 dir = normalize(position);

  // Breathing surface. The displacement is along the normal, so the shell
  // stays a shell rather than smearing into a cloud.
  float w = wobble(dir * 2.2, uTime * 0.55);
  float radius = uRadius * (1.0 + w * uBreath);

  // Ignition pulls the shell inward as it dims, so a dormant core reads as a
  // tight seed rather than a faint full-size ghost.
  radius *= mix(0.55, 1.0, uIntensity);

  vec3 displaced = dir * radius;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);

  // Sparse per-point flicker. The cube keeps most points near their base
  // brightness with occasional bright ones -- computation, not twinkling.
  float flick = fract(sin(aSeed * 97.0 + uTime * 0.9) * 43758.5453);
  vGlow = (0.35 + 0.65 * pow(flick, 3.0)) * uIntensity;
  vDepth = clamp(1.0 - (-mv.z) / 60.0, 0.0, 1.0);

  gl_PointSize = uSize * (300.0 / max(-mv.z, 0.001)) * (0.6 + 0.4 * flick);
  gl_Position = projectionMatrix * mv;
}
`;

const POINT_FRAGMENT = `
${PRECISION}

uniform vec3 uColorInner;
uniform vec3 uColorOuter;

varying float vGlow;
varying float vDepth;

void main() {
  // Round the square point sprite off into a soft dot.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float falloff = pow(1.0 - r * 2.0, 1.6);

  vec3 col = mix(uColorOuter, uColorInner, vGlow);
  float alpha = falloff * vGlow * (0.35 + 0.65 * vDepth) * 0.62;

  gl_FragColor = vec4(col, alpha);
}
`;

const BODY_VERTEX = `
${PRECISION}

uniform float uTime;
uniform float uIntensity;

varying vec3 vNormal;
varying vec3 vViewDir;

float wobble(vec3 p, float t) {
  return sin(p.x * 3.1 + t) * sin(p.y * 2.7 - t * 0.8) * sin(p.z * 3.4 + t * 0.6);
}

void main() {
  vec3 dir = normalize(position);
  float w = wobble(dir * 2.4, uTime * 0.5);
  vec3 displaced = dir * (1.0 + w * 0.07) * mix(0.55, 1.0, uIntensity);

  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * dir);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const BODY_FRAGMENT = `
${PRECISION}

uniform float uIntensity;
uniform vec3 uRim;
uniform vec3 uCore;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  // Fresnel: dark facing the camera, bright at the silhouette. This is what
  // makes the body read as a volume the points are wrapped around.
  float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
  float rim = pow(1.0 - facing, 2.6);

  vec3 col = mix(uCore, uRim, rim);
  float alpha = (0.10 + rim * 0.62) * uIntensity;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

const GLOW_FRAGMENT = `
${PRECISION}

uniform float uIntensity;
uniform float uTime;
uniform vec3 uColor;

varying vec2 vUv;

void main() {
  float r = length(vUv - vec2(0.5)) * 2.0;
  if (r > 1.0) discard;

  // Two falloffs summed: a tight hot centre over a wide soft bloom. One
  // exponent alone reads either as a hard dot or as fog.
  float core = pow(1.0 - r, 4.0) * 0.30;
  float bloom = pow(1.0 - r, 1.6) * 0.22;

  // Slow breath, so the core never looks like a static asset.
  float pulse = 0.88 + 0.12 * sin(uTime * 0.9);

  gl_FragColor = vec4(uColor, (core + bloom) * uIntensity * pulse * 0.9);
}
`;

const GLOW_VERTEX = `
${PRECISION}

varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export interface AiCoreProps {
  /** 0 = dormant (scene 1), 1 = fully ignited (scene 2 onward). */
  intensityRef: React.RefObject<number>;
  radius?: number;
}

export function AiCore({ intensityRef, radius = 2.4 }: AiCoreProps) {
  const shell = React.useMemo(() => fibonacciSphere(SHELL_COUNT), []);
  const halo = React.useMemo(() => fibonacciSphere(HALO_COUNT), []);

  const shellRef = React.useRef<THREE.Points>(null);
  const haloRef = React.useRef<THREE.Points>(null);
  const bodyRef = React.useRef<THREE.Mesh>(null);
  const glowRef = React.useRef<THREE.Mesh>(null);

  /**
   * Animate through the material's OWN uniforms, never through the object
   * passed to the `uniforms` prop.
   *
   * R3F does not keep that object by reference — the material ends up holding
   * a clone, so a component that mutates its own memoised copy every frame is
   * writing to something nothing renders. The failure is silent and looks
   * exactly like a dead render loop: the shader compiles, the mesh is in the
   * scene, `useFrame` runs (367 frames, measured), and every uniform on the
   * live material stays at its initial value. Diagnosed by comparing object
   * identity in the browser, so treat the `uniforms` prop as *initial values
   * only* and drive everything after mount through these refs.
   */
  const shellMat = React.useRef<THREE.ShaderMaterial>(null);
  const haloMat = React.useRef<THREE.ShaderMaterial>(null);
  const bodyMat = React.useRef<THREE.ShaderMaterial>(null);
  const glowMat = React.useRef<THREE.ShaderMaterial>(null);

  const shellUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uRadius: { value: radius },
      uBreath: { value: 0.16 },
      uSize: { value: 1.45 },
      uColorInner: { value: new THREE.Color("#eafcff") },
      uColorOuter: { value: new THREE.Color("#2ea8ff") },
    }),
    [radius],
  );

  const haloUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uRadius: { value: radius * 1.85 },
      uBreath: { value: 0.3 },
      uSize: { value: 1.05 },
      uColorInner: { value: new THREE.Color("#bde9ff") },
      uColorOuter: { value: new THREE.Color("#6f6bff") },
    }),
    [radius],
  );

  const bodyUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uRim: { value: new THREE.Color("#7fe3ff") },
      uCore: { value: new THREE.Color("#04101f") },
    }),
    [],
  );

  const glowUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColor: { value: new THREE.Color("#4fb8ff") },
    }),
    [],
  );

  useFrame(({ clock, camera }) => {
    const t = clock.getElapsedTime();
    const intensity = intensityRef.current ?? 0;

    const drive = (material: THREE.ShaderMaterial | null, value: number) => {
      if (!material) return;
      material.uniforms.uTime.value = t;
      material.uniforms.uIntensity.value = value;
    };

    drive(shellMat.current, intensity);
    drive(haloMat.current, intensity * 0.7);
    drive(bodyMat.current, intensity);
    drive(glowMat.current, intensity);

    // Counter-rotating layers. Equal speeds would read as one rigid object
    // turning; opposed ones read as something being computed.
    if (shellRef.current) shellRef.current.rotation.y = t * 0.055;
    if (haloRef.current) {
      haloRef.current.rotation.y = -t * 0.032;
      haloRef.current.rotation.x = t * 0.018;
    }
    if (bodyRef.current) bodyRef.current.rotation.y = t * 0.04;

    // The glow disc is billboarded by hand rather than using a Sprite, because
    // a Sprite would also scale with distance in a way that fights the camera
    // dolly through the scene.
    if (glowRef.current) glowRef.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group>
      <mesh ref={glowRef} renderOrder={-1}>
        <planeGeometry args={[radius * 11, radius * 11]} />
        <shaderMaterial
          ref={glowMat}
          vertexShader={GLOW_VERTEX}
          fragmentShader={GLOW_FRAGMENT}
          uniforms={glowUniforms}
          transparent
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh ref={bodyRef}>
        {/* Detail 4 = 5,120 triangles. The surface is displaced smoothly in the
            vertex shader, so higher subdivision buys nothing visible and costs
            a lot — detail 6 is 81,920 triangles for the same silhouette. */}
        <icosahedronGeometry args={[radius * 0.82, 4]} />
        <shaderMaterial
          ref={bodyMat}
          vertexShader={BODY_VERTEX}
          fragmentShader={BODY_FRAGMENT}
          uniforms={bodyUniforms}
          transparent
          depthWrite={false}
        />
      </mesh>

      <points ref={shellRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[shell.positions, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[shell.seeds, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={shellMat}
          vertexShader={POINT_VERTEX}
          fragmentShader={POINT_FRAGMENT}
          uniforms={shellUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <points ref={haloRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[halo.positions, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[halo.seeds, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={haloMat}
          vertexShader={POINT_VERTEX}
          fragmentShader={POINT_FRAGMENT}
          uniforms={haloUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
