# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Electron Version (v2.x)

### [Unreleased]

Merged to `main` but not yet released. The screensaver set now numbers 30.

#### Added

- Four new screensavers: **Physarum** (slime-mould transport network), **Aquarium**
  (schooling fish), **Bicycle Horizon** (first-person cycling POV), and **Weather**,
  which renders the live conditions for a configured location
- **Falling Sand**, **Frost** and **Tree Growth** screensavers
- **Art-Net reactive mode** — pushes the active screensaver's dominant colour to the
  `artnet-relay` service so the room lighting matches the wall. Off by default
- Reference manager in settings, surfacing orphaned no-signal references
- `npm run bench` — benchmarks the CSS, WebGPU and OffscreenCanvas-worker
  compositing paths on a real GPU

Weather and Art-Net are both **off by default** and make no network requests until
configured. See the README for what each sends and where.

#### Changed

- **Eleven screensavers rewritten for the videowall.** Each was redesigned for
  6000×1200 seen across a lit room, rather than tuned:
  - **Plasma** — detail moved out of chroma and into luminance, then lit as a
    heightfield from the analytic fBm gradient. Replaces a wall of undifferentiated
    purple with no large-scale variation
  - **Raymarch Fractal** — penumbra-tracking soft shadows, ambient occlusion, a real
    environment used as both background and IBL source, orbit-trap colouring, and
    temporal accumulation that removes the crawling silhouette
  - **Mandelbrot** — a genuinely unbounded dive by perturbation theory, instead of
    stopping where double precision runs out
  - **Reaction Diffusion** — lit as a relief rather than colour-mapped. Base hue now
    comes from a curated set, so the palette can no longer land on gold or amber
  - **Voronoi** — lit facets, cell count scaled to canvas area, and a bounded value
    range feeding the palette
  - **Metaballs** — a lit, refracting fluid on a Newton-solved 3D isosurface with
    Beer–Lambert interior depth. Replaces concentric rainbow rings on a brown field
  - **Matrix Rain** — real glyphs from the shared atlas across three parallax planes
    on true black. Replaces independently-hashed dot matrices, which were noise
    rather than characters
  - **Starfield Warp** — hundreds of instanced stars with blackbody colour and a
    clear vanishing point, replacing roughly thirty white dashes on flat navy
  - **Pong** — the court letterboxed into a CRT cabinet with a real phosphor
    accumulation buffer. Previously the paddles sat 5460px apart with an empty middle
  - **Truchet Tiles** — multi-scale woven bundles with continuous per-path colour and
    a retiling front that sweeps the wall. Tiles retile by rotating a quarter turn,
    untying and retying as they go
  - **Moiré Interference** — fringes computed analytically from the difference term of
    the grating product, rather than left to emerge from sampling. The look no longer
    depends on pixel pitch, so it is identical on a laptop and on the wall
- `shadercheck` structure baselines updated for six of those savers. Five moved
  **down** and one **up**: the check counts spatial high-frequency content rather than
  structure, so the old values were partly inflated by the very noise these rewrites
  removed. Plasma now sits below the absolute margin and has lost effective coverage;
  Truchet had been carrying a baseline four times below its real density, so a large
  regression there would have passed silently. See #192

#### Fixed

- `createGLRuntime()` did not size the canvas, while 15 screensavers derived an
  aspect, particle count or simulation grid from its dimensions immediately after
  construction. On a first run that meant reading the 300×150 HTML default — on the
  6000×1200 wall, an aspect of 2.0 instead of 5.0
- Oriented quads in Boids were sheared by the display aspect, because the per-axis
  pixel-to-clip conversion was applied before the rotation rather than after
- `shadercheck`'s structure check failed nondeterministically. The measurement was
  taken at a single frame and is bimodal for small-sprite savers; it now samples a
  window and requires any drop to be absolutely meaningful as well as relatively large
- A `node_modules` symlink was committed and both `.gitignore` files only matched the
  directory form, so the symlink slipped past
- The release workflow staged only `VERSION` and `package.json`, silently discarding
  the `package-lock.json` half of every version bump

#### Performance

- No-signal references are stored at detection resolution rather than full frame

### [2.13.0] - 2026-08-09

#### Added

- **Split-flap departures board** as the no-signal display, with fixed board colours
- **Matrix Rain**, **Starfield Warp** and **Pong** screensavers
- **Truchet Tiles**, **Moiré Interference** and **ASCII Doughnut** screensavers
- Multi-reference no-signal detection with a staged comparison
- Keyboard shortcuts to show and step through screensavers in production: `V` toggles,
  `+` / `-` step
- The preview harness now shows the no-signal board

#### Fixed

- Split-flap board sizing and flip animation
- Detection compared a crop of the frame rather than the whole picture
- Off-by-one in the preview's 1-based screensaver hash

### [2.12.0] - 2026-08-07

#### Added

- **Metaballs** and **Game of Life** screensavers

### [2.11.0] - 2026-08-07

#### Added

- **Voronoi** screensaver
- `shadercheck` now checks rendered pixels rather than only compilation, and adds
  structural checks for the WebGPU compositor's WGSL

#### Fixed

- Washed-out raymarch fractal, caused by a double tonemap
- Aspect-correct simulation space for every GPGPU screensaver — previously stretched
  5:1 on the videowall

### [2.10.0] - 2026-08-07

#### Added

- Screensaver runtime: frame-rate-independent trails, an HDR post-processing chain
  and a shared GLSL library

#### Fixed

- `js-yaml` bumped to 4.3.1 for CVE-2026-59870

### [2.9.0] - 2026-08-06

#### Changed

- Every screensaver now varies per activation, seeded from the wall clock. Previously
  savers derived purely from `iTime`/`iFrame` replayed identically every time

### [2.8.0] - 2026-08-05

#### Added

- WebCodecs-based detection with `requestVideoFrameCallback` pacing
- Opt-in WebGPU compositing (off by default)

#### Changed

- Repository cleanup and hardening

### [2.7.0] - 2026-08-04

#### Added

- 6000×1200 videowall emulation in the screensaver preview
- Unit tests for settings parsing and input switching

#### Fixed

- Dim screensavers lifted for big-room displays
- Particle counts scaled with canvas area, so particles stay visible on the videowall
- Explicit `mac.artifactName`, without which every macOS auto-update 404s

#### Changed

- Node 24 LTS across both workflows
- The release gate now runs the test suite and surfaces the results

#### Performance

- `compareFrames` exits early once a match is impossible

### [2.6.2] - 2026-08-03

#### Changed

- **Relicensed from MIT to Apache-2.0**, with SPDX headers added across the source
- Releases now go through a bump PR instead of pushing to protected `main`
- Vite 8.2.0 with electron-vite 6.0.0-beta.1
- Public-repository meta files applied; references updated after the repository rename
- Numerous dependency and GitHub Actions updates

#### Added

- Unit tests

#### Fixed

- npm audit vulnerabilities
- DVD logo screensaver drawn smaller

### [2.6.1] - 2026-06-08

#### Fixed

- Auto-update metadata is now published, so updates are served from this repository

### [2.6.0] - 2026-06-07

#### Added

- **WebGL2 screensaver framework with 12 screensavers**
- Presenter tool debug overlay

#### Fixed

- Double colour change when the screensaver hit an edge

#### Changed

- Supplier branding renamed to Lab271@SchubergPhilis
- The public releases repository was removed from the release pipeline
- A lint job was added to the release workflow as a required status check

### [2.5.4] - 2026-04-17

#### Changed

- CI and release workflows separated
- Auto-updater points at the main repository instead of the releases repository
- Legacy Python application removed (GPL dependency)
- Dependencies upgraded, clearing 73 reported security vulnerabilities

### [2.5.3] - 2026-04-16

#### Added

- `docs/USER_GUIDE.md`

#### Fixed

- Video capture quality for HDMI capture cards

### [2.5.2] - 2026-01-26

#### Fixed

- Remote keyboard accepts both arrow keys and Page Up/Down

### [2.5.1] - 2026-01-26

#### Changed

- Remote keyboard moved to Page Up/Down

### [2.5.0] - 2026-01-26

#### Added

- Remote keyboard support for presenter control

### [2.4.0] - 2026-01-24

#### Added

- Shake detection, audio controls and touch support

### [2.3.1] - 2026-01-24

#### Fixed

- `defaultInputId` is now saved and loaded with the rest of the settings

### [2.3.0] - 2026-01-23

#### Added

- Redesigned dropdown and a settings modal

### [2.2.2] - 2026-01-23

#### Fixed

- No-signal overlay redesigned with scanlines and a glitch effect

### [2.2.1] - 2026-01-23

#### Fixed

- Build artifacts now have correct version in filenames

### [2.2.0] - 2026-01-19

#### Added

- DVD-style bouncing logo screensaver when feeds lose signal
  - Bouncing logo animation with color changes on bounce
  - 5-minute delay before screensaver activates
  - Activates when all feeds show no-signal

#### Changed

- Consolidated CI/CD into single workflow
- Improved release automation

### [2.1.13] - 2026-01-16

#### Fixed

- Center divider logo now constrained to fit within gap

### [2.1.12] - 2026-01-16

#### Fixed

- Center divider logo scales to fit height on wide screens

### [2.1.11] - 2026-01-16

#### Fixed

- Video capture retries at device max resolution if initial resolution is low

### [2.1.10] - 2026-01-16

#### Fixed

- Request exact 1920x1200 resolution from capture device

### [2.1.9] - 2026-01-16

#### Fixed

- Use min constraints to force higher video capture resolution

### [2.1.8] - 2026-01-16

#### Fixed

- Enable hardware acceleration for better video quality

### [2.1.7] - 2026-01-16

#### Fixed

- Improved video capture quality with higher resolution constraints

### [2.1.5] - 2026-01-16

#### Fixed

- Prevent video cropping in single view mode

### [2.1.4] - 2026-01-16

#### Changed

- Streamlined CI/CD pipeline

### [2.1.0] - 2026-01-16

#### Added

- Automatic releases triggered by conventional commits
- Version bumping based on commit types (feat/fix/etc.)

### [2.0.0] - 2026-01-11

#### Added

- Complete rewrite using Electron + electron-vite
- Native installers for macOS (.dmg) and Windows (.exe)
- Auto-updater with GitHub releases integration
- Dual/Single view modes with keyboard shortcuts
- Freeze frame functionality (Space key)
- Settings panel with input configuration
- No-signal detection with reference screenshot capture
- Center gap and border width sliders
- Logo overlay in center divider and single view mode
- Dropdown panel for settings access

#### Changed

- Switched from Python/PyQt6 to JavaScript/Electron
- Improved performance with WebRTC MediaDevices API
- Cleaner UI with modern styling

---

## Python Version (v1.x) - Legacy

### [1.5.3] - 2025-12-24

#### Added

- File logging for bundled apps to help debug crashes
- Global exception handler to catch and log crashes with full stack traces
- Log file location: `%APPDATA%\Input Viewer\app.log` (Windows)

### [1.5.2] - 2025-12-24

#### Fixed

- Fixed Windows dual screen not working when both feeds use same input
- Mirror left feed to right display when using same camera input

### [1.5.1] - 2025-12-24

#### Fixed

- Fixed Windows crash when switching cameras (QImage memory issue)
- Fixed no-signal animation not showing on Windows (missing mp4 in bundle)
- Added fallback camera backend on Windows if DirectShow fails
- Added error handling in camera worker thread to prevent freezes
- Added icon.ico to Windows bundle

### [1.5.0] - 2025-12-24

#### Added

- Display Settings panel with configurable options:
  - Screensaver delay (10-300 seconds)
  - Cursor hide delay (1-30 seconds)
  - Side margin (0-500 pixels)
  - Center gap (0-500 pixels)
- Reset to Defaults button for display settings
- Settings are saved to settings.json and applied in real-time

#### Changed

- Reduced default capture resolution from 4K to 1080p for better performance

### [1.4.6] - 2025-12-24

#### Fixed

- Fixed mouse shake detection to properly reveal cursor when hidden
- Mouse tracking now enabled on all child widgets for reliable event capture
- Improved shake detection algorithm with better direction reversal tracking

#### Added

- Screensaver now exits on mouse shake (in addition to showing cursor)
- Screensaver now exits on any keyboard input

### [1.4.0] - 2025-12-24

#### Added

- Threaded camera capture with `CameraWorker` for non-blocking frame reads
- `HoverIcon` base class for reusable icon widgets with hover effects
- Architecture documentation (`input_viewer/ARCHITECTURE.md`)

#### Changed

- Camera feeds now run in background threads (~60fps capture)
- UI timer only handles display, not blocking I/O

#### Performance

- Smoother frame rate due to parallel camera capture
- Reduced UI blocking during frame reads
- Better CPU utilization with threaded workers

### [1.3.0] - 2025-12-16

#### Changed

- Updated capture resolution to 4K (3840x2160) at 30Hz
- Added attribution in info panel

### [1.2.0] - 2025-12-16

#### Changed

- Replaced no-signal detection with vision model using multi-vector feature extraction
- No-signal detection now compares against reference image
- Uses cosine similarity on color histograms, spatial intensity, edge density, and statistical features

### [1.0.0] - 2025-12-13

#### Added

- Multi-input video feed display
- Layout modes: Dual view, Single left, Single right
- Direct input selection with number keys 1-4
- Settings panel with toggle switches for input configuration
- Live settings reload without app restart
- Custom no-signal animation
- Fullscreen support
- Input name overlay when switching inputs
- Keyboard shortcuts info panel

[2.13.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.13.0
[2.12.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.12.0
[2.11.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.11.0
[2.10.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.10.0
[2.9.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.9.0
[2.8.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.8.0
[2.7.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.7.0
[2.6.2]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.6.2
[2.6.1]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.6.1
[2.6.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.6.0
[2.5.4]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.5.4
[2.5.3]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.5.3
[2.5.2]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.5.2
[2.5.1]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.5.1
[2.5.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.5.0
[2.4.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.4.0
[2.3.1]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.3.1
[2.3.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.3.0
[2.2.2]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.2.2
[2.2.1]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.2.1
[2.2.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.2.0
[2.1.13]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.13
[2.1.12]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.12
[2.1.11]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.11
[2.1.10]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.10
[2.1.9]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.9
[2.1.8]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.8
[2.1.7]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.7
[2.1.5]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.5
[2.1.4]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.4
[2.1.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.1.0
[2.0.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v2.0.0
[1.5.3]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.5.3
[1.5.2]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.5.2
[1.5.1]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.5.1
[1.5.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.5.0
[1.4.6]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.4.6
[1.4.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.4.0
[1.3.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.3.0
[1.2.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.2.0
[1.0.0]: https://github.com/LAB271/labs-input-viewer/releases/tag/v1.0.0
