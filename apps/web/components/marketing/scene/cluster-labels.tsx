"use client";

import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  CLUSTER_CENTERS,
  CLUSTER_LABELS,
  type ClusterId,
  clusterLabelOpacityAtProgress,
} from "@/lib/scene-script";

/**
 * The cluster names, shown while the camera pulls back in scene 4.
 *
 * Until now the scene has argued that HR, ERP and Finance are one connected
 * system without ever naming them — the documents carry the meaning. Naming
 * them at the pull-back is what turns "a lot of paperwork" into "these three
 * departments", which is the sentence the scene's own eyebrow is making.
 *
 * ## Drawn to a canvas, not laid over in DOM
 *
 * A DOM label would need its screen position rewritten every frame from a
 * projected world point — per-frame layout writes on a scroll, which is the
 * cost this whole section is built to avoid. A canvas texture on a
 * camera-facing plane costs one draw and moves with the scene for free.
 *
 * These are the only text in the 3D world that is not a document. They are set
 * in the same ink as the documents, and they are transparent rather than
 * emissive — a glowing label in a lit room reads as a screen.
 */

const LABEL_PIXEL_WIDTH = 512;
const LABEL_PIXEL_HEIGHT = 128;
const LABEL_WORLD_WIDTH = 9;
const LABEL_WORLD_HEIGHT = (LABEL_WORLD_WIDTH * LABEL_PIXEL_HEIGHT) / LABEL_PIXEL_WIDTH;

const INK = "#3a3d43";
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function labelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_PIXEL_WIDTH;
  canvas.height = LABEL_PIXEL_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for cluster label");

  ctx.clearRect(0, 0, LABEL_PIXEL_WIDTH, LABEL_PIXEL_HEIGHT);
  ctx.fillStyle = INK;
  ctx.font = `600 62px ${SANS}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) ctx.letterSpacing = "6px";
  ctx.fillText(text.toUpperCase(), LABEL_PIXEL_WIDTH / 2, LABEL_PIXEL_HEIGHT / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

interface LabelProps {
  cluster: ClusterId;
  progressRef: React.RefObject<number>;
  geometry: THREE.PlaneGeometry;
}

function ClusterLabel({ cluster, progressRef, geometry }: LabelProps) {
  const meshRef = React.useRef<THREE.Mesh>(null);

  const material = React.useMemo(() => {
    const texture = labelTexture(CLUSTER_LABELS[cluster]);
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Captions draw over the room rather than inside it. Without this a card
      // drifting in front of a cluster slices its name in half, which reads as
      // a clipping bug rather than as depth.
      depthTest: false,
      // Unlit on purpose, and the one exception in the room that earns it: a
      // label is a caption, not an object. Lighting it would make the words
      // dim on one side of the scene and bright on the other.
      toneMapped: false,
    });
  }, [cluster]);

  React.useEffect(() => {
    return () => {
      material.map?.dispose();
      material.dispose();
    };
  }, [material]);

  /**
   * Sits just outside its own ring, on the side facing away from the core.
   *
   * A fixed offset upward put the two bottom clusters' names in the middle of
   * the frame, next to nothing — the labels have to follow the quadrant their
   * cluster is in, not a single direction.
   */
  const centre = CLUSTER_CENTERS[cluster];
  const away = Math.sign(centre[1]) || 1;
  const position: [number, number, number] = [centre[0], centre[1] + away * 11.5, centre[2] + 2];

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const opacity = clusterLabelOpacityAtProgress(progressRef.current ?? 0);
    mesh.visible = opacity > 0.002;
    if (!mesh.visible) return;

    (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
    // Always face the reader. The camera swings a long way across scene 4, and
    // a label seen edge-on is an unreadable sliver.
    mesh.quaternion.copy(camera.quaternion);
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={position}
      // Drawn after the room, so `depthTest: false` puts it on top rather than
      // wherever the traversal order happened to place it.
      renderOrder={10}
      visible={false}
    />
  );
}

export interface ClusterLabelsProps {
  progressRef: React.RefObject<number>;
}

export function ClusterLabels({ progressRef }: ClusterLabelsProps) {
  const geometry = React.useMemo(
    () => new THREE.PlaneGeometry(LABEL_WORLD_WIDTH, LABEL_WORLD_HEIGHT),
    [],
  );
  React.useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {(Object.keys(CLUSTER_LABELS) as ClusterId[]).map((cluster) => (
        <ClusterLabel
          key={cluster}
          cluster={cluster}
          progressRef={progressRef}
          geometry={geometry}
        />
      ))}
    </group>
  );
}
