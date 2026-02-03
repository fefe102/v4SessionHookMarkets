# v4SessionHookMarket

Verifiable work market for Uniswap v4 hook modules. Requesters post HookSpecs with an acceptance harness; solvers quote price/ETA, submit artifacts, and get paid via session-based micropayments (Yellow). A verifier runs deterministic checks and emits onchain proof txids.

## Monorepo layout

- `apps/api`: Fastify API + SQLite state machine.
- `apps/web`: Next.js UI.
- `apps/verifier`: Verification runner (mock by default).
- `apps/solver-bot`, `apps/challenger-bot`: Demo agents.
- `packages/shared`: Shared types + EIP-712 signing helpers.
- `packages/yellow-client`: Yellow client wrapper (mock by default).
- `packages/uniswap-client`: v4 proof helpers (mock by default).
- `harness/v4-hook-harness`: Foundry harness + onchain proof script.
- `data/`: Local DB + receipts (ignored).

## Quick start (local demo)

```bash
pnpm install

# Terminal 1: verifier (mock)
pnpm -C apps/verifier dev

# Terminal 2: API
pnpm -C apps/api dev

# Terminal 3: web
pnpm -C apps/web dev

# Terminal 4: solver bot (set SOLVER_PRIVATE_KEY)
SOLVER_PRIVATE_KEY=0x... pnpm -C apps/solver-bot dev

# Optional: run a second solver bot (different key + price)
SOLVER_PRIVATE_KEY=0x... SOLVER_PRICE=9 SOLVER_ETA_MINUTES=12 pnpm -C apps/solver-bot dev
```

Open http://localhost:3000, create a work order, and watch quotes + verification events flow through.

Notes:
- The API auto-selects the best quote after the bidding window closes, or you can call `POST /work-orders/:id/select`.
- After verification passes, the challenge window opens; the API auto-settles when it expires.
- Quote rewards are paid when the bidding window closes (the Yellow session is created at bidding close so all quote rewards happen inside the same session).
- To receive a challenge reward inside the same Yellow session, challengers must submit a signed quote during bidding (so they are included as a session participant).
- For Yellow prize demos, set `YELLOW_MILESTONE_SPLITS=5` (or higher) to stream each milestone as multiple offchain transfers.

## Real mode (Yellow + Base Sepolia proof)

1) Copy `.env.example` to `.env` and fill:
- `YELLOW_MODE=real` + Yellow RPC/WS + requester key
- `VERIFIER_MODE=real` + `V4_RPC_URL` + verifier key
- `V4_POOL_MANAGER` for Base Sepolia (default already set)

2) Fund the requester on Yellow sandbox (offchain ledger, not ERC20):

Yellow sandbox funds are separate from Base Sepolia ETH:
- Base Sepolia ETH pays gas for the verifier's onchain proof txs.
- Yellow `ytest.usd` funds the offchain quote rewards + milestone payouts in the session.
 - Optional: `YELLOW_ENABLE_CHANNELS=true` will attempt to close a Nitrolite channel and return an onchain tx hash, but requires the requester wallet to have Base Sepolia ETH for gas and an onchain custody balance for `ytest.usd` (not provided by the sandbox faucet).

Call the faucet for the *requester address* (the address derived from `YELLOW_PRIVATE_KEY`):

```bash
curl -sS -X POST https://clearnet-sandbox.yellow.com/faucet/requestTokens \
  -H 'content-type: application/json' \
  -d '{"userAddress":"0xYOUR_REQUESTER_ADDRESS"}'
```

3) Install harness deps once:

```bash
cd harness/v4-hook-harness
forge install --no-git uniswap/v4-core
git -C lib/v4-core submodule update --init --recursive
```

4) Ensure the verifier key has Base Sepolia ETH for gas. (Optional helper: `pnpm fund:sepolia`.)

5) Run verifier + API as usual. The verifier will:
- `forge build` + `forge test`
- broadcast `script/V4Proof.s.sol` to Base Sepolia (includes a deterministic "agent loop" of swaps/liquidity ops; configure with `V4_AGENT_STEPS`)
- capture txids + proof JSON

## Notes

- SQLite state lives in `data/app.sqlite` (ignored).
- Verification reports + logs are written to `data/reports/` and `data/logs/`.
- EIP-712 signing is enforced for quotes, submissions, and challenges.

## Security / Sandbox Notes

The verifier executes untrusted code (solver artifacts + Foundry). For a hackathon demo this repo assumes solvers are trusted bots and artifacts are simple template-based Solidity modules.

For production or public submissions, run verification in a sandbox. This repo supports `VERIFIER_SANDBOX=docker` (Foundry runs inside a container, with `--network=none` for build/tests).
