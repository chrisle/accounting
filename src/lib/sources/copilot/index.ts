import type { BreakoutAdapter } from '../types'
import { fetchTransactions } from './client'
import { isConnected } from './auth'

/**
 * Copilot is the ledger, not a breakout source: it tells us money moved, never
 * what it bought. It claims no charges — every transaction it produces is
 * offered to the other adapters, and falls through to passthrough if none bite.
 */
export const copilotAdapter: BreakoutAdapter = {
  id: 'copilot',
  label: 'Copilot Money',
  archetype: 'passthrough',
  connect: 'credentials',
  claims: () => false,
  fetchTransactions,
  allocate: () => [],
}

export { isConnected }
