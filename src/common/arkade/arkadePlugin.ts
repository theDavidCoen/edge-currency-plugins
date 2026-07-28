import {
  EdgeCorePluginOptions,
  EdgeCurrencyEngine,
  EdgeCurrencyEngineOptions,
  EdgeCurrencyPlugin,
  EdgeCurrencyTools,
  EdgeWalletInfo
} from 'edge-core-js/types'

import { ArkadeEngine } from './ArkadeEngine'
import { arkadeCurrencyInfo, asArkadeSettings } from './arkadeInfo'
import { ArkadeDiskletSdkStorage } from './ArkadeSdkStorage'
import { ArkadeDiskletSwapRepository } from './ArkadeSwapRepository'
import { makeArkadeTools } from './arkadeTools'

export function makeArkadePlugin(
  pluginOptions: EdgeCorePluginOptions
): EdgeCurrencyPlugin {
  const { io, pluginDisklet } = pluginOptions
  const currencyTools = makeArkadeTools(io)

  const plugin: EdgeCurrencyPlugin = {
    currencyInfo: arkadeCurrencyInfo,

    async makeCurrencyEngine(
      walletInfo: EdgeWalletInfo,
      engineOptions: EdgeCurrencyEngineOptions
    ): Promise<EdgeCurrencyEngine> {
      const settings = asArkadeSettings({
        ...arkadeCurrencyInfo.defaultSettings,
        ...engineOptions.userSettings
      })
      const walletDisklet =
        engineOptions.walletLocalDisklet != null
          ? engineOptions.walletLocalDisklet
          : pluginDisklet

      const swapRepository = new ArkadeDiskletSwapRepository(
        walletDisklet,
        walletInfo.id
      )
      const sdkStorage = new ArkadeDiskletSdkStorage(walletDisklet, walletInfo.id)
      return new ArkadeEngine(
        walletInfo,
        engineOptions,
        {
          // Edge's `io.fetch` signature is `fetch(uri: string, init?)`.
          // The SDK expects a WHATWG-like fetch; the URI string case is enough
          // for the providers we use.
          fetch: (uri: string, init?: any) => (io.fetch as any)(uri, init)
        },
        settings,
        swapRepository,
        sdkStorage
      )
    },

    async makeCurrencyTools(): Promise<EdgeCurrencyTools> {
      return currencyTools
    },

    async updateInfoPayload(_infoPayload: unknown) {}
  }

  return plugin
}
