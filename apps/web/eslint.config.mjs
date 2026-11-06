import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import { styleRulesAsWarnings } from '../../eslint.config.mjs'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  styleRulesAsWarnings,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
])
