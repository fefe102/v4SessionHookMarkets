import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { signChallenge, signQuote, sha256Hex, WorkOrder, QuotePayload, SubmissionPayload } from '@v4shm/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const PRIVATE_KEY = process.env.CHALLENGER_PRIVATE_KEY;
const BOT_POLL_MS = Number(process.env.BOT_POLL_MS ?? 0);
const QUOTE_DELAY_MIN_MS = Math.max(0, Number(process.env.BOT_QUOTE_DELAY_MS_MIN ?? 0));
const QUOTE_DELAY_MAX_MS = Math.max(QUOTE_DELAY_MIN_MS, Number(process.env.BOT_QUOTE_DELAY_MS_MAX ?? QUOTE_DELAY_MIN_MS));

if (!PRIVATE_KEY) {
  console.error('Missing CHALLENGER_PRIVATE_KEY');
  process.exit(1);
}

const privateKey = PRIVATE_KEY;
const wallet = new Wallet(privateKey);
const challengerAddress = wallet.address;
const CHALLENGER_ETA = Number(process.env.CHALLENGER_ETA_MINUTES ?? 45);

const scheduledJoinAtByWorkOrder = new Map<string, number>();

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

function randomInt(min: number, max: number) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function joinAtMs(workOrder: WorkOrder) {
  const existing = scheduledJoinAtByWorkOrder.get(workOrder.id);
  if (existing !== undefined) return existing;
  const delayMs = randomInt(QUOTE_DELAY_MIN_MS, QUOTE_DELAY_MAX_MS);
  const scheduledAt = Math.max(Date.now(), workOrder.createdAt + delayMs);
  scheduledJoinAtByWorkOrder.set(workOrder.id, scheduledAt);
  return scheduledAt;
}

async function runOnce() {
  // Join work-order sessions during bidding so we can receive challenge rewards inside the same Yellow app session.
  const bidding = await fetchJson<WorkOrder[]>(`${API_URL}/solver/work-orders?status=BIDDING`);
  for (const workOrder of bidding) {
    // Skip stale BIDDING work orders (API doesn't auto-transition on time).
    if (Date.now() > workOrder.bidding.biddingEndsAt) {
      scheduledJoinAtByWorkOrder.delete(workOrder.id);
      continue;
    }
    if (Date.now() < joinAtMs(workOrder)) continue;
    const existing = await fetchJson<QuotePayload[]>(`${API_URL}/work-orders/${workOrder.id}/quotes`);
    if (existing.some((q) => q.solverAddress.toLowerCase() === challengerAddress.toLowerCase())) continue;

    const quoteMessage = {
      workOrderId: workOrder.id,
      price: String(workOrder.bounty.amount),
      etaMinutes: CHALLENGER_ETA,
      validUntil: Date.now() + 5 * 60 * 1000,
    };
    const signature = await signQuote(quoteMessage, privateKey);
    const quote: QuotePayload = {
      id: randomUUID(),
      workOrderId: workOrder.id,
      solverAddress: challengerAddress,
      price: quoteMessage.price,
      etaMinutes: quoteMessage.etaMinutes,
      validUntil: quoteMessage.validUntil,
      signature,
      createdAt: Date.now(),
    };
    try {
      await fetchJson(`${API_URL}/solver/quotes`, {
        method: 'POST',
        body: JSON.stringify(quote),
      });
      console.log(`joined bidding for ${workOrder.id}`);
      scheduledJoinAtByWorkOrder.delete(workOrder.id);
    } catch (err) {
      const message = String((err as any)?.message ?? err);
      if (message.includes('Bidding window closed') || message.includes('not accepting quotes')) {
        scheduledJoinAtByWorkOrder.delete(workOrder.id);
      }
    }
  }

  const pending = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=PASSED_PENDING_CHALLENGE`);
  for (const workOrder of pending) {
    if (workOrder.challenge?.status !== 'OPEN') continue;
    const submissions = await fetchJson<SubmissionPayload[]>(`${API_URL}/work-orders/${workOrder.id}/submissions`);
    if (!submissions.length) continue;
    const submission = submissions[submissions.length - 1];
    const reproductionSpec = { reason: 'demo_challenge', workOrderId: workOrder.id };
    const reproductionHash = sha256Hex(JSON.stringify(reproductionSpec));
    const signature = await signChallenge(
      {
        workOrderId: workOrder.id,
        submissionId: submission.id,
        reproductionHash,
      },
      privateKey
    );

    await fetchJson(`${API_URL}/challenger/challenges`, {
      method: 'POST',
      body: JSON.stringify({
        id: randomUUID(),
        workOrderId: workOrder.id,
        submissionId: submission.id,
        challengerAddress,
        reproductionSpec,
        signature,
        createdAt: Date.now(),
      }),
    });

    console.log(`challenge submitted for ${workOrder.id}`);
  }
}

async function main() {
  if (Number.isFinite(BOT_POLL_MS) && BOT_POLL_MS > 0) {
    console.log(`challenger-bot: polling every ${BOT_POLL_MS}ms as ${challengerAddress}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await runOnce();
      } catch (err) {
        console.error('challenger-bot loop error', err);
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
