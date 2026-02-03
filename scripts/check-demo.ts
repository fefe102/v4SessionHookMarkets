type WorkOrder = {
  id: string;
  status: string;
  yellow?: { settlementTxId?: string | null };
};

type PaymentEvent = { id: string; type: string; amount: string; milestoneKey?: string | null };

type VerificationReport = { status: 'PASS' | 'FAIL'; proof: { txIds: string[] } };

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const workOrderId = process.argv[2];

if (!workOrderId) {
  console.error('Usage: pnpm tsx scripts/check-demo.ts <workOrderId>');
  process.exit(1);
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { 'content-type': 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function looksLikeTxHash(value: string | null | undefined) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);
}

async function main() {
  const workOrder = await fetchJson<WorkOrder>(`/work-orders/${workOrderId}`);
  const payments = await fetchJson<PaymentEvent[]>(`/work-orders/${workOrderId}/payments`);

  let report: VerificationReport | null = null;
  try {
    report = await fetchJson<VerificationReport>(`/work-orders/${workOrderId}/verification`);
  } catch {
    report = null;
  }

  const milestoneCount = payments.filter((p) => p.type === 'MILESTONE').length;
  const quoteRewardCount = payments.filter((p) => p.type === 'QUOTE_REWARD').length;
  const challengeRewardCount = payments.filter((p) => p.type === 'CHALLENGE_REWARD').length;

  console.log(`workOrder: ${workOrder.id}`);
  console.log(`status: ${workOrder.status}`);
  console.log(`payments: total=${payments.length} quoteRewards=${quoteRewardCount} milestones=${milestoneCount} challengeRewards=${challengeRewardCount}`);
  console.log(`settlementTxId: ${workOrder.yellow?.settlementTxId ?? 'n/a'}`);

  if (payments.length < 20) {
    console.log('WARN: fewer than 20 offchain payments. Set YELLOW_MILESTONE_SPLITS=5 (or higher) before running the demo.');
  } else {
    console.log('OK: >=20 offchain payments');
  }

  if (!report) {
    console.log('WARN: no verification report yet');
    return;
  }

  console.log(`verification: ${report.status} txIds=${report.proof.txIds.length}`);

  const agentSteps = Number(process.env.V4_AGENT_STEPS ?? 5);
  const minExpectedTx = Math.max(3, agentSteps + 3);
  if (report.proof.txIds.length < minExpectedTx) {
    console.log(`WARN: low tx count. Expected >= ${minExpectedTx} (agentSteps=${agentSteps}).`);
  } else {
    console.log('OK: v4 proof includes multiple txids');
  }

  const settlement = workOrder.yellow?.settlementTxId;
  if (!settlement) {
    console.log('WARN: no settlementTxId recorded yet (work order may not be COMPLETED)');
  } else if (looksLikeTxHash(settlement)) {
    console.log('OK: settlementTxId looks like an onchain tx hash');
  } else {
    console.log('WARN: settlementTxId is not a tx hash (enable YELLOW_ENABLE_CHANNELS=true for real onchain settlement attempts).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

