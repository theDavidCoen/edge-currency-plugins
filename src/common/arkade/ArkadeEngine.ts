import { ArkadeSwaps, decodeInvoice, isValidArkAddress } from '@arkade-os/boltz-swap'
import {
  ChainTxType,
  Estimator,
  MnemonicIdentity,
  OnchainWallet,
  RestDelegatorProvider,
  Transaction,
  UnilateralExit,
  Unroll,
  VHTLC,
  VtxoScript,
  WalletRepositoryImpl,
  Wallet,
  networks,
  serializeExitPackage
} from '@arkade-os/sdk'
import { TxWeightEstimator } from '@arkade-tx-size-estimator'
import { base64, hex } from '@scure/base'
import { Address, OutScript, TaprootControlBlock } from '@scure/btc-signer'
import {
  EdgeAddress,
  EdgeCurrencyEngine,
  EdgeCurrencyEngineOptions,
  EdgeDataDump,
  EdgeSpendInfo,
  EdgeTransaction,
  EdgeWalletInfo,
  JsonObject
} from 'edge-core-js/types'

import {
  EngineEmitter,
  EngineEvent,
  makeEngineEmitter
} from '../plugin/EngineEmitter'
import {
  arkadeCurrencyInfo,
  ArkadeSettings,
  asArkadeSettings,
  resolveArkServerUrl,
  resolveDelegatorUrl
} from './arkadeInfo'
import { deriveLnurlSessionToken } from './arkadeLnurl'
import { ArkadeDiskletContractRepository } from './ArkadeDiskletContractRepository'
import { ArkadeDiskletSdkStorage } from './ArkadeSdkStorage'
import { ArkadeDiskletSwapRepository } from './ArkadeSwapRepository'
import {
  ArkadeUnrollCache,
  UNROLL_CACHE_MISS_MESSAGE,
  wrapIndexerWithUnrollCache
} from './ArkadeUnrollCache'
import { asArkadePrivateKeys, isBolt11Invoice, isBtcOnchainAddress } from './arkadeTools'

type ArkadeDelayType = 'blocks' | 'seconds'

export interface ArkadeVhtlcCreateParams {
  label?: string
  receiverPubKeyHex: string
  preimageHashHex: string
  refundLocktime: string
  unilateralClaimDelay?: {
    type: ArkadeDelayType
    value: string
  }
  unilateralRefundDelay?: {
    type: ArkadeDelayType
    value: string
  }
  unilateralRefundWithoutReceiverDelay?: {
    type: ArkadeDelayType
    value: string
  }
}

export interface ArkadeLnPayParams {
  invoice: string
}

export interface ArkadeLnPayResult {
  txid: string
  amount: number
  preimage?: string
}

export interface ArkadeLnReceiveParams {
  amount: number
  description?: string
}

export interface ArkadeLnReceiveResult {
  invoice: string
  amount: number
  expiry: number
  paymentHash: string
  preimage: string
  pendingSwap: unknown
}

export interface ArkadeLnurlStartParams {
  lnurlServerUrl: string
}

export interface ArkadeLnurlSessionCreated {
  sessionId: string
  lnurl: string
}

/** Live fee breakdown for the unilateral exit (Unroll + sweep) path. */
export interface ArkadeUnilateralExitEstimate {
  grossAmountSats: string
  estimatedFeeSats: string
  netAmountSats: string
  feeRatio: number
  vBytes: number
  feeRateSatvB: number
  timelockBlocks: number
  uneconomical: boolean
  highFeeImpact: boolean
}

/**
 * Keyless graph-mode exit package for the Edge web executor prototype.
 * Fee funding happens on the website — prefer a future in-app executor.
 */
export interface ArkadeUnilateralExitPackageResult {
  json: string
  filename: string
  executorUrl: string
  mode: 'graph'
  sweepAddress: string
}

/** Edge-branded unilateral-exit Pages fork (prototype). */
export const ARKADE_UNILATERAL_EXIT_EXECUTOR_URL =
  'https://thedavidcoen.github.io/arkade-unilateral-exit/'

/** Result of preflight checks before Arkade → other-asset swap quotes. */
export interface ArkadeOnchainSwapEligibility {
  eligible: boolean
  code:
    | 'ok'
    | 'no_funds'
    | 'settlement_min_expiry_gap'
    | 'insufficient_vtxos'
    | 'amount_too_small'
    | 'engine_not_started'
    | 'boltz_unavailable'
    | 'unknown'
  message: string
}

const POLL_MS = 20_000
const ENGINE_START_WAIT_MS = 45_000
const ENGINE_START_POLL_MS = 250

export class ArkadeEngine implements EdgeCurrencyEngine {
  readonly currencyInfo = arkadeCurrencyInfo
  readonly otherMethods: EdgeCurrencyEngine['otherMethods']

  private readonly emitter: EngineEmitter
  private readonly walletInfo: EdgeWalletInfo
  private settings: ArkadeSettings
  private readonly onAddressChanged: (() => void) | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wallet: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private swaps: any
  private pollId: ReturnType<typeof setInterval> | undefined
  private running = false

  private cachedBalance = '0'
  private cachedBlockHeight = 1
  private cachedTxs: EdgeTransaction[] = []
  private balanceEmitted = false
  private cachedArkadeAddress: string | undefined
  private cachedBoardingAddress: string | undefined
  private cachedLnurl: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cachedAspFees: any
  private readonly seenTxids = new Set<string>()
  private historyBootstrapped = false
  private stopIncomingNotify: (() => void) | undefined

  private lnurlAbort: AbortController | undefined
  private lnurlSessionId: string | undefined
  private lnurlLoopRunning = false
  /** HMAC token derived from mnemonic — resumes the same LNURL across reconnects. */
  private lnurlSessionToken: string | undefined
  /** Bearer from session_created (posted with invoices). */
  private lnurlBearerToken: string | undefined
  private lnurlReconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** Shared in-flight Wallet.create / restore so concurrent syncNetwork calls wait. */
  private walletInitPromise: Promise<void> | undefined
  /** Last successful unroll artifact prefetch (ms). */
  private unrollPrefetchAt = 0
  private unrollPrefetchInflight: Promise<void> | undefined

  /**
   * Edge `io.fetch` wrapper passed from the plugin.
   * Do NOT assign this to `globalThis.fetch` — Edge's own io.fetch calls
   * `window.fetch` / `globalThis.fetch`, which causes infinite recursion and
   * breaks auth (`Could not reach the auth server: /v2/login/keys`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly fetch: (uri: string, init?: any) => Promise<any>

  constructor(
    walletInfo: EdgeWalletInfo,
    engineOptions: EdgeCurrencyEngineOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    io: { fetch: (uri: string, init?: any) => Promise<any> },
    settings: ArkadeSettings,
    private readonly swapRepository: ArkadeDiskletSwapRepository,
    private readonly sdkStorage: ArkadeDiskletSdkStorage,
    private readonly unrollCache: ArkadeUnrollCache
  ) {
    this.walletInfo = walletInfo
    this.settings = settings
    this.fetch = io.fetch
    this.emitter = makeEngineEmitter(engineOptions.callbacks)
    this.onAddressChanged = engineOptions.callbacks.onAddressChanged

    // Ensure common globals exist in the core WebView environment:
    if ((globalThis as any).Buffer == null) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ;(globalThis as any).Buffer = require('buffer').Buffer
    }

    this.otherMethods = {
      getBoardingAddress: async () => {
        if (this.wallet == null) throw new Error('Engine not started')
        return this.wallet.getBoardingAddress()
      },
      getVtxos: async (filter?: unknown) => {
        if (this.wallet == null) throw new Error('Engine not started')
        return this.wallet.getVtxos(filter)
      },

      // --- VHTLC swap primitives (Lightning-swap building blocks) ---
      arkadeCreateVhtlcContract: async (params: ArkadeVhtlcCreateParams) => {
        if (this.wallet == null) throw new Error('Engine not started')

        const senderPubKey: Uint8Array = await this.wallet.identity.xOnlyPublicKey()
        const receiverPubKey = Uint8Array.from(
          Buffer.from(params.receiverPubKeyHex, 'hex')
        )
        const preimageHash = Uint8Array.from(
          Buffer.from(params.preimageHashHex, 'hex')
        )

        const serverPubKey: Uint8Array =
          this.wallet?.offchainTapscript?.options?.serverPubKey ??
          this.wallet?.arkServerPublicKey
        if (serverPubKey == null) {
          throw new Error('Missing server public key')
        }

        const hrp: string =
          this.wallet?.network?.hrp ??
          (await this.wallet.getAddress()).slice(0, 3) // fallback guess

        const script = new VHTLC.Script({
          preimageHash,
          sender: senderPubKey,
          receiver: receiverPubKey,
          server: serverPubKey,
          refundLocktime: BigInt(params.refundLocktime),
          unilateralClaimDelay:
            params.unilateralClaimDelay != null
              ? {
                  type: params.unilateralClaimDelay.type,
                  value: BigInt(params.unilateralClaimDelay.value)
                }
              : { type: 'blocks', value: BigInt('10') },
          unilateralRefundDelay:
            params.unilateralRefundDelay != null
              ? {
                  type: params.unilateralRefundDelay.type,
                  value: BigInt(params.unilateralRefundDelay.value)
                }
              : { type: 'blocks', value: BigInt('12') },
          unilateralRefundWithoutReceiverDelay:
            params.unilateralRefundWithoutReceiverDelay != null
              ? {
                  type: params.unilateralRefundWithoutReceiverDelay.type,
                  value: BigInt(
                    params.unilateralRefundWithoutReceiverDelay.value
                  )
                }
              : { type: 'blocks', value: BigInt('14') }
        })

        const address = script.address(hrp, serverPubKey).encode()
        const pkScriptHex = Buffer.from(script.pkScript).toString('hex')

        const manager = await this.wallet.getContractManager()
        const contract = await manager.createContract({
          label: params.label ?? 'Lightning Swap',
          type: 'vhtlc',
          params: {
            sender: Buffer.from(senderPubKey).toString('hex'),
            receiver: params.receiverPubKeyHex,
            server: Buffer.from(serverPubKey).toString('hex'),
            hash: params.preimageHashHex,
            refundLocktime: params.refundLocktime,
            claimDelay: (params.unilateralClaimDelay?.value ?? '10').toString(),
            refundDelay: (
              params.unilateralRefundDelay?.value ?? '12'
            ).toString(),
            refundNoReceiverDelay: (
              params.unilateralRefundWithoutReceiverDelay?.value ?? '14'
            ).toString()
          },
          script: pkScriptHex,
          address
        })

        return { address, pkScriptHex, contract }
      },

      arkadeListContracts: async () => {
        if (this.wallet == null) throw new Error('Engine not started')
        const manager = await this.wallet.getContractManager()
        return manager.getContracts()
      },

      arkadeGetContractsWithVtxos: async (filter: unknown) => {
        if (this.wallet == null) throw new Error('Engine not started')
        const manager = await this.wallet.getContractManager()
        return manager.getContractsWithVtxos(filter)
      },

      arkadeUpdateContractParams: async (
        contractScript: string,
        newParams: unknown
      ) => {
        if (this.wallet == null) throw new Error('Engine not started')
        const manager = await this.wallet.getContractManager()
        return manager.updateContractParams(contractScript, newParams)
      },

      arkadeGetSpendablePaths: async (args: unknown) => {
        if (this.wallet == null) throw new Error('Engine not started')
        const manager = await this.wallet.getContractManager()
        return manager.getSpendablePaths(args)
      },

      // --- High-level Lightning UX (Boltz via ArkadeSwaps) ---
      arkadeDecodeLightningInvoice: async (invoice: string) => {
        return decodeInvoice(invoice)
      },

      arkadeSendLightningPayment: async (
        params: ArkadeLnPayParams
      ): Promise<ArkadeLnPayResult> => {
        if (this.swaps == null) throw new Error('Swaps not initialized')
        const result = await this.swaps.sendLightningPayment({
          invoice: params.invoice
        })
        return {
          txid: String(result.txid ?? ''),
          amount: Number(result.amount ?? 0),
          preimage:
            result.preimage != null ? String(result.preimage) : undefined
        }
      },

      arkadeCreateLightningInvoice: async (
        params: ArkadeLnReceiveParams
      ): Promise<ArkadeLnReceiveResult> => {
        if (this.swaps == null) throw new Error('Swaps not initialized')
        const result = await this.swaps.createLightningInvoice({
          amount: params.amount,
          description: params.description
        })
        return {
          invoice: String(result.invoice),
          amount: Number(result.amount),
          expiry: Number(result.expiry),
          paymentHash: String(result.paymentHash),
          preimage: String(result.preimage),
          pendingSwap: result.pendingSwap
        }
      },

      /**
       * Starts an amountless LNURL receive session (Arkade Wallet / lnurl-server).
       */
      arkadeLnurlStartReceiveSession: async (
        params?: Partial<ArkadeLnurlStartParams>
      ): Promise<ArkadeLnurlSessionCreated> => {
        const lnurlServerUrl =
          params?.lnurlServerUrl ?? this.settings.lnurlServerUrl
        const lnurl = await this.ensureLnurlSession(lnurlServerUrl)
        if (lnurl == null || this.lnurlSessionId == null) {
          throw new Error('LNURL session failed to start')
        }
        return { sessionId: this.lnurlSessionId, lnurl }
      },

      arkadeLnurlStopReceiveSession: async (): Promise<void> => {
        this.stopLnurlSession({ clearCached: true })
      },

      /**
       * Collaborative settle/offboard: exit spendable VTXOs to an onchain BTC
       * address while the ASP is online (`wallet.settle`).
       *
       * For ASP-independent Unroll + CSV sweep, use
       * `arkadeUnilateralExitToAddress` instead.
       */
      arkadeOffboardToAddress: async (
        destination: string
      ): Promise<{
        txid: string
        destination: string
      }> => {
        if (this.wallet == null) throw new Error('Engine not started')
        if (destination == null || destination === '') {
          throw new Error('Missing destination address')
        }
        if (!isBtcOnchainAddress(destination)) {
          throw new Error('Destination must be a Bitcoin onchain address')
        }

        const vtxos = await this.wallet.getVtxos({
          withRecoverable: true,
          withUnrolled: false
        })
        if (vtxos.length === 0) {
          throw new Error('No funds available to exit')
        }

        const arkProvider = this.wallet.arkProvider
        if (arkProvider?.getInfo == null) {
          throw new Error('Arkade provider unavailable')
        }
        const info = await arkProvider.getInfo()
        let txid: string
        try {
          txid = await this.settleOnchainExit(destination, undefined, info.fees)
        } catch (error: unknown) {
          throw new Error(this.formatOnchainExitError(error))
        }
        return { txid: String(txid), destination }
      },

      /**
       * Estimate network fees for a true unilateral exit (Unroll chain + CSV sweep).
       */
      arkadeEstimateUnilateralExit: async (
        destination: string
      ): Promise<ArkadeUnilateralExitEstimate> => {
        if (this.wallet == null) throw new Error('Engine not started')
        if (destination == null || destination === '') {
          throw new Error('Missing destination address')
        }
        if (!isBtcOnchainAddress(destination)) {
          throw new Error('Destination must be a Bitcoin onchain address')
        }
        return await this.estimateUnilateralExitFees(destination)
      },

      /**
       * Broadcast the unilateral exit chain (Unroll steps, then sweep when possible).
       * Prefer `arkadePrepareUnilateralExitPackage` + web executor for average users.
       */
      arkadeUnilateralExitToAddress: async (
        destination: string
      ): Promise<{
        txid: string
        destination: string
        phase: 'sweep' | 'unroll'
      }> => {
        if (this.wallet == null) throw new Error('Engine not started')
        if (destination == null || destination === '') {
          throw new Error('Missing destination address')
        }
        if (!isBtcOnchainAddress(destination)) {
          throw new Error('Destination must be a Bitcoin onchain address')
        }
        try {
          return await this.runUnilateralExitToAddress(destination)
        } catch (error: unknown) {
          throw new Error(this.formatOnchainExitError(error))
        }
      },

      /**
       * Build a graph-mode unilateral exit JSON package (no in-app Unroll/CPFP).
       * User imports the file into the Edge web executor to fund fees and finish.
       */
      arkadePrepareUnilateralExitPackage: async (
        destination: string
      ): Promise<ArkadeUnilateralExitPackageResult> => {
        if (this.wallet == null) throw new Error('Engine not started')
        if (destination == null || destination === '') {
          throw new Error('Missing destination address')
        }
        if (!isBtcOnchainAddress(destination)) {
          throw new Error('Destination must be a Bitcoin onchain address')
        }
        try {
          return await this.prepareUnilateralExitPackage(destination)
        } catch (error: unknown) {
          throw new Error(this.formatOnchainExitError(error))
        }
      },

      /**
       * P2TR key-path address used to pay Unroll CPFP fees (not the boarding
       * address — boarding UTXOs auto-settle into Ark).
       */
      arkadeGetUnrollFeeAddress: async (): Promise<string> => {
        return await this.getUnrollFeeAddress()
      },

      /**
       * Preflight before Arkade → other-asset swap quotes.
       * Prefers Boltz ARK→BTC (Arkade Wallet path); falls back to ASP settle checks.
       */
      arkadeCheckOnchainSwapEligibility: async (params?: {
        nativeAmount?: string
      }): Promise<ArkadeOnchainSwapEligibility> => {
        return await this.checkOnchainSwapEligibility(params?.nativeAmount)
      }
    }
  }

  async startEngine(): Promise<void> {
    if (this.running) return
    this.running = true
    // Wallet + swaps are created in syncNetwork once Edge supplies private keys
    // (see currencyInfo.unsafeSyncNetwork).
  }

  private async waitForWalletReady(
    timeoutMs: number = ENGINE_START_WAIT_MS
  ): Promise<any> {
    if (this.wallet != null) return this.wallet

    // Prefer waiting on the in-flight init rather than busy-polling.
    if (this.walletInitPromise != null) {
      try {
        await Promise.race([
          this.walletInitPromise,
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('Engine not started')),
              timeoutMs
            )
          })
        ])
      } catch {
        // Fall through to final null check below.
      }
      if (this.wallet != null) return this.wallet
    }

    const deadline = Date.now() + timeoutMs
    while (this.running && Date.now() < deadline) {
      if (this.wallet != null) return this.wallet
      await new Promise(resolve => setTimeout(resolve, ENGINE_START_POLL_MS))
    }

    throw new Error('Engine not started')
  }

  private async waitForSwapsReady(
    timeoutMs: number = ENGINE_START_WAIT_MS
  ): Promise<any> {
    if (this.swaps != null) return this.swaps

    await this.waitForWalletReady(timeoutMs)

    const deadline = Date.now() + timeoutMs
    while (this.running && Date.now() < deadline) {
      if (this.swaps != null) return this.swaps
      await new Promise(resolve => setTimeout(resolve, ENGINE_START_POLL_MS))
    }

    throw new Error('Lightning swaps not ready')
  }

  /**
   * Edge calls this periodically when `unsafeSyncNetwork` is set, passing the
   * encrypted private keys. That is the only place we may read `arkadeMnemonic`.
   */
  async syncNetwork(opts: {
    privateKeys?: JsonObject
  }): Promise<number> {
    if (!this.running) return POLL_MS

    try {
      if (this.wallet == null) {
        if (this.walletInitPromise != null) {
          await this.walletInitPromise
        } else if (opts.privateKeys == null) {
          return POLL_MS
        } else {
          const privateKeys = opts.privateKeys
          this.walletInitPromise = (async () => {
            const { mnemonic } = asArkadePrivateKeys(privateKeys)
            if (mnemonic == null || mnemonic === '') {
              throw new Error('Missing wallet mnemonic')
            }

            const identity = MnemonicIdentity.fromMnemonic(mnemonic)

            const arkServerUrl = resolveArkServerUrl(this.settings)
            const delegatorUrl = resolveDelegatorUrl(this.settings)

            this.wallet = await Wallet.create({
              identity,
              walletMode: 'hd',
              arkServerUrl,
              ...(delegatorUrl != null
                ? { delegatorProvider: new RestDelegatorProvider(delegatorUrl) }
                : {}),
              storage: {
                walletRepository: new WalletRepositoryImpl(this.sdkStorage as any),
                contractRepository: new ArkadeDiskletContractRepository(
                  this.sdkStorage
                ) as any
              }
            })

            // HD wallets in the newer Arkade SDK recover derived contracts and
            // advance their watermark through the built-in gap-limit scan.
            await this.wallet.restore({ gapLimit: 20 })
            // The receive rotator subscribes lazily on first getVtxoManager().
            // Without this, the wallet stays functional but keeps showing the same
            // display address in Edge even after receives.
            await this.wallet.getVtxoManager()

            // HD quirk: first getNextSigningDescriptor() allocates index 0, which is
            // already the baseline display address. Advance the watermark so the
            // first post-receive rotate() produces a *new* address instead of a
            // no-op that only changes after the second payment.
            try {
              const provider = (this.wallet as any)?._descriptorProvider
              if (
                provider?.getLastIndexUsed != null &&
                provider?.advanceLastIndexUsed != null
              ) {
                const lastIndexUsed = await provider.getLastIndexUsed()
                if (lastIndexUsed == null) {
                  await provider.advanceLastIndexUsed(0)
                }
              }
            } catch (error: unknown) {
              console.warn('[arkade] HD watermark bootstrap failed', error)
            }

            // Initialize Boltz swaps with Disklet persistence (no IndexedDB):
            this.swaps = await ArkadeSwaps.create({
              wallet: this.wallet,
              swapRepository: this.swapRepository,
              swapManager: {
                enableAutoActions: true,
                autoStart: true,
                pollInterval: 30_000
              }
            })

            // Cache receive addresses for Request screen:
            this.cachedArkadeAddress = await this.wallet.getAddress()
            this.cachedBoardingAddress = await this.wallet.getBoardingAddress()

            // Stable LNURL session token (arkade-os/wallet compatible):
            this.lnurlSessionToken = deriveLnurlSessionToken(mnemonic, true)

            // Live incoming funds → refresh balance/txs for in-app receive dropdown
            try {
              this.stopIncomingNotify = await this.wallet.notifyIncomingFunds(() => {
                this.poll().catch(() => {})
              })
            } catch {
              // Optional SDK feature; polling still works.
            }

            // Keep LNURL SSE alive for the wallet lifetime (not per Receive open):
            this.ensureLnurlSession().catch(() => {})
          })().finally(() => {
            this.walletInitPromise = undefined
          })

          await this.walletInitPromise
        }
      }

      if (this.wallet == null) return POLL_MS

      await this.poll()
      this.emitter.emit(EngineEvent.ADDRESSES_CHECKED, 1)
    } catch (error) {
      // Surface to Edge core logs; keep retrying on the next tick.
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] syncNetwork failed: ${message}`)
      this.emitter.emit(EngineEvent.ADDRESSES_CHECKED, 0)
      throw error
    }
    return POLL_MS
  }

  async killEngine(): Promise<void> {
    this.running = false
    if (this.pollId != null) clearInterval(this.pollId)
    this.pollId = undefined
    this.walletInitPromise = undefined

    try {
      this.stopIncomingNotify?.()
    } catch {}
    this.stopIncomingNotify = undefined

    this.stopLnurlSession({ clearCached: true })
    this.lnurlSessionToken = undefined

    // SDK wallet has dispose() in some variants; ignore if missing:
    try {
      await this.wallet?.dispose?.()
    } catch {}
    this.wallet = undefined
    this.cachedArkadeAddress = undefined
    this.cachedBoardingAddress = undefined
    this.cachedAspFees = undefined
    this.seenTxids.clear()
    this.historyBootstrapped = false
    // Keep last known balance/txs until the next successful poll so a failed
    // restart does not flash 0 / empty history in the UI.
    this.balanceEmitted = false

    try {
      await this.swaps?.dispose?.()
    } catch {}
    this.swaps = undefined
  }

  async resyncBlockchain(): Promise<void> {
    if (!this.running) {
      this.emitter.emit(EngineEvent.ADDRESSES_CHECKED, 1)
      return
    }
    // ASP refresh can hang on slow networks; resync must return immediately so
    // the wallet menu spinner and sync ratio recover without waiting on poll().
    void this.poll().catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] resync poll failed: ${message}`)
    })
    this.emitter.emit(EngineEvent.ADDRESSES_CHECKED, 1)
  }

  getBlockHeight(): number {
    // Arkade is mostly offchain; expose a non-zero tip so core confirmation
    // math does not mark settled txs as "Syncing..." (1 + 0 - 1 <= 0).
    return this.cachedBlockHeight
  }

  // Token support not used (yet):
  async enableTokens(_tokenIds: string[]): Promise<void> {}
  async disableTokens(_tokenIds: string[]): Promise<void> {}

  getBalance(_opts?: { tokenId?: string | null }): string {
    return this.cachedBalance
  }

  getNumTransactions(_opts?: { tokenId?: string | null }): number {
    return this.cachedTxs.length
  }

  async getTransactions(_opts?: {
    tokenId?: string | null
    startIndex?: number
    numEntries?: number
  }): Promise<EdgeTransaction[]> {
    return this.cachedTxs
  }

  async getAddresses(): Promise<EdgeAddress[]> {
    const addresses: EdgeAddress[] = []

    if (
      this.running &&
      this.wallet == null &&
      (this.cachedBoardingAddress == null || this.cachedArkadeAddress == null)
    ) {
      await this.waitForWalletReady(4_000).catch(() => {})
    }

    // Arkade offchain address (ark1…):
    let arkade: string | undefined
    if (this.wallet != null) {
      arkade = await this.wallet.getAddress()
      this.cachedArkadeAddress = arkade
    } else {
      arkade =
        this.cachedArkadeAddress ??
        (typeof this.walletInfo.keys.publicKey === 'string'
          ? this.walletInfo.keys.publicKey
          : undefined)
    }
    if (arkade != null && arkade !== '') {
      addresses.push({
        addressType: 'publicAddress',
        publicAddress: arkade
      })
    }

    // Onchain boarding address (bc1p…):
    let boarding: string | undefined
    if (this.wallet != null) {
      boarding = await this.wallet.getBoardingAddress()
      this.cachedBoardingAddress = boarding
    } else {
      boarding = this.cachedBoardingAddress
    }
    if (boarding != null && boarding !== '') {
      // boardingAddress for Request UI; segwitAddress so swap getAddress() prefers
      // the onchain bc1p (providers don't accept ark1).
      addresses.push({
        addressType: 'boardingAddress',
        publicAddress: boarding
      })
      addresses.push({
        addressType: 'segwitAddress',
        publicAddress: boarding
      })
    }

    // Amountless LNURL: never start/abort sessions here — that killed live
    // LNURLs ("This LNURL is no longer active"). Session lives with the engine.
    if (this.cachedLnurl != null && this.cachedLnurl !== '') {
      addresses.push({
        addressType: 'lnurlAddress',
        publicAddress: this.cachedLnurl
      })
    } else if (this.swaps != null && !this.lnurlLoopRunning) {
      this.ensureLnurlSession().catch(() => {})
    }

    if (addresses.length === 0) {
      throw new Error('Engine not started')
    }
    return addresses
  }

  async getFreshAddress(): Promise<{
    publicAddress: string
    segwitAddress?: string
    legacyAddress?: string
  }> {
    const wallet = await this.waitForWalletReady()
    const arkade = await wallet.getAddress()
    const boarding = await wallet.getBoardingAddress()

    this.cachedArkadeAddress = arkade
    this.cachedBoardingAddress = boarding
    return {
      // Primary QR: Arkade offchain address
      publicAddress: arkade,
      // Map boarding → segwitAddress so older UI paths still expose onchain BTC
      segwitAddress: boarding
    }
  }

  async addGapLimitAddresses(): Promise<void> {}

  async getMaxSpendable(spendInfo: EdgeSpendInfo): Promise<string> {
    // Arkade offchain / Lightning (via Boltz) — max is available VTXO balance.
    // Boltz fees mean the true max for Lightning may be slightly lower; the
    // swap API will reject if insufficient after fees.
    if (spendInfo.spendTargets.length !== 1) {
      throw new Error('Arkade supports exactly one spendTarget for now')
    }
    const target = spendInfo.spendTargets[0]
    if (target == null) throw new Error('Missing spendTarget')

    const to = target.publicAddress
    if (to == null || to === '') throw new Error('Missing publicAddress')

    if (!isBtcOnchainAddress(to)) return this.cachedBalance

    const balance = BigInt(this.cachedBalance)
    const rawAmount = target.nativeAmount
    const probeAmount =
      rawAmount != null && rawAmount !== ''
        ? Math.abs(Number(rawAmount))
        : Number(this.cachedBalance)

    // Match Arkade Wallet: prefer Boltz ARK→BTC fee when within limits.
    const boltz = await this.tryResolveArkToBtcPath(probeAmount)
    if (boltz != null) {
      const max = balance - BigInt(boltz.feeSats)
      return max > BigInt(0) ? max.toString() : '0'
    }

    let feeInfo: unknown
    try {
      const info =
        this.cachedAspFees != null
          ? { fees: this.cachedAspFees }
          : await this.wallet?.arkProvider?.getInfo?.()
      if (info?.fees != null) this.cachedAspFees = info.fees
      feeInfo = info?.fees
    } catch {}

    // Collaborative settle fallback: fee estimate only. Do not call
    // prepareOnchainExit here — SettlementMinExpiryGap / ASP hangs freeze the
    // send UI while typing amounts. Eligibility is enforced in broadcastTx.
    const amount =
      rawAmount != null && rawAmount !== ''
        ? BigInt(Math.abs(Number(rawAmount)))
        : balance
    const outputFee = this.estimateOnchainOutputFee(to, amount, feeInfo)
    const max = balance - outputFee
    return max > BigInt(0) ? max.toString() : '0'
  }

  private attachSpendInfoMetadata(
    tx: EdgeTransaction,
    spendInfo: EdgeSpendInfo
  ): EdgeTransaction {
    return {
      ...tx,
      memos: spendInfo.memos ?? tx.memos,
      savedAction: spendInfo.savedAction ?? tx.savedAction,
      assetAction: spendInfo.assetAction ?? tx.assetAction,
      tokenId:
        spendInfo.tokenId !== undefined ? spendInfo.tokenId : tx.tokenId
    }
  }

  async makeSpend(spendInfo: EdgeSpendInfo): Promise<EdgeTransaction> {
    if (spendInfo.spendTargets.length !== 1) {
      throw new Error('Arkade supports exactly one spendTarget for now')
    }
    const target = spendInfo.spendTargets[0]
    if (target == null) throw new Error('Missing spendTarget')
    const to = target.publicAddress
    if (to == null || to === '') throw new Error('Missing publicAddress')

    // Arkade sends can otherwise reach the confirm slider before the SDK wallet
    // is initialized, then fail later in broadcastTx with "Engine not started".
    await this.waitForWalletReady()

    // --- Lightning invoice (Boltz submarine swap) ---
    if (isBolt11Invoice(to)) {
      await this.waitForSwapsReady()
      const decoded = decodeInvoice(to)
      let amount =
        decoded.amountSats > 0
          ? decoded.amountSats
          : Math.abs(Number(target.nativeAmount ?? 0))
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Amount required for this Lightning invoice')
      }
      if (amount > Number(this.cachedBalance)) {
        throw new Error('Insufficient funds')
      }
      const lightningFee = await this.tryEstimateLightningFee(amount)
      if (amount + lightningFee > Number(this.cachedBalance)) {
        throw new Error('Insufficient funds')
      }

      return this.attachSpendInfoMetadata(
        {
          blockHeight: 0,
          currencyCode: arkadeCurrencyInfo.currencyCode,
          date: Math.floor(Date.now() / 1000),
          isSend: true,
          memos: [],
          metadata:
            decoded.description !== ''
              ? { name: decoded.description }
              : undefined,
          nativeAmount: String(-amount),
          networkFee: String(lightningFee),
          networkFees: [],
          otherParams: {
            paymentType: 'lightning',
            invoice: to,
            amount: String(amount)
          },
          ourReceiveAddresses: [],
          signedTx: '',
          tokenId: null,
          txid: '',
          walletId: this.walletInfo.id
        },
        spendInfo
      )
    }

    // --- Arkade offchain address ---
    if (isValidArkAddress(to)) {
      if (target.nativeAmount == null) throw new Error('Missing nativeAmount')

      const amount = Math.abs(Number(target.nativeAmount))
      if (!Number.isFinite(amount)) throw new Error('Invalid nativeAmount')
      if (amount > Number(this.cachedBalance)) {
        throw new Error('Insufficient funds')
      }

      return this.attachSpendInfoMetadata(
        {
          blockHeight: 0,
          currencyCode: arkadeCurrencyInfo.currencyCode,
          date: Math.floor(Date.now() / 1000),
          isSend: true,
          memos: [],
          nativeAmount: String(-amount),
          networkFee: '0',
          networkFees: [],
          otherParams: {
            paymentType: 'arkade',
            to,
            amount: String(amount)
          },
          ourReceiveAddresses: [],
          signedTx: '',
          tokenId: null,
          txid: '',
          walletId: this.walletInfo.id
        },
        spendInfo
      )
    }

    // --- Onchain Bitcoin (Arkade Wallet: Boltz arkToBtc, settle fallback) ---
    if (isBtcOnchainAddress(to)) {
      if (target.nativeAmount == null) {
        const err = new Error('Unable to create zero-amount transaction.')
        err.name = 'NoAmountSpecifiedError'
        throw err
      }
      const amount = Math.abs(Number(target.nativeAmount))
      if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Unable to create zero-amount transaction.')
        err.name = 'NoAmountSpecifiedError'
        throw err
      }
      if (amount > Number(this.cachedBalance)) {
        throw new Error('Insufficient funds')
      }

      const isSwapQuote = spendInfo.savedAction?.actionType === 'swap'
      const boltz = await this.tryResolveArkToBtcPath(amount)

      if (boltz != null) {
        if (amount + boltz.feeSats > Number(this.cachedBalance)) {
          throw new Error('Insufficient funds')
        }
        console.warn(
          `[arkade onchain] makeSpend via Boltz arkToBtc amount=${amount} fee=${boltz.feeSats} to=${to} quote=${isSwapQuote}`
        )
        return this.attachSpendInfoMetadata(
          {
            blockHeight: 0,
            currencyCode: arkadeCurrencyInfo.currencyCode,
            date: Math.floor(Date.now() / 1000),
            isSend: true,
            memos: [],
            nativeAmount: String(-amount),
            networkFee: String(boltz.feeSats),
            networkFees: [],
            otherParams: {
              paymentType: 'onchain_boltz',
              to,
              amount: String(amount)
            },
            ourReceiveAddresses: [],
            signedTx: '',
            tokenId: null,
            txid: '',
            walletId: this.walletInfo.id
          },
          spendInfo
        )
      }

      let feeInfo: unknown
      try {
        const info =
          this.cachedAspFees != null
            ? { fees: this.cachedAspFees }
            : await this.wallet?.arkProvider?.getInfo?.()
        if (info?.fees != null) this.cachedAspFees = info.fees
        feeInfo = info?.fees
      } catch {}

      // Collaborative settle fallback only when Boltz is unavailable / out of
      // limits. Fee estimate only — prepareOnchainExit here surfaces
      // SettlementMinExpiryGap ("VTXO too fresh") and can hang the send UI
      // before slide-to-confirm. Real eligibility runs in broadcastTx.
      const outputFee = this.estimateOnchainOutputFee(
        to,
        BigInt(amount),
        feeInfo
      )
      console.warn(
        `[arkade onchain] makeSpend via ASP settle fallback amount=${amount} fee=${outputFee.toString()} to=${to} quote=${isSwapQuote}`
      )

      return this.attachSpendInfoMetadata(
        {
          blockHeight: 0,
          currencyCode: arkadeCurrencyInfo.currencyCode,
          date: Math.floor(Date.now() / 1000),
          isSend: true,
          memos: [],
          nativeAmount: String(-amount),
          networkFee: outputFee.toString(),
          networkFees: [],
          otherParams: {
            paymentType: 'onchain',
            to,
            amount: String(amount)
          },
          ourReceiveAddresses: [],
          signedTx: '',
          tokenId: null,
          txid: '',
          walletId: this.walletInfo.id
        },
        spendInfo
      )
    }

    throw new Error('Invalid Arkade address')
  }

  async signTx(tx: EdgeTransaction): Promise<EdgeTransaction> {
    // SDK / Boltz signing happens inside broadcastTx.
    return tx
  }

  async broadcastTx(tx: EdgeTransaction): Promise<EdgeTransaction> {
    const paymentType = (tx.otherParams as { paymentType?: string } | undefined)
      ?.paymentType

    if (paymentType === 'lightning') {
      const swaps = await this.waitForSwapsReady()
      const invoice = (tx.otherParams as { invoice?: string }).invoice
      if (invoice == null || invoice === '') {
        throw new Error('Missing Lightning invoice')
      }
      try {
        const result = await swaps.sendLightningPayment({ invoice })
        const out: EdgeTransaction = {
          ...tx,
          txid: String(result.txid ?? '')
        }
        await this.poll()
        return out
      } catch (error: unknown) {
        // Surface Boltz / swap messages instead of a generic "Unexpected error"
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
            ? error
            : 'Lightning payment failed'
        throw new Error(message)
      }
    }

    const wallet = await this.waitForWalletReady()

    const to = (tx.otherParams as { to?: string } | undefined)?.to
    const amount = Number(
      (tx.otherParams as { amount?: string } | undefined)?.amount
    )
    if (typeof to !== 'string' || !Number.isFinite(amount)) {
      throw new Error('Invalid spend parameters')
    }

    try {
      if (paymentType === 'onchain_boltz') {
        const result = await this.payOnchainViaBoltz(to, amount)
        const priorNotes =
          typeof tx.metadata?.notes === 'string' ? tx.metadata.notes.trim() : ''
        const boltzNote = `Boltz: ${result.boltzSwapId}`
        const out: EdgeTransaction = {
          ...tx,
          txid: result.txid,
          metadata: {
            ...tx.metadata,
            notes:
              priorNotes === ''
                ? boltzNote
                : priorNotes.includes(result.boltzSwapId)
                ? priorNotes
                : `${priorNotes}\n${boltzNote}`
          },
          otherParams: {
            ...(tx.otherParams as object),
            paymentType: 'onchain_boltz',
            boltzSwapId: result.boltzSwapId,
            boltzClaimTxid: result.claimTxid,
            to,
            amount: String(amount)
          }
        }
        await this.poll()
        return out
      }

      if (paymentType === 'onchain') {
        const txid = await this.collaborativeExitToOnchain(to, amount)
        const out: EdgeTransaction = { ...tx, txid }
        await this.poll()
        return out
      }

      const arkTxId = await this.sendOffchainWithRecovery(wallet, {
        address: to,
        amount
      })
      const out: EdgeTransaction = { ...tx, txid: arkTxId }
      await this.poll()
      return out
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
          ? error
          : paymentType === 'onchain_boltz'
          ? 'Boltz ARK→BTC swap failed'
          : paymentType === 'onchain'
          ? 'Onchain exit failed'
          : 'Arkade send failed'
      throw new Error(message)
    }
  }

  async saveTx(_tx: EdgeTransaction): Promise<void> {}

  async sweepPrivateKeys(_opts: any): Promise<EdgeTransaction> {
    throw new Error('Unsupported')
  }

  async dumpData(): Promise<EdgeDataDump> {
    const out: EdgeDataDump = {
      walletId: this.walletInfo.id,
      walletType: this.currencyInfo.walletType,
      data: {}
    }
    return out
  }

  async changeUserSettings(userSettings: JsonObject): Promise<void> {
    const newSettings = asArkadeSettings({
      ...arkadeCurrencyInfo.defaultSettings,
      ...userSettings
    })
    this.settings = newSettings

    // Drop the live wallet so the next syncNetwork recreates it with the new
    // operator / delegator URLs (private keys arrive again via unsafeSyncNetwork).
    try {
      this.stopIncomingNotify?.()
    } catch {}
    this.stopIncomingNotify = undefined
    this.stopLnurlSession({ clearCached: false })
    try {
      await this.wallet?.dispose?.()
    } catch {}
    this.wallet = undefined
    try {
      await this.swaps?.dispose?.()
    } catch {}
    this.swaps = undefined
  }

  async isAddressUsed(_address: string): Promise<boolean> {
    // Arkade addresses are derived from wallet identity. We don't track per-address
    // usage yet, so conservatively return true to avoid reusing addresses.
    return true
  }

  // ---------------------------------------------------------------------------

  /**
   * Boltz ARK→BTC fee — same formula as Arkade Wallet `calcArkToBtcSwapFee`.
   */
  private calcArkToBtcSwapFee(
    receiverAmountSats: number,
    fees: {
      percentage: number
      minerFees: { server: number; user: { claim: number } }
    }
  ): number {
    const { percentage, minerFees } = fees
    return Math.ceil(
      (receiverAmountSats * percentage) / 100 +
        minerFees.server +
        minerFees.user.claim
    )
  }

  private calcLightningSubmarineFee(
    amountSats: number,
    fees: {
      percentage: number
      minerFees: number
    }
  ): number {
    return Math.ceil((amountSats * fees.percentage) / 100 + fees.minerFees)
  }

  private async tryEstimateLightningFee(amountSats: number): Promise<number> {
    if (
      this.swaps == null ||
      !Number.isFinite(amountSats) ||
      amountSats <= 0
    ) {
      return 0
    }
    try {
      const fees = await this.swaps.getFees()
      if (fees?.submarine == null) return 0
      return this.calcLightningSubmarineFee(amountSats, fees.submarine)
    } catch {
      return 0
    }
  }

  private async sendOffchainWithRecovery(
    wallet: any,
    params: { address: string; amount: number },
    timeoutMs: number = 45_000
  ): Promise<string> {
    try {
      await wallet.finalizePendingTxs?.()
    } catch (error: unknown) {
      console.warn('[arkade] finalizePendingTxs before send failed', error)
    }

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'Arkade send timed out while waiting for the operator to finalize the transaction'
          )
        )
      }, timeoutMs)

      wallet
        .send(params)
        .then((txid: unknown) => {
          clearTimeout(timer)
          resolve(String(txid ?? ''))
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  private async getCachedSdkVtxos(wallet: any): Promise<any[]> {
    try {
      const address = await wallet.getAddress()
      const cached = await wallet.walletRepository?.getVtxos?.(address)
      return Array.isArray(cached) ? cached : []
    } catch {
      return []
    }
  }

  private async getCachedSdkHistory(wallet: any): Promise<any[]> {
    try {
      const address = await wallet.getAddress()
      const cached = await wallet.walletRepository?.getTransactionHistory?.(address)
      return Array.isArray(cached) ? cached : []
    } catch {
      return []
    }
  }

  private async getFallbackBalance(wallet: any): Promise<string> {
    const vtxos = await this.getCachedSdkVtxos(wallet)
    let total = 0
    for (const vtxo of vtxos) {
      if (vtxo?.isSpent === true) continue
      const state = String(vtxo?.virtualStatus?.state ?? '')
      if (state === 'swept') continue
      total += Number(vtxo?.value ?? 0)
    }
    return String(total)
  }

  /**
   * Resolve Boltz chain-swap path when amount is within ARK→BTC limits.
   * Returns null → caller should fall back to ASP collaborative settle
   * (same as Arkade Wallet: Boltz first, settle if out of limits / unavailable).
   */
  private boltzArkToBtcCache:
    | {
        at: number
        limits: { min: number; max: number }
        fees: {
          percentage: number
          minerFees: { server: number; user: { claim: number } }
        }
      }
    | undefined

  private async tryResolveArkToBtcPath(
    receiverAmountSats: number
  ): Promise<{ feeSats: number } | null> {
    if (!Number.isFinite(receiverAmountSats) || receiverAmountSats <= 0) {
      return null
    }
    // makeSpend can run before Boltz init finishes; wait briefly so we do not
    // fall through to ASP settle (which fails on fresh VTXOs).
    if (this.swaps == null) {
      try {
        await this.waitForSwapsReady(15_000)
      } catch {
        return null
      }
    }
    if (this.swaps == null) return null
    try {
      const CACHE_MS = 30_000
      const now = Date.now()
      if (
        this.boltzArkToBtcCache == null ||
        now - this.boltzArkToBtcCache.at > CACHE_MS
      ) {
        const limits = await this.swaps.getLimits('ARK', 'BTC')
        const fees = await this.swaps.getFees('ARK', 'BTC')
        if (limits == null || fees?.percentage == null || fees.minerFees == null) {
          return null
        }
        this.boltzArkToBtcCache = {
          at: now,
          limits: { min: Number(limits.min), max: Number(limits.max) },
          fees
        }
      }

      const { limits, fees } = this.boltzArkToBtcCache
      if (limits.max === 0) return null
      if (receiverAmountSats < limits.min) return null
      if (limits.max > 0 && receiverAmountSats > limits.max) return null

      return {
        feeSats: this.calcArkToBtcSwapFee(receiverAmountSats, fees)
      }
    } catch (error: unknown) {
      console.warn(
        '[arkade] Boltz arkToBtc unavailable, falling back to collaborative exit',
        error
      )
      return null
    }
  }

  /**
   * Arkade Wallet `payBtc`: create chain swap → fund ARK lockup offchain →
   * claim BTC on L1 via Boltz.
   *
   * Edge txid MUST be the Ark fund tx (matches SDK history). Boltz's
   * waitForSwapCompletion returns the swap id for chain swaps — never use that
   * as Edge txid (it creates a duplicate phantom row that vanishes on resync).
   *
   * Claim completion can take minutes. Do not block Edge `broadcastTx` /
   * slide-to-confirm on `waitAndClaimBtc` — that freezes the send slider.
   * After a successful fund, return immediately and finish the claim in
   * background (swap state is persisted in the Disklet swap repo).
   */
  private async payOnchainViaBoltz(
    btcAddress: string,
    receiverAmountSats: number
  ): Promise<{
    txid: string
    boltzSwapId: string
    claimTxid: string
  }> {
    const swaps = await this.waitForSwapsReady()
    const wallet = await this.waitForWalletReady()

    const result = await swaps.arkToBtc({
      btcAddress,
      receiverLockAmount: receiverAmountSats
    })
    if (result?.arkAddress == null || result.amountToPay == null) {
      throw new Error('Boltz arkToBtc returned incomplete swap details')
    }
    const boltzSwapId = String(result.pendingSwap?.id ?? '')
    if (boltzSwapId === '') {
      throw new Error('Boltz arkToBtc missing swap id')
    }

    // Timed offchain send — raw wallet.send can hang forever on ASP finalize.
    const fundTxid = await this.sendOffchainWithRecovery(wallet, {
      address: result.arkAddress,
      amount: result.amountToPay
    })
    if (fundTxid === '') {
      throw new Error('Failed to fund Boltz ARK lockup')
    }

    const pendingSwap = result.pendingSwap
    const claimPromise = (async (): Promise<string> => {
      // Return value is the Boltz swap id for chain swaps — ignore as txid.
      await swaps.waitAndClaimBtc(pendingSwap)
      try {
        const status = await swaps.getSwapStatus(boltzSwapId)
        return String(status?.transaction?.id ?? '')
      } catch {
        return ''
      }
    })()

    // Brief window so fast claims still attach claimTxid; then release the UI.
    const CLAIM_UI_BUDGET_MS = 20_000
    let claimTxid = ''
    try {
      const raced = await Promise.race([
        claimPromise.then(id => ({ done: true as const, id })),
        new Promise<{ done: false }>(resolve =>
          setTimeout(() => resolve({ done: false }), CLAIM_UI_BUDGET_MS)
        )
      ])
      if (raced.done) {
        claimTxid = raced.id
      } else {
        console.warn(
          `[arkade] Boltz claim still pending after ${CLAIM_UI_BUDGET_MS}ms; continuing in background swapId=${boltzSwapId}`
        )
      }
    } catch (error: unknown) {
      // Fund already succeeded — do not fail broadcastTx / stick the slider.
      console.warn(
        '[arkade] Boltz waitAndClaimBtc error after fund; claim may still complete',
        error
      )
    }

    void claimPromise
      .then(async id => {
        if (id !== '') {
          console.warn(`[arkade] Boltz claim completed claimTxid=${id}`)
        }
        try {
          await this.poll()
        } catch {}
      })
      .catch((error: unknown) => {
        console.warn('[arkade] Boltz background claim failed', error)
      })

    return { txid: fundTxid, boltzSwapId, claimTxid }
  }

  /**
   * Ark → onchain BTC collaborative exit (ASP settle).
   *
   * Fallback when Boltz chain swap is unavailable or amount is outside limits.
   * Do NOT settle with all VTXOs for partial exits: one ineligible input blocks
   * everything. Select only enough VTXOs, preferring
   * those that expire soonest — arkade.computer SettlementMinExpiryGap rejects
   * VTXOs that expire *after* now+gap (~29d), i.e. "too fresh", not too old.
   */
  private async collaborativeExitToOnchain(
    address: string,
    amount: number
  ): Promise<string> {
    const wallet = await this.waitForWalletReady()
    const arkProvider = wallet.arkProvider
    if (arkProvider?.getInfo == null) {
      throw new Error('Arkade provider unavailable')
    }

    const info = await arkProvider.getInfo()
    try {
      return await this.settleOnchainExit(address, BigInt(amount), info.fees)
    } catch (error: unknown) {
      throw new Error(this.formatOnchainExitError(error))
    }
  }

  /**
   * Shared collaborative exit path used for both partial and full-wallet offboard.
   *
   * Do NOT settle with all VTXOs blindly: one ineligible input blocks everything.
   * Select only enough VTXOs, preferring
   * those that expire soonest — arkade.computer SettlementMinExpiryGap rejects
   * VTXOs that expire *after* now+gap (~29d), i.e. "too fresh", not too old.
   */
  private async settleOnchainExit(
    destinationAddress: string,
    amount: bigint | undefined,
    feeInfo: unknown
  ): Promise<string> {
    const wallet = await this.waitForWalletReady()
    const { change, selected, sendAmount } = await this.prepareOnchainExit(
      destinationAddress,
      amount,
      feeInfo
    )
    const outputs: Array<{ address: string; amount: bigint }> = [
      { address: destinationAddress, amount: sendAmount }
    ]
    if (change > BigInt(0)) {
      const offchainAddress = await this.wallet.getAddress()
      outputs.push({ address: offchainAddress, amount: change })
    }
    // Match Arkade Wallet: change first when present.
    outputs.reverse()

    return await this.wallet.settle({ inputs: selected, outputs })
  }

  private estimateOnchainOutputFee(
    destinationAddress: string,
    amount: bigint,
    feeInfo: unknown
  ): bigint {
    const estimator = new Estimator(
      (feeInfo as { intentFee?: object } | null)?.intentFee ?? {}
    )
    const destinationScript = this.getOnchainOutputScript(destinationAddress)
    return BigInt(
      estimator.evalOnchainOutput({
        amount,
        script: destinationScript
      }).satoshis
    )
  }

  private async prepareOnchainExit(
    destinationAddress: string,
    amount: bigint | undefined,
    feeInfo: unknown
  ): Promise<{
    change: bigint
    outputFee: bigint
    selected: any[]
    sendAmount: bigint
  }> {
    const wallet = await this.waitForWalletReady()
    const eligible = await this.getEligibleOnchainExitVtxos(wallet)
    const estimator = new Estimator(
      (feeInfo as { intentFee?: object } | null)?.intentFee ?? {}
    )
    const evalOutputFee = (value: bigint): bigint =>
      this.estimateOnchainOutputFee(destinationAddress, value, feeInfo)

    const selected: any[] = []
    let selectedNet = BigInt(0)

    if (amount == null) {
      for (const vtxo of eligible) {
        const inputFee = estimator.evalOffchainInput({
          amount: BigInt(vtxo.value),
          type:
            vtxo.virtualStatus?.state === 'swept' ? 'recoverable' : 'vtxo',
          weight: 0,
          birth: vtxo.createdAt,
          expiry: vtxo.virtualStatus?.batchExpiry
            ? new Date(Number(vtxo.virtualStatus.batchExpiry))
            : undefined
        })
        if (BigInt(inputFee.satoshis) >= BigInt(vtxo.value)) continue
        selected.push(vtxo)
        selectedNet += BigInt(vtxo.value) - BigInt(inputFee.satoshis)
      }
      if (selected.length === 0) {
        throw new Error('No vtxos available after deducting fees')
      }
      const outputFee = evalOutputFee(selectedNet)
      if (outputFee >= selectedNet) {
        throw new Error('Amount too small to cover onchain exit fee')
      }
      return {
        change: BigInt(0),
        outputFee,
        selected,
        sendAmount: selectedNet - outputFee
      }
    }

    const outputFee = evalOutputFee(amount)
    const required = amount + outputFee

    for (const vtxo of eligible) {
      if (selectedNet >= required) break
      const inputFee = estimator.evalOffchainInput({
        amount: BigInt(vtxo.value),
        type: vtxo.virtualStatus?.state === 'swept' ? 'recoverable' : 'vtxo',
        weight: 0,
        birth: vtxo.createdAt,
        expiry: vtxo.virtualStatus?.batchExpiry
          ? new Date(Number(vtxo.virtualStatus.batchExpiry))
          : undefined
      })
      if (BigInt(inputFee.satoshis) >= BigInt(vtxo.value)) continue
      selected.push(vtxo)
      selectedNet += BigInt(vtxo.value) - BigInt(inputFee.satoshis)
    }

    if (selected.length === 0) {
      throw new Error('No vtxos available after deducting fees')
    }
    if (selectedNet < required) {
      throw new Error(
        'Insufficient eligible VTXOs for onchain exit (some are too fresh for ASP). ' +
          'Try a smaller amount later, or wait until more funds age into the settlement window.'
      )
    }

    return {
      change: selectedNet - required,
      outputFee,
      selected,
      sendAmount: amount
    }
  }

  private async getEligibleOnchainExitVtxos(wallet: any): Promise<any[]> {
    const vtxos = await wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    })
    if (vtxos.length === 0) throw new Error('No funds available to exit')

    // arkd: reject if expiresAt > now + SettlementMinExpiryGap (~29d on mainnet).
    // Prefer VTXOs that expire soonest and still within that window.
    const nowMs = Date.now()
    // Gap is not in GetInfo; use a conservative 28d window (ASP error showed ~695h).
    const maxExpiryMs = nowMs + 28 * 24 * 60 * 60 * 1000
    const byExpiry = [...vtxos].sort((a: any, b: any) => {
      const ae = Number(a.virtualStatus?.batchExpiry ?? 0)
      const be = Number(b.virtualStatus?.batchExpiry ?? 0)
      return ae - be
    })
    const eligible = byExpiry.filter((v: any) => {
      const exp = Number(v.virtualStatus?.batchExpiry ?? 0)
      // Missing expiry → allow; otherwise must expire on/before the gap limit.
      return exp <= 0 || exp <= maxExpiryMs
    })
    if (eligible.length === 0) {
      throw new Error(
        'Arkade ASP SettlementMinExpiryGap: these VTXOs are still too fresh ' +
          'for collaborative onchain exit (expiry too far in the future). ' +
          'Offchain sends still work. Wait until the batch is closer to expiry ' +
          '(~within 28 days), then try again. Funds are safe.'
      )
    }
    return eligible
  }

  private async checkOnchainSwapEligibility(
    nativeAmount?: string
  ): Promise<ArkadeOnchainSwapEligibility> {
    try {
      await this.waitForWalletReady()

      const amountStr = nativeAmount?.trim()
      const hasAmount =
        amountStr != null && amountStr !== '' && amountStr !== '0'
      const amount = hasAmount ? Number(amountStr) : undefined

      // Prefer Boltz ARK→BTC (same as Arkade Wallet send-to-mainnet).
      // Offchain lockup avoids ASP SettlementMinExpiryGap.
      if (amount == null || !Number.isFinite(amount) || amount <= 0) {
        const boltzProbe = await this.tryResolveArkToBtcPath(
          Math.max(1, Math.floor(Number(this.cachedBalance) / 2) || 1)
        )
        if (boltzProbe != null || this.swaps != null) {
          // Swaps initialized: typical swap amounts go via Boltz when in limits.
          // Without a concrete amount, allow quote discovery; makeSpend will
          // fall back to settle per-quote if out of Boltz limits.
          try {
            if (this.swaps != null) {
              const limits = await this.swaps.getLimits('ARK', 'BTC')
              if (limits != null && limits.max !== 0) {
                return { eligible: true, code: 'ok', message: '' }
              }
            }
          } catch {}
        }
      } else {
        const boltz = await this.tryResolveArkToBtcPath(amount)
        if (boltz != null) {
          if (amount + boltz.feeSats > Number(this.cachedBalance)) {
            return {
              eligible: false,
              code: 'insufficient_vtxos',
              message:
                'Insufficient funds for Boltz ARK→BTC chain swap (amount + fees).'
            }
          }
          return { eligible: true, code: 'ok', message: '' }
        }
      }

      // Fallback: ASP collaborative settle eligibility
      const wallet = await this.waitForWalletReady()
      await this.getEligibleOnchainExitVtxos(wallet)

      if (hasAmount && amount != null && amount > 0) {
        const boardingAddress = await wallet.getBoardingAddress()
        let feeInfo: unknown
        try {
          const info =
            this.cachedAspFees != null
              ? { fees: this.cachedAspFees }
              : await wallet.arkProvider?.getInfo?.()
          if (info?.fees != null) this.cachedAspFees = info.fees
          feeInfo = info?.fees
        } catch {}

        await this.prepareOnchainExit(
          boardingAddress,
          BigInt(amount),
          feeInfo
        )
      }

      return { eligible: true, code: 'ok', message: '' }
    } catch (error: unknown) {
      const message = this.formatOnchainExitError(error)
      const lower = message.toLowerCase()

      if (/settlementminexpirygap|expiry too far in the future|too fresh/i.test(lower)) {
        return {
          eligible: false,
          code: 'settlement_min_expiry_gap',
          message
        }
      }
      if (/no funds available/i.test(lower)) {
        return { eligible: false, code: 'no_funds', message }
      }
      if (/insufficient eligible vtxos/i.test(lower)) {
        return { eligible: false, code: 'insufficient_vtxos', message }
      }
      if (/amount too small|too small to cover/i.test(lower)) {
        return { eligible: false, code: 'amount_too_small', message }
      }
      if (/engine not started/i.test(lower)) {
        return { eligible: false, code: 'engine_not_started', message }
      }

      return { eligible: false, code: 'unknown', message }
    }
  }

  /**
   * Conservative parent vsize for a TREE / checkpoint unroll tx when the
   * Arklabs indexer is unavailable (no virtual PSBT to measure).
   */
  private static readonly UNROLL_PARENT_VSIZE = 160
  /** Assumed off-chain packages still needing broadcast per VTXO (TREE + checkpoint). */
  private static readonly UNROLL_PACKAGES_PER_VTXO = 2
  /** Fallback CPFP child vsize if boarding address / OnchainWallet is unavailable. */
  private static readonly UNROLL_CHILD_VSIZE_FALLBACK = 110
  /** Mempool fee-rate floor when explorer is unreachable (sat/vB). */
  private static readonly UNILATERAL_FEE_RATE_FALLBACK = 5
  /** Minimum interval between unroll artifact prefetches. */
  private static readonly UNROLL_PREFETCH_MIN_MS = 12 * 60 * 1000

  /**
   * Fee estimate for Unilateral Exit without Arklabs indexer/ASP.
   * Uses local VTXO tapTrees + a conservative unroll package heuristic and
   * Bitcoin mempool fee rates (or a local default).
   */
  private async estimateUnilateralExitFees(
    destinationAddress: string
  ): Promise<ArkadeUnilateralExitEstimate> {
    const wallet = await this.waitForWalletReady(8_000).catch(() => this.wallet)
    const vtxos = await this.getVtxosForUnilateralEstimate(wallet)
    if (vtxos.length === 0) {
      throw new Error('No funds available to exit')
    }

    let grossAmountSats = BigInt(0)
    for (const vtxo of vtxos) {
      grossAmountSats += BigInt(vtxo.value)
    }

    const network = wallet?.network ?? networks.bitcoin

    let feeRate = ArkadeEngine.UNILATERAL_FEE_RATE_FALLBACK
    try {
      const provider = wallet?.onchainProvider
      if (provider?.getFeeRate != null) {
        const live = await provider.getFeeRate()
        if (live != null && Number.isFinite(live) && live > 0) {
          feeRate = live
        }
      }
    } catch {
      // Bitcoin explorer unreachable — keep local fallback.
    }
    const minRate = OnchainWallet.MIN_FEE_RATE ?? 1
    if (feeRate < minRate) feeRate = minRate

    const timelockBlocks = this.estimateTimelockBlocksFromVtxos(vtxos)

    let boardingAddress: string | undefined
    try {
      if (wallet != null) {
        const onchainWallet = await OnchainWallet.create(
          wallet.identity,
          wallet.networkName,
          wallet.onchainProvider
        )
        boardingAddress = onchainWallet.address
      }
    } catch {
      // Estimate CPFP child with fixed vsize fallback.
    }

    let totalVBytes = 0
    let estimatedFeeSats = BigInt(0)

    for (const vtxo of vtxos) {
      const bump = this.estimateUnrollBumpFeesLocal(
        vtxo,
        feeRate,
        network,
        boardingAddress
      )
      totalVBytes += bump.vBytes
      estimatedFeeSats += bump.feeSats
    }

    let sweepVBytes = 50 + vtxos.length * 200
    try {
      if (network != null) {
        sweepVBytes = this.estimateSweepVBytes(
          vtxos,
          destinationAddress,
          network
        )
      }
    } catch (error: unknown) {
      console.warn('[arkade] local sweep vsize estimate failed', error)
    }
    totalVBytes += sweepVBytes
    const sweepFee = BigInt(Math.ceil(feeRate * sweepVBytes))
    estimatedFeeSats += sweepFee

    const netAmountSats =
      estimatedFeeSats >= grossAmountSats
        ? BigInt(0)
        : grossAmountSats - estimatedFeeSats
    const feeRatio =
      grossAmountSats > BigInt(0)
        ? Number(estimatedFeeSats) / Number(grossAmountSats)
        : 0

    return {
      grossAmountSats: grossAmountSats.toString(),
      estimatedFeeSats: estimatedFeeSats.toString(),
      netAmountSats: netAmountSats.toString(),
      feeRatio,
      vBytes: totalVBytes,
      feeRateSatvB: feeRate,
      timelockBlocks,
      uneconomical: estimatedFeeSats >= grossAmountSats,
      highFeeImpact: feeRatio > 0.2 && netAmountSats > BigInt(0)
    }
  }

  private async getVtxosForUnilateralEstimate(wallet: any): Promise<any[]> {
    const filterSpent = (list: any[]): any[] =>
      list.filter(vtxo => {
        if (vtxo?.isSpent === true) return false
        const state = String(vtxo?.virtualStatus?.state ?? '')
        if (state === 'swept') return false
        if (vtxo?.isUnrolled === true) return false
        return true
      })

    if (wallet != null) {
      try {
        const live = await wallet.getVtxos({
          withRecoverable: true,
          withUnrolled: false
        })
        if (Array.isArray(live) && live.length > 0) {
          return filterSpent(live)
        }
      } catch (error: unknown) {
        console.warn(
          '[arkade] getVtxos for unilateral estimate failed; using cache',
          error
        )
      }
      const cached = filterSpent(await this.getCachedSdkVtxos(wallet))
      if (cached.length > 0) return cached
    }

    throw new Error(
      'No local VTXOs available for exit estimate. Wait for the wallet to finish loading, then try again.'
    )
  }

  private estimateTimelockBlocksFromVtxos(vtxos: any[]): number {
    let timelockBlocks = 144
    for (const vtxo of vtxos) {
      try {
        if (vtxo?.tapTree == null) continue
        const decoded = VtxoScript.decode(vtxo.tapTree)
        const exits = decoded.exitPaths()
        const exit =
          exits.find(
            (path: { params: { timelock: { type: string; value?: bigint } } }) =>
              path.params.timelock.type === 'blocks'
          ) ?? exits[0]
        const value = exit?.params?.timelock?.value
        if (value != null && value > BigInt(0) && value < BigInt(512)) {
          timelockBlocks = Number(value)
          break
        }
      } catch {
        // Try next VTXO.
      }
    }
    return timelockBlocks
  }

  /**
   * Local unroll package fee estimate — no indexer / ASP.
   * Conservative: assume TREE + checkpoint packages still need CPFP broadcast.
   */
  private estimateUnrollBumpFeesLocal(
    vtxo: any,
    feeRate: number,
    network: typeof networks.bitcoin,
    boardingAddress: string | undefined
  ): { feeSats: bigint; vBytes: number } {
    const state = String(vtxo?.virtualStatus?.state ?? '')
    if (vtxo?.isUnrolled === true || state === 'swept') {
      return { feeSats: BigInt(0), vBytes: 0 }
    }

    let childVsize = ArkadeEngine.UNROLL_CHILD_VSIZE_FALLBACK
    if (boardingAddress != null && network != null) {
      try {
        childVsize = Number(
          TxWeightEstimator.create()
            .addKeySpendInput(true)
            .addP2AInput()
            .addOutputAddress(boardingAddress, network)
            .vsize().value
        )
      } catch {
        // Keep fallback child size.
      }
    }

    const packageVsize =
      ArkadeEngine.UNROLL_PARENT_VSIZE + childVsize
    const packages = ArkadeEngine.UNROLL_PACKAGES_PER_VTXO
    const vBytes = packageVsize * packages
    const feeSats = BigInt(Math.ceil(feeRate * vBytes))
    return { feeSats, vBytes }
  }

  private estimateSweepVBytes(
    vtxos: any[],
    destinationAddress: string,
    network: typeof networks.mainnet
  ): number {
    const estimator = TxWeightEstimator.create()
    for (const vtxo of vtxos) {
      const decoded = VtxoScript.decode(vtxo.tapTree)
      const exits = decoded.exitPaths()
      const exit =
        exits.find(
          (path: { params: { timelock: { type: string } } }) =>
            path.params.timelock.type === 'blocks'
        ) ?? exits[0]
      if (exit == null) continue
      const spendingLeaf = decoded.findLeaf(hex.encode(exit.script))
      if (spendingLeaf == null) continue
      estimator.addTapscriptInput(
        64,
        spendingLeaf[1].length,
        TaprootControlBlock.encode(spendingLeaf[0]).length
      )
    }
    estimator.addOutputAddress(destinationAddress, network)
    return Number(estimator.vsize().value)
  }

  private async getUnrollFeeAddress(): Promise<string> {
    const wallet = await this.waitForWalletReady(8_000).catch(() => this.wallet)
    if (wallet == null) {
      throw new Error('Engine not started')
    }
    const onchainWallet = await OnchainWallet.create(
      wallet.identity,
      wallet.networkName,
      wallet.onchainProvider
    )
    const address = String(onchainWallet.address ?? '')
    if (address === '') {
      throw new Error('Could not derive Unroll fee address')
    }
    return address
  }

  private async prepareUnilateralExitPackage(
    destinationAddress: string
  ): Promise<ArkadeUnilateralExitPackageResult> {
    const wallet = await this.waitForWalletReady(8_000).catch(() => this.wallet)
    if (wallet == null) {
      throw new Error('Engine not started')
    }

    const onchainWallet = await OnchainWallet.create(
      wallet.identity,
      wallet.networkName,
      wallet.onchainProvider
    )

    const networkName =
      wallet.networkName ??
      (wallet.network?.bech32 === 'bc'
        ? 'bitcoin'
        : wallet.network?.bech32 === 'bcrt'
          ? 'regtest'
          : 'testnet')

    const exitOpts = {
      wallet,
      onchainWallet,
      sweepAddress: destinationAddress,
      mode: 'graph' as const,
      networkName
    }

    const summarizeSkipped = (infos: Array<{ skipped?: string }>): string => {
      const reasons = [
        ...new Set(
          infos
            .map(i => i.skipped)
            .filter((r): r is string => r != null && r !== '')
        )
      ]
      if (reasons.length === 0) {
        return 'All VTXOs were skipped (no unilateral exit path available).'
      }
      return `All VTXOs were skipped: ${reasons.join('; ')}`
    }

    try {
      // Estimate first — surfaces per-VTXO skip reasons without the misleading
      // "cache exit data" rewrite used for real indexer/offline failures.
      const quote = await UnilateralExit.estimate(exitOpts)
      const infos = Array.isArray(quote?.vtxos) ? quote.vtxos : []
      if (infos.length === 0) {
        throw new Error('No funds available to exit')
      }
      if (infos.every(i => i.skipped != null && i.skipped !== '')) {
        throw new Error(summarizeSkipped(infos))
      }

      const pkg = await UnilateralExit.prepare(exitOpts)
      const json = serializeExitPackage(pkg)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `edge-arkade-exit-${stamp}.json`
      return {
        json,
        filename,
        executorUrl: ARKADE_UNILATERAL_EXIT_EXECUTOR_URL,
        mode: 'graph',
        sweepAddress: destinationAddress
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes(UNROLL_CACHE_MISS_MESSAGE)) {
        throw error
      }
      if (/^All VTXOs were skipped|^No funds available/i.test(message)) {
        throw error
      }
      if (/no exitable vtxos \(all skipped\)/i.test(message)) {
        throw new Error(
          'All VTXOs were skipped while building the exit package. Funds may be too small for network fees, or no unilateral exit path is available for these VTXOs.'
        )
      }
      if (
        /not found|indexer|fetch|ECONN|timeout|Unroll data not cached|no vtxos to exit/i.test(
          message
        )
      ) {
        throw new Error(
          `Could not build the exit package. Open the wallet online once so Arkade can cache exit data, then try again. (${message})`
        )
      }
      throw error
    }
  }

  private async runUnilateralExitToAddress(
    destinationAddress: string
  ): Promise<{
    txid: string
    destination: string
    phase: 'sweep' | 'unroll'
  }> {
    const wallet = await this.waitForWalletReady(8_000).catch(() => this.wallet)
    if (wallet == null) {
      throw new Error('Engine not started')
    }
    const vtxos = await this.getVtxosForUnilateralEstimate(wallet)
    if (vtxos.length === 0) {
      throw new Error('No funds available to exit')
    }

    const onchainWallet = await OnchainWallet.create(
      wallet.identity,
      wallet.networkName,
      wallet.onchainProvider
    )

    const indexer = wrapIndexerWithUnrollCache(
      wallet.indexerProvider,
      this.unrollCache
    )

    for (const vtxo of vtxos) {
      try {
        const session = await Unroll.Session.create(
          { txid: vtxo.txid, vout: vtxo.vout },
          onchainWallet,
          wallet.onchainProvider,
          indexer
        )
        for await (const _step of session) {
          // Session iterator executes WAIT / UNROLL steps.
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error)
        if (message.includes(UNROLL_CACHE_MISS_MESSAGE)) {
          throw error
        }
        if (/not found|indexer|fetch|network|ECONN|timeout/i.test(message)) {
          throw new Error(`${UNROLL_CACHE_MISS_MESSAGE} (${message})`)
        }
        throw error
      }
    }

    const vtxoTxids = vtxos.map((v: { txid: string }) => v.txid)
    try {
      const txid = await Unroll.completeUnroll(
        wallet,
        vtxoTxids,
        destinationAddress
      )
      return { txid: String(txid), destination: destinationAddress, phase: 'sweep' }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error)
      if (
        /not fully unrolled|not confirmed|no available exit path|timelock/i.test(
          message
        )
      ) {
        return {
          txid: '',
          destination: destinationAddress,
          phase: 'unroll'
        }
      }
      throw error
    }
  }

  /** Best-effort: populate chain + virtual PSBT cache while indexer is reachable. */
  private scheduleUnrollPrefetch(wallet: any): void {
    if (wallet?.indexerProvider == null) return
    if (this.unrollPrefetchInflight != null) return
    if (
      Date.now() - this.unrollPrefetchAt <
      ArkadeEngine.UNROLL_PREFETCH_MIN_MS
    ) {
      return
    }
    this.unrollPrefetchInflight = this.prefetchUnrollArtifacts(wallet)
      .catch((error: unknown) => {
        console.warn('[arkade] unroll artifact prefetch failed', error)
      })
      .finally(() => {
        this.unrollPrefetchInflight = undefined
      })
  }

  private async prefetchUnrollArtifacts(wallet: any): Promise<void> {
    let vtxos: any[] = []
    try {
      vtxos = await this.getVtxosForUnilateralEstimate(wallet)
    } catch {
      return
    }
    if (vtxos.length === 0) return

    const indexer = wrapIndexerWithUnrollCache(
      wallet.indexerProvider,
      this.unrollCache
    )

    for (const vtxo of vtxos) {
      try {
        const { chain } = await indexer.getVtxoChain({
          txid: vtxo.txid,
          vout: vtxo.vout
        })
        if (!Array.isArray(chain)) continue
        for (const chainTx of chain) {
          if (
            chainTx?.type === ChainTxType.COMMITMENT ||
            chainTx?.type === ChainTxType.UNSPECIFIED
          ) {
            continue
          }
          const txid = chainTx?.txid
          if (typeof txid !== 'string' || txid === '') continue
          await indexer.getVirtualTxs([txid])
        }
      } catch (error: unknown) {
        console.warn(
          `[arkade] prefetch unroll artifacts for ${String(vtxo?.txid)} failed`,
          error
        )
      }
    }

    this.unrollPrefetchAt = Date.now()
  }

  private formatOnchainExitError(error: unknown): string {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : 'Onchain exit failed'
    if (/^Insufficient funds$/i.test(message.trim())) {
      return (
        'Unroll needs on-chain BTC at this wallet’s P2TR key-path address ' +
        'to pay CPFP package fees. That address is not the Arkade boarding ' +
        'address (boarding funds auto-settle into Ark). Fund the key-path ' +
        'address shown in Unilateral Exit, then try again.'
      )
    }
    if (
      /minExpiryGap/i.test(message) ||
      (/INVALID_PSBT_INPUT/i.test(message) && /expir/i.test(message))
    ) {
      return (
        'Arkade ASP rejected this onchain exit: a VTXO is too fresh ' +
        '(SettlementMinExpiryGap — expiry is still too far in the future). ' +
        'Funds are safe. Offchain Arkade sends still work. Wait until the ' +
        'batch is closer to expiry (~within 4 weeks), then exit again. ' +
        'Do not renew before exit — renewal makes VTXOs fresher and can block exit longer.'
      )
    }
    return message
  }

  private getOnchainOutputScript(destinationAddress: string): string {
    for (const networkName of Object.keys(networks) as Array<keyof typeof networks>) {
      try {
        const addr = Address(networks[networkName]).decode(destinationAddress)
        return hex.encode(OutScript.encode(addr))
      } catch {
        continue
      }
    }
    throw new Error(`Failed to decode destination address: ${destinationAddress}`)
  }

  private stopLnurlSession(opts: { clearCached: boolean }): void {
    if (this.lnurlReconnectTimer != null) {
      clearTimeout(this.lnurlReconnectTimer)
      this.lnurlReconnectTimer = undefined
    }
    this.lnurlAbort?.abort()
    this.lnurlAbort = undefined
    this.lnurlSessionId = undefined
    this.lnurlBearerToken = undefined
    this.lnurlLoopRunning = false
    if (opts.clearCached) {
      this.cachedLnurl = undefined
    }
  }

  /**
   * Opens (or reuses) an LNURL-pay SSE session and returns the LNURL string.
   * Uses a mnemonic-derived token so reconnects resume the same LNURL
   * (matches arkade-os/wallet + lnurl.arkade.sh).
   */
  private async ensureLnurlSession(
    lnurlServerUrl: string = this.settings.lnurlServerUrl
  ): Promise<string | undefined> {
    if (lnurlServerUrl == null || lnurlServerUrl === '') return undefined
    if (this.swaps == null) return undefined

    if (
      this.cachedLnurl != null &&
      this.cachedLnurl !== '' &&
      this.lnurlLoopRunning
    ) {
      return this.cachedLnurl
    }

    // Already connecting — wait briefly for session_created
    if (this.lnurlLoopRunning) {
      for (let i = 0; i < 40; i++) {
        if (this.cachedLnurl != null && this.cachedLnurl !== '') {
          return this.cachedLnurl
        }
        await new Promise(resolve => setTimeout(resolve, 250))
        if (!this.lnurlLoopRunning) break
      }
      return this.cachedLnurl
    }

    // Soft restart of the SSE only — keep cached LNURL until we get a new one
    // so the Receive QR does not flip to a dead bech32 mid-payment.
    if (this.lnurlReconnectTimer != null) {
      clearTimeout(this.lnurlReconnectTimer)
      this.lnurlReconnectTimer = undefined
    }
    this.lnurlAbort?.abort()
    this.lnurlAbort = new AbortController()
    const abort = this.lnurlAbort
    this.lnurlSessionId = undefined
    this.lnurlBearerToken = undefined

    const base = lnurlServerUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {}
    const body =
      this.lnurlSessionToken != null
        ? JSON.stringify({ token: this.lnurlSessionToken })
        : undefined
    if (body != null) headers['content-type'] = 'application/json'

    const res = await this.fetch(`${base}/lnurl/session`, {
      method: 'POST',
      headers,
      body,
      signal: abort.signal
    })
    if (res.ok !== true) throw new Error('LNURL session failed to start')
    if (res.body == null || typeof res.body.getReader !== 'function') {
      throw new Error('LNURL streaming not supported')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventType = ''

    let createdResolve: ((lnurl: string) => void) | undefined
    let createdReject: ((e: unknown) => void) | undefined
    const createdPromise = new Promise<string>((resolve, reject) => {
      createdResolve = resolve
      createdReject = reject
    })

    const authHeaders = (): Record<string, string> => ({
      'content-type': 'application/json',
      ...(this.lnurlBearerToken != null
        ? { Authorization: `Bearer ${this.lnurlBearerToken}` }
        : {})
    })

    const postInvoice = async (
      sessionId: string,
      pr: string
    ): Promise<void> => {
      await this.fetch(`${base}/lnurl/session/${sessionId}/invoice`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ pr })
      })
    }

    const postError = async (
      sessionId: string,
      reason: string
    ): Promise<void> => {
      try {
        await this.fetch(`${base}/lnurl/session/${sessionId}/invoice`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ error: reason })
        })
      } catch {}
    }

    this.lnurlLoopRunning = true
    const loop = async (): Promise<void> => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done === true) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim()
              continue
            }
            if (!line.startsWith('data:') || eventType === '') continue

            let data: any
            try {
              data = JSON.parse(line.slice(5).trim())
            } catch {
              eventType = ''
              continue
            }

            if (eventType === 'session_created') {
              const sessionId = String(data.sessionId ?? '')
              const lnurl = String(data.lnurl ?? '')
              if (sessionId === '' || lnurl === '') {
                eventType = ''
                continue
              }
              this.lnurlSessionId = sessionId
              this.cachedLnurl = lnurl
              if (typeof data.token === 'string' && data.token !== '') {
                this.lnurlBearerToken = data.token
              }
              createdResolve?.(lnurl)
              createdResolve = undefined
              createdReject = undefined
              try {
                this.onAddressChanged?.()
              } catch {}
              eventType = ''
              continue
            }

            if (eventType === 'invoice_request') {
              const sessionId = this.lnurlSessionId
              eventType = ''
              if (sessionId == null || this.swaps == null) continue
              const amountMsat = Number(data.amountMsat ?? 0)
              if (!Number.isFinite(amountMsat) || amountMsat <= 0) {
                await postError(sessionId, 'Invalid amount')
                continue
              }
              const amount = Math.floor(amountMsat / 1000)
              if (amount <= 0) {
                await postError(sessionId, 'Invalid amount')
                continue
              }

              try {
                const created = await this.swaps.createLightningInvoice({
                  amount,
                  description:
                    data.comment != null ? String(data.comment) : undefined
                })
                await postInvoice(sessionId, String(created.invoice))
                // Claim funds into Arkade when the Lightning payment settles:
                if (created.pendingSwap != null) {
                  this.swaps
                    .waitAndClaim(created.pendingSwap)
                    .then(() => this.poll())
                    .catch(() => {})
                }
              } catch (e) {
                const reason =
                  e instanceof Error ? e.message : 'Failed to create invoice'
                await postError(sessionId, reason)
              }
              continue
            }

            eventType = ''
          }
        }
      } catch (e) {
        createdReject?.(e)
      } finally {
        this.lnurlLoopRunning = false
        // Reconnect with the same mnemonic token so the LNURL stays valid.
        if (
          this.running &&
          this.swaps != null &&
          this.lnurlAbort === abort
        ) {
          this.lnurlReconnectTimer = setTimeout(() => {
            this.ensureLnurlSession(lnurlServerUrl).catch(() => {})
          }, 2000)
        }
      }
    }

    loop().catch(() => {
      this.lnurlLoopRunning = false
    })

    return await createdPromise
  }

  private async poll(): Promise<void> {
    if (!this.running || this.wallet == null) return

    let receiveAddressChanged = false
    try {
      const [nextArkadeAddress, nextBoardingAddress] = await Promise.all([
        this.wallet.getAddress(),
        this.wallet.getBoardingAddress()
      ])
      receiveAddressChanged =
        nextArkadeAddress !== this.cachedArkadeAddress ||
        nextBoardingAddress !== this.cachedBoardingAddress
      this.cachedArkadeAddress = nextArkadeAddress
      this.cachedBoardingAddress = nextBoardingAddress
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] refresh receive addresses failed: ${message}`)
    }

    // Fetch independently so a history failure does not leave balance stuck
    // at 0 after killEngine / app restart (InMemory repo rebuild).
    let balance: {
      available?: number | string
      total?: number | string
      recoverable?: number | string
      settled?: number | string
      preconfirmed?: number | string
    }
    try {
      balance = await this.wallet.getBalance()
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] getBalance failed: ${message}`)
      const fallbackBalance = await this.getFallbackBalance(this.wallet)
      if (fallbackBalance !== '0') {
        balance = { available: fallbackBalance, total: fallbackBalance }
      } else {
        throw error
      }
    }

    // Prefer total (offchain + boarding + recoverable), matching arkade-os/wallet.
    const total = Number(balance.total)
    const available = Number(balance.available)
    const newBalance = String(
      Number.isFinite(total)
        ? total
        : Number.isFinite(available)
        ? available
        : 0
    )
    if (newBalance !== this.cachedBalance || !this.balanceEmitted) {
      this.cachedBalance = newBalance
      this.balanceEmitted = true
      this.emitter.emit(
        EngineEvent.WALLET_BALANCE_CHANGED,
        arkadeCurrencyInfo.currencyCode,
        newBalance
      )
    }

    let history: any[] = []
    try {
      history = await this.wallet.getTransactionHistory()
      if (!Array.isArray(history)) history = []
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] getTransactionHistory failed: ${message}`)
      history = await this.getCachedSdkHistory(this.wallet)
    }

    // Balance uses getBoardingUtxos/getCoins; history uses getTransactions which
    // can miss mempool or fail. Merge live boarding UTXOs so BTC→Ark receives
    // always appear (Pending → Pending boarding → Settled).
    try {
      const boardingUtxos = await this.wallet.getBoardingUtxos()
      const knownBoarding = new Set(
        history
          .map((h: any) => String(h.key?.boardingTxid ?? ''))
          .filter((id: string) => id !== '')
      )
      for (const utxo of boardingUtxos as any[]) {
        const txid = String(utxo.txid ?? '')
        if (txid === '' || knownBoarding.has(txid)) continue
        const confirmed = utxo.status?.confirmed === true
        // Once the boarding tx is confirmed, rely on SDK history. Synthesizing
        // a second row here causes a duplicate "Pending boarding" entry.
        if (confirmed) continue
        const blockTime = Number(utxo.status?.block_time ?? 0)
        history.push({
          key: {
            boardingTxid: txid,
            arkTxid: '',
            commitmentTxid: ''
          },
          tag: 'boarding',
          type: 'RECEIVED',
          amount: Number(utxo.value ?? 0),
          settled: false,
          createdAt:
            confirmed && Number.isFinite(blockTime) && blockTime > 0
              ? blockTime * 1000
              : 0,
          boardingConfirmed: confirmed
        })
        knownBoarding.add(txid)
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.warn(`[arkade] getBoardingUtxos for history failed: ${message}`)
    }

    // Newest first (SDK usually sorts; our merge may not).
    history.sort(
      (a: any, b: any) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)
    )

    // Boltz ARK→BTC: annotate matching SENT rows with swap id (never use Boltz
    // id as Edge txid — that created duplicate phantom rows).
    const boltzByFundTxid = await this.mapBoltzIdsByFundHint(history)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bootstrap = !this.historyBootstrapped
    const events = history.map((h: any) => {
      const isSend = h.type === 'SENT'
      const nativeAmount = String(isSend ? -h.amount : h.amount)
      const boardingTxid = String(h.key?.boardingTxid ?? '')
      const arkTxid = String(h.key?.arkTxid ?? '')
      const commitmentTxid = String(h.key?.commitmentTxid ?? '')
      let txid = String(
        arkTxid ||
          commitmentTxid ||
          boardingTxid ||
          `ark-${h.type}-${h.createdAt}-${h.amount}`
      )
      // Defensive: never surface raw Boltz swap ids as Edge txids.
      if (this.looksLikeBoltzSwapId(txid)) {
        const fallback = commitmentTxid || boardingTxid
        if (fallback !== '' && !this.looksLikeBoltzSwapId(fallback)) {
          txid = fallback
        } else {
          txid = `ark-${h.type}-${h.createdAt}-${h.amount}`
        }
      }

      // Boarding lifecycle (arkade-os/wallet Transaction.tsx):
      // 1) mempool / no createdAt → Unconfirmed (Pending)
      // 2) onchain confirmed, not yet settled into Ark → Pending boarding
      // 3) settled=true (spent into batch) → Settled
      // Offchain / Lightning → preconfirmed until settled.
      const tag = String(h.tag ?? '')
      const isBoarding =
        tag === 'boarding' ||
        (boardingTxid !== '' && arkTxid === '' && commitmentTxid === '')
      const settled = h.settled === true
      const createdAtMs = Number(h.createdAt ?? 0)
      const boardingConfirmed =
        h.boardingConfirmed === true ||
        (isBoarding && Number.isFinite(createdAtMs) && createdAtMs > 0)

      let arkadeStatus:
        | 'settled'
        | 'preconfirmed'
        | 'pending_boarding'
        | 'boarding_pending'
      if (isBoarding && !settled) {
        arkadeStatus = boardingConfirmed
          ? 'boarding_pending'
          : 'pending_boarding'
      } else if (settled) {
        arkadeStatus = 'settled'
      } else {
        arkadeStatus = 'preconfirmed'
      }

      // Unconfirmed boarding: use "now" so the row sorts to the top (SDK uses 0).
      const dateSec =
        isBoarding && !(createdAtMs > 0)
          ? Math.floor(Date.now() / 1000)
          : Math.floor(createdAtMs / 1000)

      const boltzSwapId =
        boltzByFundTxid.get(txid) ??
        boltzByFundTxid.get(arkTxid) ??
        undefined

      const transaction: EdgeTransaction = {
        // Only mempool boarding stays height 0 → Edge "Pending".
        // Confirmed boarding awaiting batch uses height 1 + boarding_pending label.
        blockHeight: arkadeStatus === 'pending_boarding' ? 0 : 1,
        confirmations:
          arkadeStatus === 'pending_boarding' ? 'unconfirmed' : 'confirmed',
        currencyCode: arkadeCurrencyInfo.currencyCode,
        date: dateSec > 0 ? dateSec : Math.floor(Date.now() / 1000),
        isSend,
        memos: [],
        metadata:
          boltzSwapId != null
            ? { notes: `Boltz: ${boltzSwapId}` }
            : undefined,
        nativeAmount,
        networkFee: '0',
        networkFees: [],
        otherParams: {
          ark: true,
          arkadeStatus,
          settled,
          tag: tag !== '' ? tag : undefined,
          key: h.key,
          ...(boltzSwapId != null ? { boltzSwapId } : {})
        },
        ourReceiveAddresses: [],
        signedTx: '',
        tokenId: null,
        txid,
        walletId: this.walletInfo.id
      }
      // First history load seeds the set without firing receive dropdowns.
      const isNew = !bootstrap && !this.seenTxids.has(txid)
      this.seenTxids.add(txid)
      return { isNew, transaction }
    })
    this.historyBootstrapped = true
    this.cachedBlockHeight = 1

    // After a new incoming receive, the SDK rotator updates the display
    // address asynchronously. Wait for that to finish before refreshing the
    // Edge cache, otherwise Receive can briefly (or sticky) show the old one.
    //
    // Important HD quirk: the first rotate() after boot often re-materializes
    // derivation index 0 (same baseline display address). From the user's
    // point of view the address only changes after the *second* payment.
    // If drain left the address unchanged, force one additional exclusive
    // rotate so Receive advances after the first incoming funds.
    const hasNewReceive = events.some(
      e => e.isNew && !e.transaction.isSend && e.transaction.nativeAmount !== '0'
    )
    if (hasNewReceive) {
      try {
        const rotator = (this.wallet as any)?._receiveRotator
        const beforeArkade = this.cachedArkadeAddress
        if (rotator?.drain != null) {
          await rotator.drain()
        } else {
          await new Promise(resolve => setTimeout(resolve, 250))
        }

        let nextArkadeAddress = await this.wallet.getAddress()
        if (
          beforeArkade != null &&
          nextArkadeAddress === beforeArkade &&
          rotator?.rotate != null
        ) {
          if (rotator.runExclusive != null) {
            await rotator.runExclusive(() => rotator.rotate(this.wallet))
          } else {
            await rotator.rotate(this.wallet)
          }
          if (rotator.drain != null) {
            await rotator.drain()
          }
          nextArkadeAddress = await this.wallet.getAddress()
        }

        const nextBoardingAddress = await this.wallet.getBoardingAddress()
        if (
          nextArkadeAddress !== this.cachedArkadeAddress ||
          nextBoardingAddress !== this.cachedBoardingAddress
        ) {
          this.cachedArkadeAddress = nextArkadeAddress
          this.cachedBoardingAddress = nextBoardingAddress
          receiveAddressChanged = true
        }
      } catch (error: unknown) {
        console.warn('[arkade] post-receive address refresh failed', error)
      }
    }

    this.cachedTxs = events.map(e => e.transaction)
    if (events.length > 0) {
      // Must use TRANSACTIONS (with isNew) — TRANSACTIONS_CHANGED forces
      // isNew=false and never triggers the in-app receive dropdown.
      this.emitter.emit(EngineEvent.TRANSACTIONS, events)
    }
    if (receiveAddressChanged) {
      try {
        this.onAddressChanged?.()
      } catch {}
    }

    // Populate Unroll chain/PSBT cache while indexer is reachable (best-effort).
    this.scheduleUnrollPrefetch(this.wallet)
  }

  /** Boltz swap ids look like `37XaHp17umws`, not 64-char hex txids. */
  private looksLikeBoltzSwapId(id: string): boolean {
    if (id.length < 8 || id.length > 20) return false
    if (/^[0-9a-fA-F]{64}$/.test(id)) return false
    return /^[0-9A-Za-z]+$/.test(id)
  }

  /**
   * Match completed/pending ARK→BTC chain swaps to history SENT amounts so we
   * can show the Boltz id on the real Ark fund tx.
   */
  private async mapBoltzIdsByFundHint(
    history: any[]
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (this.swaps == null) return out
    try {
      const chainSwaps: any[] =
        (await this.swaps.getPendingChainSwaps?.()) ?? []
      let historySwaps: any[] = []
      try {
        historySwaps = (await this.swaps.getSwapHistory?.()) ?? []
      } catch {}
      const all = [...chainSwaps, ...historySwaps].filter(
        (s: any) =>
          s?.type === 'chain' &&
          s?.request?.from === 'ARK' &&
          s?.request?.to === 'BTC'
      )
      for (const swap of all) {
        const swapId = String(swap.id ?? '')
        if (swapId === '') continue
        const lockAmount = Number(
          swap.response?.lockupDetails?.amount ?? swap.amount ?? 0
        )
        if (!Number.isFinite(lockAmount) || lockAmount <= 0) continue
        // Prefer SENT rows whose amount matches the lockup.
        const match = history.find(
          (h: any) =>
            h.type === 'SENT' && Number(h.amount) === lockAmount
        )
        if (match == null) continue
        const arkTxid = String(match.key?.arkTxid ?? '')
        const commitmentTxid = String(match.key?.commitmentTxid ?? '')
        const txid = arkTxid || commitmentTxid
        if (txid !== '') out.set(txid, swapId)
      }
    } catch (error: unknown) {
      console.warn('[arkade] mapBoltzIdsByFundHint failed', error)
    }
    return out
  }
}
