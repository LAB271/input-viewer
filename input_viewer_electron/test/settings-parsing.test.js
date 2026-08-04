// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Settings parsing/validation.
 *
 * The main process merges a loaded settings.json over its own defaults and
 * hands the result to the renderer, which uses it as-is. These tests pin the
 * defaults both sides agree on, and the behaviour of the input-lookup helpers
 * when a settings file is partial, malformed or hand-edited -- the cases a
 * real settings.json accumulates over 38 releases.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, projectRoot } from './helpers/renderer-dom.js'

installRendererDom()
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  configurable: true,
})

const { state, getInputName, isInputEnabled, getDefaultSettings } =
  await import('../src/renderer/renderer.js')

/** Reproduces the main process's merge: defaults, overlaid with file content. */
function mainProcessMerge(fileContents) {
  // Mirrors loadSettings() in src/main/index.js.
  const defaults = mainDefaults()
  try {
    return { ...defaults, ...JSON.parse(fileContents) }
  } catch {
    return { ...defaults }
  }
}

/**
 * The main process's defaultSettings, read from its source rather than
 * duplicated here, so this test cannot drift from the real defaults.
 * main/index.js is CommonJS and requires electron at module scope, so it
 * cannot simply be imported.
 */
function mainDefaults() {
  const src = readFileSync(path.join(projectRoot, 'src/main/index.js'), 'utf8')
  const body = src.match(/const defaultSettings = \{([\s\S]*?)\n\}/)[1]
  // The literal contains only primitives and {}, so evaluating it is safe.
  // The closing brace goes on its own line: the last entry carries a trailing
  // `//` comment, which would otherwise swallow it.
  // eslint-disable-next-line no-new-func
  return new Function(`return {${body}\n}`)()
}

beforeEach(() => {
  state.settings = { ...getDefaultSettings() }
})

describe('main-process settings merge', () => {
  it('returns defaults for a missing file', () => {
    const merged = mainProcessMerge('this is not json')
    expect(merged.inputs).toEqual({})
    expect(merged.layoutMode).toBe('dual')
  })

  it('survives malformed JSON without throwing', () => {
    expect(() => mainProcessMerge('{ "inputs": ')).not.toThrow()
    expect(mainProcessMerge('{ "inputs": ').inputs).toEqual({})
  })

  it('backfills keys a partial file omits', () => {
    const merged = mainProcessMerge(JSON.stringify({ layoutMode: 'single' }))
    expect(merged.layoutMode).toBe('single')
    expect(merged.inputs).toEqual({})
    expect(merged.leftDeviceId).toBe(null)
  })

  it('lets the file override every default it names', () => {
    const merged = mainProcessMerge(JSON.stringify({
      leftDeviceId: 'cam1', rightDeviceId: 'cam2', layoutMode: 'single',
    }))
    expect(merged.leftDeviceId).toBe('cam1')
    expect(merged.rightDeviceId).toBe('cam2')
  })

  it('does not deep-merge inputs: a partial entry replaces the default wholesale', () => {
    // Documents current behaviour. The merge is shallow, so an entry missing
    // `enabled` stays missing -- which is why isInputEnabled has to tolerate
    // absent/invalid values rather than assume the field is present.
    const merged = mainProcessMerge(JSON.stringify({ inputs: { cam1: { name: 'Laptop' } } }))
    expect(merged.inputs.cam1).toEqual({ name: 'Laptop' })
    expect(merged.inputs.cam1.enabled).toBeUndefined()
  })
})

describe('renderer defaults vs main-process defaults', () => {
  it('main provides every key it claims to', () => {
    const d = mainDefaults()
    for (const k of ['leftDeviceId', 'rightDeviceId', 'layoutMode', 'inputs']) {
      expect(d, k).toHaveProperty(k)
    }
  })

  it('renderer defaults cover the keys the renderer actually reads', () => {
    // These are read directly off state.settings in renderer.js, so a missing
    // default surfaces as `undefined` in the UI rather than a sane value.
    const d = getDefaultSettings()
    for (const k of ['inputs', 'centerGap', 'borderWidth', 'leftVolume',
      'rightVolume', 'systemVolume', 'defaultInputId']) {
      expect(d, k).toHaveProperty(k)
    }
  })

  it('documents that the two default sets are not identical', () => {
    // The main process backfills only its own keys, so renderer-only keys
    // (centerGap, volumes, remote-keyboard settings) arrive undefined from a
    // real load and the renderer must tolerate that. Captured deliberately:
    // if the two are ever unified, this test should be updated, not deleted.
    const mainKeys = Object.keys(mainDefaults())
    const rendererKeys = Object.keys(getDefaultSettings())
    const rendererOnly = rendererKeys.filter(k => !mainKeys.includes(k))
    expect(rendererOnly.length).toBeGreaterThan(0)
    expect(rendererOnly).toContain('centerGap')
  })
})

describe('input settings lookups tolerate a hand-edited settings.json', () => {
  it('handles an entry that is null', () => {
    state.settings.inputs = { cam1: null }
    expect(() => isInputEnabled('cam1')).not.toThrow()
    expect(isInputEnabled('cam1')).toBe(true)
    expect(getInputName('cam1', 'Input 1')).toBe('Input 1')
  })

  it('handles an entry missing the enabled field', () => {
    state.settings.inputs = { cam1: { name: 'Laptop' } }
    expect(isInputEnabled('cam1')).toBe(true)
    expect(getInputName('cam1', 'Input 1')).toBe('Laptop')
  })

  it('handles a numeric enabled (0/1 rather than boolean)', () => {
    state.settings.inputs = { cam1: { enabled: 0 } }
    // Only a real boolean false disables; anything else defaults to enabled.
    expect(isInputEnabled('cam1')).toBe(true)
  })

  it('handles a non-string name', () => {
    state.settings.inputs = { cam1: { name: 42, enabled: true } }
    expect(getInputName('cam1', 'Input 1')).toBe(42)
  })

  it('handles an empty inputs object', () => {
    state.settings.inputs = {}
    expect(isInputEnabled('anything')).toBe(true)
    expect(getInputName('anything', 'Input 3')).toBe('Input 3')
  })
})
