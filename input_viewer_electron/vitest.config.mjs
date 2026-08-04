// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
import { defineConfig } from 'vite'

// Most tests are deliberately DOM-free and run in the default node
// environment. Only the renderer tests need a DOM, and they opt in per-file
// with `// @vitest-environment jsdom`, so the fast node path stays the default.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // A jsdom worker that fails to boot reports as an unhandled error rather
    // than a failing test, so the run would otherwise "pass" with those files
    // silently skipped. Keep the default strict behaviour explicit: if an
    // environment cannot start, the run must fail.
    dangerouslyIgnoreUnhandledErrors: false
  }
})
