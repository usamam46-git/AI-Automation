"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  CARD_REST_Y,
  PLATE_DESK_EDGE_Z,
  platePresenceAtProgress,
} from "@/lib/scene-script";

/**
 * The tabletop the documents rest on — invisible except for their shadows.
 *
 * ## This used to be the room, and no longer is
 *
 * It was a wall, a floor, a procedural walnut desk and an apron: a complete
 * modelled office. `room-plate.tsx` replaced all of it with a photograph, so the
 * only thing still needed in 3D is a surface for the paperwork to sit on and,
 * far more importantly, to **cast onto**.
 *
 * ## The shadows are the whole job
 *
 * Contact shadows are what weld 3D paper to a photographed surface. Without
 * them the cards are geometrically correct and still read as stickers — the eye
 * reads "not attached" long before it can say why. Everything else about this
 * component is in service of one plane that is invisible until something is
 * above it.
 *
 * `ShadowMaterial` renders *only* where a shadow falls, so the photographed oak
 * shows through everywhere else. That is the reason it is used rather than a
 * matched wooden plane: no attempt to reproduce the plate's tabletop can survive
 * comparison with the plate's tabletop two pixels away.
 *
 * ## Warm-neutral, not black
 *
 * The plate's tabletop samples at #c0956e — warm mid-tone oak. A pure black
 * shadow on it reads as a hole punched in the table rather than as an occlusion,
 * because a real shadow there is still lit by everything in the room that is not
 * the window. The colour below is a desaturated brown, and the opacity is low:
 * the window light in the plate is soft and its own shadows (the plant's, the
 * chair's) are correspondingly gentle. Matching their weight matters as much as
 * matching their direction.
 */

/** Sampled from the plate's tabletop and darkened, rather than black. */
const SHADOW_COLOR = "#4a3826";

/**
 * How dark the contact shadows go.
 *
 * Tuned against the plate's own shadows rather than to taste — the window light
 * is soft and diffuse, so a hard dark shadow under a sheet of paper would be the
 * one object in frame lit by a different room.
 */
const SHADOW_OPACITY = 0.3;

/** The catcher runs from behind the photographed table's far edge to well past
 *  the bottom of frame, so a card cropped by the viewport still lands its
 *  shadow on something. Width likewise overruns the frame at every aspect. */
const CATCHER_DEPTH = 30;
const CATCHER_WIDTH = 90;

/**
 * How far the catcher sits below the cards' rest plane.
 *
 * ## Not a z-fight nudge — this is what makes the shadow visible at all
 *
 * It was 0.02, which is the right number for avoiding coplanar artefacts and
 * the wrong number for casting. The key light comes from upper-left at roughly
 * 50 degrees off vertical, so a card `g` above the surface displaces its shadow
 * by about `1.2g`. At 0.02 that is 0.024 world units against a card four units
 * wide — the shadow lands **underneath the card that cast it** and nothing is
 * visible but a sliver at one edge. The papers read as pasted on, which is the
 * exact failure this component exists to prevent.
 *
 * At 0.11 the displacement is ~0.13 units, roughly ten screen pixels at the
 * opening camera: a soft edge of shadow emerging from the lower-right of each
 * sheet, which is what paper on a lit desk actually looks like.
 *
 * The cards themselves did **not** move — `CARD_REST_Y` is load-bearing for the
 * whole camera solve (it sets `h`, and every desk constant derives from it), so
 * the gap is opened downward instead. A transparent plane 0.11 units below the
 * paper is invisible; moving the paper 0.11 units up is not.
 */
const CATCHER_DROP = 0.11;

export interface OfficeRoomProps {
  progressRef: React.RefObject<number>;
}

export function OfficeRoom({ progressRef }: OfficeRoomProps) {
  const meshRef = React.useRef<THREE.Mesh>(null);

  const material = React.useMemo(
    () =>
      new THREE.ShadowMaterial({
        color: SHADOW_COLOR,
        opacity: SHADOW_OPACITY,
        transparent: true,
        // The catcher is the furthest thing back that is not the plate, and
        // nothing is ever drawn behind it. Writing depth would let an invisible
        // plane occlude the cards whose shadows it exists to receive.
        depthWrite: false,
      }),
    [],
  );

  React.useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Fades in step with the plate. A shadow outliving the surface it was cast
    // on is the same artefact the old wooden desk had — a dark rectangle lying
    // in mid-air with nothing above it.
    const presence = platePresenceAtProgress(progressRef.current ?? 0);
    mesh.visible = presence > 0.002;
    if (!mesh.visible) return;
    (mesh.material as THREE.ShadowMaterial).opacity = SHADOW_OPACITY * presence;
  });

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, CARD_REST_Y - CATCHER_DROP, PLATE_DESK_EDGE_Z + CATCHER_DEPTH / 2]}
      material={material}
      receiveShadow
      visible={false}
    >
      <planeGeometry args={[CATCHER_WIDTH, CATCHER_DEPTH]} />
    </mesh>
  );
}
