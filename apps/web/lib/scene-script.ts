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
export const CAMERA_KEYS: readonly CameraKey[] = [
  { at: 0.0, position: [0, 3, 34], target: [0, 1, 0] },
  { at: 0.28, position: [0, 2, 27], target: [0, 0, 0] },
  { at: 0.52, position: [0, 1.5, 19], target: [0, 0, 0] },
  { at: 0.66, position: [6, 1, 13], target: [2, 0, 0] },
  { at: 0.82, position: [0, 3, 26], target: [0, 0, 0] },
  { at: 1.0, position: [0, 6, 60], target: [0, 0, 0] },
] as const;

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
const STUDIO_NEAR_TOP: Vec3 = [240, 238, 233];
const STUDIO_NEAR_BOTTOM: Vec3 = [226, 223, 216];
const STUDIO_FAR_TOP: Vec3 = [233, 230, 224];
const STUDIO_FAR_BOTTOM: Vec3 = [212, 208, 200];

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

export type ClusterId = "people" | "hr" | "finance" | "erp";

export interface SceneNode {
  id: string;
  kind: NodeKind;
  cluster: ClusterId;
  /** Rendered as a label when the node is near the camera or hovered. */
  label: string;
  /** Where it drifts in scene 1, before anything is connected. */
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

/** Where each cluster settles in scene 4, once the AI core is between them. */
export const CLUSTER_CENTERS: Readonly<Record<ClusterId, Vec3>> = {
  people: [0, -13, 4],
  hr: [-21, 7, -6],
  finance: [21, 5, -4],
  erp: [0, 15, -12],
};

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

function buildNodes(seed: number): readonly SceneNode[] {
  const rand = mulberry32(seed);

  return ROSTER.map((entry) => {
    // Scattered: a thick spherical shell around the origin. The inner radius
    // keeps the field clear of where the core ignites in scene 2; the outer one
    // keeps everything inside the camera's opening frustum.
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const radius = 13 + rand() * 16;
    const scattered: Vec3 = [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi) * 0.62, // squashed: a sphere reads as a ball, a
      radius * Math.sin(phi) * Math.sin(theta), // lens reads as a field
    ];

    // Home: a small jittered cloud around its cluster centre.
    const centre = CLUSTER_CENTERS[entry.cluster];
    const home: Vec3 = [
      centre[0] + (rand() - 0.5) * 9,
      centre[1] + (rand() - 0.5) * 6,
      centre[2] + (rand() - 0.5) * 9,
    ];

    return {
      ...entry,
      scattered,
      home,
      phase: rand() * Math.PI * 2,
      scale: 0.75 + rand() * 0.5,
    };
  });
}

export const SCENE_NODES: readonly SceneNode[] = Object.freeze(buildNodes(LAYOUT_SEED));

/**
 * How far the field has migrated from scattered to clustered, 0–1.
 *
 * The migration deliberately runs across scenes 2 and 4 with a hold through
 * scene 3: while the camera is following one run, the rest of the world must
 * stay still, or the shot reads as busy and the approval hold loses its weight.
 */
export function settleAtProgress(progress: number): number {
  const clamped = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  if (clamped <= 0.28) return 0;
  if (clamped < 0.52) return smoothstep((clamped - 0.28) / (0.52 - 0.28)) * 0.55;
  if (clamped < 0.82) return 0.55;
  return 0.55 + smoothstep((clamped - 0.82) / (1 - 0.82)) * 0.45;
}
