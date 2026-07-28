# Arkade HD Receive Rotation Bug Report

## Title

Arkade HD receive address does not rotate in Edge integration when using `MnemonicIdentity`

## Summary

We are integrating Arkade into Edge and are seeing a persistent issue with HD receive address rotation.

An Arkade wallet created from `MnemonicIdentity` always returns the same offchain receive address in the Edge receive flow, even after successful receives and repeated openings of the receive screen.

## Observed Behavior

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

None of the above changed the returned receive address.

## Narrowed Root-Cause Area

At this point the issue appears to be deeper than address selection or UI caching.

The most likely root-cause area is one of these:

1. `WalletReceiveRotator.rotate()` is not actually persisting a new HD receive contract for this wallet state
2. `HDDescriptorProvider.getNextSigningDescriptor()` is not advancing beyond the baseline flow in this real integration path
3. Boot / reconstruction is not syncing runtime wallet state with persisted receive contracts
4. `MnemonicIdentity` plus the current wallet mode path is not enabling the HD receive flow we expect

## Most Relevant Symptom

Even when we patched `wallet.getAddress()` to read the newest active `wallet-receive` contract from the repository, the returned address still did not change.

That suggests either:

- no newer tagged receive contract is being created or persisted, or
- the contracts being created are not actually different receive addresses

## Suggested Investigation Points

Please inspect these paths together:

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

From the Edge side, we were not able to obtain rotating Arkade receive addresses despite:

- HD identity
- persistent repositories
- restore
- explicit rotator initialization
- direct rotator invocation
- SDK-level address-selection patches

So this currently looks like an SDK-side HD receive rotation bug or an SDK/runtime expectation mismatch.
