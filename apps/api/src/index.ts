import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, Wallet } from 'ethers';
import {
  QuoteMessage,
  SubmissionMessage,
  ChallengeMessage,
  WorkOrder,
  QuotePayload,
  SubmissionPayload,
  PaymentEvent,
  YELLOW_ASSET,
  sha256Hex,
  recoverQuoteSigner,
  recoverSubmissionSigner,
  recoverChallengeSigner,
} from '@v4shm/shared';
import { createDb } from './db.js';
import { EventBus } from './events.js';
import { YellowClient, type YellowSessionState } from '@v4shm/yellow-client';
import { calculateReputation, emptySolverStats, type SolverStats } from './reputation.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

const BIDDING_WINDOW_MS = 5 * 60 * 1000;
const DELIVERY_WINDOW_MS = 25 * 60 * 1000;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;
const PATCH_WINDOW_MS = 10 * 60 * 1000;
const QUOTE_REWARD = 0.01;
const MAX_QUOTE_REWARDS = 20;
const MILESTONE_SPLITS = Math.max(1, Math.min(20, Number(process.env.YELLOW_MILESTONE_SPLITS ?? 1)));
const AUTO_TICK_MS = 5 * 1000;

const VERIFIER_URL = process.env.VERIFIER_URL ?? 'http://localhost:3002';
const EVENT_LOG_PATH = process.env.V4SHM_EVENT_LOG
  ? path.resolve(repoRoot, process.env.V4SHM_EVENT_LOG)
  : path.join(repoRoot, 'data', 'events.jsonl');
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

const yellowMode = process.env.YELLOW_MODE === 'real' ? 'real' : 'mock';
const yellowClient = new YellowClient({
  mode: yellowMode,
  apiUrl: API_URL,
});

const quietLogs = process.env.V4SHM_QUIET_LOGS === 'true';
const server = Fastify({
  logger: { base: null },
  disableRequestLogging: quietLogs,
});
const db = createDb();
const events = new EventBus(EVENT_LOG_PATH);

await server.register(cors, { origin: true });
await server.register(websocket);

function emit(workOrderId: string, type: string, payload: unknown) {
  const event = {
    id: randomUUID(),
    workOrderId,
    type,
    createdAt: Date.now(),
    payload,
  };
  events.emit(event);
}

function buildSessionState(workOrder: WorkOrder): YellowSessionState | null {
  if (!workOrder.yellow.yellowSessionId || !workOrder.yellow.allowanceTotal) return null;
  if (!workOrder.yellow.participants || !workOrder.yellow.allocations) return null;
  if (workOrder.yellow.sessionVersion === undefined || workOrder.yellow.sessionVersion === null) return null;
  return {
    sessionId: workOrder.yellow.yellowSessionId,
    allowanceTotal: workOrder.yellow.allowanceTotal,
    participants: workOrder.yellow.participants,
    allocations: workOrder.yellow.allocations,
    version: workOrder.yellow.sessionVersion,
  };
}

function applySessionState(workOrder: WorkOrder, sessionState: YellowSessionState | null) {
  if (!sessionState) return;
  workOrder.yellow.yellowSessionId = sessionState.sessionId;
  workOrder.yellow.allowanceTotal = sessionState.allowanceTotal;
  workOrder.yellow.participants = sessionState.participants;
  workOrder.yellow.allocations = sessionState.allocations;
  workOrder.yellow.sessionVersion = sessionState.version;
}

function toUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  const padded = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+/, '') || '0';
  return BigInt(padded);
}

function fromUnits(value: bigint, decimals: number): string {
  const raw = value.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals) || '0';
  const frac = raw.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function splitUnits(total: bigint, parts: number): bigint[] {
  if (parts <= 1) return [total];
  const p = BigInt(parts);
  const base = total / p;
  const rem = total % p;
  const out: bigint[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(base + (BigInt(i) < rem ? 1n : 0n));
  }
  return out.filter((v) => v > 0n);
}

function totalPaidForMilestone(workOrderId: string, milestoneKey: string, toAddress: string): bigint {
  const payments = db.listPaymentEvents(workOrderId).map((evt) => evt.payload as PaymentEvent);
  const lower = toAddress.toLowerCase();
  return payments
    .filter((evt) => evt.type === 'MILESTONE' && evt.milestoneKey === milestoneKey && evt.toAddress.toLowerCase() === lower)
    .reduce((acc, evt) => acc + toUnits(String(evt.amount), YELLOW_ASSET.decimals), 0n);
}

function persistWorkOrder(workOrder: WorkOrder) {
  db.updateWorkOrder({
    id: workOrder.id,
    createdAt: workOrder.createdAt,
    status: workOrder.status,
    payload: workOrder,
  });
}

function getSolverStats(address: string): SolverStats {
  const record = db.getSolverStats(address.toLowerCase());
  if (!record) return emptySolverStats(address.toLowerCase());
  return record.payload as SolverStats;
}

function saveSolverStats(stats: SolverStats) {
  db.upsertSolverStats({
    solverAddress: stats.solverAddress.toLowerCase(),
    payload: stats,
  });
}

function selectBestQuote(quotes: QuotePayload[]) {
  const reputation = new Map<string, number>();
  for (const quote of quotes) {
    const key = quote.solverAddress.toLowerCase();
    if (reputation.has(key)) continue;
    reputation.set(key, calculateReputation(getSolverStats(quote.solverAddress)).score);
  }

  return [...quotes].sort((a, b) => {
    const priceDiff = Number(a.price) - Number(b.price);
    if (priceDiff !== 0) return priceDiff;
    const etaDiff = a.etaMinutes - b.etaMinutes;
    if (etaDiff !== 0) return etaDiff;
    const repA = reputation.get(a.solverAddress.toLowerCase()) ?? 0;
    const repB = reputation.get(b.solverAddress.toLowerCase()) ?? 0;
    if (repA !== repB) return repB - repA;
    return a.createdAt - b.createdAt;
  })[0];
}

function selectNextQuote(quotes: QuotePayload[], attempted: string[]) {
  const attemptedSolvers = new Set<string>();
  for (const attemptedId of attempted) {
    const quote = quotes.find((q) => q.id === attemptedId);
    if (quote) attemptedSolvers.add(quote.solverAddress.toLowerCase());
  }

  const filtered = quotes.filter((quote) => !attemptedSolvers.has(quote.solverAddress.toLowerCase()));
  if (filtered.length === 0) return null;
  return selectBestQuote(filtered);
}

function requireWorkOrder(id: string) {
  const record = db.getWorkOrder(id);
  if (!record) return null;
  return normalizeWorkOrder(record.payload as WorkOrder);
}

function normalizeWorkOrder(workOrder: WorkOrder): WorkOrder {
  const selection = workOrder.selection ?? { selectedQuoteId: null, selectedSolverId: null };
  return {
    ...workOrder,
    selection: {
      ...selection,
      selectedAt: selection.selectedAt ?? null,
      attemptedQuoteIds: selection.attemptedQuoteIds ?? [],
    },
    deadlines: {
      ...workOrder.deadlines,
      patchEndsAt: workOrder.deadlines.patchEndsAt ?? null,
    },
    challenge: workOrder.challenge ?? {
      status: 'NONE',
      challengeId: null,
      challengerAddress: null,
      pendingRewardAmount: null,
    },
  };
}

function computeAllowanceTotal(workOrder: WorkOrder, quotes: QuotePayload[]) {
  const solverCount = collectSessionSolversFromQuotes(quotes).length;
  return (Number(workOrder.bounty.amount) + QUOTE_REWARD * solverCount).toFixed(2);
}

function collectSessionSolversFromQuotes(quotes: QuotePayload[]) {
  const sorted = [...quotes].sort((a, b) => a.createdAt - b.createdAt);
  const solvers: string[] = [];
  const seen = new Set<string>();
  for (const quote of sorted) {
    const key = quote.solverAddress.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    solvers.push(quote.solverAddress);
    if (solvers.length >= MAX_QUOTE_REWARDS) break;
  }
  return solvers;
}

async function ensureYellowSession(workOrder: WorkOrder, quotes: QuotePayload[]) {
  const existing = buildSessionState(workOrder);
  if (existing) return existing;

  const solverAddresses = collectSessionSolversFromQuotes(quotes);
  if (solverAddresses.length === 0) {
    throw new Error('Cannot create Yellow session without any solver quotes');
  }

  // Only reserve what we can actually spend: bounty + quote rewards for observed quotes.
  // This keeps demo wallets usable and avoids locking MAX_QUOTE_REWARDS worth of funds.
  const allowanceTotal = computeAllowanceTotal(workOrder, quotes);
  // Session allocations must cover both bounty payouts and quote rewards.
  const allocationTotal = allowanceTotal;

  const session = await yellowClient.createSession({
    workOrderId: workOrder.id,
    allowanceTotal,
    allocationTotal,
    solverAddresses,
    requesterAddress: workOrder.requesterAddress ?? undefined,
  });
  applySessionState(workOrder, session);
  workOrder.requesterAddress = session.participants[0] ?? workOrder.requesterAddress ?? null;
  return session;
}

function applySelection(workOrder: WorkOrder, selectedQuote: QuotePayload) {
  const now = Date.now();
  workOrder.status = 'SELECTED';
  workOrder.selection.selectedQuoteId = selectedQuote.id;
  workOrder.selection.selectedSolverId = selectedQuote.solverAddress;
  workOrder.selection.selectedAt = now;
  workOrder.deadlines.deliveryEndsAt = now + DELIVERY_WINDOW_MS;
  workOrder.deadlines.verifyEndsAt = now + VERIFY_WINDOW_MS;
  workOrder.deadlines.challengeEndsAt = null;
  workOrder.deadlines.patchEndsAt = null;
  workOrder.challenge.status = 'NONE';
  workOrder.challenge.challengeId = null;
  workOrder.challenge.challengerAddress = null;
  workOrder.challenge.pendingRewardAmount = null;
}

function hasPaymentEvent(workOrderId: string, predicate: (evt: PaymentEvent) => boolean) {
  const events = db.listPaymentEvents(workOrderId).map((evt) => evt.payload as PaymentEvent);
  return events.some(predicate);
}

async function recordPayment(workOrder: WorkOrder, paymentEvent: PaymentEvent) {
  const transfer = await yellowClient.transfer({
    workOrderId: workOrder.id,
    event: paymentEvent,
    sessionState: buildSessionState(workOrder),
    allowanceTotal: workOrder.yellow.allowanceTotal,
  });
  paymentEvent.yellowTransferId = transfer.transferId;
  applySessionState(workOrder, transfer.sessionState ?? null);
  persistWorkOrder(workOrder);
  db.insertPaymentEvent({
    id: paymentEvent.id,
    workOrderId: workOrder.id,
    createdAt: paymentEvent.createdAt,
    type: paymentEvent.type,
    payload: paymentEvent,
  });
  return paymentEvent;
}

async function ensureQuoteRewardsPaid(workOrder: WorkOrder, quotes: QuotePayload[]) {
  const solvers = collectSessionSolversFromQuotes(quotes);
  if (solvers.length === 0) return;

  const alreadyPaidTo = new Set(
    db
      .listPaymentEvents(workOrder.id)
      .filter((evt) => evt.type === 'QUOTE_REWARD')
      .map((evt) => (evt.payload as PaymentEvent).toAddress.toLowerCase())
  );

  for (const solverAddress of solvers) {
    if (alreadyPaidTo.has(solverAddress.toLowerCase())) continue;
    const paymentEvent: PaymentEvent = {
      id: randomUUID(),
      workOrderId: workOrder.id,
      type: 'QUOTE_REWARD',
      toAddress: solverAddress,
      amount: QUOTE_REWARD.toFixed(2),
      yellowTransferId: null,
      createdAt: Date.now(),
    };
    await recordPayment(workOrder, paymentEvent);
    emit(workOrder.id, 'quoteRewardPaid', paymentEvent);
  }
}

async function settleWorkOrder(workOrder: WorkOrder) {
  if (workOrder.status !== 'PASSED_PENDING_CHALLENGE') return null;
  if (workOrder.challenge.status === 'PATCH_WINDOW') return null;

  const selectedQuoteId = workOrder.selection.selectedQuoteId;
  const selectedQuote = selectedQuoteId
    ? (db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload).find((q) => q.id === selectedQuoteId) ?? null)
    : null;
  const basePrice = selectedQuote ? Number(selectedQuote.price) : Number(workOrder.bounty.amount);
  const holdback = ((basePrice * 20) / 100).toFixed(4);

  const solver = workOrder.selection.selectedSolverId ?? '0x0000000000000000000000000000000000000000';
  const holdbackUnits = toUnits(holdback, YELLOW_ASSET.decimals);
  const alreadyPaidUnits = totalPaidForMilestone(workOrder.id, 'M5_NO_CHALLENGE_OR_PATCH_OK', solver);
  if (alreadyPaidUnits < holdbackUnits) {
    const paymentEvent: PaymentEvent = {
      id: randomUUID(),
      workOrderId: workOrder.id,
      type: 'MILESTONE',
      toAddress: solver,
      amount: fromUnits(holdbackUnits - alreadyPaidUnits, YELLOW_ASSET.decimals),
      yellowTransferId: null,
      milestoneKey: 'M5_NO_CHALLENGE_OR_PATCH_OK',
      createdAt: Date.now(),
    };
    await recordPayment(workOrder, paymentEvent);
    emit(workOrder.id, 'milestonePaid', paymentEvent);
  }

  const sessionState = buildSessionState(workOrder);
  if (!sessionState) return null;
  const result = await yellowClient.closeSession({ workOrderId: workOrder.id, sessionState });
  workOrder.yellow.settlementTxId = result.settlementTxId;
  workOrder.status = 'COMPLETED';
  persistWorkOrder(workOrder);
  emit(workOrder.id, 'workOrderCompleted', { settlement: result });
  return result;
}

async function finalizeChallengeFailure(workOrder: WorkOrder) {
  const challenger = workOrder.challenge.challengerAddress;
  const pending = workOrder.challenge.pendingRewardAmount;
  if (!challenger || !pending) return;

  const alreadyPaid = hasPaymentEvent(workOrder.id, (evt) => evt.type === 'CHALLENGE_REWARD');
  if (!alreadyPaid) {
    const paymentEvent: PaymentEvent = {
      id: randomUUID(),
      workOrderId: workOrder.id,
      type: 'CHALLENGE_REWARD',
      toAddress: challenger,
      amount: pending,
      yellowTransferId: null,
      milestoneKey: 'M5_NO_CHALLENGE_OR_PATCH_OK',
      createdAt: Date.now(),
    };
    await recordPayment(workOrder, paymentEvent);
    emit(workOrder.id, 'challengeRewardPaid', paymentEvent);
  }

  const selectedQuoteId = workOrder.selection.selectedQuoteId;
  if (selectedQuoteId) {
    const selectedQuote = db
      .listQuotes(workOrder.id)
      .map((q) => q.payload as QuotePayload)
      .find((q) => q.id === selectedQuoteId);
    if (selectedQuote) {
      const solverStats = getSolverStats(selectedQuote.solverAddress);
      solverStats.challengesAgainst += 1;
      saveSolverStats(solverStats);
    }
  }
  const challengerStats = getSolverStats(challenger);
  challengerStats.challengesWon += 1;
  saveSolverStats(challengerStats);

  workOrder.status = 'FAILED';
  workOrder.challenge.status = 'PATCH_FAILED';
  workOrder.challenge.pendingRewardAmount = null;
  persistWorkOrder(workOrder);
  emit(workOrder.id, 'challengeFailed', { workOrderId: workOrder.id });
}

server.get('/health', async () => ({ ok: true }));

server.get('/config', async () => {
  const chainId = Number(process.env.V4_CHAIN_ID ?? YELLOW_ASSET.chainId ?? 84532);

  let requesterAddress: string | null = null;
  if (process.env.YELLOW_REQUESTER_ADDRESS) {
    try {
      requesterAddress = getAddress(process.env.YELLOW_REQUESTER_ADDRESS);
    } catch {
      requesterAddress = null;
    }
  } else if (process.env.YELLOW_PRIVATE_KEY) {
    try {
      requesterAddress = new Wallet(process.env.YELLOW_PRIVATE_KEY).address;
    } catch {
      requesterAddress = null;
    }
  }

  let verifierAddress: string | null = null;
  if (process.env.V4_PRIVATE_KEY) {
    try {
      verifierAddress = new Wallet(process.env.V4_PRIVATE_KEY).address;
    } catch {
      verifierAddress = null;
    }
  }

  return {
    chainId,
    yellow: {
      mode: yellowMode,
      asset: YELLOW_ASSET,
      requesterAddress,
      enableChannels: process.env.YELLOW_ENABLE_CHANNELS === 'true',
    },
    verifier: {
      chainId,
      address: verifierAddress,
    },
  };
});

server.get('/work-orders', async (request) => {
  const { status } = request.query as { status?: string };
  const records = db.listWorkOrders(status);
  return records.map((record) => normalizeWorkOrder(record.payload as WorkOrder));
});

server.post('/work-orders', async (request, reply) => {
  const body = request.body as {
    title?: string;
    templateType?: WorkOrder['templateType'];
    params?: Record<string, unknown>;
    bounty?: { currency: string; amount: string | number };
    requesterAddress?: string;
  };

  if (!body?.title || !body?.templateType || !body?.bounty) {
    return reply.status(400).send({
      error: 'Missing required fields: title, templateType, bounty',
    });
  }

  let requesterAddress: string | null = null;
  if (body.requesterAddress) {
    try {
      requesterAddress = getAddress(body.requesterAddress);
    } catch {
      return reply.status(400).send({ error: 'Invalid requester address' });
    }
  }

  const now = Date.now();
  const id = randomUUID();
  const status: WorkOrder['status'] = 'BIDDING';

  const workOrder: WorkOrder = {
    id,
    createdAt: now,
    status,
    title: body.title,
    templateType: body.templateType,
    params: body.params ?? {},
    bounty: {
      currency: body.bounty.currency,
      amount: String(body.bounty.amount),
    },
    requesterAddress,
    bidding: {
      biddingEndsAt: now + BIDDING_WINDOW_MS,
    },
    deadlines: {
      deliveryEndsAt: null,
      verifyEndsAt: null,
      challengeEndsAt: null,
      patchEndsAt: null,
    },
    selection: {
      selectedQuoteId: null,
      selectedSolverId: null,
      selectedAt: null,
      attemptedQuoteIds: [],
    },
    challenge: {
      status: 'NONE',
      challengeId: null,
      challengerAddress: null,
      pendingRewardAmount: null,
    },
    yellow: {
      yellowSessionId: null,
      sessionAssetAddress: YELLOW_ASSET.token,
      allowanceTotal: null,
      participants: undefined,
      allocations: undefined,
      sessionVersion: undefined,
    },
    milestones: {
      payoutSchedule: [
        { key: 'M1_COMPILE_OK', percent: 10 },
        { key: 'M2_TESTS_OK', percent: 25 },
        { key: 'M3_DEPLOY_OK', percent: 20 },
        { key: 'M4_V4_POOL_PROOF_OK', percent: 25 },
        { key: 'M5_NO_CHALLENGE_OR_PATCH_OK', percent: 20 },
      ],
    },
    artifacts: {
      harnessVersion: null,
      harnessHash: null,
    },
    verification: {
      verificationReportId: null,
    },
  };

  db.insertWorkOrder({
    id,
    createdAt: now,
    status,
    payload: workOrder,
  });

  emit(id, 'workOrderCreated', workOrder);

  return reply.status(201).send(workOrder);
});

server.get('/work-orders/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const workOrder = requireWorkOrder(id);
  if (!workOrder) {
    return reply.status(404).send({ error: 'Work order not found' });
  }
  return workOrder;
});

server.get('/work-orders/:id/quotes', async (request, reply) => {
  const { id } = request.params as { id: string };
  const workOrder = requireWorkOrder(id);
  if (!workOrder) {
    return reply.status(404).send({ error: 'Work order not found' });
  }
  const quotes = db.listQuotes(id).map((q) => q.payload);
  return quotes;
});

server.get('/work-orders/:id/submissions', async (request, reply) => {
  const { id } = request.params as { id: string };
  const workOrder = requireWorkOrder(id);
  if (!workOrder) {
    return reply.status(404).send({ error: 'Work order not found' });
  }
  const submissions = db.listSubmissions(id).map((s) => s.payload);
  return submissions;
});

server.get('/work-orders/:id/verification', async (request, reply) => {
  const { id } = request.params as { id: string };
  const workOrder = requireWorkOrder(id);
  if (!workOrder) {
    return reply.status(404).send({ error: 'Work order not found' });
  }
  if (!workOrder.verification.verificationReportId) {
    return reply.status(404).send({ error: 'No verification report yet' });
  }
  const report = db.getVerificationReportById(workOrder.verification.verificationReportId);
  return report?.payload ?? null;
});

server.post('/work-orders/:id/select', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { quoteId?: string; force?: boolean } | undefined;
  const { force } = (request.query as { force?: string }) ?? {};
  const forceSelect = body?.force === true || force === 'true';
  const allowForceSelect = process.env.V4SHM_DEMO_ACTIONS === 'true';

  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = normalizeWorkOrder(record.payload as WorkOrder);

  if (!['BIDDING', 'FAILED', 'EXPIRED'].includes(workOrder.status)) {
    return reply.status(400).send({ error: 'Work order cannot be selected in the current state' });
  }

  if (workOrder.status === 'BIDDING' && Date.now() < workOrder.bidding.biddingEndsAt) {
    if (!forceSelect) {
      return reply.status(400).send({ error: 'Bidding window still open. Use ?force=true to select early.' });
    }
    if (!allowForceSelect) {
      return reply.status(400).send({ error: 'Force select disabled (set V4SHM_DEMO_ACTIONS=true)' });
    }
    workOrder.bidding.biddingEndsAt = Date.now();
  }

  const quotes = db.listQuotes(id).map((q) => q.payload as QuotePayload);
  if (quotes.length === 0) {
    return reply.status(400).send({ error: 'No quotes to select' });
  }

  try {
    const session = await ensureYellowSession(workOrder, quotes);
    emit(id, 'yellowSessionCreated', session);
    await ensureQuoteRewardsPaid(workOrder, quotes);
  } catch (error) {
    server.log.error(error, 'failed to create Yellow session');
    const details = process.env.V4SHM_DEMO_ACTIONS === 'true'
      ? String((error as any)?.message ?? error)
      : undefined;
    return reply.status(500).send({ error: 'Failed to create Yellow session', details });
  }

  const allowedSolvers = new Set(
    (workOrder.yellow.participants ?? []).slice(1).map((participant) => participant.toLowerCase())
  );
  const eligibleQuotes = quotes.filter((quote) => allowedSolvers.has(quote.solverAddress.toLowerCase()));
  if (eligibleQuotes.length === 0) {
    return reply.status(400).send({ error: 'No eligible quotes (session participant cap reached)' });
  }

  const attempted = workOrder.selection.attemptedQuoteIds ?? [];
  const availableQuotes = eligibleQuotes.filter((quote) => !attempted.includes(quote.id));
  const selectedQuote = body?.quoteId
    ? eligibleQuotes.find((quote) => quote.id === body.quoteId)
    : selectBestQuote(availableQuotes.length > 0 ? availableQuotes : eligibleQuotes);

  if (!selectedQuote) {
    return reply.status(404).send({ error: 'Quote not found' });
  }

  applySelection(workOrder, selectedQuote);

  const winStats = getSolverStats(selectedQuote.solverAddress);
  winStats.quotesWon += 1;
  saveSolverStats(winStats);

  persistWorkOrder(workOrder);

  emit(id, 'solverSelected', { workOrderId: id, quote: selectedQuote });

  return reply.status(200).send(workOrder);
});

server.post('/work-orders/:id/submit', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as SubmissionPayload;

  if (body.workOrderId !== id) {
    return reply.status(400).send({ error: 'Work order ID mismatch' });
  }

  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = normalizeWorkOrder(record.payload as WorkOrder);

  const canSubmit =
    workOrder.status === 'SELECTED'
    || (workOrder.status === 'CHALLENGED' && workOrder.deadlines.patchEndsAt !== null && Date.now() <= workOrder.deadlines.patchEndsAt);
  if (!canSubmit) {
    return reply.status(400).send({ error: 'Work order is not ready for submission' });
  }

  if (workOrder.selection.selectedSolverId &&
      getAddress(body.solverAddress) !== getAddress(workOrder.selection.selectedSolverId)) {
    return reply.status(403).send({ error: 'Solver is not selected for this work order' });
  }

  const message: SubmissionMessage = {
    workOrderId: body.workOrderId,
    repoUrl: body.artifact.repoUrl,
    commitSha: body.artifact.commitSha,
    artifactHash: body.artifact.artifactHash,
  };
  const recovered = recoverSubmissionSigner(message, body.signature);
  if (getAddress(recovered) !== getAddress(body.solverAddress)) {
    return reply.status(400).send({ error: 'Invalid submission signature' });
  }

  const computedHash = sha256Hex(`${body.artifact.repoUrl}:${body.artifact.commitSha}`);
  if (computedHash !== body.artifact.artifactHash) {
    return reply.status(400).send({ error: 'Artifact hash mismatch' });
  }

  db.insertSubmission({
    id: body.id,
    workOrderId: id,
    createdAt: body.createdAt,
    payload: body,
  });

  workOrder.status = 'VERIFYING';
  db.updateWorkOrder({
    id: workOrder.id,
    createdAt: workOrder.createdAt,
    status: workOrder.status,
    payload: workOrder,
  });

  emit(id, 'submissionReceived', body);

  const verifierResponse = await fetch(`${VERIFIER_URL}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workOrder, submission: body }),
  });

  if (!verifierResponse.ok) {
    const errorText = await verifierResponse.text();
    workOrder.status = 'FAILED';
    db.updateWorkOrder({
      id: workOrder.id,
      createdAt: workOrder.createdAt,
      status: workOrder.status,
      payload: workOrder,
    });
    emit(id, 'verificationFailed', { error: errorText });
    return reply.status(500).send({ error: 'Verifier failed', details: errorText });
  }

  const report = (await verifierResponse.json()) as {
    report: any;
    milestonesPassed: string[];
  };

  db.insertVerificationReport({
    id: report.report.id,
    submissionId: body.id,
    createdAt: report.report.producedAt,
    status: report.report.status,
    payload: report.report,
  });

  workOrder.verification.verificationReportId = report.report.id;

  const selectedQuoteId = workOrder.selection.selectedQuoteId;
  const selectedQuote = selectedQuoteId
    ? (db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload).find((q) => q.id === selectedQuoteId) ?? null)
    : null;

  if (report.report.status === 'PASS') {
    const patched = workOrder.challenge.status === 'PATCH_WINDOW';
    workOrder.status = 'PASSED_PENDING_CHALLENGE';
    workOrder.challenge.status = patched ? 'PATCH_PASSED' : 'OPEN';
    workOrder.challenge.pendingRewardAmount = null;
    workOrder.deadlines.patchEndsAt = null;
    workOrder.deadlines.challengeEndsAt = patched ? Date.now() : Date.now() + CHALLENGE_WINDOW_MS;
    emit(id, 'verificationPassed', report.report);

    if (selectedQuote) {
      const stats = getSolverStats(selectedQuote.solverAddress);
      stats.deliveriesSucceeded += 1;
      const selectionTime = workOrder.selection.selectedAt ?? workOrder.createdAt;
      const actualMinutes = Math.max(1, Math.ceil((Date.now() - selectionTime) / 60000));
      stats.totalEtaMinutes += selectedQuote.etaMinutes;
      stats.totalActualMinutes += actualMinutes;
      if (workOrder.deadlines.deliveryEndsAt && Date.now() <= workOrder.deadlines.deliveryEndsAt) {
        stats.onTimeDeliveries += 1;
      }
      saveSolverStats(stats);
    }

    // Pay milestones in order.
    const basePrice = selectedQuote ? Number(selectedQuote.price) : Number(workOrder.bounty.amount);
    for (const milestone of workOrder.milestones.payoutSchedule) {
      if (!report.milestonesPassed.includes(milestone.key)) continue;
      const targetAmount = ((basePrice * milestone.percent) / 100).toFixed(4);
      const targetUnits = toUnits(targetAmount, YELLOW_ASSET.decimals);
      const alreadyPaidUnits = totalPaidForMilestone(workOrder.id, milestone.key, body.solverAddress);
      if (alreadyPaidUnits >= targetUnits) continue;

      const remainingUnits = targetUnits - alreadyPaidUnits;
      const splitCount = milestone.key === 'M5_NO_CHALLENGE_OR_PATCH_OK' ? 1 : MILESTONE_SPLITS;
      for (const partUnits of splitUnits(remainingUnits, splitCount)) {
        const paymentEvent: PaymentEvent = {
          id: randomUUID(),
          workOrderId: workOrder.id,
          type: 'MILESTONE',
          toAddress: body.solverAddress,
          amount: fromUnits(partUnits, YELLOW_ASSET.decimals),
          yellowTransferId: null,
          milestoneKey: milestone.key,
          createdAt: Date.now(),
        };
        await recordPayment(workOrder, paymentEvent);
        emit(workOrder.id, 'milestonePaid', paymentEvent);
      }
    }
  } else {
    emit(id, 'verificationFailed', report.report);
    if (workOrder.challenge.status === 'PATCH_WINDOW') {
      await finalizeChallengeFailure(workOrder);
      return reply.status(200).send({ workOrder, report: report.report });
    }

    if (selectedQuote) {
      const stats = getSolverStats(selectedQuote.solverAddress);
      stats.deliveriesFailed += 1;
      saveSolverStats(stats);
    }

    const attempted = workOrder.selection.attemptedQuoteIds ?? [];
    if (selectedQuoteId && !attempted.includes(selectedQuoteId)) {
      attempted.push(selectedQuoteId);
      workOrder.selection.attemptedQuoteIds = attempted;
    }

    const quotes = db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload);
    try {
      const session = await ensureYellowSession(workOrder, quotes);
      emit(workOrder.id, 'yellowSessionCreated', session);
    } catch (error) {
      server.log.error(error, 'failed to ensure Yellow session for fallback selection');
    }

    const allowedSolvers = new Set(
      (workOrder.yellow.participants ?? []).slice(1).map((participant) => participant.toLowerCase())
    );
    const eligibleQuotes = allowedSolvers.size > 0
      ? quotes.filter((quote) => allowedSolvers.has(quote.solverAddress.toLowerCase()))
      : quotes;

    const fallbackQuote = selectNextQuote(eligibleQuotes, attempted);
    if (fallbackQuote) {
      applySelection(workOrder, fallbackQuote);
      emit(workOrder.id, 'solverFallbackSelected', { quote: fallbackQuote });
    } else {
      workOrder.status = 'FAILED';
    }
  }

  persistWorkOrder(workOrder);

  return reply.status(200).send({ workOrder, report: report.report });
});

server.post('/work-orders/:id/end-session', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { force } = (request.query as { force?: string }) ?? {};
  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = normalizeWorkOrder(record.payload as WorkOrder);

  if (workOrder.status !== 'PASSED_PENDING_CHALLENGE') {
    return reply.status(400).send({ error: 'Work order is not ready to settle' });
  }
  if (workOrder.challenge.status === 'PATCH_WINDOW') {
    return reply.status(400).send({ error: 'Patch window open; cannot settle yet' });
  }

  if (workOrder.deadlines.challengeEndsAt && Date.now() < workOrder.deadlines.challengeEndsAt && force !== 'true') {
    return reply.status(400).send({ error: 'Challenge window still open. Use ?force=true to settle early.' });
  }

  const result = await settleWorkOrder(workOrder);
  if (!result) {
    return reply.status(400).send({ error: 'Unable to settle work order' });
  }

  return reply.status(200).send({ workOrder, settlement: result });
});

server.get('/work-orders/:id/payments', async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const payments = db.listPaymentEvents(id).map((evt) => evt.payload);
  return payments;
});

server.get('/solvers', async () => {
  const rows = db.listSolverStats();
  return rows.map((row) => {
    const stats = row.payload as SolverStats;
    return { stats, reputation: calculateReputation(stats) };
  });
});

server.get('/solvers/:address', async (request, reply) => {
  const { address } = request.params as { address: string };
  try {
    const checksummed = getAddress(address);
    const record = db.getSolverStats(checksummed.toLowerCase());
    if (!record) return reply.status(404).send({ error: 'Solver not found' });
    const stats = record.payload as SolverStats;
    return { stats, reputation: calculateReputation(stats) };
  } catch {
    return reply.status(400).send({ error: 'Invalid address' });
  }
});

server.get('/solver/work-orders', async (request) => {
  const { status } = request.query as { status?: string };
  const records = db.listWorkOrders(status ?? 'BIDDING');
  return records.map((record) => normalizeWorkOrder(record.payload as WorkOrder));
});

server.post('/solver/quotes', async (request, reply) => {
  const body = request.body as QuotePayload;
  const record = db.getWorkOrder(body.workOrderId);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = normalizeWorkOrder(record.payload as WorkOrder);

  if (workOrder.status !== 'BIDDING') {
    return reply.status(400).send({ error: 'Work order is not accepting quotes' });
  }

  if (Date.now() > workOrder.bidding.biddingEndsAt) {
    return reply.status(400).send({ error: 'Bidding window closed' });
  }
  if (body.validUntil < Date.now()) {
    return reply.status(400).send({ error: 'Quote already expired' });
  }
  if (Number(body.price) > Number(workOrder.bounty.amount)) {
    return reply.status(400).send({ error: 'Quote exceeds bounty amount' });
  }

  const message: QuoteMessage = {
    workOrderId: body.workOrderId,
    price: body.price,
    etaMinutes: body.etaMinutes,
    validUntil: body.validUntil,
  };
  const recovered = recoverQuoteSigner(message, body.signature);
  if (getAddress(recovered) !== getAddress(body.solverAddress)) {
    return reply.status(400).send({ error: 'Invalid quote signature' });
  }

  db.insertQuote({
    id: body.id,
    workOrderId: body.workOrderId,
    createdAt: body.createdAt,
    payload: body,
  });

  const quoteStats = getSolverStats(body.solverAddress);
  quoteStats.quotesSubmitted += 1;
  saveSolverStats(quoteStats);

  emit(body.workOrderId, 'quoteCreated', body);

  return reply.status(201).send(body);
});

server.post('/solver/submissions', async (request, reply) => {
  const body = request.body as SubmissionPayload;
  const response = await server.inject({
    method: 'POST',
    url: `/work-orders/${body.workOrderId}/submit`,
    payload: body,
  });

  return reply.status(response.statusCode).send(response.json());
});

server.post('/challenger/challenges', async (request, reply) => {
  const body = request.body as {
    id: string;
    workOrderId: string;
    submissionId: string;
    challengerAddress: string;
    reproductionSpec: Record<string, unknown>;
    signature: string;
    createdAt: number;
  };

  const record = db.getWorkOrder(body.workOrderId);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = normalizeWorkOrder(record.payload as WorkOrder);

  if (workOrder.status !== 'PASSED_PENDING_CHALLENGE') {
    return reply.status(400).send({ error: 'Work order is not in challenge window' });
  }
  if (workOrder.deadlines.challengeEndsAt && Date.now() > workOrder.deadlines.challengeEndsAt) {
    return reply.status(400).send({ error: 'Challenge window closed' });
  }
  if (workOrder.challenge.status !== 'OPEN') {
    return reply.status(400).send({ error: 'Challenge window not open' });
  }

  const challengerInSession = (workOrder.yellow.participants ?? [])
    .some((participant) => participant.toLowerCase() === body.challengerAddress.toLowerCase());
  if (!challengerInSession) {
    return reply.status(400).send({ error: 'Challenger must have joined the Yellow session during bidding' });
  }

  const reproductionHash = sha256Hex(JSON.stringify(body.reproductionSpec ?? {}));
  const message: ChallengeMessage = {
    workOrderId: body.workOrderId,
    submissionId: body.submissionId,
    reproductionHash,
  };
  const recovered = recoverChallengeSigner(message, body.signature);
  if (getAddress(recovered) !== getAddress(body.challengerAddress)) {
    return reply.status(400).send({ error: 'Invalid challenge signature' });
  }

  const submissionRecord = db.getSubmission(body.submissionId);
  if (!submissionRecord) return reply.status(404).send({ error: 'Submission not found' });
  if (submissionRecord.workOrderId !== body.workOrderId) {
    return reply.status(400).send({ error: 'Submission does not belong to work order' });
  }

  const verifierResponse = await fetch(`${VERIFIER_URL}/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workOrder, submission: submissionRecord.payload, challenge: body }),
  });

  if (!verifierResponse.ok) {
    const errorText = await verifierResponse.text();
    return reply.status(500).send({ error: 'Verifier failed', details: errorText });
  }

  const result = (await verifierResponse.json()) as { outcome: 'SUCCESS' | 'REJECTED' };

  if (result.outcome === 'SUCCESS') {
    const selectedQuoteId = workOrder.selection.selectedQuoteId;
    const selectedQuote = selectedQuoteId
      ? (db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload).find((q) => q.id === selectedQuoteId) ?? null)
      : null;
    const basePrice = selectedQuote ? Number(selectedQuote.price) : Number(workOrder.bounty.amount);
    const challengeAmount = ((basePrice * 20) / 100).toFixed(4);
    const now = Date.now();

    if (PATCH_WINDOW_MS > 0) {
      workOrder.status = 'CHALLENGED';
      workOrder.deadlines.patchEndsAt = now + PATCH_WINDOW_MS;
      workOrder.challenge.status = 'PATCH_WINDOW';
      workOrder.challenge.challengeId = body.id;
      workOrder.challenge.challengerAddress = body.challengerAddress;
      workOrder.challenge.pendingRewardAmount = challengeAmount;
      persistWorkOrder(workOrder);
      emit(workOrder.id, 'challengeOpened', { challenge: body, patchEndsAt: workOrder.deadlines.patchEndsAt });
    } else {
      const paymentEvent: PaymentEvent = {
        id: randomUUID(),
        workOrderId: workOrder.id,
        type: 'CHALLENGE_REWARD',
        toAddress: body.challengerAddress,
        amount: challengeAmount,
        yellowTransferId: null,
        milestoneKey: 'M5_NO_CHALLENGE_OR_PATCH_OK',
        createdAt: now,
      };
      const transfer = await yellowClient.transfer({
        workOrderId: workOrder.id,
        event: paymentEvent,
        sessionState: buildSessionState(workOrder),
        allowanceTotal: workOrder.yellow.allowanceTotal,
      });
      paymentEvent.yellowTransferId = transfer.transferId;
      applySessionState(workOrder, transfer.sessionState ?? null);
      persistWorkOrder(workOrder);
      db.insertPaymentEvent({
        id: paymentEvent.id,
        workOrderId: workOrder.id,
        createdAt: paymentEvent.createdAt,
        type: paymentEvent.type,
        payload: paymentEvent,
      });
      workOrder.status = 'FAILED';
      persistWorkOrder(workOrder);
      emit(workOrder.id, 'challengeSucceeded', { challenge: body, paymentEvent });
      if (selectedQuote) {
        const solverStats = getSolverStats(selectedQuote.solverAddress);
        solverStats.challengesAgainst += 1;
        saveSolverStats(solverStats);
      }
      const challengerStats = getSolverStats(body.challengerAddress);
      challengerStats.challengesWon += 1;
      saveSolverStats(challengerStats);
    }
  } else {
    workOrder.challenge.status = 'REJECTED';
    persistWorkOrder(workOrder);
    emit(workOrder.id, 'challengeRejected', { challenge: body });
  }

  return reply.status(200).send(result);
});

server.get('/work-orders/:id/ws', { websocket: true }, (connection, request) => {
  const { id } = request.params as { id: string };
  const socket = (connection as any).socket ?? connection;
  const unsubscribe = events.subscribe(id, (event) => {
    socket.send(JSON.stringify(event));
  });

  socket.on('close', () => {
    unsubscribe();
  });
});

async function sweepWorkOrders() {
  const now = Date.now();
  const workOrders = db.listWorkOrders().map((record) => normalizeWorkOrder(record.payload as WorkOrder));

  for (const workOrder of workOrders) {
    if (workOrder.status === 'BIDDING' && now >= workOrder.bidding.biddingEndsAt) {
      const quotes = db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload);
      if (quotes.length === 0) {
        workOrder.status = 'EXPIRED';
        persistWorkOrder(workOrder);
        emit(workOrder.id, 'workOrderExpired', { reason: 'no_quotes' });
        continue;
      }

      try {
        const session = await ensureYellowSession(workOrder, quotes);
        emit(workOrder.id, 'yellowSessionCreated', session);
        await ensureQuoteRewardsPaid(workOrder, quotes);
      } catch (error) {
        server.log.error(error, 'failed to create Yellow session (auto)');
        continue;
      }

      const allowedSolvers = new Set(
        (workOrder.yellow.participants ?? []).slice(1).map((participant) => participant.toLowerCase())
      );
      const eligibleQuotes = quotes.filter((quote) => allowedSolvers.has(quote.solverAddress.toLowerCase()));
      if (eligibleQuotes.length === 0) {
        workOrder.status = 'EXPIRED';
        persistWorkOrder(workOrder);
        emit(workOrder.id, 'workOrderExpired', { reason: 'session_participant_cap' });
        continue;
      }

      const attempted = workOrder.selection.attemptedQuoteIds ?? [];
      const selectedQuote = selectNextQuote(eligibleQuotes, attempted) ?? selectBestQuote(eligibleQuotes);
      if (!selectedQuote) continue;
      applySelection(workOrder, selectedQuote);

      const winStats = getSolverStats(selectedQuote.solverAddress);
      winStats.quotesWon += 1;
      saveSolverStats(winStats);
      persistWorkOrder(workOrder);
      emit(workOrder.id, 'solverAutoSelected', { quote: selectedQuote });
    }

    if (workOrder.status === 'SELECTED' && workOrder.deadlines.deliveryEndsAt && now > workOrder.deadlines.deliveryEndsAt) {
      workOrder.status = 'EXPIRED';
      persistWorkOrder(workOrder);
      emit(workOrder.id, 'workOrderExpired', { reason: 'delivery_window' });
    }

    if (workOrder.status === 'PASSED_PENDING_CHALLENGE' && workOrder.deadlines.challengeEndsAt && now > workOrder.deadlines.challengeEndsAt) {
      await settleWorkOrder(workOrder);
    }

    if (workOrder.status === 'CHALLENGED' && workOrder.deadlines.patchEndsAt && now > workOrder.deadlines.patchEndsAt) {
      await finalizeChallengeFailure(workOrder);
    }
  }
}

let sweeping = false;
setInterval(() => {
  // Prevent overlapping sweeps (the real Yellow WS path can take >AUTO_TICK_MS).
  // Overlaps can spam the Yellow RPC and make timeouts much more likely.
  if (sweeping) return;
  sweeping = true;
  sweepWorkOrders()
    .catch((err) => server.log.error(err, 'auto sweep failed'))
    .finally(() => {
      sweeping = false;
    });
}, AUTO_TICK_MS);

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

server
  .listen({ port, host })
  .catch((err) => {
    server.log.error(err, 'failed to start api');
    process.exit(1);
  });
