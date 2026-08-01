import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    // email-worker/ is excluded here (not just additively overridden below)
    // — flat-config globals MERGE across matching blocks, so a bare `files`
    // match on email-worker/**/*.js would still leave it holding the full
    // globals.browser set (document, window, ...) on top of its own minimal
    // one. `ignores` is what actually keeps browser globals out.
    ignores: ['email-worker/**'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Server-side modules, the local dev server, the Vercel handlers, and their
  // tests run in Node, not the browser — give them Node globals so process,
  // Buffer, etc. are defined. (Additive: merges on top of the browser block.)
  {
    files: ['lib/**/*.js', 'server.js', 'api/**/*.{js,mjs}', 'vitest.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  // email-worker/ runs in the Cloudflare Workers runtime, not Node or the
  // browser. Excluded from the browser block above via `ignores`, so this is
  // its ONLY global set — fetch/Response for the fetch-and-forward flow,
  // console for logging — rather than an addition on top of globals.browser.
  // js.configs.recommended is applied here too (not just globals) so no-undef
  // still catches a stray `document`/`window` reference as a real lint error
  // instead of silently resolving against a global that shouldn't be there.
  {
    files: ['email-worker/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { fetch: 'readonly', Response: 'readonly', console: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
