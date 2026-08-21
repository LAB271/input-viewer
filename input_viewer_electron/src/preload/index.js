// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Diagnostic log (temporary; see the no-signal detection investigation)
  diagLog: (lines) => ipcRenderer.invoke('diag-log', lines),
  diagLogReset: () => ipcRenderer.invoke('diag-log-reset'),

  // Settings persistence
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path'),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Test-mode launch flags (#248). Returns the argument strings that could be
  // test flags; the renderer parses them with test-flags.js.
  getTestFlagArgs: () => ipcRenderer.invoke('get-test-flag-args'),

  // GPU report. Called once at startup with what the renderer can see of its own
  // WebGL implementation; main combines it with the process-level GPU status and
  // writes a single overwritten file.
  writeGpuReport: (rendererInfo) => ipcRenderer.invoke('write-gpu-report', rendererInfo),

  // Frame-rate report. One overwritten file; the renderer sends a formatted body
  // rather than raw samples, so main stays a dumb writer.
  writeFpsReport: (body) => ipcRenderer.invoke('write-fps-report', body),

  // System volume control
  getSystemVolume: () => ipcRenderer.invoke('get-system-volume'),
  setSystemVolume: (volume) => ipcRenderer.invoke('set-system-volume', volume),

  // Art-Net reactive mode (#59). The POST goes through the main process, not the
  // renderer: the renderer's origin is `file://` in production, the relay has no
  // CORS middleware, and a cross-origin JSON POST therefore never gets past the
  // preflight. Main has no origin, so no preflight exists. It also keeps a
  // LAN-mutating capability out of the renderer.
  artnetSend: (request) => ipcRenderer.invoke('artnet-send', request),

  // Updater events
  onUpdaterProgress: (callback) => {
    ipcRenderer.on('updater-progress', (event, percent) => callback(percent))
  }
})
