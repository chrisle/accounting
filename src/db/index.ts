import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { dbPath, ensureDirs } from '@/lib/paths'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | null = null
let _raw: Database.Database | null = null

function connect() {
  ensureDirs()
  const sqlite = new Database(dbPath())
  // WAL so the worker writing a sync doesn't block you reading the dashboard.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')
  _raw = sqlite
  return drizzle(sqlite, { schema })
}

/** Single connection for the whole process — Next hot-reload safe. */
export function getDb(): Db {
  if (!_db) {
    const g = globalThis as unknown as { __costsDb?: Db }
    _db = g.__costsDb ?? connect()
    g.__costsDb = _db
  }
  return _db
}

export function getRaw(): Database.Database {
  getDb()
  return _raw!
}

/** Lazy so importing the schema never opens a file handle at module load. */
export const db = new Proxy({} as Db, {
  get: (_t, prop) => Reflect.get(getDb() as object, prop),
})

export { schema }
export * from './schema'
