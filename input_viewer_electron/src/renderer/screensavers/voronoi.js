// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Voronoi — a shattered-slate surface. A jittered grid of drifting sites
 * partitions the plane; every cell is a bevelled, tilted facet lit by a slowly
 * orbiting key light, and a fracture front sweeps across the wall every minute
 * or so, splintering the plates it passes into finer shards that then heal.
 *
 * Chosen first from the screensaver wishlist because it is the brightest,
 * highest-contrast design in the set (issue #97). That matters directly for
 * #88: the dim-on-black savers wash out under ambient light on the projector,
 * and lit facets with bright rims have far more luminance headroom than
 * particles or thin lines.
 *
 * WHAT CHANGED AND WHY (issue #174)
 *
 * The first version uploaded up to 32 CPU-integrated sites as uniforms and
 * shaded each cell as a flat pastel fill plus a rim. At 6000x1200 the world is
 * five units wide, so 32 sites meant roughly twenty cells across the wall, each
 * one 300px of near-flat mid-lightness colour. It read as a children's toy.
 * Three things are different now:
 *
 *   - Sites are procedural, one per grid bucket, found by a 3x3 neighbourhood
 *     search. Cost is O(1) per pixel regardless of how many cells are on
 *     screen, so density is a world-space constant and the wall shows *more*
 *     cells rather than bigger ones. No 32-site cap anywhere in the render path.
 *   - Cells are lit, not filled. The bisector distance gives a bevel, the bevel
 *     gives a facet normal, and the normal gets diffuse, specular and Fresnel
 *     terms from an orbiting key light plus a cool fill.
 *   - Lightness spans the OKLab ramp instead of sitting at a constant pastel L,
 *     and it is driven by a low-frequency field so neighbouring facets belong
 *     to the same tonal zone. That is what gives a 5:1 canvas light and dark
 *     regions instead of an even field of confetti.
 *
 * Still a pure fragment shader with no simulation state: everything, including
 * the fracture front's history, is an analytic function of position and time.
 *
 * Per-activation variation: cell density, drift rate, palette hue/spread/
 * chroma, bevel geometry, facet tilt, specular gain, rim gain and the fracture
 * front's speed and phase.
 */
import { createGLRuntime, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

const FRAG = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float uCellSize;    // world units per grid cell -- sets cell density
uniform float uSubDiv;      // how many shards a fractured plate breaks into
uniform float uDrift;       // angular speed of the site orbits, rad/s
uniform float uHue;         // palette centre, in turns
uniform float uHueSpread;   // analogous spread around it, in turns
uniform float uChroma;      // OKLab chroma
uniform float uAccentMix;   // fraction of cells taking the complementary hue
uniform float uBevel;       // bevel width, in cell units
uniform float uBevelHeight; // how steeply the bevel tilts the facet normal
uniform float uFacetTilt;   // per-facet plane tilt
uniform float uSpec;        // specular gain
uniform float uRimGain;     // rim brightness
uniform float uRimWidth;    // rim width, in cell units
uniform float uFrontSpeed;  // fracture front sweep, world units/s
uniform float uFrontPhase;
uniform float uLightPhase;
uniform float uLum;
out vec4 outColor;

${GLSL.worldSpace}
${GLSL.palette}
${GLSL.hash}
${GLSL.simplex2d}

// Feature point of grid cell g, in grid units.
//
// Sites orbit rather than bounce. The old CPU sites reflected off the world
// edge, which reads as a cell stalling and reversing against the frame; a
// closed orbit has no turning point to see.
//
// The orbit radius is capped below half a cell so a site never leaves its own
// bucket. That is what makes the 3x3 search in pass one correct, and it is also
// why the cells come out near-equal in area: a jittered grid at this amplitude
// already sits close to where Lloyd relaxation converges, without needing a
// relaxation pass or any CPU-side site state at all.
vec2 cellSite(vec2 g, float t) {
  vec2 a = rand2(g);
  vec2 b = rand2(g + 19.7);
  float dir = b.x < 0.5 ? -1.0 : 1.0;
  float ang = 6.28318530718 * a.x + t * uDrift * mix(0.55, 1.45, a.y) * dir;
  float rad = 0.16 + 0.26 * b.y;
  return g + 0.5 + rad * vec2(cos(ang), sin(ang));
}

// Inigo Quilez, "Voronoi edges" (2011). Pass one finds the owning site over the
// 3x3 neighbourhood; pass two measures the perpendicular distance from the
// sample point to the bisector between that site and each neighbour, over 5x5
// because a cell two buckets away can still own the nearest edge.
//
// The bisector distance is the reason for the second pass. The old shader used
// sqrt(F2) - sqrt(F1), which is not the distance to the boundary: it collapses
// toward zero near a vertex where three cells meet, so those junctions bloom
// into blobs while the middle of an edge stays thin. The bisector form gives a
// genuinely constant-width border, which is what makes it safe to filter with
// fwidth below.
//
// Distances are returned in GRID units, not world units, so every width in the
// shader is a fraction of a cell and stays correct when uCellSize changes.
void voronoiEdges(vec2 x, float t, out vec2 cellId, out vec2 toSite,
                  out float edgeDist, out vec2 edgeDir) {
  vec2 n = floor(x);
  vec2 f = x - n;

  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = cellSite(n + g, t) - n - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }

  md = 8.0;
  vec2 mdir = vec2(1.0, 0.0);
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 r = cellSite(n + g, t) - n - f;
      vec2 diff = r - mr;
      // Skip the owning site itself; anything closer than this is the same
      // point re-found, and normalize() of a zero vector is undefined.
      if (dot(diff, diff) > 1e-5) {
        vec2 dir = normalize(diff);
        float d = dot(0.5 * (mr + r), dir);
        if (d < md) { md = d; mdir = dir; }
      }
    }
  }

  cellId = n + mg;
  toSite = mr;
  edgeDist = md;
  edgeDir = mdir;
}

// Slope of the bevel at distance d from the edge: the derivative of
// smoothstep(0, w, d). Taking it analytically rather than differencing a height
// field keeps the normal smooth -- dFdx of a height is constant across each 2x2
// quad, which shows up as blocky 2px shading steps along every bevel.
float bevelSlope(float d, float w) {
  float u = clamp(d / w, 0.0, 1.0);
  return 6.0 * u * (1.0 - u) / w;
}

// Anti-aliased line of half-width w around the cell boundary. fwidth(d) is the
// world size of one pixel measured in the same units as d, so the transition is
// exactly one pixel wide at any resolution. The width is also floored at 1.5
// pixels: a purely world-space rim thins to nothing at 6000px and then crawls
// as the sites move, which was the old shader's other edge problem.
float edgeLine(float d, float w) {
  float aa = fwidth(d);
  float rw = max(w, 1.5 * aa);
  return 1.0 - smoothstep(rw - aa, rw + aa, d);
}

void main() {
  // World space, so cells are the shape they should be rather than stretched
  // 5:1 on the wall (issue #114 -- and the trap #97 explicitly warns about).
  vec2 p = worldFromFrag(gl_FragCoord.xy, iResolution.xy);
  float t = iTime;
  float halfW = 0.5 * iResolution.x / iResolution.y;

  // ---- the fracture front ------------------------------------------------
  // A front sweeps across the world in +x and re-fractures what it passes. The
  // whole thing is analytic: because the sweep is monotonic, the time since the
  // front last crossed a given column is just the wrapped distance behind it
  // divided by the speed. No per-cell state, no simulation buffer.
  //
  // The front line is bent by a slow noise term so it arrives as a ragged crack
  // rather than a vertical wipe.
  float span = 2.0 * halfW + 0.8;
  float bend = 0.30 * snoise(vec2(p.y * 1.4, t * 0.05));
  float age = mod(t * uFrontSpeed + uFrontPhase - (p.x + bend + halfW + 0.4), span)
            / uFrontSpeed;

  // Fracture rises within half a second of the front passing, then heals with a
  // ~5s half-life. That deliberately keeps the shattered zone as a BAND trailing
  // the front -- roughly a world unit wide, so about a fifth of the wall -- and
  // not a state the whole surface is in. Healing an order of magnitude slower
  // was the first thing tried and it left every plate permanently splintered,
  // which is just a denser Voronoi with extra steps.
  float heal = smoothstep(0.0, 0.5, age) * exp(-age * 0.135);
  // Narrow Gaussian at the front itself, pushed well past 1.0 so the post
  // chain's bright pass picks it out as a travelling glowing crack.
  float front = exp(-age * age * 5.0);

  // ---- the plates --------------------------------------------------------
  vec2 cid, mr, edir;
  float ed;
  voronoiEdges(p / uCellSize, t, cid, mr, ed, edir);

  vec2 c1 = rand2(cid);
  vec2 c2 = rand2(cid + 5.3);
  vec2 c3 = rand2(cid + 91.1);

  // Per-cell fracture. Scaling by a per-cell random staggers the shattering, so
  // plates splinter at visibly different moments instead of in lockstep, and
  // the low-draw cells never fully break up. The subtracted floor matters: an
  // exponential never reaches zero, and a 5%-strength shard layer is still
  // clearly visible as texture, so without it the "healed" half of the wall was
  // never actually a plain plate.
  float fr = clamp((heal * (0.45 + 1.25 * c3.x) - 0.09) / 0.91, 0.0, 1.0);

  // ---- the shards --------------------------------------------------------
  // Second Voronoi layer at uSubDiv times the frequency, offset so its lattice
  // does not sit on top of the coarse one. Only evaluated where a plate is
  // actually fractured; the branch is coherent because fr is constant per
  // plate, so a wavefront takes one side or the other.
  float sd = 8.0;
  vec2 sdir = vec2(1.0, 0.0);
  vec2 sid = vec2(0.0), smr = vec2(0.0);
  if (fr > 0.01) {
    voronoiEdges((p + vec2(11.3, 7.9)) * uSubDiv / uCellSize, t * 1.3,
                 sid, smr, sd, sdir);
  }

  // ---- surface normal ----------------------------------------------------
  // Each facet is a flat plane with its own tilt, so the key light rakes across
  // them at different angles and some catch it nearly head-on. That per-facet
  // tilt is most of the value range in the image; the bevel supplies the rest.
  vec2 tilt = (c2 - 0.5) * uFacetTilt;
  // Plates breathe: a slow per-cell modulation of the bevel depth, so the
  // surface keeps moving even between fracture fronts.
  float lift = uBevelHeight * (0.68 + 0.5 * sin(t * 0.13 + 6.28318530718 * c1.y));
  vec2 grad = edir * bevelSlope(ed, uBevel) * lift;
  if (fr > 0.01) {
    grad += sdir * bevelSlope(sd, uBevel * 0.55) * lift * 0.8 * fr;
  }
  // Surface grain. A perfectly flat facet reads as plastic; a shallow gradient
  // of noise on the normal gives it the slightly uneven cleave of stone. Taken
  // as a central difference of simplex rather than of a value-noise field, so
  // there is no axis-aligned lattice in the highlight.
  // The amplitude is deliberately tiny. At 0.035 the specular broke into a
  // regular field of little highlights and the whole surface read as glazed
  // ceramic tile; 0.010 leaves the same unevenness in the diffuse without
  // giving the highlight anything to catch on, which is also what keeps it from
  // crawling at 6000px.
  const vec2 ge = vec2(0.006, 0.0);
  vec2 gq = p * 30.0;
  vec2 grain = vec2(snoise(gq + ge.xy) - snoise(gq - ge.xy),
                    snoise(gq + ge.yx) - snoise(gq - ge.yx)) / (2.0 * ge.x);
  vec3 nrm = normalize(vec3(tilt + grad + grain * 0.010, 1.0));

  // ---- palette -----------------------------------------------------------
  // Cell centre in world space, used to sample the tonal field. mr is the
  // vector from the sample point to the owning site, in grid units.
  vec2 cellPos = p + mr * uCellSize;

  // Lightness is mostly a low-frequency field sampled at the cell centre, with
  // a per-cell jitter on top. Independent per-cell randomness gives confetti;
  // sampling a field makes neighbouring facets belong to the same tonal zone,
  // so a 5:1 canvas reads as lit regions of stone with dark ground between them
  // rather than as an undifferentiated wall of texture.
  float zone = 0.5 + 0.5 * snoise(cellPos * 0.5 + vec2(t * 0.015, 0.0));
  float lc = clamp(0.05 + 0.58 * zone * zone + 0.20 * (c1.y - 0.5), 0.03, 0.78);
  // Roughly one facet in eight is polished: near the top of the ramp and far
  // glossier. These are the near-white plates the design needs to have any
  // highlights at all -- the tonal field alone is biased dark by the squared
  // term above, and without a deliberate top end the image has no peak.
  float polish = step(0.87, c3.y);
  lc = mix(lc, min(0.93, lc + 0.34), polish);
  // Fractured shards drift apart in lightness, which is what makes a shattered
  // region read as many pieces rather than one textured plate.
  if (fr > 0.01) lc = clamp(lc + (rand(sid) - 0.5) * 0.34 * fr, 0.02, 0.93);

  // Analogous hue family, tracking the tonal field so colour varies at the same
  // large scale as value. A small share of cells take the complementary hue --
  // one accent in a family of near neighbours is what stops a limited palette
  // reading as monochrome mud.
  float hue = uHue + (zone - 0.5) * uHueSpread * 1.2 + (c1.x - 0.5) * uHueSpread * 0.5;
  if (c2.y < uAccentMix) hue += 0.45;
  // Chroma comes down as lightness goes up: near-white facets are where sRGB
  // gamut runs out first, and a clipped channel there would flatten exactly the
  // highlights the design depends on.
  vec3 albedo = oklabRamp(hue, lc, uChroma * (1.0 - 0.5 * lc), 0.0);

  // ---- lighting ----------------------------------------------------------
  // Key light orbits once every ~140s. Slow enough that it is never seen to
  // move, fast enough that the facet that was brightest a minute ago is not the
  // brightest one now.
  float ang = t * 0.045 + 6.28318530718 * uLightPhase;
  vec3 key = normalize(vec3(cos(ang) * 0.85, sin(ang) * 0.5, 0.55));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 half3 = normalize(key + view);

  float diff = max(dot(nrm, key), 0.0);
  float spec = pow(max(dot(nrm, half3), 0.0), 48.0);
  float fres = pow(1.0 - max(nrm.z, 0.0), 4.0);

  // Contact darkening in the bevel trough. Without it the albedo step across a
  // cell boundary is a hard aliased edge wherever the rim happens to be dim;
  // with it, the step happens inside a dark groove and reads as grout.
  float ao = 0.22 + 0.78 * smoothstep(0.0, uBevel * 0.9, ed);
  if (fr > 0.01) ao *= mix(1.0, 0.30 + 0.70 * smoothstep(0.0, uBevel * 0.5, sd), fr);

  // Large-scale pools of key light travelling slowly across the surface. This
  // is composition, not shading: at 5:1 an evenly lit field of facets has
  // nowhere for the eye to rest.
  float pool = 0.5 + 0.9 * (0.5 + 0.5 * snoise(p * 0.28 + vec2(t * 0.02, -t * 0.01)));

  vec3 keyCol = vec3(1.06, 0.99, 0.90);   // slightly warm
  vec3 fillCol = vec3(0.30, 0.38, 0.55);  // cool sky fill, so shadowed facets
                                          // are tinted rather than dead grey
  vec3 col = albedo * ao * (fillCol * 0.60 + keyCol * diff * pool * 1.25);
  // Gloss tracks lightness, and the polished facets get several times more --
  // this is the term that writes past 1.0 and so the one bloom actually sees.
  col += keyCol * spec * uSpec * (0.30 + 1.0 * lc) * (1.0 + 2.6 * polish) * pool;
  col += albedo * fres * 0.30;

  // ---- rims --------------------------------------------------------------
  // Rims are LIT, not drawn. An unconditional bright outline on every cell was
  // the single biggest thing making this read as mosaic wallpaper: it draws the
  // whole tessellation at equal weight, so the eye gets a uniform net instead of
  // a surface. Weighting each edge by how its own bevel faces the key light
  // means only the edges turned toward the light catch it, exactly as a real
  // chamfer would, and the net dissolves into form.
  float rim = edgeLine(ed, uRimWidth);
  float rimLit = rim * (0.14 + 1.25 * max(dot(normalize(vec3(edir * 1.7, 1.0)), key), 0.0));
  if (fr > 0.01) {
    float srim = edgeLine(sd, uRimWidth * 0.75) * fr;
    rim = max(rim, srim);
    rimLit = max(rimLit,
      srim * (0.14 + 1.25 * max(dot(normalize(vec3(sdir * 1.7, 1.0)), key), 0.0)));
  }
  // The rim is the cell's own hue lifted well up the lightness ramp rather than
  // plain white, so the edges stay inside the palette instead of washing it out.
  vec3 rimCol = oklabRamp(hue + 0.02, min(0.96, lc + 0.42), uChroma * 0.45, 0.0);
  col += rimCol * rimLit * uRimGain;

  // The travelling crack: every rim flares, lit or not -- the crack is its own
  // light source, so it is the one place the unweighted rim is correct. Plus a
  // faint wash so the front stays legible crossing a large unbroken plate.
  col += rimCol * rim * front * 4.0;
  col += vec3(1.00, 0.82, 0.60) * front * 0.09;

  outColor = vec4(col * uLum, 1.0);
}`

export default {
  name: 'Voronoi',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let prog = null, post = null

    const rng = createRng(seedValue)

    // Cell density is set as rows across the SHORT axis, because that is the
    // one dimension the wall shares with a desk monitor: world space is
    // aspect x 1, so a constant cell size in world units automatically gives a
    // 5:1 canvas five times as many cells rather than five times wider ones.
    //
    // 5 rows is about 25 plates across the wall, 7.5 about 38 -- against the
    // roughly 20 the old 32-site cap managed at ITS most generous. The band the
    // fracture front leaves behind subdivides those again by uSubDiv, so the
    // wall carries two distinct scales at once rather than one even grid. Going
    // denser than ~8 rows was tried and reads as crazy paving: the bevels and
    // rims start to dominate the fill and the plates stop being plates.
    const rows = rng.range(5.0, 7.5)
    const cellSize = 1.0 / rows
    // Non-integer, so the shard lattice never lines up with the plate lattice.
    const subDiv = rng.range(2.6, 3.7)

    // Radians per second of the site orbits. At 0.2 rad/s a site takes ~30s to
    // come round, which moves the boundaries visibly without letting cells
    // trade territory fast enough to flicker (#97 flags that specifically).
    const drift = rng.range(0.10, 0.24)

    const hue = rng.next()
    // Deliberately narrow. A wide spread here is what made the first version
    // look like sugar paper: an analogous family plus a few complementary
    // accents reads as one material under one light, which a full hue wheel
    // never does.
    const hueSpread = rng.range(0.05, 0.13)
    // Bounded by the gamut measurement in glsl-lib's palettePerceptual notes:
    // past ~0.13 the brighter facets start clipping a channel.
    const chroma = rng.range(0.085, 0.125)
    const accentMix = rng.range(0.03, 0.09)

    // Bevel width as a fraction of a cell, and the tilt it applies to the facet
    // normal. These two are tuned together and cannot be varied independently:
    // the peak slope of the profile is 1.5/bevel, so the tilt at the steepest
    // point is bevelHeight * 1.5 / bevel, and it is that product -- not either
    // number -- that decides how a chamfer reads.
    //
    // The first pass used 0.13 / 2.2, which keeps the product right but spreads
    // the shoulder over a third of the way to the cell centre. The result was
    // plates that looked like inflated cushions rather than cut stone: there was
    // no flat top left. Narrowing the bevel and scaling the height down with it
    // holds the chamfer's contrast while giving each plate a genuinely flat face.
    const bevel = rng.range(0.05, 0.09)
    const bevelHeight = rng.range(0.8, 1.5)
    const facetTilt = rng.range(0.22, 0.42)
    const spec = rng.range(1.1, 2.3)
    const rimGain = rng.range(0.45, 0.95)
    // In cell units. The shader floors this at 1.5px, so on a desk monitor the
    // pixel floor usually wins and on the wall this value does.
    const rimWidth = rng.range(0.010, 0.020)

    // World units per second. The wall is 5 units wide, so 0.055-0.10 puts a
    // full sweep between roughly 60 and 105 seconds.
    const frontSpeed = rng.range(0.055, 0.10)
    // Offset so an activation does not always begin just as a front arrives.
    const frontPhase = rng.range(0.0, 6.0)
    const lightPhase = rng.next()

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl

        prog = runtime.createQuadProgram(FRAG)
        const u = createUniformCache(gl, prog.program)

        // Bloom on the speculars and the fracture front, which are the only
        // things written past 1.0. The cell bodies peak well below that, so the
        // fill does not glow -- only the lit edges and the highlights, which is
        // where the contrast is.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 0.90 * luminanceScale(canvas),
            knee: 0.35,
            intensity: 0.35,
            radius: 0.9,
          },
          tonemap: 'aces',
          dither: true,
        })

        runtime.start((time, frame) => {
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }

          prog.draw(time, frame, (g) => {
            g.uniform1f(u('uCellSize'), cellSize)
            g.uniform1f(u('uSubDiv'), subDiv)
            g.uniform1f(u('uDrift'), drift)
            g.uniform1f(u('uHue'), hue)
            g.uniform1f(u('uHueSpread'), hueSpread)
            g.uniform1f(u('uChroma'), chroma)
            g.uniform1f(u('uAccentMix'), accentMix)
            g.uniform1f(u('uBevel'), bevel)
            g.uniform1f(u('uBevelHeight'), bevelHeight)
            g.uniform1f(u('uFacetTilt'), facetTilt)
            g.uniform1f(u('uSpec'), spec)
            g.uniform1f(u('uRimGain'), rimGain)
            g.uniform1f(u('uRimWidth'), rimWidth)
            g.uniform1f(u('uFrontSpeed'), frontSpeed)
            g.uniform1f(u('uFrontPhase'), frontPhase)
            g.uniform1f(u('uLightPhase'), lightPhase)
            g.uniform1f(u('uLum'), luminanceScale(canvas))
          })

          if (post) post.present()
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (prog) { prog.destroy(); prog = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      },
    }
  },
}
