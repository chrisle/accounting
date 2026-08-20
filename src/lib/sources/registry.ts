import { amazonAdapter } from './amazon'
import { copilotAdapter } from './copilot'
import { gcpAdapter } from './gcp'
import { passthroughAdapter } from './passthrough'
import { paypalAdapter } from './paypal'
import type { BreakoutAdapter } from './types'

/** Order matters only for `claims()` — first match wins. */
export const ADAPTERS: BreakoutAdapter[] = [gcpAdapter, amazonAdapter, paypalAdapter]

/** Sources the user connects and syncs, shown on the Sources page. */
export const SYNCABLE: BreakoutAdapter[] = [copilotAdapter, gcpAdapter, amazonAdapter, paypalAdapter]

export const byId = (id: string): BreakoutAdapter | undefined =>
  [...SYNCABLE, passthroughAdapter].find((a) => a.id === id)

/** Which adapter, if any, should break this charge out? */
export function adapterFor(txn: Parameters<BreakoutAdapter['claims']>[0]): BreakoutAdapter {
  return ADAPTERS.find((a) => a.claims(txn)) ?? passthroughAdapter
}

export { passthroughAdapter, copilotAdapter, gcpAdapter, amazonAdapter, paypalAdapter }
export type { BreakoutAdapter }
