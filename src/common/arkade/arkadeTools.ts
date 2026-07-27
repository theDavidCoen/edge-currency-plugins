import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  ReadonlyWallet
} from '@arkade-os/sdk'
import { decodeInvoice, isValidArkAddress } from '@arkade-os/boltz-swap'
import * as bip39 from 'bip39'
import { asCodec, asMaybe, asObject, asString, uncleaner } from 'cleaners'
import {
  EdgeCurrencyTools,
  EdgeEncodeUri,
  EdgeIo,
  EdgeMetaToken,
  EdgeParsedUri,
  EdgeWalletInfo,
  JsonObject
} from 'edge-core-js/types'
import * as uri from 'uri-js'

import { arkadeCurrencyInfo } from './arkadeInfo'

const pluginId = arkadeCurrencyInfo.pluginId
const BTC_SAT_MULTIPLIER = 100_000_000

/**
 * Internal shape used by the engine / tools.
 * On disk Edge stores this as `arkadeMnemonic` (see edge-core key-formats).
 */
export interface ArkadePrivateKeys {
  mnemonic: string
}

export const asArkadePrivateKeys = asCodec<ArkadePrivateKeys>(
  raw => {
    if (raw == null || typeof raw !== 'object') {
      throw new TypeError('Private keys must be objects')
    }
    const from = asObject({
      [`${pluginId}Mnemonic`]: asString
    })({
      ...raw,
      // Accept legacy in-memory `{ mnemonic }` if present:
      [`${pluginId}Mnemonic`]:
        (raw as JsonObject)[`${pluginId}Mnemonic`] ??
        (raw as JsonObject).mnemonic
    })
    return {
      mnemonic: from[`${pluginId}Mnemonic`]
    }
  },
  clean => ({
    [`${pluginId}Mnemonic`]: clean.mnemonic
  })
)

const wasArkadePrivateKeys = uncleaner(asArkadePrivateKeys)

const asArkadePublicKeys = asObject({
  publicKey: asString
})

const stripLightningPrefix = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.toLowerCase().startsWith('lightning:')
    ? trimmed.slice('lightning:'.length).trim()
    : trimmed
}

/** BOLT11 invoice (not LNURL). */
export const isBolt11Invoice = (value: string): boolean => {
  const s = stripLightningPrefix(value).toLowerCase()
  return (
    s.startsWith('lnbc') || s.startsWith('lntb') || s.startsWith('lnbcrt')
  )
}

const isBtcOnchainAddress = (value: string): boolean => {
  const segwit =
    /^(bc1|tb1|bcrt1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,87}$/i
  const legacy = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
  return segwit.test(value) || legacy.test(value)
}

export { isBtcOnchainAddress }

const btcAmountToSats = (amountParam: string): string => {
  const amount = Number(amountParam)
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('InvalidUriError')
  }
  return String(Math.round(amount * BTC_SAT_MULTIPLIER))
}

const parseBolt11Uri = (raw: string): EdgeParsedUri => {
  const invoice = stripLightningPrefix(raw)
  if (!isBolt11Invoice(invoice)) throw new Error('InvalidUriError')
  const decoded = decodeInvoice(invoice)
  const parsed: EdgeParsedUri = {
    publicAddress: invoice,
    currencyCode: arkadeCurrencyInfo.currencyCode
  }
  if (decoded.amountSats > 0) {
    parsed.nativeAmount = String(decoded.amountSats)
  }
  if (decoded.description != null && decoded.description !== '') {
    parsed.metadata = { name: decoded.description }
  }
  return parsed
}

/**
 * BIP21 from Arkade Wallet / arkade.money:
 * `bitcoin:<bc1…>?ark=<ark1…>&amount=<btc>[&lightning=<lnbc…>]`
 * Prefer ark1 (instant), then lightning, then reject bare onchain-only.
 */
const parseBip21Uri = (raw: string): EdgeParsedUri => {
  const bip21Url = raw.trim()
  if (!bip21Url.toLowerCase().startsWith('bitcoin:')) {
    throw new Error('InvalidUriError')
  }
  const withoutScheme = bip21Url.slice(bip21Url.indexOf(':') + 1)
  const q = withoutScheme.indexOf('?')
  const addressPart = (
    q >= 0 ? withoutScheme.slice(0, q) : withoutScheme
  ).trim()
  const queryString = q >= 0 ? withoutScheme.slice(q + 1) : ''
  const params = new URLSearchParams(queryString)

  const getParam = (name: string): string | null => {
    for (const [key, value] of params.entries()) {
      if (key.toLowerCase() === name) return value
    }
    return null
  }

  const arkAddress = getParam('ark')
  const lightning = getParam('lightning')
  const amountParam = getParam('amount')

  if (arkAddress != null && isValidArkAddress(arkAddress)) {
    const parsed: EdgeParsedUri = {
      publicAddress: arkAddress,
      currencyCode: arkadeCurrencyInfo.currencyCode
    }
    if (addressPart !== '' && isBtcOnchainAddress(addressPart)) {
      parsed.segwitAddress = addressPart
    }
    if (amountParam != null && amountParam !== '') {
      parsed.nativeAmount = btcAmountToSats(amountParam)
    }
    return parsed
  }

  if (lightning != null && isBolt11Invoice(lightning)) {
    const parsed = parseBolt11Uri(lightning)
    if (
      parsed.nativeAmount == null &&
      amountParam != null &&
      amountParam !== ''
    ) {
      parsed.nativeAmount = btcAmountToSats(amountParam)
    }
    return parsed
  }

  // Onchain BIP21 / bare address → collaborative exit (Ark → Bitcoin onchain).
  if (addressPart !== '' && isBtcOnchainAddress(addressPart)) {
    const parsed: EdgeParsedUri = {
      publicAddress: addressPart,
      currencyCode: arkadeCurrencyInfo.currencyCode
    }
    if (amountParam != null && amountParam !== '') {
      parsed.nativeAmount = btcAmountToSats(amountParam)
    }
    return parsed
  }

  throw new Error('InvalidUriError')
}

export function makeArkadeTools(io: EdgeIo): EdgeCurrencyTools {
  const tools: EdgeCurrencyTools = {
    async checkPublicKey(publicKeyData: JsonObject): Promise<boolean> {
      return asMaybe(asArkadePublicKeys)(publicKeyData) != null
    },

    async createPrivateKey(_walletType: string): Promise<JsonObject> {
      const mnemonic = bip39.entropyToMnemonic(Buffer.from(io.random(32)))
      return wasArkadePrivateKeys({ mnemonic })
    },

    async importPrivateKey(entropy: string): Promise<JsonObject> {
      if (!bip39.validateMnemonic(entropy)) throw new Error('Invalid mnemonic')
      return wasArkadePrivateKeys({ mnemonic: entropy })
    },

    async derivePublicKey(
      unsafeWalletInfo: EdgeWalletInfo
    ): Promise<JsonObject> {
      // Edge only passes *public* keys into makeCurrencyEngine / startEngine.
      // Public receive address must be derived here from the private mnemonic.
      const { mnemonic } = asArkadePrivateKeys(unsafeWalletInfo.keys)
      const identity = MnemonicIdentity.fromMnemonic(mnemonic)
      const wallet = await ReadonlyWallet.create({
        identity: await identity.toReadonly(),
        arkServerUrl: String(
          (arkadeCurrencyInfo.defaultSettings as { arkServerUrl: string })
            .arkServerUrl
        ),
        storage: {
          walletRepository: new InMemoryWalletRepository(),
          contractRepository: new InMemoryContractRepository()
        }
      })
      try {
        const publicKey = await wallet.getAddress()
        return { publicKey }
      } finally {
        try {
          await (wallet as { dispose?: () => Promise<void> }).dispose?.()
        } catch {}
      }
    },

    async getDisplayPrivateKey(
      privateWalletInfo: EdgeWalletInfo
    ): Promise<string> {
      const { mnemonic } = asArkadePrivateKeys(privateWalletInfo.keys)
      return mnemonic
    },

    async getDisplayPublicKey(
      publicWalletInfo: EdgeWalletInfo
    ): Promise<string> {
      const { publicKey } = asArkadePublicKeys(publicWalletInfo.keys)
      return publicKey
    },

    async parseUri(rawUri: string): Promise<EdgeParsedUri> {
      const trimmed = rawUri.trim()
      if (trimmed === '') throw new Error('InvalidUriError')
      const lower = trimmed.toLowerCase()

      // Lightning BOLT11 (optionally lightning:…):
      if (
        lower.startsWith('lnbc') ||
        lower.startsWith('lntb') ||
        lower.startsWith('lnbcrt') ||
        lower.startsWith('lightning:')
      ) {
        return parseBolt11Uri(trimmed)
      }

      // BIP21 bitcoin:… (arkade.money / Arkade Wallet unified QR):
      if (lower.startsWith('bitcoin:')) {
        return parseBip21Uri(trimmed)
      }

      // arkade:<ark1…>?amount=<sats> or bare ark1… / tark1…
      let address = trimmed
      let amountSats: string | undefined
      if (lower.startsWith(`${pluginId}:`) || lower.startsWith('ark:')) {
        const withoutScheme = trimmed.slice(trimmed.indexOf(':') + 1)
        const qIndex = withoutScheme.indexOf('?')
        address = (
          qIndex >= 0 ? withoutScheme.slice(0, qIndex) : withoutScheme
        ).trim()
        if (qIndex >= 0) {
          const params = new URLSearchParams(withoutScheme.slice(qIndex + 1))
          const amount = params.get('amount')
          if (amount != null && amount !== '') amountSats = amount
        }
      }

      if (!isValidArkAddress(address)) {
        // Bare onchain BTC → collaborative exit path.
        if (isBtcOnchainAddress(address)) {
          const parsed: EdgeParsedUri = {
            publicAddress: address,
            currencyCode: arkadeCurrencyInfo.currencyCode
          }
          if (amountSats != null) {
            if (!/^\d+$/.test(amountSats)) throw new Error('InvalidUriError')
            parsed.nativeAmount = amountSats
          }
          return parsed
        }
        throw new Error('InvalidUriError')
      }

      const parsed: EdgeParsedUri = {
        publicAddress: address,
        currencyCode: arkadeCurrencyInfo.currencyCode
      }
      if (amountSats != null) {
        // Our encodeUri uses sats; reject non-integers.
        if (!/^\d+$/.test(amountSats)) throw new Error('InvalidUriError')
        parsed.nativeAmount = amountSats
      }
      return parsed
    },

    async encodeUri(
      obj: EdgeEncodeUri,
      _customTokens?: EdgeMetaToken[]
    ): Promise<string> {
      if (obj.publicAddress === '') throw new Error('InvalidPublicAddressError')

      // Boarding / onchain BTC (Request copy of boarding address):
      if (isBtcOnchainAddress(obj.publicAddress)) {
        if (obj.nativeAmount != null && obj.nativeAmount !== '') {
          // BIP21 uses BTC units, not sats.
          const btc = Number(obj.nativeAmount) / 1e8
          if (!Number.isFinite(btc) || btc < 0) {
            throw new Error('InvalidNativeAmountError')
          }
          return `bitcoin:${obj.publicAddress}?amount=${btc}`
        }
        return obj.publicAddress
      }

      if (!isValidArkAddress(obj.publicAddress)) {
        // Lightning / other — return as-is for QR of invoices we parsed.
        if (isBolt11Invoice(obj.publicAddress)) return obj.publicAddress
        throw new Error('InvalidPublicAddressError')
      }

      const query: string[] = []
      if (obj.nativeAmount != null) query.push(`amount=${obj.nativeAmount}`)

      return query.length > 0
        ? uri.serialize({
            scheme: arkadeCurrencyInfo.pluginId,
            path: obj.publicAddress,
            query: query.join('&')
          })
        : obj.publicAddress
    },

    getSplittableTypes(_walletInfo: EdgeWalletInfo): string[] {
      return []
    }
  }

  return tools
}
