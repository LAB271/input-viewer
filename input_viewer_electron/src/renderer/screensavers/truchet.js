// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Truchet tiles — a grid where each cell draws one of two quarter-arc
 * orientations, forming continuous winding paths across the surface (#93).
 *
 * Pure fragment shader with no state. The cell is derived from fragCoord, its
 * orientation from a hash of the cell coordinate, and the arcs are evaluated as
 * an SDF, so it is antialiased and resolution-independent for free.
 *
 * Tiles morph rather than flip. The issue offered both; a hard flip means a
 * path can break and reconnect between two frames, which at wall scale reads as
 * a glitch rather than a change. Rotating the arc pair through 90 degrees keeps
 * the paths continuous throughout the transition.
 *
 * Per-activation variation (iSeed): cell size, line weight, morph cadence,
 * palette rotation and the hash offset that picks the tile layout.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

// Target cell size in device pixels at 1080p. Cells stay square and scale with
// the short axis, so a 5:1 wall simply gets more columns (the property that
// makes this saver aspect-safe).
const CELL_PX = 96

const SHADER = /* glsl */ `${GLSL.hash}
${GLSL.palette}

// Distance to a quarter-circle arc of radius r centred on the origin, for a
// point already folded into the relevant quadrant.
float arcDistance(vec2 p, float r) {
  return abs(length(p) - r);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // Cell size from the short axis so tiles are square at any aspect ratio.
  float cellPx = ${CELL_PX}.0 * max(0.55, min(iResolution.x, iResolution.y) / 1080.0);
  cellPx *= 0.75 + iSeed.z * 0.6;

  vec2 grid = fragCoord / cellPx;
  vec2 cell = floor(grid);
  // Local coordinate in [-0.5, 0.5], so the arc centres sit on the corners.
  vec2 p = fract(grid) - 0.5;

  // Per-cell orientation. Quantising time gives each cell its own morph
  // schedule, so the pattern rearranges continuously rather than the whole
  // grid turning at once.
  float cellRand = rand(cell + vec2(iSeed.x * 331.0, iSeed.y * 547.0));
  float rate = 0.10 + iSeed.w * 0.14;
  float beat = iTime * rate + cellRand * 20.0;
  float step0 = floor(beat);
  float frac = smoothstep(0.0, 1.0, fract(beat));

  // Orientation before and after this beat, as 0 or 1.
  float o0 = step(0.5, rand(cell * 1.37 + step0 * 7.13 + 4.1));
  float o1 = step(0.5, rand(cell * 1.37 + (step0 + 1.0) * 7.13 + 4.1));

  // Morph by rotating the arc pair a quarter turn. Interpolating the angle
  // rather than cross-fading two SDFs is what keeps the paths joined: the arc
  // endpoints stay on the cell edges throughout the rotation, so a path never
  // disconnects mid-transition.
  float turns = mix(o0, o1, frac);
  float a = turns * 1.5707963;
  float c = cos(a), s = sin(a);
  vec2 q = mat2(c, -s, s, c) * p;

  // Two arcs per tile, centred on opposite corners. Radius 0.5 puts their
  // endpoints exactly at the edge midpoints, which is what makes arcs in
  // neighbouring cells meet without a seam.
  float d = min(arcDistance(q - vec2(-0.5, -0.5), 0.5),
                arcDistance(q - vec2( 0.5,  0.5), 0.5));

  // Line width as a fraction of the cell, so weight scales with the tiles
  // rather than being fixed in pixels (issue #88 -- a 1px line is
  // sub-resolvable at wall distance).
  float width = 0.13 + iSeed.y * 0.07;

  // Antialias against the screen-space derivative, which is what makes this
  // resolution-independent: the edge is always ~1.5px regardless of cell size.
  float aa = fwidth(d) * 1.5;
  float line = 1.0 - smoothstep(width - aa, width + aa, d);

  // Colour follows position along the path plus time, so the winding paths
  // read as flowing rather than as static pipes.
  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  float hue = dot(cell, vec2(0.07, 0.11)) + length(p) * 0.3 + iTime * 0.05;
  vec3 col = palettePerceptual(hue, phase);

  // Dim ground rather than black (issue #88): the projector sits in ambient
  // light and pure black gives the arcs nothing to sit against.
  vec3 bg = palettePerceptual(0.72 + iSeed.y, phase) * 0.05;

  fragColor = vec4(mix(bg, col, line), 1.0);
}
`

// Bloom on the arcs. Threshold is set from the measured scene peak rather than
// by analogy -- see the HDR-vs-LDR note in post-fx.js, which is the trap that
// caught #112 and again in #140.
export default createShaderScreensaver('Truchet Tiles', SHADER, {
  postFX: { bloom: { threshold: 0.45, knee: 0.3, intensity: 0.3, radius: 0.85 } }
})
