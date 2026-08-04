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

# After PR merge, release happens automatically
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

1. **Auto-Release workflow** runs on `main` push
2. Analyzes commit messages since last tag
3. Determines version bump (major/minor/patch/none)
4. Updates `VERSION` file and `package.json`
5. Creates and pushes tag `v*.*.*`
6. **Build and Release workflow** triggers on new tag
7. Builds macOS and Windows packages
8. Publishes to this repo's GitHub Releases

### Release Flow Diagram

```
PR Merged to main
        ↓
Auto-Release Workflow
        ↓
┌───────────────────────┐
│ Analyze commits       │
│ feat: → minor bump    │
│ fix:  → patch bump    │
│ docs: → no bump       │
└───────────────────────┘
        ↓
Bump VERSION file
Update package.json
        ↓
Create tag v2.1.0
Push tag to origin
        ↓
Build & Release Workflow
        ↓
┌───────────────────────┐
│ Build macOS (universal)│
│ Build Windows (x64)    │
└───────────────────────┘
        ↓
Publish to GitHub Releases
- LAB271/labs-input-viewer
```

---

## 6. Manual Release (Emergency)

If auto-release fails or you need manual control:

```bash
# 1. Update VERSION file
echo "2.1.1" > VERSION

# 2. Update package.json version
cd input_viewer_electron
npm version 2.1.1 --no-git-tag-version
cd ..

# 3. Commit version bump
git add VERSION input_viewer_electron/package.json
git commit -m "chore: bump version to 2.1.1"
git push

# 4. Create and push tag
git tag -a v2.1.1 -m "Release v2.1.1"
git push origin v2.1.1

# This triggers the Build and Release workflow
```

Or use GitHub Actions UI:
1. Go to Actions → Build and Release
2. Click "Run workflow"
3. Enter tag (e.g., `v2.1.1`) or leave empty for latest

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

# After approval, merge immediately
# Auto-release will create a patch version
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

If VERSION and package.json are out of sync:

```bash
# Sync package.json to VERSION
VERSION=$(cat VERSION)
cd input_viewer_electron
npm version $VERSION --no-git-tag-version --allow-same-version
```

### Release Not Triggering

Check:
1. Commit message format (must be conventional)
2. Auto-release workflow logs
3. Ensure not just `docs:` or `chore:` commits
