# Development Workflow

## Quick Reference

```bash
# Start new feature
git checkout main && git pull
git checkout -b feat/my-feature

# Develop and test locally
cd input_viewer_electron
npm run dev

# Commit frequently
git add . && git commit -m "feat: add new capability"
git push -u origin feat/my-feature

# Create PR when ready
gh pr create --title "feat: my feature" --body "Description..."

# After PR merge, trigger the release by hand (it is workflow_dispatch, not automatic)
# gh workflow run release.yml
```

---

## 1. Starting a New Feature

### Create a Branch

```bash
# Ensure you're on latest main
git checkout main
git pull origin main

# Create feature branch with proper naming
git checkout -b <type>/<short-description>
```

**Branch naming conventions:**

| Type | Use When | Example |
|------|----------|---------|
| `feat/` | Adding new functionality | `feat/keyboard-shortcuts` |
| `fix/` | Fixing a bug | `fix/memory-leak` |
| `perf/` | Performance improvements | `perf/detection-speed` |
| `refactor/` | Code restructuring (no behavior change) | `refactor/settings-module` |
| `docs/` | Documentation changes | `docs/readme-update` |
| `chore/` | Maintenance (deps, configs) | `chore/update-electron` |
| `test/` | Adding or fixing tests | `test/detection-unit-tests` |

---

## 2. Local Development

### Start Development Server

```bash
cd input_viewer_electron
npm run dev
```

This starts electron-vite with hot reload. Changes to renderer files auto-refresh.

### Test a Production Build

```bash
# Build the app
npm run build

# Create macOS package (unsigned)
npm run build:mac

# Create Windows package
npm run build:win

# Quick test without packaging
npm run start
```

---

## 3. Committing Changes

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Examples:**

```bash
# Simple feature
git commit -m "feat: add freeze frame indicator"

# Bug fix with scope
git commit -m "fix(detection): handle zero-dimension canvas"

# Performance improvement
git commit -m "perf: cache canvas context for detection loop"

# Breaking change (triggers major version bump)
git commit -m "feat!: change settings file format

BREAKING CHANGE: Settings from v1.x are not compatible"

# With body for complex changes
git commit -m "refactor(renderer): extract detection into module

- Move detection logic to detection-simple.js
- Add pixel sampling for performance
- Implement debounced state changes"
```

### Commit Types and Version Impact

| Type | Version Bump | When to Use |
|------|--------------|-------------|
| `feat` | **Minor** (1.X.0) | New user-facing feature |
| `fix` | **Patch** (1.1.X) | Bug fix |
| `perf` | **Patch** | Performance improvement |
| `refactor` | **Patch** | Code change without behavior change |
| `build` | **Patch** | Build system changes |
| `ci` | **Patch** | CI/CD changes |
| `docs` | None | Documentation only |
| `style` | None | Code formatting |
| `test` | None | Test changes |
| `chore` | None | Maintenance |
| `feat!` | **Major** (X.0.0) | Breaking change |

---

## 4. Pushing and Pull Requests

### Push Your Branch

```bash
# First push (set upstream)
git push -u origin feat/my-feature

# Subsequent pushes
git push
```

### Create Pull Request

```bash
# Using GitHub CLI
gh pr create --title "feat: add new feature" --body "## Summary
- Added X capability
- Fixed Y issue

## Test Plan
- [ ] Test locally with dev server
- [ ] Verify build succeeds"

# Or use GitHub web UI
```

### PR Requirements

1. **CI must pass** - Lint, build, and package test
2. **Descriptive title** - Use conventional commit format
3. **Description** - Explain what and why
4. **Test plan** - How to verify the change

---

## 5. Merging and Release

### Merge Options

- **Squash and merge** (recommended) - Combines all commits into one clean commit
- **Merge commit** - Preserves all commits (use for large features)

### What Happens After Merge

**Nothing releases.** Merging to `main` runs CI and stops there. Releasing is a
separate, deliberate step you take by hand:

```bash
gh workflow run release.yml     # or Actions -> Release -> Run workflow
```

There is exactly one release workflow, `Release` (`.github/workflows/release.yml`),
and its only trigger is `workflow_dispatch`. Nothing runs on a push to `main` except
CI, and **nothing at all is triggered by pushing a tag**.

### What the Release workflow does, in one run

1. Analyzes commit messages since the last tag and computes the bump
   (`feat:` -> minor, `fix:`/`perf:`/`refactor:`/`build:`/`ci:` -> patch, `!:` or
   `BREAKING CHANGE` -> major, anything else -> none)
2. Runs lint and the test suite, which **gates** the release
3. Builds macOS (universal) and Windows (x64)
4. Bumps `VERSION`, `package.json` **and `package-lock.json`** together
5. Creates and pushes the tag `v*.*.*`
6. Publishes the installers plus `latest-mac.yml` / `latest.yml` to this repo's
   GitHub Releases

All six are jobs in that single workflow. The `force_release` input releases even when
the computed bump is `none`.

### Release Flow Diagram

```
PR Merged to main
        ↓
CI only -- lint, test, build. No release.
        ↓
   (you run it)  gh workflow run release.yml
        ↓
Release workflow
        ↓
┌────────────────────────────┐
│ Analyze commits            │
│ feat:  -> minor bump       │
│ fix:   -> patch bump       │
│ docs:  -> no bump          │
├────────────────────────────┤
│ Lint + test (gates below)  │
├────────────────────────────┤
│ Build macOS (universal)    │
│ Build Windows (x64)        │
├────────────────────────────┤
│ Bump VERSION,              │
│ package.json,              │
│ package-lock.json          │
│ Tag v*.*.*                 │
└────────────────────────────┘
        ↓
Publish to GitHub Releases
- LAB271/labs-input-viewer
- installers + latest-mac.yml + latest.yml
```

---

## 6. Releasing

The normal path is the only path, and it is manual:

```bash
gh workflow run release.yml
gh run watch                     # or Actions -> Release
```

Or in the UI: **Actions -> Release -> Run workflow**. Tick `force_release` only if you
want a release when the computed bump is `none`.

### After it finishes, check two things

Both have failed silently before, and neither shows up as a red run:

**All three version files moved together.** The workflow staged only `VERSION` and
`package.json` for four releases, leaving `package-lock.json` stranded at 2.9.0 while
`package.json` reached 2.13.0. `npm ci` tolerates the mismatch, which is why nobody
noticed. Fixed in #197.

```bash
cat VERSION
python3 -c "import json;print(json.load(open('input_viewer_electron/package.json'))['version'])"
python3 -c "import json;print(json.load(open('input_viewer_electron/package-lock.json'))['version'])"
```

**The update manifests point at files that exist.** If the emitted asset names disagree
with the paths written into `latest-mac.yml`, every macOS auto-update 404s while the
release itself looks perfect -- see #86.

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
gh release download vX.Y.Z --pattern '*.yml' --dir /tmp && grep -E 'url|path' /tmp/latest*.yml
```

### Do not release by pushing a tag

Nothing is triggered by a tag push. Creating and pushing `vX.Y.Z` by hand builds
nothing, publishes nothing, and leaves a tag with no release attached to it -- which
then has to be deleted before the real release can use that version. Earlier revisions
of this document described exactly that procedure; it never worked against the current
workflow.

---

## 7. Hotfix Process

For urgent fixes to production:

```bash
# Create hotfix branch from main
git checkout main && git pull
git checkout -b fix/critical-bug

# Make fix
# ... edit files ...

# Commit with fix: prefix
git commit -m "fix: resolve critical startup crash"

# Push and create PR
git push -u origin fix/critical-bug
gh pr create --title "fix: resolve critical startup crash"

# After approval, merge immediately, then release by hand
gh workflow run release.yml
# A fix: commit computes a patch bump
```

---

## Troubleshooting

### CI Failing

```bash
# Check locally
cd input_viewer_electron
npm ci
npm run lint --if-present
npm run build
```

### Version Mismatch

All THREE files must agree: `VERSION`, `package.json` and `package-lock.json`.
`npm version` updates the last two together, which is the point -- syncing only
`package.json` is how the lock sat at 2.9.0 while `package.json` reached 2.13.0 for
four releases (#197). `npm ci` tolerates that mismatch, so nothing fails and nobody
notices.

```bash
VERSION=$(cat VERSION)
cd input_viewer_electron
npm version $VERSION --no-git-tag-version --allow-same-version
# Verify all three, then commit all three:
git add ../VERSION package.json package-lock.json
```

### No Release Appeared

**First: did you run it?** Releasing is `workflow_dispatch` -- merging to `main` does
not release, and neither does pushing a tag. `gh run list --workflow release.yml`
shows whether a run exists at all.

If a run exists and produced no release:

1. The computed bump was `none` -- only `docs:`/`style:`/`test:`/`chore:` commits since
   the last tag. Re-run with `force_release` if you want one anyway.
2. Commit messages are not conventional, so nothing matched the bump patterns.
3. The lint/test job failed, which gates the release deliberately.
4. Check the `Release` workflow logs -- not "Auto-Release", which does not exist.
