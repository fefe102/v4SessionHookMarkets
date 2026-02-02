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
- `harness/v4-hook-harness`: Foundry scaffold.
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
export SOLVER_PRIVATE_KEY=0x...
pnpm -C apps/solver-bot dev
```

Open http://localhost:3000, create a work order, and watch quotes + verification events flow through.

## Env config

Copy `.env.example` to `.env` and fill in keys. The repo ships in mock mode for Yellow + verifier; switch to real mode once you wire in the onchain harness.

## Notes

- SQLite state lives in `data/app.sqlite` (ignored).
- Verification reports + logs are written to `data/reports/` and `data/logs/`.
- EIP-712 signing is enforced for quotes, submissions, and challenges.
