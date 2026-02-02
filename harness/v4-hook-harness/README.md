# v4 Hook Harness

Foundry harness used by the verifier to compile, test, and run onchain proof steps for v4 hook modules.

## Quick start

1) Install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

2) Install v4 deps (once):

```bash
forge install uniswap/v4-core --no-commit
# v4-core uses git submodules for forge-std + solmate
git -C lib/v4-core submodule update --init --recursive
```

3) Build + test:

```bash
forge build
# Run a specific template test
CAP_AMOUNT_IN=1000 forge test --match-path test/SwapCapHook.t.sol
ALLOWLIST_A=0x0000000000000000000000000000000000000001 \
ALLOWLIST_B=0x0000000000000000000000000000000000000002 \
  forge test --match-path test/WhitelistHook.t.sol
```

## Onchain proof script

The verifier invokes `script/V4Proof.s.sol` in real mode. Required env vars:

- `POOL_MANAGER` (Base Sepolia PoolManager address)
- `TEMPLATE_TYPE` (`SWAP_CAP_HOOK` or `WHITELIST_HOOK`)
- `CAP_AMOUNT_IN` or `ALLOWLIST_A`/`ALLOWLIST_B`
- `PROOF_OUT` (path for proof JSON)
- plus `--rpc-url` and `--private-key` when broadcasting

Example:

```bash
POOL_MANAGER=0x05E73354cFDd1B9f74B0Afdc6fC8E6B9d0B2fA96 \
TEMPLATE_TYPE=SWAP_CAP_HOOK \
CAP_AMOUNT_IN=1000 \
PROOF_OUT=./proof.json \
forge script script/V4Proof.s.sol:V4Proof \
  --broadcast --rpc-url $V4_RPC_URL --private-key $V4_PRIVATE_KEY --json
```
