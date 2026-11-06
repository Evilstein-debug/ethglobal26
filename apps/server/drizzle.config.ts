// drizzle-kit config: `pnpm db:generate` writes SQL migrations to ./drizzle from src/db/schema.ts.
// Docs: https://orm.drizzle.team/docs/drizzle-config-file
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
