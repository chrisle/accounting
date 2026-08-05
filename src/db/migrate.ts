import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import { getDb } from './index'

/** Runs at boot from instrumentation.ts, and via `npm run db:migrate`. */
export function runMigrations(): void {
  migrate(getDb(), {
    migrationsFolder: path.join(process.cwd(), 'src/db/migrations'),
  })
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations()
  console.log('migrations applied')
}
