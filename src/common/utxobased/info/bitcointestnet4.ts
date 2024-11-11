import { EdgeCurrencyInfo } from 'edge-core-js/types'

import { CoinInfo, EngineInfo, PluginInfo } from '../../plugin/types'
import {
  legacyMemoInfo,
  utxoCustomFeeTemplate,
  utxoMemoOptions
} from './commonInfo'

export const currencyInfo: EdgeCurrencyInfo = {
  canReplaceByFee: true,
  currencyCode: 'TESTBTC4',
  customFeeTemplate: utxoCustomFeeTemplate,
  displayName: 'Bitcoin Testnet4',
  memoOptions: utxoMemoOptions,
  pluginId: 'bitcointestnet',
  walletType: 'wallet:bitcointestnet',

  // Explorers:
  blockExplorer: 'https://mempool.space/testnet4/block/%s',
  addressExplorer: 'https://mempool.space/testnet4/address/%s',
  transactionExplorer: 'https://mempool.space/testnet4/tx/%s',

  denominations: [
    { name: 'TESTBTC4', multiplier: '100000000', symbol: '₿' },
    { name: 'mTESTBTC4', multiplier: '100000', symbol: 'm₿' },
    { name: 'bits', multiplier: '100', symbol: 'ƀ' },
    { name: 'sats', multiplier: '1', symbol: 's' }
  ],

  // Deprecated:
  ...legacyMemoInfo,
  defaultSettings: {
    customFeeSettings: ['satPerByte'],
    blockbookServers: ['wss://testnet4-explorer.wakiyamap.dev'],
    enableCustomServers: false
  },
  metaTokens: []
}

export const engineInfo: EngineInfo = {
  formats: ['bip49', 'bip84', 'bip44', 'bip32'],
  forks: ['bitcoincash', 'bitcoingold'],
  gapLimit: 25,
  feeUpdateInterval: 60000,
  mempoolSpaceFeeInfoServer: 'https://mempool.space/api/v1/fees/recommended',
  defaultFeeInfo: {
    lowFeeFudgeFactor: undefined,
    standardFeeLowFudgeFactor: undefined,
    standardFeeHighFudgeFactor: undefined,
    highFeeFudgeFactor: undefined,

    highFee: '150',
    lowFee: '20',
    standardFeeLow: '50',
    standardFeeHigh: '100',
    standardFeeLowAmount: '173200',
    standardFeeHighAmount: '8670000'
  }
}

export const coinInfo: CoinInfo = {
  name: 'bitcointestnet4',
  segwit: true,
  coinType: 1,

  prefixes: {
    messagePrefix: ['\x18Bitcoin Signed Message:\n'],
    wif: [0xef],
    legacyXPriv: [0x04358394],
    legacyXPub: [0x043587cf],
    wrappedSegwitXPriv: [0x044a4e28],
    wrappedSegwitXPub: [0x044a5262],
    segwitXPriv: [0x045f18bc],
    segwitXPub: [0x045f1cf6],
    pubkeyHash: [0x6f],
    scriptHash: [0xc4],
    bech32: ['tb']
  }
}

export const info: PluginInfo = { currencyInfo, engineInfo, coinInfo }
