# v4SessionHookMarkets

Instant Yellow session-paid agent market for Uniswap v4 hooks: tx proof, off-chain pay, settle once.

A new kind of marketplace where agents compete to deliver Uniswap v4 hook modules (new market structures). A requester posts a HookSpec (executable tests + an onchain proof script) and funds a single Yellow session. Solvers bid price/ETA and submit a commit; the verifier deploys the winning hook into a real v4 pool (Base Sepolia) and produces TxIDs/logs as receipts. Payments stream off-chain inside the session (quote rewards + milestones) and can optionally settle on-chain. Optional cross-chain funding/cashout via LI.FI.

Business model idea: small success fee + optional paid verification.

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

# One command (recommended): starts API + verifier + web + bots (reads .env if present)
pnpm demo:up
```

Open the Web UI (default: http://localhost:3000), create a work order, and watch quotes + verification events flow through.
If those ports are already in use, `pnpm demo:up` will print the actual URLs it started on.

Notes:
- The Work Order page live-updates via API websocket events (badge: `Live: live`) so you don't need manual refreshes during demos.
- The API auto-selects the best quote after the bidding window closes.
  - Demo shortcut: click `Close Bidding + Select` on the Work Order page (requires `V4SHM_DEMO_ACTIONS=true`; `pnpm demo:up` sets it by default), or call `POST /work-orders/:id/select?force=true`.
- After verification passes, the challenge window opens; the API auto-settles when it expires.
- Quote rewards are paid when the bidding window closes (the Yellow session is created at bidding close so all quote rewards happen inside the same session).
- To receive a challenge reward inside the same Yellow session, challengers must submit a signed quote during bidding (so they are included as a session participant).
- To guarantee 2+ quotes, set `SOLVER_B_PRIVATE_KEY` (starts a second solver bot with a different price/ETA).
- For Yellow prize demos, set `YELLOW_MILESTONE_SPLITS=5` (or higher) to stream each milestone as multiple offchain transfers (`pnpm demo:up` defaults this to 5 if unset).
- For Uniswap v4 TxIDs volume, set `V4_AGENT_STEPS=5` (or higher) for a multi-tx “agent loop” (`pnpm demo:up` defaults this to 5 if unset).
- Optional LI.FI prize: open http://localhost:3000/lifi to bridge/swap cross-chain (fund requester or cash out). Requires a browser wallet.

Fast demo video (20–30 seconds):
1) (Off-camera) Create a work order, wait for 2+ quotes, click `Close Bidding + Select`, then wait until “Payments” has multiple entries and “Verification Report” shows `TxIDs: N`.
2) (On-camera) Start on the Work Order page, show Payments + TxIDs, then click `End Session`.

Manual startup (if you prefer separate terminals):

```bash
# Terminal 1
pnpm -C apps/verifier dev

# Terminal 2
pnpm -C apps/api dev

# Terminal 3
pnpm -C apps/web dev

# Terminal 4 (optional bots; set BOT_POLL_MS=5000 for polling)
BOT_POLL_MS=5000 pnpm -C apps/solver-bot dev
BOT_POLL_MS=5000 pnpm -C apps/challenger-bot dev
```

## Real mode (Yellow + Base Sepolia proof)

1) Copy `.env.example` to `.env` and fill:
- `YELLOW_MODE=real` + Yellow RPC/WS + requester key
- `VERIFIER_MODE=real` + `V4_RPC_URL` + verifier key
- `V4_POOL_MANAGER` for Base Sepolia (default already set)
- Demo knobs: `YELLOW_MILESTONE_SPLITS=5`, `V4_AGENT_STEPS=5`, `V4SHM_DEMO_ACTIONS=true`
- Demo bots: `SOLVER_PRIVATE_KEY` and `SOLVER_B_PRIVATE_KEY` (optional: `BOT_POLL_MS=1000`)

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
# From repo root (recommended helper):
pnpm harness:check
pnpm harness:install

# Or manually:
cd harness/v4-hook-harness
forge install uniswap/v4-core --no-commit
git -C lib/v4-core submodule update --init --recursive
```

4) Ensure the verifier key has Base Sepolia ETH for gas. (Optional helper: `pnpm fund:sepolia`.)

5) Run verifier + API as usual. The verifier will:
- `forge build` + `forge test`
- broadcast `script/V4Proof.s.sol` to Base Sepolia (includes a deterministic "agent loop" of swaps/liquidity ops; configure with `V4_AGENT_STEPS`)
- capture txids + proof JSON

You can use `pnpm demo:up` in real mode too (it reads `.env`).

## Notes

- SQLite state lives in `data/app.sqlite` (ignored).
- Verification reports + logs are written to `data/reports/` and `data/logs/`.
- EIP-712 signing is enforced for quotes, submissions, and challenges.

## Security / Sandbox Notes

The verifier executes untrusted code (solver artifacts + Foundry). For a hackathon demo this repo assumes solvers are trusted bots and artifacts are simple template-based Solidity modules.

For production or public submissions, run verification in a sandbox. This repo supports `VERIFIER_SANDBOX=docker` (Foundry runs inside a container, with `--network=none` for build/tests).

## Hosting

GitHub Pages can host a static landing page (README/video), but it cannot run the API/verifier/bots. For an interactive hosted demo you need to deploy `apps/api` + `apps/verifier` somewhere and point the UI at it via `NEXT_PUBLIC_API_BASE`.
