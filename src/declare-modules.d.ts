declare module 'react-native' {
  export const NativeModules: {
    EdgeCurrencyPluginsModule: {
      getConstants: () => {
        sourceUri: string
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Arkade TS-SDK shims:
//
// The Edge currency plugins repo currently builds with an older TypeScript
// toolchain, while `@arkade-os/sdk` publishes .d.ts using newer TS syntax.
// We provide minimal `any` shims so this package can compile, while still
// bundling and running the SDK at runtime.
// ---------------------------------------------------------------------------

declare module '@arkade-os/sdk' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MnemonicIdentity: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Wallet: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const VHTLC: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const WalletRepositoryImpl: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ContractRepositoryImpl: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const InMemoryWalletRepository: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const InMemoryContractRepository: any
}

declare module '@arkade-os/boltz-swap' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ArkadeSwaps: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const decodeInvoice: any
}
