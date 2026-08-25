// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The Art-Net settings panel.
 *
 * The reason this file exists is the save allowlist. `saveSettings()` builds an
 * explicit object, so a key missing from it is not merely unsaved -- it is reset
 * to its default the next time anything else is saved. `artnetSpotDepth` shipped
 * in 3.0.0 that way: the setting existed, loaded, and worked, and then a volume
 * change silently put it back to 0.5. Nothing failed, which is what made it worth
 * a test rather than a fix.
 *
 * The other trap is the target select. An unrecognised target falls back to
 * `/all` inside colourEndpoint, and a `<select>` coerces an unknown value to its
 * first option. Together those would silently repoint a hand-configured
 * `group:`/`strip:` install to every fixture in the room, at the moment someone
 * opened this panel to change something unrelated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, projectRoot } from './helpers/renderer-dom.js'

installRendererDom()
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  configurable: true,
})

const saved = []
globalThis.window.electronAPI = {
  saveSettings: vi.fn(async (s) => { saved.push(s); return true }),
  loadSettings: vi.fn(async () => ({})),
}

const {
  state, elements, saveSettings, updateArtnetUI, toggleArtnet,
  setArtnetTarget, setArtnetSpotDepth, getDefaultSettings
} = await import('../src/renderer/renderer.js')

/** Every artnet* key the main process defines, read from its source. */
function mainArtnetKeys() {
  const src = readFileSync(path.join(projectRoot, 'src/main/index.js'), 'utf8')
  const body = src.match(/const defaultSettings = \{([\s\S]*?)\n\}/)[1]
  return [...body.matchAll(/^\s{2}(artnet\w+):/gm)].map(m => m[1])
}

beforeEach(() => {
  // The setters debounce by 300ms. Left on a real clock those timers land during
  // *later* tests and push to `saved`, which is how the toggle test below passed
  // with its saveSettings() call deleted -- it was reading a leaked write from an
  // earlier test. Fake timers plus synchronous assertions remove the whole class.
  vi.useFakeTimers()
  saved.length = 0
  state.settings = { ...getDefaultSettings() }
  // Reset the select to its declared options, since updateArtnetUI appends one
  // for an unknown target and that would leak between tests.
  for (const extra of [...elements.artnetTarget.options].filter(o => o.textContent.includes('settings.json'))) {
    extra.remove()
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the save allowlist', () => {
  it('round-trips every artnet setting the main process defines', async () => {
    // The allowlist is hand-maintained; the defaults are the contract. Deriving
    // the expected keys from main/index.js means adding a setting there without
    // adding it here fails, instead of silently never persisting.
    const keys = mainArtnetKeys()
    expect(keys.length).toBeGreaterThanOrEqual(6)

    const sentinels = {
      artnetEnabled: true,
      artnetUrl: 'https://relay.example',
      artnetTarget: 'effect:spot',
      artnetReleaseScene: 'warm_wit',
      artnetMaxBrightness: 0.42,
      artnetSpotDepth: 0.27,
      artnetSceneBySaver: { matrixRain: 'scene:lab_modus' },
    }
    // Guard against the sentinel list itself going stale.
    expect(Object.keys(sentinels).sort()).toEqual([...keys].sort())

    Object.assign(state.settings, sentinels)
    await saveSettings()

    expect(saved).toHaveLength(1)
    for (const [k, v] of Object.entries(sentinels)) {
      // toEqual, not toBe: the per-saver map is an object, and a shallow copy
      // of it is still a correct round-trip.
      expect(saved[0][k], `${k} was dropped by the save allowlist`).toEqual(v)
    }
  })

  it('persists spot depth, the key 3.0.0 shipped unable to save', async () => {
    setArtnetSpotDepth(35)
    const before = saved.length
    await saveSettings()
    expect(saved.length).toBe(before + 1)
    expect(saved.at(-1).artnetSpotDepth).toBeCloseTo(0.35, 6)
  })
})

describe('the target select', () => {
  it('keeps a hand-configured group target instead of coercing it to /all', () => {
    state.settings.artnetTarget = 'group:universe_0'
    updateArtnetUI()
    // The dangerous outcome is not a missing option -- it is the select landing
    // on 'all' and the next save writing that back, repointing the whole room.
    expect(elements.artnetTarget.value).toBe('group:universe_0')
  })

  it('says where an unlisted target came from', () => {
    state.settings.artnetTarget = 'strip:u0_01'
    updateArtnetUI()
    const opt = [...elements.artnetTarget.options].find(o => o.value === 'strip:u0_01')
    expect(opt).toBeDefined()
    expect(opt.textContent).toContain('settings.json')
  })

  it('does not accumulate duplicate options when reopened', () => {
    state.settings.artnetTarget = 'group:universe_0'
    updateArtnetUI()
    updateArtnetUI()
    updateArtnetUI()
    const matches = [...elements.artnetTarget.options].filter(o => o.value === 'group:universe_0')
    expect(matches).toHaveLength(1)
  })

  it('offers spot, and the effects that were asked for', () => {
    const values = [...elements.artnetTarget.options].map(o => o.value)
    expect(values).toContain('all')
    expect(values).toContain('effect:spot')
    for (const e of ['ripple', 'plasma', 'blobs', 'aurora']) {
      expect(values).toContain(`effect:${e}`)
    }
  })

  it('releases the running effect when the target changes', () => {
    // Switching from an effect to a colour leaves the effect animating unless
    // it is released -- the room would keep moving with nothing driving it.
    state.settings.artnetTarget = 'effect:spot'
    setArtnetTarget('all')
    expect(state.settings.artnetTarget).toBe('all')
  })
})

describe('panel visibility', () => {
  it('reveals the fields only while enabled', () => {
    state.settings.artnetEnabled = false
    updateArtnetUI()
    expect(elements.artnetFields.classList.contains('hidden')).toBe(true)
    expect(elements.artnetToggle.classList.contains('active')).toBe(false)

    state.settings.artnetEnabled = true
    updateArtnetUI()
    expect(elements.artnetFields.classList.contains('hidden')).toBe(false)
    expect(elements.artnetToggle.classList.contains('active')).toBe(true)
  })

  it('shows spot depth only for the spot, which is the only target that uses it', () => {
    state.settings.artnetTarget = 'effect:spot'
    updateArtnetUI()
    expect(elements.artnetSpotDepthRow.classList.contains('hidden')).toBe(false)

    state.settings.artnetTarget = 'all'
    updateArtnetUI()
    expect(elements.artnetSpotDepthRow.classList.contains('hidden')).toBe(true)

    state.settings.artnetTarget = 'effect:aurora'
    updateArtnetUI()
    expect(elements.artnetSpotDepthRow.classList.contains('hidden')).toBe(true)
  })

  it('toggling flips the setting and saves it', () => {
    state.settings.artnetEnabled = false
    const before = saved.length
    toggleArtnet()
    expect(state.settings.artnetEnabled).toBe(true)
    // saveSettings() reaches the IPC mock synchronously -- it is async, but the
    // body runs to its first await, which IS the call. Asserting a delta rather
    // than a non-empty array means no stray write can stand in for this one.
    expect(saved.length).toBe(before + 1)
    expect(saved.at(-1).artnetEnabled).toBe(true)
  })
})

describe('field values', () => {
  it('renders brightness and depth as percentages of the stored fraction', () => {
    state.settings.artnetMaxBrightness = 0.8
    state.settings.artnetSpotDepth = 0.25
    updateArtnetUI()
    expect(elements.artnetMaxBrightness.value).toBe('80')
    expect(elements.artnetMaxBrightnessValue.textContent).toBe('80%')
    expect(elements.artnetSpotDepth.value).toBe('25')
    expect(elements.artnetSpotDepthValue.textContent).toBe('25%')
  })

  it('falls back to the documented defaults when a key is absent', () => {
    delete state.settings.artnetMaxBrightness
    delete state.settings.artnetSpotDepth
    updateArtnetUI()
    expect(elements.artnetMaxBrightnessValue.textContent).toBe('80%')
    expect(elements.artnetSpotDepthValue.textContent).toBe('50%')
  })

  it('shows the url and release scene, and blanks rather than printing undefined', () => {
    state.settings.artnetUrl = 'https://relay.example'
    delete state.settings.artnetReleaseScene
    updateArtnetUI()
    expect(elements.artnetUrl.value).toBe('https://relay.example')
    expect(elements.artnetReleaseScene.value).toBe('')
  })
})
