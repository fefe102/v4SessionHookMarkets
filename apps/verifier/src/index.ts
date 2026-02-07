import Fastify from 'fastify';
import { runVerification, runChallenge } from './runner.js';

const quietLogs = process.env.V4SHM_QUIET_LOGS === 'true';
const server = Fastify({
  logger: { base: null },
  disableRequestLogging: quietLogs,
});

const mode = (process.env.VERIFIER_MODE ?? 'mock') as 'mock' | 'real';

server.get('/health', async () => ({ ok: true, mode }));

server.post('/verify', async (request, reply) => {
  const body = request.body as {
    workOrder: any;
    submission: any;
  };

  if (!body?.workOrder?.id || !body?.submission?.id) {
    return reply.status(400).send({ error: 'Missing work order or submission' });
  }

  const result = await runVerification({
    workOrder: body.workOrder,
    submission: body.submission,
    mode,
  });

  return reply.status(200).send(result);
});

server.post('/challenge', async (_request, reply) => {
  const body = (_request as any).body as {
    workOrder: any;
    submission: any;
    challenge: any;
  };

  if (!body?.workOrder?.id || !body?.submission?.id || !body?.challenge?.id) {
    return reply.status(400).send({ error: 'Missing work order, submission, or challenge' });
  }

  const result = await runChallenge({
    mode,
    workOrder: body.workOrder,
    submission: body.submission,
    challenge: body.challenge,
  });
  return reply.status(200).send(result);
});

const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? '0.0.0.0';

server
  .listen({ port, host })
  .catch((err) => {
    server.log.error(err, 'failed to start verifier');
    process.exit(1);
  });
