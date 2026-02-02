# v4 Hook Harness (Scaffold)

This harness is a minimal scaffold for the v4 hook verification flow.

## Quick start

1) Install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

2) Build + test:

```bash
forge install foundry-rs/forge-std
forge build
forge test
```

## Notes

- This scaffold uses simplified hook contracts for demo purposes.
- The verifier runs in mock mode by default; wire real v4 interactions here when ready.
- For Uniswap v4 integration, add the official v4 hook templates + PoolManager dependencies.
