/**
 * Script for the 3D scene on the marketing landing page.
 *
 * This module is the scene's *choreography*, kept pure and testable in the same
 * way `run-film.ts` keeps the 2D film's beat list out of its renderer. Nothing
 * here imports three.js or React — it is arithmetic over a 0–1 scrub progress,
 * so the whole narrative can be asserted in a node-environment test while the
 * rendering stays in `components/marketing/scene/*`.
 *
 * ## The four scenes
 *
 *   0.00 → 0.28  scattered      Descent from the sky. Objects drift, unconnected.
 *   0.28 → 0.52  connect        The core ignites; edges resolve the drift into a graph.
 *   0.52 → 0.82  run            One real run, and the hold at the approval gate.
 *   0.82 → 1.00  orchestrated   Pull back to HR/ERP/Finance, collapse into the mark.
 *
 * Scene 3 is deliberately the longest. It is the one that carries the product's
 * actual argument, and it inherits its beats from `run-film.ts` rather than
 * inventing a second, drift-prone version of the same story.
 *
 * ## Why positions are generated, not authored
 *
 * Twenty hand-placed `[x, y, z]` triples would be unreadable and impossible to
 * re-balance. They come from a seeded PRNG instead, so the layout is stable
 * across SSR, the client, and the test run — but re-tuning the composition is a
 * one-constant change rather than a merge conflict. The *labels* are authored,
 * because they are real domain nouns and the scene is worthless if they read as
 * lorem ipsum.
 */

import { FILM_BEATS, type FilmBeat, nodeStatesAtBeat } from "@/lib/run-film";

export type Vec3 = readonly [number, number, number];

/* -------------------------------------------------------------------------- */
/* Scenes                                                                     */
/* -------------------------------------------------------------------------- */

export type SceneId = "scattered" | "connect" | "run" | "orchestrated";

export interface SceneDef {
  id: SceneId;
  /** Global scrub progress where this scene begins. */
  start: number;
  /** Global scrub progress where it ends. Contiguous with the next `start`. */
  end: number;
  /** Small label above the line. */
  eyebrow: string;
  /** The sentence the scene is arguing. Kept here so the copy is testable. */
  line: string;
}

export const SCENES: readonly SceneDef[] = [
  {
    id: "scattered",
    start: 0,
    end: 0.28,
    eyebrow: "Every system, separately",
    line: "Your company is already automated. It just doesn't know it yet.",
  },
  {
    id: "connect",
    start: 0.28,
    end: 0.52,
    eyebrow: "One reasoning layer",
    line: "From events, to decisions, to actions.",
  },
  {
    id: "run",
    start: 0.52,
    end: 0.82,
    eyebrow: "One real run",
    line: "And here it stops. Nothing reaches your ledger until a person says so.",
  },
  {
    id: "orchestrated",
    start: 0.82,
    end: 1,
    eyebrow: "HR · ERP · Finance",
    line: "Your business shouldn't need people to connect the dots.",
  },
] as const;

/**
 * Maps a 0–1 scrub progress onto a scene index.
 *
 * Clamps rather than throwing, for the same reason `beatIndexAtProgress` does:
 * ScrollTrigger reports marginally out-of-range progress during a resize or a
 * fast fling, and a scene that crashes on overscroll is worse than one that
 * shows its last frame.
 */
export function sceneIndexAtProgress(progress: number, scenes: readonly SceneDef[] = SCENES): number {
  if (!Number.isFinite(progress) || scenes.length === 0) return 0;
  const clamped = Math.min(Math.max(progress, 0), 1);
  for (let i = 0; i < scenes.length; i += 1) {
    if (clamped < scenes[i].end) return i;
  }
  return scenes.length - 1;
}

/** Progress *within* the current scene, 0–1. Useful for per-scene easing. */
export function sceneLocalProgress(progress: number, scenes: readonly SceneDef[] = SCENES): number {
  const scene = scenes[sceneIndexAtProgress(progress, scenes)];
  const span = scene.end - scene.start;
  if (span <= 0) return 0;
  const clamped = Math.min(Math.max(progress, 0), 1);
  return Math.min(Math.max((clamped - scene.start) / span, 0), 1);
}

/* -------------------------------------------------------------------------- */
/* Clusters — declared before the camera, which frames them                   */
/* -------------------------------------------------------------------------- */

export type ClusterId = "people" | "hr" | "finance" | "erp";

/**
 * Where each cluster settles once the core is between them.
 *
 * A balanced 2x2, deliberately not a diamond. A diamond puts one cluster at
 * bottom centre, which is exactly where the scene's copy sits — the settled
 * graph ended up with the people cluster behind the sentence. Four quadrants
 * keep the centre of frame for the core and the bottom centre for the words.
 *
 * They are also tight around the origin. A wider arrangement left the documents
 * so far apart after settling that the edges between them stayed frame-crossing
 * lines and the graph never visually closed.
 *
 * Declared above the camera because scene 3's keyframes are derived from the
 * finance cluster's position rather than hardcoded — the run happens *there*,
 * and a camera that does not follow the cluster when it moves is a camera
 * pointed at empty room.
 */
export const CLUSTER_CENTERS: Readonly<Record<ClusterId, Vec3>> = {
  erp: [-20, 10, -4],
  finance: [20, 10, -4],
  hr: [-20, -10, -4],
  people: [20, -10, -4],
};

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

export interface CameraKey {
  /** Global progress at which the camera is exactly here. */
  at: number;
  position: Vec3;
  target: Vec3;
}

/**
 * Camera path, as keyframes interpolated with a smoothstep ease.
 *
 * **The whole path is constrained by legibility.** The objects are documents
 * with body copy on them, so the camera has to sit close enough that the
 * nearest cards can actually be read — roughly 200px of screen height at the
 * opening. An earlier version opened at z=62 to show the field as a whole; at
 * that distance a card is 60px tall, the text is mush, and the scene is back to
 * being abstract shapes. Depth in the composition now comes from the *spread*
 * of the field, not from retreating out of it: near cards read fully, far ones
 * fall away.
 *
 * The one place the camera is allowed to go wide is the final pull-back, where
 * the subject is the shape of the whole system rather than any one document.
 */
/** Shorthand for the cluster scene 3 takes place in. */
const FIN = CLUSTER_CENTERS.finance;

/**
 * Where the desk sits, and how long the page stays on it.
 *
 * The scene opens on **an actual desk** — documents lying flat on a surface,
 * lit and casting shadows onto it — and only then do they lift off and scatter.
 * That opening is doing real work: it gives the whole sequence a physical
 * starting point a viewer already recognises, so the field that follows reads as
 * *this company's paperwork in the air* rather than as objects that were always
 * floating. It is also the honest version of the page's first sentence: the work
 * is already happening, on a desk, right now.
 */
export const DESK_Y = -5;
/**
 * Where a document actually rests: on the wood, not in it.
 *
 * A card is a 0.06-deep box, so laying it at exactly `DESK_Y` centres it *in*
 * the desk's top face and leaves half its thickness below the surface. The two
 * coplanar surfaces then fight, and the desk wins over parts of the card — one
 * invoice on the right of the opening frame looked like it had been sliced off
 * inside the table. Half the card's depth clears the surface; the rest is
 * breathing room so no camera angle can bring them back into contact.
 */
export const CARD_REST_Y = DESK_Y + 0.05;
/**
 * The room the desk stands in — now a photograph, not geometry.
 *
 * `FLOOR_Y` and `WALL_Z` used to position a modelled floor and back wall in
 * `office-room.tsx`. `room-plate.tsx` replaced that whole room with
 * `public/desk-room.jpg`, so nothing renders at either coordinate any more and
 * both were removed along with the meshes and the procedural walnut map.
 */

/* -------------------------------------------------------------------------- */
/* The plate — the photographed room the page opens in                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the photographed table's far edge lands, in NDC y.
 *
 * **Measured off the plate, not chosen.** `public/desk-room.jpg` is 1000×661; a
 * per-row luminance scan of the lower frame finds one dominant step at y=478 —
 * the blurred dark interior (luminance ~95) giving way to the lit, sharp oak
 * tabletop (~212), a jump of 80 in four rows. `1 - 2 * 478 / 661 = -0.4463`.
 *
 * Everything below derives from this one number, which is why it is stated once
 * and asserted in the tests rather than being spread across three files as tuned
 * magic constants. **If the plate is ever replaced with a different photograph
 * or a crop, re-measure it** — the whole opening composition hangs off it. The
 * scan is a dozen lines: mean row luminance across the centre 40% of the frame,
 * then the largest single step in the lower half.
 */
export const PLATE_DESK_EDGE_NDC = -0.4463;

/**
 * Where that edge sits in world space, given the opening camera.
 *
 * The opening camera is deliberately **level** (see `CAMERA_KEYS`), so the
 * projection reduces to `y = -h / (d * tanHalf)` with `h = 0.25 - CARD_REST_Y`,
 * i.e. 5.2. Solving `d = h / (0.4463 * tanHalf)` gives 27.44, so the
 * photographed table's far edge sits at `z = 14 - 27.44`. Documents live in
 * front of it; the shadow catcher spans up to it.
 */
export const PLATE_DESK_EDGE_Z = -13.44;

/**
 * Near and far bounds of the band documents may occupy on the photographed desk.
 *
 * ## A whole document fits, and that is what this plate bought
 *
 * The visible tabletop runs from NDC -0.4463 to -1.0 — **0.55 NDC, better than
 * a quarter of the frame**. Requiring a card to be wholly inside it gives
 * `d >= 14.87` (near end above the bottom of frame) and `d <= 24.82` (far end
 * below the table edge), which is a wide, comfortable range.
 *
 * That was not true of the first plate, whose table was a 0.25-NDC sliver where
 * the two constraints were mutually exclusive and every sheet had to be cropped.
 * The documents there could not be read at the opening; here they can, which is
 * the whole reason the plate was replaced.
 *
 * `DESK_NEAR_Z` still reaches slightly in front of the whole-fit range, so a
 * sheet or two runs off the bottom of frame. That is deliberate and is what a
 * photograph of a working desk looks like — the table continues toward the
 * viewer and so does the paperwork. `placeOnDesk` enforces the asymmetry:
 * never past the table's far edge, freely past the bottom.
 */
export const DESK_NEAR_Z = 1.0;
export const DESK_FAR_Z = -10.3;
/**
 * How much of its height a card lying flat presents to the opening camera.
 *
 * `h * d / (d^2 - c^2)` at mid-band, with `c` the card's half depth — 0.284 at
 * `d = 18.65`. A test pins this against the projection so the two cannot drift.
 *
 * It is a mid-band approximation: the true ratio runs 0.35 at the front of the
 * band to 0.22 at the back, because a flat card's angular height falls off as
 * `1/d^2` while an upright one falls off as `1/d`. Using the mid value
 * *over*-estimates the height of the far cards, which is the safe direction —
 * the far-edge rule then rejects placements that would in fact have been legal
 * rather than letting one ride up onto the bookcase.
 */
export const DESK_FORESHORTEN = 0.284;
/** How much closer than the airborne rule desk documents may sit. Below 1
 *  because paper on a desk overlaps. */
const DESK_OVERLAP = 0.5;
/** Progress at which the documents have fully left the desk. */
export const LIFTOFF_END = 0.16;
/**
 * Progress at which the scattered field is composed.
 *
 * **Not 0.** Progress 0 is the desk, so composing the airborne field against
 * the desk camera would place it for a shot it is never seen in. Every layout
 * rule — the copy safe zone, the frame-edge rule, the depth schedule — is
 * evaluated here instead, at the first moment the field is actually the subject.
 */
export const LAYOUT_PROGRESS = 0.22;

export const CAMERA_KEYS: readonly CameraKey[] = [
  /**
   * Matched to the photograph, and **exactly level** — that is load-bearing.
   *
   * Verticals in `desk-room.jpg` run parallel to the frame edges: the shelf
   * uprights, the window frame and the door of the credenza show no keystoning
   * at all, which means the plate was shot with the sensor plane vertical. A
   * tilted 3D camera over an untilted photograph is the kind of mismatch nobody
   * can name but everybody sees — the papers would sit in a subtly different
   * perspective from the table under them.
   *
   * Level also collapses the projection to `y = -h / (d * tanHalf)`, which is
   * what makes `PLATE_DESK_EDGE_Z` and `DESK_FORESHORTEN` solvable in closed
   * form instead of tuned by eye. The previous key looked down by 2.2 degrees
   * (its comment claimed 40, which was never true of these numbers).
   *
   * ## The height is the document size
   *
   * `y = 0.25` puts the camera 5.2 world units above the paper — about 1.3
   * document-widths, which is the physically right answer for this plate: a
   * low product-shot camera sitting a hand's height above the table, which is
   * exactly what the photograph's own framing implies. It is also the knob that
   * sets how large the paperwork reads, since a card is a fixed 4 units wide
   * and its on-screen size is `~5.3 / d`. At this height the near sheets land
   * around 320px and the far ones around 175px on a 1600px viewport — an A4
   * sheet on a table, which is what they are.
   *
   * Raising the camera pushes the whole band further away and shrinks every
   * document; the first pass at this plate used the old `y = 1.5` and the
   * paperwork came out too small to read.
   */
  { at: 0.0, position: [0, 0.25, 14], target: [0, 0.25, -11] },
  // Lifting: the camera rises with the documents and levels off.
  { at: LIFTOFF_END, position: [0, 4, 17], target: [0, -1, -2] },
  { at: LAYOUT_PROGRESS, position: [0, 3, 30], target: [0, 1, 0] },
  // Scene 2 pulls *back*, it does not push in. The first version moved the
  // camera to z=19 while the field was still spread across ninety world units,
  // which put the viewer inside the web: every edge became a scaffolding pole
  // crossing the whole frame and nothing read as a connection. The subject of
  // this scene is the shape of the graph, so the camera has to be outside it.
  { at: 0.28, position: [0, 3, 33], target: [0, 0, 0] },
  { at: 0.52, position: [0, 4, 46], target: [0, 0, 0] },

  // Scene 3 — the run. The camera crosses to the finance cluster, because that
  // is where INV-2291 actually lives once the field has settled; these are
  // offsets from `CLUSTER_CENTERS.finance` rather than literals so the shot
  // follows the cluster if it is ever re-placed.
  { at: 0.60, position: [FIN[0] + 1, FIN[1] - 1, FIN[2] + 30], target: FIN },
  // The hold. Closest the camera comes to anything all page — the gate is the
  // one thing on this page worth reading in full.
  { at: 0.70, position: [FIN[0] + 2, FIN[1] - 1, FIN[2] + 19], target: FIN },
  { at: 0.78, position: [FIN[0] + 1, FIN[1] - 2, FIN[2] + 24], target: FIN },

  // Scene 4 — pull back to the whole system, then out.
  { at: 0.88, position: [4, 2, 44], target: [0, 0, 0] },
  { at: 1.0, position: [0, 5, 74], target: [0, 0, 0] },
] as const;

/* -------------------------------------------------------------------------- */
/* Projection — used to compose the opening frame, not just to describe it    */
/* -------------------------------------------------------------------------- */

/**
 * Card size in world units, owned here rather than in the renderer.
 *
 * The layout below reasons about how large a card lands on screen, so the size
 * has to be a fact this module knows. `document-field.tsx` imports these rather
 * than declaring its own, so the composition and the geometry cannot drift.
 *
 * Widened from 3.4 after the opening frame was first seen: at 3.4 a mid-depth
 * card was ~135px tall on a 800px viewport and its body rows resolved to grey
 * ticks. Only the titles survived, which is the "abstract shapes" failure the
 * whole document treatment exists to avoid.
 */
export const CARD_WORLD_WIDTH = 4;
/** Aspect must match `CARD_PIXEL_HEIGHT / CARD_PIXEL_WIDTH` in
 *  `document-texture.ts`, or the printed document is stretched on the card.
 *  Hardcoded rather than imported because this module stays three.js-free. */
export const CARD_WORLD_HEIGHT = CARD_WORLD_WIDTH * (672 / 512);

/** Matches the `fov` on the R3F camera. Changing one without the other makes
 *  every composition rule below quietly wrong. */
export const CAMERA_FOV_DEG = 46;

/** Assumed viewport aspect for composition. A desktop 16:9-ish frame is the
 *  one being composed for; narrower viewports crop in, which only ever moves
 *  cards further from the centre, never into the copy. */
const COMPOSE_ASPECT = 1.78;

export interface ScreenPoint {
  /** Normalised device coordinates, -1..1. Off-screen values are not clamped. */
  x: number;
  y: number;
  /** Distance along the camera's forward axis. Negative means behind. */
  depth: number;
  /** Half-height of a card at this depth, in NDC units. */
  radiusY: number;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Projects a world point through the camera at a given scrub progress.
 *
 * Exists so the opening composition can be *asserted* rather than eyeballed:
 * the copy block sits at the bottom centre of the frame, and a card that lands
 * behind it makes the sentence unreadable. The first rendered frame had exactly
 * that — an employee record sitting under "Your company is already automated."
 */
/**
 * Places a world point *from* a screen position and a depth.
 *
 * The inverse of `projectAtProgress`, and the reason the layout below composes
 * reliably. Rejection-sampling world positions and hoping they land where the
 * composition needs them does not work here: the region that is simultaneously
 * near enough to read, inside the frame, clear of the copy and off the camera
 * axis is a narrow annulus, and uniform world sampling finds it roughly once in
 * a hundred attempts. Sampling the screen and solving for the world point hits
 * it every time, and makes "three cards near enough to read" an instruction
 * rather than a hope.
 */
export function unprojectAtProgress(
  x: number,
  y: number,
  depth: number,
  progress = 0,
  aspect = COMPOSE_ASPECT,
): Vec3 {
  const { position, target } = cameraAtProgress(progress);
  const forward = normalize(sub(target, position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

  const xCam = x * depth * tanHalf * aspect;
  const yCam = y * depth * tanHalf;

  return [
    position[0] + forward[0] * depth + right[0] * xCam + up[0] * yCam,
    position[1] + forward[1] * depth + right[1] * xCam + up[1] * yCam,
    position[2] + forward[2] * depth + right[2] * xCam + up[2] * yCam,
  ];
}

export function projectAtProgress(
  point: Vec3,
  progress = 0,
  aspect = COMPOSE_ASPECT,
): ScreenPoint {
  const { position, target } = cameraAtProgress(progress);
  const forward = normalize(sub(target, position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  const v = sub(point, position);
  const depth = dot(v, forward);
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

  // Behind the camera: report it as such rather than returning a mirrored
  // projection, which would read as a valid on-screen position.
  if (depth <= 0.001) return { x: 0, y: 0, depth, radiusY: 0 };

  return {
    x: dot(v, right) / (depth * tanHalf * aspect),
    y: dot(v, up) / (depth * tanHalf),
    depth,
    radiusY: CARD_WORLD_HEIGHT / 2 / (depth * tanHalf),
  };
}

/**
 * The band of the opening frame the copy occupies, in NDC.
 *
 * The scene's sentence is DOM text composited over the canvas, so a card here
 * is not occluded by the copy — it shows *through* it, which is worse. Nothing
 * may be placed inside this box at the opening.
 */
export const COPY_SAFE_ZONE = { minX: -0.46, maxX: 0.46, minY: -1.05, maxY: -0.34 } as const;

/**
 * The band the *hero* copy occupies, which is a different shape entirely.
 *
 * The scene's captions sit at the bottom of the frame; the page's hero — the
 * headline, the subhead and the two calls to action — sits high, over the back
 * wall, with the desk below it. So the desk layout is composed against this
 * zone rather than `COPY_SAFE_ZONE`: no document may rise into the upper frame
 * where the headline is.
 */
export const HERO_SAFE_ZONE = { minX: -0.9, maxX: 0.9, minY: 0.02, maxY: 1.1 } as const;

/**
 * The channel the calls to action sit in, below the headline.
 *
 * The hero copy is not a rectangle — it is a wide block of text with a narrow
 * column beneath it. Reserving one rectangle for the whole thing left the desk a
 * band 0.68 NDC tall to seat documents 0.8 NDC tall, and exactly two fitted.
 *
 * This channel covers **only the last line of small text**, not the buttons
 * below it. The buttons are opaque pills; paper behind them reads as buttons
 * sitting on a desk, which is what they should look like. Reserving space for
 * them too emptied the entire lower centre of the shot and left a hole through
 * the middle of the composition. Text needs a clean background; a solid button
 * does not.
 */
export const HERO_CTA_CHANNEL = { minX: -0.42, maxX: 0.42, minY: -0.18, maxY: 0.02 } as const;

/** Whether a document would touch the hero copy or the button channel. */
export function intersectsHeroZone(p: ScreenPoint): boolean {
  if (p.depth <= 0) return false;
  const radiusX = p.radiusY / COMPOSE_ASPECT;
  const hits = (zone: { minX: number; maxX: number; minY: number; maxY: number }) =>
    p.x + radiusX > zone.minX &&
    p.x - radiusX < zone.maxX &&
    p.y + p.radiusY > zone.minY &&
    p.y - p.radiusY < zone.maxY;
  return hits(HERO_SAFE_ZONE) || hits(HERO_CTA_CHANNEL);
}

/** Whether a card centred at this screen point would touch the copy block. */
export function intersectsCopyZone(p: ScreenPoint): boolean {
  if (p.depth <= 0) return false;
  const radiusX = p.radiusY / COMPOSE_ASPECT;
  return (
    p.x + radiusX > COPY_SAFE_ZONE.minX &&
    p.x - radiusX < COPY_SAFE_ZONE.maxX &&
    p.y + p.radiusY > COPY_SAFE_ZONE.minY &&
    p.y - p.radiusY < COPY_SAFE_ZONE.maxY
  );
}

/** Classic smoothstep. Keeps the camera from arriving at each key with a jerk. */
export function smoothstep(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Resolves the camera position and look-at target at a given scrub progress. */
export function cameraAtProgress(
  progress: number,
  keys: readonly CameraKey[] = CAMERA_KEYS,
): { position: Vec3; target: Vec3 } {
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;

  if (clamped <= keys[0].at) return { position: keys[0].position, target: keys[0].target };
  const last = keys[keys.length - 1];
  if (clamped >= last.at) return { position: last.position, target: last.target };

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (clamped >= a.at && clamped <= b.at) {
      const span = b.at - a.at;
      const t = smoothstep(span <= 0 ? 0 : (clamped - a.at) / span);
      return { position: lerpVec3(a.position, b.position, t), target: lerpVec3(a.target, b.target, t) };
    }
  }

  return { position: last.position, target: last.target };
}

/* -------------------------------------------------------------------------- */
/* The room: a daylight studio                                                */
/* -------------------------------------------------------------------------- */

/**
 * The scene is lit like an overhead shot of a desk, not like deep space.
 *
 * An earlier version opened on the marketing hero's sky and descended into a
 * near-black void with neon curtains. It was rejected, and correctly: an
 * indigo-and-violet nebula is the default look of every AI landing page, it
 * said nothing about back-office software, and white text over glow left no
 * room for the actual subject — readable documents. This palette is warm
 * studio grey with white paper and near-black ink, and **nothing in the scene
 * is emissive.** If a surface starts glowing it stops reading as paper.
 *
 * The tonal shift below is deliberately tiny: a few points darker as the camera
 * pulls back, which gives depth without ever approaching a dark theme.
 */
/**
 * These are the landing page's own two neutrals, not a new palette.
 *
 * `--mk-paper` (#f5f5f7 — macOS light mode\'s own system background) is the
 * background of every other section on the page, and `--mk-mist` (#ececef) is
 * the one step down from it that the page already uses. Both are **neutral**:
 * an earlier pass used warm greys and the section read as beige. The scene first shipped with its own warm studio greys (#f0eee9 down to
 * #d4d0c8) and the section read as a differently-coloured panel dropped into an
 * otherwise near-white page — a random background appearing out of nowhere. The
 * room is the same room as the rest of the site; only the light in it changes.
 *
 * Keep these in step with `--mk-paper` / `--mk-mist` in `app/globals.css`. The
 * range between them is deliberately tiny: this gradient exists to give the
 * room a floor and a ceiling, not to be noticed.
 */
const STUDIO_NEAR_TOP: Vec3 = [245, 245, 247];
const STUDIO_NEAR_BOTTOM: Vec3 = [238, 238, 241];
const STUDIO_FAR_TOP: Vec3 = [241, 241, 244];
const STUDIO_FAR_BOTTOM: Vec3 = [232, 232, 236];

/**
 * How far the room has deepened, 0–1.
 *
 * Tracks the whole page rather than finishing early, because there is no longer
 * a discrete "we are now underground" moment to arrive at — the room stays the
 * same room throughout, just a little deeper as the camera retreats from it.
 */
export function roomDepthAtProgress(progress: number): number {
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  return smoothstep(clamped);
}

function rgb(c: Vec3): string {
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

/**
 * The page background at a given progress, as a CSS gradient.
 *
 * Deliberately CSS and not a WebGL clear colour: it means first paint is a
 * gradient rather than a shader, which is what keeps the landing page's LCP
 * where it is today. The canvas composites on top with a transparent clear.
 */
export function backdropGradientAtProgress(progress: number): string {
  const t = roomDepthAtProgress(progress);
  const top = lerpVec3(STUDIO_NEAR_TOP, STUDIO_FAR_TOP, t);
  const bottom = lerpVec3(STUDIO_NEAR_BOTTOM, STUDIO_FAR_BOTTOM, t);
  return `linear-gradient(180deg, ${rgb(top)} 0%, ${rgb(bottom)} 100%)`;
}

/**
 * Ignition of the AI core, 0–1.
 *
 * Deliberately still 0 for most of scene 1. The scene's opening claim is that
 * the work is already happening and nothing is connecting it — a core glowing
 * away in the corner from the first frame would contradict that before the
 * copy has had a chance to make it. It reaches full just after scene 2 begins,
 * so the ignition *is* the scene change rather than a thing that happens during it.
 */
export function coreIntensityAtProgress(progress: number): number {
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  return smoothstep((clamped - 0.18) / (0.36 - 0.18));
}

/* -------------------------------------------------------------------------- */
/* The objects                                                                */
/* -------------------------------------------------------------------------- */

export type NodeKind =
  | "employee"
  | "hr_record"
  | "invoice"
  | "payment"
  | "document"
  | "approval"
  | "payroll"
  | "erp_op";

export interface SceneNode {
  id: string;
  kind: NodeKind;
  cluster: ClusterId;
  /** Rendered as a label when the node is near the camera or hovered. */
  label: string;
  /** Where it lies on the desk, before anything has lifted off. */
  desk: Vec3;
  /** Where it drifts once airborne, before anything is connected. */
  scattered: Vec3;
  /** Where it settles in scene 4, once the clusters resolve around the core. */
  home: Vec3;
  /** Per-object drift phase, so nothing in the field moves in lockstep. */
  phase: number;
  /** 0.75–1.25. Breaks up the silhouette so the field doesn't read as tiling. */
  scale: number;
}

/** Authored roster. Real back-office nouns — see the module docstring. */
const ROSTER: readonly { id: string; kind: NodeKind; cluster: ClusterId; label: string }[] = [
  { id: "employee_record", kind: "employee", cluster: "people", label: "Employee record" },
  { id: "new_hire", kind: "employee", cluster: "people", label: "New hire" },
  { id: "contractor", kind: "employee", cluster: "people", label: "Contractor" },
  { id: "leave_request", kind: "hr_record", cluster: "hr", label: "Leave request" },
  { id: "attendance", kind: "hr_record", cluster: "hr", label: "Attendance" },
  { id: "recruitment", kind: "hr_record", cluster: "hr", label: "Recruitment" },
  { id: "payroll_run", kind: "payroll", cluster: "hr", label: "Payroll run" },
  { id: "salary_change", kind: "payroll", cluster: "hr", label: "Salary change" },
  { id: "vendor_invoice", kind: "invoice", cluster: "finance", label: "Vendor invoice" },
  { id: "expense_claim", kind: "invoice", cluster: "finance", label: "Expense claim" },
  { id: "payment_run", kind: "payment", cluster: "finance", label: "Payment run" },
  { id: "receivable", kind: "payment", cluster: "finance", label: "Receivable" },
  { id: "journal_entry", kind: "document", cluster: "finance", label: "Journal entry" },
  { id: "purchase_order", kind: "erp_op", cluster: "erp", label: "Purchase order" },
  { id: "goods_receipt", kind: "erp_op", cluster: "erp", label: "Goods receipt" },
  { id: "inventory_move", kind: "erp_op", cluster: "erp", label: "Inventory move" },
  { id: "supplier", kind: "erp_op", cluster: "erp", label: "Supplier" },
  { id: "contract_pdf", kind: "document", cluster: "erp", label: "Contract" },
  { id: "finance_approval", kind: "approval", cluster: "finance", label: "Finance approval" },
  { id: "manager_approval", kind: "approval", cluster: "hr", label: "Manager approval" },
] as const;

/**
 * Radius of the ring a cluster's documents sit on, by member count.
 *
 * Cluster members are placed on a ring rather than jittered randomly around a
 * centre, and that is a correctness matter, not a style one: a card is four
 * world units wide, so five of them scattered inside a ±4.5 box *must* overlap.
 * The settled graph looked like four piles of paper. A ring needs roughly
 * `count × cardWidth` of circumference to seat everything without touching.
 */
function clusterRadius(count: number): number {
  // The ring is squashed vertically by CLUSTER_RING_SQUASH, so two seats
  // separated mostly in y sit closer than the raw chord suggests — the radius
  // has to be divided back out by that factor or the top and bottom of each
  // ring still overlap.
  const perSeat = CARD_WORLD_WIDTH + 2.4;
  return Math.max(8, (count * perSeat) / (2 * Math.PI * CLUSTER_RING_SQUASH));
}

/** How flat each cluster ring lies. A circle seen from a camera slightly above
 *  reads as a ring in the room; an unsquashed one reads as a wheel on edge. */
const CLUSTER_RING_SQUASH = 0.78;

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded so the layout is byte-identical on the server, in the browser and in
 * the test run. `Math.random()` here would mean a hydration mismatch on every
 * load and an untestable composition.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The one knob for re-rolling the composition. Change it, look at the result,
 * keep the one that reads best — the layout is stable for any given value.
 */
export const LAYOUT_SEED = 0x6b357;

/**
 * How the scattered field is composed, and why it is not a sphere.
 *
 * The first rendered frame showed the field packed into the edges and corners
 * with a hole through the middle. That was structural, not bad luck: the
 * positions came from a spherical *shell*, and a shell projects to an annulus.
 * There is no seed of a shell distribution that fills the centre of frame.
 *
 * What replaces it is a **depth slab** — wide in x, shallow in y, and very deep
 * in z — sampled with rejection against three rules:
 *
 *   1. Nothing inside the copy block (see `COPY_SAFE_ZONE`). The scene's
 *      sentence is the argument; a card behind it costs more than the card is
 *      worth.
 *   2. Nothing within `CORE_CLEARANCE` of the origin, where the core ignites in
 *      scene 2.
 *   3. No two cards closer than `MIN_SCREEN_GAP` apart *on screen* at the
 *      opening. World-space separation is the wrong measure — two cards 20
 *      units apart in z can still overlap exactly from the camera.
 *
 * Depth is what carries the composition: near cards are large and readable and
 * frame the edges, far ones fall away small toward the centre. That is the
 * "depth from spread, not from retreating" rule made mechanical.
 */
/**
 * The depth of every card in the opening frame, authored rather than sampled.
 *
 * This is the composition's spine, and it encodes a decision: **the opening is
 * a legibility hierarchy, not twenty equal documents.** A photograph of a desk
 * works the same way — a few things are sharp and readable, several more are
 * recognisable, the rest are texture that tells you the desk is busy.
 *
 * `radiusY` (a card's height as a fraction of the viewport) at each band:
 *   16–22 → 0.39–0.28   near: body copy resolves, these carry the story
 *   30–44 → 0.21–0.14   mid: kind and title read, rows are texture
 *   54–86 → 0.11–0.07   far: shape and paper only
 *
 * Twelve of the twenty are placed in frame; the rest are pushed outside it. The
 * roster does not fit at a readable size and should not — see `framing`.
 */
const DEPTH_SCHEDULE: readonly number[] = [
  16, 19, 22, // near — the readable ones
  30, 34, 38, 44, // mid
  54, 60, 68, 76, 86, // far
] as const;

/** Cards not in the opening frame at all. They exist in the room, and the
 *  camera reaches them in later scenes. */
const OFFSCREEN_DEPTHS: readonly number[] = [24, 31, 39, 47, 58, 66, 72, 80] as const;

const CORE_CLEARANCE = 7;
/** Absolute floor on screen separation, for two cards both far enough away that
 *  their own size no longer dominates. */
export const MIN_SCREEN_GAP = 0.2;

/**
 * Required screen separation between two cards, as a function of their size.
 *
 * A fixed gap is wrong in a scene whose whole composition is depth: 0.28 NDC
 * between two distant cards is generous, and between two near ones it is an
 * overlap. Sizing the rule to the cards is also what keeps the opening frame
 * countable — one large near card claims real estate and pushes its neighbours
 * out of frame entirely, which is the intended behaviour, not a side effect.
 */
function requiredGap(a: ScreenPoint, b: ScreenPoint): number {
  return Math.max(MIN_SCREEN_GAP, (a.radiusY + b.radiusY) * 0.82 + 0.05);
}
/** Near cards are pushed off the camera axis so the centre is filled by depth
 *  rather than by something looming. */
const NEAR_AXIS_CLEARANCE = 0.42;

/**
 * A card must be wholly on screen or wholly off it — never straddling an edge.
 *
 * This is the rule that makes twenty documents possible at a readable size, and
 * it is worth stating plainly: **the opening frame cannot hold the whole
 * roster.** Twenty cards big enough to read need about half the frame's area
 * once the copy block is excluded, which no rejection sampler will pack. The
 * field therefore extends past the viewport — some documents are simply
 * elsewhere in the room at the opening, and the camera reaches them later.
 *
 * What is *not* acceptable is the in-between: a card sliced by the frame edge
 * reads as a rendering fault rather than as a world continuing offscreen.
 */
/**
 * Inside and outside are judged at *different* aspect ratios, on purpose.
 *
 * The camera's fov is vertical, so widening the window reveals more of the
 * world horizontally. A card parked just off the left edge of a 16:9 frame is
 * back on screen at 21:9 — which is exactly what happened: cards placed outside
 * the composed frame reappeared, clipped, along the top corners of a 1512×798
 * window.
 *
 * So: a card is "inside" only if it holds on the **narrowest** viewport worth
 * composing for, and "outside" only if it stays clear on the **widest** one.
 * Anything that depends on the aspect is straddling and gets resampled.
 */
const NARROW_ASPECT = 1.6;
const WIDE_ASPECT = 2.4;

/**
 * The floating nav pill occupies the top of every frame on this page.
 *
 * It sits at `top-8` and is ~56px tall, which on an 800px viewport is roughly
 * the top 11% — NDC y above ~0.78. Authored layouts (the desk, the scattered
 * field) must keep their documents below it, or the composition puts readable
 * paper exactly where a floating white pill is drawn over it. This was visible
 * on the desk shot, where the back row of documents ran under the nav.
 *
 * Deliberately asymmetric: only the top of frame has furniture in it.
 */
const NAV_SAFE_TOP = 0.76;

export function framing(screen: ScreenPoint): "inside" | "outside" | "straddling" {
  // x is reported at COMPOSE_ASPECT; rescaling to another aspect is a ratio.
  const xAt = (aspect: number) => Math.abs(screen.x) * (COMPOSE_ASPECT / aspect);
  const rxAt = (aspect: number) => screen.radiusY / aspect;

  if (
    xAt(NARROW_ASPECT) + rxAt(NARROW_ASPECT) < 0.98 &&
    screen.y + screen.radiusY < NAV_SAFE_TOP &&
    screen.radiusY - screen.y < 0.98
  ) {
    return "inside";
  }
  if (
    xAt(WIDE_ASPECT) - rxAt(WIDE_ASPECT) > 1.06 ||
    Math.abs(screen.y) - screen.radiusY > 1.06
  ) {
    return "outside";
  }
  return "straddling";
}

/**
 * Worst-case world-space excursion of a card from its authored position.
 *
 * `document-field.tsx` drifts each card by up to (0.9, 0.75, 0.8) on the three
 * axes and tilts it. A composition computed from the authored position alone is
 * therefore a composition of where the cards *aren't* — the first fixed frame
 * still clipped cards along the top edge for exactly this reason. Every rule
 * below is evaluated against the card's inflated footprint instead.
 *
 * Keep in step with the `useFrame` amplitudes in `document-field.tsx`.
 */
const DRIFT_MARGIN = 0.8;

/**
 * The card's drawn size on screen — its scale applied, no drift allowance.
 *
 * This is what spacing is measured against. Two cards drift independently and
 * on different periods, so budgeting both of their worst cases toward each
 * other reserves room they will never simultaneously need; doing that pushed
 * every near card out of frame and left the opening with nothing readable in it.
 */
function scaled(screen: ScreenPoint, scale: number): ScreenPoint {
  return { ...screen, radiusY: screen.radiusY * scale };
}

/**
 * The card's footprint with drift budgeted in.
 *
 * Used only where an excursion is a hard visual fault — clipping the frame edge
 * or wandering onto the copy — and never for spacing.
 *
 * `SceneNode.scale` varies 0.75–1.25, so a projection that assumes 1.0 is wrong
 * by a quarter in both directions.
 */
function inflate(screen: ScreenPoint, scale: number): ScreenPoint {
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  return {
    ...screen,
    radiusY: screen.radiusY * scale + DRIFT_MARGIN / (screen.depth * tanHalf),
  };
}

/**
 * Where a node's card actually lands on screen, drift and scale included.
 *
 * The one function both the sampler and its tests use, so an assertion cannot
 * quietly measure something different from what placement enforced.
 */
export function cardFootprint(node: SceneNode, progress = LAYOUT_PROGRESS): ScreenPoint {
  return inflate(projectAtProgress(node.scattered, progress), node.scale);
}

/**
 * The card as actually drawn — no drift allowance.
 *
 * `radiusY` here is the card's height as a fraction of the viewport, which is
 * the number legibility is judged on: ~0.25 is the ~200px that keeps body copy
 * readable at the opening.
 */
export function cardDrawnSize(node: SceneNode, progress = LAYOUT_PROGRESS): ScreenPoint {
  return scaled(projectAtProgress(node.scattered, progress), node.scale);
}

/** Whether a card is wholly within the frame at the opening. */
export function isVisibleAtOpening(node: SceneNode): boolean {
  return framing(cardFootprint(node, LAYOUT_PROGRESS)) === "inside";
}

/** Places one card at an authored depth, sampling only where it sits on screen. */
function placeVisible(
  rand: () => number,
  placed: ScreenPoint[],
  scale: number,
  depth: number,
): Vec3 | null {
  // Bounded rather than a while(true): a sampler that cannot satisfy its
  // constraints must fail visibly at build time, not hang the module.
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const x = (rand() * 2 - 1) * 0.92;
    const y = (rand() * 2 - 1) * 0.92;
    const candidate = unprojectAtProgress(x, y, depth, LAYOUT_PROGRESS);

    // Clear of where the core ignites in scene 2.
    if (Math.hypot(...candidate) < CORE_CLEARANCE) continue;

    const raw = projectAtProgress(candidate, LAYOUT_PROGRESS);
    const footprint = inflate(raw, scale);
    const drawn = scaled(raw, scale);

    if (framing(footprint) !== "inside") continue;
    if (intersectsCopyZone(footprint)) continue;
    // Anything close to the camera must sit off the axis, or it fills the frame
    // and hides everything behind it.
    if (drawn.radiusY > 0.3 && Math.hypot(drawn.x, drawn.y) < NEAR_AXIS_CLEARANCE) continue;
    // Separation is measured on drawn size — see `scaled`.
    const crowded = placed.some(
      (other) => Math.hypot(other.x - drawn.x, other.y - drawn.y) < requiredGap(other, drawn),
    );
    if (crowded) continue;

    placed.push(drawn);
    return candidate;
  }
  return null;
}

/**
 * Places one document on the photographed desk.
 *
 * ## The rules are not the airborne field's rules
 *
 * The scattered field floats in open space, where a card sliced by any frame
 * edge reads as a rendering fault. Paper on a table is the opposite case: the
 * table continues toward the viewer, past the bottom of the shot, and so does
 * the paperwork. The near sheets in any real photograph of a desk are cropped.
 *
 * So this sampler enforces a different pair of rules:
 *
 *  - **Never past the table's far edge.** A card whose top rises above
 *    `PLATE_DESK_EDGE_NDC` is standing on the chair. This is the hard one, and
 *    it is checked against the *upright* footprint (see below).
 *  - **Freely past the bottom.** No lower-edge test at all. As the note on
 *    `DESK_NEAR_Z` sets out, no whole document fits in the visible band anyway,
 *    so forbidding this would place exactly zero documents.
 *
 * Left and right straddling is still rejected — the table runs the full width of
 * the plate, but a sheet half-cut by the side of the *viewport* has no such
 * excuse, and there is ample room in x without it.
 */
function placeOnDesk(rand: () => number, placed: ScreenPoint[], scale: number): Vec3 | null {
  const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

  // Two passes. The first tries to seat the document on the visible tabletop
  // under the spacing rule; the second, once that is full, puts it off to the
  // sides where it is simply out of shot. A table does not stop at the viewport.
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const crowdedPass = attempt < 650;

    // Sampled across the *visible* surface rather than a fixed world box: the
    // desk recedes, so a box in world x covers a shrinking slice of frame as it
    // goes back and piles everything into the foreground.
    const z = DESK_NEAR_Z - rand() * (DESK_NEAR_Z - DESK_FAR_Z);
    const probe = projectAtProgress([0, CARD_REST_Y, z], 0);
    if (probe.depth <= 2) continue;
    const halfWidth = probe.depth * tanHalf * COMPOSE_ASPECT;

    // Once the visible surface is full, remaining documents go off to the
    // sides. Sideways rather than further back: further back is now the table's
    // own edge, and anything crossing it lands on the chair.
    const x = crowdedPass
      ? (rand() * 2 - 1) * halfWidth * 0.95
      : (rand() < 0.5 ? -1 : 1) * halfWidth * (1.5 + rand() * 0.8);

    const candidate: Vec3 = [x, CARD_REST_Y, z];
    const raw = projectAtProgress(candidate, 0);
    if (raw.depth <= 2) continue;

    /**
     * Foreshortening applies to SPACING only, not to framing.
     *
     * A card lying flat presents ~42% of its height to this camera — but its
     * full width. `framing` derives the horizontal half-extent from `radiusY`,
     * so handing it a flattened radius under-reports the width by more than half
     * and documents get sliced by the left and right frame edges. Framing
     * therefore uses the upright (conservative) footprint, and only the
     * neighbour test uses the flattened one.
     */
    const footprint = inflate(raw, scale);
    const drawn = scaled({ ...raw, radiusY: raw.radiusY * DESK_FORESHORTEN }, scale);

    // Side edges only. `framing` also tests the top and bottom of frame, which
    // is precisely what must not apply here, so the horizontal half of it is
    // reproduced rather than reused.
    const xAtNarrow = Math.abs(footprint.x) * (COMPOSE_ASPECT / NARROW_ASPECT);
    const rxAtNarrow = footprint.radiusY / NARROW_ASPECT;
    const xAtWide = Math.abs(footprint.x) * (COMPOSE_ASPECT / WIDE_ASPECT);
    const rxAtWide = footprint.radiusY / WIDE_ASPECT;
    const clearOfSides = xAtNarrow + rxAtNarrow < 0.98;
    const wellOutside = xAtWide - rxAtWide > 1.06;
    if (!clearOfSides && !wellOutside) continue;

    if (clearOfSides) {
      if (!crowdedPass) continue;
      // The table's far edge. Measured on the drawn (foreshortened) footprint
      // because that is what is actually painted — the upright inflation would
      // reject the entire band.
      if (drawn.y + drawn.radiusY > PLATE_DESK_EDGE_NDC) continue;
      // Kept for the day the copy block moves. At the plate's framing the hero
      // bottoms out at NDC -0.18 and the tabletop starts at -0.75, so the two
      // cannot currently touch.
      if (intersectsHeroZone(footprint)) continue;
      // Papers on a desk overlap, and that is what makes it read as a desk in
      // use rather than as a filing system. The gap is a fraction of the
      // airborne rule on purpose.
      const crowded = placed.some(
        (other) =>
          Math.hypot(other.x - drawn.x, other.y - drawn.y) <
          requiredGap(other, drawn) * DESK_OVERLAP,
      );
      if (crowded) continue;
      placed.push(drawn);
    }

    return candidate;
  }
  return null;
}

/** Places one card deliberately outside the opening frame. */
function placeOffscreen(rand: () => number, scale: number, depth: number): Vec3 | null {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    // Beyond the frame on one axis, anywhere on the other. Horizontal exits
    // have to reach further than vertical ones: clearing the frame sideways is
    // judged at WIDE_ASPECT, where a card needs roughly 1.5 in composed-NDC
    // before it is genuinely gone.
    const along = (rand() * 2 - 1) * 1.5;
    const horizontal = rand() < 0.62;
    const sign = rand() < 0.5 ? -1 : 1;
    const x = horizontal ? sign * (1.55 + rand() * 1.05) : along;
    const y = horizontal ? along : sign * (1.2 + rand() * 0.7);

    const candidate = unprojectAtProgress(x, y, depth, LAYOUT_PROGRESS);
    if (Math.hypot(...candidate) < CORE_CLEARANCE) continue;

    const footprint = inflate(projectAtProgress(candidate, LAYOUT_PROGRESS), scale);
    if (framing(footprint) !== "outside") continue;

    return candidate;
  }
  return null;
}

/**
 * Which documents get the readable near slots.
 *
 * Not left to the shuffle. These two are the thread scene 3 follows all the way
 * to the approval hold, so the opening has to have already introduced them —
 * the invoice that arrives and the gate it will stop at. Everything else can
 * fall where the seed puts it.
 */
const PINNED_DEPTHS: Readonly<Record<string, number>> = {
  vendor_invoice: 19,
  finance_approval: 22,
};

/** Deterministic Fisher–Yates, so cluster kinds mix across the depth bands
 *  instead of arriving in roster order (all three people cards up front). */
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildNodes(seed: number): readonly SceneNode[] {
  const rand = mulberry32(seed);
  /**
   * The desk gets its own stream, and that is not a detail.
   *
   * Both samplers draw from the PRNG inside one loop, so with a single stream
   * the *number of attempts* the desk takes shifts every subsequent airborne
   * draw. Retuning the desk camera by two units therefore moved the airborne
   * field and made a pinned card unplaceable — a change in one composition
   * silently breaking the other. Two streams keep them independent.
   */
  const randDesk = mulberry32(seed ^ 0x9e3779b9);
  const placed: ScreenPoint[] = [];

  const pinnedIds = Object.keys(PINNED_DEPTHS);
  const free = ROSTER.filter((entry) => !pinnedIds.includes(entry.id)).map((entry) => entry.id);
  // Remaining slots, minus the ones the pinned cards consumed.
  const remaining = [
    ...DEPTH_SCHEDULE.filter((d) => !Object.values(PINNED_DEPTHS).includes(d)).map((depth) => ({
      depth,
      visible: true,
    })),
    ...OFFSCREEN_DEPTHS.map((depth) => ({ depth, visible: false })),
  ];
  if (remaining.length !== free.length) {
    throw new Error(
      `Depth schedule holds ${remaining.length} slots for ${free.length} unpinned documents — ` +
        "DEPTH_SCHEDULE and OFFSCREEN_DEPTHS must together cover the roster.",
    );
  }

  const deskPlaced: ScreenPoint[] = [];
  const order = shuffled(remaining, rand);
  const slotFor = new Map<string, { depth: number; visible: boolean }>();
  free.forEach((id, i) => slotFor.set(id, order[i]));
  for (const [id, depth] of Object.entries(PINNED_DEPTHS)) {
    slotFor.set(id, { depth, visible: true });
  }

  // Near cards first, so they claim their space before the mid and far ones
  // fill in around them. Placing in roster order let a distant card sit exactly
  // where a readable one needed to be.
  const byDepth = [...ROSTER].sort((a, b) => slotFor.get(a.id)!.depth - slotFor.get(b.id)!.depth);
  const scattered = new Map<string, Vec3>();
  const desks = new Map<string, Vec3>();
  const scales = new Map<string, number>();

  for (const entry of byDepth) {
    const slot = slotFor.get(entry.id)!;
    // Near cards are held closer to their nominal size: a 0.75 scale on the one
    // card meant to be readable throws away the whole point of the slot.
    const scale = slot.depth <= 22 ? 0.94 + rand() * 0.16 : 0.78 + rand() * 0.44;
    const position = slot.visible
      ? placeVisible(rand, placed, scale, slot.depth)
      : placeOffscreen(rand, scale, slot.depth);

    if (!position) {
      throw new Error(
        `Could not place "${entry.id}" at depth ${slot.depth} after 800 attempts — ` +
          "the frame is too crowded for this depth schedule.",
      );
    }
    scattered.set(entry.id, position);
    scales.set(entry.id, scale);

    const onDesk = placeOnDesk(randDesk, deskPlaced, scale);
    if (!onDesk) {
      throw new Error(
        `Could not place "${entry.id}" on the desk after 800 attempts — ` +
          "the surface is too small or the copy zone too wide for this roster.",
      );
    }
    desks.set(entry.id, onDesk);
  }

  // Ring index within each cluster, assigned in roster order so the arrangement
  // is stable and every member gets its own seat.
  const clusterMembers = new Map<ClusterId, string[]>();
  for (const entry of ROSTER) {
    const members = clusterMembers.get(entry.cluster) ?? [];
    members.push(entry.id);
    clusterMembers.set(entry.cluster, members);
  }

  return ROSTER.map((entry) => {
    const scale = scales.get(entry.id)!;
    const sampled = scattered.get(entry.id)!;

    // Home: a seat on the cluster's ring. See `clusterRadius` for why this is
    // a ring and not a jittered cloud.
    const centre = CLUSTER_CENTERS[entry.cluster];
    const members = clusterMembers.get(entry.cluster)!;
    const seat = members.indexOf(entry.id);
    const radius = clusterRadius(members.length);
    // Offset per cluster so the four rings are not four identical clock faces.
    const angle = (seat / members.length) * Math.PI * 2 + entry.cluster.length * 0.7;
    const home: Vec3 = [
      centre[0] + Math.cos(angle) * radius,
      centre[1] + Math.sin(angle) * radius * CLUSTER_RING_SQUASH,
      centre[2] + (rand() - 0.5) * 5,
    ];

    return {
      ...entry,
      desk: desks.get(entry.id)!,
      scattered: sampled,
      home,
      phase: rand() * Math.PI * 2,
      scale,
    };
  });
}

export const SCENE_NODES: readonly SceneNode[] = Object.freeze(buildNodes(LAYOUT_SEED));

/* -------------------------------------------------------------------------- */
/* Where a card actually is, at a given moment                                */
/* -------------------------------------------------------------------------- */

/**
 * The live position of one card: its scattered→home migration plus its drift.
 *
 * Pure, and deliberately shared. `document-field.tsx` computes card transforms
 * and `connection-edges.tsx` has to attach edge endpoints to those same cards —
 * two copies of this arithmetic would drift apart the first time an amplitude
 * was retuned, and the symptom would be edges detached from the documents they
 * claim to connect. `DRIFT_MARGIN` budgets screen space for exactly the
 * excursion below, so all three move together or none of them do.
 */
/**
 * How far the documents have lifted off the desk, 0–1.
 *
 * Eased rather than linear, and deliberately slow to start: paper that leaps off
 * a desk the instant you scroll reads as an animation being triggered. It should
 * look like the desk is being left behind.
 */
export function deskLiftAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 1;
  return smoothstep(Math.min(Math.max(progress / LIFTOFF_END, 0), 1));
}

/**
 * How present the desk surface itself is, 0–1.
 *
 * Fades a little ahead of the documents finishing their climb, so the surface is
 * gone before the field settles — otherwise a large pale plane hangs in the
 * bottom of frame through scene 2 looking like a rendering artefact.
 */
export function deskPresenceAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  // Holds fully solid for the first half of the liftoff, then dissolves quickly.
  // A long slow alpha fade on a solid wooden desk spends most of the transition
  // showing a half-transparent object, which never looks like anything real —
  // and by the time it starts here the camera has already begun to climb, so
  // the desk is leaving frame anyway.
  const hold = 0.55;
  const t = Math.min(Math.max(progress / LIFTOFF_END, 0), 1);
  return 1 - smoothstep(Math.min(Math.max((t - hold) / (1 - hold), 0), 1));
}

/* -------------------------------------------------------------------------- */
/* The plate's exit — a camera leaving a room, not a room evaporating         */
/* -------------------------------------------------------------------------- */

/**
 * How present the photographed room is, 0–1.
 *
 * Shares `deskPresenceAtProgress`'s hold-then-fall shape, and for the same
 * reason: a long slow alpha fade spends most of its duration showing a
 * half-transparent thing, which never looks like anything real. The room holds
 * whole while the paper climbs, then goes quickly.
 */
export function platePresenceAtProgress(progress: number): number {
  return deskPresenceAtProgress(progress);
}

/**
 * The rack focus, 0 (sharp) → 1 (defocused).
 *
 * ## Why the room defocuses instead of simply fading
 *
 * A photograph that cross-fades to a flat gradient tells the visitor the room
 * was a picture, which is the one thing this opening must not do. Pulling focus
 * and drifting forward is what a camera does when it stops attending to
 * something, so the room reads as being *left*, not deleted.
 *
 * It runs **ahead** of the opacity fade — focus goes first, then the room goes —
 * because the reverse order shows a sharp image dissolving, which reads as a
 * dissolve. It also, conveniently, hides the plate's modest resolution exactly
 * when it starts being scaled up.
 */
export function plateDefocusAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 1;
  const t = Math.min(Math.max(progress / LIFTOFF_END, 0), 1);
  return smoothstep(Math.min(t / 0.72, 1));
}

/**
 * The slow push-in, 1 → 1.06.
 *
 * Small on purpose. Enough that the frame is alive and the move reads as a
 * camera, not so much that the upscale becomes obvious or that the papers
 * visibly slide against the tabletop while it happens.
 */
export function plateScaleAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 1.06;
  const t = Math.min(Math.max(progress / LIFTOFF_END, 0), 1);
  return 1 + 0.06 * smoothstep(t);
}

/**
 * How warm the key light is, 1 (matching the plate) → 0 (neutral white).
 *
 * ## A deliberate, bounded divergence from a settled rule
 *
 * `apps/web/CLAUDE.md` records "the lights were the beige, not the palette" as a
 * hard-won conclusion, and it was right: a warm key multiplying a near-white 3D
 * room turned the whole section beige while every hex value in the source said
 * neutral.
 *
 * That diagnosis does not transfer to a photographed room. The plate is
 * genuinely warm — its tabletop samples at #c0956e — and the only surfaces the
 * key light touches are the paper cards. Lighting white paper with pure white
 * light inside a warm room is the classic composite tell: the paper reads as
 * having been pasted on, because it is the one object in frame not sharing the
 * room's light.
 *
 * The warmth is therefore tied to the plate's own lifetime and reaches exactly
 * zero at `LIFTOFF_END`. Scenes 2, 3 and 4 are lit precisely as neutrally as
 * they were before. **If the room ever looks warm past the liftoff, this
 * function is the first place to look** — but the rule it appears to break is
 * still in force everywhere it was ever about.
 */
export function keyLightWarmthAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const t = Math.min(Math.max(progress / LIFTOFF_END, 0), 1);
  return 1 - smoothstep(t);
}

/**
 * How much of the pointer parallax is allowed, 0–1.
 *
 * ## The papers would otherwise slide across the photograph
 *
 * `CameraRig` sways the camera by up to 2.6 world units with the pointer. At the
 * tabletop that is ~9.4% of the frame's width — so with a fixed plate behind
 * them, the documents would visibly skate across a stationary tabletop on every
 * mouse move. A photograph is a fixed viewpoint and cannot parallax with them.
 *
 * A small residual is kept rather than freezing the frame outright: at 0.15 the
 * excursion is ~1.4% of frame width, which the plate covers by being scaled
 * 1.04 and translated to match (see `room-plate.tsx`), so nothing is ever
 * revealed at its edges. Full sway returns as the room leaves.
 */
export function swayScaleAtProgress(progress: number): number {
  const present = platePresenceAtProgress(progress);
  return 1 - present * 0.85;
}

/** Fraction of the camera's sway the plate must be translated by to keep the
 *  documents welded to the tabletop. Paired with the 1.04 scale-up in
 *  `room-plate.tsx`, which is what gives it material to move within. */
export const PLATE_PARALLAX_SCALE = 0.15;

/**
 * How visible the scene's own caption is, 0–1.
 *
 * Zero while the page's hero copy is on screen. The scene opens *as* the hero
 * now, so for the first stretch of scroll the headline is doing the talking;
 * the scene's captions arrive as the documents leave the desk. Two competing
 * blocks of copy on one screen is one too many.
 */
export function sceneCaptionOpacityAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  // Starts exactly where the hero copy finishes fading and completes at
  // LIFTOFF_END, so the handover is a single clean crossfade rather than a
  // stretch where both blocks of copy are on screen at once.
  return smoothstep((progress - HERO_HANDOVER) / (LIFTOFF_END - HERO_HANDOVER));
}

/** Progress at which the hero copy has fully given way to the scene. */
const HERO_HANDOVER = LIFTOFF_END * 0.7;

/**
 * How present the page's hero copy is, 0–1.
 *
 * The hero scrolls away on its own — it sits in the first viewport of the
 * scroll container while the canvas behind it is sticky — but scrolling alone
 * is not enough: a full viewport of travel means the headline is still on
 * screen when the scene's own caption arrives, and the page briefly carries two
 * competing blocks of copy. Fading it out over the same handover point fixes
 * that without any scroll listener.
 */
export function heroOpacityAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 1;
  return 1 - smoothstep(progress / HERO_HANDOVER);
}

/** A document lying flat on the desk, face up, with its own small yaw. */
export function deskRotationFor(node: SceneNode): Vec3 {
  // X tips the card face-up; Z is then its yaw on the desk surface, because the
  // card's normal was +Z before the tip. Papers on a real desk are never square
  // to the edge, and a grid of perfectly aligned documents reads as a UI.
  return [-Math.PI / 2, 0, (node.phase - Math.PI) * 0.14];
}

export function cardPositionAt(
  node: SceneNode,
  settle: number,
  time: number,
  /** Scrub progress, so the run's documents can step onto their scene-3 stage.
   *  Omitted (or negative) means "no staging" — used by the layout and tests,
   *  which only ever care about the scattered and settled arrangements. */
  progress = -1,
): Vec3 {
  const damp = 1 - settle * 0.85;
  const [sx, sy, sz] = node.scattered;
  const [hx, hy, hz] = node.home;
  const drift: Vec3 = [
    Math.sin(time * 0.26 + node.phase) * 0.45 * damp,
    Math.cos(time * 0.21 + node.phase * 1.4) * 0.38 * damp,
    Math.sin(time * 0.18 + node.phase * 0.7) * 0.4 * damp,
  ];

  const base: Vec3 = [
    sx + (hx - sx) * settle,
    sy + (hy - sy) * settle,
    sz + (hz - sz) * settle,
  ];

  // The desk. Before liftoff the card is on the surface; the drift is scaled in
  // with the lift so paper does not bob while it is still lying on a table.
  const lift = progress >= 0 ? deskLiftAtProgress(progress) : 1;
  if (lift < 1) {
    const [dx, dy, dz] = node.desk;
    // Rises before it travels, so documents leave the surface rather than
    // sliding off the edge of it.
    const climb = smoothstep(Math.min(lift * 1.35, 1));
    return [
      dx + (base[0] - dx) * climb + drift[0] * lift,
      dy + (base[1] - dy) * smoothstep(Math.min(lift * 1.7, 1)) + drift[1] * lift,
      dz + (base[2] - dz) * climb + drift[2] * lift,
    ];
  }

  // Scene 3 pulls the run's own documents onto a staged row. Everything else,
  // and every other moment, is untouched by this.
  const stage = progress >= 0 ? runStagePosition(node.id) : null;
  const blend = stage ? runStageBlendAtProgress(progress) : 0;
  const placed: Vec3 =
    stage && blend > 0
      ? [
          base[0] + (stage[0] - base[0]) * blend + drift[0] * (1 - blend),
          base[1] + (stage[1] - base[1]) * blend + drift[1] * (1 - blend),
          base[2] + (stage[2] - base[2]) * blend + drift[2] * (1 - blend),
        ]
      : [base[0] + drift[0], base[1] + drift[1], base[2] + drift[2]];

  // Scene 4's ending: every document falls into the node of the mark it
  // belongs to. Applied last, so it overrides both the settled arrangement and
  // the run stage.
  const collapse = progress >= 0 ? markCollapseAtProgress(progress) : 0;
  if (collapse <= 0) return placed;

  const target = markTargetFor(node);
  return [
    placed[0] + (target[0] - placed[0]) * collapse,
    placed[1] + (target[1] - placed[1]) * collapse,
    placed[2] + (target[2] - placed[2]) * collapse,
  ];
}

/** The card's tilt at a given moment. Small, and never enough to turn the text
 *  away from the reader — a document you cannot read is the abstract shape it
 *  replaced. */
export function cardRotationAt(node: SceneNode, time: number, progress = -1): Vec3 {
  const airborne: Vec3 = [
    Math.sin(time * 0.22 + node.phase) * 0.14,
    Math.sin(time * 0.17 + node.phase * 1.3) * 0.28,
    Math.sin(time * 0.13 + node.phase * 0.8) * 0.06,
  ];

  const lift = progress >= 0 ? deskLiftAtProgress(progress) : 1;
  if (lift >= 1) return airborne;

  // Flat on the desk, turning to face the reader as it rises. The turn trails
  // the climb slightly so a document is clearly *off* the desk before it starts
  // rotating — otherwise it looks like it pivots through the surface.
  const turn = smoothstep(Math.min(Math.max((lift - 0.15) / 0.85, 0), 1));
  const flat = deskRotationFor(node);
  return [
    flat[0] + (airborne[0] - flat[0]) * turn,
    flat[1] + (airborne[1] - flat[1]) * turn,
    flat[2] + (airborne[2] - flat[2]) * turn,
  ];
}

/* -------------------------------------------------------------------------- */
/* Edges — the connections scene 2 resolves                                   */
/* -------------------------------------------------------------------------- */

/** Endpoint id standing for the reasoning core rather than a document. */
export const CORE_ENDPOINT = "core";

export interface SceneEdge {
  from: string;
  to: string;
  /**
   * `chain` edges are the real document trail one company's paperwork makes —
   * a purchase order becomes a goods receipt becomes an invoice becomes a
   * journal entry. `reasoning` edges are the core's: they are what the product
   * adds, and they are the ones that did not exist before scene 2.
   */
  kind: "chain" | "reasoning";
}

/**
 * What connects to what, and why these connections and not others.
 *
 * The chain edges are **not decorative**. They trace the same thread
 * `document-cards.ts` pins and `run-film.ts` dramatises:
 *
 *   supplier → PO-4471 → GR-2214 → INV-2291 → finance approval → JE-99120
 *
 * so by the time scene 3 follows that invoice, the viewer has already been
 * shown the trail it travels. The HR thread mirrors it at smaller scale
 * (employee → leave request → manager approval) so the scene's claim to cover
 * HR *and* finance is visible rather than asserted in copy.
 *
 * Reasoning edges all touch the core, and every cluster has exactly one, which
 * is the argument: one layer sits between the systems, not four integrations.
 */
export const SCENE_EDGES: readonly SceneEdge[] = [
  // The finance/ERP document trail.
  { from: "supplier", to: "purchase_order", kind: "chain" },
  { from: "purchase_order", to: "goods_receipt", kind: "chain" },
  { from: "goods_receipt", to: "vendor_invoice", kind: "chain" },
  { from: "vendor_invoice", to: "finance_approval", kind: "chain" },
  { from: "finance_approval", to: "journal_entry", kind: "chain" },
  { from: "journal_entry", to: "payment_run", kind: "chain" },
  { from: "purchase_order", to: "inventory_move", kind: "chain" },
  { from: "contract_pdf", to: "supplier", kind: "chain" },
  { from: "expense_claim", to: "payment_run", kind: "chain" },
  { from: "receivable", to: "journal_entry", kind: "chain" },

  // The HR trail, deliberately the same shape: a record, a request, a gate.
  { from: "employee_record", to: "leave_request", kind: "chain" },
  { from: "leave_request", to: "manager_approval", kind: "chain" },
  { from: "employee_record", to: "attendance", kind: "chain" },
  { from: "attendance", to: "payroll_run", kind: "chain" },
  { from: "salary_change", to: "payroll_run", kind: "chain" },
  { from: "payroll_run", to: "journal_entry", kind: "chain" },
  { from: "new_hire", to: "recruitment", kind: "chain" },
  { from: "contractor", to: "expense_claim", kind: "chain" },

  // What the product adds: one reasoning layer touching every cluster.
  { from: CORE_ENDPOINT, to: "vendor_invoice", kind: "reasoning" },
  { from: CORE_ENDPOINT, to: "finance_approval", kind: "reasoning" },
  { from: CORE_ENDPOINT, to: "purchase_order", kind: "reasoning" },
  { from: CORE_ENDPOINT, to: "payroll_run", kind: "reasoning" },
  { from: CORE_ENDPOINT, to: "manager_approval", kind: "reasoning" },
  { from: CORE_ENDPOINT, to: "employee_record", kind: "reasoning" },
] as const;

/**
 * How far one edge has drawn itself in, 0–1.
 *
 * Edges resolve across scene 2 in a stagger rather than all at once: twenty-odd
 * lines appearing on the same frame reads as a diagram being switched on, and
 * the scene is arguing that the connections were always latent in the work.
 * Chain edges go first and the core's reasoning edges follow, so the order on
 * screen is "this paperwork was always related" and *then* "and here is what
 * noticed".
 */
export function edgeRevealAtProgress(
  progress: number,
  index: number,
  edges: readonly SceneEdge[] = SCENE_EDGES,
): number {
  if (!Number.isFinite(progress) || edges.length === 0) return 0;
  const edge = edges[Math.min(Math.max(index, 0), edges.length - 1)];

  // Reasoning edges occupy the back half of the scene, chain edges the front.
  // The reasoning band closes exactly on the scene-2 boundary. Overrunning it
  // even slightly means an edge is still growing while scene 3 has begun and
  // the camera has already moved on to the run.
  const band = edge.kind === "chain" ? [0.28, 0.44] : [0.4, SCENES[1].end];
  const peers = edges.filter((e) => e.kind === edge.kind);
  const rank = peers.indexOf(edge);
  const stagger = peers.length <= 1 ? 0 : rank / (peers.length - 1);

  // Each edge takes a fixed slice of its band, offset by its rank. The slice is
  // wider than the gap between ranks, so several are always drawing at once and
  // the field resolves as a wave rather than as a queue.
  const span = band[1] - band[0];
  const draw = span * 0.45;
  const start = band[0] + stagger * (span - draw);
  return smoothstep((progress - start) / draw);
}

/* -------------------------------------------------------------------------- */
/* Scene 3 — one real run, and the hold                                       */
/* -------------------------------------------------------------------------- */

/**
 * Scene 3 is `run-film.ts`'s beat list, in three dimensions.
 *
 * The film is **not** being reimplemented here. `FILM_BEATS` stays the single
 * script for this run, and this module only maps it onto scroll and onto the
 * documents in the room. That is the whole reason `run-film.ts` was kept rather
 * than deleted when the 3D scene replaced the 2D film: its beats are already
 * tested, already honest about what the product does, and already pin the one
 * invariant this scene exists to show.
 *
 * The mapping from beat to document is the only new information:
 */
const BEAT_FOCUS: Readonly<Record<string, string>> = {
  trigger: "vendor_invoice",
  "agent-thinking": "vendor_invoice",
  "agent-output": "vendor_invoice",
  condition: "vendor_invoice",
  approval: "finance_approval",
  tool: "journal_entry",
  complete: "journal_entry",
};

/** Which beat of the run is showing at a given scrub progress. */
export function runBeatIndexAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const scene = SCENES[2];
  const local = Math.min(
    Math.max((progress - scene.start) / (scene.end - scene.start), 0),
    1,
  );
  return Math.min(Math.floor(local * FILM_BEATS.length), FILM_BEATS.length - 1);
}

/** The beat itself, for captions and for the node states below. */
export function runBeatAtProgress(progress: number): FilmBeat {
  return FILM_BEATS[runBeatIndexAtProgress(progress)];
}

/**
 * Which document the camera and the highlight are on — **during the run only**.
 *
 * Returns `null` everywhere outside scene 3, and that is load-bearing rather
 * than tidy. `runBeatIndexAtProgress` clamps, so at progress 0 it reports beat
 * 0, whose focus is `vendor_invoice` — which meant the run scene's "lift toward
 * the camera and square up to it" was being applied to the invoice **while it
 * was lying on the desk in the opening frame**. It stood the card upright,
 * halfway into the desk, and it looked like a rendering fault. Nothing is
 * focused until the run is actually playing.
 */
export function focusedDocumentAtProgress(progress: number): string | null {
  if (!Number.isFinite(progress)) return null;
  const scene = SCENES[2];
  if (progress < scene.start || progress > scene.end) return null;
  return BEAT_FOCUS[runBeatAtProgress(progress).id] ?? null;
}

/**
 * Whether the ERP has been written to yet — **the load-bearing fact.**
 *
 * `run-film.ts` pins that on the approval beat `approval_1` is `waiting` while
 * `post_to_erp` is still `pending`. In the 2D film that was a badge on a rail.
 * Here it has to be something you can *see*, so it drives whether the journal
 * entry card renders as a finished document or as an unwritten page: at the
 * hold, JE-99120 has no debit, no credit and no period on it, because nothing
 * has been posted. When the gate clears, the figures appear.
 *
 * Derived from the beat states rather than from a progress threshold, so it
 * cannot drift out of agreement with the film's own tests.
 */
export function erpWrittenAtProgress(progress: number): boolean {
  const states = nodeStatesAtBeat(runBeatIndexAtProgress(progress));
  return states.post_to_erp === "succeeded";
}

/** Whether the run is currently held at the human-approval gate. */
export function heldAtGateAtProgress(progress: number): boolean {
  return runBeatAtProgress(progress).runStatus === "waiting_approval";
}

/**
 * The documents this run actually touches, in order.
 *
 * Everything else in the room recedes while scene 3 plays. That is the scene's
 * own claim — *one* real run — and it is also what makes the frame legible: the
 * first version of the hold had eleven unrelated cards in shot and the copy
 * running straight across an invoice. A scene that says "here is one run"
 * should not be showing you the whole company at the same time.
 */
export const RUN_CHAIN: readonly string[] = [
  "purchase_order",
  "goods_receipt",
  "vendor_invoice",
  "finance_approval",
  "journal_entry",
] as const;

/** Lowest opacity a receded document falls to. Not zero: the run happens
 *  *inside* a company, and emptying the room would lose that. */
const RECEDED_OPACITY = 0.14;

/**
 * Where the run's documents stand while scene 3 plays, relative to the finance
 * cluster's centre.
 *
 * The run gathers its own paperwork onto a stage instead of being filmed where
 * it happens to have settled. Left to their ring seats the five documents sat
 * at whatever angle the cluster geometry produced — the invoice landed behind
 * the caption, and the trail read in no particular order.
 *
 * Laid out left to right in execution order, so the shot is legible as a
 * sequence: PO → goods receipt → invoice → the gate → the ledger. Raised above
 * the centre line because the copy occupies the bottom third of the frame; at
 * this camera distance that puts every card comfortably clear of the words.
 */
const RUN_STAGE: Readonly<Record<string, Vec3>> = {
  purchase_order: [-11.4, 2.6, -1.4],
  goods_receipt: [-5.7, 2.6, -0.4],
  vendor_invoice: [0, 2.6, 0.6],
  finance_approval: [5.7, 2.6, -0.4],
  journal_entry: [11.4, 2.6, -1.4],
};

/**
 * How far the run's documents have moved onto the stage, 0–1.
 *
 * Shares the fade band with `documentPresenceAtProgress` so the room receding
 * and the run stepping forward are one movement rather than two.
 */
export function runStageBlendAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const scene = SCENES[2];
  const fade = 0.04;
  const rising = smoothstep((progress - scene.start) / fade);
  const falling = 1 - smoothstep((progress - (scene.end - fade)) / fade);
  return Math.min(rising, falling);
}

/** The staged position for a run document, in world space. */
export function runStagePosition(nodeId: string): Vec3 | null {
  const offset = RUN_STAGE[nodeId];
  if (!offset) return null;
  const finance = CLUSTER_CENTERS.finance;
  return [finance[0] + offset[0], finance[1] + offset[1], finance[2] + offset[2]];
}

/**
 * How present a document is at a given progress, 0–1.
 *
 * 1 everywhere outside scene 3. Inside it, the run's own documents stay at 1
 * and everything else falls back, easing in and out at the scene edges so the
 * change reads as attention moving rather than as a layer being switched off.
 */
export function documentPresenceAtProgress(nodeId: string, progress: number): number {
  if (!Number.isFinite(progress)) return 1;

  // The run's own documents never recede *during the run* — but they are still
  // absorbed by the collapse at the end like everything else, so this is not an
  // early return. Making it one left the five chain documents hanging in the
  // final frame at full opacity, on top of the mark.
  let duringRun = 1;
  if (!RUN_CHAIN.includes(nodeId)) {
    const scene = SCENES[2];
    const fade = 0.04;
    const rising = smoothstep((progress - scene.start) / fade);
    const falling = 1 - smoothstep((progress - (scene.end - fade)) / fade);
    const recede = Math.min(rising, falling);
    duringRun = 1 - recede * (1 - RECEDED_OPACITY);
  }
  // Everything goes with the collapse. The mark is the last frame and it has
  // to be clean — a document still hanging in shot reads as one that failed to
  // arrive rather than as part of the ending.
  return duringRun * (1 - markCollapseAtProgress(progress));
}

/**
 * How present the core is on screen, as opposed to how ignited it is.
 *
 * `coreIntensityAtProgress` is the *ignition* curve and never dims once lit —
 * that is a property worth keeping, because the core does not stop reasoning.
 * What happens at the end is that it, like everything else, is absorbed into
 * the mark. Keeping the two separate means the ending cannot be mistaken for
 * the core shutting down.
 */
export function coreVisibilityAtProgress(progress: number): number {
  return coreIntensityAtProgress(progress) * (1 - markCollapseAtProgress(progress));
}

/* -------------------------------------------------------------------------- */
/* Scene 4 — the clusters, and the collapse into the mark                     */
/* -------------------------------------------------------------------------- */

/** Display names for the clusters, shown once the camera pulls back. */
export const CLUSTER_LABELS: Readonly<Record<ClusterId, string>> = {
  erp: "ERP",
  finance: "Finance",
  hr: "HR",
  people: "People",
};

/** How visible the cluster names are, 0–1. They arrive with the pull-back and
 *  leave before the collapse, so they never fight the mark for attention. */
export function clusterLabelOpacityAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const inFade = smoothstep((progress - 0.83) / 0.05);
  const outFade = 1 - smoothstep((progress - 0.93) / 0.04);
  return Math.min(inFade, outFade);
}

/**
 * The Orkest mark, in world space.
 *
 * Geometry lifted from `components/marketing/orkest-mark.tsx`, whose viewBox is
 * 24×24: filled nodes at (5, 6.5) and (19, 17.5), and an **open ring** at
 * (12, 12). Converted here to a centred, Y-up world layout so the 3D ending and
 * the 24-pixel SVG in the nav are unmistakably the same drawing. If the SVG is
 * ever redrawn, these move with it — three unrelated versions of one mark is
 * exactly what `orkest-mark.tsx` warns against.
 */
const MARK_SCALE = 1.55;
function fromViewBox(x: number, y: number): Vec3 {
  return [(x - 12) * MARK_SCALE, -(y - 12) * MARK_SCALE, 0];
}

export interface MarkNode {
  position: Vec3;
  radius: number;
  /** The middle node is drawn as a ring, not a disc. */
  open: boolean;
}

export const MARK_NODES: readonly MarkNode[] = [
  { position: fromViewBox(5, 6.5), radius: 2.25 * MARK_SCALE, open: false },
  { position: fromViewBox(12, 12), radius: 3.25 * MARK_SCALE, open: true },
  { position: fromViewBox(19, 17.5), radius: 2.25 * MARK_SCALE, open: false },
] as const;

/** How far the graph has collapsed into the mark, 0–1. */
export function markCollapseAtProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return smoothstep((progress - 0.92) / 0.08);
}

/**
 * Which node of the mark a document collapses into.
 *
 * **Approval gates go to the open middle node**, and that is the whole point of
 * the ending rather than a detail of it. The mark's held-open centre *is* the
 * human-approval step — that is what `orkest-mark.tsx` says it means — so the
 * two approval requests in the room are exactly the documents that belong
 * there. Everything else falls to the node on its own side of the diagonal.
 */
export function markTargetFor(node: SceneNode): Vec3 {
  if (node.kind === "approval") return MARK_NODES[1].position;
  return node.cluster === "erp" || node.cluster === "hr"
    ? MARK_NODES[0].position
    : MARK_NODES[2].position;
}

/**
 * How far the field has migrated from scattered to clustered, 0–1.
 *
 * The migration deliberately runs across scenes 2 and 4 with a hold through
 * scene 3: while the camera is following one run, the rest of the world must
 * stay still, or the shot reads as busy and the approval hold loses its weight.
 */
export function settleAtProgress(progress: number): number {
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  // Scene 2 does most of the gathering — 0.8 rather than the 0.55 this first
  // held. At 0.55 the field was still more scattered than clustered when the
  // edges finished drawing, so scene 2 ended on a half-formed graph and its
  // closing line ("from events, to decisions, to actions") had nothing to
  // land on. Scene 4's job is the pull-back and the clusters being *named*,
  // not the gathering itself.
  // Scene 2 completes the gathering. This first stopped at 0.55 and left the
  // field more scattered than clustered exactly when the edges finished
  // drawing, so the scene closed on a half-formed graph with its own line
  // ("from events, to decisions, to actions") having nothing to land on.
  // Scene 4's job is the pull-back, the naming of the clusters and the
  // collapse into the mark — not the gathering, which is over by then.
  if (clamped <= 0.28) return 0;
  if (clamped < 0.52) return smoothstep((clamped - 0.28) / (0.52 - 0.28));
  return 1;
}
