import * as THREE from "three";

import type { DocumentCard } from "@/lib/document-cards";

/**
 * Draws a `DocumentCard` to a canvas and wraps it as a three.js texture.
 *
 * The scene's objects are readable documents rather than abstract solids, and
 * this is where that readability actually happens. Everything is drawn with the
 * 2D canvas API — no HTML-to-texture pass, no external image assets, no fonts
 * to load beyond the system stack, so a card costs a few hundred microseconds
 * once and nothing thereafter.
 *
 * ## Size
 *
 * 512 × 672 per card. That is legible on the cards nearest the camera without
 * being wasteful: twenty cards at this size is ~27MB of GPU memory, where
 * doubling to 1024-wide would be ~110MB and push low-end phones into swapping
 * textures mid-scroll.
 *
 * ## Palette
 *
 * White paper, near-black ink, one lime accent rule, amber only on approval
 * gates. There is deliberately no glow and no emissive treatment anywhere —
 * these are physical objects lit by the scene's own lights, and any self-lit
 * surface immediately reads as a screen instead of as paper.
 */

export const CARD_PIXEL_WIDTH = 512;
export const CARD_PIXEL_HEIGHT = 672;
/** Card geometry height for one unit of width. */
export const CARD_ASPECT = CARD_PIXEL_HEIGHT / CARD_PIXEL_WIDTH;

const INK = "#14161a";
const MUTED = "#8a8781";
const RULE = "#e6e3dd";
const PAPER = "#ffffff";
const LIME = "#a8dd45";
const AMBER = "#e0a233";

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** `letterSpacing` is recent; skip it rather than break on older engines. */
function withLetterSpacing(ctx: CanvasRenderingContext2D, spacing: string, draw: () => void) {
  const supported = "letterSpacing" in ctx;
  const previous = supported ? ctx.letterSpacing : undefined;
  if (supported) ctx.letterSpacing = spacing;
  draw();
  if (supported && previous !== undefined) ctx.letterSpacing = previous;
}

/** Wraps to at most `maxLines`, ellipsising the last one. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && line) lines.push(line);

  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    if (ctx.measureText(lines[maxLines - 1]).width > maxWidth) lines[maxLines - 1] = `${last}…`;
  }

  return lines;
}

function drawCard(ctx: CanvasRenderingContext2D, card: DocumentCard) {
  const W = CARD_PIXEL_WIDTH;
  const H = CARD_PIXEL_HEIGHT;
  const pad = 44;
  const accent = card.tone === "gate" ? AMBER : LIME;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // Hairline edge. Without it a white card on a light background loses its
  // silhouette entirely wherever the lighting is flat.
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Accent rule.
  ctx.fillStyle = accent;
  ctx.fillRect(pad, 46, 68, 6);

  // Kind, small caps.
  ctx.fillStyle = card.tone === "gate" ? AMBER : MUTED;
  ctx.font = `600 21px ${SANS}`;
  ctx.textBaseline = "alphabetic";
  withLetterSpacing(ctx, "1.6px", () => {
    ctx.fillText(card.kind.toUpperCase(), pad, 104);
  });

  // Title, wrapped to two lines maximum.
  ctx.fillStyle = INK;
  ctx.font = `650 42px ${SANS}`;
  const titleLines = wrapText(ctx, card.title, W - pad * 2, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, pad, 160 + i * 50));

  const afterTitle = 160 + (titleLines.length - 1) * 50;

  // Reference.
  ctx.fillStyle = MUTED;
  ctx.font = `400 23px ${MONO}`;
  ctx.fillText(card.reference, pad, afterTitle + 44);

  // Divider.
  const dividerY = afterTitle + 78;
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, dividerY);
  ctx.lineTo(W - pad, dividerY);
  ctx.stroke();

  // Rows.
  let y = dividerY + 54;
  for (const row of card.rows) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 23px ${SANS}`;
    ctx.textAlign = "left";
    ctx.fillText(row.label, pad, y);

    ctx.fillStyle = INK;
    ctx.font = `500 25px ${SANS}`;
    ctx.textAlign = "right";
    ctx.fillText(row.value, W - pad, y);
    ctx.textAlign = "left";

    y += 50;
  }

  // Total, ruled off and heavier.
  if (card.total) {
    const totalY = H - 92;
    ctx.strokeStyle = RULE;
    ctx.beginPath();
    ctx.moveTo(pad, totalY - 44);
    ctx.lineTo(W - pad, totalY - 44);
    ctx.stroke();

    ctx.fillStyle = MUTED;
    ctx.font = `500 23px ${SANS}`;
    ctx.fillText(card.total.label, pad, totalY);

    ctx.fillStyle = card.tone === "gate" ? AMBER : INK;
    ctx.font = `650 38px ${SANS}`;
    ctx.textAlign = "right";
    ctx.fillText(card.total.value, W - pad, totalY + 4);
    ctx.textAlign = "left";
  }

  // Approval gates carry a status pill, so a gate is identifiable at a
  // distance where the body text has stopped resolving.
  if (card.tone === "gate") {
    const pillW = 132;
    const pillH = 40;
    const x = W - pad - pillW;
    const pillY = 74;
    ctx.fillStyle = "#fbf1dd";
    ctx.beginPath();
    ctx.roundRect(x, pillY, pillW, pillH, 20);
    ctx.fill();
    ctx.strokeStyle = "#f0dcb4";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = AMBER;
    ctx.font = `600 19px ${SANS}`;
    ctx.textAlign = "center";
    withLetterSpacing(ctx, "1px", () => {
      ctx.fillText("WAITING", x + pillW / 2, pillY + 27);
    });
    ctx.textAlign = "left";
  }
}

const cache = new Map<string, THREE.CanvasTexture>();

/**
 * Builds (and memoises) the texture for one card.
 *
 * Cached by node id because React re-renders and Fast Refresh would otherwise
 * redraw and re-upload twenty textures on every edit.
 */
export function documentTexture(nodeId: string, card: DocumentCard): THREE.CanvasTexture {
  const existing = cache.get(nodeId);
  if (existing) return existing;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_PIXEL_WIDTH;
  canvas.height = CARD_PIXEL_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for document texture");
  drawCard(ctx, card);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Cards are viewed at a slant across most of the scene; without anisotropy
  // the body text turns to mush the moment a card is not face-on.
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  cache.set(nodeId, texture);
  return texture;
}
