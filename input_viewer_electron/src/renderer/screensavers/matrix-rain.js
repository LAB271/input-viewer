// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Matrix rain — columns of glyphs falling down the screen, brightest at the
 * leading edge and fading behind (issue #58).
 *
 * Pure fragment shader, no state. Each column's head position is a closed-form
 * function of iTime and a per-column hash, so there is nothing to simulate and
 * nothing to upload per frame. A pixel works out which column and which cell
 * within it it belongs to, then decides that cell's brightness from its
 * distance behind the head.
 *
 * The glyphs are procedural rather than a font atlas: a 5x7 dot matrix seeded
 * per cell, which at wall distance reads as katakana-ish without shipping a
 * texture. That trade is deliberate -- a real atlas would look better close up,
 * but this saver is viewed from across a room.
 *
 * Per-activation variation (iSeed): column phase and speed offsets, glyph
 * cycling rate, palette (classic green plus a few alternatives) and density.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

// Target glyph cell width in device pixels at 1080p. Columns are derived from
// canvas width so the 6000x1200 wall gets proportionally more of them rather
// than 5x-wider glyphs.
const CELL_PX = 22

const SHADER = /* glsl */ `${GLSL.hash}

// Glyph as a 5x7 dot matrix. The bit pattern is hashed per (column, cell,
// glyph-step) so each cell shows a stable glyph that changes on its own
// schedule -- the characteristic flicker of the effect.
float glyph(vec2 cellUv, float id) {
  // 5x7 grid inside the cell, with a margin so glyphs do not touch.
  vec2 g = floor(cellUv * vec2(5.0, 7.0));
  if (g.x < 0.0 || g.x > 4.0 || g.y < 0.0 || g.y > 6.0) return 0.0;
  // One hash per dot. Biased so roughly half the dots are lit, which is what
  // makes the result read as a dense character rather than sparse noise.
  float bit = rand(vec3(g.x, g.y, id));
  return bit > 0.45 ? 1.0 : 0.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // Cell size in pixels, resolved from the canvas so glyphs stay square and
  // the same physical size regardless of aspect (issue #114). Deriving columns
  // from width alone is what keeps the wall from getting stretched glyphs.
  float cellPx = ${CELL_PX}.0 * max(1.0, iResolution.y / 1080.0);
  vec2 cell = floor(fragCoord / cellPx);
  vec2 cellUv = fract(fragCoord / cellPx);

  float columns = ceil(iResolution.x / cellPx);
  float rows = ceil(iResolution.y / cellPx);

  // Per-column constants. Speed varies so columns desynchronise immediately;
  // without this the rain falls as a single horizontal front.
  float colRand = rand(cell.x + 0.5 + iSeed.x * 977.0);
  float speed = mix(4.0, 13.0, colRand);
  float phase = rand(cell.x + 91.7 + iSeed.y * 311.0) * 200.0;

  // Some columns are empty, which gives the effect its vertical rhythm.
  // Named columnLive rather than the obvious "active", which is a reserved
  // word in GLSL ES and fails to compile. (No backticks in this comment: the
  // shader is a JS template literal, so a backtick here would end the string.)
  float columnLive = rand(cell.x + 41.3 + iSeed.z * 733.0);
  float density = mix(0.62, 0.86, iSeed.w);
  if (columnLive > density) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Head position, measured in cells from the top, wrapping past the bottom.
  // The tail length is folded into the modulus so a column goes fully dark
  // before it restarts rather than the head reappearing over its own tail.
  float tail = mix(8.0, 26.0, rand(cell.x + 7.3 + iSeed.x * 53.0));
  float cycle = rows + tail;
  float head = mod((iTime + phase) * speed, cycle);

  // Distance behind the head, in cells. Row 0 is the top of the screen, but
  // fragCoord.y counts up from the bottom, so flip.
  float row = rows - 1.0 - cell.y;
  float behind = head - row;

  // Ahead of the head, or past the tail: dark.
  if (behind < 0.0 || behind > tail) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Glyph identity changes on its own clock per cell, so the trail churns.
  float flickerRate = mix(2.0, 9.0, rand(cell.x * 3.1 + cell.y * 7.7 + iSeed.z));
  float glyphStep = floor(iTime * flickerRate + rand(cell.x + cell.y * 31.0) * 10.0);
  float lit = glyph(cellUv, glyphStep + cell.x * 13.0 + cell.y * 7.0);

  // Brightness falls off behind the head. Exponential rather than linear:
  // linear gives a flat grey band, exponential gives the bright head and the
  // long dim tail the effect is known for.
  float fade = exp(-behind / (tail * 0.32));

  // The leading cell is near-white; everything behind it takes the palette
  // colour. This is the detail that makes it read as Matrix rain rather than
  // as green dots.
  float headness = smoothstep(1.6, 0.0, behind);

  // Palette. Classic green by default, with a few alternates drawn per
  // activation -- amber and cyan both read well on the wall; blue-violet is
  // dimmer so it is given more headroom below.
  vec3 base;
  float pick = iSeed.y;
  if (pick < 0.55)      base = vec3(0.16, 1.00, 0.28);  // classic green
  else if (pick < 0.75) base = vec3(1.00, 0.72, 0.18);  // amber terminal
  else if (pick < 0.90) base = vec3(0.24, 0.86, 1.00);  // cyan
  else                  base = vec3(0.68, 0.45, 1.00);  // violet

  vec3 col = mix(base, vec3(0.90, 1.00, 0.94), headness) * fade * lit;

  // Faint column glow independent of the glyph mask, so the trail reads as a
  // continuous streak rather than disconnected characters at a distance.
  col += base * fade * 0.06;

  fragColor = vec4(col, 1.0);
}
`

// Bloom on the glyph heads. Threshold is set from the measured peak rather than
// by analogy -- see the HDR-vs-LDR note in post-fx.js. This saver is mostly
// black with small very bright heads, so the bright pass has a lot of headroom.
export default createShaderScreensaver('Matrix Rain', SHADER, {
  postFX: { bloom: { threshold: 0.55, knee: 0.25, intensity: 0.42, radius: 0.8 } }
})
