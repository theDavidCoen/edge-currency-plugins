/**
 * Android Disklet/AtomicFile can fail to rename paths that contain `%`
 * (from encodeURIComponent) or `/` (from base64 wallet ids).
 * Keep filenames alphanumeric + underscore only.
 */
export function safeArkadeWalletFileId(walletId: string): string {
  return walletId.replace(/[^A-Za-z0-9_-]/g, '_')
}
