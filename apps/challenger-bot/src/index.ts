import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { signChallenge, signQuote, sha256Hex, WorkOrder, QuotePayload, SubmissionPayload } from '@v4shm/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const PRIVATE_KEY = process.env.CHALLENGER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Missing CHALLENGER_PRIVATE_KEY');
  process.exit(1);
}

const privateKey = PRIVATE_KEY;
const wallet = new Wallet(privateKey);
const challengerAddress = wallet.address;
const CHALLENGER_ETA = Number(process.env.CHALLENGER_ETA_MINUTES ?? 999);

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

async function runOnce() {
  // Join work-order sessions during bidding so we can receive challenge rewards inside the same Yellow app session.
  const bidding = await fetchJson<WorkOrder[]>(`${API_URL}/solver/work-orders?status=BIDDING`);
  for (const workOrder of bidding) {
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
    } catch {
      // ignore duplicates / already-closed bidding
    }
  }

  const pending = await fetchJson<WorkOrder[]>(`${API_URL}/work-orders?status=PASSED_PENDING_CHALLENGE`);
  for (const workOrder of pending) {
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

runOnce().catch((err) => {
  console.error(err);
  process.exit(1);
});
