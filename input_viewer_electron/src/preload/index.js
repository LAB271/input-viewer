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

  // System volume control
  getSystemVolume: () => ipcRenderer.invoke('get-system-volume'),
  setSystemVolume: (volume) => ipcRenderer.invoke('set-system-volume', volume),

  // Updater events
  onUpdaterProgress: (callback) => {
    ipcRenderer.on('updater-progress', (event, percent) => callback(percent))
  }
})
