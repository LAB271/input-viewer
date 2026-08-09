# Input Viewer

[![CI/CD](https://github.com/LAB271/labs-input-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/LAB271/labs-input-viewer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LAB271/labs-input-viewer)](https://github.com/LAB271/labs-input-viewer/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A lightweight video input viewer — **OBS without the complexity**. View and manage capture card feeds with a clean, simple interface designed for users who need to display video inputs without the overhead of full streaming software.

![Input Viewer in dual view, with the input dropdown open](assets/screenshot-dual.png)

*Dual view with the dropdown open: per-side input selection, per-input and
system volume, and the centre divider between the two feeds.*

## Download

Download the latest release for your platform:

- **macOS**: [Input Viewer.dmg](https://github.com/LAB271/labs-input-viewer/releases/latest)
- **Windows**: [Input Viewer Setup.exe](https://github.com/LAB271/labs-input-viewer/releases/latest)

The app includes auto-updates and will notify you when new versions are available.

> **Note:** Releases live in **this** repository. The separate
> `LAB271/input-viewer-releases` repo is retired — it stopped receiving
> builds at v2.5.2 and is no longer authoritative. The in-app auto-updater
> also points here, so downloads and updates come from the same place.

## Features

- **Multi-input display** — View one or two video feeds side by side
- **Layout switching** — Dual view or single feed centered
- **Direct input selection** — Number keys 1-4 to switch inputs instantly
- **Freeze frame** — Pause any feed with Space key
- **Settings panel** — Configure inputs with toggle switches
- **No-signal detection** — Custom overlay when source disconnects
- **DVD screensaver** — Bouncing logo when feeds lose signal
- **Fullscreen support** — Designed for dedicated display setups
- **Auto-updater** — Automatic updates from GitHub releases
- **Any capture card** — Works with any video capture device

## Keyboard Shortcuts

| Key         | Action                              |
| ----------- | ----------------------------------- |
| `D`         | Dual view (both feeds) — *see note* |
| `S`         | Single view (selected feed centered) — *see note* |
| `1-4`       | Select input directly               |
| `Space`     | Freeze/unfreeze current feed        |
| `F11` / `F` | Toggle fullscreen                   |
| `Escape`    | Exit fullscreen                     |
| `Q`         | Quit                                |
| `V`         | Show/hide the screensaver           |
| `+` / `-`   | Step through the screensavers       |

> **Note:** `D` and `S` are not currently wired to the keyboard handler — layout
> is switchable from the dropdown panel only. The rows are kept here because the
> shortcut is intended; tracked in #157.

`V` starts the screensaver immediately rather than waiting out the five-minute
no-signal delay, and `+` / `-` step through the set (wrapping at both ends).
Stepping restarts the rotation countdown, so a manual pick is not replaced
moments later by the automatic rotation.

Hover over the top edge to reveal the settings dropdown panel.

## Configuration

### Settings Panel

Click the ⚙ gear icon to open the settings panel:

- **Toggle inputs** on/off
- **Set default input** (shown at startup)
- **Rename inputs** for easy identification
- **Adjust center gap** between feeds
- **Adjust border width** on sides
- Changes are saved automatically

### settings.json

Settings are stored in the app's user data directory — the Settings panel shows
the exact path. Inputs are keyed by capture device id, since index order is not
stable across reboots:

```json
{
  "leftDeviceId": null,
  "rightDeviceId": null,
  "layoutMode": null,
  "centerGap": 60,
  "borderWidth": 0,
  "inputs": {
    "<capture-device-id>": { "name": "Laptop", "enabled": true }
  }
}
```

[`settings.example.json`](settings.example.json) in the repo root lists every
key with its default. It is documentation only; the app does not read it.

## Development

### Prerequisites

- Node.js 24+ (the active LTS, and what CI builds on; Electron and the test
  tooling both require newer than 20)
- npm

### Setup

```bash
cd input_viewer_electron
npm install
npm run dev     # Development mode with hot reload
npm run build   # Build for production
```

### Building Installers

```bash
npm run build:mac   # Build macOS DMG
npm run build:win   # Build Windows installer
```

## Hardware

Works with:

- **Any capture card** — USB or PCIe capture devices
- **Any display** — adapts to your screen resolution
- **Platforms**: macOS, Windows

**Optimised for ultrawide.** It runs on any resolution, but the defaults are
tuned for very wide displays: on a screen with an aspect ratio of 3:1 or wider
it starts in dual view (two feeds side by side), and on anything narrower it
starts in single view. The reference deployment is a 6000×1200 projector
videowall, which is also what the screensaver scaling in
`src/renderer/screensavers/gl-base.js` is calibrated against.

## Repository Layout

| Path | What it is |
|------|------------|
| [`input_viewer_electron/`](input_viewer_electron/) | The application. Everything that ships is here. |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | End-user guide: booth setup, shortcuts, troubleshooting. |
| [`remote_keyboard/`](remote_keyboard/) | Arduino sketch (ESP32-S3) for the optional Remote Keyboard feature. Receives HTTP requests from the app over WiFi and emits USB HID keypresses to a presenter PC. Flash it separately; the app works without it. The WiFi credentials and API key in the sketch are placeholders to fill in before flashing. |
| [`spikes/`](spikes/) | Standalone HTML design prototypes (no-signal screen, dropdown/settings, an OpenCV detection experiment). Not built, shipped, or maintained — kept as a visual reference for how those screens were designed. |
| [`settings.example.json`](settings.example.json) | Documented example of the settings file. Reference only; the app reads its own copy from the user data directory. |

## Legacy Python Version

The original Python implementation was removed in v2.6.0 (it carried a GPL dependency). It remains available in the [`v2.5.3` source tree](https://github.com/Lab271/labs-input-viewer/tree/v2.5.3/input_viewer_python) but is no longer maintained. Use the Electron version for the best experience.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately, not as a GitHub issue. See
[SECURITY.md](SECURITY.md).

## License

Copyright 2025-2026 Schuberg Philis B.V.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
these files except in compliance with the License. You may obtain a copy of the
License in [LICENSE](LICENSE) or at <https://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the specific
language governing permissions and limitations under the License.
