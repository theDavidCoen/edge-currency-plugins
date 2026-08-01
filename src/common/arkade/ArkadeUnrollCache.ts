import { Disklet } from 'disklet'

import { safeArkadeWalletFileId } from './arkadeStoragePaths'

export type UnrollChainTx = {
  txid: string
  expiresAt?: string
  type: string
  spends?: string[]
}

export type UnrollCachePayload = {
  chains: Record<string, UnrollChainTx[]>
  virtualTxs: Record<string, string>
}

const EMPTY_PAYLOAD: UnrollCachePayload = {
  chains: {},
  virtualTxs: {}
}

export function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`
}

/**
 * Disklet-backed cache of VTXO ancestry chains + virtual PSBTs for offline Unroll.
 * Same AtomicFile-safe enqueue/persist pattern as ArkadeDiskletSdkStorage.
 */
export class ArkadeUnrollCache {
  private readonly disklet: Disklet
  private readonly filePath: string
  private payload: UnrollCachePayload = {
    chains: {},
    virtualTxs: {}
  }
  private memoryLoaded = false
  private queued: Promise<unknown> = Promise.resolve()

  constructor(disklet: Disklet, walletId: string) {
    this.disklet = disklet
    const safeWalletId = safeArkadeWalletFileId(walletId)
    this.filePath = `arkade-unroll-cache-${safeWalletId}.json`
  }

  async getChain(outpoint: string): Promise<UnrollChainTx[] | null> {
    return await this.enqueue(async () => {
      await this.ensureLoaded()
      const chain = this.payload.chains[outpoint]
      return Array.isArray(chain) && chain.length > 0 ? chain : null
    })
  }

  async setChain(outpoint: string, chain: UnrollChainTx[]): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      this.payload.chains[outpoint] = chain
      await this.persistBestEffort()
    })
  }

  async getVirtualTx(txid: string): Promise<string | null> {
    return await this.enqueue(async () => {
      await this.ensureLoaded()
      const tx = this.payload.virtualTxs[txid]
      return typeof tx === 'string' && tx.length > 0 ? tx : null
    })
  }

  async setVirtualTx(txid: string, psbtBase64: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      this.payload.virtualTxs[txid] = psbtBase64
      await this.persistBestEffort()
    })
  }

  async setVirtualTxs(entries: Array<{ txid: string; tx: string }>): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      for (const { txid, tx } of entries) {
        if (typeof txid === 'string' && typeof tx === 'string' && tx.length > 0) {
          this.payload.virtualTxs[txid] = tx
        }
      }
      await this.persistBestEffort()
    })
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queued.then(fn, fn)
    this.queued = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async ensureLoaded(): Promise<void> {
    if (this.memoryLoaded) return
    try {
      const text = await this.disklet.getText(this.filePath)
      const json = JSON.parse(text) as Partial<UnrollCachePayload>
      this.payload = {
        chains:
          json.chains != null && typeof json.chains === 'object'
            ? (json.chains as Record<string, UnrollChainTx[]>)
            : {},
        virtualTxs:
          json.virtualTxs != null && typeof json.virtualTxs === 'object'
            ? (json.virtualTxs as Record<string, string>)
            : {}
      }
    } catch {
      this.payload = { chains: {}, virtualTxs: {} }
    }
    this.memoryLoaded = true
  }

  private async persistBestEffort(): Promise<void> {
    const payload = JSON.stringify(this.payload)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.disklet.setText(this.filePath, payload)
        return
      } catch (error: unknown) {
        if (attempt >= 2) {
          console.warn(
            '[arkade] unroll-cache disk persist failed; keeping memory-only state',
            error
          )
          return
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
}

export const UNROLL_CACHE_MISS_MESSAGE =
  'Unroll data not cached yet; open the wallet while Arkade is reachable once, then retry.'

/**
 * IndexerProvider proxy: caches getVtxoChain / getVirtualTxs for Unroll.Session.
 * All other methods forward to the live indexer unchanged.
 */
export function wrapIndexerWithUnrollCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inner: any,
  cache: ArkadeUnrollCache
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (inner == null) {
    throw new Error('Missing indexer provider')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      if (prop === 'getVtxoChain') {
        return async (
          vtxoOutpoint: { txid: string; vout: number },
          opts?: unknown
        ) => {
          const key = outpointKey(vtxoOutpoint.txid, vtxoOutpoint.vout)
          try {
            const result = await target.getVtxoChain(vtxoOutpoint, opts)
            const chain = result?.chain
            if (Array.isArray(chain) && chain.length > 0) {
              await cache.setChain(key, chain)
            }
            return result
          } catch (error: unknown) {
            const cached = await cache.getChain(key)
            if (cached != null) {
              console.warn(
                '[arkade] getVtxoChain failed; using local unroll cache',
                error
              )
              return { chain: cached }
            }
            const message =
              error instanceof Error ? error.message : String(error)
            throw new Error(`${UNROLL_CACHE_MISS_MESSAGE} (${message})`)
          }
        }
      }

      if (prop === 'getVirtualTxs') {
        return async (txids: string[], opts?: unknown) => {
          const ids = Array.isArray(txids) ? txids : []
          try {
            const result = await target.getVirtualTxs(ids, opts)
            const txs: string[] = Array.isArray(result?.txs) ? result.txs : []
            const entries: Array<{ txid: string; tx: string }> = []
            for (let i = 0; i < ids.length; i++) {
              const tx = txs[i]
              if (typeof tx === 'string' && tx.length > 0) {
                entries.push({ txid: ids[i], tx })
              }
            }
            if (entries.length > 0) {
              await cache.setVirtualTxs(entries)
            }
            return result
          } catch (error: unknown) {
            const txs: string[] = []
            for (const txid of ids) {
              const cached = await cache.getVirtualTx(txid)
              if (cached == null) {
                const message =
                  error instanceof Error ? error.message : String(error)
                throw new Error(`${UNROLL_CACHE_MISS_MESSAGE} (${message})`)
              }
              txs.push(cached)
            }
            console.warn(
              '[arkade] getVirtualTxs failed; using local unroll cache',
              error
            )
            return { txs }
          }
        }
      }

      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') {
        return value.bind(target)
      }
      return value
    }
  }

  return new Proxy(inner, handler)
}

// Silence unused when tree-shaken differently
void EMPTY_PAYLOAD
