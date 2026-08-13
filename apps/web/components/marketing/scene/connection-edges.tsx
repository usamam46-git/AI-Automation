"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  CORE_ENDPOINT,
  SCENE_EDGES,
  SCENE_NODES,
  type SceneEdge,
  type SceneNode,
  cardPositionAt,
  documentPresenceAtProgress,
  edgeRevealAtProgress,
  runStageBlendAtProgress,
} from "@/lib/scene-script";

/**
 * The connections scene 2 resolves out of the drifting field.
 *
 * ## Why these are solid geometry and not `THREE.Line`
 *
 * `LineBasicMaterial`'s `linewidth` is ignored by every WebGL renderer — lines
 * are always one device pixel. A one-pixel line is invisible against warm grey
 * at this scale, and it cannot take light or cast a shadow, so it would read as
 * an overlay drawn on top of the room rather than as something *in* it. Each
 * edge is therefore a thin box, lit by the same key light as the cards. The
 * scene's whole claim is that these connections are as physical as the
 * paperwork.
 *
 * ## No shader, and that is the point
 *
 * An earlier version of this scene lost a long session to R3F cloning a
 * `uniforms` object, and another to mismatched `precision` between shader
 * stages. Neither trap can fire here: every material below is a stock
 * `meshStandardMaterial`, driven by transforms rather than by uniforms. If a
 * future phase does need a custom shader, both traps are documented in
 * apps/web/CLAUDE.md — but reaching for one here would buy nothing.
 *
 * ## Ink, not light
 *
 * Chain edges are near-black hairlines: the trail the paperwork already made.
 * Reasoning edges — the core's — are the one lime accent in the room, and are
 * still a lit surface rather than an emissive one. Nothing here glows.
 */

/** Thin enough to read as a drawn line, thick enough to catch the key light. */
const EDGE_THICKNESS = 0.04;
const CHAIN_COLOR = "#2a2d33";
const REASONING_COLOR = "#93c53d";

/** Where the reasoning core sits. The field is placed to keep clear of it. */
export const CORE_POSITION: readonly [number, number, number] = [0, 0, 0];

interface EdgeMeshProps {
  index: number;
  /** True for the core's reasoning edges — see the taper in `useFrame`. */
  touchesCore: boolean;
  from: SceneNode | null;
  to: SceneNode | null;
  progressRef: React.RefObject<number>;
  settleRef: React.RefObject<number>;
  geometry: THREE.BoxGeometry;
  material: THREE.Material;
}

/**
 * One edge, re-solved every frame.
 *
 * The endpoints are drifting cards, so an edge cannot be baked at mount — it is
 * positioned at the midpoint, scaled to the current span, and rotated onto the
 * axis between its two documents. `quaternion.setFromUnitVectors` is what makes
 * that a three-line operation rather than a pile of trigonometry.
 */
function EdgeMesh({
  index,
  touchesCore,
  from,
  to,
  progressRef,
  settleRef,
  geometry,
  material,
}: EdgeMeshProps) {
  const meshRef = React.useRef<THREE.Mesh>(null);

  // Allocated once and mutated in place. Allocating vectors inside `useFrame`
  // makes garbage on every frame of a scroll, which is exactly when a landing
  // page can least afford a collection pause.
  const scratch = React.useMemo(
    () => ({
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
    }),
    [],
  );

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const progress = progressRef.current ?? 0;
    const reveal = edgeRevealAtProgress(progress, index);
    // Hidden rather than zero-scaled: a zero-length box still costs a draw call
    // and can flicker as a degenerate triangle.
    mesh.visible = reveal > 0.001;
    if (!mesh.visible) return;

    const time = clock.getElapsedTime();
    const settle = settleRef.current ?? 0;

    const start = from ? cardPositionAt(from, settle, time, progress) : CORE_POSITION;
    const end = to ? cardPositionAt(to, settle, time, progress) : CORE_POSITION;
    scratch.a.set(start[0], start[1], start[2]);
    scratch.b.set(end[0], end[1], end[2]);

    // Draw *from* the start toward the end, so an edge grows along its own
    // direction instead of expanding from its middle in both directions.
    scratch.b.lerpVectors(scratch.a, scratch.b, reveal);

    scratch.dir.subVectors(scratch.b, scratch.a);
    const length = scratch.dir.length();
    if (length < 0.001) {
      mesh.visible = false;
      return;
    }

    scratch.mid.addVectors(scratch.a, scratch.b).multiplyScalar(0.5);
    mesh.position.copy(scratch.mid);

    /**
     * Connections outside the run taper away while scene 3 plays.
     *
     * Done by thinning the box rather than by fading the material, because all
     * chain edges share one material — per-edge opacity would need per-edge
     * materials. Tapering is a transform, costs nothing, and an edge thinned
     * to a fraction of 0.04 world units is simply not visible.
     *
     * An edge is only as present as its least present endpoint: a connection
     * to a document that has receded should recede with it.
     */
    const presence = Math.min(
      from ? documentPresenceAtProgress(from.id, progress) : 1,
      to ? documentPresenceAtProgress(to.id, progress) : 1,
      // The core's own edges taper during the run too, even though the
      // documents they touch stay present. Scene 3 stages the run in the
      // finance cluster and the core is far off frame at the origin, so these
      // would render as long diagonals leaving the shot toward nothing.
      touchesCore ? 1 - runStageBlendAtProgress(progress) : 1,
    );
    mesh.scale.set(presence, length, presence);
    mesh.quaternion.setFromUnitVectors(scratch.up, scratch.dir.normalize());
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} visible={false} />;
}

export interface ConnectionEdgesProps {
  progressRef: React.RefObject<number>;
  settleRef: React.RefObject<number>;
  edges?: readonly SceneEdge[];
  nodes?: readonly SceneNode[];
}

export function ConnectionEdges({
  progressRef,
  settleRef,
  edges = SCENE_EDGES,
  nodes = SCENE_NODES,
}: ConnectionEdgesProps) {
  // Unit-height box on +Y, so an edge is scaled on one axis and rotated onto
  // its direction. Shared by every edge; only the transform differs.
  const geometry = React.useMemo(() => new THREE.BoxGeometry(EDGE_THICKNESS, 1, EDGE_THICKNESS), []);

  const materials = React.useMemo(
    () => ({
      chain: new THREE.MeshStandardMaterial({ color: CHAIN_COLOR, roughness: 0.7, metalness: 0 }),
      reasoning: new THREE.MeshStandardMaterial({
        color: REASONING_COLOR,
        roughness: 0.55,
        metalness: 0,
      }),
    }),
    [],
  );

  React.useEffect(() => {
    return () => {
      geometry.dispose();
      materials.chain.dispose();
      materials.reasoning.dispose();
    };
  }, [geometry, materials]);

  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  return (
    <group>
      {edges.map((edge, index) => {
        // A `null` endpoint means the core rather than a missing document —
        // `CORE_ENDPOINT` is a real, expected id.
        const from = edge.from === CORE_ENDPOINT ? null : (byId.get(edge.from) ?? null);
        const to = edge.to === CORE_ENDPOINT ? null : (byId.get(edge.to) ?? null);
        if ((!from && edge.from !== CORE_ENDPOINT) || (!to && edge.to !== CORE_ENDPOINT)) {
          return null;
        }

        return (
          <EdgeMesh
            key={`${edge.from}-${edge.to}`}
            index={index}
            touchesCore={edge.from === CORE_ENDPOINT || edge.to === CORE_ENDPOINT}
            from={from}
            to={to}
            progressRef={progressRef}
            settleRef={settleRef}
            geometry={geometry}
            material={edge.kind === "chain" ? materials.chain : materials.reasoning}
          />
        );
      })}
    </group>
  );
}
