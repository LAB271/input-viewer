// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Input Viewer - Renderer Process
 * 
 * Handles video capture, UI interactions, and keyboard shortcuts
 */

import {
  checkNoSignalFromSource,
  isReady as isDetectionReady,
  getReferenceScreenshots,
  findOrphanedReferences,
  pruneOrphanedReferences,
  removeReferenceScreenshot,
  referenceAtSize,
  matchRatio,
  setDiagnosticSink,
  probeFrames,
  CONFIG,
  setDebugLogging,
  saveReferenceScreenshot,
  captureScreenshot,
  serializeReferences,
  deserializeReferences
} from './detection-simple.js'

import {
  createFrameSource,
  supportsWebCodecsFrames
} from './frame-source.js'

import {
  createGpuCompositor,
  supportsGpuCompositing
} from './gpu-compositor.js'

import {
  initScreensavers,
  startScreensaver,
  stopScreensaver,
  isScreensaverRunning,
  getActiveIndex,
  screensaverCount
} from './screensavers/registry.js'
import { installWeatherSource } from './screensavers/weather-source.js'
import { installArtnetSync, getArtnetSync } from './screensavers/artnet-sync.js'
import { observeFrames } from './screensavers/gl-base.js'

// Imported directly rather than through the registry: the split-flap board is
// the no-signal display, not one of the rotating screensavers (#92).
import splitFlap from './screensavers/split-flap.js'

// The shortcut list (#258): keys, labels and the key->shortcut lookup. Actions
// live in SHORTCUT_ACTIONS below; this module deliberately holds no behaviour.
import {
  SHORTCUTS,
  SHORTCUTS_BY_KEY,
  inputKeyFor
} from './shortcuts.js'

// Test-mode launch flags (#248).
import {
  parseTestFlags,
  anyTestFlagSet,
  describeTestFlags,
  DEFAULT_TEST_FLAGS
} from './test-flags.js'
import {
  mockDeviceList,
  createMockStream,
  isMockDeviceId
} from './mock-capture.js'

// =============================================================================
// State Management
// =============================================================================

const state = {
  devices: [],
  leftDeviceId: null,
  rightDeviceId: null,
  leftStream: null,
  rightStream: null,
  layoutMode: 'dual', // 'dual', 'single'
  cursorTimeout: null,
  cursorHideDelay: 3000,
  centerGap: 60,
  borderWidth: 0,
  frozen: false,
  settings: null, // Will be loaded from file
  defaultInputId: null, // Which input loads at startup
  // No-signal detection state
  detectionCanvas: null,
  detectionRunning: false,
  detectionFrameCount: 0, // Frame counter for detection sampling
  noSignalState: {
    left: false,
    right: false
  },
  // Test-mode launch flags (#248). Defaults are the production values, so every
  // path below behaves exactly as it did before these flags existed unless one
  // is actually passed.
  testFlags: { ...DEFAULT_TEST_FLAGS },
  // Live mock streams, so they can be stopped on input switch. Keyed by side.
  mockStreams: { left: null, right: null },
  // DVD screensaver timer
  dvdScreensaverTimeout: null,
  // dvdScreensaverDelay: 10 * 1000, // 10 seconds in milliseconds
  dvdScreensaverDelay: 5 * 60 * 1000, // 5 minutes in milliseconds
  // Rotation between screensavers while no-signal persists. 10 minutes is long
  // enough that each saver's slow evolution (zoom tours, parameter drift) plays
  // out, and short enough that a passer-by rarely sees the same one twice.
  screensaverRotateInterval: null,
  screensaverRotateDelay: 10 * 60 * 1000, // 10 minutes in milliseconds
  // Shake detection state
  shakeHistory: [],           // Array of {timestamp, direction}
  shakeWindowMs: 500,         // Time window to detect shakes (500ms)
  shakeThreshold: 4,          // Number of direction changes needed
  lastMouseX: null,
  lastMouseY: null,
  lastMoveDirection: null,    // 'left' or 'right'
  // Dropdown state for touch support
  dropdownOpen: false,
  // Audio state
  audioContext: null,
  leftAudioGain: null,        // GainNode for left feed
  rightAudioGain: null,       // GainNode for right feed
  leftAudioSource: null,      // MediaStreamAudioSourceNode
  rightAudioSource: null,
  leftVolume: 1.0,            // 0.0 to 1.0
  rightVolume: 1.0,
  systemVolume: 50,           // 0 to 100
  // Remote keyboard state
  remoteKeyboardEnabled: false,
  remoteKeyboardHost: '',
  remoteKeyboardApiKey: '',
  // Presenter tool debug overlay
  presenterDebugEnabled: false,
  // Experimental WebGPU compositing (issue #62). Off by default: the CSS
  // path is what ships, and this takes over drawing the live video.
  gpuCompositing: false,
  gpuCompositor: null
}

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  leftFeed: document.getElementById('left-feed'),
  rightFeed: document.getElementById('right-feed'),
  leftVideo: document.getElementById('left-video'),
  rightVideo: document.getElementById('right-video'),
  videoWrapper: document.getElementById('video-wrapper'),
  centerDivider: document.getElementById('center-divider'),
  bottomLogo: document.getElementById('bottom-logo'),
  leftBorder: document.getElementById('left-border'),
  rightBorder: document.getElementById('right-border'),
  inputNameOverlay: document.getElementById('input-name-overlay'),
  inputNameText: document.getElementById('input-name-text'),
  freezeOverlay: document.getElementById('freeze-overlay'),
  freezeIndicator: document.getElementById('freeze-indicator'),
  freezeCanvas: document.getElementById('freeze-canvas'),
  dropdownTrigger: document.getElementById('dropdown-trigger'),
  dropdownPanel: document.getElementById('dropdown-panel'),
  updateNotification: document.getElementById('update-notification'),
  updateMessage: document.getElementById('update-message'),
  // New dropdown elements
  shortcutsTable: document.getElementById('shortcuts-table'),
  viewModeDual: document.getElementById('view-mode-dual'),
  viewModeSingle: document.getElementById('view-mode-single'),
  dualColumns: document.getElementById('dual-columns'),
  leftInputList: document.getElementById('left-input-list'),
  rightInputList: document.getElementById('right-input-list'),
  singleInputList: document.getElementById('single-input-list'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  // New settings modal elements
  settingsModal: document.getElementById('settings-modal'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  settingsInputList: document.getElementById('settings-input-list'),
  settingsCenterGap: document.getElementById('settings-center-gap'),
  settingsCenterGapValue: document.getElementById('settings-center-gap-value'),
  settingsBorderWidth: document.getElementById('settings-border-width'),
  settingsBorderWidthValue: document.getElementById('settings-border-width-value'),
  captureLeftBtn: document.getElementById('capture-left-btn'),
  captureRightBtn: document.getElementById('capture-right-btn'),
  settingsAppVersion: document.getElementById('settings-app-version'),
  // Dropdown volume control elements
  dropdownInputVolumes: document.getElementById('dropdown-input-volumes'),
  dropdownSystemVolume: document.getElementById('dropdown-system-volume'),
  dropdownSystemVolumeValue: document.getElementById('dropdown-system-volume-value'),
  // Cached label references (avoids DOM queries in hot paths)
  leftLabel: document.querySelector('#left-feed .input-label'),
  rightLabel: document.querySelector('#right-feed .input-label'),
  // DVD screensaver overlay
  dvdOverlay: document.getElementById('dvd-overlay'),
  screensaverCanvas: document.getElementById('screensaver-canvas'),
  // Experimental WebGPU compositing target (issue #62)
  gpuCanvas: document.getElementById('gpu-canvas'),
  // Remote keyboard settings elements
  remoteKeyboardToggle: document.getElementById('remote-keyboard-toggle'),
  remoteKeyboardFields: document.getElementById('remote-keyboard-fields'),
  remoteKeyboardHost: document.getElementById('remote-keyboard-host'),
  remoteKeyboardApiKey: document.getElementById('remote-keyboard-api-key'),
  // Presenter tool debug overlay
  presenterDebugToggle: document.getElementById('presenter-debug-toggle'),
  presenterDebugOverlay: document.getElementById('presenter-debug-overlay'),
  presenterDebugLog: document.getElementById('presenter-debug-log')
}

// =============================================================================
// Settings Persistence
// =============================================================================

async function loadSettings() {
  try {
    if (window.electronAPI) {
      const settings = await window.electronAPI.loadSettings()
      return settings
    }
  } catch (e) {
    console.error('Error loading settings:', e)
  }
  return getDefaultSettings()
}

async function saveSettings() {
  // Mock mode never writes settings (#248).
  //
  // Not a convenience -- a correctness guard. getVideoDevices() creates an
  // `inputs` entry per discovered device and saveSettings() persists
  // leftDeviceId/rightDeviceId/defaultInputId, so a single mock run would write
  // `mock-input-1`..`mock-input-4` into the real settings.json and could leave
  // the default input pointing at a device that will never exist again. The
  // next production launch would then start on a dead input. Test mode must not
  // be able to damage the wall's configuration.
  if (state.testFlags.mock) return

  try {
    if (window.electronAPI) {
      const settingsToSave = {
        leftDeviceId: state.leftDeviceId,
        rightDeviceId: state.rightDeviceId,
        layoutMode: state.layoutMode,
        centerGap: state.centerGap,
        borderWidth: state.borderWidth,
        defaultInputId: state.defaultInputId,
        leftVolume: state.leftVolume,
        rightVolume: state.rightVolume,
        systemVolume: state.systemVolume,
        remoteKeyboardEnabled: state.remoteKeyboardEnabled,
        remoteKeyboardHost: state.remoteKeyboardHost,
        remoteKeyboardApiKey: state.remoteKeyboardApiKey,
        presenterDebugEnabled: state.presenterDebugEnabled,
        gpuCompositing: state.gpuCompositing,
        inputs: state.settings.inputs,
        initialSetupComplete: state.settings.initialSetupComplete,
        noSignalReferences: state.settings.noSignalReferences,
        // Read from state.settings rather than state, like inputs above: these
        // have no mirrored state.* field. They must be listed here explicitly --
        // this object is an allowlist, so a key omitted from it is silently
        // reset to its default on the next load.
        weatherEnabled: state.settings.weatherEnabled,
        weatherLatitude: state.settings.weatherLatitude,
        weatherLongitude: state.settings.weatherLongitude,
        artnetEnabled: state.settings.artnetEnabled,
        artnetUrl: state.settings.artnetUrl,
        artnetTarget: state.settings.artnetTarget,
        artnetReleaseScene: state.settings.artnetReleaseScene,
        artnetMaxBrightness: state.settings.artnetMaxBrightness
      }
      await window.electronAPI.saveSettings(settingsToSave)
    }
  } catch (e) {
    console.error('Error saving settings:', e)
  }
}

// Debounced save to reduce IPC calls during rapid changes (e.g., slider drags)
let saveSettingsTimeout = null
function debouncedSaveSettings() {
  clearTimeout(saveSettingsTimeout)
  saveSettingsTimeout = setTimeout(saveSettings, 300)
}

function getDefaultSettings() {
  return {
    inputs: {},
    centerGap: 60,
    borderWidth: 0,
    leftDeviceId: null,
    rightDeviceId: null,
    defaultInputId: null,
    leftVolume: 1.0,
    rightVolume: 1.0,
    systemVolume: 50,
    layoutMode: null, // null means use screen-based detection
    initialSetupComplete: false,
    noSignalReferences: null,
    remoteKeyboardEnabled: false,
    remoteKeyboardHost: '',
    remoteKeyboardApiKey: '',
    presenterDebugEnabled: false,
    // Experimental; see initGpuCompositing and issue #62.
    gpuCompositing: false,
    // Weather screensaver (#101). Off by default: the only feature here that
    // reaches a third party. Mirrors defaultSettings in src/main/index.js.
    weatherEnabled: false,
    weatherLatitude: 52.37,
    weatherLongitude: 4.89,
    // Art-Net reactive mode (#59). Off, and with no URL, by default.
    artnetEnabled: false,
    artnetUrl: '',
    artnetTarget: 'all',
    artnetReleaseScene: '',
    artnetMaxBrightness: 0.8
  }
}

// Get custom name for input
function getInputName(deviceId, defaultName) {
  const inputSettings = state.settings.inputs[deviceId]
  if (inputSettings && inputSettings.name) {
    return inputSettings.name
  }
  return defaultName
}

// Check if input is enabled
function isInputEnabled(deviceId) {
  const inputSettings = state.settings.inputs[deviceId]
  if (inputSettings && typeof inputSettings.enabled === 'boolean') {
    return inputSettings.enabled
  }
  return true // Default to enabled
}

// Set custom name for input
function setInputName(deviceId, name) {
  if (!state.settings.inputs[deviceId]) {
    state.settings.inputs[deviceId] = { enabled: true }
  }
  state.settings.inputs[deviceId].name = name
  saveSettings()
}

// Toggle input enabled/disabled
function toggleInputEnabled(deviceId) {
  if (!state.settings.inputs[deviceId]) {
    state.settings.inputs[deviceId] = { enabled: true, name: null }
  }
  state.settings.inputs[deviceId].enabled = !state.settings.inputs[deviceId].enabled
  saveSettings()
  renderDropdownInputLists()
  renderSettingsInputList()
}

// =============================================================================
// Freeze Frame
// =============================================================================

function toggleFreeze() {
  state.frozen = !state.frozen
  
  if (state.frozen) {
    // Capture current frame to canvas
    captureFrame()
    elements.freezeOverlay.classList.remove('hidden')
    elements.freezeIndicator.classList.remove('hidden')
    elements.freezeIndicator.innerHTML = '<span class="freeze-icon">❙❙</span> FROZEN'
    elements.freezeIndicator.classList.add('frozen')
    
    // Hide video feeds
    elements.leftVideo.style.opacity = '0'
    elements.rightVideo.style.opacity = '0'
  } else {
    // Show video feeds
    elements.freezeOverlay.classList.add('hidden')
    elements.freezeIndicator.classList.add('hidden')
    elements.leftVideo.style.opacity = '1'
    elements.rightVideo.style.opacity = '1'
    
    // Show brief LIVE indicator
    elements.freezeIndicator.classList.remove('hidden')
    elements.freezeIndicator.innerHTML = '<span class="freeze-icon">▶</span> LIVE'
    elements.freezeIndicator.classList.remove('frozen')
    setTimeout(() => {
      elements.freezeIndicator.classList.add('hidden')
    }, 1000)
  }
}

function captureFrame() {
  const canvas = elements.freezeCanvas
  const ctx = canvas.getContext('2d')
  
  // Get the video wrapper dimensions
  const wrapper = elements.videoWrapper
  canvas.width = wrapper.clientWidth
  canvas.height = wrapper.clientHeight
  
  // Clear canvas
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  
  // Draw based on layout mode
  if (state.layoutMode === 'dual') {
    // Draw both videos side by side
    const gap = state.layoutGap
    const halfWidth = (canvas.width - gap) / 2
    
    // Draw left video
    if (elements.leftVideo.srcObject) {
      ctx.drawImage(elements.leftVideo, 0, 0, halfWidth, canvas.height)
    }
    
    // Draw right video
    if (elements.rightVideo.srcObject) {
      ctx.drawImage(elements.rightVideo, halfWidth + gap, 0, halfWidth, canvas.height)
    }
  } else {
    // Single view - draw the active video
    const video = state.layoutMode === 'right' ? elements.rightVideo : elements.leftVideo
    if (video.srcObject) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    }
  }
}

// =============================================================================
// Test-mode launch flags (#248)
// =============================================================================

/**
 * Read and apply the launch flags.
 *
 * Called first in init(), before anything reads state.testFlags. Failure is
 * non-fatal and leaves the production defaults: a broken flag must not stop the
 * wall from coming up.
 */
async function loadTestFlags() {
  let args = []
  try {
    if (window.electronAPI?.getTestFlagArgs) {
      args = await window.electronAPI.getTestFlagArgs()
    }
  } catch (e) {
    console.error('[TestFlags] Could not read launch arguments:', e)
    return
  }

  const { flags, errors } = parseTestFlags(args)
  state.testFlags = flags

  // Logged at error level on purpose. A mistyped flag means the operator is
  // looking at a wall that is not in the mode they asked for, and a warning in
  // a console nobody has open is how that goes unnoticed.
  for (const message of errors) {
    console.error(`[TestFlags] ${message}`)
  }

  if (anyTestFlagSet(flags)) {
    console.log(`[TestFlags] TEST MODE -- ${describeTestFlags(flags)}`)
  }

  if (flags.screensaverDelayMs !== null) {
    state.dvdScreensaverDelay = flags.screensaverDelayMs
  }
}

// =============================================================================
// Video Device Management
// =============================================================================

async function getVideoDevices() {
  // Mock inputs (#248): skip hardware entirely. getUserMedia is not called at
  // all, so this works with no capture device present and never triggers a
  // camera permission prompt.
  if (state.testFlags.mock) {
    state.devices = mockDeviceList(state.testFlags.mockInputs)
    console.log(`[TestFlags] ${state.devices.length} mock input(s):`,
      state.devices.map(d => d.label).join(', '))

    // Mock devices get in-memory settings entries so the dropdown, naming and
    // enable/disable all work on them. saveSettings() is a no-op in mock mode,
    // so none of this reaches disk.
    for (const device of state.devices) {
      if (!state.settings.inputs[device.deviceId]) {
        state.settings.inputs[device.deviceId] = { name: null, enabled: true }
      }
    }

    // Assign sides from the mock list rather than from saved settings: a saved
    // real deviceId cannot match a mock one, and falling through to the normal
    // restore path would leave both sides null and show nothing at all.
    state.leftDeviceId = state.devices[0].deviceId
    state.rightDeviceId = state.devices[1]?.deviceId ?? state.devices[0].deviceId

    renderDropdownInputLists()
    return state.devices
  }

  try {
    // Request permission first, then immediately release the stream
    const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true })
    permissionStream.getTracks().forEach(track => track.stop())

    const devices = await navigator.mediaDevices.enumerateDevices()
    state.devices = devices.filter(device => device.kind === 'videoinput')
    
    console.log('Available video devices:', state.devices)
    
    // Initialize settings for new devices
    state.devices.forEach((device) => {
      if (!state.settings.inputs[device.deviceId]) {
        state.settings.inputs[device.deviceId] = {
          name: null, // Will use default label
          enabled: true
        }
      }
    })
    
    // Save settings with new devices
    saveSettings()
    
    // Set default devices from settings or auto-assign
    if (state.devices.length > 0) {
      // Try to restore from settings
      const savedLeft = state.devices.find(d => d.deviceId === state.settings.leftDeviceId)
      const savedRight = state.devices.find(d => d.deviceId === state.settings.rightDeviceId)
      
      // Auto-assign devices if not saved
      if (savedLeft) {
        state.leftDeviceId = savedLeft.deviceId
      } else {
        // Use first enabled device
        const firstEnabled = state.devices.find(d => isInputEnabled(d.deviceId))
        state.leftDeviceId = firstEnabled ? firstEnabled.deviceId : state.devices[0].deviceId
      }
      
      if (savedRight) {
        state.rightDeviceId = savedRight.deviceId
      } else {
        // For dual mode: use second device if available, otherwise duplicate first
        if (state.devices.length > 1) {
          const secondEnabled = state.devices.slice(1).find(d => isInputEnabled(d.deviceId))
          state.rightDeviceId = secondEnabled ? secondEnabled.deviceId : state.devices[1].deviceId
        } else {
          // Only one device: duplicate it for dual mode
          state.rightDeviceId = state.leftDeviceId
        }
      }
    }
    
    renderDropdownInputLists()
    return state.devices
  } catch (error) {
    console.error('Error getting video devices:', error)
    showNoSignal('left')
    showNoSignal('right')
    return []
  }
}

async function startVideoStream(deviceId, videoElement, side) {
  try {
    // Stop existing stream
    if (side === 'left' && state.leftStream) {
      state.leftStream.getTracks().forEach(track => track.stop())
    }
    if (side === 'right' && state.rightStream) {
      state.rightStream.getTracks().forEach(track => track.stop())
    }
    // A mock stream owns a requestAnimationFrame loop as well as its tracks
    // (#248); stopping only the tracks would leave the loop drawing forever.
    if (state.mockStreams[side]) {
      state.mockStreams[side].stop()
      state.mockStreams[side] = null
    }
    
    if (!deviceId) {
      showNoSignal(side)
      return null
    }
    
    // Check if device is enabled
    if (!isInputEnabled(deviceId)) {
      showNoSignal(side)
      return null
    }

    // Mock inputs (#248). Placed after the guards above so a disabled mock input
    // behaves like a disabled real one, and before getUserMedia so no hardware
    // is touched.
    //
    // Under --no-signal the mock draws its dead-input card rather than the live
    // pattern. The overlay covers it either way, but the two differ the moment
    // someone hides the overlay to look underneath, and a colourful test pattern
    // behind a NO SIGNAL board would be actively misleading.
    if (isMockDeviceId(deviceId)) {
      const device = state.devices.find(d => d.deviceId === deviceId)
      const mock = createMockStream({
        label: getInputName(deviceId, device?.label || 'Mock Input'),
        still: state.testFlags.noSignal,
      })
      state.mockStreams[side] = mock
      videoElement.srcObject = mock.stream
      if (side === 'left') {
        state.leftStream = mock.stream
      } else {
        state.rightStream = mock.stream
      }

      // hideNoSignal is a no-op while --no-signal is set, so this is safe to
      // call unconditionally: it clears the overlay in plain mock mode and
      // leaves it up in forced mode.
      hideNoSignal(side)

      const label = side === 'left' ? elements.leftLabel : elements.rightLabel
      if (label && device) {
        label.textContent = getInputName(deviceId, device.label || 'Mock Input')
      }
      return mock.stream
    }
    
    // Pair audio by groupId, not by reusing the video deviceId (#151).
    //
    // A videoinput id is never a valid audioinput id, so `audio: {deviceId:
    // {exact: videoDeviceId}}` rejected with OverconstrainedError for every
    // device without a coincidentally-matching audio id -- virtual cameras,
    // most webcams, many capture cards. Every one of those paid two
    // getUserMedia calls on each input switch and logged a misleading "audio
    // not available", which carried no information because it fired constantly.
    //
    // enumerateDevices reports groupId for exactly this: devices belonging to
    // the same physical unit share one.
    const videoDevice = state.devices.find((d) => d.deviceId === deviceId)
    let audioDevice = null
    if (videoDevice?.groupId) {
      const all = await navigator.mediaDevices.enumerateDevices()
      audioDevice = all.find(
        (d) => d.kind === 'audioinput' && d.groupId === videoDevice.groupId) || null
    }

    const videoConstraints = {
      deviceId: { exact: deviceId },
      width: { ideal: 4096 },
      height: { ideal: 2160 },
      frameRate: { ideal: 60 }
    }
    const constraints = {
      video: videoConstraints,
      // Only ask for audio when a matching device actually exists, so the
      // common path is a single call.
      ...(audioDevice ? { audio: { deviceId: { exact: audioDevice.deviceId } } } : {})
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch {
      // Audio was expected but could not be opened -- the device may have been
      // claimed by another application. Video alone is still worth having.
      console.log(`[Video] Audio unavailable for ${side}, falling back to video only`)
      const videoOnlyConstraints = {
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 4096 },
          height: { ideal: 2160 },
          frameRate: { ideal: 60 }
        }
      }
      stream = await navigator.mediaDevices.getUserMedia(videoOnlyConstraints)
    }
    videoElement.srcObject = stream

    // Log stream info for diagnostics
    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings()
    // getCapabilities is optional in the spec and genuinely absent on some
    // platforms and virtual devices, so it cannot be called unguarded -- doing
    // so threw "track.getCapabilities is not a function" and aborted the whole
    // stream setup, which surfaced as the feed simply not starting.
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    console.log(`[Video] ${side} stream: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`)
    console.log(`[Video] ${side} capabilities: ${caps.width?.max ?? 'unknown'}x` +
      `${caps.height?.max ?? 'unknown'} @ ${caps.frameRate?.max ?? 'unknown'}fps`)

    // Some capture cards start at low default resolution and need a retry.
    // Cap target at 1920x1080 to prefer uncompressed formats over MJPEG.
    //
    // Absent capabilities mean "unknown", not "no better mode exists" (#152).
    // Gating on caps.width?.max > 640 skipped the retry entirely for any device
    // reporting nothing -- virtual cameras commonly do -- leaving the feed
    // stuck at whatever low resolution it happened to open with. The retry has
    // its own try/catch and re-acquires at default resolution on failure, so
    // attempting it speculatively is safe.
    const maxCapW = caps.width?.max ?? 1920
    const maxCapH = caps.height?.max ?? 1080
    if (settings.width <= 640 && maxCapW > 640) {
      const targetWidth = Math.min(maxCapW, 1920)
      const targetHeight = Math.min(maxCapH, 1080)
      console.log(`[Video] ${side} resolution too low, retrying for ${targetWidth}x${targetHeight}...`)

      const hasAudio = stream.getAudioTracks().length > 0
      stream.getTracks().forEach(t => t.stop())
      await new Promise(resolve => setTimeout(resolve, 300))

      const retryConstraints = {
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: targetWidth },
          height: { ideal: targetHeight },
          frameRate: { ideal: 60 }
        }
      }
      if (hasAudio) {
        retryConstraints.audio = { deviceId: { exact: deviceId } }
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia(retryConstraints)
        videoElement.srcObject = stream
        const retrySettings = stream.getVideoTracks()[0].getSettings()
        console.log(`[Video] ${side} retry: ${retrySettings.width}x${retrySettings.height} @ ${retrySettings.frameRate}fps`)
      } catch (e) {
        console.warn(`[Video] ${side} retry failed: ${e.message}`)
        // Re-acquire at default resolution
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } }
        })
        videoElement.srcObject = stream
      }
    }

    // Store stream reference
    if (side === 'left') {
      state.leftStream = stream
    } else {
      state.rightStream = stream
    }

    // Set up audio processing if stream has audio tracks
    if (stream.getAudioTracks().length > 0) {
      setupAudioForStream(stream, side)
    }

    hideNoSignal(side)

    // Update input label using cached reference
    const device = state.devices.find(d => d.deviceId === deviceId)
    const label = side === 'left' ? elements.leftLabel : elements.rightLabel
    if (label && device) {
      const name = getInputName(deviceId, device.label || 'Unknown Input')
      label.textContent = name
    }

    return stream
  } catch (error) {
    console.error(`Error starting ${side} stream:`, error)
    showNoSignal(side)
    return null
  }
}

// =============================================================================
// Audio Management
// =============================================================================

/**
 * Set up Web Audio API for a media stream
 */
function setupAudioForStream(stream, side) {
  // Initialize AudioContext if needed (must be done after user interaction)
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)()
  }

  // Resume audio context if suspended (browsers require user interaction)
  if (state.audioContext.state === 'suspended') {
    state.audioContext.resume()
  }

  // Disconnect previous source if exists
  if (side === 'left' && state.leftAudioSource) {
    try {
      state.leftAudioSource.disconnect()
    } catch {
      // Ignore disconnect errors
    }
  } else if (side === 'right' && state.rightAudioSource) {
    try {
      state.rightAudioSource.disconnect()
    } catch {
      // Ignore disconnect errors
    }
  }

  // Create audio source from stream
  const source = state.audioContext.createMediaStreamSource(stream)

  // Create gain node for volume control
  const gainNode = state.audioContext.createGain()
  const volume = side === 'left' ? state.leftVolume : state.rightVolume
  gainNode.gain.value = volume

  // Connect: source -> gain -> destination (speakers)
  source.connect(gainNode)
  gainNode.connect(state.audioContext.destination)

  // Store references
  if (side === 'left') {
    state.leftAudioSource = source
    state.leftAudioGain = gainNode
  } else {
    state.rightAudioSource = source
    state.rightAudioGain = gainNode
  }

  console.log(`[Audio] Set up audio for ${side} feed, volume: ${Math.round(volume * 100)}%`)
}

/**
 * Set left feed volume (0.0 to 1.0)
 */
function setLeftVolume(volume) {
  state.leftVolume = Math.max(0, Math.min(1, volume))
  if (state.leftAudioGain) {
    state.leftAudioGain.gain.value = state.leftVolume
  }
  state.settings.leftVolume = state.leftVolume
  debouncedSaveSettings()
}

/**
 * Set right feed volume (0.0 to 1.0)
 */
function setRightVolume(volume) {
  state.rightVolume = Math.max(0, Math.min(1, volume))
  if (state.rightAudioGain) {
    state.rightAudioGain.gain.value = state.rightVolume
  }
  state.settings.rightVolume = state.rightVolume
  debouncedSaveSettings()
}

/**
 * Set system volume (0 to 100) via IPC
 */
async function setSystemVolume(volume) {
  state.systemVolume = Math.max(0, Math.min(100, Math.round(volume)))
  state.settings.systemVolume = state.systemVolume
  debouncedSaveSettings()

  if (window.electronAPI && window.electronAPI.setSystemVolume) {
    try {
      await window.electronAPI.setSystemVolume(state.systemVolume)
    } catch (e) {
      console.error('[Audio] Error setting system volume:', e)
    }
  }
}

/**
 * Get current system volume via IPC
 */
async function getSystemVolume() {
  if (window.electronAPI && window.electronAPI.getSystemVolume) {
    try {
      const volume = await window.electronAPI.getSystemVolume()
      state.systemVolume = volume
      return volume
    } catch (e) {
      console.error('[Audio] Error getting system volume:', e)
    }
  }
  return state.systemVolume
}

/**
 * Sync system volume from OS to UI (for when user changes volume externally)
 */
async function syncSystemVolume() {
  const volume = await getSystemVolume()
  // Update UI if it differs from current slider value
  if (elements.dropdownSystemVolume && parseInt(elements.dropdownSystemVolume.value) !== volume) {
    elements.dropdownSystemVolume.value = volume
    elements.dropdownSystemVolumeValue.textContent = `${volume}%`
  }
}

// Live split-flap board per side, one per no-signal overlay (#92).
//
// This is the *no-signal display*, not a screensaver: it appears the moment
// signal drops, whereas the screensaver rotation only starts after
// state.dvdScreensaverDelay. The board carries information (NO SIGNAL /
// AWAITING INPUT / STANDBY), which is the point -- an abstract animation the
// instant a feed dies reads as a crash, a departures board reads as deliberate.
const noSignalBoards = { left: null, right: null }

function startNoSignalBoard(side, overlay) {
  if (noSignalBoards[side]) return
  const canvas = overlay.querySelector('.no-signal-board')
  if (!canvas) return
  // Size the backing store to the element, or the board lays out against a
  // 300x150 default and the tile grid is wrong.
  const rect = canvas.getBoundingClientRect()
  canvas.width = Math.max(1, Math.round(rect.width))
  canvas.height = Math.max(1, Math.round(rect.height))
  try {
    const board = splitFlap.create(canvas)
    board.start()
    noSignalBoards[side] = board
    // Hide the HTML fallback only once the board is actually running.
    overlay.classList.add('board-active')
  } catch (err) {
    // Leaves the HTML "NO SIGNAL" text visible, which is the whole point of
    // keeping it in the markup.
    console.error('[NoSignal] Split-flap board unavailable:', err)
  }
}

function stopNoSignalBoard(side, overlay) {
  if (!noSignalBoards[side]) return
  try { noSignalBoards[side].stop() } catch { /* already torn down */ }
  noSignalBoards[side] = null
  overlay.classList.remove('board-active')
}

function showNoSignal(side) {
  const feed = side === 'left' ? elements.leftFeed : elements.rightFeed
  const overlay = feed.querySelector('.no-signal-overlay')
  overlay.classList.remove('hidden')
  state.noSignalState[side] = true
  startNoSignalBoard(side, overlay)
}

function hideNoSignal(side) {
  // --no-signal (#248) pins the state on. This is the single seam that enforces
  // it: every path that would clear the overlay -- a stream starting, detection
  // reporting signal restored, an input switch -- goes through here, so one
  // guard covers all of them. Guarding the call sites individually is how one
  // gets missed and the forced state silently un-forces itself.
  if (state.testFlags.noSignal) return

  const feed = side === 'left' ? elements.leftFeed : elements.rightFeed
  const overlay = feed.querySelector('.no-signal-overlay')
  overlay.classList.add('hidden')
  state.noSignalState[side] = false
  // Release the GL context rather than leaving it running behind a hidden
  // overlay -- two idle WebGL contexts per wall is real GPU memory.
  stopNoSignalBoard(side, overlay)
}

/**
 * Force both sides into the no-signal state for --no-signal (#248).
 *
 * Runs after the streams have been started, so it overrides whatever they did
 * to the overlay rather than racing them.
 */
function applyForcedNoSignal() {
  if (!state.testFlags.noSignal) return
  showNoSignal('left')
  showNoSignal('right')
  console.log('[TestFlags] no-signal forced on both sides')
  // Arms the screensaver timer, which is what makes --no-signal
  // --screensaver-delay=0 land on a screensaver without any hardware involved.
  updateDvdScreensaver()
}

/**
 * Check if DVD screensaver should be shown and update accordingly
 * Shows when all active feeds have no signal for 5 minutes
 */
function updateDvdScreensaver() {
  // Determine which feeds are active based on layout mode
  let allNoSignal

  if (state.layoutMode === 'dual') {
    // In dual mode, show DVD when both feeds have no signal
    allNoSignal = state.noSignalState.left && state.noSignalState.right
  } else {
    // In single mode, show DVD when the left feed (active feed) has no signal
    allNoSignal = state.noSignalState.left
  }

  if (allNoSignal) {
    // Start timer if not already running
    if (!state.dvdScreensaverTimeout && !isScreensaverRunning()) {
      console.log('[DVD] No signal detected - starting 5 minute timer')
      state.dvdScreensaverTimeout = setTimeout(() => {
        // Double-check we still have no signal before starting
        const stillNoSignal = state.layoutMode === 'dual'
          ? state.noSignalState.left && state.noSignalState.right
          : state.noSignalState.left

        if (stillNoSignal) {
          showDvdScreensaver()
        }
        state.dvdScreensaverTimeout = null
      }, state.dvdScreensaverDelay)
    }
  } else {
    // Signal restored - cancel timer and hide screensaver
    if (state.dvdScreensaverTimeout) {
      clearTimeout(state.dvdScreensaverTimeout)
      state.dvdScreensaverTimeout = null
      console.log('[DVD] Signal restored - cancelled screensaver timer')
    }
    if (isScreensaverRunning()) {
      hideDvdScreensaver()
    }
  }
}

/**
 * Show the DVD screensaver overlay
 */
function showDvdScreensaver() {
  // Overlay must be visible before starting so the canvas has layout size.
  elements.dvdOverlay.classList.remove('hidden')
  const name = startScreensaver() // random pick each activation
  console.log(`[Screensaver] Activated: ${name}`)
  startScreensaverRotation()
}

/**
 * Rotate to a different screensaver periodically.
 *
 * No-signal can persist for hours or days, and a single activation used to run
 * one screensaver for that entire stretch. Each saver now randomises itself per
 * activation (see screensavers/seed.js), but that variation is only ever seen
 * *at* activation -- so without rotation a fresh look would appear once every
 * no-signal event and then be frozen for the duration.
 *
 * The registry avoids repeating the previous pick, so a rotation always visibly
 * changes the screen.
 */
function startScreensaverRotation() {
  stopScreensaverRotation()
  state.screensaverRotateInterval = setInterval(() => {
    if (!isScreensaverRunning()) {
      // Defensive: nothing should stop the saver without clearing this timer,
      // but if it happens, don't resurrect the overlay from a background timer.
      stopScreensaverRotation()
      return
    }
    const name = startScreensaver() // stops the current one, fresh seed
    console.log(`[Screensaver] Rotated to: ${name}`)
  }, state.screensaverRotateDelay)
}

/**
 * Start the screensaver on demand, or step to the next/previous one.
 *
 * Exists so the wall can be browsed without waiting out the no-signal delay:
 * production only starts a saver after state.dvdScreensaverDelay (5 minutes)
 * and then rotates every state.screensaverRotateDelay, which makes reviewing
 * the set on the real display impractical.
 *
 * @param {number} step 0 to just show one, +1/-1 to move through the list
 */
function stepScreensaver(step) {
  const count = screensaverCount()

  if (!isScreensaverRunning()) {
    // Not running: show the overlay and start. A step of 0 gets a random pick,
    // which matches what a real no-signal activation would have done.
    elements.dvdOverlay.classList.remove('hidden')
    const name = step === 0 ? startScreensaver() : startScreensaver(0)
    console.log(`[Screensaver] Manually started: ${name}`)
  } else if (step !== 0) {
    // Wrap in both directions so + at the end returns to the first.
    const next = ((getActiveIndex() + step) % count + count) % count
    const name = startScreensaver(next)
    console.log(`[Screensaver] Manual step to ${next + 1}/${count}: ${name}`)
  } else {
    // Already running and no step: treat as "turn it off".
    hideDvdScreensaver()
    return
  }

  // Restart the rotation countdown. Without this the auto-rotate can fire
  // seconds after a manual pick and jump away from whatever was just selected.
  startScreensaverRotation()
}

/** Cancel the rotation timer. */
function stopScreensaverRotation() {
  if (state.screensaverRotateInterval) {
    clearInterval(state.screensaverRotateInterval)
    state.screensaverRotateInterval = null
  }
}

/**
 * Hide the DVD screensaver overlay
 */
function hideDvdScreensaver() {
  stopScreensaverRotation()
  stopScreensaver()
  elements.dvdOverlay.classList.add('hidden')
  // Stop driving the room lighting (#59). By default this sends nothing at all:
  // the fixtures keep their last colour, so a room with people in it does not
  // suddenly go dark and whatever normally owns the lights takes over on its
  // next command. A scene is posted only if artnetReleaseScene is configured.
  const artnet = getArtnetSync()
  if (artnet) artnet.release()
  console.log('[Screensaver] Deactivated')
}

// =============================================================================
// Layout Management
// =============================================================================

// Input-switch fade. Shorter than the layout transition on purpose: a layout change
// is a deliberate reconfiguration and can take its time, whereas an input change
// should feel immediate. 130ms out, then the stream swap, then the CSS fades it back
// in over 180ms.
const INPUT_FADE_MS = 130

// Monotonic token per side, so an interrupted swap does not fade the wrong stream
// back in. Pressing 2 then 3 quickly must leave input 3 visible, not whichever
// acquisition happened to resolve last.
const swapToken = { left: 0, right: 0 }

// Layout transition (#247). Matches the CSS duration; the two must agree or the
// sibling is hidden mid-slide or long after it has finished.
const LAYOUT_ANIM_MS = 320

// Pending "now actually display:none the collapsed feed" timer. Held at module
// scope so a second layout switch arriving mid-animation can cancel it -- which is
// what makes the transition interruptible rather than leaving a feed hidden after
// the user has already switched back.
let layoutAnimTimer = null

/** 0 when the operator has asked the OS for less motion, so the switch is instant. */
function layoutAnimMs () {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : LAYOUT_ANIM_MS
}

function setLayout(mode) {
  state.layoutMode = mode
  state.settings.layoutMode = mode

  // Update view mode button states in dropdown
  elements.viewModeDual.classList.toggle('active', mode === 'dual')
  elements.viewModeSingle.classList.toggle('active', mode === 'single')

  // Update dropdown input list visibility
  updateDropdownVisibility()

  // Update volume controls to show correct inputs
  renderDropdownVolumeControls()

  // Cancel any pending hide from a previous switch. Without this, switching
  // single -> dual -> single inside the animation window leaves the earlier timer
  // to fire and hide a feed that should now be visible.
  if (layoutAnimTimer !== null) {
    clearTimeout(layoutAnimTimer)
    layoutAnimTimer = null
  }
  const animMs = layoutAnimMs()

  switch (mode) {
    case 'dual':
      document.body.classList.remove('single-view')
      elements.leftFeed.classList.remove('hidden', 'single', 'collapsed')
      // Display it BEFORE clearing .collapsed, then force a reflow: a transition
      // cannot interpolate from display:none, so without the reflow the browser
      // coalesces both changes and the feed appears at full width instantly.
      elements.rightFeed.classList.remove('hidden', 'single')
      void elements.rightFeed.offsetWidth
      elements.rightFeed.classList.remove('collapsed')
      elements.centerDivider.classList.remove('hidden', 'overlay')
      elements.bottomLogo.classList.add('hidden')
      break
    case 'single':
      document.body.classList.add('single-view')
      elements.leftFeed.classList.remove('hidden', 'collapsed')
      elements.leftFeed.classList.add('single')
      // Collapse first and hide only once it has finished, so the right feed
      // shrinks out instead of vanishing.
      elements.rightFeed.classList.add('collapsed')
      layoutAnimTimer = setTimeout(() => {
        layoutAnimTimer = null
        // Only hide if single view is still the current mode -- the switch may
        // have been reversed while this was pending.
        if (state.layoutMode === 'single') elements.rightFeed.classList.add('hidden')
      }, animMs)
      elements.centerDivider.classList.add('overlay')
      elements.bottomLogo.classList.add('hidden')
      break
  }

  saveSettings()
}

function setCenterGap(gap) {
  state.centerGap = gap
  state.settings.centerGap = gap
  elements.centerDivider.style.width = `${gap}px`
  elements.settingsCenterGapValue.textContent = `${gap}px`
  debouncedSaveSettings()
}

function setBorderWidth(width) {
  state.borderWidth = width
  state.settings.borderWidth = width
  document.documentElement.style.setProperty('--border-width', `${width}px`)
  elements.settingsBorderWidthValue.textContent = `${width}px`
  debouncedSaveSettings()
}

// =============================================================================
// Input Selection
// =============================================================================

async function selectInput(index, side = 'both') {
  // Filter to only enabled devices
  const enabledDevices = state.devices.filter(d => isInputEnabled(d.deviceId))
  const device = enabledDevices[index]
  if (!device) return
  
  if (side === 'left' || side === 'both') {
    state.leftDeviceId = device.deviceId
    await startVideoStream(device.deviceId, elements.leftVideo, 'left')
  }
  
  if (side === 'right' || side === 'both') {
    state.rightDeviceId = device.deviceId
    await startVideoStream(device.deviceId, elements.rightVideo, 'right')
  }
  
  const name = getInputName(device.deviceId, device.label || `Input ${index + 1}`)
  showInputName(name)
  saveSettings()
  renderDropdownInputLists()
}

function showInputName(name) {
  elements.inputNameText.textContent = name
  elements.inputNameOverlay.classList.remove('hidden')
  
  // Remove after animation
  setTimeout(() => {
    elements.inputNameOverlay.classList.add('hidden')
  }, 2000)
}

// =============================================================================
// UI Rendering
// =============================================================================

/**
 * Update dropdown visibility based on layout mode
 */
function updateDropdownVisibility() {
  if (state.layoutMode === 'dual') {
    elements.dualColumns.classList.remove('hidden')
    elements.singleInputList.classList.add('hidden')
  } else {
    elements.dualColumns.classList.add('hidden')
    elements.singleInputList.classList.remove('hidden')
  }
}

/**
 * Render the simplified dropdown input lists (enabled inputs only)
 */
// =============================================================================
// Shortcut hints (#258)
// =============================================================================

/**
 * A <kbd> chip, or a row of them with separators.
 *
 * Built as elements rather than an innerHTML string. The chips themselves come
 * from a trusted constant, but the same helper is used next to device labels
 * that come from capture hardware, and having one safe path is cheaper than
 * remembering which call site is which.
 */
function shortcutChips(shortcut, className = 'shortcut-hint') {
  const wrap = document.createElement('span')
  wrap.className = className
  const sep = shortcut.chipSep ?? ' / '
  shortcut.chips.forEach((chip, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode(sep))
    const kbd = document.createElement('kbd')
    kbd.textContent = chip
    wrap.appendChild(kbd)
  })
  return wrap
}

/** A single key as a chip, for the dropdown's per-row hints. */
function shortcutKeyChip(key) {
  const wrap = document.createElement('span')
  wrap.className = 'shortcut-hint'
  const kbd = document.createElement('kbd')
  kbd.textContent = key.toUpperCase()
  wrap.appendChild(kbd)
  return wrap
}

/**
 * Label the dropdown's view-mode buttons and render the Settings table.
 *
 * Both read from the same SHORTCUTS list as the keydown handler (#258), so the
 * three cannot disagree. Called once at startup; nothing here changes with
 * state, unlike the input rows which re-render on every device change.
 */
function renderShortcutHints() {
  // Dual / Single buttons: the two dropdown controls that have a key.
  const buttons = [
    { el: elements.viewModeDual, id: 'layout-dual', text: 'Dual' },
    { el: elements.viewModeSingle, id: 'layout-single', text: 'Single' },
  ]
  for (const { el, id, text } of buttons) {
    if (!el) continue
    const shortcut = SHORTCUTS.find(sc => sc.id === id)
    el.textContent = text
    if (shortcut) el.appendChild(shortcutChips(shortcut))
  }

  // Settings table: every shortcut, in list order.
  const table = elements.shortcutsTable
  if (!table) return
  table.innerHTML = ''
  for (const shortcut of SHORTCUTS) {
    const row = document.createElement('tr')

    const keyCell = document.createElement('td')
    keyCell.appendChild(shortcutChips(shortcut, 'shortcut-keys'))
    row.appendChild(keyCell)

    const labelCell = document.createElement('td')
    labelCell.textContent = shortcut.label
    if (shortcut.note) {
      const note = document.createElement('span')
      note.className = 'shortcut-note'
      note.textContent = ` (${shortcut.note})`
      labelCell.appendChild(note)
    }
    row.appendChild(labelCell)

    table.appendChild(row)
  }
}

function renderDropdownInputLists() {
  // Clear lists
  elements.leftInputList.innerHTML = ''
  elements.rightInputList.innerHTML = ''
  elements.singleInputList.innerHTML = ''

  // Filter to enabled devices only
  const enabledDevices = state.devices.filter(d => isInputEnabled(d.deviceId))

  enabledDevices.forEach((device, index) => {
    const customName = getInputName(device.deviceId, device.label || `Input ${index + 1}`)
    const isLeftActive = device.deviceId === state.leftDeviceId
    const isRightActive = device.deviceId === state.rightDeviceId

    // The number key that selects this input, or null past the fourth (#258).
    // Null rather than an invented key: the wall can have more capture devices
    // than there are number keys, and labelling a fifth row '5' would promise a
    // binding that does not exist.
    const key = inputKeyFor(index)

    // Name via textContent, never innerHTML: this string is a device label from
    // capture hardware or a user-entered rename.
    const buildOption = (className, isActive, side) => {
      const option = document.createElement('div')
      option.className = `${className}${isActive ? ' selected' : ''}`
      const name = document.createElement('span')
      name.className = 'input-option-name'
      name.textContent = customName
      option.appendChild(name)
      if (key) option.appendChild(shortcutKeyChip(key))
      option.addEventListener('click', () => {
        selectInputForSide(device.deviceId, side)
      })
      return option
    }

    elements.leftInputList.appendChild(
      buildOption('input-option', isLeftActive, 'left'))
    elements.rightInputList.appendChild(
      buildOption('input-option', isRightActive, 'right'))
    elements.singleInputList.appendChild(
      buildOption('single-input-option', isLeftActive, 'left'))
  })
}

/**
 * Render the dropdown volume controls for active inputs
 */
function renderDropdownVolumeControls() {
  elements.dropdownInputVolumes.innerHTML = ''

  // Determine which inputs to show based on layout mode
  const inputsToShow = []

  if (state.layoutMode === 'dual') {
    // In dual mode, show both inputs (or one if same)
    if (state.leftDeviceId) {
      inputsToShow.push({ side: 'left', deviceId: state.leftDeviceId })
    }
    if (state.rightDeviceId && state.rightDeviceId !== state.leftDeviceId) {
      inputsToShow.push({ side: 'right', deviceId: state.rightDeviceId })
    }
  } else {
    // In single mode, show only the active input
    if (state.leftDeviceId) {
      inputsToShow.push({ side: 'left', deviceId: state.leftDeviceId })
    }
  }

  // Create volume row for each input
  inputsToShow.forEach(({ side, deviceId }) => {
    const device = state.devices.find(d => d.deviceId === deviceId)
    if (!device) return

    const name = getInputName(deviceId, device.label || 'Input')
    const volume = side === 'left' ? state.leftVolume : state.rightVolume
    const volumePercent = Math.round(volume * 100)

    const row = document.createElement('div')
    row.className = 'volume-row'
    row.innerHTML = `
      <span class="volume-label" title="${name}">${name}</span>
      <input type="range" min="0" max="100" value="${volumePercent}" data-side="${side}">
      <span class="volume-value">${volumePercent}%</span>
    `

    // Volume slider event
    const slider = row.querySelector('input[type="range"]')
    const valueSpan = row.querySelector('.volume-value')
    slider.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value) / 100
      if (side === 'left') {
        setLeftVolume(vol)
      } else {
        setRightVolume(vol)
      }
      valueSpan.textContent = `${e.target.value}%`
    })

    elements.dropdownInputVolumes.appendChild(row)
  })
}

/**
 * Select a specific input for a side
 */
async function selectInputForSide(deviceId, side) {
  const device = state.devices.find(d => d.deviceId === deviceId)
  if (!device) return

  const videoEl = side === 'left' ? elements.leftVideo : elements.rightVideo
  const token = ++swapToken[side]
  const fadeMs = layoutAnimMs() === 0 ? 0 : INPUT_FADE_MS

  // Fade out, swap, fade in. The dark hold covers however long stream acquisition
  // takes, which is the part that otherwise flickers.
  if (fadeMs > 0 && videoEl) {
    videoEl.classList.add('swapping')
    await new Promise(resolve => setTimeout(resolve, fadeMs))
    // A later switch on this side has taken over; let it own the fade-in.
    if (swapToken[side] !== token) return
  }

  if (side === 'left') {
    state.leftDeviceId = deviceId
    await startVideoStream(deviceId, elements.leftVideo, 'left')
  } else {
    state.rightDeviceId = deviceId
    await startVideoStream(deviceId, elements.rightVideo, 'right')
  }

  // Only the newest swap for this side reveals the picture. Without the token, a
  // slow acquisition finishing late would fade in a stream the operator has already
  // switched away from.
  if (videoEl && swapToken[side] === token) videoEl.classList.remove('swapping')

  const name = getInputName(deviceId, device.label || 'Input')
  showInputName(name)
  saveSettings()
  renderDropdownInputLists()
  renderDropdownVolumeControls()
}

/**
 * Render the settings modal input list
 */
function renderSettingsInputList() {
  elements.settingsInputList.innerHTML = ''
  renderOrphanedReferences()

  state.devices.forEach((device, index) => {
    const isEnabled = isInputEnabled(device.deviceId)
    const customName = getInputName(device.deviceId, device.label || `Input ${index + 1}`)
    const isDefault = state.defaultInputId === device.deviceId

    const row = document.createElement('div')
    row.className = 'input-name-row'

    // Reference state for this input. A device with none is silently inert:
    // checkNoSignalFromSource returns false unconditionally and logs nothing,
    // so detection appears broken when it has simply never been configured.
    // Surfacing the count is the point (#161).
    const refs = getReferenceScreenshots(device.deviceId)

    row.innerHTML = `
      <span class="input-number">${index + 1}</span>
      <div class="toggle-switch ${isEnabled ? 'active' : ''}" data-device-id="${device.deviceId}"></div>
      <input type="text" class="input-name-field" value="${customName}" data-device-id="${device.deviceId}" />
      <button class="default-btn${isDefault ? ' active' : ''}" data-device-id="${device.deviceId}">Default</button>
      <button class="ref-toggle-btn${refs.length === 0 ? ' warn' : ''}" data-device-id="${device.deviceId}">
        ${refs.length === 0 ? '⚠ No reference' : `${refs.length} reference${refs.length === 1 ? '' : 's'}`}
      </button>
    `

    // Toggle switch event
    const toggleSwitch = row.querySelector('.toggle-switch')
    toggleSwitch.addEventListener('click', () => {
      toggleInputEnabled(device.deviceId)
    })

    // Name field events
    const nameField = row.querySelector('.input-name-field')
    nameField.addEventListener('change', (e) => {
      setInputName(device.deviceId, e.target.value)
      renderDropdownInputLists() // Update dropdown with new name
    })
    nameField.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.target.blur()
      }
    })

    // Default button event
    const defaultBtn = row.querySelector('.default-btn')
    defaultBtn.addEventListener('click', () => {
      setDefaultInput(device.deviceId)
    })

    elements.settingsInputList.appendChild(row)

    // Expandable reference panel: thumbnails with per-reference delete.
    const panel = document.createElement('div')
    panel.className = 'ref-panel hidden'
    renderReferencePanel(panel, device.deviceId)
    elements.settingsInputList.appendChild(panel)

    row.querySelector('.ref-toggle-btn').addEventListener('click', () => {
      panel.classList.toggle('hidden')
    })
  })
}

/**
 * Surface references whose device is not currently connected (#160).
 *
 * References are keyed by deviceId, and some devices -- virtual cameras
 * especially -- regenerate theirs on reinstall. When that happens the stored
 * reference is stranded and detection silently reports "has signal" for that
 * device forever. Nothing in the UI showed this, so the only symptom was
 * detection appearing not to work.
 *
 * Pruning is offered rather than automatic: a device absent right now may just
 * be unplugged, and discarding its references would throw away deliberate work.
 */
function renderOrphanedReferences() {
  const orphans = findOrphanedReferences(state.devices.map((d) => d.deviceId))
  if (orphans.length === 0) return

  const total = orphans.reduce((n, o) => n + o.count, 0)
  const box = document.createElement('div')
  box.className = 'ref-orphans'

  const text = document.createElement('span')
  text.textContent =
    `${total} reference${total === 1 ? '' : 's'} belong to ` +
    `${orphans.length} device${orphans.length === 1 ? '' : 's'} that ${orphans.length === 1 ? 'is' : 'are'} ` +
    'not connected. If a device changed its id, re-capture its no-signal screen.'
  box.appendChild(text)

  const btn = document.createElement('button')
  btn.className = 'ref-prune-btn'
  btn.textContent = 'Discard them'
  btn.addEventListener('click', async () => {
    pruneOrphanedReferences(state.devices.map((d) => d.deviceId))
    state.settings.noSignalReferences = serializeReferences()
    await saveSettings()
    renderSettingsInputList()
  })
  box.appendChild(btn)

  elements.settingsInputList.appendChild(box)
}

/**
 * Fill a device's reference panel with thumbnails and delete buttons.
 *
 * References are stored as ImageData at the detect resolution, so a thumbnail
 * is just that data drawn to a small canvas -- no separate copy is kept.
 *
 * @param {HTMLElement} panel
 * @param {string} deviceId
 */
function renderReferencePanel(panel, deviceId) {
  const refs = getReferenceScreenshots(deviceId)
  panel.innerHTML = ''

  if (refs.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'ref-empty'
    hint.textContent =
      'No reference captured. Detection cannot fire for this input until one ' +
      'exists: show its no-signal screen, then use Capture above.'
    panel.appendChild(hint)
    return
  }

  const grid = document.createElement('div')
  grid.className = 'ref-grid'

  refs.forEach((ref, i) => {
    const item = document.createElement('div')
    item.className = 'ref-item'

    const canvas = document.createElement('canvas')
    canvas.width = ref.width
    canvas.height = ref.height
    canvas.className = 'ref-thumb'
    canvas.getContext('2d').putImageData(ref, 0, 0)
    canvas.title = `${ref.width}x${ref.height}`

    const del = document.createElement('button')
    del.className = 'ref-delete'
    del.textContent = '×'
    del.title = 'Delete this reference'
    del.addEventListener('click', async () => {
      removeReferenceScreenshot(deviceId, i)
      state.settings.noSignalReferences = serializeReferences()
      await saveSettings()
      // Re-render the whole list: the row's count badge changes too.
      renderSettingsInputList()
    })

    item.appendChild(canvas)
    item.appendChild(del)
    grid.appendChild(item)
  })

  panel.appendChild(grid)

  const note = document.createElement('p')
  note.className = 'ref-note'
  note.textContent = refs.length === 1
    ? 'A frame matching this reference counts as no signal. Capture more if this ' +
      'card shows other no-signal screens (unsupported mode, HDCP error).'
    : `A frame matching any of these ${refs.length} counts as no signal.`
  panel.appendChild(note)
}

/**
 * Set the default input for startup
 */
function setDefaultInput(deviceId) {
  state.defaultInputId = deviceId
  state.settings.defaultInputId = deviceId
  saveSettings()
  renderSettingsInputList() // Re-render to update button states
}

/**
 * Show the settings modal
 */
function showSettingsModal() {
  elements.settingsModal.classList.remove('hidden')
  renderSettingsInputList()
  updateRemoteKeyboardUI()
  updatePresenterDebugUI()
}

/**
 * Update the remote keyboard settings UI to reflect current state
 */
function updateRemoteKeyboardUI() {
  // Update toggle
  if (state.remoteKeyboardEnabled) {
    elements.remoteKeyboardToggle.classList.add('active')
    elements.remoteKeyboardFields.classList.remove('hidden')
  } else {
    elements.remoteKeyboardToggle.classList.remove('active')
    elements.remoteKeyboardFields.classList.add('hidden')
  }
  // Update input fields
  elements.remoteKeyboardHost.value = state.remoteKeyboardHost || ''
  elements.remoteKeyboardApiKey.value = state.remoteKeyboardApiKey || ''
}

/**
 * Toggle remote keyboard enabled state
 */
function toggleRemoteKeyboard() {
  state.remoteKeyboardEnabled = !state.remoteKeyboardEnabled
  state.settings.remoteKeyboardEnabled = state.remoteKeyboardEnabled
  updateRemoteKeyboardUI()
  saveSettings()
}

/**
 * Set the remote keyboard hostname
 */
function setRemoteKeyboardHost(host) {
  state.remoteKeyboardHost = host
  state.settings.remoteKeyboardHost = host
  debouncedSaveSettings()
}

/**
 * Set the remote keyboard API key
 */
function setRemoteKeyboardApiKey(apiKey) {
  state.remoteKeyboardApiKey = apiKey
  state.settings.remoteKeyboardApiKey = apiKey
  debouncedSaveSettings()
}

/**
 * Update the presenter debug overlay visibility to reflect current state
 */
function updatePresenterDebugUI() {
  if (state.presenterDebugEnabled) {
    elements.presenterDebugToggle.classList.add('active')
    elements.presenterDebugOverlay.classList.remove('hidden')
  } else {
    elements.presenterDebugToggle.classList.remove('active')
    elements.presenterDebugOverlay.classList.add('hidden')
  }
}

/**
 * Toggle the presenter debug overlay
 */
function togglePresenterDebug() {
  state.presenterDebugEnabled = !state.presenterDebugEnabled
  state.settings.presenterDebugEnabled = state.presenterDebugEnabled
  updatePresenterDebugUI()
  saveSettings()
}

/**
 * Append a line to the presenter debug overlay (most recent at top, max 8 lines)
 * @param {string} message
 * @param {'ok'|'error'|''} status
 */
function logPresenterDebug(message, status = '') {
  console.log(`[Presenter Debug] ${message}`)
  if (!state.presenterDebugEnabled || !elements.presenterDebugLog) return

  const line = document.createElement('div')
  line.className = `debug-line${status ? ' ' + status : ''}`
  const time = new Date().toLocaleTimeString()
  line.textContent = `${time}  ${message}`

  elements.presenterDebugLog.prepend(line)
  while (elements.presenterDebugLog.childElementCount > 8) {
    elements.presenterDebugLog.lastElementChild.remove()
  }
}

/**
 * Hide the settings modal
 */
function hideSettingsModal() {
  elements.settingsModal.classList.add('hidden')
}

/**
 * Close all panels (dropdown and settings modal)
 */
function closeAllPanels() {
  closeDropdown()
  hideSettingsModal()
}

/**
 * Toggle dropdown open/close state
 */
function toggleDropdown() {
  state.dropdownOpen = !state.dropdownOpen
  updateDropdownState()
}

/**
 * Close the dropdown
 */
function closeDropdown() {
  state.dropdownOpen = false
  updateDropdownState()
}

/**
 * Update dropdown CSS classes based on state
 */
function updateDropdownState() {
  elements.dropdownPanel.classList.toggle('touch-open', state.dropdownOpen)
  elements.dropdownTrigger.classList.toggle('touch-open', state.dropdownOpen)
}

/**
 * Capture no-signal reference for a specific side
 */
async function captureNoSignalForSide(side) {
  const video = side === 'left' ? elements.leftVideo : elements.rightVideo
  const deviceId = side === 'left' ? state.leftDeviceId : state.rightDeviceId

  if (!deviceId) {
    console.error(`[Setup] No device selected for ${side}`)
    return
  }

  if (!video || !video.srcObject || video.readyState < 2) {
    console.error(`[Setup] Video feed not ready for ${side}`)
    return
  }

  // Capture screenshot
  const canvas = document.createElement('canvas')
  const imageData = captureScreenshot(video, canvas)

  if (!imageData) {
    console.error(`[Setup] Failed to capture screenshot for ${side}`)
    return
  }

  // Save reference
  saveReferenceScreenshot(deviceId, imageData)

  // Mark initial setup as complete
  state.settings.initialSetupComplete = true

  // Save to settings
  state.settings.noSignalReferences = serializeReferences()
  await saveSettings()

  console.log(`[Setup] No-signal reference captured for ${side} (${deviceId})`)

  // Visual feedback - briefly change button text
  const btn = side === 'left' ? elements.captureLeftBtn : elements.captureRightBtn
  const originalText = btn.textContent
  btn.textContent = '✓ Captured!'
  btn.disabled = true
  setTimeout(() => {
    btn.textContent = originalText
    btn.disabled = false
  }, 1500)
}

// =============================================================================
// Cursor Management & Shake Detection
// =============================================================================

function showCursor() {
  document.body.classList.add('cursor-visible')

  clearTimeout(state.cursorTimeout)
  state.cursorTimeout = setTimeout(() => {
    document.body.classList.remove('cursor-visible')
  }, state.cursorHideDelay)
}

/**
 * Detect mouse shake pattern (rapid left-right movement)
 * Returns true if shake detected
 */
function detectShake(currentX, currentY) {
  const now = Date.now()

  // Calculate movement direction
  if (state.lastMouseX !== null) {
    const dx = currentX - state.lastMouseX

    // Determine horizontal direction (only track significant movements)
    let direction = null
    if (Math.abs(dx) > 10) {
      direction = dx > 0 ? 'right' : 'left'
    }

    // Check for direction reversal
    if (direction && state.lastMoveDirection && direction !== state.lastMoveDirection) {
      state.shakeHistory.push({ timestamp: now, direction })
    }

    if (direction) {
      state.lastMoveDirection = direction
    }
  }

  state.lastMouseX = currentX
  state.lastMouseY = currentY

  // Clean old entries outside the time window
  state.shakeHistory = state.shakeHistory.filter(
    entry => now - entry.timestamp < state.shakeWindowMs
  )

  // Check if shake detected (enough direction reversals in time window)
  if (state.shakeHistory.length >= state.shakeThreshold) {
    state.shakeHistory = [] // Reset after detection
    return true
  }

  return false
}

/**
 * Reset shake detection state
 */
function resetShakeDetection() {
  state.shakeHistory = []
  state.lastMouseX = null
  state.lastMouseY = null
  state.lastMoveDirection = null
}

/**
 * Handle mouse movement - shows cursor and checks for shake to exit screensaver
 */
function handleMouseMove(event) {
  showCursor()

  // Only check for shake when screensaver is active
  if (isScreensaverRunning()) {
    if (detectShake(event.clientX, event.clientY)) {
      hideDvdScreensaver()
      resetShakeDetection()
      console.log('[Shake] Screensaver dismissed by mouse shake')
    }
  }
}

// =============================================================================
// Remote Keyboard
// =============================================================================

/**
 * Send a keypress to the remote keyboard device
 * @param {string} direction - 'left' or 'right'
 */
async function sendRemoteKeypress(direction) {
  if (!state.remoteKeyboardEnabled) return
  if (!state.remoteKeyboardHost || !state.remoteKeyboardApiKey) {
    logPresenterDebug(`${direction}: skipped (host/API key not set)`, 'error')
    return
  }

  const host = state.remoteKeyboardHost.trim()
  // Add http:// prefix and .local suffix if needed
  let url = host
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`
  }
  if (!url.includes('.') && !url.includes(':')) {
    url = `${url}.local`
  }
  url = `${url}/${direction}`

  logPresenterDebug(`${direction} → ${url}`)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': state.remoteKeyboardApiKey
      }
    })

    if (!response.ok) {
      console.warn(`[Remote Keyboard] Request failed: ${response.status}`)
      logPresenterDebug(`${direction}: failed (HTTP ${response.status})`, 'error')
    } else {
      console.log(`[Remote Keyboard] Sent: ${direction}`)
      logPresenterDebug(`${direction}: sent (HTTP ${response.status})`, 'ok')
    }
  } catch (error) {
    console.warn(`[Remote Keyboard] Error: ${error.message}`)
    logPresenterDebug(`${direction}: error (${error.message})`, 'error')
  }
}

// =============================================================================
// Keyboard Shortcuts
// =============================================================================

/**
 * What each shortcut id does.
 *
 * Keyed by the ids in shortcuts.js, which is where the keys themselves live
 * (#258). Splitting it this way is what makes the invariant structural rather
 * than a convention: handleKeyDown builds its lookup from SHORTCUTS, so a key
 * that is not in the list is simply not handled, and an id in the list with no
 * action here is caught by a test.
 *
 * Actions receive the event because a few need it -- select-input reads which
 * number was pressed rather than needing four near-identical entries.
 */
const SHORTCUT_ACTIONS = {
  'select-input': (event) => selectInput(parseInt(event.key, 10) - 1),

  // Documented in the README since before the keyboard handler existed, but
  // never wired up (#157): layout was switchable from the dropdown only, so a
  // documented key silently did nothing. The booth is operated by keyboard,
  // often by someone following a printed shortcut list, where that reads as the
  // app being broken rather than the docs being wrong.
  'layout-dual': () => setLayout('dual'),

  // Single view shows the left feed. That is always the selected input: the
  // number keys call selectInput() with the default side='both', so both feeds
  // carry the same device and there is no "wrong side" to show.
  'layout-single': () => setLayout('single'),

  'freeze': () => toggleFreeze(),

  // Toggle the screensaver on demand. Not 'S': that is documented in the README
  // as single-view layout, and taking it would either break a documented binding
  // or quietly make the docs wrong.
  'screensaver-toggle': () => stepScreensaver(0),
  'screensaver-next': () => stepScreensaver(1),
  'screensaver-prev': () => stepScreensaver(-1),

  'fullscreen': () => window.electronAPI.toggleFullscreen(),

  'escape': () => {
    closeAllPanels()
    if (state.frozen) {
      toggleFreeze() // Unfreeze on escape
    }
    window.electronAPI.isFullscreen().then(isFs => {
      if (isFs) window.electronAPI.toggleFullscreen()
    })
  },

  'quit': () => window.electronAPI.quitApp(),

  'remote-back': () => sendRemoteKeypress('left'),
  'remote-forward': () => sendRemoteKeypress('right'),
}

function handleKeyDown(event) {
  // Don't handle if typing in an input
  if (event.target.tagName === 'INPUT') return

  console.log(`[Key] pressed: "${event.key}" (code: ${event.code})`)

  const shortcut = SHORTCUTS_BY_KEY.get(event.key.toLowerCase())
  if (!shortcut) return

  const action = SHORTCUT_ACTIONS[shortcut.id]
  if (!action) {
    // Only reachable if an entry was added to shortcuts.js without an action
    // here, which a test is meant to catch long before this could run.
    console.error(`[Key] no action for shortcut "${shortcut.id}"`)
    return
  }

  if (shortcut.preventDefault) event.preventDefault()
  action(event)
}

// =============================================================================
// Event Listeners
// =============================================================================

function setupEventListeners() {
  // Mouse movement shows cursor and checks for shake to exit screensaver
  document.addEventListener('mousemove', handleMouseMove)

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyDown)

  // Keep cursor visible when hovering dropdown
  elements.dropdownTrigger.addEventListener('mouseenter', () => {
    document.body.classList.add('cursor-visible')
    clearTimeout(state.cursorTimeout)
  })

  elements.dropdownPanel.addEventListener('mouseenter', () => {
    document.body.classList.add('cursor-visible')
    clearTimeout(state.cursorTimeout)
  })

  elements.dropdownPanel.addEventListener('mouseleave', () => {
    showCursor() // Reset cursor timeout
  })

  // View mode buttons in dropdown
  elements.viewModeDual.addEventListener('click', () => setLayout('dual'))
  elements.viewModeSingle.addEventListener('click', () => setLayout('single'))

  // Settings button opens modal
  elements.openSettingsBtn.addEventListener('click', () => {
    showSettingsModal()
  })

  // Close settings modal
  elements.closeSettingsBtn.addEventListener('click', () => {
    hideSettingsModal()
  })

  // Close modal on backdrop click
  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      hideSettingsModal()
    }
  })

  // Settings modal sliders
  elements.settingsCenterGap.addEventListener('input', (e) => {
    setCenterGap(parseInt(e.target.value))
  })

  elements.settingsBorderWidth.addEventListener('input', (e) => {
    setBorderWidth(parseInt(e.target.value))
  })

  // No-signal capture buttons
  elements.captureLeftBtn.addEventListener('click', () => {
    captureNoSignalForSide('left')
  })

  elements.captureRightBtn.addEventListener('click', () => {
    captureNoSignalForSide('right')
  })

  // Remote keyboard settings
  elements.remoteKeyboardToggle.addEventListener('click', toggleRemoteKeyboard)

  elements.remoteKeyboardHost.addEventListener('input', (e) => {
    setRemoteKeyboardHost(e.target.value)
  })

  elements.remoteKeyboardHost.addEventListener('keydown', (e) => {
    e.stopPropagation() // Prevent keyboard shortcuts while typing
  })

  elements.remoteKeyboardApiKey.addEventListener('input', (e) => {
    setRemoteKeyboardApiKey(e.target.value)
  })

  elements.remoteKeyboardApiKey.addEventListener('keydown', (e) => {
    e.stopPropagation() // Prevent keyboard shortcuts while typing
  })

  // Presenter tool debug overlay toggle
  elements.presenterDebugToggle.addEventListener('click', togglePresenterDebug)

  // System volume slider in dropdown
  elements.dropdownSystemVolume.addEventListener('input', async (e) => {
    const volume = parseInt(e.target.value)
    elements.dropdownSystemVolumeValue.textContent = `${volume}%`
    await setSystemVolume(volume)
  })

  // Touch support for dropdown
  elements.dropdownTrigger.addEventListener('touchstart', (e) => {
    e.preventDefault() // Prevent mouse events from firing
    toggleDropdown()
    showCursor()
  }, { passive: false })

  // Close dropdown when tapping outside
  document.addEventListener('touchstart', (e) => {
    if (state.dropdownOpen) {
      const isInsideDropdown = elements.dropdownPanel.contains(e.target) ||
                               elements.dropdownTrigger.contains(e.target)
      if (!isInsideDropdown) {
        closeDropdown()
      }
    }
  }, { passive: true })

  // Device changes (when plugging/unplugging devices)
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    console.log('Device change detected')
    // Drop detection frame sources: a re-plugged capture card gets new tracks,
    // and the old ones would otherwise be read until the loop noticed.
    closeAllFrameSources()
    await getVideoDevices()
  })

  // Auto-updater download progress
  if (window.electronAPI && window.electronAPI.onUpdaterProgress) {
    window.electronAPI.onUpdaterProgress((percent) => {
      console.log('Updater progress:', percent + '%')
      elements.updateMessage.textContent = `Downloading update... ${percent}%`
      elements.updateNotification.classList.remove('hidden')
      // Hide notification when download completes (dialog will show)
      if (percent >= 100) {
        setTimeout(() => {
          elements.updateNotification.classList.add('hidden')
        }, 1000)
      }
    })
  }
}

// =============================================================================
// No-Signal Detection
// =============================================================================

// Frame sources for detection, keyed by deviceId (issue #61). Each entry also
// records the track it was built from, so a device that gets a new stream
// (input switch, device re-plug) gets a fresh source instead of reading a dead
// track forever.
const frameSources = new Map()

/**
 * Frame source for a device, creating or replacing it as needed.
 *
 * Prefers WebCodecs and falls back to the canvas readback; see frame-source.js.
 * Returns null when the video has no usable track yet.
 */
function getFrameSource(deviceId, video) {
  const track = video.srcObject?.getVideoTracks?.()[0] ?? null
  if (!track) {
    // Stream gone: drop any source so the next live track builds a new one.
    const stale = frameSources.get(deviceId)
    if (stale) {
      stale.source.close()
      frameSources.delete(deviceId)
    }
    return null
  }

  const existing = frameSources.get(deviceId)
  if (existing && existing.track === track) return existing.source

  if (existing) existing.source.close()

  const source = createFrameSource(video, state.detectionCanvas)
  frameSources.set(deviceId, { track, source })
  if (CONFIG_DETECT_LOG) {
    console.log(`[Detection] Frame source for ${deviceId}: ${source.kind}`)
  }
  return source
}

/** Release every frame source (device list changed, detection stopping). */
function closeAllFrameSources() {
  for (const { source } of frameSources.values()) source.close()
  frameSources.clear()
}

// One-line log per source creation is useful when diagnosing which path is in
// use on the wall; the per-cycle detection logging stays behind CONFIG.
const CONFIG_DETECT_LOG = true

/**
 * Bring up experimental WebGPU compositing if it has been switched on.
 *
 * Off unless `gpuCompositing: true` is set in settings.json. Default behaviour
 * is the CSS path Chromium already uses, which keeps decoded frames on the GPU
 * -- so this is a benchmarking alternative (issue #62), not an improvement to
 * switch on blind.
 *
 * Every failure path leaves the CSS layout untouched: no adapter, no context,
 * a shader that will not compile, or a throw during setup all end with the
 * canvas hidden and video rendering exactly as before.
 */
async function initGpuCompositing() {
  if (!state.gpuCompositing) return

  const canvas = elements.gpuCanvas
  if (!canvas) {
    console.warn('[GPU] No compositor canvas in the DOM; staying on the CSS path')
    return
  }

  if (!(await supportsGpuCompositing())) {
    console.warn('[GPU] WebGPU unavailable; staying on the CSS path')
    return
  }

  let compositor
  try {
    compositor = await createGpuCompositor(canvas)
  } catch (err) {
    console.error('[GPU] Compositor setup failed; staying on the CSS path:', err)
    return
  }
  if (!compositor) {
    console.warn('[GPU] Compositor unavailable; staying on the CSS path')
    return
  }

  state.gpuCompositor = compositor
  // Size the backing store to device pixels, or the canvas renders at its
  // 300x150 default and gets stretched. Capped at 2x DPR to match the
  // screensaver runtime and avoid enormous buffers on the videowall.
  const sizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr))
  }
  sizeCanvas()
  window.addEventListener('resize', sizeCanvas)

  canvas.classList.remove('hidden')
  document.body.classList.add('gpu-compositing')
  console.log('[GPU] WebGPU compositing active (experimental)')

  // Drive from rVFC so compositing follows decoded frames, same rationale as
  // the detection loop. One failed frame disables the path rather than
  // repeating the error every frame.
  const drawFrame = () => {
    if (!state.gpuCompositor) return
    try {
      state.gpuCompositor.draw(gpuFeedLayout())
    } catch (err) {
      console.error('[GPU] Draw failed; reverting to the CSS path:', err)
      teardownGpuCompositing()
      return
    }
    scheduleGpuFrame(drawFrame)
  }
  scheduleGpuFrame(drawFrame)
}

/** Schedule the next composite, preferring decoded-frame callbacks. */
function scheduleGpuFrame(cb) {
  const video = elements.leftVideo
  if (video?.srcObject && !video.paused &&
      typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback(cb)
  } else {
    requestAnimationFrame(cb)
  }
}

/** Where each feed sits in the composited target, in normalised [0,1] space. */
function gpuFeedLayout() {
  if (state.layoutMode === 'dual') {
    // Two halves with the centre gap expressed as a fraction of the width.
    const gap = (state.centerGap || 0) / (window.innerWidth || 1)
    const half = (1 - gap) / 2
    return [
      { video: elements.leftVideo, offset: [0, 0], scale: [half, 1] },
      { video: elements.rightVideo, offset: [half + gap, 0], scale: [half, 1] },
    ]
  }
  return [{ video: elements.leftVideo, offset: [0, 0], scale: [1, 1] }]
}

/** Return to the CSS path and release GPU resources. */
function teardownGpuCompositing() {
  if (!state.gpuCompositor) return
  state.gpuCompositor.destroy()
  state.gpuCompositor = null
  elements.gpuCanvas?.classList.add('hidden')
  document.body.classList.remove('gpu-compositing')
  console.log('[GPU] Compositing stopped; CSS path restored')
}

/**
 * Initialize the no-signal detection system
 */
async function initNoSignalDetection() {
  // Canvas is still needed: it backs the fallback frame source and the
  // freeze-frame capture path.
  state.detectionCanvas = document.createElement('canvas')

  console.log(`[Detection] Frame reading: ${supportsWebCodecsFrames() ? 'WebCodecs available' : 'canvas fallback only'}`)

  // Load saved reference screenshots from settings
  if (state.settings.noSignalReferences) {
    await deserializeReferences(state.settings.noSignalReferences)

    // Rewrite settings if migration shrank anything. References used to be
    // stored at full capture resolution -- twelve 1080p entries made
    // settings.json 21MB, re-read and base64-decoded on every startup -- and
    // deserializeReferences now downscales them to the detect size. Without
    // this the shrink would not reach disk until the next manual capture.
    const before = JSON.stringify(state.settings.noSignalReferences).length
    const migrated = serializeReferences()
    const after = JSON.stringify(migrated).length
    if (after < before * 0.9) {
      state.settings.noSignalReferences = migrated
      await saveSettings()
      console.log(`[Detection] Migrated references to detect resolution: ` +
        `${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`)
    }
  }

  // Warn about references whose device is no longer present (#160). Keyed by
  // deviceId, so a virtual camera that regenerated its id leaves its reference
  // stranded -- detection then reports "has signal" for that device forever
  // with nothing logged, which is indistinguishable from never configuring it.
  const orphans = findOrphanedReferences(state.devices.map((d) => d.deviceId))
  if (orphans.length > 0) {
    const total = orphans.reduce((n, o) => n + o.count, 0)
    console.warn(`[Detection] ${total} reference(s) belong to ${orphans.length} device(s) ` +
      'that are not currently connected. If a device changed its id, re-capture ' +
      'its no-signal screen; the settings panel lists them.',
    orphans.map((o) => `${o.deviceId.slice(0, 16)} (${o.count})`))
  }

  console.log('[Detection] No-signal detection initialized')
  startDetectionLoop()
}

// Detection cadence. Previously counted 100 rAF ticks, which assumed 60Hz --
// on a 120Hz panel that is 0.8s and on a stalled feed it never fires. A wall
// clock interval means the same real-world cadence regardless.
const DETECT_INTERVAL_MS = 1600

/**
 * Start the detection loop.
 *
 * Paced by requestVideoFrameCallback on a capture video when available (issue
 * #60), which ticks per *decoded frame* rather than per display refresh. Two
 * consequences that matter here:
 *
 *   - sampling follows the capture feed, not the monitor, so cadence does not
 *     change with refresh rate
 *   - a stalled feed stops delivering callbacks, so detection idles instead of
 *     spinning at 60Hz over a frozen image
 *
 * rAF remains the fallback when rVFC is unavailable or no video is playing --
 * detection must keep running even if it is only to notice nothing is arriving.
 */
/**
 * Whether to emit the verbose detection trace.
 *
 * Read live rather than captured, so it can be toggled from the DevTools
 * console mid-run without a rebuild:
 *
 *   __detectDebug(true)    // start tracing
 *   __detectDebug(false)   // stop
 *   __detectState()        // one-shot snapshot of why detection is or is not firing
 */

/**
 * One-shot diagnostic: why is (or isn't) no-signal detection firing?
 *
 * Walks the same preconditions the detection loop does and reports the first
 * one that fails, per side, rather than making someone read a stream of
 * per-cycle logs. Exposed on globalThis for the DevTools console.
 */
async function detectionSnapshot() {
  const out = {
    detectionLoopRunning: state.detectionRunning,
    frozen: state.frozen,
    layoutMode: state.layoutMode,
    screensaverRunning: isScreensaverRunning(),
    sides: {}
  }

  for (const side of ['left', 'right']) {
    const video = side === 'left' ? elements.leftVideo : elements.rightVideo
    const deviceId = side === 'left' ? state.leftDeviceId : state.rightDeviceId
    const info = { deviceId: deviceId ? deviceId.slice(0, 16) : null }

    if (!deviceId) { info.blocker = 'no device selected for this side'; out.sides[side] = info; continue }
    if (!video?.srcObject) { info.blocker = 'video element has no stream'; out.sides[side] = info; continue }

    info.readyState = video.readyState
    info.videoSize = `${video.videoWidth}x${video.videoHeight}`
    if (video.readyState < 2) { info.blocker = 'readyState < 2 (no decoded frame yet)'; out.sides[side] = info; continue }

    const refs = getReferenceScreenshots(deviceId)
    info.referenceCount = refs.length
    info.referenceSizes = refs.map((r) => `${r.width}x${r.height}`)
    if (refs.length === 0) {
      info.blocker = 'NO REFERENCE CAPTURED for this device -- detection can never fire. ' +
        'Capture one from the settings panel while the no-signal screen is showing.'
      out.sides[side] = info
      continue
    }

    // Actually run a comparison and report the numbers behind the verdict.
    const source = getFrameSource(deviceId, video)
    if (!source) { info.blocker = 'no frame source could be created'; out.sides[side] = info; continue }

    const frame = await source.read()
    if (!frame) { info.blocker = 'frame source returned no frame yet'; out.sides[side] = info; continue }
    info.comparedAt = `${frame.width}x${frame.height}`

    info.perReference = refs.map((ref, i) => {
      const scaled = referenceAtSize(deviceId, i, ref, frame.width, frame.height)
      if (!scaled) return { index: i, error: 'could not scale reference' }
      const probePassed = probeFrames(frame, scaled)
      return {
        index: i,
        referenceSize: `${ref.width}x${ref.height}`,
        probePassed,
        matchRatio: probePassed ? matchRatio(frame, scaled) : '(probe rejected, not scanned)',
        needed: CONFIG.matchThreshold
      }
    })

    const anyMatch = info.perReference.some(
      (r) => typeof r.matchRatio === 'number' && r.matchRatio >= CONFIG.matchThreshold)
    info.verdict = anyMatch ? 'NO SIGNAL (would fire)' : 'has signal (would not fire)'
    info.overlayShown = state.noSignalState[side]
    if (!anyMatch) {
      const best = info.perReference
        .map((r) => (typeof r.matchRatio === 'number' ? r.matchRatio : 0))
        .reduce((a, b) => Math.max(a, b), 0)
      info.blocker = `best match ${(best * 100).toFixed(1)}% is below the ` +
        `${(CONFIG.matchThreshold * 100).toFixed(0)}% threshold`
    }
    out.sides[side] = info
  }

  console.log('[Detect] snapshot', JSON.parse(JSON.stringify(out)))
  return out
}

function detectionDebug() {
  return globalThis.__INPUT_VIEWER_DETECT_DEBUG__ === true
}
// Tracing is currently unconditional while this is being diagnosed, so the
// flag has no reader. Kept referenced so the helper survives until the trace
// is trimmed back to opt-in.
void detectionDebug

// Console helpers. Deliberately on globalThis rather than a settings toggle:
// this is for diagnosing a specific machine's hardware, not a shipped feature.
globalThis.__detectDebug = (on = true) => {
  globalThis.__INPUT_VIEWER_DETECT_DEBUG__ = on === true
  setDebugLogging(on === true)
  console.log(`[Detect] tracing ${on ? 'ON' : 'OFF'}`)
}
globalThis.__detectState = () => detectionSnapshot()

// Collector used by __diag(). Null except while a capture is in progress.
let diagCollect = null

/**
 * Capture a few detection cycles to a log file and report where it landed.
 *
 * Reading this off the console is impractical -- the loop ticks at display
 * rate, so the interesting lines scroll away instantly. This writes a short
 * report instead.
 *
 *   await __diag()        // ~4 cycles, about 7 seconds
 */
globalThis.__diag = async (cycles = 4) => {
  const lines = []
  const stamp = new Date().toISOString()
  lines.push(`=== detection diagnostic ${stamp} ===`)
  lines.push(`layout=${state.layoutMode} frozen=${state.frozen} ` +
    `detectionRunning=${state.detectionRunning}`)
  for (const side of ['left', 'right']) {
    const v = side === 'left' ? elements.leftVideo : elements.rightVideo
    const id = side === 'left' ? state.leftDeviceId : state.rightDeviceId
    lines.push(`${side}: device=${id ? id.slice(0, 16) : 'none'} ` +
      `readyState=${v?.readyState} size=${v?.videoWidth}x${v?.videoHeight} ` +
      `refs=${id ? getReferenceScreenshots(id).length : 0}`)
  }

  diagCollect = (line) => lines.push(line)
  setDiagnosticSink((line) => lines.push(line))
  const seen = lines.length
  await new Promise((r) => setTimeout(r, DETECT_INTERVAL_MS * cycles + 500))
  diagCollect = null
  setDiagnosticSink(null)

  if (lines.length === seen) lines.push('(no detection cycles ran during the capture window)')
  if (!window.electronAPI?.diagLog) {
    console.error('[Diag] electronAPI.diagLog missing -- preload did not expose it. ' +
      'Dumping to console instead:')
    console.log(lines.join('\n'))
    return null
  }
  const file = await window.electronAPI.diagLog(lines)
  if (!file) {
    console.error('[Diag] main process could not write the file. Dumping here instead:')
    console.log(lines.join('\n'))
  } else {
    console.log(`[Diag] written to:\n${file}`)
  }
  return file
}

function startDetectionLoop() {
  if (state.detectionRunning) return

  // --no-signal (#248) overrides detection's verdict, so running it would spend
  // a per-cycle GPU readback on a result that is thrown away -- and every cycle
  // would log a "signal restored" that hideNoSignal then refuses to act on.
  // Left off rather than left running-and-ignored.
  if (state.testFlags.noSignal) {
    console.log('[Detection] Not started: --no-signal pins the state')
    return
  }

  state.detectionRunning = true

  let lastRun = 0
  let running = false

  const supportsRvfc = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
  console.log(`[Detection] Loop paced by ${supportsRvfc ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

  async function runDetection() {
    const devicesToCheck = getUniqueActiveDevices()

    // Diagnostic: every early-continue below silently skips detection, and
    // there is no way to tell from the outside which one fired. Logged once
    // per cycle when debug logging is on.
    if (diagCollect) {
      diagCollect(`cycle: ${devicesToCheck.length} device(s) ` +
        devicesToCheck.map(d => `${d.side}:${d.deviceId.slice(0, 8)}`).join(' '))
    }

    for (const { deviceId, video, side } of devicesToCheck) {
      if (!video.srcObject) {
        diagCollect?.(`SKIP ${side}: no srcObject`)
        continue
      }
      if (video.readyState < 2) {
        diagCollect?.(`SKIP ${side}: readyState ${video.readyState} < 2`)
        continue
      }
      if (!isDetectionReady(deviceId)) {
        diagCollect?.(`SKIP ${side}: NO REFERENCE`)
        continue
      }

      const source = getFrameSource(deviceId, video)
      if (!source) {
        diagCollect?.(`SKIP ${side}: no frame source`)
        continue
      }

      const isNoSignal = await checkNoSignalFromSource(deviceId, source)
      diagCollect?.(`${side}: isNoSignal=${isNoSignal} overlay=${state.noSignalState[side]}`)

      // Detection is async now, so the layout may have changed while awaiting.
      if (!state.detectionRunning) return

      if (isNoSignal && !state.noSignalState[side]) {
        showNoSignal(side)
        console.log(`[Detection] No signal detected on ${side} (${deviceId})`)
      } else if (!isNoSignal && state.noSignalState[side]) {
        hideNoSignal(side)
        console.log(`[Detection] Signal restored on ${side} (${deviceId})`)
      }

      // If same device is on both sides, sync the state
      if (state.layoutMode === 'dual' && state.leftDeviceId === state.rightDeviceId) {
        const otherSide = side === 'left' ? 'right' : 'left'
        if (isNoSignal && !state.noSignalState[otherSide]) {
          showNoSignal(otherSide)
          console.log(`[Detection] No signal detected on ${otherSide} (synced from ${side})`)
        } else if (!isNoSignal && state.noSignalState[otherSide]) {
          hideNoSignal(otherSide)
          console.log(`[Detection] Signal restored on ${otherSide} (synced from ${side})`)
        }
      }
    }

    updateDvdScreensaver()
  }

  function tick(now) {
    if (!state.detectionRunning) { console.log('[TRACE] tick: loop not running'); return }
    clearWatchdog()

    const t = typeof now === 'number' ? now : performance.now()
    // `running` guards re-entry: detection is async and a slow cycle must not
    // overlap itself, or two passes would race on the same device state.
    if (!running && !state.frozen && t - lastRun >= DETECT_INTERVAL_MS) {
      lastRun = t
      running = true
      runDetection()
        .catch(err => console.error('[TRACE] runDetection THREW:', err))
        .finally(() => { running = false })
    }

    schedule()
  }

  // Guards against the rVFC deadlock described below: cleared whenever a tick
  // happens by any route, so only a genuinely stalled feed ever fires it.
  let watchdog = null

  function clearWatchdog() {
    if (watchdog !== null) {
      clearTimeout(watchdog)
      watchdog = null
    }
  }

  function schedule() {
    if (!state.detectionRunning) return

    if (supportsRvfc) {
      // Pace from whichever active video is playing; the left feed is always
      // present in both layouts, so prefer it and fall back to the right.
      for (const video of [elements.leftVideo, elements.rightVideo]) {
        if (video?.srcObject && !video.paused) {
          video.requestVideoFrameCallback(tick)

          // A video that is playing but produces NO new frames never fires
          // rVFC, so detection stops running entirely -- and a feed that has
          // stopped producing frames is exactly the case detection exists to
          // catch. That is not hypothetical: a virtual camera showing a static
          // image (OBS with no scene change) delivers no frames, so no-signal
          // could never fire for it.
          //
          // The pre-existing requestAnimationFrame fallback below does not
          // cover this: it only applies when there is no playing video at all.
          //
          // So arm a timer alongside rVFC. Whichever fires first runs the tick
          // and cancels the other.
          clearWatchdog()
          watchdog = setTimeout(() => {
            watchdog = null
            tick(performance.now())
          }, DETECT_INTERVAL_MS * 2)
          return
        }
      }
    }
    // No playing video (or no rVFC): keep ticking so detection still notices
    // when a feed comes back.
    requestAnimationFrame(tick)
  }

  schedule()
}

/**
 * Stop the detection loop and release its frame sources.
 */
function stopDetectionLoop() {
  state.detectionRunning = false
  closeAllFrameSources()
}

/**
 * Get unique active devices to check (avoid duplicate checks for same device)
 * @returns {Array<{deviceId: string, video: HTMLVideoElement, side: string}>}
 */
function getUniqueActiveDevices() {
  const devices = []
  const checkedIds = new Set()
  
  // In dual mode, check both feeds if they have different sources
  // In single mode, only check the visible feed
  
  if (state.layoutMode === 'dual') {
    // Left feed
    if (state.leftDeviceId && elements.leftVideo.srcObject) {
      devices.push({ 
        deviceId: state.leftDeviceId, 
        video: elements.leftVideo, 
        side: 'left' 
      })
      checkedIds.add(state.leftDeviceId)
    }
    
    // Right feed - only if different device
    if (state.rightDeviceId && elements.rightVideo.srcObject && !checkedIds.has(state.rightDeviceId)) {
      devices.push({ 
        deviceId: state.rightDeviceId, 
        video: elements.rightVideo, 
        side: 'right' 
      })
    } else if (state.rightDeviceId && checkedIds.has(state.rightDeviceId)) {
      // Same device on both feeds - copy state from left
      // This will be handled in the detection result propagation
    }
  } else {
    // Single mode - only check left feed (which shows the active source)
    if (state.leftDeviceId && elements.leftVideo.srcObject) {
      devices.push({ 
        deviceId: state.leftDeviceId, 
        video: elements.leftVideo, 
        side: 'left' 
      })
    }
  }
  
  return devices
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
  console.log('Input Viewer initializing...')

  // First, before anything reads state.testFlags: device enumeration, the
  // screensaver delay and the no-signal state all branch on it.
  await loadTestFlags()

  // Display app version from package.json
  if (window.electronAPI && window.electronAPI.getAppVersion) {
    try {
      const version = await window.electronAPI.getAppVersion()
      if (elements.settingsAppVersion) {
        elements.settingsAppVersion.textContent = `Input Viewer v${version}`
      }
    } catch (e) {
      console.error('Error getting app version:', e)
    }
  }

  // Load settings from file
  state.settings = await loadSettings()

  // Load default input from settings
  state.defaultInputId = state.settings.defaultInputId || null

  // Setup event listeners
  setupEventListeners()

  // Detect screen aspect ratio and set default layout
  // If aspect ratio >= 3:1 (super wide) → dual view
  // If aspect ratio < 3:1 (normal/square) → single view
  const screenAspectRatio = window.screen.width / window.screen.height
  console.log(`Screen width: ${window.screen.width}, height: ${window.screen.height}`)
  console.log(`Calculated screen aspect ratio: ${screenAspectRatio.toFixed(2)}`)
  const defaultLayout = screenAspectRatio >= 3 ? 'dual' : 'single'
  console.log(`Screen aspect ratio: ${screenAspectRatio.toFixed(2)} → default layout: ${defaultLayout}`)

  // Use saved layout mode if available, otherwise use screen-based default
  const layoutMode = state.settings.layoutMode || defaultLayout
  setLayout(layoutMode)

  // Initialize center gap and border width from settings
  const centerGap = state.settings.centerGap || 60
  setCenterGap(centerGap)
  elements.settingsCenterGap.value = centerGap

  const borderWidth = state.settings.borderWidth || 0
  setBorderWidth(borderWidth)
  elements.settingsBorderWidth.value = borderWidth

  // Initialize audio volumes from settings
  state.leftVolume = state.settings.leftVolume ?? 1.0
  state.rightVolume = state.settings.rightVolume ?? 1.0
  state.systemVolume = state.settings.systemVolume ?? 50

  // Initialize remote keyboard settings
  state.remoteKeyboardEnabled = state.settings.remoteKeyboardEnabled ?? false
  state.remoteKeyboardHost = state.settings.remoteKeyboardHost ?? ''
  state.remoteKeyboardApiKey = state.settings.remoteKeyboardApiKey ?? ''

  // Initialize presenter debug overlay
  state.presenterDebugEnabled = state.settings.presenterDebugEnabled ?? false
  updatePresenterDebugUI()

  // Experimental WebGPU compositing (issue #62): opt-in via settings.json only,
  // and it self-disables if WebGPU is unusable.
  state.gpuCompositing = state.settings.gpuCompositing ?? false

  // Initialize system volume from actual system (async)
  syncSystemVolume()

  // Start system volume sync polling (every 2 seconds)
  setInterval(syncSystemVolume, 2000)

  // Get video devices and start streams
  await getVideoDevices()

  // Start video streams
  if (state.devices.length > 0) {
    // Use default input if set and device exists
    if (state.defaultInputId) {
      const defaultDevice = state.devices.find(d => d.deviceId === state.defaultInputId)
      if (defaultDevice && isInputEnabled(state.defaultInputId)) {
        state.leftDeviceId = state.defaultInputId
        if (layoutMode === 'dual') {
          state.rightDeviceId = state.defaultInputId
        }
      }
    }

    // Always start left stream
    await startVideoStream(state.leftDeviceId, elements.leftVideo, 'left')

    // Start right stream in dual mode
    if (layoutMode === 'dual' && state.rightDeviceId) {
      await startVideoStream(state.rightDeviceId, elements.rightVideo, 'right')
    }
  }

  // --no-signal (#248): override whatever the streams above did to the overlays.
  applyForcedNoSignal()

  // Initialize screensaver registry (random screensaver chosen on activation)
  initScreensavers(elements.screensaverCanvas)

  // Weather polling for the weather screensaver (#101).
  //
  // Deliberately owned here rather than by the saver. The registry's start path
  // is synchronous and its failure handling is a try/catch around create()+
  // start(), so a fetch that rejects after start() returns cannot be caught
  // there -- a saver that polled for itself would leave a blank canvas and an
  // unhandled rejection. Polling out here also means no-signal never waits on
  // HTTP, and a wall that boots offline simply never offers the saver.
  //
  // getConfig is read at each poll rather than captured, so toggling the setting
  // takes effect without a restart. start() is a no-op while disabled.
  installWeatherSource({
    getConfig: () => ({
      enabled: Boolean(state.settings.weatherEnabled),
      latitude: state.settings.weatherLatitude,
      longitude: state.settings.weatherLongitude
    })
  }).start()

  // Art-Net reactive mode (#59): drive the room lighting from whatever the
  // screensaver is showing.
  //
  // Registered once, for the app's lifetime, rather than per activation: the
  // observer is a no-op while disabled, and gl-base only pays for the readback
  // when at least one observer exists. offerFrame() owns its own rate limiting
  // (1Hz) and backoff, so this callback stays a single call per frame.
  const artnet = installArtnetSync({
    getConfig: () => ({
      enabled: Boolean(state.settings.artnetEnabled),
      url: state.settings.artnetUrl,
      target: state.settings.artnetTarget,
      releaseScene: state.settings.artnetReleaseScene,
      maxBrightness: state.settings.artnetMaxBrightness
    })
  })
  observeFrames((rgba) => artnet.offerFrame(rgba))

  // Experimental WebGPU compositing. No-op unless enabled in settings, and
  // failures leave the CSS path in place, so this cannot block startup.
  initGpuCompositing().catch(err => {
    console.error('[GPU] Compositing init failed; staying on the CSS path:', err)
  })

  // Initialize no-signal detection (don't await - let it load in background)
  initNoSignalDetection().catch(err => {
    console.error('[Detection] Initialization error:', err)
  })

  // Render dropdown input lists and volume controls
  renderDropdownInputLists()
  renderDropdownVolumeControls()

  // Label the view-mode buttons and fill the Settings shortcut table from the
  // shared list (#258). After renderDropdownInputLists, which paints the rows
  // these sit alongside.
  renderShortcutHints()

  // Show cursor initially
  showCursor()

  console.log('Input Viewer ready')

}

// Start the app.
//
// Guarded so the module can be imported for unit tests without booting the
// whole app (device enumeration, streams, detection, screensavers). Nothing
// sets this flag in production, so the app starts exactly as before; the test
// harness sets it before importing.
if (!globalThis.__INPUT_VIEWER_NO_AUTOSTART__) {
  init()
}

// Exported for unit tests only. These are the state-transition functions the
// keyboard shortcuts and dropdown drive; production code calls them directly
// within this module.
export {
  state,
  elements,
  setLayout,
  // Exported so the key bindings themselves are testable. D and S were
  // documented in the README for a long time while never being wired to this
  // handler (#157) -- setLayout was covered by tests, but nothing asserted
  // that a keypress reached it.
  handleKeyDown,
  selectInput,
  toggleFreeze,
  getInputName,
  isInputEnabled,
  setInputName,
  toggleInputEnabled,
  getDefaultSettings,
  setCenterGap,
  setBorderWidth,
  startDetectionLoop,
  stopDetectionLoop,
  gpuFeedLayout,
  // Exported so the no-signal transition itself is testable (#248). Before the
  // flags existed, nothing in test/ drove showNoSignal/hideNoSignal at all --
  // the coverage stopped at compareFrames, one layer below the state change.
  showNoSignal,
  hideNoSignal,
  applyForcedNoSignal,
  updateDvdScreensaver,
  // Exported so the rendered hints are testable against the shared list (#258).
  renderShortcutHints,
  renderDropdownInputLists
}
