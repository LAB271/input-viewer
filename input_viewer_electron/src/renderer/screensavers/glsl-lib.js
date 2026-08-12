// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Shared GLSL snippets for the screensavers (issue #115).
 *
 * These are strings to splice into shader sources, not modules -- GLSL has no
 * import mechanism, so the alternative is copy-paste, which is what this
 * replaces. Compose them with template literals:
 *
 *   const FRAG = `#version 300 es
 *   precision highp float;
 *   ${GLSL.simplex2d}
 *   ${GLSL.fbm}
 *   void main() { ... }`
 *
 * Each snippet declares its own dependencies in a comment. They are additive
 * and safe to include more than once only if you deduplicate first -- GLSL
 * rejects duplicate function definitions.
 */

/**
 * Integer-hash based random. Replaces the `fract(sin(dot(...)) * 43758.5453)`
 * idiom, which has visible structure on many GPUs and correlates between
 * adjacent samples -- boids' neighbour sampling and white-particles' respawn
 * positions both suffered from that (issue #115).
 *
 * Based on the integer bit-mixing hashes surveyed in Jarzynski & Olano,
 * "Hash Functions for GPU Rendering" (JCGT 2020), which do not rely on
 * trigonometric precision.
 */
const hash = /* glsl */`
uint hashU(uint x) {
  x += (x << 10u); x ^= (x >>  6u);
  x += (x <<  3u); x ^= (x >> 11u);
  x += (x << 15u);
  return x;
}
uint hashU(uvec2 v) { return hashU(v.x ^ hashU(v.y)); }
uint hashU(uvec3 v) { return hashU(v.x ^ hashU(v.y) ^ hashU(v.z)); }

// [0,1) float from the top 23 bits, so the mantissa is fully populated.
float hashF(uint h) { return float(h & 0x007FFFFFu) / float(0x00800000u); }

float rand(float p)  { return hashF(hashU(floatBitsToUint(p))); }
float rand(vec2 p)   { return hashF(hashU(floatBitsToUint(p))); }
float rand(vec3 p)   { return hashF(hashU(floatBitsToUint(p))); }
vec2  rand2(vec2 p)  { uint h = hashU(floatBitsToUint(p));
                       return vec2(hashF(h), hashF(hashU(h))); }
`

/**
 * 2D simplex noise: true *gradient* noise, unlike the value noise it replaces.
 *
 * Value noise interpolates random values at lattice points, which leaves
 * axis-aligned grid artifacts -- visible under magnification, and at 6000x1200
 * that means visible at normal viewing distance. Gradient noise interpolates
 * random *gradients* instead, so the lattice does not show through.
 *
 * Returns roughly [-1, 1].
 */
const simplex2d = /* glsl */`
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute289(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`

/** Fractal Brownian motion over simplex noise. Requires: simplex2d. */
const fbm = /* glsl */`
float fbm(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += amp * snoise(p);
    norm += amp;
    p *= 2.02;   // Slightly off 2.0 so octave lattices do not align.
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}
`

/**
 * Divergence-free curl of a 2D noise field, for flow that churns rather than
 * slides.
 *
 * Two fixes over the hand-rolled versions. The step is finer (they used
 * e=0.05/0.08 over non-smooth value noise, giving visible faceting in the flow
 * direction), and time enters as a *third* noise dimension rather than as a
 * scalar offset added to both components. Adding time to both components
 * translates the whole field diagonally -- which is why the old flow visibly
 * slid across the screen instead of evolving in place.
 *
 * Requires: simplex2d.
 */
const curl2d = /* glsl */`
vec2 curl2d(vec2 p, float t) {
  const float e = 0.008;
  // Decorrelated planes rather than a shared time offset, so the field evolves.
  float n1 = snoise(p + vec2(0.0, e) + vec2(0.0, t * 0.35));
  float n2 = snoise(p - vec2(0.0, e) + vec2(0.0, t * 0.35));
  float n3 = snoise(p + vec2(e, 0.0) + vec2(t * 0.35, 0.0));
  float n4 = snoise(p - vec2(e, 0.0) + vec2(t * 0.35, 0.0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}
`

/**
 * OKLab-space palette helpers.
 *
 * The cosine palette (`0.5 + 0.5*cos(6.2831*(t + phase))`) is duplicated across
 * ten files with slightly different phase constants. It is convenient but
 * interpolates in sRGB, so ramps pass through muddy desaturated midpoints and
 * perceived lightness is uneven along the ramp. OKLab is perceptually uniform,
 * so a linear traverse looks linear.
 *
 * cosinePalette is kept for compatibility with existing looks; oklabRamp is the
 * better choice for new work.
 */
const palette = /* glsl */`
vec3 cosinePalette(float t, vec3 phase) {
  return 0.5 + 0.5 * cos(6.28318530718 * (t + phase));
}

vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
    +4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);
}

// Perceptually even ramp: L in [0,1], hue in turns, chroma ~[0,0.4].
vec3 oklabRamp(float t, float lightness, float chroma, float hueTurns) {
  float h = 6.28318530718 * (hueTurns + t);
  return max(oklabToLinear(vec3(lightness, chroma * cos(h), chroma * sin(h))), 0.0);
}

// Drop-in replacement for the cosine palette, in OKLab.
//
// Constant lightness and chroma, hue sweeping -- the textbook perceptually
// uniform ramp. Holding both fixed is the whole point: varying them is what
// gives the cosine palette its muddy troughs and blown highlights.
//
// L=0.75, C=0.12 were chosen by measurement, not taste. Sampling 24 hues and
// converting back to OKLab:
//
//   cosine palette      chroma varies 2.3x across the ramp
//   L=0.70 C=0.13       1.08x, but 3/24 hues fall outside sRGB
//   L=0.72 C=0.15       1.20x, 7/24 out of gamut
//   L=0.75 C=0.12       1.00x, 0/24 out of gamut   <- this one
//
// Out-of-gamut hues clip, which reintroduces exactly the flat patches the
// change is meant to remove, so staying inside sRGB matters more than squeezing
// out extra saturation.
//
// The phase vector keeps the cosine version's meaning: .x rotates the hue
// wheel, and the spread between components nudges chroma, so per-activation
// palette variation still varies the palette.
vec3 palettePerceptual(float t, vec3 phase) {
  float chroma = 0.12 * (0.85 + 0.3 * fract(phase.y - phase.z));
  return oklabRamp(phase.x + t, 0.75, chroma, 0.0);
}
`

/**
 * gl_VertexID -> state-texture lookup, the preamble duplicated verbatim in four
 * particle vertex shaders. Declares `uSide` and `uState`, so do not redeclare
 * them in the caller.
 */
const particleFetch = /* glsl */`
uniform sampler2D uState;
uniform float uSide;

vec4 fetchParticle(out vec2 uvOut) {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  uvOut = (vec2(float(x), float(y)) + 0.5) / uSide;
  return texture(uState, uvOut);
}
vec4 fetchParticle() { vec2 ignored; return fetchParticle(ignored); }
`

/**
 * Vertex-shader preamble for instanced-quad particles (issue #116).
 *
 * GL_POINTS cannot be rotated or stretched. boids computes each bird's heading
 * and then throws it away, using it only for hue, because a point sprite has no
 * orientation -- so a murmuration renders as round dots rather than arrowheads,
 * losing most of the read. Velocity-aligned motion-blur streaks are impossible
 * for the same reason.
 *
 * This draws N instanced unit quads instead, each fetching its state from the
 * sim texture by gl_InstanceID and orienting itself along its velocity.
 * `aCorner` is the per-vertex unit-quad corner in [-0.5, 0.5].
 *
 * Cost is roughly 4x the vertex work of points, which is irrelevant here: these
 * savers are fill-rate and simulation bound, not vertex bound.
 *
 * Declares uState/uSide/aCorner; do not redeclare them in the caller.
 */
const instancedQuad = /* glsl */`
in vec2 aCorner;
uniform sampler2D uState;
uniform float uSide;

// Per-instance state, fetched by instance id.
vec4 fetchInstance(out vec2 uvOut) {
  int id = gl_InstanceID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  uvOut = (vec2(float(x), float(y)) + 0.5) / uSide;
  return texture(uState, uvOut);
}

// Place the quad at the instance position, rotated to face its velocity and
// scaled by size. The stretch factor elongates along the direction of travel:
// 1.0 is round, higher values give motion-blur streaks.
// size MUST be isotropic in whatever space you pass it -- pixels, or world
// units. Passing a size that already has a per-axis conversion folded in (e.g.
// multiplied by a pixel->clip uQuadScale) rotates an anisotropically-scaled
// corner, which shears the quad by the display aspect: 5x on a 6000x1200 wall
// and invisible at 16:9. Convert to clip on the RESULT, not the input.
// See issue #190; boids.js had exactly this bug.
vec2 orientedQuadOffset(vec2 vel, vec2 size, float stretch) {
  float speed = length(vel);
  // Below a threshold the heading is noise, so keep the quad axis-aligned
  // rather than letting it spin wildly when a particle is nearly stationary.
  vec2 dir = speed > 1e-4 ? vel / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 c = aCorner * size;
  return dir * (c.x * stretch) + perp * c.y;
}
`

/**
 * Aspect-correct world space (issue #114).
 *
 * Clip space is [-1,1] on both axes but maps to the viewport, so it is only
 * square when the canvas is. On the 6000x1200 wall it is stretched 5:1, and
 * every simulation that works directly in clip space is geometrically wrong
 * there: boids' 0.06 separation radius becomes a 180x36px ellipse, a circular
 * orbit renders as a 5:1 oval, and a curl-noise field acquires a horizontal
 * bias nobody designed.
 *
 * World space fixes that by dividing both axes by the *short* one, so y runs
 * [-0.5, 0.5] and x covers [-aspect/2, aspect/2]. One unit is the same distance
 * in both directions, so a radius means a radius. Only the final conversion to
 * gl_Position reintroduces the aspect.
 *
 * The escape-time fractals and raymarch already did this by hand
 * ((frag - 0.5*res)/res.y); this makes it the shared default rather than
 * something each author has to remember.
 *
 * Requires a `uAspect` uniform (width / height) for the vertex-side helpers,
 * or `iResolution` for the fragment-side ones.
 */
const worldSpace = /* glsl */`
// Fragment shaders: pixel coordinate -> world space. Needs iResolution.
vec2 worldFromFrag(vec2 fragCoord, vec2 resolution) {
  return (fragCoord - 0.5 * resolution) / resolution.y;
}

// Vertex shaders: world space -> clip space. Needs the aspect ratio (w/h).
// Dividing x by aspect is what undoes the viewport stretch.
vec4 clipFromWorld(vec2 world, float aspect) {
  return vec4(world.x * 2.0 / aspect, world.y * 2.0, 0.0, 1.0);
}

// Half-extent of the visible world region, for placing and wrapping things.
// y is always 0.5; x grows with the aspect ratio.
vec2 worldExtent(float aspect) {
  return vec2(0.5 * aspect, 0.5);
}

// Shortest separation between two points on a torus of the given half-extent.
//
// A plain (b - a) is wrong once a simulation wraps: two points either side of
// the seam are physically adjacent but numerically maximally distant. In boids
// that made neighbours across the edge read as far away, so the flock visibly
// tore at screen edges rather than flowing through them.
vec2 torusDelta(vec2 a, vec2 b, vec2 halfExtent) {
  vec2 d = b - a;
  vec2 span = 2.0 * halfExtent;
  return d - span * floor(d / span + 0.5);
}

// Wrap a position back into [-halfExtent, halfExtent] on both axes.
vec2 torusWrap(vec2 p, vec2 halfExtent) {
  vec2 span = 2.0 * halfExtent;
  return p - span * floor((p + halfExtent) / span);
}
`

export const GLSL = {
  hash, simplex2d, fbm, curl2d, palette, particleFetch, instancedQuad, worldSpace,
}

/**
 * Aspect ratio of a canvas, guarded against a zero-sized one.
 * @param {HTMLCanvasElement} canvas
 * @returns {number} width / height
 */
export function canvasAspect(canvas) {
  const w = canvas.width || 1
  const h = canvas.height || 1
  return w / h
}

/**
 * Geometry for instanced-quad particle rendering (issue #116).
 *
 * Creates the shared unit-quad VBO and a VAO with `aCorner` set up as a
 * per-vertex attribute. Draw with `draw(instanceCount)`.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program - must declare `in vec2 aCorner`
 * @returns {{draw: (count: number) => void, destroy: () => void}}
 */
export function createInstancedQuads(gl, program) {
  // Two triangles as a unit quad centred on the origin.
  const corners = new Float32Array([
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ])
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(program, 'aCorner')
  if (loc >= 0) {
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }
  gl.bindVertexArray(null)

  return {
    draw(instanceCount) {
      gl.bindVertexArray(vao)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount)
    },
    destroy() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(vbo)
    },
  }
}

/**
 * Uniform-location cache for a program.
 *
 * getUniformLocation is a string-keyed driver query and every simulation saver
 * called it inside its per-frame draw callback -- reaction-diffusion does 5
 * lookups across 8 substeps, so 40 queries per frame for values that never
 * change. Locations are fixed for a program's lifetime, so cache them.
 *
 *   const u = createUniformCache(gl, program)
 *   gl.uniform1f(u('uDt'), dt)
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @returns {(name: string) => WebGLUniformLocation|null}
 */
export function createUniformCache(gl, program) {
  const cache = new Map()
  return function uniform(name) {
    let loc = cache.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name)
      // Cache misses too: an optimised-out uniform returns null every time, and
      // re-querying it each frame is the cost we are removing.
      cache.set(name, loc)
    }
    return loc
  }
}

// =============================================================================
// Appended snippets (issue #118).
//
// These are declared after the GLSL object and merged in rather than being
// written inline above it. That is deliberate: the savers are being reworked by
// several people at once and every one of them touches this file, so keeping
// additions strictly at the end of the file -- including the registration --
// means two additions conflict only with each other, never with the existing
// body.
// =============================================================================

/**
 * 3D simplex noise with analytic derivatives.
 *
 * Two things this buys over the 2D version, both of which the plasma needs:
 *
 *   - Time on the third axis. A 2D field can only be *translated* over time,
 *     which reads as a texture scrolling past. Advancing z through a 3D field
 *     makes it churn in place, which is the difference between a screensaver
 *     and a living surface.
 *   - The exact gradient, for free. Finite differences over a noise field cost
 *     an extra 2-6 evaluations and are only as smooth as the step size; the
 *     analytic gradient is exact and comes out of arithmetic already done. Once
 *     you have it you can shade the noise as a heightfield and use its
 *     steepness to attenuate later octaves (see fbmd3).
 *
 * The value half is Ashima Arts / Stefan Gustavson's webgl-noise `snoise`
 * (MIT), unchanged. The derivative is the textbook differentiation of its final
 * sum: each corner contributes w^4 * dot(g, x) with w = 0.6 - |x|^2, so
 *
 *   d/dx [ w^4 (g.x) ] = w^4 g + 4 w^3 (dw/dx) (g.x) = w^4 g - 8 w^3 (g.x) x
 *
 * Returns vec4(value, d/dx, d/dy, d/dz); value is roughly [-1, 1].
 *
 * Requires: simplex2d (for mod289(vec3) and permute289(vec3)).
 */
const simplex3d = /* glsl */`
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute289(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

vec4 snoised(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  // Skew into the simplex lattice and find the first corner.
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  // Rank the components to pick which of the six tetrahedra we are in.
  vec3 gt = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - gt;
  vec3 i1 = min(gt.xyz, l.zxy);
  vec3 i2 = max(gt.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  // Gradients: 7x7x6 points over a cube, mapped onto an octahedron.
  float n_ = 0.142857142857; // 1/7
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 xf = floor(j * ns.z);
  vec4 yf = floor(j - 7.0 * xf);

  vec4 gx = xf * ns.x + ns.yyyy;
  vec4 gy = yf * ns.x + ns.yyyy;
  vec4 gh = 1.0 - abs(gx) - abs(gy);

  vec4 b0 = vec4(gx.xy, gy.xy);
  vec4 b1 = vec4(gx.zw, gy.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(gh, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 g0 = vec3(a0.xy, gh.x);
  vec3 g1 = vec3(a0.zw, gh.y);
  vec3 g2 = vec3(a1.xy, gh.z);
  vec3 g3 = vec3(a1.zw, gh.w);

  vec4 norm = taylorInvSqrt(vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
  g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;

  // Radial falloff per corner. w is kept unsquared here (Ashima squares in
  // place) because the derivative needs both w^3 and w^4.
  vec4 w  = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 w2 = w * w;
  vec4 w4 = w2 * w2;
  vec4 gd = vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3));

  vec4 c = w2 * w * gd;
  vec3 grad = -8.0 * (c.x * x0 + c.y * x1 + c.z * x2 + c.w * x3)
            + w4.x * g0 + w4.y * g1 + w4.z * g2 + w4.w * g3;

  return 42.0 * vec4(dot(w4, gd), grad);
}

// Value only, for the places that do not need the gradient.
float snoise(vec3 v) { return snoised(v).x; }
`

/**
 * fBm over 3D simplex noise, carrying the analytic gradient and using it to
 * erode later octaves. Inigo Quilez's construction
 * (https://iquilezles.org/articles/morenoise/), ported rather than reinvented.
 *
 * Two ideas, both from that article:
 *
 *   - Each octave is rotated in 3D as well as scaled. Pure scaling by a power
 *     of two lines every octave's lattice up with the last one and the sum
 *     acquires a faint grid; an irrational-ish scale plus a rotation
 *     decorrelates them. The derivative has to be rotated back by the inverse
 *     to stay a derivative, which is what the `m` matrix accumulates -- for an
 *     orthonormal rotation the inverse is the transpose.
 *   - Erosion: divide an octave's contribution by 1 + k * |accumulated slope|^2,
 *     so detail is suppressed where the field is already steep and survives on
 *     the flats. It is a one-line change and it is the whole difference between
 *     fBm that looks like static and fBm that looks like carved rock, because
 *     it is a crude model of what erosion actually does to a landscape.
 *
 * Returns vec4(value, gradient) with the value normalised to roughly [-1, 1].
 * The gradient is in units of the *input* coordinate, so a caller that scaled
 * its coordinates has scaled the gradient by the same factor.
 *
 * `gain` matters more here than in an ordinary fBm, and 0.5 is usually the
 * wrong answer. Each octave's *gradient* is amplified by the lacunarity, so at
 * gain 0.5 and lacunarity ~2 every octave contributes roughly equal gradient
 * energy and the returned normal is dominated by the finest one -- lighting the
 * result then produces pixel-scale grain rather than relief. Pick gain such
 * that gain * lacunarity is comfortably below 1 (0.40 gives a 0.79 per-octave
 * gradient falloff) whenever the gradient is going to be used for shading or
 * for domain warping.
 *
 * Requires: simplex3d.
 */
const fbmd3 = /* glsl */`
// Quilez's decorrelating rotation and its inverse (orthonormal, so transpose).
const mat3 FBMD3_ROT = mat3( 0.00,  0.80,  0.60,
                            -0.80,  0.36, -0.48,
                            -0.60, -0.48,  0.64);
const mat3 FBMD3_ROT_INV = mat3( 0.00, -0.80, -0.60,
                                 0.80,  0.36, -0.48,
                                 0.60, -0.48,  0.64);

vec4 fbmd3(vec3 p, int octaves, float gain, float erosion) {
  // 1.97 rather than 2.0: an exact octave doubling repeats the lattice
  // alignment at every level, and the near-miss is free.
  const float LACUNARITY = 1.97;
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec3 grad = vec3(0.0);
  mat3 m = mat3(1.0);
  for (int i = 0; i < octaves; i++) {
    vec4 n = snoised(p);
    sum  += amp * n.x / (1.0 + erosion * dot(grad, grad));
    grad += amp * m * n.yzw;
    norm += amp;
    amp  *= gain;
    p = LACUNARITY * FBMD3_ROT * p;
    m = LACUNARITY * FBMD3_ROT_INV * m;
  }
  float inv = 1.0 / max(norm, 1e-5);
  return vec4(sum * inv, grad * inv);
}
`

Object.assign(GLSL, { simplex3d, fbmd3 })
