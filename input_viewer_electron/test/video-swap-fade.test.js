// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The input-switch fade shares the opacity property with freeze, and the two
 * invariants that keep them from fighting are easy to remove while tidying.
 *
 * `toggleFreeze()` sets `video.style.opacity` INLINE -- '0' to hide the live feed
 * behind the frozen frame, '1' to restore it. That collides twice, and both were
 * verified live in a browser before being pinned here:
 *
 *   - Without `!important` on `.swapping`, the inline style wins and one
 *     freeze/unfreeze cycle silently disables the fade for the rest of the session.
 *   - With the transition on the BASE `video` rule instead of on `.swapping`, freeze
 *     animates too, and you watch the live feed dissolve into the frozen frame.
 *
 * Asserted against the stylesheet text because there is no DOM here -- the check is
 * that the declarations stay where they are, which is exactly what a refactor moves.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const CSS = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8')

/**
 * The bodies of EVERY rule with this exact selector, concatenated.
 *
 * Not just the first: `.video-feed` legitimately appears twice -- the original
 * layout rule and a separate one holding the transition next to the .collapsed
 * state it belongs with. Matching only the first found the layout rule and reported
 * the transition missing when it was two rules further down.
 */
function ruleBody (selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  const bodies = [...CSS.matchAll(re)].map(m => m[1])
  expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
  return bodies.join('\n')
}

describe('the input-switch fade coexists with freeze', () => {
  it('marks the swap opacity !important, to beat freeze inline styles', () => {
    const body = ruleBody('.video-feed video.swapping')
    expect(body).toMatch(/opacity:\s*0\s*!important/)
  })

  it('declares the transition on .swapping, not on the base video rule', () => {
    // On the base rule this would animate freeze, which must be instant.
    expect(ruleBody('.video-feed video.swapping')).toMatch(/transition:\s*opacity/)
    expect(ruleBody('.video-feed video')).not.toMatch(/transition/)
  })

  it('honours prefers-reduced-motion for the swap', () => {
    expect(CSS).toMatch(/prefers-reduced-motion[\s\S]*?\.video-feed video\.swapping[\s\S]*?transition:\s*none/)
  })

  it('still animates the layout transition on the feed containers', () => {
    // The other half of #247, and it belongs on the container rather than the video.
    expect(ruleBody('.video-feed')).toMatch(/transition:\s*flex-grow/)
    expect(ruleBody('.video-feed.collapsed')).toMatch(/flex-grow:\s*0/)
  })
})
