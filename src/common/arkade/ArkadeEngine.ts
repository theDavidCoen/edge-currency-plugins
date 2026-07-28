import { ArkadeSwaps, decodeInvoice, isValidArkAddress } from '@arkade-os/boltz-swap'
import {
  ChainTxType,
  Estimator,
  MnemonicIdentity,
  OnchainWallet,
  RestDelegatorProvider,
  Transaction,
  TxWeightEstimator,
  Unroll,
  VHTLC,
  VtxoScript,
  WalletRepositoryImpl,
  Wallet,
  networks
} from '@arkade-os/sdk'
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
const ENGINE_START_WAIT_MS = 12_000
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
    private readonly sdkStorage: ArkadeDiskletSdkStorage
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
       * Exit all spendable VTXOs of this wallet to an onchain BTC address.
       *
       * Working path: collaborative settle (ASP online).
       * True unilateral Unroll.Session (ASP-independent, CSV challenge) is not
       * automated here — needs an onchain fee bumper + multi-step waits.
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
        return await this.runUnilateralExitToAddress(destination)
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
        if (opts.privateKeys == null) return POLL_MS
        const { mnemonic } = asArkadePrivateKeys(opts.privateKeys)
        if (mnemonic == null || mnemonic === '') {
          throw new Error('Missing wallet mnemonic')
        }

        const identity = MnemonicIdentity.fromMnemonic(mnemonic)

        const arkServerUrl = resolveArkServerUrl(this.settings)
        const delegatorUrl = resolveDelegatorUrl(this.settings)

        // Avoid IndexedDB / filesystem assumptions: use in-memory repositories.
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
      }

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

    const isSwapQuote = spendInfo.savedAction?.actionType === 'swap'
    if (isSwapQuote) {
      const amount =
        rawAmount != null && rawAmount !== ''
          ? BigInt(Math.abs(Number(rawAmount)))
          : balance
      const outputFee = this.estimateOnchainOutputFee(to, amount, feeInfo)
      const max = balance - outputFee
      return max > BigInt(0) ? max.toString() : '0'
    }

    const { sendAmount } = await this.prepareOnchainExit(
      to,
      undefined,
      feeInfo
    )
    return sendAmount.toString()
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

      let outputFee: bigint
      if (isSwapQuote) {
        // Quote discovery: many providers call makeSpend in parallel. Do not
        // hit getVtxos / prepareOnchainExit here — that stalls the whole swap UI.
        outputFee = this.estimateOnchainOutputFee(to, BigInt(amount), feeInfo)
        console.warn(
          `[arkade swap quote] makeSpend settle fee estimate amount=${amount} fee=${outputFee.toString()} to=${to}`
        )
      } else {
        ;({ outputFee } = await this.prepareOnchainExit(
          to,
          BigInt(amount),
          feeInfo
        ))
      }

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
    if (
      this.swaps == null ||
      !Number.isFinite(receiverAmountSats) ||
      receiverAmountSats <= 0
    ) {
      return null
    }
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
   * wait for Boltz to lock BTC and claim to destination.
   *
   * Edge txid MUST be the Ark fund tx (matches SDK history). Boltz's
   * waitForSwapCompletion returns the swap id for chain swaps — never use that
   * as Edge txid (it creates a duplicate phantom row that vanishes on resync).
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

    const fundTxid = String(
      await wallet.send({
        address: result.arkAddress,
        amount: result.amountToPay
      })
    )
    if (fundTxid === '') {
      throw new Error('Failed to fund Boltz ARK lockup')
    }

    let claimTxid = ''
    try {
      // Blocks until claimed. Return value is the Boltz swap id for chain swaps
      // — ignore it as a blockchain txid.
      await swaps.waitAndClaimBtc(result.pendingSwap)
      try {
        const status = await swaps.getSwapStatus(boltzSwapId)
        claimTxid = String(status?.transaction?.id ?? '')
      } catch {}
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
          ? error
          : 'Boltz ARK→BTC claim failed'
      throw new Error(message)
    }

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

  private async estimateUnilateralExitFees(
    destinationAddress: string
  ): Promise<ArkadeUnilateralExitEstimate> {
    const wallet = await this.waitForWalletReady()
    const vtxos = await wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    })
    if (vtxos.length === 0) {
      throw new Error('No funds available to exit')
    }

    let grossAmountSats = BigInt(0)
    for (const vtxo of vtxos) {
      grossAmountSats += BigInt(vtxo.value)
    }

    const onchainWallet = await OnchainWallet.create(
      wallet.identity,
      wallet.networkName,
      wallet.onchainProvider
    )

    let feeRate =
      (await wallet.onchainProvider.getFeeRate()) ?? OnchainWallet.MIN_FEE_RATE
    if (feeRate < OnchainWallet.MIN_FEE_RATE) {
      feeRate = OnchainWallet.MIN_FEE_RATE
    }

    let timelockBlocks = 144
    try {
      const info = await wallet.arkProvider.getInfo()
      if (info.unilateralExitDelay < BigInt(512)) {
        timelockBlocks = Number(info.unilateralExitDelay)
      }
    } catch {
      // Keep default timelock hint.
    }

    let totalVBytes = 0
    let estimatedFeeSats = BigInt(0)

    for (const vtxo of vtxos) {
      const bump = await this.estimateUnrollBumpFees(
        wallet,
        onchainWallet,
        vtxo,
        feeRate
      )
      totalVBytes += bump.vBytes
      estimatedFeeSats += bump.feeSats
    }

    const sweepVBytes = this.estimateSweepVBytes(
      vtxos,
      destinationAddress,
      wallet.network
    )
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

  private async estimateUnrollBumpFees(
    wallet: any,
    onchainWallet: OnchainWallet,
    vtxo: any,
    feeRate: number
  ): Promise<{ feeSats: bigint; vBytes: number }> {
    const { chain } = await wallet.indexerProvider.getVtxoChain({
      txid: vtxo.txid,
      vout: vtxo.vout
    })

    let feeSats = BigInt(0)
    let vBytes = 0

    for (let i = chain.length - 1; i >= 0; i--) {
      const chainTx = chain[i]
      if (
        chainTx.type === ChainTxType.COMMITMENT ||
        chainTx.type === ChainTxType.UNSPECIFIED
      ) {
        continue
      }

      try {
        const txInfo = await wallet.onchainProvider.getTxStatus(chainTx.txid)
        if (!txInfo.confirmed) {
          // Exit already in progress — fee already committed in mempool.
          continue
        }
        continue
      } catch {
        // Offchain: needs Unroll + CPFP bump.
      }

      const virtualTxs = await wallet.indexerProvider.getVirtualTxs([
        chainTx.txid
      ])
      if (virtualTxs.txs.length === 0) {
        throw new Error(`Virtual tx ${chainTx.txid} not found`)
      }

      const tx = Transaction.fromPSBT(base64.decode(virtualTxs.txs[0]))
      if (chainTx.type === ChainTxType.TREE) {
        const input = tx.getInput(0)
        if (input?.tapKeySig == null) {
          throw new Error(`Tap key sig not found for tree tx ${chainTx.txid}`)
        }
        tx.updateInput(0, {
          finalScriptWitness: [input.tapKeySig]
        })
      } else {
        tx.finalize()
      }

      const parentVsize = tx.vsize
      const childVsize = Number(
        TxWeightEstimator.create()
          .addKeySpendInput(true)
          .addP2AInput()
          .addOutputAddress(onchainWallet.address, wallet.network)
          .vsize().value
      )
      const packageVsize = parentVsize + childVsize
      vBytes += packageVsize
      feeSats += BigInt(Math.ceil(feeRate * packageVsize))
    }

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

  private async runUnilateralExitToAddress(
    destinationAddress: string
  ): Promise<{
    txid: string
    destination: string
    phase: 'sweep' | 'unroll'
  }> {
    const wallet = await this.waitForWalletReady()
    const vtxos = await wallet.getVtxos({
      withRecoverable: true,
      withUnrolled: false
    })
    if (vtxos.length === 0) {
      throw new Error('No funds available to exit')
    }

    const onchainWallet = await OnchainWallet.create(
      wallet.identity,
      wallet.networkName,
      wallet.onchainProvider
    )

    for (const vtxo of vtxos) {
      const session = await Unroll.Session.create(
        { txid: vtxo.txid, vout: vtxo.vout },
        onchainWallet,
        wallet.onchainProvider,
        wallet.indexerProvider
      )
      for await (const _step of session) {
        // Session iterator executes WAIT / UNROLL steps.
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

  private formatOnchainExitError(error: unknown): string {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : 'Onchain exit failed'
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
