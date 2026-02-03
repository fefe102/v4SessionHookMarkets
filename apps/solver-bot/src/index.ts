import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { Wallet } from 'ethers';
import {
  signQuote,
  signSubmission,
  sha256Hex,
  WorkOrder,
  QuotePayload,
  SubmissionPayload,
} from '@v4shm/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const PRIVATE_KEY = process.env.SOLVER_PRIVATE_KEY;
const SOLVER_PRICE = process.env.SOLVER_PRICE ?? '10';
const SOLVER_ETA = Number(process.env.SOLVER_ETA_MINUTES ?? 15);
const BOT_POLL_MS = Number(process.env.BOT_POLL_MS ?? 0);

if (!PRIVATE_KEY) {
  console.error('Missing SOLVER_PRIVATE_KEY');
  process.exit(1);
}

const privateKey = PRIVATE_KEY;
const wallet = new Wallet(privateKey);
const solverAddress = wallet.address;

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function submitQuote(workOrder: WorkOrder) {
  // Avoid spamming duplicate quotes when running in poll mode.
  const existing = await fetchJson<QuotePayload[]>(`${API_URL}/work-orders/${workOrder.id}/quotes`);
  if (existing.some((q) => q.solverAddress.toLowerCase() === solverAddress.toLowerCase())) {
    return;
  }

  const quoteMessage = {
    workOrderId: workOrder.id,
    price: SOLVER_PRICE,
    etaMinutes: SOLVER_ETA,
    validUntil: Date.now() + 5 * 60 * 1000,
  };
  const signature = await signQuote(quoteMessage, privateKey);
  const quote: QuotePayload = {
    id: randomUUID(),
    workOrderId: workOrder.id,
    solverAddress,
    price: SOLVER_PRICE,
    etaMinutes: SOLVER_ETA,
    validUntil: quoteMessage.validUntil,
    signature,
    createdAt: Date.now(),
  };

  await fetchJson(`${API_URL}/solver/quotes`, {
    method: 'POST',
    body: JSON.stringify(quote),
  });
  console.log(`quote submitted for ${workOrder.id}`);
}

function ensureRepoDir(workOrderId: string) {
  const repoDir = path.resolve('data', 'solver-artifacts', workOrderId, solverAddress.slice(2, 8));
  fs.mkdirSync(repoDir, { recursive: true });
  return repoDir;
}

function writeHookTemplate(workOrder: WorkOrder, repoDir: string) {
  // These are deliberately minimal hook modules that match the harness tests.
  const hookBody = workOrder.templateType === 'SWAP_CAP_HOOK'
    ? `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SwapCapHook {
  uint256 public capAmountIn;

  constructor(uint256 _capAmountIn) {
    capAmountIn = _capAmountIn;
  }

  function canSwap(uint256 amountIn) external view returns (bool) {
    return amountIn <= capAmountIn;
  }
}
`
    : `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract WhitelistHook {
  mapping(address => bool) public allowed;

  constructor(address a, address b) {
    allowed[a] = true;
    allowed[b] = true;
  }

  function canSwap(address trader) external view returns (bool) {
    return allowed[trader];
  }
}
`;

  fs.writeFileSync(path.join(repoDir, 'Hook.sol'), hookBody, 'utf8');
}

function initGitRepo(repoDir: string) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "solver@local"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "solver-bot"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: repoDir, stdio: 'ignore' });
  }
  execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "feat: add hook artifact" --allow-empty', { cwd: repoDir, stdio: 'ignore' });
  const commitSha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
  return commitSha;
}

async function submitArtifact(workOrder: WorkOrder) {
  const repoDir = ensureRepoDir(workOrder.id);
  writeHookTemplate(workOrder, repoDir);
  const commitSha = initGitRepo(repoDir);
  const repoUrl = repoDir;
  const artifactHash = sha256Hex(`${repoUrl}:${commitSha}`);

  const signature = await signSubmission(
    {
      workOrderId: workOrder.id,
      repoUrl,
      commitSha,
      artifactHash,
    },
    privateKey
  );

  const submission: SubmissionPayload = {
    id: randomUUID(),
    workOrderId: workOrder.id,
    solverAddress,
    artifact: {
      kind: 'GIT_COMMIT',
      repoUrl,
      commitSha,
      artifactHash,
    },
    signature,
    createdAt: Date.now(),
  };

  await fetchJson(`${API_URL}/solver/submissions`, {
    method: 'POST',
    body: JSON.stringify(submission),
  });
  console.log(`submission sent for ${workOrder.id}`);
}

async function runOnce() {
  const bidding = await fetchJson<WorkOrder[]>(`${API_URL}/solver/work-orders?status=BIDDING`);
  for (const workOrder of bidding) {
    await submitQuote(workOrder);
  }

  const selected = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=SELECTED`);
  for (const workOrder of selected) {
    if (workOrder.selection.selectedSolverId?.toLowerCase() !== solverAddress.toLowerCase()) continue;
    const submissions = await fetchJson<SubmissionPayload[]>(`${API_URL}/work-orders/${workOrder.id}/submissions`);
    if (submissions.find((s) => s.solverAddress.toLowerCase() === solverAddress.toLowerCase())) continue;
    await submitArtifact(workOrder);
  }

  const challenged = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=CHALLENGED`);
  for (const workOrder of challenged) {
    if (workOrder.selection.selectedSolverId?.toLowerCase() !== solverAddress.toLowerCase()) continue;
    if (workOrder.deadlines.patchEndsAt && Date.now() > workOrder.deadlines.patchEndsAt) continue;
    await submitArtifact(workOrder);
  }
}

async function main() {
  if (Number.isFinite(BOT_POLL_MS) && BOT_POLL_MS > 0) {
    console.log(`solver-bot: polling every ${BOT_POLL_MS}ms as ${solverAddress}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await runOnce();
      } catch (err) {
        console.error('solver-bot loop error', err);
      }
      await sleep(BOT_POLL_MS);
    }
  }

  await runOnce();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
