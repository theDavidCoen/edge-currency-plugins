import { CipherSeed } from 'aezeed'
import * as bip39 from 'bip39'
import { JsonObject } from 'edge-core-js/types'
import * as electrumMnemonic from 'electrum-mnemonic'
// slip39 exports the class as module.exports (CJS default), not a named export.
import Slip39 from 'slip39'

import { ImportSeedType, PrivateKey, PublicKey } from '../keymanager/cleaners'

type PrivateKeyFormat = PrivateKey['format']

export type ExtendedImportMode =
  | 'auto'
  | 'bip39'
  | 'electrum'
  | 'aezeed'
  | 'slip39'
  | 'xpub'

export interface ExtendedImportOpts {
  format?: PrivateKeyFormat
  coinType?: number
  /** BIP39 or Electrum optional passphrase (never stored). */
  passphrase?: string
  /** aezeed cipher-seed password (defaults to LND's "aezeed"). */
  aezeedPassword?: string
  /** Explicit import mode from the GUI. */
  importMode?: ExtendedImportMode
  /** SLIP39 shares collected in the GUI (one mnemonic per share). */
  slip39Shares?: string[]
  /** SLIP39 optional passphrase extension. */
  slip39Passphrase?: string
}

export interface ExtendedPrivateKeyImport {
  kind: 'private'
  seed: string
  seedType: ImportSeedType
  format: PrivateKeyFormat
  imported: true
  passphraseUsed?: boolean
}

export interface ExtendedWatchOnlyImport {
  kind: 'watchOnly'
  publicKey: PublicKey
  watchOnly: true
  imported: true
}

export type ExtendedImportResult =
  | ExtendedPrivateKeyImport
  | ExtendedWatchOnlyImport

const XPUB_PREFIXES: Array<{
  prefix: string
  format: 'bip32' | 'bip44' | 'bip49' | 'bip84'
}> = [
  { prefix: 'xpub', format: 'bip44' },
  { prefix: 'tpub', format: 'bip44' },
  { prefix: 'ypub', format: 'bip49' },
  { prefix: 'upub', format: 'bip49' },
  { prefix: 'Ypub', format: 'bip49' },
  { prefix: 'zpub', format: 'bip84' },
  { prefix: 'vpub', format: 'bip84' },
  { prefix: 'Zpub', format: 'bip84' }
]

/** LND's default aezeed password when none is supplied. */
const AEZEED_DEFAULT_PASSWORD = 'aezeed'

const normalizeInput = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed.includes(' ')) return trimmed
  return trimmed
    .split(/\s+/)
    .filter(w => w !== '')
    .map(w => w.toLowerCase())
    .join(' ')
}

const isLikelyXpub = (input: string): boolean => {
  const lower = input.toLowerCase()
  return XPUB_PREFIXES.some(({ prefix }) => lower.startsWith(prefix))
}

const parseXpubImport = (input: string): ExtendedWatchOnlyImport | null => {
  const trimmed = input.trim()
  if (!isLikelyXpub(trimmed)) return null

  const lower = trimmed.toLowerCase()
  const match =
    XPUB_PREFIXES.find(({ prefix }) => lower.startsWith(prefix)) ??
    XPUB_PREFIXES[0]

  const publicKeys: PublicKey['publicKeys'] = {}
  publicKeys[match.format] = trimmed

  return {
    kind: 'watchOnly',
    publicKey: { publicKeys },
    watchOnly: true,
    imported: true
  }
}

/**
 * electrum-mnemonic.validateMnemonic(mnemonic, prefix) takes the version
 * prefix string as the 2nd arg — not an options object.
 */
const electrumPrefixToFormat = (prefix: string): PrivateKeyFormat => {
  // PrivateKeyFormat has no bip84; bip49 unlocks both bip49 + bip84 xpubs.
  if (prefix === electrumMnemonic.PREFIXES.standard) return 'bip44'
  if (prefix === electrumMnemonic.PREFIXES['2fa']) return 'bip44'
  return 'bip49'
}

const detectElectrumPrefix = (phrase: string): string | undefined => {
  for (const prefix of Object.values(electrumMnemonic.PREFIXES)) {
    try {
      if (electrumMnemonic.validateMnemonic(phrase, prefix)) return prefix
    } catch (_) {
      // try next prefix
    }
  }
  return undefined
}

const importElectrum = (
  phrase: string,
  opts: ExtendedImportOpts
): ExtendedPrivateKeyImport => {
  const prefix =
    detectElectrumPrefix(phrase) ?? electrumMnemonic.PREFIXES.segwit
  const seedBuffer = electrumMnemonic.mnemonicToSeedSync(phrase, {
    passphrase: opts.passphrase ?? '',
    prefix
  })
  return {
    kind: 'private',
    seed: seedBuffer.toString('base64'),
    seedType: 'electrum',
    format: opts.format ?? electrumPrefixToFormat(prefix),
    imported: true,
    passphraseUsed: (opts.passphrase ?? '') !== ''
  }
}

const resolveAezeedPassword = (opts: ExtendedImportOpts): string => {
  if (opts.aezeedPassword != null) return opts.aezeedPassword
  if (opts.passphrase != null && opts.passphrase !== '') return opts.passphrase
  return AEZEED_DEFAULT_PASSWORD
}

const tryAezeedDecode = (
  phrase: string,
  password: string
): CipherSeed | null => {
  try {
    return CipherSeed.fromMnemonic(phrase, password)
  } catch (_) {
    return null
  }
}

const importAezeed = (
  phrase: string,
  opts: ExtendedImportOpts
): ExtendedPrivateKeyImport => {
  const candidates = [resolveAezeedPassword(opts), AEZEED_DEFAULT_PASSWORD, '']
  let cipherSeed: CipherSeed | null = null
  let usedPassword = AEZEED_DEFAULT_PASSWORD
  for (const password of candidates) {
    cipherSeed = tryAezeedDecode(phrase, password)
    if (cipherSeed != null) {
      usedPassword = password
      break
    }
  }
  if (cipherSeed == null) {
    throw new Error('Invalid aezeed mnemonic or password')
  }
  // LND uses the 16-byte entropy directly as the BIP32 master seed.
  return {
    kind: 'private',
    seed: Buffer.from(cipherSeed.entropy).toString('base64'),
    seedType: 'aezeed',
    format: opts.format ?? 'bip49',
    imported: true,
    passphraseUsed:
      usedPassword !== '' && usedPassword !== AEZEED_DEFAULT_PASSWORD
  }
}

const importSlip39 = (opts: ExtendedImportOpts): ExtendedPrivateKeyImport => {
  const shares = (opts.slip39Shares ?? []).map(s => normalizeInput(s))
  if (shares.length === 0) {
    throw new Error('SLIP39 import requires at least one share')
  }
  for (const share of shares) {
    if (!Slip39.validateMnemonic(share)) {
      throw new Error('Invalid SLIP39 share')
    }
  }
  const slip39Passphrase = opts.slip39Passphrase ?? opts.passphrase ?? ''
  // recoverSecret returns the master secret bytes — use them directly as the
  // BIP32 seed (do not re-wrap through BIP39 mnemonicToSeed).
  const masterSecret = Buffer.from(
    Slip39.recoverSecret(shares, slip39Passphrase)
  )
  return {
    kind: 'private',
    seed: masterSecret.toString('base64'),
    seedType: 'slip39',
    format: opts.format ?? 'bip49',
    imported: true,
    passphraseUsed: slip39Passphrase !== ''
  }
}

const importBip39 = (
  phrase: string,
  opts: ExtendedImportOpts
): ExtendedPrivateKeyImport => {
  const passphrase = opts.passphrase ?? ''
  // Legacy Edge stores the mnemonic text when there is no passphrase so
  // existing importPrivateKey tests and wallets keep working. With a
  // passphrase we must bake mnemonicToSeed into base64 (passphrase is never
  // persisted).
  const seed =
    passphrase !== ''
      ? bip39.mnemonicToSeedSync(phrase, passphrase).toString('base64')
      : phrase
  return {
    kind: 'private',
    seed,
    seedType: 'bip39',
    format: opts.format ?? 'bip49',
    imported: true,
    passphraseUsed: passphrase !== ''
  }
}

const isAezeedMnemonic = (phrase: string): boolean => {
  const words = phrase.split(' ')
  if (words.length !== 24) return false
  return (
    tryAezeedDecode(phrase, AEZEED_DEFAULT_PASSWORD) != null ||
    tryAezeedDecode(phrase, '') != null
  )
}

const isSlip39Share = (phrase: string): boolean => {
  try {
    return Slip39.validateMnemonic(phrase)
  } catch (_) {
    return false
  }
}

const isElectrumMnemonic = (phrase: string): boolean => {
  try {
    return detectElectrumPrefix(phrase) != null
  } catch (_) {
    return false
  }
}

export const parseExtendedImportOpts = (
  opts?: JsonObject
): ExtendedImportOpts => {
  if (opts == null) return {}
  const keyOptions = (opts.keyOptions ?? opts) as JsonObject
  let slip39Shares: string[] | undefined
  if (Array.isArray(keyOptions.slip39Shares)) {
    slip39Shares = keyOptions.slip39Shares as string[]
  } else if (typeof keyOptions.slip39Shares === 'string') {
    slip39Shares = JSON.parse(keyOptions.slip39Shares) as string[]
  }
  return {
    format: keyOptions.format as PrivateKeyFormat | undefined,
    coinType: keyOptions.coinType as number | undefined,
    passphrase: keyOptions.passphrase as string | undefined,
    aezeedPassword: keyOptions.aezeedPassword as string | undefined,
    importMode: keyOptions.importMode as ExtendedImportMode | undefined,
    slip39Shares,
    slip39Passphrase: keyOptions.slip39Passphrase as string | undefined
  }
}

export const parseExtendedImport = (
  input: string,
  rawOpts?: JsonObject
): ExtendedImportResult => {
  const opts = parseExtendedImportOpts(rawOpts)
  const trimmed = input.trim()
  const mode = opts.importMode ?? 'auto'

  if (mode === 'xpub' || (mode === 'auto' && isLikelyXpub(trimmed))) {
    const watchOnly = parseXpubImport(trimmed)
    if (watchOnly != null) return watchOnly
    if (mode === 'xpub') throw new Error('Invalid extended public key')
  }

  if (
    mode === 'slip39' ||
    (opts.slip39Shares != null && opts.slip39Shares.length > 0)
  ) {
    return importSlip39(opts)
  }

  const phrase = normalizeInput(trimmed)
  const wordCount = phrase.split(' ').length

  if (mode === 'aezeed') {
    return importAezeed(phrase, opts)
  }

  if (mode === 'electrum') {
    if (!isElectrumMnemonic(phrase)) throw new Error('Invalid Electrum seed')
    return importElectrum(phrase, opts)
  }

  if (mode === 'bip39') {
    if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic')
    return importBip39(phrase, opts)
  }

  // auto-detect
  if (wordCount > 1) {
    if (isSlip39Share(phrase) && opts.slip39Shares != null) {
      return importSlip39(opts)
    }
    if (isAezeedMnemonic(phrase)) {
      return importAezeed(phrase, opts)
    }
    // Prefer Electrum version-prefix match over BIP39 checksum collisions.
    if (isElectrumMnemonic(phrase)) {
      return importElectrum(phrase, opts)
    }
    if (bip39.validateMnemonic(phrase)) {
      return importBip39(phrase, opts)
    }
  }

  const isAirbitzSeed = Buffer.from(trimmed, 'base64').length === 32
  if (isAirbitzSeed) {
    throw new Error('Import for Airbitz seeds is unsupported.')
  }

  throw new Error('Invalid import key')
}

export const extendedImportToWalletKeys = (
  result: ExtendedImportResult,
  coinName: string,
  coinType: number
): JsonObject => {
  if (result.kind === 'watchOnly') {
    // asPublicKey / asSafeWalletInfo expect `publicKeys` at the top level of
    // wallet keys (not nested under `publicKey`).
    return {
      imported: true,
      watchOnly: true,
      publicKeys: result.publicKey.publicKeys
    }
  }

  return {
    imported: true,
    coinType,
    format: result.format,
    seedType: result.seedType,
    passphraseUsed: result.passphraseUsed === true,
    [`${coinName}Key`]: result.seed
  }
}
