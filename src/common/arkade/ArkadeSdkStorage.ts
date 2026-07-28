import { Disklet } from 'disklet'

import { safeArkadeWalletFileId } from './arkadeStoragePaths'

/**
 * Disklet-backed key/value adapter for the Arkade SDK repositories.
 *
 * Android Edge core uses AtomicFile under the hood. Concurrent/rapid writes to
 * the same path frequently log "Failed to rename … .new" and can break wallet
 * init. Keep an in-memory mirror as source of truth and treat disk as
 * best-effort persistence.
 */
export class ArkadeDiskletSdkStorage {
  private readonly disklet: Disklet
  private readonly filePath: string
  private readonly legacyPaths: string[]
  private readonly memory: Record<string, string> = {}
  private memoryLoaded = false
  private queued: Promise<unknown> = Promise.resolve()

  constructor(disklet: Disklet, walletId: string) {
    this.disklet = disklet
    const safeWalletId = safeArkadeWalletFileId(walletId)
    const encodedWalletId = encodeURIComponent(walletId)
    this.filePath = `arkade-sdk-storage-${safeWalletId}.json`
    this.legacyPaths = [
      `arkade-sdk-storage-${encodedWalletId}.json`,
      `arkade/${encodedWalletId}/sdk-storage.json`,
      `arkade/${safeWalletId}/sdk-storage.json`
    ]
  }

  async getItem(key: string): Promise<string | null> {
    return await this.enqueue(async () => {
      await this.ensureLoaded()
      return typeof this.memory[key] === 'string' ? this.memory[key] : null
    })
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      this.memory[key] = value
      await this.persistBestEffort()
    })
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      if (this.memory[key] == null) return
      delete this.memory[key]
      await this.persistBestEffort()
    })
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      for (const key of Object.keys(this.memory)) {
        delete this.memory[key]
      }
      this.memoryLoaded = true
      await this.disklet.delete(this.filePath).catch(() => {})
      await Promise.all(
        this.legacyPaths.map(path => this.disklet.delete(path).catch(() => {}))
      )
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

    const loadPath = async (path: string): Promise<Record<string, string>> => {
      const text = await this.disklet.getText(path)
      const json = JSON.parse(text)
      if (json == null || typeof json !== 'object') return {}
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
      }
      return out
    }

    try {
      Object.assign(this.memory, await loadPath(this.filePath))
    } catch {
      for (const legacyPath of this.legacyPaths) {
        try {
          Object.assign(this.memory, await loadPath(legacyPath))
          break
        } catch {
          // try next legacy path
        }
      }
    }

    this.memoryLoaded = true
  }

  private async persistBestEffort(): Promise<void> {
    const payload = JSON.stringify(this.memory)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.disklet.setText(this.filePath, payload)
        return
      } catch (error: unknown) {
        if (attempt >= 2) {
          console.warn(
            '[arkade] sdk-storage disk persist failed; keeping memory-only state',
            error
          )
          return
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
}
