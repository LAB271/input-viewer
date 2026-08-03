# Input Viewer

[![CI/CD](https://github.com/LAB271/labs-input-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/LAB271/labs-input-viewer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LAB271/labs-input-viewer)](https://github.com/LAB271/labs-input-viewer/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A lightweight video input viewer — **OBS without the complexity**. View and manage capture card feeds with a clean, simple interface designed for users who need to display video inputs without the overhead of full streaming software.

## Download

Download the latest release for your platform:

- **macOS**: [Input Viewer.dmg](https://github.com/LAB271/input-viewer-releases/releases/latest)
- **Windows**: [Input Viewer Setup.exe](https://github.com/LAB271/input-viewer-releases/releases/latest)

The app includes auto-updates and will notify you when new versions are available.

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
| `D`         | Dual view (both feeds)              |
| `S`         | Single view (selected feed centered)|
| `1-4`       | Select input directly               |
| `Space`     | Freeze/unfreeze current feed        |
| `F11` / `F` | Toggle fullscreen                   |
| `Escape`    | Exit fullscreen                     |
| `Q`         | Quit                                |

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

Settings are stored in the app's user data directory:

```json
{
  "inputs": [
    {"index": 0, "name": "Laptop", "enabled": true, "default": true},
    {"index": 1, "name": "Desktop", "enabled": true, "default": false},
    {"index": 2, "name": "Input 3", "enabled": false, "default": false},
    {"index": 3, "name": "Input 4", "enabled": false, "default": false}
  ],
  "centerGap": 100,
  "borderWidth": 50
}
```

## Development

### Prerequisites

- Node.js 20+
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
- **Any display** — Adapts to your screen resolution
- **Platforms**: macOS, Windows

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
