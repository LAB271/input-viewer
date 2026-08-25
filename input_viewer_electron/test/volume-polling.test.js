// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * System-volume polling runs only while the dropdown is open.
 *
 * It used to run every 2 seconds for the life of the app. On Windows each poll spawns
 * PowerShell and calls `Add-Type -TypeDefinition`, compiling C# at runtime to reach
 * the audio API -- so the videowall started a process and ran a compiler every 2
 * seconds, forever, to update a slider nobody could see.
 *
 * syncSystemVolume's whole body writes to the dropdown slider and its label. Nothing
 * else reads the value, which is what makes scoping it to visibility correct rather
 * than merely cheaper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, projectRoot } from './helpers/renderer-dom.js'

installRendererDom()

const fakeTrack = () => ({
  stop: vi.fn(),
  getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
  getCapabilities: () => ({
    width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 }
  })
})
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [fakeTrack()],
      getVideoTracks: () => [fakeTrack()],
      getAudioTracks: () => [],
    })),
    enumerateDevices: vi.fn(async () => []),
  },
  configurable: true,
})

const { startVolumePolling, stopVolumePolling, volumePollingActive } =
  await import('../src/renderer/renderer.js')

const RENDERER = readFileSync(
  path.resolve(projectRoot, 'src/renderer/renderer.js'), 'utf8')

beforeEach(() => {
  vi.useFakeTimers()
  globalThis.window.electronAPI = { getSystemVolume: vi.fn(async () => 50) }
  stopVolumePolling()
})

afterEach(() => {
  stopVolumePolling()
  vi.useRealTimers()
  delete globalThis.window.electronAPI
})

describe('polling follows visibility', () => {
  it('is off at rest', () => {
    // The state the wall is in essentially all the time.
    expect(volumePollingActive()).toBe(false)
  })

  it('starts when the dropdown opens', () => {
    startVolumePolling()
    expect(volumePollingActive()).toBe(true)
  })

  it('stops when it closes', () => {
    startVolumePolling()
    stopVolumePolling()
    expect(volumePollingActive()).toBe(false)
  })

  it('does not stack on repeated opens', () => {
    // Both hover listeners fire when moving trigger -> panel, and the touch path can
    // fire again. Stacking would multiply the process spawns rather than remove them.
    const spy = vi.spyOn(globalThis, 'setInterval')
    startVolumePolling()
    startVolumePolling()
    startVolumePolling()
    expect(spy.mock.calls.length).toBe(1)
    spy.mockRestore()
  })

  it('polls on the interval while open', () => {
    startVolumePolling()
    // One immediate read on open, so the slider is not stale for the first tick.
    expect(window.electronAPI.getSystemVolume).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(window.electronAPI.getSystemVolume).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(4000)
    expect(window.electronAPI.getSystemVolume).toHaveBeenCalledTimes(4)
  })

  it('stops polling entirely once closed', () => {
    startVolumePolling()
    stopVolumePolling()
    window.electronAPI.getSystemVolume.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(window.electronAPI.getSystemVolume).not.toHaveBeenCalled()
  })

  it('auto-stops if a close event never arrives', () => {
    // The hover gap: entering the trigger and leaving without crossing the panel
    // produces no mouseleave. Without this net a missed stop polls forever, which is
    // the bug in a new costume.
    startVolumePolling()
    vi.advanceTimersByTime(31_000)
    expect(volumePollingActive()).toBe(false)
  })

  it('a re-open extends the window rather than expiring on the old deadline', () => {
    startVolumePolling()
    vi.advanceTimersByTime(20_000)
    startVolumePolling()          // still interacting
    vi.advanceTimersByTime(20_000) // 40s total, but only 20s since the last open
    expect(volumePollingActive()).toBe(true)
  })
})

describe('nothing polls it unconditionally any more', () => {
  it('has no app-lifetime interval on syncSystemVolume', () => {
    // The specific line removed: setInterval(syncSystemVolume, 2000) in init.
    //
    // Scoped to init rather than the whole file: startVolumePolling legitimately
    // calls setInterval(syncSystemVolume, ...), and asserting against the file
    // matched that too -- the first version of this test failed on the fix.
    const init = RENDERER.slice(RENDERER.indexOf('async function init()'))
    expect(init).not.toMatch(/setInterval\(\s*syncSystemVolume/)
    // And exactly one such interval exists anywhere: the scoped one.
    expect([...RENDERER.matchAll(/setInterval\(\s*syncSystemVolume/g)]).toHaveLength(1)
  })

  it('still reads it once at startup, so the first open is not stale', () => {
    const init = RENDERER.slice(RENDERER.indexOf('async function init()'))
    expect(init).toMatch(/\n\s*syncSystemVolume\(\)/)
  })

  it('is wired to both ways the dropdown opens', () => {
    // Hover is pure CSS for visibility, so the mouseenter listeners are the only JS
    // signal; touch goes through toggleDropdown.
    expect(RENDERER).toMatch(/dropdownTrigger\.addEventListener\('mouseenter'[\s\S]{0,400}startVolumePolling\(\)/)
    expect(RENDERER).toMatch(/dropdownPanel\.addEventListener\('mouseenter'[\s\S]{0,400}startVolumePolling\(\)/)
    const toggle = RENDERER.slice(RENDERER.indexOf('function toggleDropdown()'))
    expect(toggle.slice(0, 400)).toContain('startVolumePolling()')
  })

  it('is wired to both ways it closes', () => {
    expect(RENDERER).toMatch(/dropdownPanel\.addEventListener\('mouseleave'[\s\S]{0,300}stopVolumePolling\(\)/)
    const close = RENDERER.slice(RENDERER.indexOf('function closeDropdown()'))
    expect(close.slice(0, 300)).toContain('stopVolumePolling()')
  })
})
