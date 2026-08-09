// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Metaballs — a lit, refracting fluid rather than a set of shaded discs
 * (issues #99, #175).
 *
 * The original was a pure fragment shader that summed an inverse-square field,
 * indexed a palette by the *raw* field value and shaded a screen-space 2D
 * gradient. Issue #175 dissects why that failed at wall aspect: unbounded field
 * -> hue sweeping most of the wheel inside a single blob (concentric rainbow
 * rings), a flat `palette * 0.07` background that landed on brown across 85% of
 * a 6000x1200 frame, and ten fixed blobs too small to ever merge. This is a
 * rewrite, not a tune.
 *
 * WHAT REPLACES IT
 *
 * The field is treated as a genuine 3D implicit surface,
 *
 *   F(x, y, z) = sum_i  r_i^2 / (|xy - c_i|^2 + z^2)
 *
 * with all centres in the z = 0 plane, viewed orthographically from +z. In
 * u = z^2 that is a sum of r_i^2/(a_i + u): strictly decreasing and strictly
 * convex, so Newton's method started at u = 0 converges monotonically upward on
 * the isosurface and cannot overshoot. Four steps beats any raymarch here on
 * both cost and quality, and it yields three things the 2D version could not:
 *
 *   - a real 3D normal (the analytic gradient at the solved point), so
 *     specular, Fresnel and refraction all have something correct to work with;
 *   - an exact optical thickness, 2z, because the field is symmetric about
 *     z = 0 and the view is orthographic. That drives Beer-Lambert absorption,
 *     which is what gives interior depth: clear at the rim, deeply coloured in
 *     the middle;
 *   - analytic coverage from fwidth of the 2D slice, so the silhouette is
 *     antialiased without supersampling.
 *
 * Colour is indexed by *blob identity blended by weight*, which is bounded in
 * [0,1) by construction, mapped onto a narrow OKLab hue arc. There is no
 * quantity with an open range anywhere near the palette any more.
 *
 * Blobs are integrated on the CPU and uploaded as uniforms rather than being
 * evaluated from closed-form paths in the shader. That is a deliberate reversal
 * of the old design: the inner field loop now runs six times per fluid pixel
 * (one slice, four Newton steps, one gradient), and per-blob hashes and
 * sin/cos inside it would dominate the frame cost. It also buys real pair
 * forces, so the blobs genuinely coalesce and separate instead of sliding past
 * each other on independent Lissajous curves.
 *
 * Per-activation variation comes from createRng in create() (the JS-side
 * contract, as in voronoi.js) rather than from iSeed: this is no longer a pure
 * fragment saver, and the blob layout, count, palette arc, fluid density and
 * lamp path all have to be decided on the CPU anyway.
 */
import { createGLRuntime, luminanceScale } from './gl-base.js'
import { GLSL, canvasAspect, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// Upper bound on blobs. GLSL ES 3.00 wants a constant loop bound; uCount masks
// off the unused tail. 24 covers the 5:1 wall at the densities below; the field
// loop runs six times per fluid pixel, so this is the number that sets the
// worst-case fragment cost.
const MAX_BLOBS = 24

// Newton steps for the surface solve. The iteration is monotone from below on a
// convex decreasing function, so this is a precision knob and nothing else --
// but it has to be run to convergence rather than to "close enough".
//
// The starting guess (see u0 in the shader) is the largest single-blob
// solution, and WHICH blob that is changes discontinuously across the frame. An
// unconverged iterate therefore carries a different residual either side of
// that switch, which draws a hairline contour across merged blobs. Four steps
// showed it; six does not.
const NEWTON_STEPS = 6

// Isosurface level. Below 1.0 the visible radius of an isolated blob is
// r/sqrt(ISO) — larger than r — and the field reaches further, so blobs meet
// and merge sooner. 0.6 is where the merges read as a fluid rather than as
// discs touching, without collapsing the whole wall into one sheet.
const ISO = 0.6

const TAU = Math.PI * 2

const FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 iResolution;
uniform float iTime;
uniform vec4 uBlobs[${MAX_BLOBS}];  // xy = centre (world), z = radius^2, w = hue key
uniform int uCount;
uniform float uHueBase;    // centre of the fluid's hue arc, in turns
uniform float uHueSpread;  // width of that arc, in turns
uniform float uDensity;    // Beer-Lambert sigma scale
uniform float uScatter;    // in-scattering gain
uniform float uRefract;    // refraction displacement gain
uniform float uRipple;     // surface ripple amplitude
uniform vec2 uLamp;        // lamp centre, world space
uniform float uLampR;      // lamp radius, world units (a fraction of the width)
uniform float uLampGain;
uniform float uCaustic;
uniform float uLum;
out vec4 outColor;

${GLSL.worldSpace}
${GLSL.palette}
${GLSL.simplex2d}

const float EPS = 1e-4;
const float ISO = ${ISO.toFixed(3)};

// Thin bright filaments, the pattern light makes on the floor of a pool.
//
// |noise| has a crease along every zero crossing of the noise; raising that
// crease to a power thins it into a filament. Two layers, the second
// domain-warped by the first so they do not cross on a regular lattice.
//
// The layers are MULTIPLIED as well as summed, and that is the whole look. Two
// summed ridge fields draw two independent sets of closed loops, which read as
// worms crawling on the backdrop — the first two attempts both did exactly
// that. The product lights up only where two ridges cross, giving bright knots
// strung along dimmer filaments, which is what a caustic web actually is.
//
// The domain is anisotropic (x compressed relative to y) so the filaments run
// long and horizontal, with the frame rather than across it. Frequencies are in
// world units and low — a filament is ~150px wide on the 6000x1200 wall — so
// nothing here can crawl or alias.
float caustics(vec2 q, float t) {
  vec2 w = q * vec2(1.9, 3.6) + vec2(t * 0.021, -t * 0.014);
  float a = snoise(w);
  float b = snoise(w * 1.63 + vec2(4.7, -2.3) + a * 0.45);
  float ridgeA = pow(clamp(1.0 - abs(a), 0.0, 1.0), 6.0);
  float ridgeB = pow(clamp(1.0 - abs(b), 0.0, 1.0), 6.0);
  return ridgeA * 0.55 + ridgeA * ridgeB * 2.4;
}

// The room behind the fluid. Also the source the refraction samples, which is
// why it has to have structure: bending a flat field produces a flat field.
//
// Issue #88 wanted washout headroom and the old code answered it with a flat
// tinted grey. The answer here is a bright *localised* source plus caustics on
// an otherwise near-black floor: the same headroom, from something to look at.
vec3 backdrop(vec2 q, float t) {
  vec2 ext = worldExtent(iResolution.x / iResolution.y);

  // Vertical gradient. Both ends are dark — the bottom is fractionally warmer,
  // which reads as depth rather than as a tint because it never gets near grey.
  float v = clamp(q.y / (2.0 * ext.y) + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.018, 0.019, 0.028), vec3(0.003, 0.005, 0.013),
                 smoothstep(0.0, 1.0, v));

  // The lamp. One broad soft source drifting behind the fluid, which is what
  // gives a 5:1 frame a bright end and a dark end instead of a uniform field,
  // and what the refraction has something to bend. Two Gaussians rather than a
  // disc: no edge, so nothing to alias, and a tight core inside a wide halo.
  // Falloff is measured in units of uLampR, which the CPU sets as a fraction of
  // the world WIDTH. A radius fixed in world units is a pool on the 5:1 wall
  // and a full-frame wash at 16:9 — and a full-frame warm wash is precisely the
  // flat brown field this rewrite exists to remove. Scaling with the frame
  // keeps it a pool at both aspects, with genuinely black space beside it.
  vec2 dl = q - uLamp;
  float s = dot(dl, dl) / (uLampR * uLampR);
  float lamp = exp(-s * 4.0) * 0.62 + exp(-s * 1.0) * 0.18;
  col += uLampGain * lamp * vec3(1.00, 0.70, 0.44);

  // Caustics, gated on the lamp. Light has to come from somewhere for a caustic
  // to exist, and gating them keeps the dark end of the wall genuinely dark
  // instead of textured everywhere at equal strength.
  col += uCaustic * caustics(q, t) * exp(-s * 0.85) * vec3(0.50, 0.68, 1.00);

  // Per-axis vignette. A radial one is wrong at 5:1 — it would darken the outer
  // thirds of the wall to nothing. Cubed, so it only bites near the edges.
  float vx = 1.0 - 0.50 * pow(clamp(abs(q.x) / ext.x, 0.0, 1.0), 3.0);
  float vy = 1.0 - 0.38 * pow(clamp(abs(q.y) / ext.y, 0.0, 1.0), 3.0);
  return col * vx * vy;
}

// Environment sampled by the reflected direction: a dark room with one bright
// source above. The Fresnel rim picks up a glint that slides as the surface
// curves, rather than a flat tint, and the glint is written well above 1.0 so
// the bloom has something real to select.
//
// Under an orthographic view the reflected ray turns to face *away* from the
// camera as the surface approaches its silhouette (n.z -> 0 gives rd.z -> -1),
// so at the rim it is looking back into the scene. Blending toward the local
// backdrop there is both what the geometry says and what fixes the look: a
// constant dark sky drew a uniform grey outline around every blob, which read
// as a sticker edge rather than as a meniscus. Now the rim is bright where it
// sits over the lamp and dark where it does not.
// Capillary ripple on the surface normal.
//
// A perfectly smooth implicit surface reads as moulded plastic, and the tell is
// that every specular highlight is a clean oval. Perturbing the normal by the
// gradient of a slow noise field breaks the highlights up and gives the body
// some internal movement, without touching the silhouette — the amplitude is
// faded out as the surface turns edge-on (n.z -> 0) so the outline stays clean.
//
// The field is coarse (about 200px per ripple on the wall) and drifts slowly,
// which is what keeps it from shimmering or crawling at that size.
vec3 rippleNormal(vec3 n, vec2 q, float t, float amp) {
  const float e = 0.02;
  vec2 w = q * 5.5 + vec2(t * 0.012, t * 0.045);
  float gx = snoise(w + vec2(e, 0.0)) - snoise(w - vec2(e, 0.0));
  float gy = snoise(w + vec2(0.0, e)) - snoise(w - vec2(0.0, e));
  return normalize(n + amp * smoothstep(0.0, 0.30, n.z) * vec3(gx, gy, 0.0));
}

vec3 environment(vec3 rd, vec3 keyDir, vec3 behindCol) {
  vec3 sky = mix(vec3(0.008, 0.012, 0.026), vec3(0.10, 0.13, 0.21),
                 rd.y * 0.5 + 0.5);
  vec3 env = mix(behindCol * 1.25, sky, smoothstep(-0.35, 0.35, rd.z));
  return env + vec3(1.00, 0.86, 0.72) * pow(max(dot(rd, keyDir), 0.0), 48.0) * 5.0;
}

void main() {
  vec2 p = worldFromFrag(gl_FragCoord.xy, iResolution.xy);
  float t = iTime;
  vec3 bg = backdrop(p, t);

  // ---- the field on the z = 0 slice -------------------------------------
  // u0 is the Newton seed: for blob i alone, r^2/(a + u) = ISO solves exactly
  // at u = r^2/ISO - a. Adding the other blobs only raises the field, so the
  // true root is at or above the largest single-blob solution -- which makes
  // this both a valid starting point (F(u0) >= ISO) and a tight one.
  //
  // Starting at u = 0 instead is what put a dimple at the centre of every blob
  // on the first attempt: there F is ~10^2 with a slope of ~10^6, so a Newton
  // step advances u by ~10^-4 and four steps never reach r^2.
  float f0 = 0.0;
  float u0 = 0.0;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= uCount) break;
    vec2 d = p - uBlobs[i].xy;
    float a = dot(d, d) + EPS;
    f0 += uBlobs[i].z / a;
    u0 = max(u0, uBlobs[i].z / ISO - a);
  }

  // Analytic coverage across the silhouette: one field-unit of change per pixel
  // is exactly one pixel of edge. fwidth is evaluated HERE, before the early
  // out below — derivatives taken in control flow that only part of a quad
  // enters are undefined, and this saver's silhouette is where that would show.
  float cov = clamp((f0 - ISO) / max(fwidth(f0), 1e-5) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) {
    outColor = vec4(bg * uLum, 1.0);
    return;
  }

  // ---- solve for the surface height -------------------------------------
  // In u = z^2 the field is sum r_i^2/(a_i + u): decreasing and convex, so a
  // Newton step from a point where F > ISO lands on the tangent, which lies
  // below F, and therefore short of the root. The iterate is monotone upward
  // and always stays inside the surface — no bracketing, no fallback.
  float u = u0;
  for (int k = 0; k < ${NEWTON_STEPS}; k++) {
    float f = 0.0;
    float fp = 0.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
      if (i >= uCount) break;
      vec2 d = p - uBlobs[i].xy;
      float inv = 1.0 / (dot(d, d) + u + EPS);
      float q = uBlobs[i].z * inv;
      f += q;
      fp -= q * inv;
    }
    u = max(u + (f - ISO) / max(-fp, 1e-5), 0.0);
  }
  float z = sqrt(u);

  // Optical thickness. Exact rather than estimated: the field is symmetric
  // about z = 0 and the view is orthographic, so a ray enters at +z and leaves
  // at -z. This is what makes the interior depth physical instead of painted.
  float thickness = 2.0 * z;

  // ---- normal and blob identity at the surface point ---------------------
  vec3 sp = vec3(p, z);
  vec3 grad = vec3(0.0);
  float identNum = 0.0;
  float identDen = 1e-6;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= uCount) break;
    vec3 d = sp - vec3(uBlobs[i].xy, 0.0);
    float a = dot(d, d) + EPS;
    float w = uBlobs[i].z / a;
    // -grad F points out of the surface; the constant factor drops out in the
    // normalize. A true 3D normal, not the screen-space gradient the old code
    // used, which shaded the silhouette and made every blob a bevelled disc.
    grad += w * d / a;
    // Blob identity, weighted by the square of each blob's contribution so a
    // blob keeps its own colour except in the necks between merged ones.
    //
    // A plain weighted mean of the keys, NOT a circular one. Blending hue as a
    // direction on the wheel cancels to zero wherever two near-opposite keys
    // meet, and the resulting atan is discontinuous there -- that showed as
    // hard straight seams cutting across merged blobs on the first attempt.
    float w2 = w * w;
    identNum += w2 * uBlobs[i].w;
    identDen += w2;
  }
  vec3 n = rippleNormal(normalize(grad), p, t, uRipple);

  // BOUNDED BY CONSTRUCTION: a convex combination of keys that are themselves
  // in [0,1), so ident is in [-0.5, 0.5] and continuous everywhere. This is the
  // fix for the rainbow contouring -- the old code indexed the palette by the
  // raw field, which is unbounded and swept most of the wheel inside one blob.
  float ident = identNum / identDen - 0.5;

  // A narrow OKLab arc — two or three neighbouring colours, so the fluid reads
  // as one material with variation in it rather than as a thermal camera.
  // L and C are held constant across the arc, which is the whole reason for
  // working in OKLab: lightness does not pulse as the hue moves.
  vec3 body = oklabRamp(uHueBase + uHueSpread * ident, 0.72, 0.13, 0.0);
  // Chromaticity only, so the absorption below is a pure tint and its strength
  // is set by uDensity alone.
  vec3 tint = clamp(body / max(max(body.r, max(body.g, body.b)), 1e-4), 0.0, 1.0);

  // ---- shade -------------------------------------------------------------
  const vec3 V = vec3(0.0, 0.0, 1.0);   // orthographic: the view ray is +z
  vec3 key = normalize(vec3(-0.42, 0.55, 0.72));
  vec3 fill = normalize(vec3(0.60, -0.35, 0.45));

  // Fresnel-Schlick. F0 = 0.02 is a water/oil interface at normal incidence;
  // the point is that it climbs to 1 at the silhouette, and that climb is most
  // of what makes a surface read as liquid rather than as painted.
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);

  // Refraction. eta = 1/1.33, air into water. The exit point is displaced along
  // the refracted direction by the distance travelled, so the distortion is
  // strongest through the thick middle and vanishes at the rim — which is the
  // correct way round, and the reason the background needs structure.
  vec3 rdir = refract(-V, n, 1.0 / 1.33);
  vec3 behind = backdrop(p + rdir.xy * thickness * uRefract, t);

  // Beer-Lambert through the measured thickness. sigma is the complement of the
  // body chromaticity, so what survives is tinted toward the fluid's own colour
  // and gets deeper as the fluid gets thicker.
  vec3 trans = exp(-uDensity * (1.0 - tint) * thickness);
  vec3 col = behind * trans;

  // In-scattering: the light that did not make it through, re-emitted in the
  // body colour. Scalar opacity rather than 1 - trans, which would be the
  // complementary colour. Modulated by the lights so thick regions still shade.
  float ndl = max(dot(n, key), 0.0);
  float ndf = max(dot(n, fill), 0.0);
  float opacity = 1.0 - exp(-uDensity * thickness);
  col += body * uScatter * opacity * (0.28 + 0.80 * ndl + 0.22 * ndf);

  // Fresnel-weighted reflection, then a Blinn-Phong specular on top of it so a
  // highlight can be brighter than the environment it sits in. The specular is
  // the only genuinely HDR term in the frame and is what the bloom threshold is
  // set against — written raw into the HDR target, never pre-tonemapped (#140).
  col = mix(col, environment(reflect(-V, n), key, behind), fres);
  // Two lobes: a tight glint plus a broad sheen. A single exponent-90 lobe gave
  // one clean oval per blob and read as moulded plastic; the tight lobe is what
  // a liquid surface actually does, and the wide one is the wet sheen around it.
  vec3 halfV = normalize(key + V);
  float ndh = max(dot(n, halfV), 0.0);
  // The wide lobe is kept weak and fairly tight (40, not 22): a broad sheen at
  // any real strength washes the body colour out of every blob that happens to
  // be lit from behind, which turned the one over the lamp into frosted glass.
  float spec = pow(ndh, 240.0) * 7.0 + pow(ndh, 40.0) * 0.16;
  col += vec3(1.00, 0.93, 0.84) * spec * (0.15 + 0.85 * fres);

  outColor = vec4(mix(bg, col, cov) * uLum, 1.0);
}`

export default {
  name: 'Metaballs',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let prog = null, post = null
    let aspect = 0
    let blobs = []

    // Built here, not in start(), so a stop/start cycle keeps the same look.
    const rng = createRng(seedValue)

    // Blobs per unit of world area. World area is the aspect ratio, since y
    // spans one unit: 1.78 in a 16:9 window, 5.0 on the wall. This is the
    // constant that stops the wall from getting a 16:9 population spread five
    // times thinner, which is what made the old version ten dots in a desert.
    const blobDensity = rng.range(3.2, 4.2)
    // Fraction of the world area the fluid occupies. Held constant across
    // aspect ratios, and it is what sets the radius (below) — so both count and
    // radius are derived from world area rather than being fixed numbers.
    // Above ~0.22 the wall fuses into a single sheet with no negative space
    // left -- the first attempt at 0.19-0.29 rendered one continuous snake
    // across 6000px. Below ~0.10 the blobs stop meeting at all.
    const coverage = rng.range(0.12, 0.19)
    // Per-blob radius variation, as a fraction of the mean. Size contrast is
    // most of what sells the lava-lamp look, but the top of the range compounds
    // with the radius breathing below: at 0.55 the largest blob ends up nearly
    // twice the mean and swallows the frame while its neighbours vanish.
    const sizeSpread = rng.range(0.22, 0.42)

    // Palette: a narrow arc, deliberately. uHueSpread is the full width in
    // turns, so 0.10-0.17 is 36-61 degrees of hue — amber through rose, or teal
    // through green. Never a spectrum.
    const hueBase = rng.next()
    const hueSpread = rng.range(0.10, 0.17)

    // Optical properties. uDensity sets how quickly the fluid goes opaque; the
    // scatter gain sets how much of the body colour is emitted rather than
    // transmitted, and it is the single control that decides whether this looks
    // like liquid or like rubber. The first pass ran 0.55-0.95 with a density
    // of 4.5-7.5 and the scatter drowned the transmitted lamp completely --
    // opaque cyan bath toys. Low scatter and a thin fluid put the backlight
    // back in charge, which is what a lava lamp actually is.
    const fluidDensity = rng.range(5.0, 7.5)
    const scatterGain = rng.range(0.22, 0.40)
    // Refraction has to be pushed well past physical plausibility to read at
    // all: the displacement is thickness-scaled, and a blob is only ~0.3 world
    // units thick, so an eta-accurate offset moves the sampled backdrop by less
    // than the width of a caustic filament and nothing appears to bend.
    const refractGain = rng.range(2.4, 4.0)
    // Ripple amplitude. Above ~0.35 the surface stops reading as a coherent
    // volume and starts reading as noise applied to a blob.
    const rippleAmp = rng.range(0.14, 0.30)

    // Lamp. Slow enough that it is a change in the composition over minutes
    // rather than a moving object: a full traverse takes 70-170s.
    const lampFx = rng.range(0.006, 0.014)
    const lampFy = rng.range(0.009, 0.019)
    const lampPx = rng.phase()
    const lampPy = rng.phase()
    const lampGain = rng.range(0.75, 1.25)
    const causticGain = rng.range(0.05, 0.11)

    // Pair-force constants, in world units and seconds.
    //
    // REST_RATIO is the zero-force separation as a multiple of the summed field
    // radii. Slightly above 1 because the visible isosurface already sits at
    // r/sqrt(ISO) = 1.29r: a pair resting at 1.15 (r_a + r_b) has its surfaces
    // touching and drawing a neck, which is the look, while resting *inside*
    // the sum fuses them into one lump with no neck at all.
    // CUTOFF bounds the attraction so distant blobs do not all collapse toward
    // the centre of mass; beyond 2 rest lengths a pair simply ignores each
    // other and the anchor springs keep the wall populated.
    const SPRING = 1.15      // pull toward the drifting anchor
    const DAMP = 1.05        // velocity decay, 1/s
    const ATTRACT = 0.34
    const REPEL = 2.4
    const REST_RATIO = 1.15
    const CUTOFF = 2.0

    /**
     * (Re)build the blob set for the current aspect ratio.
     *
     * Count comes from world area; the mean radius then comes from the target
     * coverage and that count, so the two cannot drift apart. The radius solved
     * for is the *visible* one, so it is converted back to a field radius by
     * sqrt(ISO) — an isolated blob's isosurface sits at r/sqrt(ISO).
     */
    function seedBlobs() {
      blobs = []
      const area = aspect
      const halfW = 0.5 * aspect
      const count = Math.max(7, Math.min(MAX_BLOBS, Math.round(area * blobDensity)))
      // count * pi * rVisible^2 = coverage * area
      const rVisible = Math.sqrt((coverage * area) / (Math.PI * count))
      const rField = rVisible * Math.sqrt(ISO)

      for (let i = 0; i < count; i++) {
        // Stratified in x rather than uniformly sampled. At 5:1 with ~15 blobs
        // a uniform draw reliably leaves one third of the wall empty and clumps
        // another; lanes guarantee the frame is populated end to end and the
        // pair forces still let groups form inside it.
        const lane = ((i + 0.5) / count - 0.5) * 2 * halfW * 0.88
        const homeX = lane + rng.around(0, halfW / count)
        // Alternating high/low bands, not a single mid-height row. All the
        // homes within +/-0.17 put every blob on the same axis, and at wall
        // aspect that fused them into one horizontal snake with dead space
        // above and below. Staggering gives the field vertical extent and the
        // merges a diagonal to happen along.
        const band = (i % 2 === 0 ? 1 : -1) * rng.range(0.12, 0.27)
        const homeY = band + rng.around(0, 0.06)
        const r = rField * (1 + rng.around(0, sizeSpread))
        blobs.push({
          x: homeX, y: homeY, vx: 0, vy: 0,
          r, rBase: r,
          mass: (r * r) / (rField * rField),
          homeX, homeY,
          // Anchor drift. Independent per blob, and slow: 25-90s per cycle.
          ampX: rng.range(0.18, 0.55), ampY: rng.range(0.10, 0.24),
          freqX: rng.range(0.011, 0.040), freqY: rng.range(0.013, 0.045),
          phaseX: rng.phase(), phaseY: rng.phase(),
          // Radius breathing. Reads as mass moving between merged blobs, which
          // is what a lava lamp actually does; without it the merges look like
          // two rigid balls touching.
          breathAmp: rng.range(0.10, 0.24),
          breathFreq: rng.range(0.020, 0.055),
          breathPhase: rng.phase(),
          hue: rng.next(),
        })
      }
    }

    /** Integrate the blob set by dt seconds at wall-clock rate. */
    function step(time, dt) {
      const halfW = 0.5 * aspect

      for (const b of blobs) {
        b.r = b.rBase * (1 + b.breathAmp * Math.sin(TAU * b.breathFreq * time + b.breathPhase))
        // Weak spring to a slowly drifting anchor. This is what makes the
        // system unconditionally stable: pair attraction alone would eventually
        // collect every blob into one lump, and pure repulsion would spread
        // them into a lattice. The anchors keep the wall covered; the pair
        // forces do the coalescing inside that.
        const ax = b.homeX + b.ampX * Math.sin(TAU * b.freqX * time + b.phaseX)
        const ay = b.homeY + b.ampY * Math.cos(TAU * b.freqY * time + b.phaseY)
        b.vx += SPRING * (ax - b.x) * dt
        b.vy += SPRING * (ay - b.y) * dt
      }

      for (let i = 0; i < blobs.length; i++) {
        const a = blobs[i]
        for (let j = i + 1; j < blobs.length; j++) {
          const c = blobs[j]
          const dx = c.x - a.x
          const dy = c.y - a.y
          const d = Math.sqrt(dx * dx + dy * dy) + 1e-5
          const rest = (a.r + c.r) * REST_RATIO
          const x = d / rest
          let f = 0
          if (x < 1) {
            // Linear repulsion, bounded at contact — an inverse-square core
            // would need a step size nothing here can afford.
            f = -REPEL * (1 - x)
          } else if (x < CUTOFF) {
            // Attraction that vanishes at both ends: zero at the rest length so
            // pairs settle, zero at the cutoff so it joins smoothly to nothing.
            const s = (x - 1) / (CUTOFF - 1)
            f = ATTRACT * 4 * s * (1 - s)
          }
          // Mass-weighted, so a large blob draws a small one in rather than the
          // pair meeting halfway. Mass is area normalised to the mean blob, so
          // it hovers around 1 and the force constants above stay readable.
          const ux = (dx / d) * f * dt
          const uy = (dy / d) * f * dt
          a.vx += ux * c.mass
          a.vy += uy * c.mass
          c.vx -= ux * a.mass
          c.vy -= uy * a.mass
        }
      }

      const decay = Math.exp(-DAMP * dt)
      for (const b of blobs) {
        b.vx *= decay
        b.vy *= decay
        b.x += b.vx * dt
        b.y += b.vy * dt
        // Soft walls. A blob is allowed to touch the edge but not to sit half
        // outside it, which would read as a hard clip rather than a blob.
        const lx = halfW - b.r * 0.8
        const ly = 0.5 - b.r * 0.8
        if (b.x < -lx) { b.x = -lx; b.vx = Math.abs(b.vx) * 0.4 }
        if (b.x > lx) { b.x = lx; b.vx = -Math.abs(b.vx) * 0.4 }
        if (b.y < -ly) { b.y = -ly; b.vy = Math.abs(b.vy) * 0.4 }
        if (b.y > ly) { b.y = ly; b.vy = -Math.abs(b.vy) * 0.4 }
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        aspect = canvasAspect(canvas)
        seedBlobs()

        prog = runtime.createQuadProgram(FRAG)
        const u = createUniformCache(gl, prog.program)

        // Bloom threshold sits above the fluid body and the lamp halo, and
        // below the specular glints and the lamp core, so only genuinely bright
        // things glow. The scene target is real HDR — the specular term is
        // written at 7.0 — so this is not the LDR trap post-fx.js documents.
        //
        // Intensity and radius are both restrained on purpose. A wider, hotter
        // bloom put a 20px halo on every silhouette and the whole frame read as
        // out of focus; the blobs need a hard edge to look like liquid.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 1.15 * luminanceScale(canvas),
            knee: 0.4,
            intensity: 0.35,
            radius: 0.8,
          },
          tonemap: 'aces',
          dither: true,
        })

        const flat = new Float32Array(MAX_BLOBS * 4)

        runtime.start((time, frame, glCtx, rt) => {
          // The preview harness toggles wall mode live, and a window can be
          // resized; rebuilding on a material aspect change keeps count and
          // radius derived from the area actually on screen. The 8% band stops
          // a one-pixel resize from repopulating the frame.
          const a = canvasAspect(canvas)
          if (aspect <= 0 || Math.abs(a - aspect) / aspect > 0.08) {
            aspect = a
            seedBlobs()
          }

          step(time, rt.dt)

          for (let i = 0; i < blobs.length; i++) {
            const b = blobs[i]
            flat[i * 4] = b.x
            flat[i * 4 + 1] = b.y
            flat[i * 4 + 2] = b.r * b.r
            flat[i * 4 + 3] = b.hue
          }

          const halfW = 0.5 * aspect
          const lampX = Math.sin(TAU * lampFx * time + lampPx) * halfW * 0.78
          const lampY = Math.cos(TAU * lampFy * time + lampPy) * 0.30

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }

          prog.draw(time, frame, (g) => {
            g.uniform4fv(u('uBlobs'), flat)
            g.uniform1i(u('uCount'), blobs.length)
            g.uniform1f(u('uHueBase'), hueBase)
            g.uniform1f(u('uHueSpread'), hueSpread)
            g.uniform1f(u('uDensity'), fluidDensity)
            g.uniform1f(u('uScatter'), scatterGain)
            g.uniform1f(u('uRefract'), refractGain)
            g.uniform1f(u('uRipple'), rippleAmp)
            g.uniform2f(u('uLamp'), lampX, lampY)
            // A fifth of the world width. Big enough to be a pool the fluid
            // sits in front of, small enough to leave both ends of the wall in
            // the dark.
            g.uniform1f(u('uLampR'), 0.21 * aspect)
            g.uniform1f(u('uLampGain'), lampGain)
            g.uniform1f(u('uCaustic'), causticGain)
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
        blobs = []
        aspect = 0
      },
    }
  },
}
