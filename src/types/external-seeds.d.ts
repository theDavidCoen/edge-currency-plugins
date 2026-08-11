declare module 'electrum-mnemonic' {
  export const PREFIXES: Record<string, string>
  /** Second arg is the version prefix hex string (e.g. PREFIXES.segwit). */
  export function validateMnemonic(mnemonic: string, prefix: string): boolean
  export function mnemonicToSeedSync(
    mnemonic: string,
    opts?: { prefix?: string; passphrase?: string; skipCheck?: boolean }
  ): Buffer
  export function generateMnemonic(opts?: {
    prefix?: string
    strength?: number
  }): string
}

declare module 'aezeed' {
  export class CipherSeed {
    static fromMnemonic(mnemonic: string, password?: string): CipherSeed
    static random(): CipherSeed
    entropy: Buffer
    birthday: number
    toMnemonic(password?: string): string
  }
}

declare module 'slip39' {
  export default class Slip39 {
    static recoverSecret(mnemonics: string[], passphrase?: string): number[]
    static validateMnemonic(mnemonic: string): boolean
    static fromArray(
      masterSecret: number[],
      opts?: {
        passphrase?: string
        threshold?: number
        groups?: Array<[number, number, string?]>
        iterationExponent?: number
        extendableBackupFlag?: number
        title?: string
      }
    ): Slip39
    fromPath(path: string): { mnemonics: string[] }
  }
}
