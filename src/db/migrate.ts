import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import { getDb } from './index'
import { projects, UNALLOCATED } from './schema'

/** Runs at boot from instrumentation.ts, and via `npm run db:migrate`. */
export function runMigrations(): void {
  const db = getDb()
  migrate(db, {
    migrationsFolder: path.join(process.cwd(), 'src/db/migrations'),
  })

  // The reconciler books every unattributed amount to __unallocated__, and
  // allocations.project_id is a foreign key. That makes this a system row
  // rather than seed data: without it the first attribute pass on an empty
  // database dies with FOREIGN KEY constraint failed. Seeding also inserts it,
  // hence the conflict guard.
  db.insert(projects)
    .values({
      id: UNALLOCATED,
      name: 'Unallocated',
      synthetic: true,
      sortOrder: 99,
      color: '#8a8a80',
      colorDark: '#6f6f66',
    })
    .onConflictDoNothing()
    .run()
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations()
  console.log('migrations applied')
}
