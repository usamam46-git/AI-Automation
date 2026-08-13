"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { DESK_Y, FLOOR_Y, WALL_Z, deskPresenceAtProgress } from "@/lib/scene-script";
import { woodTexture } from "@/components/marketing/scene/wood-texture";

/**
 * The office the page opens in.
 *
 * This is the first thing a visitor sees, and it replaced a sky-gradient hero.
 * The brief was specific: not a gradient, not particles, but **a genuine office
 * with a desk that has the documents on it**, with the whole narrative starting
 * from there.
 *
 * ## Structure, not decoration
 *
 * A single floating plane read as paper on a light void rather than as a room.
 * What makes a space legible is the same short list every time: a floor, a wall
 * to close the distance, and a desk with a **visible front edge and an apron
 * below it**, so the eye gets a thickness and an under-side. The desk edge is
 * the single most load-bearing piece here — an infinite plane has no edge and
 * therefore never becomes furniture.
 *
 * ## The room is neutral; the desk is walnut
 *
 * Wall and floor are macOS-light greys — the same `--mk-paper` / `--mk-mist`
 * family as the rest of the page, and strictly neutral. Warm greys here read as
 * beige on a page this light.
 *
 * The **desk is real polished hardwood**, and it is the one warm thing in the
 * frame. An earlier pass argued against wood on the grounds that a brown
 * rectangle is a foreign object on a near-white site; that was wrong, and the
 * rendered result settled it. A grey desk under white paper gave the documents
 * nothing to be lighter *than*, and they washed out — the timber is what finally
 * makes the paperwork read. It also gives the shot the one note of material
 * warmth that stops a near-white room feeling like an empty render.
 *
 * The polish is in the **material, not the map**: `MeshPhysicalMaterial` with a
 * clearcoat over the grain, which is what puts a soft specular sheen across the
 * surface as the light moves. A `MeshStandardMaterial` with the same texture
 * looks like printed laminate.
 *
 * ## It leaves when the documents do
 *
 * The whole room fades on `deskPresenceAtProgress`, so by the time the field is
 * airborne there is nothing left of it. A wall still hanging behind a graph in
 * scene 2 would read as a backdrop someone forgot to remove.
 */

const WALL_COLOR = "#f2f2f5";
const FLOOR_COLOR = "#e2e2e7";
/** Tints the wood map. Left near-white so the texture carries the colour. */
const DESK_TINT = "#ffffff";
/** The edge and apron are the same timber a shade deeper, as a real desk's
 *  cut edge and shadowed under-panel are. */
const DESK_EDGE_TINT = "#c9b49c";

/** Thick enough to read as a desk rather than as a sheet of card. */
const DESK_THICKNESS = 0.55;
const DESK_WIDTH = 62;
const DESK_DEPTH = 48;
/** The desk's centre in z. Its front edge lands just below the frame's lower
 *  third at the opening camera, which is what puts the documents in the lower
 *  half and leaves the upper half for the headline. */
const DESK_CENTER_Z = -14;

export interface OfficeRoomProps {
  progressRef: React.RefObject<number>;
}

export function OfficeRoom({ progressRef }: OfficeRoomProps) {
  const groupRef = React.useRef<THREE.Group>(null);

  const materials = React.useMemo(
    () => ({
      wall: new THREE.MeshStandardMaterial({
        color: WALL_COLOR,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0,
      }),
      floor: new THREE.MeshStandardMaterial({
        color: FLOOR_COLOR,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0,
      }),
      // Physical, not standard: the clearcoat is the polish. Without it the
      // grain reads as a printed pattern rather than as a finished surface.
      deskTop: new THREE.MeshPhysicalMaterial({
        map: woodTexture(),
        color: DESK_TINT,
        roughness: 0.34,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.22,
        transparent: true,
        opacity: 0,
      }),
      deskEdge: new THREE.MeshPhysicalMaterial({
        map: woodTexture(),
        color: DESK_EDGE_TINT,
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.4,
        clearcoatRoughness: 0.3,
        transparent: true,
        opacity: 0,
      }),
    }),
    [],
  );

  React.useEffect(() => {
    const list = Object.values(materials);
    return () => list.forEach((material) => material.dispose());
  }, [materials]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const presence = deskPresenceAtProgress(progressRef.current ?? 0);
    group.visible = presence > 0.002;
    if (!group.visible) return;

    // Written through the group's own materials rather than a memoised array —
    // same reasoning as the cards: `react-hooks/immutability` is right that a
    // memoised value should not be rewritten from a frame loop.
    group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!material || !("opacity" in material)) return;
      material.opacity = presence;
      /**
       * `depthWrite` stays ON while fading. This is the fix for a real artefact.
       *
       * Turning it off made the desk turn into a murky grey-brown wash the
       * instant the first scroll began: the desk is a **box**, so without depth
       * writing you see straight through its top face into its own underside and
       * far side, and three layers of dark walnut blended together. It read as
       * the desk turning black.
       *
       * Writing depth is safe here because the room is behind and below
       * everything else — the documents are opaque and draw first, so they are
       * never occluded by it.
       */
      material.depthWrite = true;
      // A fading surface must stop casting, or its shadow outlives it and
      // leaves a dark rectangle lying on the floor with nothing above it.
      mesh.castShadow = presence > 0.98;
    });
  });

  return (
    <group ref={groupRef} visible={false}>
      {/* Back wall. Closes the distance so the room has an end; without it the
          desk recedes into open space and the shot stops being interior. */}
      <mesh position={[0, 8, WALL_Z]} material={materials.wall} receiveShadow>
        <planeGeometry args={[220, 90]} />
      </mesh>

      {/* Floor. Mostly below frame at the opening camera, but it catches the
          desk's shadow, and that shadow is what gives the desk somewhere to
          stand. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, FLOOR_Y, -10]}
        material={materials.floor}
        receiveShadow
      >
        <planeGeometry args={[220, 160]} />
      </mesh>

      {/* The desk itself: a slab with real thickness, so it has a front edge.
          Positioned so its TOP face sits exactly at DESK_Y, which is the plane
          `scene-script.ts` lays the documents on. */}
      <mesh
        position={[0, DESK_Y - DESK_THICKNESS / 2, DESK_CENTER_Z]}
        material={materials.deskTop}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[DESK_WIDTH, DESK_THICKNESS, DESK_DEPTH]} />
      </mesh>

      {/* Apron below the front edge. A slab alone reads as a floating shelf;
          the under-panel is what makes it a desk you could sit at. */}
      <mesh
        position={[0, DESK_Y - DESK_THICKNESS - 1.6, DESK_CENTER_Z + DESK_DEPTH / 2 - 1.4]}
        material={materials.deskEdge}
        castShadow
      >
        <boxGeometry args={[DESK_WIDTH - 3, 3.2, 0.7]} />
      </mesh>
    </group>
  );
}
