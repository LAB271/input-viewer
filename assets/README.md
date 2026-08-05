# Assets Directory

This directory contains assets for the Input Viewer application.

## Required for Release Builds

To enable app icons in release builds, add the following files:

- `icon.icns` - macOS app icon (1024x1024 recommended)
- `icon.ico` - Windows app icon (256x256 recommended)
- `icon.png` - Linux/general icon (512x512 recommended)

If these files are not present, the release will build without custom icons.

## Documentation images

- `screenshot-dual.png` - dual view with the input dropdown open, shown at the
  top of the root README. Downscaled to 1800px wide; the original capture was
  3600px / 1.6 MB, which is more than a README needs.
- `demo.gif` - **not yet added.** A short clip of `D`/`S` layout switching and
  `1`-`4` input selection (issue #49). The markup is already in the README,
  commented out; uncomment it once the file exists.
