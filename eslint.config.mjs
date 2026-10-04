// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '*.index.json',
      'index.json',
      // Standalone .mjs diagnostics, outside the TS program.
      'scripts/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The CLI layer legitimately throws plain Errors with template messages.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      // `catch (error) { throw new Error(shortMessage(error)) }` is the
      // intended pattern for surfacing viem RPC errors.
      '@typescript-eslint/no-base-to-string': 'off',
      // Records are keyed by ENS label; `noUncheckedIndexedAccess` already
      // makes these accesses explicit.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Test doubles return a stubbed Response; an `async` arrow that never
      // awaits is the clearest way to express "resolves to this fixture".
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Browser code. Not part of tsconfig.json (it has no Node types and runs
    // unbundled in the browser), so typed linting gets no project here — it is
    // checked with the plain recommended JS rules instead.
    files: ['web/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // No `project`: this code is not in tsconfig.json, and a typed project it
      // cannot resolve would be a parse error rather than a lint finding.
      parserOptions: { project: null, projectService: false },
      globals: { document: 'readonly', fetch: 'readonly', console: 'readonly' },
    },
    rules: {
      // The front end builds DOM nodes with a tiny `el()` helper; a long chain of
      // appendChild calls is clearer than a template string when every value is
      // untrusted and must go through textContent.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // Build config, not application code — it is not in tsconfig.json, so typed
    // linting has no project to resolve against.
    ignores: ['eslint.config.mjs'],
  },
)
