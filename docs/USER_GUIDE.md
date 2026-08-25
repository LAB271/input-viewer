# Input Viewer - User Guide

Input Viewer is a lightweight video input display application for viewing multiple video feeds simultaneously. Perfect for presenter booths and control rooms.

## Features

- **Dual/Single View** - Display one or two video inputs side by side
- **No-Signal Detection** - Automatically shows "NO SIGNAL" when input is disconnected
- **29 Screensavers** - GPU-rendered, shown when all inputs have no signal (5 min timeout)
- **Freeze Frame** - Pause the display without affecting the source
- **Audio Controls** - Control capture card volume and system output
- **Remote Keyboard** - Forward clicker presses to a presenter PC over network
- **Touch Support** - Tap-friendly dropdown menu

## Installation

Download the latest version from GitHub Releases:

- **macOS**: `Input-Viewer-X.X.X.dmg`
- **Windows**: `Input-Viewer-Setup-X.X.X.exe`

The app auto-updates when new versions are available.

## Presenter Booth Setup

1. **Connect your laptop** using the Thunderbolt (USB-C) cable in the presenter booth
   - The cable is marked with **"UP"** - this side should face up when plugging in
2. Wait about **10 seconds** for your screen to appear
3. This cable connects to a docking station, which is connected to the PC controlling the videowall
4. Your laptop screen will appear as an input in the Input Viewer app

## Basic Usage

### Selecting Inputs

1. Hover at the top of the screen to reveal the dropdown menu
2. Select which video input to show on each side (Dual view) or single input (Single view)

### View Modes

| Mode | Description |
|------|-------------|
| **Dual** | Two inputs side by side (for wide screens) |
| **Single** | One input fills the screen |

The app automatically selects the default mode based on your screen aspect ratio.

## Keyboard Shortcuts

Hover the **bottom** edge of the screen to bring up a legend of every shortcut, the same way
hovering the top edge brings up the input dropdown. The legend is generated from the app's own
bindings, so it always matches what the keys actually do.


| Key | Action |
|-----|--------|
| `1` - `4` | Select input 1-4 |
| `D` | Switch to Dual view |
| `S` | Switch to Single view |
| `Space` | Freeze/Unfreeze frame |
| `F` / `F11` | Toggle fullscreen |
| `Esc` | Exit fullscreen / Unfreeze / Close menus |
| `Q` | Quit application |
| `V` | Show or hide the screensaver immediately, without waiting out the 5-minute no-signal delay |
| `+` / `-` | Step forward or back through the screensavers while one is showing |
| `←` `→` `PgUp` `PgDn` | Remote keyboard (if enabled) |

## Settings

Open Settings via the dropdown menu (gear icon).

Each input in the dropdown shows a **snapshot** of what it is currently sending, taken
when the dropdown opens. These are stills, not live previews — they are as recent as the
moment you opened the panel. An input that is not currently on screen is sampled briefly to
take its picture; one that cannot be reached, or that has nothing plugged into it, keeps an
empty tile.

### Inputs

- **Enable/Disable** inputs using the toggle
- **Rename** inputs for easier identification
- **Set Default** input to load at startup

### Layout

- **Center Gap** - Space between dual view panels
- **Side Borders** - Black borders on the left/right edges

### No-Signal Detection

Capture what your capture card shows when nothing is connected. This allows the app to detect "no signal" and show the overlay.

1. Disconnect the input from your capture card
2. Click "Capture Left" or "Capture Right"
3. The app will remember this pattern

## Volume Controls

In the dropdown menu:

- **Input sliders** - Control audio from each capture card
- **Output slider** - Control system volume

The output slider syncs with your system volume every 2 seconds.

## Remote Keyboard

Control presentations on a remote PC using a wireless clicker.

### How It Works

```text
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Clicker   │────>│Input Viewer │────>│   Arduino   │────>│ Presenter   │
│  (RF/BT)    │     │     App     │     │  (ESP32-S3) │     │     PC      │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                         WiFi              USB HID
```

1. Press a button on your wireless clicker
2. Input Viewer receives the keypress
3. Input Viewer sends HTTP request to Arduino over WiFi
4. Arduino sends keypress to presenter PC via USB

### Setup

**In Input Viewer:**

1. Open **Settings** > **Remote Keyboard**
2. Enable the toggle
3. Enter **Hostname**: `space_keyboard` (or the Arduino's IP)
4. Enter **API Key**: the secret key configured on the Arduino

**Arduino side:**

The Arduino (ESP32-S3) must be:

- Connected to the same WiFi network
- Connected to the presenter PC via USB
- Configured with matching API key

### Supported Clickers

The app listens for multiple key types to support different clickers:

- Arrow keys (← →)
- Page Up / Page Down

## Touch Screen Support

For touch screen setups:

- **Tap** the dropdown trigger area to open/close the menu
- **Tap outside** the menu to close it

## Screensavers

When all video feeds show "no signal" for 5 minutes, a screensaver appears. There are
**29**, one picked at random, and it changes every 10 minutes. The rotation never picks
the same one twice in a row.

Each screensaver also looks different every time it starts — the random choices inside
it are seeded from the clock — so the same one twice is not the same picture twice.

To exit the screensaver:

- Move the mouse
- Shake the mouse rapidly
- Press any key
- Touch the screen

You can also drive it by hand: **`V`** shows or hides it immediately rather than waiting
out the five-minute delay, and **`+`** / **`-`** step through the set in the order below.

### The split-flap board is not one of them

When a feed loses signal you first see a **split-flap departures board**. That is the
no-signal display, not a screensaver: it appears straight away rather than after five
minutes, it never comes up in the rotation, and `+` / `-` cannot reach it.

### The screensavers

Listed in rotation order, which is the order `+` and `-` step through.

<!-- SCREENSAVER-LIST -->
1. DVD Logo
2. Plasma
3. Flow Field
4. Raymarch Fractal
5. Julia Family
6. Burning Ship
7. Reaction Diffusion
8. Particle Swarm
9. White Particles
10. Boids
11. Strange Attractor
12. Voronoi
13. Metaballs
14. Game of Life
15. Matrix Rain
16. Starfield Warp
17. Pong
18. Truchet Tiles
19. Moire Interference
20. ASCII Doughnut
21. Double Pendulum
22. Wave Tank
23. Falling Sand
24. Frost
25. Tree Growth
26. Physarum
27. Aquarium
28. Bicycle Horizon
29. Weather<!-- /SCREENSAVER-LIST -->

### Weather and Art-Net

Two of these reach outside the machine, and **both are off until you turn them on**:

- **Weather** (number 30) draws the live conditions for a
  configured latitude and longitude. With it off, it is skipped in the rotation. It
  fetches from a public weather service every 15 minutes while enabled.
- **Art-Net reactive mode** is not a screensaver but affects them all: it sends the
  colour of whatever is on screen to a lighting service, so the room matches the wall.

Neither makes any network request until enabled and configured. See the Configuration
section of `README.md` for the settings and exactly what each one sends.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No video showing | Check capture card connection and permissions |
| "NO SIGNAL" not detecting | Re-capture the no-signal reference in Settings |
| Remote keyboard not working | Check WiFi connection and API key |
| Audio not working | Ensure capture card provides audio (not all do) |
| Touch not opening menu | Tap near the top center of the screen |

## System Requirements

- **macOS** 10.13+ or **Windows** 10+
- USB capture card (HDMI/SDI to USB)
- For remote keyboard: ESP32-S3 Arduino + WiFi network
