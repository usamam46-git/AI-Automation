"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { MARK_NODES, markCollapseAtProgress } from "@/lib/scene-script";

/**
 * The ending: the whole graph resolves into the Orkest mark.
 *
 * ## It is the same drawing as the nav, on purpose
 *
 * The geometry comes from `MARK_NODES`, which is derived from the viewBox of
 * `components/marketing/orkest-mark.tsx`. Two filled nodes, one **open ring**
 * between them, and the edge running through. `orkest-mark.tsx` already warns
 * that the mark, the canvas node and the 3D object must not become three
 * unrelated drawings — deriving this one from that one is how that is kept
 * true rather than merely intended.
 *
 * ## Why the middle node is open
 *
 * Because it is the human-approval gate. That is the argument the whole page
 * has been making, and the ending compresses it: the documents collapse in, the
 * two approval requests land in the open middle, and the mark that has been
 * sitting in the corner of the nav the entire time turns out to be a picture of
 * what the visitor just watched.
 *
 * ## Physical, like everything else in this room
 *
 * Ink-coloured `meshStandardMaterial`, lit by the same key light, casting the
 * same shadows. No emissive term and no shader — see `ai-core.tsx` for why that
 * matters here and what it avoids.
 */

const MARK_COLOR = "#1b1e23";
/** Thickness of the open ring's stroke, and of the edge between the nodes. */
const RING_THICKNESS = 0.42;
const EDGE_THICKNESS = 0.3;

export interface MarkCollapseProps {
  progressRef: React.RefObject<number>;
}

export function MarkCollapse({ progressRef }: MarkCollapseProps) {
  const groupRef = React.useRef<THREE.Group>(null);

  const material = React.useMemo(
    // Matte, and deliberately so. At 0.4 roughness the two filled nodes picked
    // up hard specular highlights and read as billiard balls; the mark is ink,
    // and the 3D version should look like the SVG rendered in a room rather
    // than like two polished spheres.
    () => new THREE.MeshStandardMaterial({ color: MARK_COLOR, roughness: 0.82, metalness: 0 }),
    [],
  );
  React.useEffect(() => () => material.dispose(), [material]);

  /**
   * The bar joining the three nodes.
   *
   * The SVG draws two short strokes rather than one line through the middle,
   * because the ring is open and a stroke crossing it would close it visually.
   * The same reasoning applies here, so this is two segments with the ring left
   * clear between them.
   */
  const segments = React.useMemo(() => {
    const [a, b, c] = MARK_NODES;
    const build = (from: THREE.Vector3, to: THREE.Vector3) => {
      const dir = new THREE.Vector3().subVectors(to, from);
      const length = dir.length();
      const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize(),
      );
      return { mid, length, quaternion };
    };

    const pa = new THREE.Vector3(...a.position);
    const pb = new THREE.Vector3(...b.position);
    const pc = new THREE.Vector3(...c.position);

    // Stop short of each node's edge so the bar meets the circles cleanly.
    const trim = (from: THREE.Vector3, to: THREE.Vector3, startPad: number, endPad: number) => {
      const dir = new THREE.Vector3().subVectors(to, from).normalize();
      return build(
        from.clone().addScaledVector(dir, startPad),
        to.clone().addScaledVector(dir, -endPad),
      );
    };

    return [trim(pa, pb, a.radius, b.radius), trim(pb, pc, b.radius, c.radius)];
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const collapse = markCollapseAtProgress(progressRef.current ?? 0);
    group.visible = collapse > 0.001;
    if (!group.visible) return;

    // The mark assembles at its final size rather than growing from nothing:
    // scaling a logo up from zero reads as a splash screen. It fades in by
    // arriving slightly from behind and settling.
    group.position.z = (1 - collapse) * -6;
    group.scale.setScalar(0.7 + collapse * 0.3);
  });

  return (
    <group ref={groupRef} visible={false}>
      {MARK_NODES.map((node, index) => (
        <mesh
          key={index}
          position={[node.position[0], node.position[1], node.position[2]]}
          material={material}
          castShadow
          receiveShadow
        >
          {node.open ? (
            // A torus, so the middle node is genuinely a ring you can see
            // through — the open centre is the meaning, not a style.
            <torusGeometry args={[node.radius, RING_THICKNESS, 16, 48]} />
          ) : (
            <sphereGeometry args={[node.radius, 24, 24]} />
          )}
        </mesh>
      ))}

      {segments.map((segment, index) => (
        <mesh
          key={`segment-${index}`}
          position={segment.mid}
          quaternion={segment.quaternion}
          material={material}
          castShadow
        >
          <boxGeometry args={[EDGE_THICKNESS, segment.length, EDGE_THICKNESS]} />
        </mesh>
      ))}
    </group>
  );
}
