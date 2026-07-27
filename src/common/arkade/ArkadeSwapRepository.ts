import { Disklet } from 'disklet'

interface Swap {
  id: string
  type?: string
  status?: string
  createdAt?: number
  [k: string]: unknown
}

interface GetSwapsFilter {
  id?: string | string[]
  status?: string | string[]
  type?: string | string[]
  orderBy?: 'createdAt'
  orderDirection?: 'asc' | 'desc'
}

/**
 * Disklet-backed SwapRepository compatible with `@arkade-os/boltz-swap`.
 *
 * This avoids IndexedDB (not available in Edge Core or Node) while still
 * persisting swaps across app restarts.
 */
export class ArkadeDiskletSwapRepository {
  readonly version = 1 as const

  private readonly filePath: string
  private readonly disklet: Disklet

  private queued: Promise<unknown> = Promise.resolve()

  constructor(disklet: Disklet, walletId: string) {
    this.disklet = disklet
    this.filePath = `arkade/${walletId}/swaps.json`
  }

  async saveSwap<T extends Swap>(swap: T): Promise<void> {
    await this.enqueue(async () => {
      const swaps = await this.load()
      swaps[swap.id] = swap
      await this.save(swaps)
    })
  }

  async deleteSwap(id: string): Promise<void> {
    await this.enqueue(async () => {
      const swaps = await this.load()
      // Avoid `delete` (lint rule) by writing a tombstone:
      ;((swaps as unknown) as Record<string, Swap | undefined>)[id] = undefined
      await this.save(swaps)
    })
  }

  async getAllSwaps<T extends Swap>(filter?: GetSwapsFilter): Promise<T[]> {
    const swaps = await this.load()
    let out = Object.values(swaps) as T[]

    if (filter?.id != null) {
      const ids = Array.isArray(filter.id) ? filter.id : [filter.id]
      out = out.filter(s => ids.includes(String((s as any).id)))
    }
    if (filter?.status != null) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      out = out.filter(s => statuses.includes(String((s as any).status)))
    }
    if (filter?.type != null) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type]
      out = out.filter(s => types.includes(String((s as any).type)))
    }

    if (filter?.orderBy === 'createdAt') {
      out.sort((a: any, b: any) => {
        const aa = Number(a.createdAt ?? 0)
        const bb = Number(b.createdAt ?? 0)
        return filter.orderDirection === 'asc' ? aa - bb : bb - aa
      })
    }

    return out
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.disklet.delete(this.filePath).catch(() => {})
    })
  }

  async dispose(): Promise<void> {}

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queued.then(fn, fn)
    this.queued = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async load(): Promise<Record<string, Swap>> {
    try {
      const text = await this.disklet.getText(this.filePath)
      const json = JSON.parse(text)
      if (json == null || typeof json !== 'object') return {}
      return json
    } catch {
      return {}
    }
  }

  private async save(swaps: Record<string, Swap>): Promise<void> {
    // Remove tombstones before saving:
    const cleaned: Record<string, Swap> = {}
    for (const [id, swap] of Object.entries(swaps)) {
      if (swap != null) cleaned[id] = swap
    }
    await this.disklet.setText(this.filePath, JSON.stringify(cleaned))
  }
}
