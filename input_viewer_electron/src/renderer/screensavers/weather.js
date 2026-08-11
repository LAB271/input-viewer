// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Weather -- the no-signal screen showing something true about right now
 * (issue #101). Precipitation falls at the observed rate, wind pushes it and
 * shears the streaks, cloud cover sets the sky, and the palette follows local
 * day and night.
 *
 * WHERE THE DATA COMES FROM, AND WHY NOT FROM HERE
 *
 * This module does no networking. `weather-source.js` polls independently of the
 * screensaver lifecycle and caches the last good reading; this saver reads
 * whatever is there. That split is the whole point of #101's fallback problem:
 * `registry.startScreensaver()` is synchronous, so a fetch rejecting after
 * `start()` returns is uncatchable there. Polling outside means activation never
 * waits on HTTP and no timer can leak through a saver's `stop()`.
 *
 * `isAvailable()` below is what keeps a wall that has never reached the network
 * from showing this at all -- the registry skips it in the rotation. It stays
 * explicitly selectable, though, so the preview and the stepping keys can look
 * at it, which is why it must still render something defensible with no data:
 * FALLBACK is a calm, half-clouded day rather than a blank canvas. That also
 * means shadercheck exercises the shaders on a machine with no network.
 *
 * LAYOUT AT 5:1
 *
 * A 6000x1200 sky is mostly empty space, so the composition is horizontal by
 * design: a low horizon with a ground band, layered cloud at two depths, and
 * precipitation crossing the whole width at an angle set by the wind. #101 warns
 * against a bare gradient; the horizon and the cloud layers are what stop it
 * being one.
 */
import {
  createGLRuntime,
  createFullscreenPass,
  buildProgram,
  luminanceScale,
  pointScale
} from './gl-base.js'
import { GLSL, createInstancedQuads, createUniformCache, canvasAspect } from './glsl-lib.js'
import { createPostChain } from './post-fx.js'
import { createRng } from './seed.js'
import { buildGlyphAtlas, uploadGlyphAtlas, FLAP_CHARS } from './glyph-atlas.js'
import { currentReading } from './weather-source.js'

// What to animate when there is no reading. Not a guess at the weather -- a
// deliberately unremarkable scene, so an explicitly-selected run (preview,
// stepping keys, shadercheck) shows a working saver rather than a black frame.
const FALLBACK = {
  temperatureC: 12,
  precipitationMmH: 0,
  windSpeedKmh: 6,
  windDirectionDeg: 240,
  cloudCoverPct: 45,
  weatherCode: 1,
  isDay: true,
  ageMs: 0,
  stale: false,
  synthetic: true
}

// Precipitation particles at 1080p, scaled by area below. Rain needs to read as
// individual streaks rather than a wash, so this is far short of what a "heavy
// rain" texture would use -- the intensity comes from streak length and speed as
// much as from count.
// Measured, not guessed: 900 at 1080p gave ~780 drops across a 3000px frame,
// which read as a few faint scratches rather than as rain.
const DROPS_1080P = 5200
const MAX_DROPS = 26000

// mm/h that counts as "as heavy as we bother to draw". Anything above this looks
// the same; 8mm/h is already a downpour.
const HEAVY_MM_H = 8

// Below this the precipitation is drawn as snow: drifting, not falling. Uses the
// observed air temperature, which is a simplification -- real snow depends on the
// profile aloft -- but it is the honest reading we have.
const SNOW_BELOW_C = 1.0

// How fast the scene eases from one reading to the next. Weather changes slowly
// and a 15-minute poll can move numbers a long way, so a hard cut would read as a
// glitch. 25s to cover most of the gap.
const EASE_SECONDS = 25

/**
 * WMO weather code -> a scene kind and a label for the readout.
 *
 * Grouped rather than exhaustive: the visual only needs to know what to draw,
 * and 27 distinct codes would be 27 near-identical scenes. Labels are kept to
 * the glyph atlas's character set (A-Z, 0-9, dot, dash, colon).
 *
 * @param {number} code
 * @returns {{kind: string, label: string}}
 */
export function classifyWeather(code) {
  const c = Math.round(code)
  if (c === 0) return { kind: 'clear', label: 'CLEAR' }
  if (c === 1) return { kind: 'clear', label: 'MAINLY CLEAR' }
  if (c === 2) return { kind: 'cloud', label: 'PARTLY CLOUDY' }
  if (c === 3) return { kind: 'cloud', label: 'OVERCAST' }
  if (c === 45 || c === 48) return { kind: 'fog', label: 'FOG' }
  if (c >= 51 && c <= 57) return { kind: 'drizzle', label: 'DRIZZLE' }
  if (c >= 61 && c <= 67) return { kind: 'rain', label: 'RAIN' }
  if (c >= 71 && c <= 77) return { kind: 'snow', label: 'SNOW' }
  if (c >= 80 && c <= 82) return { kind: 'rain', label: 'RAIN SHOWERS' }
  if (c === 85 || c === 86) return { kind: 'snow', label: 'SNOW SHOWERS' }
  if (c >= 95) return { kind: 'storm', label: 'THUNDERSTORM' }
  return { kind: 'cloud', label: 'CLOUDY' }
}

/**
 * Build the readout line from a reading.
 *
 * Showing the numbers is what makes the display self-evidently live rather than
 * decorative (#101), and the age is what distinguishes "calm weather" from
 * "stale data" -- without it a frozen scene and a genuinely still evening look
 * identical.
 *
 * Restricted to the glyph atlas's set, so no degree sign and no slash: "21.7C"
 * and "KMH" rather than "21.7 deg C" and "km/h".
 *
 * @param {object} r a reading, possibly synthetic
 * @returns {string}
 */
export function readoutText(r) {
  const parts = []
  parts.push(`${r.temperatureC.toFixed(1)}C`)
  parts.push(classifyWeather(r.weatherCode).label)
  if (r.windSpeedKmh >= 1) parts.push(`WIND ${Math.round(r.windSpeedKmh)} KMH`)
  if (r.precipitationMmH >= 0.05) parts.push(`${r.precipitationMmH.toFixed(1)} MM-H`)
  if (r.synthetic) parts.push('NO DATA')
  else if (r.stale) {
    const mins = Math.round((r.ageMs || 0) / 60000)
    parts.push(mins >= 120 ? `${Math.round(mins / 60)} HOURS AGO` : `${mins} MIN AGO`)
  }
  return parts.join('   ')
}

// =============================================================================
// Sky
// =============================================================================
// One fullscreen pass: gradient, two cloud layers, sun or moon, stars at night,
// fog, a horizon and a ground band. Emits HDR into the post chain -- values above
// 1.0 for the sun and the brightest cloud edges -- so bloom has something real to
// select and ACES does the tonemapping once (the #140 trap: never pre-tonemap).

const SKY_FRAG = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float uCloud;      // 0..1 cover
uniform float uWind;       // km/h
uniform float uDay;        // 0 = night, 1 = day, eased across dawn/dusk
uniform float uFog;        // 0..1
uniform float uStorm;      // 0..1, drives the lightning flash
uniform float uSnowGround; // 0..1, whitens the ground band
uniform float uFlash;      // 0..1 current flash energy
uniform float uLum;
out vec4 outColor;

${GLSL.hash}
${GLSL.simplex2d}
${GLSL.fbm}

// Sky gradient. Two palettes crossfaded by uDay rather than one hue-rotated:
// a night sky is not a dark day sky, it is a different colour relationship.
vec3 skyGradient(float h) {
  vec3 dayLow  = vec3(0.62, 0.76, 0.92);
  vec3 dayHigh = vec3(0.16, 0.40, 0.78);
  vec3 nightLow  = vec3(0.05, 0.07, 0.14);
  vec3 nightHigh = vec3(0.01, 0.02, 0.06);
  vec3 day   = mix(dayLow, dayHigh, pow(clamp(h, 0.0, 1.0), 0.7));
  vec3 night = mix(nightLow, nightHigh, pow(clamp(h, 0.0, 1.0), 0.9));
  return mix(night, day, uDay);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  // Aspect-correct horizontally so cloud shapes are not stretched 5:1 on the
  // wall (issue #114): x is divided by the SHORT axis, like the fractals.
  vec2 uv = vec2((frag.x - 0.5 * iResolution.x) / iResolution.y,
                 frag.y / iResolution.y);

  // Horizon low in frame, so the sky gets the space and the ground reads as a
  // band rather than half the picture.
  float horizon = 0.16;
  float aboveH = smoothstep(horizon - 0.006, horizon + 0.006, uv.y);
  float skyH = clamp((uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);

  vec3 col = skyGradient(skyH);
  // Overcast is not blue seen through white: the sky itself goes grey. Pull
  // saturation out with cover so no residual blue survives a heavy sky.
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(grey) * mix(1.0, 0.82, uDay), uCloud * 0.85);

  // Sun or moon. Placed off-centre so the 5:1 frame is not symmetrical.
  vec2 body = vec2(-0.9, horizon + 0.42);
  float bodyD = length(uv - body);
  // HDR core: the sun is genuinely brighter than the page, which is what makes
  // the bloom read as light rather than as a white blob.
  float sunCore = smoothstep(0.055, 0.030, bodyD);
  float sunHalo = exp(-bodyD * 5.5);
  vec3 sunCol = mix(vec3(0.85, 0.90, 1.05), vec3(1.00, 0.93, 0.72), uDay);
  // Cloud cover hides it, and squared so the last of the disc goes early: a
  // linear falloff still left a visible dot at 100% cover.
  float clear = 1.0 - uCloud;
  float bodyVis = clear * clear * aboveH;
  col += sunCol * (sunCore * 5.0 + sunHalo * 0.35) * bodyVis;

  // Stars, night only, thinned by cloud. Hashed per cell so they do not crawl.
  if (uDay < 0.85) {
    vec2 cell = floor(frag / 3.0);
    float s = hashF(hashU(uint(cell.x) * 1973u + uint(cell.y) * 9277u));
    float twinkle = 0.75 + 0.25 * sin(iTime * 1.7 + s * 40.0);
    float starMask = step(0.9985, s) * (1.0 - uDay) * (1.0 - 0.9 * uCloud) * aboveH;
    col += vec3(0.9, 0.95, 1.0) * starMask * twinkle * 2.2;
  }

  // Two cloud layers at different scales and drift rates. Wind moves them, so a
  // still day has near-static cloud and a gale has it streaming.
  float drift = iTime * (0.004 + uWind * 0.0016);
  // fbm() is built on snoise and therefore returns roughly -1..1. Remap to 0..1
  // before thresholding: treating it as 0..1 meant even 100% cover left most of
  // the sky above the threshold, so a fully overcast reading rendered as a
  // pleasant partly-cloudy afternoon.
  float lowN  = fbm(uv * vec2(1.5, 3.0) + vec2(drift, 0.0), 5) * 0.5 + 0.5;
  float highN = fbm(uv * vec2(0.7, 1.8) + vec2(drift * 0.45 + 11.3, 4.7), 4) * 0.5 + 0.5;

  // Cover maps to a threshold rather than an opacity: at 20% cover you want a
  // few discrete clouds, not a uniform 20% grey veil over everything. The top of
  // the range goes NEGATIVE so that 100% really is unbroken -- stopping at 0
  // leaves gaps wherever the noise dips, and "overcast" with blue holes in it
  // reads as a bug.
  float lowT  = mix(0.80, -0.10, uCloud);
  float highT = mix(0.88, 0.02, uCloud);
  float lowMask  = smoothstep(lowT, lowT + 0.16, lowN) * aboveH;
  float highMask = smoothstep(highT, highT + 0.22, highN) * aboveH * 0.85;

  // Lit from the sun side, shaded away from it -- a flat grey cloud is the thing
  // that makes procedural skies look like wallpaper.
  float lit = clamp(0.5 + 0.5 * (uv.x - body.x) * -0.8, 0.0, 1.0);
  vec3 cloudLit  = mix(vec3(0.30, 0.33, 0.40), vec3(1.02, 1.00, 0.98), uDay);
  vec3 cloudDark = mix(vec3(0.06, 0.07, 0.11), vec3(0.42, 0.45, 0.52), uDay);
  vec3 cloudCol  = mix(cloudDark, cloudLit, lit);
  // A storm sky is darker and heavier, not just cloudier.
  cloudCol *= mix(1.0, 0.55, uStorm);
  // Modulate by the noise INDEPENDENTLY of coverage, so a fully overcast sky
  // still has lighter and darker patches. Without this, cover=1 saturates the
  // mask everywhere and the result is a flat grey gradient -- the bare-gradient
  // failure #101 warns about, just in grey instead of blue.
  float texN = fbm(uv * vec2(2.6, 5.2) + vec2(drift * 1.3 + 5.1, 8.2), 4) * 0.5 + 0.5;
  cloudCol *= 0.74 + 0.52 * mix(lowN, texN, 0.45);
  // A heavy sky is DARKER, not just more covered. Without this, full cover plus
  // the lit term plus bloom pushed the frame to near-white, which reads as fog
  // rather than as rain.
  cloudCol *= mix(1.0, 0.66, uCloud);

  col = mix(col, cloudCol, clamp(highMask, 0.0, 1.0));
  col = mix(col, cloudCol * 1.04, clamp(lowMask, 0.0, 1.0));

  // Lightning: a full-sky flash plus a brighter core near the storm cell.
  if (uFlash > 0.001) {
    float cellGlow = exp(-length(uv - vec2(1.1, horizon + 0.55)) * 2.6);
    // Restrained on purpose. Lighting the whole sky at 0.35 plus a 2.5 core blew
    // the frame to white and lost the night entirely -- the flash has to read as
    // a flash, which means the dark has to survive it.
    col += vec3(0.85, 0.90, 1.10) * uFlash * (0.10 + 1.1 * cellGlow);
  }

  // Ground: a dark band with a little texture, so the bottom of a 6000px frame
  // is not flat. Deliberately low-contrast -- it is a stage, not the subject.
  if (uv.y < horizon + 0.01) {
    float g = fbm(vec2(uv.x * 3.0, uv.y * 12.0 + 3.0), 3);
    vec3 groundCol = mix(vec3(0.02, 0.025, 0.04), vec3(0.10, 0.11, 0.09), uDay);
    groundCol *= 0.75 + 0.35 * g;
    // Lying snow: bright, low-contrast, and blue-shifted in shadow.
    vec3 snowCol = mix(vec3(0.16, 0.19, 0.26), vec3(0.80, 0.84, 0.92), uDay);
    groundCol = mix(groundCol, snowCol * (0.88 + 0.18 * g), uSnowGround);
    // Wet ground under precipitation reflects a little of the sky.
    col = mix(col, groundCol, 1.0 - aboveH);
  }

  // Fog last: it sits in front of everything, thickest at the horizon.
  if (uFog > 0.001) {
    vec3 fogCol = mix(vec3(0.10, 0.11, 0.14), vec3(0.74, 0.76, 0.79), uDay);
    float band = exp(-max(uv.y - horizon, 0.0) * 3.2);
    col = mix(col, fogCol, clamp(uFog * (0.35 + 0.65 * band), 0.0, 0.96));
  }

  outColor = vec4(col * uLum, 1.0);
}`

// =============================================================================
// Precipitation
// =============================================================================
// Instanced quads with analytic motion: each drop's position is a closed-form
// function of time and its own hash, so there is no simulation state, nothing to
// upload per frame, and start/stop is free. Rain is a sheared streak; snow is a
// round flake on a wandering path.

const DROP_VERT = `#version 300 es
precision highp float;
uniform vec2 uQuadScale;    // pixel -> clip, per axis
uniform float uTime;
uniform float uCount;
uniform float uFall;        // fall speed, screens per second
uniform float uShear;       // horizontal drift per unit of fall
uniform float uLength;      // streak length in px
uniform float uWidth;       // streak width in px
uniform float uSnow;        // 0 = rain, 1 = snow
uniform float uSeed;
uniform float uSlope;       // screen-space lean: dx/dy in pixels
out float vAlpha;
out vec2 vQuad;
out float vDepth;

${GLSL.instancedQuad}
${GLSL.hash}

void main() {
  vQuad = aCorner;
  float id = float(gl_InstanceID);
  float h1 = hashF(hashU(uint(id) * 747796405u + uint(uSeed * 4096.0)));
  float h2 = hashF(hashU(uint(id) * 2891336453u + 17u));
  float h3 = hashF(hashU(uint(id) * 1013904223u + 71u));

  // Depth: near drops are bigger, faster and brighter. Three discrete-ish bands
  // read better than a continuous ramp at wall distance.
  vDepth = 0.35 + 0.65 * h3;

  // Fall. Normalised space 0..1 vertically, wrapping. Snow falls far slower and
  // wanders; rain is close to straight.
  float speed = uFall * mix(1.0, 0.18, uSnow) * vDepth;
  float y = fract(h1 + 1.0 - uTime * speed);
  float x = h2 + (1.0 - y) * uShear * mix(1.0, 0.35, uSnow);
  if (uSnow > 0.5) {
    // Wander, at a per-flake frequency so the field does not sway in unison.
    x += 0.035 * sin(uTime * (0.5 + h3 * 0.9) + h1 * 31.0);
  }
  x = fract(x);

  // Fade the top and bottom edges so drops appear and vanish rather than
  // popping at the frame boundary.
  vAlpha = smoothstep(0.0, 0.06, y) * smoothstep(1.0, 0.94, y) * (0.35 + 0.65 * vDepth);

  vec2 centre = vec2(x * 2.0 - 1.0, y * 2.0 - 1.0);

  // Size in PIXELS, then converted to clip on the result -- never fold the
  // per-axis conversion in before shaping, or the quad shears with the display
  // aspect (issue #190).
  vec2 sizePx = uSnow > 0.5
    ? vec2(uWidth * 4.5 * vDepth)
    : vec2(uWidth * vDepth, uLength * vDepth);
  // Shear the streak along its travel so it leans with the wind instead of
  // falling vertically through a slanted field.
  // Lean the streak along its actual screen-space travel. uShear is a drift in
  // NORMALISED width and uSlope the same thing in pixels; using the normalised
  // value here made the streaks near-vertical while the field drifted sideways,
  // so the rain fell straight through slanted weather.
  vec2 offPx = vec2(aCorner.x * sizePx.x - aCorner.y * sizePx.y * uSlope,
                    aCorner.y * sizePx.y);
  gl_Position = vec4(centre + offPx * uQuadScale, 0.0, 1.0);
}`

const DROP_FRAG = `#version 300 es
precision highp float;
in float vAlpha;
in vec2 vQuad;
in float vDepth;
uniform float uSnow;
uniform float uLum;
uniform float uNight;   // 1 at night: precipitation is lit differently
out vec4 outColor;

void main() {
  float shape;
  if (uSnow > 0.5) {
    // Soft round flake.
    shape = smoothstep(0.5, 0.06, length(vQuad));
  } else {
    // Capsule: soft across the streak, tapered along it.
    float across = smoothstep(0.5, 0.12, abs(vQuad.x));
    float along = smoothstep(0.5, 0.34, abs(vQuad.y));
    shape = across * along;
  }
  if (shape <= 0.001) discard;

  // Rain is a highlight on the sky rather than a colour of its own, so it is
  // near-white by day and a cooler grey at night.
  // Rain against bright overcast has to be able to read DARKER than the sky, not
  // just brighter -- a white streak on a white sky is invisible. With
  // premultiplied blending a tint below the background darkens it, so this is a
  // blue-grey by day and a pale highlight at night against the dark.
  vec3 tint = mix(vec3(0.42, 0.50, 0.66), vec3(0.97, 0.98, 1.00), uSnow);
  tint = mix(tint, mix(vec3(0.62, 0.70, 0.95), vec3(0.90, 0.93, 1.00), uSnow), uNight);
  // Rain needs contrast against a bright overcast sky, which is exactly when it
  // is most likely to be falling.
  float energy = mix(0.95, 1.15, uSnow);
  outColor = vec4(tint * shape * vAlpha * energy * uLum, shape * vAlpha);
}`

// =============================================================================
// Readout
// =============================================================================
// A single line of glyphs from the shared atlas (#89/#92 solved this once; do not
// solve it a third time). Indices are uploaded as an int array and each pixel
// works out which character it is inside.

const MAX_CHARS = 56

const TEXT_FRAG = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform sampler2D uAtlas;
uniform int uGlyphs[${MAX_CHARS}];
uniform int uLen;
uniform float uCellPx;
uniform float uAlpha;
uniform float uLum;
uniform float uSetSize;
out vec4 outColor;

void main() {
  float len = float(uLen);
  if (len < 0.5) { outColor = vec4(0.0); return; }

  // Bottom-left, inset by one cell. Left-aligned rather than centred: on a
  // 6000px frame a centred line reads as a caption on nothing, while an inset
  // one reads as instrumentation.
  vec2 origin = vec2(uCellPx * 1.2, uCellPx * 0.9);
  vec2 local = (gl_FragCoord.xy - origin) / uCellPx;
  if (local.y < 0.0 || local.y > 1.0 || local.x < 0.0 || local.x > len) {
    outColor = vec4(0.0);
    return;
  }

  int idx = int(floor(local.x));
  if (idx < 0 || idx >= uLen) { outColor = vec4(0.0); return; }
  int glyph = uGlyphs[idx];

  // Atlas is one row of cells: u = (glyph + localU) / setSize.
  float localU = fract(local.x);
  vec2 atlasUv = vec2((float(glyph) + localU) / uSetSize, 1.0 - local.y);
  float ink = texture(uAtlas, atlasUv).r;

  // A dark plate behind the text. Not decoration: this readout has to stay
  // legible against a night sky AND against lying snow, which is nearly white.
  // Light-on-transparent disappeared completely on the snow scene.
  float plate = smoothstep(0.0, 0.12, local.y) * smoothstep(1.0, 0.88, local.y);

  // PREMULTIPLIED output, paired with blendFunc(ONE, ONE_MINUS_SRC_ALPHA). The
  // earlier version emitted colour already scaled by ink and then blended with
  // SRC_ALPHA, applying the coverage twice -- the same mistake the drop pass had.
  float a = max(ink, plate * 0.55) * uAlpha;
  vec3 rgb = vec3(0.94, 0.96, 1.0) * ink * uAlpha * uLum;
  outColor = vec4(rgb, a);
}`

export default {
  name: 'Weather',

  /**
   * Whether to offer this saver to the random rotation (#101).
   *
   * False until a reading is cached, so a wall that is offline, unconfigured, or
   * has the feature switched off never shows it. Explicit selection bypasses
   * this -- see resolveIndex in registry.js -- which is why the render path has
   * to cope with FALLBACK.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return currentReading() != null
  },

  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sky = null, post = null, text = null
    let dropProg = null, dropQuads = null, uDrop = null, uText = null
    let atlasTex = null

    const rng = createRng(seedValue)
    // Small per-activation variation so two consecutive runs in the same weather
    // are not identical: the cloud field and the drop field get different
    // offsets. Everything meteorological comes from the reading, not the RNG --
    // the point of this saver is that it is true.
    const cloudOffset = rng.range(0, 1000)
    const dropSeed = rng.next()

    // Eased scene state, so a new reading arrives as a transition rather than a
    // cut. Initialised on the first frame from whatever is current.
    let eased = null
    let flash = 0
    let nextFlashAt = 0

    /** The reading to animate: live if there is one, else the neutral fallback. */
    function reading() {
      return currentReading() || FALLBACK
    }

    /** Target scene parameters derived from a reading. */
    function targetsFrom(r) {
      const { kind } = classifyWeather(r.weatherCode)
      const isSnow = r.temperatureC < SNOW_BELOW_C || kind === 'snow'
      // Drizzle reads as a rate even when the gauge says nearly nothing, so give
      // the wetting kinds a floor -- otherwise "DRIZZLE" renders as a clear sky.
      const wetFloor = kind === 'drizzle' ? 0.25 : (kind === 'rain' ? 0.4 : 0)
      const rate = Math.max(r.precipitationMmH, wetFloor)
      return {
        cloud: r.cloudCoverPct / 100,
        wind: r.windSpeedKmh,
        day: r.isDay ? 1 : 0,
        fog: kind === 'fog' ? 0.75 : 0,
        storm: kind === 'storm' ? 1 : 0,
        snow: isSnow ? 1 : 0,
        // Normalised intensity, not a raw rate: the shader wants 0..1.
        //
        // Snow gets a multiplier because the API reports water equivalent and
        // fresh snow is roughly a tenth the density of rain -- 1.4mm/h of melt
        // is a thick snowfall, and scaling it like rain rendered it as a few
        // specks. 4x is short of the physical ratio on purpose: at 10x even light
        // snow whites out the frame.
        rate: Math.min((rate / HEAVY_MM_H) * (isSnow ? 4 : 1), 1),
        // Ground goes white while snow is falling or lying, which is most of what
        // sells a snow scene -- green grass under snowfall looks wrong.
        snowGround: isSnow ? Math.min(1, 0.35 + rate) : 0
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        const aspect = canvasAspect(canvas)
        const lum = luminanceScale(canvas)

        sky = createFullscreenPass(gl, SKY_FRAG)
        const uSky = createUniformCache(gl, sky.program)

        dropProg = buildProgram(gl, DROP_VERT, DROP_FRAG)
        dropQuads = createInstancedQuads(gl, dropProg.program)
        uDrop = createUniformCache(gl, dropProg.program)

        text = createFullscreenPass(gl, TEXT_FRAG)
        uText = createUniformCache(gl, text.program)
        const atlas = buildGlyphAtlas(FLAP_CHARS, { cellPx: 64 })
        // buildGlyphAtlas returns null when no 2D context is available. The
        // readout is then skipped rather than failing the saver: the scene is
        // still worth showing, and #101 wants the animation robust.
        atlasTex = atlas ? uploadGlyphAtlas(gl, atlas, FLAP_CHARS) : null

        // Bloom on the sun, the brightest cloud edges and the lightning. The sky
        // pass emits HDR (the sun core is 5.0), so there is real headroom above
        // the threshold rather than a bright pass that selects nothing.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 1.0, knee: 0.4, intensity: 0.5, radius: 0.9 },
          tonemap: 'aces',
          dither: true
        })

        // Drop count from area, capped: the wall gets proportionally more
        // precipitation rather than bigger drops (#88).
        const areaScale = (canvas.width * canvas.height) / (1920 * 1080)
        const maxDrops = Math.min(MAX_DROPS, Math.round(DROPS_1080P * areaScale))
        const px = pointScale(canvas, 1)

        eased = null
        flash = 0
        nextFlashAt = 0

        runtime.start((time, frame, glCtx, rt) => {
          const dt = Math.min(rt.dt, 0.1)
          const r = reading()
          const t = targetsFrom(r)
          if (!eased) eased = { ...t }
          // Exponential ease toward the target, frame-rate independent.
          const k = 1 - Math.exp(-dt / (EASE_SECONDS / 4))
          for (const key of Object.keys(t)) {
            eased[key] += (t[key] - eased[key]) * k
          }

          // Lightning, only in a storm. Irregular intervals, sharp attack and a
          // fast decay -- an evenly-spaced flash reads as a strobe.
          if (eased.storm > 0.35) {
            if (time > nextFlashAt) {
              flash = 1
              // rng, not Math.random(): every saver here is reproducible from a
              // logged seed, and a strike schedule drawn from the global RNG
              // would not replay.
              nextFlashAt = time + rng.range(2.5, 9.5)
            }
          }
          flash *= Math.exp(-dt * 7)

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)

          // --- sky
          sky.draw((g) => {
            g.uniform3f(uSky('iResolution'), canvas.width, canvas.height, 1)
            g.uniform1f(uSky('iTime'), time + cloudOffset)
            g.uniform1f(uSky('uCloud'), eased.cloud)
            g.uniform1f(uSky('uWind'), eased.wind)
            g.uniform1f(uSky('uDay'), eased.day)
            g.uniform1f(uSky('uFog'), eased.fog)
            g.uniform1f(uSky('uStorm'), eased.storm)
            g.uniform1f(uSky('uSnowGround'), eased.snowGround)
            g.uniform1f(uSky('uFlash'), flash)
            g.uniform1f(uSky('uLum'), lum)
          })

          // --- precipitation
          const count = Math.round(maxDrops * eased.rate)
          if (count > 0) {
            gl.enable(gl.BLEND)
            // Premultiplied: the fragment shader already scales colour by
            // shape*alpha, so SRC_ALPHA would apply the coverage twice and leave
            // the rain both fainter and darker than intended.
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            gl.useProgram(dropProg.program)
            // Wind direction is "from", meteorological convention, so a westerly
            // pushes rain toward the east. Shear is signed by that, scaled by
            // speed, and divided by aspect so a given wind leans the same amount
            // on the wall as in a window.
            // Wind direction is meteorological "from", so a westerly pushes rain
            // east. Define the lean in SCREEN space first -- dx/dy in pixels, a
            // physical angle -- then derive the normalised drift from it. Doing
            // it the other way round makes the lean depend on the aspect ratio,
            // which is how the 5:1 wall ended up with vertical rain.
            const rad = (r.windDirectionDeg * Math.PI) / 180
            const slope = -Math.sin(rad) * (Math.min(eased.wind, 60) / 60) * 1.5
            const shear = slope / aspect
            gl.uniform2f(uDrop('uQuadScale'), 2 / canvas.width, 2 / canvas.height)
            gl.uniform1f(uDrop('uTime'), time)
            gl.uniform1f(uDrop('uCount'), count)
            gl.uniform1f(uDrop('uFall'), 0.5 + 0.9 * eased.rate)
            gl.uniform1f(uDrop('uShear'), shear)
            gl.uniform1f(uDrop('uSlope'), slope)
            gl.uniform1f(uDrop('uLength'), px * (14 + 26 * eased.rate))
            gl.uniform1f(uDrop('uWidth'), px * 1.7)
            gl.uniform1f(uDrop('uSnow'), eased.snow > 0.5 ? 1 : 0)
            gl.uniform1f(uDrop('uSeed'), dropSeed)
            gl.uniform1f(uDrop('uLum'), lum)
            gl.uniform1f(uDrop('uNight'), 1 - eased.day)
            dropQuads.draw(count)
            gl.disable(gl.BLEND)
          }

          // --- readout
          if (atlasTex) {
            const line = readoutText(r).slice(0, MAX_CHARS)
            const idx = new Int32Array(MAX_CHARS)
            for (let i = 0; i < line.length; i++) {
              const at = FLAP_CHARS.indexOf(line[i])
              idx[i] = at >= 0 ? at : 0
            }
            const cell = Math.max(14, Math.round(canvas.height * 0.030))
            gl.enable(gl.BLEND)
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, atlasTex)
            text.draw((g) => {
              g.uniform3f(uText('iResolution'), canvas.width, canvas.height, 1)
              g.uniform1i(uText('uAtlas'), 0)
              g.uniform1iv(uText('uGlyphs'), idx)
              g.uniform1i(uText('uLen'), line.length)
              g.uniform1f(uText('uCellPx'), cell)
              g.uniform1f(uText('uAlpha'), 0.85)
              g.uniform1f(uText('uLum'), lum)
              g.uniform1f(uText('uSetSize'), FLAP_CHARS.length)
            })
            gl.disable(gl.BLEND)
          }

          if (post) post.present()
        })
      },

      stop() {
        // Every GL object this saver made, and nothing else: the poll timer is
        // owned by weather-source.js precisely so there is nothing non-GL to
        // forget here (#101 warns a leaked interval outlives every subsequent
        // screensaver).
        if (atlasTex && gl) { gl.deleteTexture(atlasTex); atlasTex = null }
        if (dropQuads) { dropQuads.destroy(); dropQuads = null }
        if (dropProg) { dropProg.destroy(); dropProg = null }
        if (text) { text.destroy(); text = null }
        if (sky) { sky.destroy(); sky = null }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        eased = null
      }
    }
  }
}
