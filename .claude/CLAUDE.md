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
│           └── preview.html   # Standalone preview harness
├── scripts/
│   ├── screensaver-preview.mjs # `npm run screensaver` dev server
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
# ambient-light washout overlay.
npm run screensaver -- white-particles --wall
```

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

Node 24+ is required: Electron's own floor is `>= 22.12.0` and jsdom 30
needs `^24.15.0`. Both workflows pin `node-version: '24'`; raise them
together.

## Version Management

- **VERSION** file at repo root - source of truth for releases
- **package.json** version - must stay in sync (auto-release handles this)
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
                              Bumps VERSION + package.json, tags v*.*.*
                              Publishes installers + update metadata
                              to GitHub Releases on LAB271/labs-input-viewer
```

Both workflows run the unit tests, so a failing test blocks a release as
well as a PR. Failures are annotated inline on the diff, and each run gets
a job summary with per-file counts (via `scripts/test-summary.mjs`).

There is **no linter configured**: the "Check code style" step is
`npm run lint --if-present` and currently a no-op, so a green tick there
does not mean style was checked.

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
