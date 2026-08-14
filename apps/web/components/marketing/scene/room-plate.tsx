import * as React from "react";
import Image from "next/image";

import { PLATE_DESK_EDGE_NDC } from "@/lib/scene-script";
import deskRoom from "@/public/desk-room.jpg";

/**
 * The photographed room the page opens in.
 *
 * ## Why a photograph and not geometry
 *
 * This replaced a fully modelled room — a wall, a floor and a procedural walnut
 * desk. That version was convincing *as a render*, which is a different thing
 * from convincing. The brief was for the opening frame to be real, and the
 * shortest path to a real office is a photograph of one.
 *
 * The documents are still real geometry sitting on a real (solved) plane; only
 * the room is a plate. See `PLATE_DESK_EDGE_NDC` in `lib/scene-script.ts` for
 * the measurement everything is matched to, and `CAMERA_KEYS[0]` for why the
 * opening camera is exactly level.
 *
 * ## This is DOM, not WebGL, and that is deliberate
 *
 * It composites *under* the transparent canvas, in the same stack as the
 * existing backdrop gradient. Three reasons: it paints before any shader
 * compiles, so the opening frame is not gated on WebGL; a lost context or an
 * absent GPU degrades to a photograph of an office rather than to a grey block;
 * and the grade below (defocus, grain, vignette) costs nothing in the render
 * loop because the compositor does it.
 *
 * ## The grade is deliberately minimal, because this plate does not need saving
 *
 * `desk-room.jpg` is 1000×661 and — the thing that makes it the right
 * photograph — its background is **optically** out of focus while the tabletop
 * is sharp. That single property does three jobs at once: the room reads as a
 * real room shot at a wide aperture, the upscale is invisible where the image is
 * already soft, and the hero copy lands on a low-detail field instead of on
 * book spines and foliage.
 *
 * An earlier plate was 736×414 and sharp-everywhere, and it needed a synthetic
 * edge defocus, heavier grain and a scrim under the copy to be usable at all.
 * None of that is here: a synthetic blur over a real one is just a second blur,
 * and it would have softened the one region — the tabletop — that must stay
 * crisp, because that is where the documents sit.
 *
 * The image is served `unoptimized`. Next's optimizer would upscale it
 * server-side and re-encode — a few hundred KB to invent detail that is not in
 * the file. The browser's own scaler does the same job on the original 52KB.
 */

/**
 * Where the photographed table's far edge must land, as a percentage of the
 * container's height. **This is the alignment, and it is not a taste knob.**
 *
 * ## Why this exact value, and why it is used for two different properties
 *
 * `object-cover` crops to fill, so at a viewport wider than the plate's 1.78 the
 * image overflows vertically and the desk edge slides depending on where that
 * overflow is taken from. The 3D camera, meanwhile, projects the tabletop to a
 * *fixed* NDC — so unless the crop is anchored, the documents drift off the wood
 * as the window resizes. That is not hypothetical: at `62%` (an eyeballed value,
 * briefly) the papers sat ~0.08 NDC high, floating over the chair.
 *
 * Setting `object-position` to the edge's own height fraction makes it
 * aspect-invariant. The algebra is short and worth keeping: with vertical
 * overflow `Hd - Hc`, taking `f` of it off the top puts the edge at
 * `f·Hd - f·(Hd - Hc) = f·Hc` — i.e. at fraction `f` of the container, for any
 * `Hd`. At a viewport narrower than 1.78 there is no vertical overflow at all
 * and the edge sits at `f·Hc` regardless. Both cases land on the same line.
 *
 * `transform-origin` gets the same value so the overscan and the push-in scale
 * *about* the desk edge, leaving the one line that has to stay put fixed while
 * the rest of the room expands around it.
 */
const DESK_EDGE_PERCENT = ((1 - PLATE_DESK_EDGE_NDC) / 2) * 100;
const DESK_EDGE_ANCHOR = `50% ${DESK_EDGE_PERCENT.toFixed(2)}%`;

/**
 * Base overscan, so the parallax translate never drags a hard edge into frame.
 *
 * Small because the translate it covers is small — the residual sway over the
 * plate is a fraction of a percent of frame width. Anything larger just costs
 * resolution on an image that has none to spare.
 */
export const PLATE_OVERSCAN = 1.03;

/** The blurred twin's radius, used for the rack focus on liftoff. Large enough
 *  to read as a focus pull rather than as a soft copy of the same image, and
 *  it has to out-blur a background that is already soft to register at all. */
const RACK_BLUR_PX = 18;

/**
 * Fine monochrome grain, as a tiling SVG turbulence patch.
 *
 * **Static, never animated.** Animated grain costs a repaint every frame and
 * reads as video noise; still grain reads as film stock. `baseFrequency` is high
 * enough to stay sub-pixel-ish at 1x and not turn into visible mush at 2x.
 */
const GRAIN_TILE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">` +
      `<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch"/>` +
      `<feColorMatrix type="saturate" values="0"/></filter>` +
      `<rect width="140" height="140" filter="url(#g)" opacity="0.5"/></svg>`,
  );

export interface RoomPlateProps {
  /**
   * Set on the SSR/loading path, where there is no scrub to drive the plate.
   *
   * Renders exactly the same markup at exactly the opening state, so the swap to
   * the live plate when the scene chunk arrives is not a visible change. Without
   * a ref there is nothing to animate, and nothing should be.
   */
  frozen?: boolean;
  /** Written to imperatively by `core-scene.tsx` — opacity, transform and the
   *  sharp/blurred crossfade. Never React state; this updates every scroll
   *  frame. */
  plateRef?: React.RefObject<HTMLDivElement | null>;
  /** The blurred twin, cross-faded in for the rack focus. Separate ref because
   *  it is the only layer whose opacity moves independently of the group's. */
  blurRef?: React.RefObject<HTMLDivElement | null>;
}

export function RoomPlate({ frozen = false, plateRef, blurRef }: RoomPlateProps) {
  return (
    <div
      ref={plateRef}
      aria-hidden
      className="absolute inset-0 overflow-hidden"
      style={{
        // Scaled about the desk edge, so the overscan expands the room around
        // the one line that has to stay aligned rather than moving it.
        transform: `scale(${PLATE_OVERSCAN})`,
        transformOrigin: DESK_EDGE_ANCHOR,
        willChange: "transform, opacity",
      }}
    >
      {/* Sharp. The `object-position` is the camera match — see
          DESK_EDGE_ANCHOR. It is not a compositional preference and changing it
          slides the documents off the tabletop. */}
      <Image
        src={deskRoom}
        alt=""
        fill
        unoptimized
        // `priority` was deprecated in Next 16; eager + high fetchPriority is
        // the documented replacement for an above-the-fold hero, and the image
        // is in the initial markup so a preload <link> would be redundant.
        loading="eager"
        fetchPriority="high"
        placeholder="blur"
        sizes="100vw"
        className="object-cover"
        style={{ objectPosition: DESK_EDGE_ANCHOR }}
      />

      {/* The blurred twin, for the rack focus. Its filter is set once at mount
          and never recomputed — animating `filter` on a full-screen element
          every scroll frame is the expensive way to do this and looks no
          better than cross-fading two composited layers. */}
      <div
        ref={blurRef}
        className="absolute inset-0"
        style={{ opacity: frozen ? 0 : undefined, willChange: "opacity" }}
      >
        <Image
          src={deskRoom}
          alt=""
          fill
          unoptimized
          loading="eager"
          sizes="100vw"
          className="object-cover"
          style={{
            objectPosition: DESK_EDGE_ANCHOR,
            filter: `blur(${RACK_BLUR_PX}px)`,
            // The blur samples transparent pixels past the edges and would
            // otherwise fade to nothing at the frame border. Scaled about the
            // same anchor so the two copies stay registered as they cross-fade.
            transform: "scale(1.08)",
            transformOrigin: DESK_EDGE_ANCHOR,
          }}
        />
      </div>

      {/**
       * The copy wash — a measured contrast device, not a mood.
       *
       * The room behind the headline runs about three stops from the bright
       * window at the left to the dark bookcase at the right, and the hero copy
       * crosses all of it. Measured on the raw plate the worst patches were
       * 1.3–1.9:1: not marginal, invisible. Sampling is per text line via
       * `Range.getClientRects()` rather than per element box, so leading and the
       * ragged right edge do not flatter the numbers.
       *
       * At 0.45 every line clears 4.5:1 — see the table in `apps/web/CLAUDE.md`.
       * Both halves of that were necessary: the wash alone could not save the
       * translucent type (see `hero-copy.tsx`), and raising the type alone could
       * not survive the bookcase.
       *
       * **The lower stop is the table edge**, so the wash dies exactly where the
       * tabletop begins. Hazing the wood would both flatten the one sharp region
       * of the photograph and put a veil between the viewer and the documents,
       * which are the subject. Because the element scales about that same anchor
       * (`DESK_EDGE_ANCHOR`), the stop stays welded to the edge under the
       * push-in rather than creeping down onto the timber.
       */}
      <div
        className="absolute inset-0"
        style={{
          background:
            `linear-gradient(to bottom,` +
            ` rgba(255,255,255,0.45) 0%,` +
            ` rgba(255,255,255,0.45) 40%,` +
            ` rgba(255,255,255,0.414) 58%,` +
            ` rgba(255,255,255,0.189) 68%,` +
            ` rgba(255,255,255,0) ${DESK_EDGE_PERCENT.toFixed(2)}%)`,
        }}
      />

      {/* Grain. Overlay rather than a flat alpha so it darkens and lightens
          around the mid-tones instead of veiling the whole frame in grey.
          Light — this plate is clean, and grain here is a unifying film-stock
          texture over the whole frame rather than damage control. It also gives
          the WebGL documents and the photographed table one shared surface
          noise, which is quietly a large part of why they sit together. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${GRAIN_TILE}")`,
          backgroundRepeat: "repeat",
          backgroundSize: "140px 140px",
          mixBlendMode: "overlay",
          opacity: 0.04,
        }}
      />

      {/* Vignette. Very slight — enough to seat the frame, not enough to read
          as an effect. Multiply so it deepens what is already there rather
          than laying grey over it. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 82% 88% at 50% 54%, rgba(255,255,255,0) 55%, rgba(120,104,88,0.20) 100%)",
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
}
