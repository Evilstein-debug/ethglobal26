// Minimal shared ESLint config: typescript-eslint recommended. apps/web adds eslint-config-next.
// Style-only rules are warnings so they never block anyone; formatting is Prettier's job.
import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export const styleRulesAsWarnings = {
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': 'warn',
    'prefer-const': 'warn',
    'no-empty': 'warn',
  },
}

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    'apps/web/**',
    'packages/contracts/**',
    'packages/shared/src/generated.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  styleRulesAsWarnings,
])
