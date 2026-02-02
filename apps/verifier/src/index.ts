import Fastify from 'fastify';
import { runVerification, runChallenge } from './runner.js';

const server = Fastify({ logger: true });

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
  const result = await runChallenge({ mode });
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
