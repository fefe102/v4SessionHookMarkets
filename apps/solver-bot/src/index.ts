import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
const SOLVER_PRICE = process.env.SOLVER_PRICE ?? '0.05';
const SOLVER_ETA = Number(process.env.SOLVER_ETA_MINUTES ?? 15);
const BOT_POLL_MS = Number(process.env.BOT_POLL_MS ?? 0);
const QUOTE_DELAY_MIN_MS = Math.max(0, Number(process.env.BOT_QUOTE_DELAY_MS_MIN ?? 0));
const QUOTE_DELAY_MAX_MS = Math.max(QUOTE_DELAY_MIN_MS, Number(process.env.BOT_QUOTE_DELAY_MS_MAX ?? QUOTE_DELAY_MIN_MS));

if (!PRIVATE_KEY) {
  console.error('Missing SOLVER_PRIVATE_KEY');
  process.exit(1);
}

const privateKey = PRIVATE_KEY;
const wallet = new Wallet(privateKey);
const solverAddress = wallet.address;

const scheduledQuoteAtByWorkOrder = new Map<string, number>();
const inflightSubmissionByWorkOrder = new Set<string>();
let inflightSubmissionCount = 0;

function parseAmount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value <= 0) return '0';
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, '');
}

function resolveQuotePrice(workOrder: WorkOrder): string {
  const requested = parseAmount(SOLVER_PRICE);
  const bountyCap = parseAmount(workOrder.bounty?.amount);
  if (requested === null || bountyCap === null) return SOLVER_PRICE;
  return formatAmount(Math.min(requested, bountyCap));
}

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

async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; captureStdout?: boolean }
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: opts.captureStdout ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout.trim());
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
      reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code})${suffix}`));
    });
  });
}

function randomInt(min: number, max: number) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function quoteAtMs(workOrder: WorkOrder) {
  const existing = scheduledQuoteAtByWorkOrder.get(workOrder.id);
  if (existing !== undefined) return existing;
  const delayMs = randomInt(QUOTE_DELAY_MIN_MS, QUOTE_DELAY_MAX_MS);
  const scheduledAt = Math.max(Date.now(), workOrder.createdAt + delayMs);
  scheduledQuoteAtByWorkOrder.set(workOrder.id, scheduledAt);
  return scheduledAt;
}

async function submitQuote(workOrder: WorkOrder) {
  // Avoid spamming duplicate quotes when running in poll mode.
  const existing = await fetchJson<QuotePayload[]>(`${API_URL}/work-orders/${workOrder.id}/quotes`);
  if (existing.some((q) => q.solverAddress.toLowerCase() === solverAddress.toLowerCase())) {
    scheduledQuoteAtByWorkOrder.delete(workOrder.id);
    return;
  }

  const quotePrice = resolveQuotePrice(workOrder);
  const quoteMessage = {
    workOrderId: workOrder.id,
    price: quotePrice,
    etaMinutes: SOLVER_ETA,
    validUntil: Date.now() + 5 * 60 * 1000,
  };
  const signature = await signQuote(quoteMessage, privateKey);
  const quote: QuotePayload = {
    id: randomUUID(),
    workOrderId: workOrder.id,
    solverAddress,
    price: quotePrice,
    etaMinutes: SOLVER_ETA,
    validUntil: quoteMessage.validUntil,
    signature,
    createdAt: Date.now(),
  };

  try {
    await fetchJson(`${API_URL}/solver/quotes`, {
      method: 'POST',
      body: JSON.stringify(quote),
    });
    console.log(`quote submitted for ${workOrder.id}`);
    scheduledQuoteAtByWorkOrder.delete(workOrder.id);
  } catch (err) {
    const message = String((err as any)?.message ?? err);
    // Avoid log spam on unrecoverable 400s.
    if (message.includes('Quote exceeds bounty amount') || message.includes('Bidding window closed') || message.includes('not accepting quotes')) {
      scheduledQuoteAtByWorkOrder.delete(workOrder.id);
      return;
    }
    // Small backoff to avoid hammering the API if it's restarting.
    scheduledQuoteAtByWorkOrder.set(workOrder.id, Date.now() + 5000);
    throw err;
  }
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

async function initGitRepo(repoDir: string) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    await runCommand('git', ['init'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.email', 'solver@local'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.name', 'solver-bot'], { cwd: repoDir });
    await runCommand('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  }
  await runCommand('git', ['add', '.'], { cwd: repoDir });
  await runCommand('git', ['commit', '-m', 'feat: add hook artifact', '--allow-empty'], { cwd: repoDir });
  const commitSha = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repoDir, captureStdout: true });
  return commitSha;
}

async function submitArtifact(workOrder: WorkOrder) {
  const repoDir = ensureRepoDir(workOrder.id);
  writeHookTemplate(workOrder, repoDir);
  const commitSha = await initGitRepo(repoDir);
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

function startSubmission(workOrder: WorkOrder) {
  if (inflightSubmissionByWorkOrder.has(workOrder.id)) return;
  inflightSubmissionByWorkOrder.add(workOrder.id);
  inflightSubmissionCount += 1;
  // Fire-and-forget so bidding/quoting stays responsive during artifact creation.
  void submitArtifact(workOrder)
    .catch((err) => {
      console.error('submission failed', workOrder.id, err);
    })
    .finally(() => {
      inflightSubmissionByWorkOrder.delete(workOrder.id);
      inflightSubmissionCount = Math.max(0, inflightSubmissionCount - 1);
    });
}

async function runOnce() {
  const bidding = await fetchJson<WorkOrder[]>(`${API_URL}/solver/work-orders?status=BIDDING`);
  for (const workOrder of bidding) {
    // Skip stale BIDDING work orders (API doesn't auto-transition on time).
    if (Date.now() > workOrder.bidding.biddingEndsAt) {
      scheduledQuoteAtByWorkOrder.delete(workOrder.id);
      continue;
    }
    if (Date.now() < quoteAtMs(workOrder)) continue;
    try {
      await submitQuote(workOrder);
    } catch (err) {
      // Keep looping so one bad work order can't block all bidding activity.
      console.error('quote failed', workOrder.id, err);
    }
  }

  // Keep the polling loop responsive: only allow a small number of inflight submissions.
  const maxInflight = Math.max(1, Number(process.env.BOT_MAX_INFLIGHT_SUBMISSIONS ?? 1));
  if (inflightSubmissionCount >= maxInflight) return;

  const selected = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=SELECTED`);
  for (const workOrder of selected) {
    if (inflightSubmissionCount >= maxInflight) break;
    if (workOrder.selection.selectedSolverId?.toLowerCase() !== solverAddress.toLowerCase()) continue;
    const submissions = await fetchJson<SubmissionPayload[]>(`${API_URL}/work-orders/${workOrder.id}/submissions`);
    if (submissions.find((s) => s.solverAddress.toLowerCase() === solverAddress.toLowerCase())) continue;
    startSubmission(workOrder);
  }

  if (inflightSubmissionCount >= maxInflight) return;

  const challenged = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=CHALLENGED`);
  for (const workOrder of challenged) {
    if (inflightSubmissionCount >= maxInflight) break;
    if (workOrder.selection.selectedSolverId?.toLowerCase() !== solverAddress.toLowerCase()) continue;
    if (workOrder.deadlines.patchEndsAt && Date.now() > workOrder.deadlines.patchEndsAt) continue;
    startSubmission(workOrder);
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
