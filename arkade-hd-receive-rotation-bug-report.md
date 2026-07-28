# Arkade HD Receive Rotation Bug Report

## Title

Arkade HD receive address does not rotate in Edge integration when using `MnemonicIdentity`

## Summary

We initially saw a persistent HD receive rotation issue in the Edge integration.

The issue was resolved after explicitly setting `walletMode: 'hd'` in `Wallet.create(...)`. With that change, the receive address stays stable while simply viewing the receive screen, and rotates after funds are actually received.

## Initial Observed Behavior

The copied Arkade receive address remains identical across repeated tests.

Example repeated address:

`ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec0me2ekx9xrnvpznawl8ccuwutnhxylkp02gvnfl3tg5kzxadmpfg469mv`

Repeated test result:

1. Open `Receive`
2. Copy address
3. Repeat
4. The copied Arkade address remains identical

This happens even after successful receives and after reopening the receive screen multiple times.

## Expected Behavior

For an HD wallet backed by `MnemonicIdentity`, the displayed Arkade receive address should rotate over time or after receive allocation, similarly to the SDK's intended HD receive flow.

## Integration Details

We are using:

- `MnemonicIdentity.fromMnemonic(...)`
- `Wallet.create(...)`
- persistent `WalletRepositoryImpl`
- persistent custom `ContractRepository`
- explicit `walletMode: 'hd'`
- `wallet.restore({ gapLimit: 20 })`
- `await wallet.getVtxoManager()` during startup to ensure the receive rotator installs

## What We Verified

We confirmed this is not just a UI cache issue in Edge.

We tested multiple layers:

### 1. Edge engine path

- Forced fresh-address allocation from the Edge plugin
- Triggered receive rotation when `getAddresses()` / `getFreshAddress()` is requested
- Forced refresh of cached Arkade / boarding addresses
- Emitted `addressChanged`

### 2. Rotator path

- Called the SDK receive rotator directly
- Tried direct `rotate()` calls
- Tried bypassing backoff
- Tried double rotation if the first result was still the baseline address

### 3. Descriptor allocation path

- Tried explicitly advancing HD state to skip the baseline `index 0` case
- Tried forcing fresh allocation logic from the plugin side

### 4. Address selection path

- Patched SDK `getAddress()` to prefer the newest active `wallet-receive` contract from `contractRepository`
- Also tried forcing address materialization from inside `getAddress()`

None of the above changed the returned receive address while the wallet was still using the default/auto wallet-mode path.

## Root Cause

In this integration path, relying on the default/auto wallet mode was not enough to get the expected HD receive behavior.

Even though we were using `MnemonicIdentity`, persistent repositories, `restore({ gapLimit })`, and `getVtxoManager()`, the receive address stayed stuck on the same baseline address until we explicitly set:

`walletMode: 'hd'`

Once we did that, the behavior matched expectations:

- the address no longer rotated just by opening or viewing `Receive`
- the address rotated after actual incoming funds were received

## Most Relevant Symptom

The wallet looked effectively non-HD under the default/auto path:

- repeated `Receive -> Copy` returned the same Arkade address
- forcing address refresh from the Edge side did not help
- several aggressive workarounds only caused unwanted rotation on UI reads, not the desired “rotate on incoming funds” behavior

The decisive change was making HD mode explicit in `Wallet.create(...)`.

## Suggested Investigation Points

Please inspect these paths together:

- wallet-mode resolution when `MnemonicIdentity` is used under the default/auto path
- `HDDescriptorProvider.getNextSigningDescriptor()`
- `WalletReceiveRotator.defaultBoot()`
- `WalletReceiveRotator.rotate()`
- `Wallet.getAddress()`
- the persistence / recovery interaction between:
  - `WalletRepository`
  - `ContractRepository`
  - `restore({ gapLimit })`
  - `getVtxoManager()`

## Practical Conclusion

From the Edge side, we were not able to obtain correct rotating receive behavior until HD mode was made explicit.

Before that, we tried:

- HD identity
- persistent repositories
- restore
- explicit rotator initialization
- direct rotator invocation
- SDK-level address-selection patches

The final working fix on our side was:

- `walletMode: 'hd'` in `Wallet.create(...)`
- no read-path rotation hacks
- let the SDK rotate on actual incoming funds

This suggests a wallet-mode resolution mismatch or SDK expectation gap in the default/auto path, rather than a fundamental failure of HD receive rotation itself.
