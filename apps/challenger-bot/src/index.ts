import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { signChallenge, sha256Hex, WorkOrder, SubmissionPayload } from '@v4shm/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const PRIVATE_KEY = process.env.CHALLENGER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Missing CHALLENGER_PRIVATE_KEY');
  process.exit(1);
}

const privateKey = PRIVATE_KEY;
const wallet = new Wallet(privateKey);
const challengerAddress = wallet.address;

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
