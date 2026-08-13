"use client";

import * as React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { ScrollTrigger } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { AiCore } from "@/components/marketing/scene/ai-core";
import { ClusterLabels } from "@/components/marketing/scene/cluster-labels";
import { ConnectionEdges } from "@/components/marketing/scene/connection-edges";
import { HeroCopy } from "@/components/marketing/hero-copy";
import { OfficeRoom } from "@/components/marketing/scene/office-room";
import { DocumentField } from "@/components/marketing/scene/document-field";
import { MarkCollapse } from "@/components/marketing/scene/mark-collapse";
import { FILM_BEATS, runStatusLabel } from "@/lib/run-film";
import {
  SCENES,
  backdropGradientAtProgress,
  cameraAtProgress,
  coreVisibilityAtProgress,
  heroOpacityAtProgress,
  runBeatIndexAtProgress,
  sceneCaptionOpacityAtProgress,
  sceneIndexAtProgress,
  settleAtProgress,
} from "@/lib/scene-script";

/** Index of the run scene in `SCENES`. */
const RUN_SCENE_INDEX = 2;

/**
 * Root of the 3D scene: a tall scroll container with a sticky WebGL stage.
 *
 * ## The scrub never enters React state
 *
 * Exactly the rule already established by `run-film.tsx`: one ScrollTrigger
 * scrubs 0→1, `onUpdate` writes the continuous progress into refs and straight
 * to the DOM, and `setState` is called **only** when the discrete scene index
 * changes. Putting a float that updates every scroll frame into state would
 * re-render the React tree — including the Canvas subtree — on every frame.
 *
 ## A daylight room, not a void
 *
 * The scene is lit like an overhead shot of a desk: warm studio grey, white
 * paper, near-black ink, one lime accent and amber only on approval gates.
 * Nothing is emissive. An earlier version opened on the marketing hero's sky
 * and descended into a near-black nebula with neon curtains; it was rejected
 * for looking like every other AI landing page and for saying nothing about
 * back-office software. Do not reintroduce a dark background, a coloured rim
 * light, or any self-lit surface — a glowing card stops reading as paper and
 * starts reading as a screen.
 *
 * ## Why the backdrop is CSS and the canvas is transparent
 *
 * The room is a two-stop CSS gradient rewritten on each tick, with the canvas
 * composited over it on a transparent clear. First paint is therefore a
 * gradient rather than a shader, which is what stops this section from becoming
 * the landing page's LCP element.
 *
 * ## No postprocessing pass
 *
 * `@react-three/postprocessing` is not a dependency. The scene is physically
 * lit rather than additive, so there is nothing for a bloom pass to do —
 * ACES tone mapping carries the highlights instead, for no bytes at all.
 *
 * ## Degradation
 *
 * No WebGL renders the backdrop and the copy alone, which is a complete (if
 * quiet) section. `prefers-reduced-motion` switches the canvas to
 * `frameloop="demand"` so it paints one composed still and never animates, and
 * no ScrollTrigger is created at all.
 */

/** Height of the scroll container, as a multiple of the viewport. Longer means
 *  a slower, more cinematic scrub; shorter means the visitor reaches the
 *  product sooner. This is the main pacing knob for the whole section. */
const SCROLL_VH = 420;

/** Where the scene sits when motion is reduced: mid-scene-2, the composed
 *  "everything is connected" frame rather than an empty opening one. */
const STILL_PROGRESS = 0.4;

/** Probed once per page load — creating a throwaway context on every render
 *  would be wasteful, and the answer cannot change. */
let webglSupport: boolean | null = null;

function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = Boolean(
      canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/** WebGL support never changes after load, so there is nothing to subscribe to. */
const subscribeNever = () => () => {};

interface RigProps {
  progressRef: React.RefObject<number>;
  pointerRef: React.RefObject<{ x: number; y: number }>;
  damped: boolean;
}

/**
 * Drives the camera from the scrub.
 *
 * The camera is damped toward its scripted position rather than snapped to it.
 * ScrollTrigger's scrub is already smooth, so this is not about removing jitter
 * — it is weight. An undamped camera tracks the wheel exactly and feels like a
 * slider; a damped one feels like a body being moved.
 */
function CameraRig({ progressRef, pointerRef, damped }: RigProps) {
  const { camera } = useThree();
  const current = React.useRef(new THREE.Vector3());
  const lookAt = React.useRef(new THREE.Vector3());
  const seeded = React.useRef(false);

  useFrame(() => {
    const progress = progressRef.current ?? 0;
    const { position, target } = cameraAtProgress(progress);
    const pointer = pointerRef.current ?? { x: 0, y: 0 };

    // Pointer parallax. Small and proportional to distance so it reads as the
    // scene having depth, never as the camera being yanked around.
    const sway = 2.6;
    const desired = new THREE.Vector3(
      position[0] + pointer.x * sway,
      position[1] + pointer.y * sway * 0.6,
      position[2],
    );
    const desiredTarget = new THREE.Vector3(target[0], target[1], target[2]);

    if (!seeded.current || !damped) {
      current.current.copy(desired);
      lookAt.current.copy(desiredTarget);
      seeded.current = true;
    } else {
      current.current.lerp(desired, 0.085);
      lookAt.current.lerp(desiredTarget, 0.12);
    }

    camera.position.copy(current.current);
    camera.lookAt(lookAt.current);
  });

  return null;
}

export function CoreScene() {
  const reducedMotion = usePrefersReducedMotion();

  const rootRef = React.useRef<HTMLDivElement>(null);
  const backdropRef = React.useRef<HTMLDivElement>(null);
  const captionRef = React.useRef<HTMLDivElement>(null);
  const heroRef = React.useRef<HTMLDivElement>(null);

  const progressRef = React.useRef(0);
  const settleRef = React.useRef(0);
  const coreRef = React.useRef(0);
  const pointerRef = React.useRef({ x: 0, y: 0 });

  const [sceneIndex, setSceneIndex] = React.useState(0);
  /** Beat index while scene 3 is playing; `null` everywhere else. */
  const [runBeat, setRunBeat] = React.useState<number | null>(null);

  // Same pessimistic-server-snapshot convention as `useMediaQuery`: `false`
  // during SSR and the first client render, then the real answer. The
  // no-WebGL branch is a complete section, so rendering it for one frame costs
  // nothing.
  const webgl = React.useSyncExternalStore(subscribeNever, hasWebGL, () => false);

  /**
   * The imperative half: refs and one DOM write, no React state.
   *
   * Split out from `applyProgress` so the reduced-motion path can compose its
   * single still frame without calling `setState` from inside an effect —
   * which cascades renders, and which `react-hooks/set-state-in-effect`
   * correctly rejects. The scene index for that path is derived during render
   * instead (see `activeIndex` below).
   */
  const applyImperative = React.useCallback((progress: number) => {
    progressRef.current = progress;
    if (heroRef.current) {
      const opacity = heroOpacityAtProgress(progress);
      heroRef.current.style.opacity = String(opacity);
      // Stops the faded hero's buttons from staying clickable over the scene.
      heroRef.current.style.visibility = opacity < 0.02 ? "hidden" : "visible";
    }
    if (captionRef.current) {
      // The hero owns the words while the room is still whole. Two competing
      // blocks of copy on one screen is one too many, so the scene's caption
      // only arrives once the documents are off the desk.
      captionRef.current.style.opacity = String(sceneCaptionOpacityAtProgress(progress));
    }
    settleRef.current = settleAtProgress(progress);
    coreRef.current = coreVisibilityAtProgress(progress);
    if (backdropRef.current) {
      backdropRef.current.style.background = backdropGradientAtProgress(progress);
    }
  }, []);

  /**
   * Writes one progress value everywhere it is consumed.
   *
   * The `setState` here is legitimate: it is called from ScrollTrigger's
   * `onUpdate` — a callback from an external system — and only fires when the
   * discrete scene index actually changes, never on every scrub frame.
   */
  const applyProgress = React.useCallback(
    (progress: number) => {
      applyImperative(progress);
      // Scene 3 swaps copy on every *beat*, not just on the scene change, so
      // the caption tracks the run rather than sitting on one sentence for a
      // third of the page. Still discrete — this fires seven times across the
      // scene, not once per scroll frame.
      setRunBeat((previous) => {
        const next =
          sceneIndexAtProgress(progress) === RUN_SCENE_INDEX
            ? runBeatIndexAtProgress(progress)
            : null;
        return next === previous ? previous : next;
      });
      setSceneIndex((previous) => {
        const next = sceneIndexAtProgress(progress);
        return next === previous ? previous : next;
      });
    },
    [applyImperative],
  );

  React.useEffect(() => {
    if (reducedMotion) {
      applyImperative(STILL_PROGRESS);
      return;
    }

    const root = rootRef.current;
    if (!root) return;

    applyProgress(0);

    const trigger = ScrollTrigger.create({
      trigger: root,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => applyProgress(self.progress),
    });

    return () => trigger.kill();
  }, [reducedMotion, applyProgress, applyImperative]);

  /**
   * Dev-only handle for driving the scrub from the console.
   *
   * Browser automation runs the page in a background tab, where
   * `requestAnimationFrame` never fires — so GSAP's ticker is frozen and
   * ScrollTrigger never processes a scroll, which makes the scene impossible to
   * inspect at a chosen moment. Pairing this with R3F's `advance()` lets a
   * specific progress be rendered on demand:
   *
   *   __orkestApplyProgress(0.62);
   *   for (let i = 0; i < 90; i++) __orkestScene.advance(performance.now());
   *
   * The 90 frames are not decoration — the camera is damped, so a single frame
   * only moves it a fraction of the way to the scripted position.
   */
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __orkestApplyProgress?: (p: number) => void };
    w.__orkestApplyProgress = applyProgress;
    return () => {
      delete w.__orkestApplyProgress;
    };
  }, [applyProgress]);

  React.useEffect(() => {
    if (reducedMotion) return;
    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = {
        x: (event.clientX / window.innerWidth) * 2 - 1,
        y: -((event.clientY / window.innerHeight) * 2 - 1),
      };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [reducedMotion]);

  // Derived rather than stored for the reduced-motion path, which never runs a
  // scrub and so never advances `sceneIndex` past its initial value.
  const activeIndex = reducedMotion ? sceneIndexAtProgress(STILL_PROGRESS) : sceneIndex;
  const active = SCENES[activeIndex];
  // The run film's own beat, when scene 3 is playing. `run-film.ts` stays the
  // single script for this run — the captions below are its sentences, not a
  // second set written to match.
  const beat = runBeat === null || reducedMotion ? null : FILM_BEATS[runBeat];

  return (
    <div ref={rootRef} style={{ height: `${SCROLL_VH}vh` }} className="relative">
      {/* The page's hero, in the first viewport of the scroll container.
          Deliberately NOT inside the sticky stage: it scrolls up and away on
          its own while the room stays stuck behind it, which is the whole
          transition and costs no scroll listener to do. */}
      <div
        ref={heroRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-screen items-start justify-center pt-28 sm:pt-32"
      >
        <HeroCopy />
      </div>

      <div className="sticky top-0 h-screen w-full overflow-hidden">
        <div
          ref={backdropRef}
          aria-hidden
          className="absolute inset-0"
          style={{ background: backdropGradientAtProgress(0) }}
        />

        {webgl && (
          <Canvas
            className="absolute inset-0"
            // Cap DPR: this is a glow-heavy scene where fragment cost dominates,
            // and a 3x phone would triple it for no visible gain.
            shadows
            dpr={[1, 1.6]}
            frameloop={reducedMotion ? "demand" : "always"}
            camera={{ fov: 46, near: 0.1, far: 400, position: [0, 26, 62] }}
            gl={{
              alpha: true,
              antialias: true,
              powerPreference: "high-performance",
              // ACES back on: the scene is now physically lit paper rather
              // than additive neon, and filmic roll-off is what keeps a white
              // card under a 2.1-intensity key light from clipping to a flat
              // blown-out rectangle.
              toneMapping: THREE.ACESFilmicToneMapping,
              toneMappingExposure: 1.05,
            }}
            onCreated={(state) => {
              // Dev-only handle for inspecting the scene graph from the browser
              // console. R3F keeps its store in a module-private map, so there
              // is otherwise no way to check a uniform's live value against
              // what the scrub thinks it is.
              if (process.env.NODE_ENV !== "production") {
                (window as unknown as { __orkestScene?: unknown }).__orkestScene = state;
              }
            }}
          >
            {/* Overhead daylight, and deliberately NEUTRAL.
                
                This is where a beige cast came from, and it is worth writing
                down because nothing in the palette looked wrong: the key light
                was #fffaf2, the fill #fff4e6 and the hemisphere ground #d8d3c9.
                Every surface in the scene — near-white backdrop, white paper,
                grey room — was being multiplied by a warm light and the whole
                section read as beige while every hex value in the source said
                otherwise. **Tint the lights and you tint everything.** If the
                room ever looks warm again, check here before the palette.
                
                Still no coloured rim light: a cool or violet cast is exactly
                what made the first version read as a generic AI page. */}
            <hemisphereLight args={["#ffffff", "#e8e8ee", 1.15]} />
            <directionalLight
              position={[9, 22, 12]}
              intensity={2.1}
              color="#ffffff"
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0006}
              shadow-camera-left={-40}
              shadow-camera-right={40}
              shadow-camera-top={40}
              shadow-camera-bottom={-40}
              shadow-camera-near={1}
              shadow-camera-far={90}
            />
            <directionalLight position={[-12, -6, 8]} intensity={0.35} color="#f4f4f7" />

            <CameraRig progressRef={progressRef} pointerRef={pointerRef} damped={!reducedMotion} />
            {/* The room first, so the documents lying on the desk have
                something to cast their contact shadows onto. */}
            <OfficeRoom progressRef={progressRef} />
            <DocumentField settleRef={settleRef} progressRef={progressRef} />
            {/* Edges before the core in the tree, but neither depends on the
                other's order — both read the same refs and resolve their own
                geometry each frame. */}
            <ConnectionEdges progressRef={progressRef} settleRef={settleRef} />
            <AiCore intensityRef={coreRef} />
            <ClusterLabels progressRef={progressRef} />
            <MarkCollapse progressRef={progressRef} />
          </Canvas>
        )}

        {/* Copy. Keyed on the scene so React swaps the node and the CSS
            transition replays — cross-fading two absolutely-positioned blocks
            would need both mounted and is not worth the layout cost. */}
        <div
          ref={captionRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-6 pb-16 sm:pb-20"
          style={{ opacity: 0 }}
        >
          <div
            key={beat ? `beat-${runBeat}` : active.id}
            className="mx-auto max-w-3xl text-center [animation:mk-scene-copy_700ms_ease-out]"
          >
            <p className="text-[0.6875rem] font-semibold tracking-[0.18em] text-mk-ink/45 uppercase">
              {/* During the run the eyebrow carries the live run status, which
                  is a real `WorkflowRun.status` string — "Waiting for approval"
                  is the product's own word for what is on screen. */}
              {beat ? runStatusLabel(beat.runStatus) : active.eyebrow}
            </p>
            <p className="mt-3 text-balance text-2xl leading-snug font-medium text-mk-ink sm:text-[2rem]">
              {beat ? beat.caption : active.line}
            </p>
          </div>
        </div>

        <style>{`
          @keyframes mk-scene-copy {
            from { opacity: 0; transform: translateY(14px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    </div>
  );
}
