/**
 * Parmesan — silent background monitor for pending Boltz chain swaps.
 *
 * Temporary solution: polls Boltz every POLL_INTERVAL_MS while the engine is
 * running, updates the disklet record, and calls the provided callbacks so the
 * GUI can surface a toast / banner / perform the RBTC claim.
 *
 * For BTC→RBTC, after Boltz locks RBTC (`transaction.server.confirmed`) the
 * client MUST call EtherSwap.claim with the stored preimage. That claim is
 * orchestrated by the GUI (needs the RSK wallet); this monitor only flips
 * disklet status to `rbtc_claim_ready`.
 */

import { Disklet } from 'disklet'

import {
  BOLTZ_SERVER_LOCK_READY_STATES,
  getBoltzSwapStatus
} from './boltzChainSwap'

const POLL_INTERVAL_MS = 60_000 // 1 minute
const BOLTZ_FILE_PREFIX = 'parmesan-boltz-'

/** States Boltz uses in GET /v2/swap/{id} after a successful claim path. */
const CLAIMED_STATES = new Set([
  'transaction.claimed',
  'invoice.settled',
  'transaction.claim.pending'
])
const FAILED_STATES = new Set([
  'swap.expired',
  'transaction.refunded',
  'invoice.failedToPay'
])

export interface ParmesanSwapRecord {
  id: string
  direction: 'btc_rbtc' | 'rbtc_btc'
  status: string
  preimage?: string
  preimageHash?: string
  claimAddress?: string
  claimPriv?: string
  claimPub?: string
  /** RBTC claim amount in wei (from Boltz server lock). */
  claimAmountWei?: string
  /** Boltz refundAddress on the EtherSwap lock. */
  refundAddress?: string
  /** EtherSwap timelock (block height). */
  timelock?: number
  /** RSK lock txid once Boltz broadcasts server lock. */
  serverLockTxid?: string
  to?: string
  amount?: string | number
  created?: unknown
  lockTxid?: string
}

export interface SwapMonitorCallbacks {
  /** Called when Boltz confirms the swap completed (claimed on destination). */
  onSwapCompleted: (swap: ParmesanSwapRecord) => void
  /** Called when the swap timed out and a refund is needed. */
  onSwapRefundNeeded: (swap: ParmesanSwapRecord) => void
  /** BTC→RBTC: Boltz locked RBTC; GUI must EtherSwap.claim with preimage. */
  onSwapReadyToClaimRbtc?: (swap: ParmesanSwapRecord) => void
}

async function listPendingSwaps(
  disklet: Disklet
): Promise<ParmesanSwapRecord[]> {
  const list = await disklet.list('').catch(() => ({}))
  const pending: ParmesanSwapRecord[] = []
  for (const name of Object.keys(list)) {
    if (!name.startsWith(BOLTZ_FILE_PREFIX)) continue
    try {
      const raw = await disklet.getText(name)
      const rec = JSON.parse(raw) as ParmesanSwapRecord
      if (
        rec.status === 'locked_awaiting_claim' ||
        rec.status === 'locked_awaiting_btc_claim' ||
        rec.status === 'rbtc_claim_ready'
      ) {
        pending.push(rec)
      }
    } catch {
      // corrupt file — skip
    }
  }
  return pending
}

async function updateSwapRecord(
  disklet: Disklet,
  rec: ParmesanSwapRecord,
  patch: Partial<ParmesanSwapRecord>
): Promise<ParmesanSwapRecord> {
  const next = { ...rec, ...patch }
  const filename = `${BOLTZ_FILE_PREFIX}${rec.id}.json`
  await disklet.setText(filename, JSON.stringify(next)).catch(() => undefined)
  return next
}

async function pollOnce(
  disklet: Disklet,
  fetchFn: typeof fetch,
  callbacks: SwapMonitorCallbacks,
  log: { warn: (msg: string) => void }
): Promise<void> {
  const pending = await listPendingSwaps(disklet)
  for (const swap of pending) {
    try {
      const statusData = await getBoltzSwapStatus(swap.id, fetchFn)
      const state = String(statusData.status ?? '')
      const serverTx = statusData.transaction as { id?: string } | undefined

      if (CLAIMED_STATES.has(state)) {
        log.warn(`Boltz swap ${swap.id} completed (state: ${state})`)
        await updateSwapRecord(disklet, swap, { status: 'completed' })
        callbacks.onSwapCompleted(swap)
      } else if (FAILED_STATES.has(state)) {
        log.warn(`Boltz swap ${swap.id} expired/failed (state: ${state})`)
        await updateSwapRecord(disklet, swap, { status: 'refund_needed' })
        callbacks.onSwapRefundNeeded(swap)
      } else if (
        swap.direction === 'btc_rbtc' &&
        BOLTZ_SERVER_LOCK_READY_STATES.has(state)
      ) {
        const updated = await updateSwapRecord(disklet, swap, {
          status: 'rbtc_claim_ready',
          serverLockTxid: serverTx?.id ?? swap.serverLockTxid
        })
        log.warn(
          `[Parmesan] BTC→RBTC swap ${swap.id} ready for RBTC claim ` +
            `(Boltz ${state}). GUI must call EtherSwap.claim with preimage.`
        )
        callbacks.onSwapReadyToClaimRbtc?.(updated)
      }
      // else still in-flight — leave as-is
    } catch (e) {
      log.warn(`Boltz swap monitor error for ${swap.id}: ${String(e)}`)
    }
  }
}

/**
 * Start the background swap monitor. Returns a stop function.
 * Call stop() when the engine stops.
 */
export function startBoltzSwapMonitor(
  disklet: Disklet,
  fetchFn: typeof fetch,
  callbacks: SwapMonitorCallbacks,
  log: { warn: (msg: string) => void }
): () => void {
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    pollOnce(disklet, fetchFn, callbacks, log).catch(e =>
      log.warn(`Boltz monitor tick error: ${String(e)}`)
    )
  }

  // First poll shortly after engine start (5 s) to surface stale swaps fast.
  const initial = setTimeout(tick, 5_000)
  const interval = setInterval(tick, POLL_INTERVAL_MS)

  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(interval)
  }
}
