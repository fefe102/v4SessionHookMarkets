import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runMockV4Proof } from '@v4shm/uniswap-client';
import type { SubmissionPayload, VerificationReport, WorkOrder } from '@v4shm/shared';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const dataDir = process.env.V4SHM_DATA_DIR
  ? path.resolve(repoRoot, process.env.V4SHM_DATA_DIR)
  : path.join(repoRoot, 'data');

const reportsDir = path.join(dataDir, 'reports');
const logsDir = path.join(dataDir, 'logs');
const runsDir = path.join(dataDir, 'runs');
const harnessRoot = path.join(repoRoot, 'harness', 'v4-hook-harness');

fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(runsDir, { recursive: true });

type CommandResult = { ok: boolean; output: string; error?: Error };

function runCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) {
    return { ok: false, output, error: result.error as Error };
  }
  return { ok: result.status === 0, output };
}

function resolveForgeBin(env: NodeJS.ProcessEnv): string {
  const explicit = env.FORGE_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const foundryBin = env.FOUNDRY_BIN;
  if (foundryBin) {
    const candidate = path.join(foundryBin, 'forge');
    if (fs.existsSync(candidate)) return candidate;
  }

  const home = env.HOME ?? process.env.HOME;
  const candidates = [
    home ? path.join(home, '.foundry', 'bin', 'forge') : null,
    home ? path.join(home, '.config', '.foundry', 'bin', 'forge') : null,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'forge';
}

function resolveArtifactPath(repoUrl: string): string {
  const candidates = [
    path.join(repoUrl, 'Hook.sol'),
    path.join(repoUrl, 'SwapCapHook.sol'),
    path.join(repoUrl, 'WhitelistHook.sol'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Hook artifact not found at repoUrl');
}

function writeReport(report: VerificationReport) {
  const reportPath = path.join(reportsDir, `${report.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  const logPath = path.join(logsDir, `${report.id}.log`);
  fs.writeFileSync(
    logPath,
    `${report.logs.buildLog}\n${report.logs.testLog}\n${report.logs.verifierStdout}\n`,
    'utf8'
  );
}

export async function runVerification(input: {
  workOrder: WorkOrder;
  submission: SubmissionPayload;
  mode: 'mock' | 'real';
}) {
  const startedAt = Date.now();

  if (input.mode === 'mock') {
    const proof = await runMockV4Proof({
      workOrderId: input.workOrder.id,
      submissionId: input.submission.id,
      chainId: 84532,
    });

    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
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
      artifactHash: input.submission.artifact.artifactHash,
    };

    writeReport(report);

    return {
      report,
      milestonesPassed: ['M1_COMPILE_OK', 'M2_TESTS_OK', 'M3_DEPLOY_OK', 'M4_V4_POOL_PROOF_OK'],
    };
  }

  const runId = `${input.workOrder.id}_${input.submission.id}`;
  const runDir = path.join(runsDir, runId);
  const harnessDir = path.join(runDir, 'harness');
  fs.mkdirSync(runDir, { recursive: true });
  if (!fs.existsSync(harnessDir)) {
    fs.cpSync(harnessRoot, harnessDir, { recursive: true });
  }

  const templateType = input.workOrder.templateType;
  const artifactPath = resolveArtifactPath(input.submission.artifact.repoUrl);
  const hookDest = path.join(
    harnessDir,
    'src',
    templateType === 'SWAP_CAP_HOOK' ? 'SwapCapHook.sol' : 'WhitelistHook.sol'
  );
  fs.copyFileSync(artifactPath, hookDest);

  const v4CorePath = path.join(harnessDir, 'lib', 'v4-core');
  if (!fs.existsSync(v4CorePath)) {
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog: '',
        testLog: '',
        verifierStdout: 'Missing v4-core dependency. Run `forge install --no-git uniswap/v4-core` and init submodules.',
      },
      proof: {
        chainId: Number(process.env.V4_CHAIN_ID ?? 84532),
        hookAddress: '0x0000000000000000000000000000000000000000',
        tokenAAddress: '0x0000000000000000000000000000000000000000',
        tokenBAddress: '0x0000000000000000000000000000000000000000',
        poolKey: {},
        poolId: '0x0',
        txIds: [],
      },
      metrics: {
        latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      },
      producedAt: Date.now(),
      artifactHash: input.submission.artifact.artifactHash,
    };
    writeReport(report);
    return { report, milestonesPassed: [] };
  }

  const envBase: NodeJS.ProcessEnv = {
    ...process.env,
    CAP_AMOUNT_IN: String(input.workOrder.params?.capAmountIn ?? 1000),
    ALLOWLIST_A: String((input.workOrder.params?.allowlist as string[] | undefined)?.[0]
      ?? '0x0000000000000000000000000000000000000001'),
    ALLOWLIST_B: String((input.workOrder.params?.allowlist as string[] | undefined)?.[1]
      ?? '0x0000000000000000000000000000000000000002'),
  };

  const milestonesPassed: string[] = [];
  let buildLog = '';
  let testLog = '';
  let verifierStdout = '';

  const zeroAddress = '0x0000000000000000000000000000000000000000';
  let proof: VerificationReport['proof'] = {
    chainId: Number(process.env.V4_CHAIN_ID ?? 84532),
    hookAddress: zeroAddress,
    tokenAAddress: zeroAddress,
    tokenBAddress: zeroAddress,
    poolKey: {},
    poolId: '0x0',
    txIds: [] as string[],
  };

  const forgeBin = resolveForgeBin(envBase);
  const build = runCommand(forgeBin, ['build'], harnessDir, envBase);
  buildLog = build.output;
  if (!build.ok) {
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog,
        testLog: '',
        verifierStdout: build.error?.message ?? 'forge build failed',
      },
      proof,
      metrics: {
        latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      },
      producedAt: Date.now(),
      artifactHash: input.submission.artifact.artifactHash,
    };
    writeReport(report);
    return { report, milestonesPassed };
  }
  milestonesPassed.push('M1_COMPILE_OK');

  const testPath = templateType === 'SWAP_CAP_HOOK' ? 'test/SwapCapHook.t.sol' : 'test/WhitelistHook.t.sol';
  const test = runCommand(forgeBin, ['test', '--match-path', testPath], harnessDir, envBase);
  testLog = test.output;
  if (!test.ok) {
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog,
        testLog,
        verifierStdout: test.error?.message ?? 'forge test failed',
      },
      proof,
      metrics: {
        latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      },
      producedAt: Date.now(),
      artifactHash: input.submission.artifact.artifactHash,
    };
    writeReport(report);
    return { report, milestonesPassed };
  }
  milestonesPassed.push('M2_TESTS_OK');

  const rpcUrl = process.env.V4_RPC_URL;
  const privateKey = process.env.V4_PRIVATE_KEY;
  const poolManager = process.env.V4_POOL_MANAGER ?? '0x05E73354cFDd1B9f74B0Afdc6fC8E6B9d0B2fA96';
  if (!rpcUrl || !privateKey) {
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog,
        testLog,
        verifierStdout: 'Missing V4_RPC_URL or V4_PRIVATE_KEY for real verification',
      },
      proof,
      metrics: {
        latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      },
      producedAt: Date.now(),
      artifactHash: input.submission.artifact.artifactHash,
    };
    writeReport(report);
    return { report, milestonesPassed };
  }

  // Foundry restricts vm.writeFile to paths within the project directory.
  // Keep proof output inside the copied harness folder for each run.
  const proofOut = path.join(harnessDir, 'proof.json');
  const scriptEnv: NodeJS.ProcessEnv = {
    ...envBase,
    POOL_MANAGER: poolManager,
    TEMPLATE_TYPE: templateType,
    // Keep PROOF_OUT relative so Foundry's vm.writeFile sandbox permits it.
    PROOF_OUT: 'proof.json',
  };

  const script = runCommand(
    forgeBin,
    [
      'script',
      'script/V4Proof.s.sol:V4Proof',
      '--broadcast',
      '--rpc-url',
      rpcUrl,
      '--private-key',
      privateKey,
      '--json',
    ],
    harnessDir,
    scriptEnv
  );
  verifierStdout = script.output;
  if (!script.ok) {
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog,
        testLog,
        verifierStdout,
      },
      proof,
      metrics: {
        latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      },
      producedAt: Date.now(),
      artifactHash: input.submission.artifact.artifactHash,
    };
    writeReport(report);
    return { report, milestonesPassed };
  }

  // With `forge script --json`, stdout is often multiple JSON objects separated by newlines.
  // The most reliable source of tx hashes is the broadcast artifact that Foundry writes.
  let txIds: string[] = [];
  try {
    const chainId = Number(process.env.V4_CHAIN_ID ?? 84532);
    const broadcastPath = path.join(harnessDir, 'broadcast', 'V4Proof.s.sol', String(chainId), 'run-latest.json');
    const fallbackPath = path.join(harnessDir, 'broadcast', 'V4Proof.s.sol', String(chainId), 'dry-run', 'run-latest.json');
    const runPath = fs.existsSync(broadcastPath) ? broadcastPath : fallbackPath;
    if (fs.existsSync(runPath)) {
      const parsed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      txIds = (parsed.transactions ?? parsed.receipts ?? [])
        .map((tx: any) => tx.hash ?? tx.transactionHash)
        .filter((hash: string | undefined) => !!hash);
    }
  } catch {
    txIds = [];
  }

  if (fs.existsSync(proofOut)) {
    const proofRaw = fs.readFileSync(proofOut, 'utf8');
    const parsedProof = JSON.parse(proofRaw);
    proof = {
      chainId: Number(parsedProof.chainId ?? process.env.V4_CHAIN_ID ?? 84532),
      hookAddress: parsedProof.hookAddress ?? zeroAddress,
      tokenAAddress: parsedProof.tokenAAddress ?? zeroAddress,
      tokenBAddress: parsedProof.tokenBAddress ?? zeroAddress,
      poolKey: parsedProof.poolKey ?? {},
      poolId: parsedProof.poolId ?? '0x0',
      txIds,
    };
  } else {
    proof.txIds = txIds;
  }

  milestonesPassed.push('M3_DEPLOY_OK', 'M4_V4_POOL_PROOF_OK');

  const report: VerificationReport = {
    id: randomUUID(),
    submissionId: input.submission.id,
    status: 'PASS',
    logs: {
      buildLog,
      testLog,
      verifierStdout,
    },
    proof,
    metrics: {
      latencySeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
    },
    producedAt: Date.now(),
    artifactHash: input.submission.artifact.artifactHash,
  };

  writeReport(report);

  return { report, milestonesPassed };
}

export async function runChallenge(input: { mode: 'mock' | 'real' }) {
  const outcome = process.env.V4SHM_CHALLENGE_OUTCOME ?? 'REJECTED';
  return { outcome: outcome === 'SUCCESS' ? 'SUCCESS' : 'REJECTED' } as const;
}
