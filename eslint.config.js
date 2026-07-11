import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
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
])
