"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { SCENE_NODES, type SceneNode } from "@/lib/scene-script";
import { cardFor } from "@/lib/document-cards";
import { CARD_ASPECT, documentTexture } from "@/components/marketing/scene/document-texture";

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

/** Card width in world units. Height follows the texture's aspect. */
const CARD_WIDTH = 3.4;
const CARD_HEIGHT = CARD_WIDTH * CARD_ASPECT;
/** Enough for a real shadow and a visible edge; paper, not cardboard. */
const CARD_DEPTH = 0.06;

interface CardProps {
  node: SceneNode;
  settleRef: React.RefObject<number>;
  geometry: THREE.BoxGeometry;
}

function DocumentCardMesh({ node, settleRef, geometry }: CardProps) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const card = React.useMemo(() => cardFor(node.id), [node.id]);
  const texture = React.useMemo(() => documentTexture(node.id, card), [node.id, card]);

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
    const front = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.88 });
    return [edge, edge, edge, edge, front, back];
  }, [texture]);

  React.useEffect(() => {
    return () => materials.forEach((material) => material.dispose());
  }, [materials]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const t = clock.getElapsedTime();
    const settle = settleRef.current ?? 0;
    const drift = 1 - settle * 0.85;

    const [sx, sy, sz] = node.scattered;
    const [hx, hy, hz] = node.home;

    mesh.position.set(
      sx + (hx - sx) * settle + Math.sin(t * 0.26 + node.phase) * 0.9 * drift,
      sy + (hy - sy) * settle + Math.cos(t * 0.21 + node.phase * 1.4) * 0.75 * drift,
      sz + (hz - sz) * settle + Math.sin(t * 0.18 + node.phase * 0.7) * 0.8 * drift,
    );

    // Small oscillation about a face-on base pose — enough to feel weightless,
    // never enough to turn the text away from the reader.
    mesh.rotation.set(
      Math.sin(t * 0.22 + node.phase) * 0.14,
      Math.sin(t * 0.17 + node.phase * 1.3) * 0.28,
      Math.sin(t * 0.13 + node.phase * 0.8) * 0.06,
    );
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={materials}
      scale={node.scale}
      castShadow
      receiveShadow
    />
  );
}

export interface DocumentFieldProps {
  /** 0 = scattered (scene 1), 1 = settled into clusters (scene 4). */
  settleRef: React.RefObject<number>;
  nodes?: readonly SceneNode[];
}

export function DocumentField({ settleRef, nodes = SCENE_NODES }: DocumentFieldProps) {
  // One geometry shared by every card; only the materials differ.
  const geometry = React.useMemo(
    () => new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH),
    [],
  );
  React.useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {nodes.map((node) => (
        <DocumentCardMesh key={node.id} node={node} settleRef={settleRef} geometry={geometry} />
      ))}
    </group>
  );
}
