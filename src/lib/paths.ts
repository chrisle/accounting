import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Single source of truth for where state lives.
 *
 * Local dev  -> ./data
 * Container  -> /data  (bind-mounted from a ZFS dataset on the Proxmox host)
 *
 * Everything under here sorts into two kinds:
 *   precious    raw/  config/     cannot be recreated; back this up
 *   derived     costs.db  cache/  rebuildable from the above at any time
 */
export function dataDir(): string {
  return path.resolve(process.env.COSTS_DATA_DIR || './data')
}

export const dbPath = () => path.join(dataDir(), 'costs.db')

/** Uploaded source documents, kept forever. Amazon ZIPs take 24h to re-request. */
export const rawDir = () => path.join(dataDir(), 'raw')

/** YAML exports of rules/overrides so your categorisation decisions stay diffable. */
export const configDir = () => path.join(dataDir(), 'config')

/** Disposable. Safe to `tmutil addexclusion` / exclude from backups. */
export const cacheDir = () => path.join(dataDir(), 'cache')

export const logDir = () => path.join(dataDir(), 'state', 'logs')

export function ensureDirs(): void {
  for (const d of [dataDir(), rawDir(), configDir(), cacheDir(), logDir()]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
  }
}
