"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The reasoning core — rebuilt for the daylight room.
 *
 * ## What changed, and why the old one had to go
 *
 * The first version was a point-cloud nucleus: ~3,400 additive points, a
 * fresnel-rimmed dark body and a camera-facing glow disc standing in for a
 * bloom pass. It was the right object for a near-black void, and the void was
 * rejected. In a lit room a glowing nucleus is simply wrong — every other
 * surface here is paper taking light from a key lamp, and the one self-lit
 * thing in the frame reads as a screen someone left on. "Nothing is emissive"
 * is the room's rule and the core does not get an exemption.
 *
 * ## It is still made of nodes and edges, and that is still the argument
 *
 * The idea worth keeping from the old version: the core is **the same
 * substance as the rest of the world at high density** — not a magic orb, but a
 * graph dense enough to read as a body. So it is still built from nodes and the
 * links between them. They are now *objects*: small graphite spheres and thin
 * struts, lit by the same light as the cards and casting the same shadows. A
 * physical model of a decision, sitting on the same desk as the paperwork.
 *
 * ## No shader at all
 *
 * Both of this scene's expensive traps live in custom GLSL — R3F cloning a
 * `uniforms` object so per-frame mutation renders nothing, and `precision`
 * declared in only one stage so the program silently draws nothing. Neither can
 * fire here: this is `meshStandardMaterial` on instanced geometry, animated
 * through transforms. That is not an accident, it is the cheaper way to be
 * correct. (Both traps stay documented in apps/web/CLAUDE.md for whatever does
 * eventually need a shader.)
 *
 * ## Ignition
 *
 * `intensityRef` runs 0→1 across scene 2. At 0 the core is *absent*, not dim:
 * scene 1 claims nothing is connecting the work, and a lattice already sitting
 * there would contradict the copy before it has been read. It assembles —
 * nodes fly in from the radius they will occupy, struts follow.
 */

/** Nodes in the lattice. Enough to read as dense, few enough that 60fps is
 *  never in question on integrated graphics. */
const NODE_COUNT = 96;
const STRUT_COUNT = 132;
const CORE_RADIUS = 3.1;

const NODE_COLOR = "#23262b";
const STRUT_COLOR = "#5c6068";

/** Deterministic per-point jitter. Avoids `Math.random()` so a given build
 *  always produces the same core — reproducible screenshots, reviewable diffs. */
function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Fibonacci sphere.
 *
 * Even coverage without the pole clustering a naive lat/long grid produces —
 * which matters here because a visible seam or a bald patch immediately reads
 * as a texture-mapping error rather than as a structure.
 */
function fibonacciSphere(count: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    // Radius is modulated per point so the surface is a lattice rather than a
    // shell — a perfect sphere of dots reads as a ball, which is the orb this
    // design is explicitly not.
    const shell = 0.58 + hash(i) * 0.42;
    points.push(
      new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius).multiplyScalar(
        CORE_RADIUS * shell,
      ),
    );
  }
  return points;
}

export interface AiCoreProps {
  /** 0 = dormant (scene 1), 1 = fully assembled. */
  intensityRef: React.RefObject<number>;
}

export function AiCore({ intensityRef }: AiCoreProps) {
  const nodesRef = React.useRef<THREE.InstancedMesh>(null);
  const strutsRef = React.useRef<THREE.InstancedMesh>(null);

  const points = React.useMemo(() => fibonacciSphere(NODE_COUNT), []);

  /**
   * Which nodes are strutted together.
   *
   * Nearest-neighbour rather than random pairs: random links across the
   * diameter turn the lattice into a ball of wool, where short links between
   * neighbours read as structure. Computed once — the lattice is rigid, only
   * its assembly animates.
   */
  const struts = React.useMemo(() => {
    const pairs: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    for (let i = 0; i < points.length && pairs.length < STRUT_COUNT; i += 1) {
      const distances = points
        .map((point, j) => ({ j, d: point.distanceTo(points[i]) }))
        .filter((entry) => entry.j !== i)
        .sort((left, right) => left.d - right.d);
      // Two links per node, skipping the closest few times it would duplicate
      // an existing pair. Enough for a connected body, not so many it fills in.
      for (const { j } of distances.slice(0, 2)) {
        if (pairs.length >= STRUT_COUNT) break;
        if (j < i) continue;
        pairs.push({ a: points[i], b: points[j] });
      }
    }
    return pairs;
  }, [points]);

  const scratch = React.useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
    }),
    [],
  );

  useFrame(({ clock }) => {
    const nodes = nodesRef.current;
    const strutMesh = strutsRef.current;
    if (!nodes || !strutMesh) return;

    const intensity = Math.min(Math.max(intensityRef.current ?? 0, 0), 1);
    nodes.visible = intensity > 0.001;
    strutMesh.visible = intensity > 0.001;
    if (!nodes.visible) return;

    const time = clock.getElapsedTime();
    // A slow tumble. The core is the one thing in the room that is thinking, so
    // it is the one thing with its own motion rather than a drift.
    const spin = time * 0.12;

    for (let i = 0; i < points.length; i += 1) {
      // Assembly: each node travels in from beyond its final radius, on its own
      // slightly different schedule, so the core gathers rather than appearing.
      const lead = hash(i * 3.7) * 0.35;
      const arrival = Math.min(Math.max((intensity - lead) / (1 - lead), 0), 1);
      const eased = arrival * arrival * (3 - 2 * arrival);

      scratch.position.copy(points[i]).multiplyScalar(0.6 + eased * 0.4);
      scratch.position.applyAxisAngle(scratch.up, spin);

      const size = 0.075 * eased;
      scratch.scale.set(size, size, size);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      nodes.setMatrixAt(i, scratch.matrix);
    }
    nodes.instanceMatrix.needsUpdate = true;

    // Struts trail the nodes: the parts arrive, then the links between them.
    const strutReveal = Math.min(Math.max((intensity - 0.3) / 0.7, 0), 1);
    for (let i = 0; i < struts.length; i += 1) {
      scratch.a.copy(struts[i].a).multiplyScalar(0.6 + strutReveal * 0.4);
      scratch.b.copy(struts[i].b).multiplyScalar(0.6 + strutReveal * 0.4);
      scratch.a.applyAxisAngle(scratch.up, spin);
      scratch.b.applyAxisAngle(scratch.up, spin);

      scratch.dir.subVectors(scratch.b, scratch.a);
      const length = scratch.dir.length() * strutReveal;
      scratch.position.addVectors(scratch.a, scratch.b).multiplyScalar(0.5);
      scratch.quaternion.setFromUnitVectors(scratch.up, scratch.dir.normalize());
      scratch.scale.set(1, Math.max(length, 0.0001), 1);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      strutMesh.setMatrixAt(i, scratch.matrix);
    }
    strutMesh.instanceMatrix.needsUpdate = true;
    // Reset, or the next node loop inherits the last strut's rotation.
    scratch.quaternion.identity();
  });

  return (
    <group>
      <instancedMesh
        ref={nodesRef}
        args={[undefined, undefined, NODE_COUNT]}
        castShadow
        receiveShadow
        visible={false}
      >
        <sphereGeometry args={[1, 12, 12]} />
        <meshStandardMaterial color={NODE_COLOR} roughness={0.42} metalness={0.05} />
      </instancedMesh>

      <instancedMesh
        ref={strutsRef}
        args={[undefined, undefined, STRUT_COUNT]}
        castShadow
        visible={false}
      >
        <boxGeometry args={[0.022, 1, 0.022]} />
        <meshStandardMaterial color={STRUT_COLOR} roughness={0.5} metalness={0.1} />
      </instancedMesh>
    </group>
  );
}
