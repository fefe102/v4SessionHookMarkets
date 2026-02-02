import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
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
import { YellowClient } from '@v4shm/yellow-client';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

const BIDDING_WINDOW_MS = 5 * 60 * 1000;
const DELIVERY_WINDOW_MS = 25 * 60 * 1000;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;
const QUOTE_REWARD = 0.01;
const MAX_QUOTE_REWARDS = 20;

const VERIFIER_URL = process.env.VERIFIER_URL ?? 'http://localhost:3002';
const EVENT_LOG_PATH = process.env.V4SHM_EVENT_LOG ?? path.join(repoRoot, 'data', 'events.jsonl');
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

const yellowMode = process.env.YELLOW_MODE === 'real' ? 'real' : 'mock';
const yellowClient = new YellowClient({
  mode: yellowMode,
  apiUrl: API_URL,
});

const server = Fastify({ logger: true });
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

function selectBestQuote(quotes: QuotePayload[]) {
  return [...quotes].sort((a, b) => {
    const priceDiff = Number(a.price) - Number(b.price);
    if (priceDiff !== 0) return priceDiff;
    const etaDiff = a.etaMinutes - b.etaMinutes;
    if (etaDiff !== 0) return etaDiff;
    return a.createdAt - b.createdAt;
  })[0];
}

function requireWorkOrder(id: string) {
  const record = db.getWorkOrder(id);
  if (!record) return null;
  return record.payload as WorkOrder;
}

server.get('/health', async () => ({ ok: true }));

server.get('/work-orders', async (request) => {
  const { status } = request.query as { status?: string };
  const records = db.listWorkOrders(status);
  return records.map((record) => record.payload);
});

server.post('/work-orders', async (request, reply) => {
  const body = request.body as {
    title?: string;
    templateType?: WorkOrder['templateType'];
    params?: Record<string, unknown>;
    bounty?: { currency: string; amount: string | number };
  };

  if (!body?.title || !body?.templateType || !body?.bounty) {
    return reply.status(400).send({
      error: 'Missing required fields: title, templateType, bounty',
    });
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
    bidding: {
      biddingEndsAt: now + BIDDING_WINDOW_MS,
    },
    deadlines: {
      deliveryEndsAt: null,
      verifyEndsAt: null,
      challengeEndsAt: null,
    },
    selection: {
      selectedQuoteId: null,
      selectedSolverId: null,
    },
    yellow: {
      yellowSessionId: null,
      sessionAssetAddress: YELLOW_ASSET.token,
      allowanceTotal: null,
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

  const allowanceTotal = (
    Number(workOrder.bounty.amount) +
    QUOTE_REWARD * MAX_QUOTE_REWARDS
  ).toFixed(2);

  try {
    const session = await yellowClient.createSession({
      workOrderId: workOrder.id,
      allowanceTotal,
    });
    workOrder.yellow.yellowSessionId = session.sessionId;
    workOrder.yellow.allowanceTotal = session.allowanceTotal;
    emit(id, 'yellowSessionCreated', session);
  } catch (error) {
    server.log.error(error, 'failed to create Yellow session');
  }

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
  const body = request.body as { quoteId?: string } | undefined;

  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = record.payload as WorkOrder;

  if (workOrder.status !== 'BIDDING') {
    return reply.status(400).send({ error: 'Work order is not in BIDDING state' });
  }

  const quotes = db.listQuotes(id).map((q) => q.payload as QuotePayload);
  if (quotes.length === 0) {
    return reply.status(400).send({ error: 'No quotes to select' });
  }

  const selectedQuote = body?.quoteId
    ? quotes.find((quote) => quote.id === body.quoteId)
    : selectBestQuote(quotes);

  if (!selectedQuote) {
    return reply.status(404).send({ error: 'Quote not found' });
  }

  const now = Date.now();
  workOrder.status = 'SELECTED';
  workOrder.selection.selectedQuoteId = selectedQuote.id;
  workOrder.selection.selectedSolverId = selectedQuote.solverAddress;
  workOrder.deadlines.deliveryEndsAt = now + DELIVERY_WINDOW_MS;
  workOrder.deadlines.verifyEndsAt = now + VERIFY_WINDOW_MS;
  workOrder.deadlines.challengeEndsAt = now + CHALLENGE_WINDOW_MS;

  db.updateWorkOrder({
    id: workOrder.id,
    createdAt: workOrder.createdAt,
    status: workOrder.status,
    payload: workOrder,
  });

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
  const workOrder = record.payload as WorkOrder;

  if (workOrder.status !== 'SELECTED') {
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

  if (report.report.status === 'PASS') {
    workOrder.status = 'PASSED_PENDING_CHALLENGE';
    emit(id, 'verificationPassed', report.report);
  } else {
    workOrder.status = 'FAILED';
    emit(id, 'verificationFailed', report.report);
  }

  db.updateWorkOrder({
    id: workOrder.id,
    createdAt: workOrder.createdAt,
    status: workOrder.status,
    payload: workOrder,
  });

  // Pay milestones in order (demo mode off-chain transfers).
  if (report.report.status === 'PASS') {
    const selectedQuoteId = workOrder.selection.selectedQuoteId;
    const selectedQuote = selectedQuoteId
      ? (db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload).find((q) => q.id === selectedQuoteId) ?? null)
      : null;
    const basePrice = selectedQuote ? Number(selectedQuote.price) : Number(workOrder.bounty.amount);
    for (const milestone of workOrder.milestones.payoutSchedule) {
      if (!report.milestonesPassed.includes(milestone.key)) continue;
      const amount = ((basePrice * milestone.percent) / 100).toFixed(4);
      const paymentEvent: PaymentEvent = {
        id: randomUUID(),
        workOrderId: workOrder.id,
        type: 'MILESTONE',
        toAddress: body.solverAddress,
        amount,
        yellowTransferId: null,
        milestoneKey: milestone.key,
        createdAt: Date.now(),
      };
      const transfer = await yellowClient.transfer(paymentEvent);
      paymentEvent.yellowTransferId = transfer.transferId;
      db.insertPaymentEvent({
        id: paymentEvent.id,
        workOrderId: workOrder.id,
        createdAt: paymentEvent.createdAt,
        type: paymentEvent.type,
        payload: paymentEvent,
      });
      emit(workOrder.id, 'milestonePaid', paymentEvent);
    }
  }

  return reply.status(200).send({ workOrder, report: report.report });
});

server.post('/work-orders/:id/end-session', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { force } = (request.query as { force?: string }) ?? {};
  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = record.payload as WorkOrder;

  if (workOrder.status !== 'PASSED_PENDING_CHALLENGE') {
    return reply.status(400).send({ error: 'Work order is not ready to settle' });
  }

  if (workOrder.deadlines.challengeEndsAt && Date.now() < workOrder.deadlines.challengeEndsAt && force !== 'true') {
    return reply.status(400).send({ error: 'Challenge window still open. Use ?force=true to settle early.' });
  }

  const selectedQuoteId = workOrder.selection.selectedQuoteId;
  const selectedQuote = selectedQuoteId
    ? (db.listQuotes(workOrder.id).map((q) => q.payload as QuotePayload).find((q) => q.id === selectedQuoteId) ?? null)
    : null;
  const basePrice = selectedQuote ? Number(selectedQuote.price) : Number(workOrder.bounty.amount);
  const holdback = ((basePrice * 20) / 100).toFixed(4);

  const paymentEvent: PaymentEvent = {
    id: randomUUID(),
    workOrderId: workOrder.id,
    type: 'MILESTONE',
    toAddress: workOrder.selection.selectedSolverId ?? '0x0000000000000000000000000000000000000000',
    amount: holdback,
    yellowTransferId: null,
    milestoneKey: 'M5_NO_CHALLENGE_OR_PATCH_OK',
    createdAt: Date.now(),
  };
  const transfer = await yellowClient.transfer(paymentEvent);
  paymentEvent.yellowTransferId = transfer.transferId;
  db.insertPaymentEvent({
    id: paymentEvent.id,
    workOrderId: workOrder.id,
    createdAt: paymentEvent.createdAt,
    type: paymentEvent.type,
    payload: paymentEvent,
  });
  emit(id, 'milestonePaid', paymentEvent);

  const result = await yellowClient.closeSession({ workOrderId: workOrder.id });
  workOrder.status = 'COMPLETED';

  db.updateWorkOrder({
    id: workOrder.id,
    createdAt: workOrder.createdAt,
    status: workOrder.status,
    payload: workOrder,
  });

  emit(id, 'workOrderCompleted', { settlement: result });

  return reply.status(200).send({ workOrder, settlement: result });
});

server.get('/work-orders/:id/payments', async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = db.getWorkOrder(id);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const payments = db.listPaymentEvents(id).map((evt) => evt.payload);
  return payments;
});

server.get('/solver/work-orders', async (request) => {
  const { status } = request.query as { status?: string };
  const records = db.listWorkOrders(status ?? 'BIDDING');
  return records.map((record) => record.payload);
});

server.post('/solver/quotes', async (request, reply) => {
  const body = request.body as QuotePayload;
  const record = db.getWorkOrder(body.workOrderId);
  if (!record) return reply.status(404).send({ error: 'Work order not found' });
  const workOrder = record.payload as WorkOrder;

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

  const rewardEvents = db.listPaymentEvents(body.workOrderId).filter((evt) => evt.type === 'QUOTE_REWARD');
  if (rewardEvents.length < MAX_QUOTE_REWARDS) {
    const paymentEvent: PaymentEvent = {
      id: randomUUID(),
      workOrderId: body.workOrderId,
      type: 'QUOTE_REWARD',
      toAddress: body.solverAddress,
      amount: QUOTE_REWARD.toFixed(2),
      yellowTransferId: null,
      createdAt: Date.now(),
    };
    const transfer = await yellowClient.transfer(paymentEvent);
    paymentEvent.yellowTransferId = transfer.transferId;
    db.insertPaymentEvent({
      id: paymentEvent.id,
      workOrderId: body.workOrderId,
      createdAt: paymentEvent.createdAt,
      type: paymentEvent.type,
      payload: paymentEvent,
    });
    emit(body.workOrderId, 'quoteRewardPaid', paymentEvent);
  }

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
  const workOrder = record.payload as WorkOrder;

  if (workOrder.status !== 'PASSED_PENDING_CHALLENGE') {
    return reply.status(400).send({ error: 'Work order is not in challenge window' });
  }
  if (workOrder.deadlines.challengeEndsAt && Date.now() > workOrder.deadlines.challengeEndsAt) {
    return reply.status(400).send({ error: 'Challenge window closed' });
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

  const verifierResponse = await fetch(`${VERIFIER_URL}/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workOrder, challenge: body }),
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
    const paymentEvent: PaymentEvent = {
      id: randomUUID(),
      workOrderId: workOrder.id,
      type: 'CHALLENGE_REWARD',
      toAddress: body.challengerAddress,
      amount: challengeAmount,
      yellowTransferId: null,
      milestoneKey: 'M5_NO_CHALLENGE_OR_PATCH_OK',
      createdAt: Date.now(),
    };
    const transfer = await yellowClient.transfer(paymentEvent);
    paymentEvent.yellowTransferId = transfer.transferId;
    db.insertPaymentEvent({
      id: paymentEvent.id,
      workOrderId: workOrder.id,
      createdAt: paymentEvent.createdAt,
      type: paymentEvent.type,
      payload: paymentEvent,
    });
    workOrder.status = 'FAILED';
    db.updateWorkOrder({
      id: workOrder.id,
      createdAt: workOrder.createdAt,
      status: workOrder.status,
      payload: workOrder,
    });
    emit(workOrder.id, 'challengeSucceeded', { challenge: body, paymentEvent });
  } else {
    emit(workOrder.id, 'challengeRejected', { challenge: body });
  }

  return reply.status(200).send(result);
});

server.get('/work-orders/:id/ws', { websocket: true }, (connection, request) => {
  const { id } = request.params as { id: string };
  const unsubscribe = events.subscribe(id, (event) => {
    connection.socket.send(JSON.stringify(event));
  });

  connection.socket.on('close', () => {
    unsubscribe();
  });
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

server
  .listen({ port, host })
  .catch((err) => {
    server.log.error(err, 'failed to start api');
    process.exit(1);
  });
