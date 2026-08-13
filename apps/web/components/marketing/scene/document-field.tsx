"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  CARD_WORLD_HEIGHT,
  CARD_WORLD_WIDTH,
  SCENE_NODES,
  type SceneNode,
  cardPositionAt,
  cardRotationAt,
  documentPresenceAtProgress,
  erpWrittenAtProgress,
  focusedDocumentAtProgress,
  runStageBlendAtProgress,
  runStagePosition,
} from "@/lib/scene-script";
import { cardFor } from "@/lib/document-cards";
import { documentTexture } from "@/components/marketing/scene/document-texture";

/**
 * The field of back-office documents the scene opens on.
 *
 * Replaces the earlier abstract solids. Each object is a physical card with a
 * real document drawn on its face — an invoice, a payslip, a purchase order, an
 * approval request — so the opening reads as one company's work in flight
 * rather than as particles.
 *
 * ## Physical, not emissive
 *
 * Every material here is a plain `meshStandardMaterial` with no emissive term.
 * The cards are lit by the scene's lights and cast shadows on each other, which
 * is the whole reason they read as paper. The moment any of them glows they
 * stop being documents and start being screens.
 *
 * ## Individual meshes, not instanced
 *
 * Instancing was right when every object shared one geometry and differed only
 * by colour. Every card now carries a different texture, which instancing
 * cannot express. Twenty draw calls is nothing, and the geometry is shared
 * between them anyway.
 *
 * ## Cards face the reader
 *
 * They drift and tilt but never tumble freely. A document you cannot read is
 * indistinguishable from the abstract shape it replaced, so each card holds a
 * base orientation roughly facing the camera and only oscillates around it.
 */

/**
 * Card size in world units, owned by `scene-script.ts`.
 *
 * The layout there composes the opening frame by projecting cards through the
 * camera — it has to know how big one is. Redeclaring the size here would let
 * the composition and the geometry drift apart silently.
 */
const CARD_WIDTH = CARD_WORLD_WIDTH;
const CARD_HEIGHT = CARD_WORLD_HEIGHT;
/** Enough for a real shadow and a visible edge; paper, not cardboard. */
const CARD_DEPTH = 0.06;

/** The document the run writes. Its unwritten printing is the visual form of
 *  the scene's load-bearing claim — see `document-texture.ts`. */
const LEDGER_NODE_ID = "journal_entry";

interface CardProps {
  node: SceneNode;
  settleRef: React.RefObject<number>;
  progressRef: React.RefObject<number>;
  geometry: THREE.BoxGeometry;
}

function DocumentCardMesh({ node, settleRef, progressRef, geometry }: CardProps) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const card = React.useMemo(() => cardFor(node.id), [node.id]);

  /**
   * The ledger entry has two printings; every other card has one.
   *
   * `JE-99120` is the document the run writes, so it is the one that must be
   * visibly *unwritten* while the approval gate holds. Both textures are built
   * up front and swapped by index in `useFrame` — building one lazily mid-scrub
   * would mean a canvas draw and a GPU upload on the frame the gate clears,
   * which is the one frame in the scene that must not stutter.
   */
  const isLedger = node.id === LEDGER_NODE_ID;
  const texture = React.useMemo(() => documentTexture(node.id, card), [node.id, card]);
  const unwrittenTexture = React.useMemo(
    () => (isLedger ? documentTexture(node.id, card, "unwritten") : null),
    [isLedger, node.id, card],
  );

  /**
   * Six materials, because a box takes one per face.
   *
   * Index 4 is +Z (the printed face) and index 5 is −Z (the blank back). A
   * single material would map the texture onto all six faces, which puts
   * mirrored body copy on the back of every card and a stretched sliver of it
   * down each 0.06-unit edge.
   */
  const materials = React.useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ color: "#f2efe9", roughness: 0.95 });
    const back = new THREE.MeshStandardMaterial({ color: "#f7f5f0", roughness: 0.92 });
    const front = new THREE.MeshStandardMaterial({
      map: unwrittenTexture ?? texture,
      roughness: 0.88,
    });
    return [edge, edge, edge, edge, front, back];
  }, [texture, unwrittenTexture]);

  React.useEffect(() => {
    return () => materials.forEach((material) => material.dispose());
  }, [materials]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const t = clock.getElapsedTime();
    const settle = settleRef.current ?? 0;

    // Position and tilt both come from `scene-script.ts`. `connection-edges.tsx`
    // attaches to these same cards and must agree with them exactly — two
    // copies of this arithmetic would drift apart the first time an amplitude
    // was retuned, and the symptom would be edges floating free of the
    // documents they claim to connect. The layout's `DRIFT_MARGIN` budgets
    // screen space for this same excursion.
    const progress = progressRef.current ?? 0;

    const [px, py, pz] = cardPositionAt(node, settle, t, progress);
    mesh.position.set(px, py, pz);

    // Staged documents square up to the camera: a card being *shown* to you
    // should not be at a jaunty angle.
    const staged = runStagePosition(node.id) ? runStageBlendAtProgress(progress) : 0;
    const [rx, ry, rz] = cardRotationAt(node, t, progress);
    mesh.rotation.set(rx * (1 - staged), ry * (1 - staged), rz * (1 - staged));

    // The ledger's two printings. Swapping `map` is a pointer assignment on an
    // already-uploaded texture, so the change costs nothing on the frame it
    // happens — see the note where both are built.
    if (isLedger && unwrittenTexture) {
      // Reached through the mesh rather than through the memoised `materials`
      // array. They are the same objects, but mutating the memo is what
      // `react-hooks/immutability` rejects, and it is right to: a value a
      // component memoises should not be rewritten from a frame loop.
      const front = (mesh.material as THREE.MeshStandardMaterial[])[4];
      const wanted = erpWrittenAtProgress(progress) ? texture : unwrittenTexture;
      if (front.map !== wanted) {
        front.map = wanted;
        front.needsUpdate = true;
      }
    }

    // The focused document lifts slightly toward the camera and squares up to
    // it. Small on purpose: this is the scene pointing, not the card jumping.
    const focused = focusedDocumentAtProgress(progress) === node.id;
    const lift = focused ? 1 : 0;
    mesh.position.z += lift * 1.6;
    mesh.rotation.x *= 1 - lift * 0.75;
    mesh.rotation.y *= 1 - lift * 0.75;
    const emphasis = 1 + lift * 0.12;
    mesh.scale.setScalar(node.scale * emphasis);

    /**
     * Documents outside the run recede while scene 3 plays.
     *
     * `depthWrite` goes off with them, which matters: a faded card that still
     * writes depth punches a hole in whatever is behind it, so the run's own
     * documents would be occluded by paper you can barely see. Faded cards are
     * background and do not need to sort correctly against each other.
     *
     * `transparent` changes the shader program, so it is only assigned when it
     * actually flips — which happens twice a page, at the scene's edges.
     */
    const presence = documentPresenceAtProgress(node.id, progress);
    const faces = mesh.material as THREE.MeshStandardMaterial[];
    const wantsTransparent = presence < 0.999;
    for (const face of faces) {
      if (face.transparent !== wantsTransparent) {
        face.transparent = wantsTransparent;
        face.needsUpdate = true;
      }
      face.opacity = presence;
      face.depthWrite = !wantsTransparent;
    }
    mesh.castShadow = !wantsTransparent;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={materials}
      castShadow
      receiveShadow
    />
  );
}

export interface DocumentFieldProps {
  /** 0 = scattered (scene 1), 1 = settled into clusters (scene 4). */
  settleRef: React.RefObject<number>;
  /** Raw scrub progress, for the run scene's focus and the ledger swap. */
  progressRef: React.RefObject<number>;
  nodes?: readonly SceneNode[];
}

export function DocumentField({
  settleRef,
  progressRef,
  nodes = SCENE_NODES,
}: DocumentFieldProps) {
  // One geometry shared by every card; only the materials differ.
  const geometry = React.useMemo(
    () => new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH),
    [],
  );
  React.useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {nodes.map((node) => (
        <DocumentCardMesh
          key={node.id}
          node={node}
          settleRef={settleRef}
          progressRef={progressRef}
          geometry={geometry}
        />
      ))}
    </group>
  );
}
