import { Disklet } from 'disklet'

/**
 * Minimal Disklet-backed key/value adapter for the Arkade SDK repositories.
 *
 * The SDK repository migration implementations only need async string storage,
 * so we keep a single JSON object per wallet. This survives app restarts and
 * avoids the "empty wallet until full re-sync" behavior from in-memory repos.
 */
export class ArkadeDiskletSdkStorage {
  private readonly disklet: Disklet
  private readonly filePath: string
  private queued: Promise<unknown> = Promise.resolve()

  constructor(disklet: Disklet, walletId: string) {
    this.disklet = disklet
    this.filePath = `arkade/${encodeURIComponent(walletId)}/sdk-storage.json`
  }

  async getItem(key: string): Promise<string | null> {
    const data = await this.load()
    return typeof data[key] === 'string' ? data[key] : null
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      data[key] = value
      await this.save(data)
    })
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      if (data[key] == null) return
      delete data[key]
      await this.save(data)
    })
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.disklet.delete(this.filePath).catch(() => {})
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

  private async load(): Promise<Record<string, string>> {
    try {
      const text = await this.disklet.getText(this.filePath)
      const json = JSON.parse(text)
      if (json == null || typeof json !== 'object') return {}
      return json
    } catch {
      return {}
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await this.disklet.setText(this.filePath, JSON.stringify(data))
  }
}
