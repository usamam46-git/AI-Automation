import * as THREE from "three";

/**
 * A polished hardwood desk surface, drawn procedurally.
 *
 * ## Why this is generated and not an image
 *
 * The same reasoning as `document-texture.ts`: no asset download, no licensing
 * question about a photographed wood, no 2MB texture on a landing page's first
 * paint, and it is tunable by constant rather than by re-exporting a file. A
 * desk is the one large surface in the opening shot, so a low-resolution or
 * visibly tiled photo would be the most obvious thing on the page.
 *
 * ## What actually makes wood read as wood
 *
 * Three things, in order of importance:
 *
 *   1. **Grain lines that run in one direction** and vary in width, darkness and
 *      spacing. Evenly spaced lines read as corduroy.
 *   2. **Cathedral figure** — the long stretched arcs where the saw crossed a
 *      growth ring. This is the single feature that separates "wood" from
 *      "brown surface with stripes", and it is why the arcs below are worth the
 *      extra code.
 *   3. **Slow tonal drift** across the board, so no two areas are the same
 *      value. Flat colour under grain looks like printed laminate.
 *
 * The polish is not in the texture — it is in the material. See
 * `office-room.tsx`, which pairs this map with a clearcoat.
 */

const WIDTH = 1024;
const HEIGHT = 1024;

/**
 * Walnut, and warm on purpose.
 *
 * This is the one warm thing in the room and it is deliberate. The rest of the
 * page is macOS-light neutral greys; a warm timber against them is the contrast
 * the whole opening is built on, and it is also what finally makes the white
 * documents read — paper on a near-white desk washed out completely.
 */
const GRAIN_DARK = "rgba(38, 24, 14, 0.55)";
const GRAIN_LIGHT = "rgba(190, 143, 96, 0.20)";

/** Deterministic noise, so a given build always produces the same desk —
 *  reproducible screenshots and reviewable diffs, as elsewhere in this scene. */
function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function drawWood(ctx: CanvasRenderingContext2D) {
  // Base board, with a slow tonal drift across it so the surface is never flat.
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, "#5b3a22");
  base.addColorStop(0.35, "#6b4529");
  base.addColorStop(0.7, "#573620");
  base.addColorStop(1, "#634025");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Grain. Runs along the board's length (x), wobbling slightly so no line is
  // mechanically straight.
  for (let i = 0; i < 260; i += 1) {
    const y = hash(i * 3.1) * HEIGHT;
    const thickness = 0.6 + hash(i * 7.7) * 2.4;
    const dark = hash(i * 5.3) > 0.35;

    ctx.strokeStyle = dark ? GRAIN_DARK : GRAIN_LIGHT;
    ctx.lineWidth = thickness;
    ctx.globalAlpha = 0.25 + hash(i * 11.3) * 0.5;

    ctx.beginPath();
    ctx.moveTo(0, y);
    const wobble = 6 + hash(i * 2.9) * 22;
    const phase = hash(i * 13.7) * Math.PI * 2;
    for (let x = 0; x <= WIDTH; x += 32) {
      ctx.lineTo(x, y + Math.sin(x / 190 + phase) * wobble);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Cathedral figure: the stretched arcs of a growth ring cut on the flat. A
  // few, large, and low contrast — this is the feature that stops the surface
  // reading as painted stripes.
  for (let i = 0; i < 5; i += 1) {
    const cx = hash(i * 17.3) * WIDTH;
    const cy = hash(i * 23.9) * HEIGHT;
    for (let ring = 0; ring < 16; ring += 1) {
      ctx.strokeStyle = "rgba(40, 25, 14, 0.16)";
      ctx.lineWidth = 1 + hash(i * 31.1 + ring) * 1.8;
      ctx.beginPath();
      // Very wide, very flat ellipses — a growth ring seen almost edge-on.
      ctx.ellipse(cx, cy, 60 + ring * 46, 10 + ring * 5.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // A last pass of fine hairlines for close-up detail: the desk sits directly
  // under the camera in the opening frame, so the surface is seen large.
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 420; i += 1) {
    const y = hash(i * 41.7) * HEIGHT;
    ctx.strokeStyle = hash(i * 3.3) > 0.5 ? "#2a1a0e" : "#8d6440";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y + (hash(i * 5.9) - 0.5) * 8);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

let cached: THREE.CanvasTexture | null = null;

/** Builds (and memoises) the desk's wood map. */
export function woodTexture(): THREE.CanvasTexture {
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for wood texture");
  drawWood(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // NOT tiled. The drawn grain does not wrap seamlessly — its left and right
  // edges do not meet — so any repeat above 1 puts a hard vertical seam straight
  // down the middle of the desk, which is the most visible thing in the opening
  // frame. One board across the whole surface, grain running its length.
  texture.repeat.set(1, 1);
  texture.anisotropy = 8;

  cached = texture;
  return texture;
}
