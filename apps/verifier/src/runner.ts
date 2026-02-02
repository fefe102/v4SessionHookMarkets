import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMockV4Proof } from '@v4shm/uniswap-client';
import { VerificationReport } from '@v4shm/shared';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const dataDir = process.env.V4SHM_DATA_DIR
  ? path.resolve(process.env.V4SHM_DATA_DIR)
  : path.join(repoRoot, 'data');

const reportsDir = path.join(dataDir, 'reports');
const logsDir = path.join(dataDir, 'logs');

fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

export async function runVerification(input: {
  workOrderId: string;
  submissionId: string;
  artifactHash: string;
  mode: 'mock' | 'real';
}) {
  const startedAt = Date.now();

  if (input.mode !== 'mock') {
    throw new Error('VERIFIER_MODE=real is not implemented yet. Use mock mode for local demo.');
  }

  const proof = await runMockV4Proof({
    workOrderId: input.workOrderId,
    submissionId: input.submissionId,
    chainId: 84532,
  });

  const report: VerificationReport = {
    id: randomUUID(),
    submissionId: input.submissionId,
    status: 'PASS',
    logs: {
      buildLog: 'mock: forge build ok',
      testLog: 'mock: forge test ok',
      verifierStdout: 'mock: onchain proof simulated',
    },
    proof,
    metrics: {
      latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
    },
    producedAt: Date.now(),
    artifactHash: input.artifactHash,
  };

  const reportPath = path.join(reportsDir, `${report.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const logPath = path.join(logsDir, `${report.id}.log`);
  fs.writeFileSync(
    logPath,
    `${report.logs.buildLog}\n${report.logs.testLog}\n${report.logs.verifierStdout}\n`,
    'utf8'
  );

  return {
    report,
    milestonesPassed: ['M1_COMPILE_OK', 'M2_TESTS_OK', 'M3_DEPLOY_OK', 'M4_V4_POOL_PROOF_OK'],
  };
}

export async function runChallenge(input: { mode: 'mock' | 'real' }) {
  if (input.mode !== 'mock') {
    throw new Error('VERIFIER_MODE=real is not implemented yet. Use mock mode for local demo.');
  }

  const outcome = process.env.V4SHM_CHALLENGE_OUTCOME ?? 'REJECTED';
  return { outcome: outcome === 'SUCCESS' ? 'SUCCESS' : 'REJECTED' } as const;
}
