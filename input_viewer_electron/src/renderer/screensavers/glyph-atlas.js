// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Shared glyph atlas for the text-rendering screensavers.
 *
 * Issues #89 (ASCII doughnut) and #92 (split-flap board) both need characters
 * on screen, and #92 says explicitly that the two should share one solution
 * rather than solving it twice. This is that solution.
 *
 * **Why an atlas rather than rasterising each frame.** The shared screensaver
 * canvas is WebGL2 for its whole life (gl-base.js), so `getContext('2d')` on it
 * returns null once any GL saver has run -- text has to reach the screen through
 * GL either way. The two ways are: rasterise the whole frame in 2D and upload it
 * per frame, or bake the glyphs once and index them in the shader. The glyph
 * shapes never change, so baking wins: a per-frame upload at 6000x1200 is the
 * dominant cost of a saver that otherwise does almost nothing.
 *
 * The atlas is drawn on a *detached* canvas that is never added to the DOM,
 * which is what keeps the one-context invariant intact.
 */

/**
 * Rasterise a character set into a single-row texture atlas.
 *
 * Cells are laid out left to right in the order the characters appear in `chars`,
 * so a shader indexes glyph i at u = (i + localU) / chars.length.
 *
 * @param {string} chars characters to bake, in ramp/index order
 * @param {object} [options]
 * @param {number} [options.cellPx=64] atlas cell size; the upper bound on how
 *   crisp a glyph can be when scaled up to a wall-sized cell
 * @param {number} [options.fontScale=0.82] glyph size as a fraction of the cell
 * @param {string} [options.family='monospace'] a monospace family keeps every
 *   glyph in an identical box, which is what makes a fixed grid line up
 * @param {number} [options.baselineBias=0.54] vertical centre as a fraction of
 *   the cell; slightly below 0.5 because textBaseline 'middle' sits optically
 *   high for most faces
 * @returns {HTMLCanvasElement|null} null when no 2D context is available
 */
export function buildGlyphAtlas(chars, options = {}) {
  const {
    cellPx = 64,
    fontScale = 0.82,
    family = 'monospace',
    baselineBias = 0.54
  } = options

  const canvas = document.createElement('canvas')
  canvas.width = cellPx * chars.length
  canvas.height = cellPx
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.font = `${Math.round(cellPx * fontScale)}px ${family}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], (i + 0.5) * cellPx, cellPx * baselineBias)
  }
  return canvas
}

/**
 * Upload a baked atlas as a GL texture, with the filtering these savers want.
 *
 * LINEAR so glyph edges stay smooth when a 64px cell is scaled up to a
 * wall-sized one; CLAMP_TO_EDGE so sampling at a cell boundary cannot bleed in
 * the neighbouring glyph, which shows up as ghost characters.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {HTMLCanvasElement} atlas
 * @param {string} chars the set baked into the atlas, used to size a mip cap
 * @returns {WebGLTexture}
 */
export function uploadGlyphAtlas(gl, atlas, chars) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas)
  // Mipmaps, and a mip-aware minification filter.
  //
  // A glyph is minified whenever a tile is smaller than the 64px atlas cell,
  // and during a flap the falling half compresses it further still. Sampling a
  // 64px row into a handful of screen pixels with plain LINEAR aliases badly:
  // the strokes beat against the pixel grid and throw moving horizontal bands
  // across the board. LINEAR_MIPMAP_LINEAR picks an appropriate mip instead.
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // Cap the mip level so glyphs cannot bleed into each other.
  //
  // The atlas is one row of cells, so each mip halves the cell width as well
  // as its height. Below about 4px per cell, adjacent characters merge and a
  // tile shows a smear of two glyphs. Allowing mips down to 1x1 would trade
  // the aliasing bands for that, which is no better.
  const cellPxAtMip = (level) => (atlas.width >> level) / chars.length
  let maxLevel = 0
  while (cellPxAtMip(maxLevel + 1) >= 4 && (atlas.height >> (maxLevel + 1)) >= 1) {
    maxLevel++
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

/** The split-flap character set: blank, A-Z, 0-9, and a few separators. */
export const FLAP_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:'

/** The classic donut.c luminance ramp, dimmest to brightest. */
export const ASCII_RAMP = '.,-~:;=!*#$@'
