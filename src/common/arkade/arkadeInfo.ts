import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import { EdgeCurrencyInfo } from 'edge-core-js/types'

/** Mainnet Arkade Operator (ASP) — same as arkade-os/wallet `mainServer`. */
export const DEFAULT_ARK_SERVER_URL = 'https://arkade.computer'

/** Mainnet default Arkade delegate — same as arkade-os/wallet bitcoin delegate. */
export const DEFAULT_DELEGATOR_URL = 'https://delegate.arkade.money'

export const DEFAULT_LNURL_SERVER_URL = 'https://lnurl.arkade.sh'

export interface ArkadeSettings {
  /** Default / Edge operator URL (used when custom operator is off). */
  arkServerUrl: string
  /** Amountless LNURL-pay session server (ArkLabs lnurl-server). */
  lnurlServerUrl: string

  /** When true, use `customArkServerUrl` instead of `arkServerUrl`. */
  enableCustomArkServer: boolean
  customArkServerUrl: string

  /** Auto-delegate VTXOs via a delegator service (default ON). */
  enableDelegate: boolean
  /** When true, use `customDelegatorUrl` instead of `defaultDelegatorUrl`. */
  enableCustomDelegate: boolean
  customDelegatorUrl: string
  /** Built-in default delegate for bitcoin mainnet. */
  defaultDelegatorUrl: string
}

export const asArkadeSettings = asObject<ArkadeSettings>({
  arkServerUrl: asString,
  lnurlServerUrl: asOptional(asString, DEFAULT_LNURL_SERVER_URL),
  enableCustomArkServer: asOptional(asBoolean, false),
  customArkServerUrl: asOptional(asString, ''),
  enableDelegate: asOptional(asBoolean, true),
  enableCustomDelegate: asOptional(asBoolean, false),
  customDelegatorUrl: asOptional(asString, ''),
  defaultDelegatorUrl: asOptional(asString, DEFAULT_DELEGATOR_URL)
}).withRest

export const arkadeDefaultSettings: ArkadeSettings = {
  arkServerUrl: DEFAULT_ARK_SERVER_URL,
  lnurlServerUrl: DEFAULT_LNURL_SERVER_URL,
  enableCustomArkServer: false,
  customArkServerUrl: '',
  enableDelegate: true,
  enableCustomDelegate: false,
  customDelegatorUrl: '',
  defaultDelegatorUrl: DEFAULT_DELEGATOR_URL
}

export function resolveArkServerUrl(settings: ArkadeSettings): string {
  if (
    settings.enableCustomArkServer &&
    settings.customArkServerUrl.trim() !== ''
  ) {
    return settings.customArkServerUrl.trim()
  }
  return settings.arkServerUrl
}

export function resolveDelegatorUrl(
  settings: ArkadeSettings
): string | undefined {
  if (!settings.enableDelegate) return undefined
  if (
    settings.enableCustomDelegate &&
    settings.customDelegatorUrl.trim() !== ''
  ) {
    return settings.customDelegatorUrl.trim()
  }
  return settings.defaultDelegatorUrl
}

export const arkadeCurrencyInfo: EdgeCurrencyInfo = {
  assetDisplayName: 'Bitcoin',
  chainDisplayName: 'Arkade',
  currencyCode: 'BTC',
  pluginId: 'arkade',
  walletType: 'wallet:arkade',

  // Explorers:
  addressExplorer: 'https://arkade.space/address/%s',
  transactionExplorer: 'https://arkade.space/tx/%s',

  denominations: [
    { name: 'BTC', multiplier: '100000000', symbol: '₿' },
    { name: 'sats', multiplier: '1', symbol: 's' }
  ],

  defaultSettings: arkadeDefaultSettings,

  // Private mnemonic is not present on `walletInfo` passed to startEngine —
  // Edge only injects it via syncNetwork when this flag is set (same as
  // zcash / monero).
  unsafeSyncNetwork: true,

  // Wallet details header uses sprintf("%s Network", displayName).
  displayName: 'Arkade',
  metaTokens: []
}
