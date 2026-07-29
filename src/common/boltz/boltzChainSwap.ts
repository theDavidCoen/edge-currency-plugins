/**
 * Boltz API v2 chain-swap helpers for Parmesan (BTC ↔ RBTC).
 * Quote fees for Edge Send; create/lock/claim orchestration lives with engines.
 */

export type BoltzChainAsset = 'BTC' | 'RBTC' | 'ARK'

export interface BoltzChainPairFees {
  percentage: number
  minerFees: {
    server: number
    user: { claim: number; lockup: number }
  }
}

export interface BoltzChainPairInfo {
  hash: string
  rate: number
  limits: { maximal: number; minimal: number; maximalZeroConf: number }
  fees: BoltzChainPairFees
}

export interface BoltzFeeQuote {
  from: BoltzChainAsset
  to: BoltzChainAsset
  /** Amount the user locks on the source chain (sats). */
  userLockAmountSats: number
  /** Approximate amount received on destination (sats). */
  receiverAmountSats: number
  /** Total fee to show in Edge networkFee (sats). */
  totalFeeSats: number
  percentageFeeSats: number
  serverMinerFeeSats: number
  userLockupFeeSats: number
  userClaimFeeSats: number
  pair: BoltzChainPairInfo
}

const BOLTZ_API = 'https://api.boltz.exchange'

export const isEvmAddress = (value: string): boolean =>
  /^0x[0-9a-fA-F]{40}$/.test(value.trim())

export const isBtcOnchainAddress = (value: string): boolean => {
  const v = value.trim()
  return (
    /^(bc1|tb1|bcrt1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,87}$/i.test(v) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(v)
  )
}

let cachedPairs: Record<
  string,
  Record<string, BoltzChainPairInfo>
> | null = null
let cachedAt = 0

export async function fetchBoltzChainPairs(
  fetchFn: typeof fetch = fetch
): Promise<Record<string, Record<string, BoltzChainPairInfo>>> {
  if (cachedPairs != null && Date.now() - cachedAt < 60_000) {
    return cachedPairs
  }
  const res = await fetchFn(`${BOLTZ_API}/v2/swap/chain`)
  if (!res.ok) {
    throw new Error(`Boltz chain pairs HTTP ${res.status}`)
  }
  cachedPairs = (await res.json()) as Record<
    string,
    Record<string, BoltzChainPairInfo>
  >
  cachedAt = Date.now()
  return cachedPairs
}

export async function getBoltzChainPair(
  from: BoltzChainAsset,
  to: BoltzChainAsset,
  fetchFn: typeof fetch = fetch
): Promise<BoltzChainPairInfo> {
  const pairs = await fetchBoltzChainPairs(fetchFn)
  const pair = pairs[from]?.[to]
  if (pair == null) {
    throw new Error(`Boltz chain pair ${from}→${to} unavailable`)
  }
  return pair
}

/**
 * Fee for locking `userLockAmountSats` on `from` to receive on `to`.
 * totalFee = percentage + server miner + user lockup + user claim
 * (matches Boltz chain-swap fee model for Send display).
 */
export function calcChainSwapFee(
  userLockAmountSats: number,
  pair: BoltzChainPairInfo
): BoltzFeeQuote {
  const percentageFeeSats = Math.ceil(
    (userLockAmountSats * pair.fees.percentage) / 100
  )
  const serverMinerFeeSats = pair.fees.minerFees.server
  const userLockupFeeSats = pair.fees.minerFees.user.lockup
  const userClaimFeeSats = pair.fees.minerFees.user.claim
  const totalFeeSats =
    percentageFeeSats +
    serverMinerFeeSats +
    userLockupFeeSats +
    userClaimFeeSats
  const receiverAmountSats = Math.max(
    0,
    userLockAmountSats - percentageFeeSats - serverMinerFeeSats
  )
  return {
    from: 'BTC',
    to: 'RBTC',
    userLockAmountSats,
    receiverAmountSats,
    totalFeeSats,
    percentageFeeSats,
    serverMinerFeeSats,
    userLockupFeeSats,
    userClaimFeeSats,
    pair
  }
}

export async function quoteChainSwapFee(
  from: BoltzChainAsset,
  to: BoltzChainAsset,
  userLockAmountSats: number,
  fetchFn: typeof fetch = fetch
): Promise<BoltzFeeQuote> {
  const pair = await getBoltzChainPair(from, to, fetchFn)
  if (userLockAmountSats < pair.limits.minimal) {
    throw new Error(
      `Amount below Boltz minimum (${pair.limits.minimal} sats) for ${from}→${to}`
    )
  }
  if (userLockAmountSats > pair.limits.maximal) {
    throw new Error(
      `Amount above Boltz maximum (${pair.limits.maximal} sats) for ${from}→${to}`
    )
  }
  const quote = calcChainSwapFee(userLockAmountSats, pair)
  return { ...quote, from, to }
}

export interface CreateChainSwapParams {
  from: BoltzChainAsset
  to: BoltzChainAsset
  userLockAmount: number
  preimageHash: string
  /** EVM claim destination (BTC→RBTC). */
  claimAddress?: string
  claimPublicKey?: string
  refundPublicKey?: string
}

export async function createBoltzChainSwap(
  params: CreateChainSwapParams,
  fetchFn: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    from: params.from,
    to: params.to,
    userLockAmount: params.userLockAmount,
    preimageHash: params.preimageHash
  }
  if (params.claimAddress != null) body.claimAddress = params.claimAddress
  if (params.claimPublicKey != null) body.claimPublicKey = params.claimPublicKey
  if (params.refundPublicKey != null) {
    body.refundPublicKey = params.refundPublicKey
  }

  const res = await fetchFn(`${BOLTZ_API}/v2/swap/chain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Boltz create chain swap failed: ${res.status} ${text}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

export async function getBoltzSwapStatus(
  id: string,
  fetchFn: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${BOLTZ_API}/v2/swap/${id}`)
  if (!res.ok) {
    throw new Error(`Boltz swap status HTTP ${res.status}`)
  }
  return (await res.json()) as Record<string, unknown>
}

/** Boltz statuses where the server has locked destination funds and the client must claim. */
export const BOLTZ_SERVER_LOCK_READY_STATES = new Set([
  'transaction.server.mempool',
  'transaction.server.confirmed'
])

/**
 * ABI-encode EtherSwap.claim(bytes32,uint256,address,uint256) as hex without 0x.
 * Selector keccak: c3c37fbc.
 */
export function encodeEtherSwapClaimCalldata(
  preimageHex: string,
  amountWei: string | number | bigint,
  refundAddress: string,
  timelock: number
): string {
  const preimage = preimageHex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const amount = BigInt(amountWei).toString(16).padStart(64, '0')
  const refund = refundAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const lock = BigInt(timelock).toString(16).padStart(64, '0')
  return `c3c37fbc${preimage}${amount}${refund}${lock}`
}

/** Generate an ephemeral secp256k1 key pair for Boltz refundPublicKey / claimPublicKey. */
export function randomSecp256k1CompressedPubKey(): {
  privateKeyHex: string
  publicKeyHex: string
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ec: EC } = require('elliptic') as typeof import('elliptic')
  const ec = new EC('secp256k1')
  const key = ec.genKeyPair()
  const privateKeyHex = key.getPrivate('hex').padStart(64, '0')
  const publicKeyHex = key.getPublic(true, 'hex')
  return { privateKeyHex, publicKeyHex }
}

export { BOLTZ_API }
