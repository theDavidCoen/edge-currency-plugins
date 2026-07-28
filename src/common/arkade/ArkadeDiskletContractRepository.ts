import { ArkadeDiskletSdkStorage } from './ArkadeSdkStorage'

type JsonMap = Record<string, unknown>

/**
 * Disk-backed contract repository compatible with the newer Arkade TS SDK.
 *
 * The SDK needs both the old contract-data/collection helpers and the new
 * contract-row methods (`getContracts/saveContract/deleteContract`).
 */
export class ArkadeDiskletContractRepository {
  readonly version = 1 as const

  private readonly storage: ArkadeDiskletSdkStorage
  private queued: Promise<unknown> = Promise.resolve()

  constructor(storage: ArkadeDiskletSdkStorage) {
    this.storage = storage
  }

  async getContractData<T>(contractId: string, key: string): Promise<T | null> {
    const all = await this.loadMap<Record<string, JsonMap>>('contractData')
    const contract = all[contractId]
    return (contract?.[key] as T | undefined) ?? null
  }

  async setContractData<T>(
    contractId: string,
    key: string,
    data: T
  ): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.loadMap<Record<string, JsonMap>>('contractData')
      const contract = all[contractId] ?? {}
      contract[key] = data as unknown
      all[contractId] = contract
      await this.saveMap('contractData', all)
    })
  }

  async deleteContractData(contractId: string, key: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.loadMap<Record<string, JsonMap>>('contractData')
      const contract = all[contractId]
      if (contract == null) return
      delete contract[key]
      all[contractId] = contract
      await this.saveMap('contractData', all)
    })
  }

  async getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>> {
    const all = await this.loadMap<Record<string, T[]>>('collections')
    return all[contractType] ?? []
  }

  async saveToContractCollection<T, K extends keyof T>(
    contractType: string,
    item: T,
    idField: K
  ): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.loadMap<Record<string, T[]>>('collections')
      const existing = all[contractType] ?? []
      const itemId = item[idField]
      const next = existing.filter(candidate => candidate[idField] !== itemId)
      next.push(item)
      all[contractType] = next
      await this.saveMap('collections', all)
    })
  }

  async removeFromContractCollection<T, K extends keyof T>(
    contractType: string,
    id: T[K],
    idField: K
  ): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.loadMap<Record<string, T[]>>('collections')
      const existing = all[contractType] ?? []
      all[contractType] = existing.filter(candidate => candidate[idField] !== id)
      await this.saveMap('collections', all)
    })
  }

  async getContracts(filter?: {
    script?: string | string[]
    state?: string | string[]
    type?: string | string[]
  }): Promise<any[]> {
    const contractsByScript = await this.loadMap<Record<string, any>>('contracts')
    const contracts = Object.values(contractsByScript)
    if (filter == null) return contracts

    const matches = (value: unknown, criterion: string | string[] | undefined) =>
      criterion == null
        ? true
        : Array.isArray(criterion)
        ? criterion.includes(String(value))
        : String(value) === criterion

    return contracts.filter(
      contract =>
        matches(contract.script, filter.script) &&
        matches(contract.state, filter.state) &&
        matches(contract.type, filter.type)
    )
  }

  async saveContract(contract: any): Promise<void> {
    await this.enqueue(async () => {
      const contractsByScript = await this.loadMap<Record<string, any>>('contracts')
      contractsByScript[String(contract.script)] = contract
      await this.saveMap('contracts', contractsByScript)
    })
  }

  async deleteContract(script: string): Promise<void> {
    await this.enqueue(async () => {
      const contractsByScript = await this.loadMap<Record<string, any>>('contracts')
      delete contractsByScript[script]
      await this.saveMap('contracts', contractsByScript)
    })
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await Promise.all([
        this.storage.removeItem('contracts:contractData'),
        this.storage.removeItem('contracts:collections'),
        this.storage.removeItem('contracts:contracts')
      ])
    })
  }

  async [Symbol.asyncDispose](): Promise<void> {}

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queued.then(fn, fn)
    this.queued = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async loadMap<T extends JsonMap>(name: string): Promise<T> {
    const text = await this.storage.getItem(`contracts:${name}`)
    if (text == null) return {} as T
    try {
      const parsed = JSON.parse(text)
      return parsed != null && typeof parsed === 'object' ? (parsed as T) : ({} as T)
    } catch {
      return {} as T
    }
  }

  private async saveMap(name: string, value: JsonMap): Promise<void> {
    await this.storage.setItem(`contracts:${name}`, JSON.stringify(value))
  }
}
