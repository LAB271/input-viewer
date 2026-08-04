// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
import js from '@eslint/js'
import globals from 'globals'

// The project spans three environments with different module systems and
// globals, so they are configured separately rather than with one permissive
// blanket that would miss real mistakes in each:
//
//   src/main, src/preload  CommonJS, Node globals (Electron main + bridge)
//   src/renderer           ESM, browser globals (+ WebGL2, canvas)
//   scripts, test          ESM, Node globals
//
// Intent is correctness over style: this catches genuine mistakes (unused
// variables, undefined identifiers, accidental globals) and deliberately does
// not enforce formatting, so it does not churn 5,700 existing lines or fight
// the current hand-formatting.
export default [
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**'],
  },

  // Electron main process and preload bridge: CommonJS, Node globals.
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    ...js.configs.recommended,
  },

  // Renderer: ESM running in Chromium. Browser globals cover the DOM, canvas
  // and WebGL2 APIs the screensavers and detection use.
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    ...js.configs.recommended,
  },

  // Build/dev scripts and the test suite: ESM on Node.
  {
    files: ['scripts/**/*.{js,mjs}', 'test/**/*.{js,mjs}', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    ...js.configs.recommended,
  },

  // Tests also see vitest's injected globals via the imports they make, but
  // renderer tests run under jsdom and touch browser globals directly.
  {
    files: ['test/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // A few rules beyond recommended that catch real hazards in this codebase
  // rather than styling it.
  {
    files: ['src/**/*.js', 'scripts/**/*.{js,mjs}', 'test/**/*.{js,mjs}'],
    rules: {
      // Both evaluate strings as code. There is one deliberate, commented use
      // in the tests (parsing a literal out of main/index.js); anywhere else
      // it should have to be justified explicitly.
      'no-new-func': 'error',
      'no-eval': 'error',
      // Easy to introduce when hand-editing shader strings and GL setup.
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      // `==` against null/undefined is idiomatic; everywhere else it hides bugs.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
]
