import type { Config } from 'drizzle-kit'
import { dbPath } from './src/lib/paths'

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath() },
} satisfies Config
