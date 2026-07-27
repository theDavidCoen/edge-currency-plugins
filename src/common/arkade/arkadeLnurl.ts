import * as bip32 from 'bip32'
import * as bip39 from 'bip39'
import { createHmac } from 'crypto'

/**
 * Stable LNURL-session token (same scheme as arkade-os/wallet):
 * BIP86 Taproot key → HMAC-SHA256("lnurl-session").
 * Passing this on POST /lnurl/session resumes the same LNURL across reconnects.
 */
export function deriveLnurlSessionToken(
  mnemonic: string,
  isMainnet: boolean = true
): string {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic')
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic)
  const root = bip32.fromSeed(seed)
  const coinType = isMainnet ? 0 : 1
  const child = root.derivePath(`m/86'/${coinType}'/0'/0/0`)
  if (child.privateKey == null) {
    throw new Error('BIP32 derivation yielded no private key')
  }
  return createHmac('sha256', child.privateKey)
    .update('lnurl-session')
    .digest('hex')
}
