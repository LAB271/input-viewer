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
# The selector is matched after lowercasing and stripping whitespace, hyphens and
# underscores, so white-particles, whiteparticles and "White Particles" all work.
npm run screensaver -- white-particles --wall

# Pin a seed to reproduce an exact look (any string or integer).
# The seed used is logged to the console on every activation.
open 'http://localhost:5180/preview.html?seed=abc#plasma'

# Compile every screensaver's shaders, headlessly. Forces SwiftShader.
npm run shadercheck

# Benchmark the CSS, WebGPU and OffscreenCanvas-worker compositing paths (#62),
# with a fake capture device. Does NOT force SwiftShader -- see below.
npm run bench -- --size 6000x1200 --seconds 8

# Regenerate the shadercheck structure baselines. READ THE CAVEAT BELOW FIRST.
npm run baselines

# Test-mode launch flags (#248). Reach the no-signal board and the screensavers
# without unplugging a capture card. Note the bare `--`: everything after it is
# forwarded to Electron rather than consumed by electron-vite.
npm run dev -- -- --no-signal                      # split-flap board, immediately
npm run dev -- -- --mock                           # 4 synthetic inputs, no hardware
npm run dev -- -- --mock=2 --no-signal             # 2 inputs, both dark
npm run dev -- -- --no-signal --screensaver-delay=0  # straight to a screensaver

# The same flags against an installed build, which is how you would use them on
# the wall itself rather than on a dev machine.
open -a 'Input Viewer' --args --no-signal --screensaver-delay=0
```

### Keyboard shortcuts live in one list (#258)

`src/renderer/shortcuts.js` is the single source of truth: keys, the chips the UI
prints, labels, and whether each suppresses the default action. It holds no
behaviour and imports nothing.

Four consumers read from it, and none of them keeps its own copy:

| Consumer | How |
|---|---|
| the keydown handler | `SHORTCUTS_BY_KEY.get(event.key.toLowerCase())`, then `SHORTCUT_ACTIONS[id]` |
| the dropdown | `renderShortcutHints()` labels Dual/Single; the **single-view** input rows get `inputKeyFor(index)` |
| the Settings table | `renderShortcutHints()` fills `#shortcuts-table`, which ships empty |
| `README.md` and `docs/USER_GUIDE.md` | still hand-written, but a test asserts every chip appears in both |

Adding a key means adding one entry and one action. The entry alone gets you a
row in the table and a hint in the dropdown with a key that does nothing, and a
test fails for exactly that.

**Why this is worth the indirection.** There were four lists before, and three had
drifted. The Settings table was missing `Q`, `V`, `+`/`-` and `F11`; README was
missing the remote-keyboard row; USER_GUIDE was missing `F11`. Nothing ever
failed -- they were just quietly wrong for however long nobody looked.

Two things about the UI side worth not re-learning:

- The chips are sized off this UI's 12px floor, not shrunk until they stopped
  competing. A first pass at 10px / opacity 0.55 read fine on a laptop and was
  invisible on the wall -- 6000x1200 in a lit room. A test pins the floor.
- The dropdown rows put the device name in a `<span>` with `min-width: 0`. Without
  it the flex default of `min-width: auto` holds a long capture-card label at full
  width and pushes the chip out of the row instead of ellipsising.

Past the fourth input row `inputKeyFor()` returns null and no chip is drawn. The
wall can have more capture devices than there are number keys, and labelling a
fifth row `5` would promise a binding that does not exist.

**The dual columns carry no chip, and that is about correctness, not space.**
`1`-`4` call `selectInput()` with the default `side='both'` and set BOTH feeds;
clicking a row in the Left column calls `selectInputForSide(id, 'left')` and sets
one. A chip on a per-side row documents a key that does something different from
the control beside it. In single view one feed is shown, so setting both and
setting that one are the same thing to the operator, and the chip is honest.

It was reported as a fit bug in dual view, and it was that as well. Two things had
to be fixed:

- `.column-layout` needed `minmax(0, 1fr)`, not `1fr`. A bare `1fr` is
  `minmax(auto, 1fr)` and the auto minimum is the item's **min-content** size, so a
  `white-space: nowrap` name pinned the tracks open: they computed to 339.758px
  each inside a 358px panel and spilled ~320px out of the dropdown. Same trap as
  flex `min-width: auto`, one level up — and the flex one was already fixed in this
  file, which is how the grid one got missed.
- Name truncation is scoped to `.single-input-option .input-option-name`, the only
  list with a chip. A ~173px column has no room to both truncate and stay
  readable, so dual-column names wrap as they did before the chips existed.

### The test-mode launch flags (#248)

| Flag | Effect |
|---|---|
| `--mock[=N]` | N synthetic inputs (1-8, default 4). No capture hardware, no camera permission prompt. |
| `--no-signal` | Pins every input into the no-signal state, so the split-flap board is up from launch. |
| `--screensaver-delay=MS` | Replaces the five-minute wait. `0` starts a saver as soon as the state is reached. |

Orthogonal on purpose. `--no-signal` alone is the fast path to the board on any
machine; adding `--mock` gives you named inputs to switch between while they are
all dark, which is what exercises the per-side transitions rather than just the
initial state.

Three things worth knowing before using these:

**`--mock` never writes settings.** `saveSettings()` returns early in mock mode.
Without that guard one mock run would persist `mock-input-1`..`mock-input-4` into
the real `settings.json` and could leave `defaultInputId` pointing at a device
that will never exist again -- the next production launch would start on a dead
input. Renames and enable/disable still work in mock mode, they just stay in
memory.

**`--no-signal` is enforced in exactly one place:** `hideNoSignal()` returns
early. Every path that would clear the overlay -- a stream starting, detection
reporting signal restored, an input switch -- goes through there, so one guard
covers all of them. Do not push that check out to the call sites; that is how one
gets missed and the forced state silently un-forces itself.

Separately, the flag also stops the detection loop from starting at all, rather
than letting it run and discarding every verdict. Otherwise each cycle would pay
a GPU readback for a result `hideNoSignal()` then refuses to act on, and would
log a "signal restored" that never happens.

**Mock inputs are real MediaStreams**, from `canvas.captureStream()`, not a stub
in front of the video elements. They flow through `srcObject`, `readyState`,
`getVideoTracks()`, the `MediaStreamTrackProcessor` in `frame-source.js` and the
downscale, so detection cannot tell one from a capture card. That is the point:
a stub would only prove the UI renders.

Parsing lives in `src/renderer/test-flags.js`, apart from both processes, because
it is the one part that is pure and therefore unit tested. Main forwards
candidate arguments without parsing them (it is CommonJS and cannot import the
ESM parser); its filter is deliberately looser than the parser's known-flag list
so a typo like `--nosignal` still reaches the renderer and gets logged as
unrecognised. A flag that silently does nothing means someone at the wall is
looking at a production-mode screen believing it is in test mode.

### shadercheck forces SwiftShader; bench deliberately does not

`shadercheck` pins the software rasteriser on purpose, because its job is a
deterministic yes/no on whether every shader compiles and renders sane pixels, and
a deterministic answer is worth more than a fast one. `bench` measures *time*, and
a timing taken on a software rasteriser is meaningless, so it runs on the real GPU.

Getting this backwards has cost real work: several PRs claimed frame cost "cannot
be measured headlessly" because they had seen shadercheck's SwiftShader numbers.
It can — headless Chrome gives ANGLE/Metal on an M3 Pro, and every frame-cost
figure in the issues was measured that way.

### `npm run baselines` rewrites all 30 entries

It regenerates every line of `structure-baselines.js` from one fresh measurement.
When ONE saver is deliberately redesigned and its density legitimately moves, edit
only that saver's line by hand: regenerating buries the intended change among 29
lines of run-to-run noise, and conflicts with every other open PR touching the
file. Six baselines moved during the #210/#214..#220 batch and regenerating would
have made those PRs mutually unmergeable. Keep entries in descending value order —
a test enforces it.

### Preview harness keys

Documented here as well as in the HUD legend, because these are the review tools
and the HUD is only visible once you already know to look.

| Key | Purpose |
|---|---|
| `W` | Videowall emulation at 6000x1200 — the geometry that ships, and where most composition problems only become visible |
| `L` | Ambient-light washout (0 / 6 / 12 / 20%), for the lit-room case in #88 |
| `A` | Cycle canned weather states, so rain, snow, fog and night are reviewable without waiting for real weather |
| `S` | Restart with a NEW seed — how you check that a saver's randomised ranges all look good |
| `R` | Restart with the SAME seed, for iterating on one exact look |
| `←` `→` | Previous / next screensaver |
| `H` | Show or hide the HUD |
| `F` | Fullscreen |
| `[` `]` | Bloom threshold down / up |
| `-` `+` | Bloom intensity down / up |
| `0` | Reset bloom to the saver's own settings |

Note the collision: in the shipped app `+` and `-` step through screensavers, but in
this harness they adjust bloom intensity — use the arrow keys here.

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
