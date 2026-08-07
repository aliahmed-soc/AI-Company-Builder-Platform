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
      // Agent-tool git worktrees: each is a full checkout of ANOTHER branch nested inside this one, so linting
      // them reports that branch's diagnostics against this branch — and the volume exhausts the default V8 heap
      // (ACBP-P7-007 hit 30,288 errors and an OOM with three worktrees present). Every other checker in
      // `check:static` takes an explicit root list and never saw this; ESLint is the only one that walks from the
      // repository root. CI checks out a bare tree, so it is unaffected either way.
      '**/.claude/worktrees/**',
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
