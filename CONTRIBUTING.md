# Contributing

Thanks for taking the time to look at this project!

Contributions are governed by the [Apache-2.0 License](LICENSE), and
participation by the [Code of Conduct](CODE_OF_CONDUCT.md).

By opening a pull request you agree that your contribution is licensed under the
Apache License 2.0, the same terms as the rest of the repository.

Do not report security issues here - see [SECURITY.md](SECURITY.md).

## Commit Message Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automatic versioning.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types and Version Bumps

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | **Minor** (1.0.0 → 1.1.0) |
| `fix` | Bug fix | **Patch** (1.0.0 → 1.0.1) |
| `perf` | Performance improvement | **Patch** |
| `refactor` | Code refactoring | **Patch** |
| `build` | Build system changes | **Patch** |
| `ci` | CI configuration | **Patch** |
| `docs` | Documentation only | No bump |
| `style` | Code style (formatting) | No bump |
| `test` | Adding tests | No bump |
| `chore` | Maintenance tasks | No bump |

### Breaking Changes

Add `!` after the type or include `BREAKING CHANGE:` in the footer for a **Major** bump:

```
feat!: remove deprecated API

BREAKING CHANGE: The old API has been removed.
```

### Examples

```bash
# Patch bump
git commit -m "fix: resolve crash when no inputs are enabled"
git commit -m "perf: optimize frame rendering"

# Minor bump
git commit -m "feat: add keyboard shortcut customization"
git commit -m "feat(settings): add dark mode toggle"

# Major bump
git commit -m "feat!: change settings.json format"
git commit -m "refactor!: rename CameraFeed to InputFeed"

# No version bump
git commit -m "docs: update README with new shortcuts"
git commit -m "test: add settings validation tests"
git commit -m "chore: update dependencies"
```

## Automatic Releases

When you push to `main`:

1. **Auto-Release workflow** analyzes commit messages
2. Determines version bump (major/minor/patch/none)
3. Updates `VERSION` file
4. Creates a git tag (e.g., `v1.2.0`)
5. **Release workflow** triggers on the new tag
6. Builds executables for all platforms
7. Creates GitHub Release with binaries

## Manual Release

To manually create a release:

```bash
# Update version
echo "2.0.0" > VERSION
git add VERSION
git commit -m "chore: bump version to 2.0.0"
git push

# Create and push tag
git tag -a v2.0.0 -m "Release v2.0.0"
git push origin v2.0.0
```

## GitHub Workflows

This project uses GitHub Actions for CI/CD. **Only the Electron app is built/tested** (no Python CI).

### Workflow Files

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | Lint & build test on every push/PR |
| `.github/workflows/auto-release.yml` | Version bump & tag on push to main |
| `.github/workflows/release.yml` | Build & publish on tag or manual trigger |

### CI (`ci.yml`)

- **Triggers:** Push to any branch, PRs to main
- **Runner:** macOS (required for build testing)
- **Steps:** npm lint → electron-vite build → macOS DMG build test
- **Purpose:** Validate code before merge

### Auto Release (`auto-release.yml`)

- **Triggers:** Push to main (ignores docs, assets)
- **Steps:** Analyze commits → bump VERSION → create git tag
- **Purpose:** Automatic semantic versioning

### Build & Release (`release.yml`)

- **Triggers:** Tag push (`v*.*.*`), manual `workflow_dispatch`
- **Builds:** macOS DMG (universal), Windows NSIS installer
- **Publishes to:** This repo's GitHub Releases (`LAB271/labs-input-viewer`)
- **Manual trigger:** Can specify tag or use latest

### Trigger Flow

```
Push to feature branch ──► CI (lint + build test)
           │
           ▼
Open PR to main ──────────► CI (lint + build test)
           │
           ▼
Merge PR to main ─────────► Auto-release (bump version, create tag)
           │
           ▼
Tag created ──────────────► Release (build macOS + Windows, publish)
```

### Re-running Failed Builds

Use the manual `workflow_dispatch` trigger on the Release workflow:
1. Go to Actions → "Build and Release"
2. Click "Run workflow"
3. Enter tag (e.g., `v1.2.0`) or leave empty for latest tag

