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
  initScreensavers,
  startScreensaver,
  stopScreensaver,
  isScreensaverRunning
} from './screensavers/registry.js'

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
  // DVD screensaver timer
  dvdScreensaverTimeout: null,
  // dvdScreensaverDelay: 10 * 1000, // 10 seconds in milliseconds
  dvdScreensaverDelay: 5 * 60 * 1000, // 5 minutes in milliseconds
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
  presenterDebugEnabled: false
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
        inputs: state.settings.inputs,
        initialSetupComplete: state.settings.initialSetupComplete,
        noSignalReferences: state.settings.noSignalReferences
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
    presenterDebugEnabled: false
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
// Video Device Management
// =============================================================================

async function getVideoDevices() {
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
    
    if (!deviceId) {
      showNoSignal(side)
      return null
    }
    
    // Check if device is enabled
    if (!isInputEnabled(deviceId)) {
      showNoSignal(side)
      return null
    }
    
    // Request highest resolution the device supports, with audio
    const constraints = {
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 4096 },
        height: { ideal: 2160 },
        frameRate: { ideal: 60 }
      },
      audio: {
        deviceId: { exact: deviceId }
      }
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch {
      // If audio fails (device doesn't support audio), try video only
      console.log(`[Video] Audio not available for device, falling back to video only`)
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
    const caps = track.getCapabilities()
    console.log(`[Video] ${side} stream: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`)
    console.log(`[Video] ${side} capabilities: ${caps.width?.max}x${caps.height?.max} @ ${caps.frameRate?.max}fps`)

    // Some capture cards start at low default resolution and need a retry.
    // Cap target at 1920x1080 to prefer uncompressed formats over MJPEG.
    if (settings.width <= 640 && caps.width?.max > 640) {
      const targetWidth = Math.min(caps.width.max, 1920)
      const targetHeight = Math.min(caps.height.max, 1080)
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

function showNoSignal(side) {
  const feed = side === 'left' ? elements.leftFeed : elements.rightFeed
  const overlay = feed.querySelector('.no-signal-overlay')
  overlay.classList.remove('hidden')
  state.noSignalState[side] = true
}

function hideNoSignal(side) {
  const feed = side === 'left' ? elements.leftFeed : elements.rightFeed
  const overlay = feed.querySelector('.no-signal-overlay')
  overlay.classList.add('hidden')
  state.noSignalState[side] = false
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
}

/**
 * Hide the DVD screensaver overlay
 */
function hideDvdScreensaver() {
  stopScreensaver()
  elements.dvdOverlay.classList.add('hidden')
  console.log('[Screensaver] Deactivated')
}

// =============================================================================
// Layout Management
// =============================================================================

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

  switch (mode) {
    case 'dual':
      document.body.classList.remove('single-view')
      elements.leftFeed.classList.remove('hidden', 'single')
      elements.rightFeed.classList.remove('hidden', 'single')
      elements.centerDivider.classList.remove('hidden', 'overlay')
      elements.bottomLogo.classList.add('hidden')
      break
    case 'single':
      document.body.classList.add('single-view')
      elements.leftFeed.classList.remove('hidden')
      elements.leftFeed.classList.add('single')
      elements.rightFeed.classList.add('hidden')
      // Hide center divider and bottom logo in single view - video fills screen
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

    // Left column option
    const leftOption = document.createElement('div')
    leftOption.className = `input-option${isLeftActive ? ' selected' : ''}`
    leftOption.textContent = customName
    leftOption.addEventListener('click', () => {
      selectInputForSide(device.deviceId, 'left')
    })
    elements.leftInputList.appendChild(leftOption)

    // Right column option
    const rightOption = document.createElement('div')
    rightOption.className = `input-option${isRightActive ? ' selected' : ''}`
    rightOption.textContent = customName
    rightOption.addEventListener('click', () => {
      selectInputForSide(device.deviceId, 'right')
    })
    elements.rightInputList.appendChild(rightOption)

    // Single mode option
    const singleOption = document.createElement('div')
    singleOption.className = `single-input-option${isLeftActive ? ' selected' : ''}`
    singleOption.textContent = customName
    singleOption.addEventListener('click', () => {
      selectInputForSide(device.deviceId, 'left')
    })
    elements.singleInputList.appendChild(singleOption)
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

  if (side === 'left') {
    state.leftDeviceId = deviceId
    await startVideoStream(deviceId, elements.leftVideo, 'left')
  } else {
    state.rightDeviceId = deviceId
    await startVideoStream(deviceId, elements.rightVideo, 'right')
  }

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

  state.devices.forEach((device, index) => {
    const isEnabled = isInputEnabled(device.deviceId)
    const customName = getInputName(device.deviceId, device.label || `Input ${index + 1}`)
    const isDefault = state.defaultInputId === device.deviceId

    const row = document.createElement('div')
    row.className = 'input-name-row'

    row.innerHTML = `
      <span class="input-number">${index + 1}</span>
      <div class="toggle-switch ${isEnabled ? 'active' : ''}" data-device-id="${device.deviceId}"></div>
      <input type="text" class="input-name-field" value="${customName}" data-device-id="${device.deviceId}" />
      <button class="default-btn${isDefault ? ' active' : ''}" data-device-id="${device.deviceId}">Default</button>
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
  })
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

function handleKeyDown(event) {
  // Don't handle if typing in an input
  if (event.target.tagName === 'INPUT') return

  console.log(`[Key] pressed: "${event.key}" (code: ${event.code})`)

  switch (event.key.toLowerCase()) {
    case ' ': // Space bar - Freeze frame
      event.preventDefault()
      toggleFreeze()
      break
    case '1':
    case '2':
    case '3':
    case '4':
      selectInput(parseInt(event.key) - 1)
      break
    case 'f':
    case 'f11':
      event.preventDefault()
      window.electronAPI.toggleFullscreen()
      break
    case 'escape':
      closeAllPanels()
      if (state.frozen) {
        toggleFreeze() // Unfreeze on escape
      }
      window.electronAPI.isFullscreen().then(isFs => {
        if (isFs) window.electronAPI.toggleFullscreen()
      })
      break
    case 'q':
      window.electronAPI.quitApp()
      break
    case 'pageup':
    case 'arrowleft':
      sendRemoteKeypress('left')
      break
    case 'pagedown':
    case 'arrowright':
      sendRemoteKeypress('right')
      break
  }
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
function startDetectionLoop() {
  if (state.detectionRunning) return
  state.detectionRunning = true

  let lastRun = 0
  let running = false

  const supportsRvfc = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
  console.log(`[Detection] Loop paced by ${supportsRvfc ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

  async function runDetection() {
    const devicesToCheck = getUniqueActiveDevices()

    for (const { deviceId, video, side } of devicesToCheck) {
      if (!video.srcObject || video.readyState < 2) continue
      if (!isDetectionReady(deviceId)) continue

      const source = getFrameSource(deviceId, video)
      if (!source) continue

      const isNoSignal = await checkNoSignalFromSource(deviceId, source)

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
    if (!state.detectionRunning) return

    const t = typeof now === 'number' ? now : performance.now()
    // `running` guards re-entry: detection is async and a slow cycle must not
    // overlap itself, or two passes would race on the same device state.
    if (!running && !state.frozen && t - lastRun >= DETECT_INTERVAL_MS) {
      lastRun = t
      running = true
      runDetection()
        .catch(err => console.error('[Detection] Cycle failed:', err))
        .finally(() => { running = false })
    }

    schedule()
  }

  function schedule() {
    if (!state.detectionRunning) return

    if (supportsRvfc) {
      // Pace from whichever active video is playing; the left feed is always
      // present in both layouts, so prefer it and fall back to the right.
      for (const video of [elements.leftVideo, elements.rightVideo]) {
        if (video?.srcObject && !video.paused) {
          video.requestVideoFrameCallback(tick)
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

  // Initialize screensaver registry (random screensaver chosen on activation)
  initScreensavers(elements.screensaverCanvas)

  // Initialize no-signal detection (don't await - let it load in background)
  initNoSignalDetection().catch(err => {
    console.error('[Detection] Initialization error:', err)
  })

  // Render dropdown input lists and volume controls
  renderDropdownInputLists()
  renderDropdownVolumeControls()

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
  stopDetectionLoop
}
