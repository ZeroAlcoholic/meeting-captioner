import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      '**/dist-mobile/**',
      'build/**',
      // Local service snapshots and Python caches are generated artifacts.
      '.cache/**',
      // Project scratch space (E2E run directories hold bundled workers).
      '.tmp/**',
      '**/.pytest_cache/**',
      // Packaged distribution output (scripts/package-online.*). A gitignored
      // build artifact containing a minified single-file bundle — never source
      // to lint, same as dist/build above.
      'release/**',
      '**/release/**',
      'coverage/**',
      '.venv/**',
      '**/.venv/**',
      'services/offline/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: [
      'scripts/*.mjs',
      'services/online/build-bundle.mjs',
      'tests/architecture/*.mjs',
      'tests/e2e/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // zod schema + inferred type intentionally share a name; both ESLint
      // base rule and the TS-aware variant flag this — turn both off.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'off',
      // Disable the base no-undef for TS: TypeScript's own compiler already
      // reports undefined identifiers far more accurately, and no-undef
      // false-positives on type-only references (e.g. `as RequestInit`,
      // `MediaTrackConstraints`) that erase at compile time. This is the
      // typescript-eslint recommended configuration.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // AudioWorklet processors run in AudioWorkletGlobalScope, which provides
    // these globals (not part of the browser/window env ESLint knows about).
    files: ['**/pcm-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly',
      },
    },
  },
];
