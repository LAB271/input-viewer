# Input Viewer - Project Documentation

## Project Overview

Input Viewer is an Electron-based video input display application for viewing multiple video feeds simultaneously with no-signal detection capabilities. It's a lightweight alternative to OBS for simple input monitoring.

## Architecture

```
input_viewer_electron/
├── src/
│   ├── main/index.js          # Electron main process
│   ├── preload/index.js       # Context bridge (IPC)
│   └── renderer/
│       ├── index.html         # Main UI
│       ├── renderer.js        # Core app logic
│       ├── detection-simple.js # No-signal detection
│       ├── styles.css         # Styling
│       └── screensavers/      # No-signal screensavers + WebGL helpers
│           ├── registry.js    # Screensaver list and lifecycle
│           ├── gl-base.js     # Shared GL runtime, pointScale/particleSide
│           ├── seed.js        # Per-activation RNG (wall-clock seeded)
│           ├── preview.html   # Standalone preview harness
│           └── shadercheck.html # Headless shader-compile harness
├── scripts/
│   ├── screensaver-preview.mjs # `npm run screensaver` dev server
│   ├── shader-check.mjs       # `npm run shadercheck` GPU compile check
│   └── test-summary.mjs       # Renders JUnit as a CI job summary
├── test/                      # vitest suites (see Testing below)
├── build/                     # App icons and entitlements
├── package.json               # Dependencies and build config
├── electron.vite.config.mjs   # App build configuration
├── vite.preview.config.mjs    # Screensaver preview harness config
└── vitest.config.mjs          # Test configuration
```

## Key Technologies

- **Electron** 43.x with electron-vite (requires Node 24+)
- **electron-updater** for auto-updates from GitHub releases
- **WebRTC MediaDevices API** for video capture
- **Canvas API** for frame capture and comparison
- **WebGL2** for the screensavers
- **vitest** (+ jsdom for the renderer tests) for unit tests

## Development Commands

```bash
cd input_viewer_electron
npm run dev          # Start dev server with hot reload
npm test             # Run the unit tests
npm run build        # Build for production
npm run build:mac    # Build macOS DMG
npm run build:win    # Build Windows installer

# Preview a screensaver in a browser with a real WebGL2 context.
# --wall emulates the 6000x1200 videowall; W toggles it, L cycles an
# ambient-light washout overlay, S draws a new random seed.
npm run screensaver -- white-particles --wall

# Pin a seed to reproduce an exact look (any string or integer).
# The seed used is logged to the console on every activation.
open 'http://localhost:5180/preview.html?seed=abc#plasma'

# Compile every screensaver's shaders on a real GPU, headlessly.
npm run shadercheck
```

## Screensaver randomness

Every screensaver varies per activation, seeded from the wall clock
(`screensavers/seed.js`). This matters because `gl-base.js` resets `iTime` and
`iFrame` to 0 on every `start()`, so a saver derived purely from those replays
bit-for-bit — 7 of the 12 used to do exactly that.

- `create(canvas, seed)` is the module contract. `seed` is optional; omitted
  means "draw from the clock". `registry.js` resolves and **logs** it, so a run
  can be reproduced by passing the logged value back.
- Pure fragment-shader savers get `uniform vec4 iSeed` (four uncorrelated
  randoms in `[0,1)`, fixed for the activation) declared in `FRAGMENT_HEADER`.
  Use it for phases, targets and palette rotation.
- JS-side savers use `createRng(seed)` — `range/around/int/pick/chance/sign/
  phase`. Build the RNG in `create()`, not `start()`, so choices survive a
  start/stop cycle.
- **`isAvailable()` is optional** (#101). A saver that depends on something
  outside itself may export it and return false to be skipped by the *random*
  rotation. Explicit selection (preview, stepping keys, shadercheck) ignores it,
  so such a saver must still render something defensible without its data. Only
  `weather.js` uses it, and only until a reading is cached. This exists so
  `startScreensaver()` can stay synchronous — an async `prepare()` awaited by the
  registry would have made it async for every caller.
- **Network access lives outside the saver.** `weather-source.js` owns the poll
  and its timer; `weather.js` only reads a cached reading. The registry's failure
  path is a `try { create(); start() } catch`, so a `fetch` rejecting after
  `start()` returns is uncatchable there. Keeping the poll outside also means a
  saver's `stop()` cannot leak a timer into every subsequent screensaver.
- **`observeFrames()` in gl-base** hands the rendered frame to a watcher once per
  frame, for Art-Net reactive mode (#59). It reads a sparse grid of small tiles
  straight from the default framebuffer — **not** a `blitFramebuffer` downscale.
  The context is created `alpha: false`, so the default framebuffer is RGB8 while
  any renderable target is RGBA8, and that colour blit is a format mismatch:
  measured INVALID_OPERATION with LINEAR, NEAREST and no scaling alike, giving an
  all-zero readback. Observers must rate-limit themselves; readback is a pipeline
  stall.
- **Outbound POSTs go through the main process** (`artnet-send` over IPC), not
  renderer `fetch`. In production the renderer is `file://`, so it has no origin,
  and `artnet-relay` sends no CORS headers — a renderer-side POST never gets past
  the preflight. The weather GET is fine in the renderer only because Open-Meteo
  sends permissive CORS.
- **Perturb, don't randomise.** These constants were tuned. Where a bound is
  load-bearing (`sep < ali` radius in boids, feed/kill regimes in
  reaction-diffusion, zoom depth vs float precision in the fractals) say so in a
  comment — several ranges are deliberately tight or drawn from curated lists
  because most of the parameter space looks broken.
- The no-signal screen **rotates every 10 minutes**
  (`state.screensaverRotateDelay`) and never repeats the previous pick. Without
  rotation a fresh seed would be seen once per no-signal event, then frozen for
  hours.

## Testing

`npm test` runs vitest. Note two deliberate quirks:

- **`vitest` is not in `devDependencies`.** CI installs it with
  `npm install --no-save vitest@^4` so the committed `package-lock.json`
  stays in sync for the `npm ci` the release workflow relies on. A bare
  `npm ci` therefore leaves `vitest: command not found` — that is expected.
  `jsdom` *is* a real devDependency.
- **Most suites are DOM-free** and run in the node environment. Only the
  renderer tests need a DOM and they opt in per-file with
  `// @vitest-environment jsdom`, keeping the fast path default.

`renderer.js` builds its `elements` map at module load and calls `init()` at
module scope, guarded by `globalThis.__INPUT_VIEWER_NO_AUTOSTART__` so tests
can import it without booting the app. `test/helpers/renderer-dom.js` derives
the required element ids from `renderer.js` source, so the fixture cannot
silently drift.

**No shader is compiled by `npm test`** — there is no WebGL2 context in the node
environment, and headless-gl would add a native build dependency to `npm ci`.
The split is:

- `test/screensaver-seed.test.js` covers what is checkable without a driver:
  the RNG's distribution and reproducibility, `pickRandomIndex` never repeating,
  and static GLSL checks (balanced braces/parens, malformed numeric literals,
  valid `iSeed` swizzles, every shader saver actually using `iSeed`).
- `npm run shadercheck` drives all 12 savers × 5 seeds through headless Chrome
  against a real GPU, so the driver genuinely compiles and links every shader.

The shadercheck harness calls `create()`/`start()` **directly rather than
through `registry.startScreensaver()`**. The registry deliberately swallows a
start failure and falls back to the DVD logo — right for production, but it
makes failures invisible to a caller. An earlier version of the harness used the
registry and cheerfully reported 60/60 passing while the driver was rejecting a
shader; if you touch that file, re-verify it by injecting a type error and
confirming a non-zero exit.

Node 24+ is required: Electron's own floor is `>= 22.12.0` and jsdom 30
needs `^24.15.0`. Both workflows pin `node-version: '24'`; raise them
together.

## Version Management

- **VERSION** file at repo root - source of truth for releases
- **package.json** version - must stay in sync (auto-release handles this)
- **package-lock.json** version - also bumped by `npm version`, and it must be
  committed with the other two. The Release workflow staged only `VERSION` and
  `package.json` for four releases, so the lock sat at 2.9.0 while package.json
  had reached 2.13.0. `npm ci` tolerates that mismatch, which is why nothing
  failed and nobody noticed.
- Tags follow semver: `v{major}.{minor}.{patch}`

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Description | Version Bump |
|--------|-------------|--------------|
| `feat:` | New feature | Minor (x.Y.0) |
| `fix:` | Bug fix | Patch (x.y.Z) |
| `perf:` | Performance improvement | Patch |
| `refactor:` | Code refactoring | Patch |
| `docs:` | Documentation only | None |
| `style:` | Code style (formatting) | None |
| `test:` | Tests only | None |
| `chore:` | Maintenance tasks | None |
| `build:` | Build system changes | Patch |
| `ci:` | CI/CD changes | Patch |
| `feat!:` or `BREAKING CHANGE` | Breaking change | Major (X.0.0) |

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/short-description` | `feat/add-dark-mode` |
| Bug fix | `fix/issue-description` | `fix/memory-leak-detection` |
| Performance | `perf/optimization-area` | `perf/frame-comparison` |
| Refactor | `refactor/area` | `refactor/settings-module` |
| Documentation | `docs/topic` | `docs/api-reference` |
| Chore | `chore/task` | `chore/update-deps` |

## Auto-Update Configuration

The app fetches updates from the public `LAB271/labs-input-viewer` repo (the
source repo itself). The runtime feed (`setFeedURL` in the main process)
and the electron-builder `publish` config both point there. There is no
longer a separate `input-viewer-releases` repo.

Each release publishes the installers **plus** the electron-updater
metadata required for updates to work:

- macOS: `Input-Viewer-<version>-universal.dmg`, the universal
  `Input-Viewer-<version>-universal.zip` (the zip is what
  electron-updater actually applies), and `latest-mac.yml`
- Windows: `Input-Viewer-Setup-<version>.exe` and `latest.yml`

Both `mac` and `nsis` define an explicit `artifactName`. This is
required, not cosmetic: without it electron-builder names the output
files from the raw `productName` (`Input Viewer` → `Input.Viewer-...`)
while writing the sanitized name (`Input-Viewer-...`) into
`latest-mac.yml`. The two disagree and every macOS auto-update 404s —
see issue #86. If you change `productName` or these `artifactName`
templates, re-run `npx electron-builder --mac --publish never` and
confirm the `url`/`path` values in `dist/latest-mac.yml` match the
filenames actually emitted in `dist/`.

## CI/CD Flow

CI triggers on **PRs targeting `main`** and on pushes to `main` — not on
every branch. A PR based on another branch (a stacked PR) gets **no checks
at all**, so retarget it at `main` before relying on CI. Releasing is a
**manual** step (the Release workflow is `workflow_dispatch`, not triggered
automatically on merge):

```
Feature Branch → PR (base: main) → CI: lint, test & build → Merge to Main
                                      │
        (manually) Run "Release" workflow ──┐
                                      ↓
                              Analyzes commits since last tag
                              Computes version bump (semver)
                              Runs the test suite (gates the release:
                                version-bump needs the lint job)
                              Builds macOS + Windows
                              Bumps VERSION + package.json + package-lock.json,
                                tags v*.*.*
                              Publishes installers + update metadata
                              to GitHub Releases on LAB271/labs-input-viewer
```

Both workflows run the unit tests, so a failing test blocks a release as
well as a PR. Failures are annotated inline on the diff, and each run gets
a job summary with per-file counts (via `scripts/test-summary.mjs`).

## Linting

`npm run lint` runs ESLint 10 with a flat config (`eslint.config.mjs`);
`npm run lint:fix` applies the auto-fixable subset. Both workflows run it,
so a lint error blocks a PR *and* a release.

The config is deliberately **correctness-focused, not a formatter**. It
starts from `js.configs.recommended` — unused/undefined identifiers, dead
code, duplicate keys — plus `no-eval`/`no-new-func` and `eqeqeq` (with
`null: 'ignore'`, since `== null` is idiomatic here). It does not enforce
indentation, quotes or semicolons, so it neither churns the existing ~5,700
lines nor fights the current hand-formatting. Keep it that way unless you
also want to reformat the codebase.

Three environments are configured separately, because they genuinely differ:

| Path | Modules | Globals |
|---|---|---|
| `src/main`, `src/preload` | CommonJS | Node |
| `src/renderer` | ESM | browser (DOM, canvas, WebGL2) |
| `scripts`, `test` | ESM | Node (+ browser for the jsdom tests) |

Trigger a release with `gh workflow run release.yml` (or via the Actions
tab). The `release` skill also covers this.

## Important Files

| File | Purpose |
|------|---------|
| `VERSION` | Current version (source of truth) |
| `.github/workflows/ci.yml` | PR and branch testing |
| `.github/workflows/release.yml` | Version bump, tag, build, and publish (manual dispatch) |

## Performance Considerations

The detection loop runs at ~1.6s intervals (every 100 frames at 60fps).
Key optimizations:
- Canvas context caching
- Pixel sampling (every 4th pixel)
- Debounced settings saves
- Conditional canvas resizing
