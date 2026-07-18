// ACBP-P0-013 — ESLint flat config (correctness-focused static analysis).
// Type-aware rules for workspace TypeScript; plain Node rules for tooling scripts.
// No framework-specific (React/web) plugins until a web framework is scaffolded.
// Import-direction/boundary discipline is owned by tools/check-boundaries.mjs, not ESLint.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/next-env.d.ts', // Next.js-generated, gitignored, and excluded from tsconfig (ACBP-P1-001).
      'docs/**',
      'evidence/**',
      'tooling/**',
      '**/*.json',
      'pnpm-lock.yaml',
    ],
  },

  // Workspace TypeScript: type-aware correctness rules.
  {
    files: ['apps/**/*.{ts,tsx,mts,cts}', 'packages/**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  // Node tooling scripts (checker, secret scanner, tests): plain JS, not type-checked.
  {
    files: ['**/*.mjs', '**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
