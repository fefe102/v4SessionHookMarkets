import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { runMockV4Proof } from '@v4shm/uniswap-client';
import type { ChallengePayload, SubmissionPayload, VerificationReport, WorkOrder } from '@v4shm/shared';

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

type VerifierSandboxMode = 'host' | 'docker';

function verifierSandbox(): VerifierSandboxMode {
  return (process.env.VERIFIER_SANDBOX ?? 'host') === 'docker' ? 'docker' : 'host';
}

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['version'], { encoding: 'utf8' });
  return result.status === 0;
}

function runForge(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: { network?: 'none' | 'default' }
): CommandResult {
  if (verifierSandbox() !== 'docker') {
    const forgeBin = resolveForgeBin(env);
    return runCommand(forgeBin, args, cwd, env);
  }

  if (!dockerAvailable()) {
    return { ok: false, output: 'docker not found (VERIFIER_SANDBOX=docker)', error: new Error('docker not found') };
  }

  const image = process.env.VERIFIER_DOCKER_IMAGE ?? 'ghcr.io/foundry-rs/foundry:latest';
  const dockerArgs: string[] = ['run', '--rm', '-v', `${cwd}:/work`, '-w', '/work'];
  if (options?.network === 'none') {
    dockerArgs.push('--network', 'none');
  }

  // Make sure generated artifacts are readable on the host.
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    dockerArgs.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  // Only pass the small set of env vars the harness needs. Secrets are injected only
  // for the onchain steps (rpc/private-key are passed as forge args, not env vars).
  const passEnvKeys = [
    'CAP_AMOUNT_IN',
    'ALLOWLIST_A',
    'ALLOWLIST_B',
    'TEMPLATE_TYPE',
    'POOL_MANAGER',
    'PROOF_OUT',
    'PROOF_IN',
    'V4_FEE',
    'V4_TICK_SPACING',
    'V4_AGENT_STEPS',
    'CHALLENGE_AMOUNT_IN',
    'CHALLENGE_TRADER',
  ];
  for (const key of passEnvKeys) {
    const value = env[key];
    if (value === undefined) continue;
    dockerArgs.push('-e', `${key}=${value}`);
  }

  dockerArgs.push(image, 'forge', ...args);
  return runCommand('docker', dockerArgs, cwd, env);
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

function resolveArtifactPath(repoDir: string): string {
  const candidates = [
    path.join(repoDir, 'Hook.sol'),
    path.join(repoDir, 'SwapCapHook.sol'),
    path.join(repoDir, 'WhitelistHook.sol'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Hook artifact must not be a symlink: ${candidate}`);
    }
    if (!stat.isFile()) continue;
    return candidate;
  }
  throw new Error('Hook artifact not found at repoUrl');
}

function isRemoteRepoUrl(repoUrl: string) {
  const trimmed = repoUrl.trim();
  return (
    trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('ssh://')
    || trimmed.startsWith('git@')
  );
}

function ensureCleanDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function checkoutGitCommit(input: { repoUrl: string; commitSha: string }, destDir: string) {
  ensureCleanDir(destDir);

  if (!isRemoteRepoUrl(input.repoUrl)) {
    if (!fs.existsSync(input.repoUrl)) {
      throw new Error(`Artifact repo path does not exist: ${input.repoUrl}`);
    }
    fs.cpSync(input.repoUrl, destDir, { recursive: true });
  } else {
    const init = spawnSync('git', ['init'], { cwd: destDir, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr ?? init.stdout ?? '').trim()}`);
    const addRemote = spawnSync('git', ['remote', 'add', 'origin', input.repoUrl], { cwd: destDir, encoding: 'utf8' });
    if (addRemote.status !== 0) throw new Error(`git remote add failed: ${(addRemote.stderr ?? addRemote.stdout ?? '').trim()}`);
    const fetch = spawnSync('git', ['fetch', '--depth', '1', 'origin', input.commitSha], { cwd: destDir, encoding: 'utf8' });
    if (fetch.status !== 0) throw new Error(`git fetch failed: ${(fetch.stderr ?? fetch.stdout ?? '').trim()}`);
  }

  // Always checkout in the copied repo so we don't mutate the solver's working directory.
  if (fs.existsSync(path.join(destDir, '.git'))) {
    const checkout = spawnSync('git', ['checkout', '--detach', input.commitSha], { cwd: destDir, encoding: 'utf8' });
    if (checkout.status !== 0) {
      const out = `${checkout.stdout ?? ''}${checkout.stderr ?? ''}`.trim();
      throw new Error(`git checkout failed: ${out}`);
    }
  }
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
  const artifactDir = path.join(runDir, 'artifact');
  fs.mkdirSync(runDir, { recursive: true });
  if (!fs.existsSync(harnessDir)) {
    fs.cpSync(harnessRoot, harnessDir, { recursive: true });
  }

  const templateType = input.workOrder.templateType;
  checkoutGitCommit(
    { repoUrl: input.submission.artifact.repoUrl, commitSha: input.submission.artifact.commitSha },
    artifactDir
  );
  const artifactPath = resolveArtifactPath(artifactDir);
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

  const build = runForge(['build'], harnessDir, envBase, { network: 'none' });
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
  const test = runForge(['test', '--match-path', testPath], harnessDir, envBase, { network: 'none' });
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

  const scriptResult = runForge(
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
    scriptEnv,
    { network: 'default' }
  );
  verifierStdout = scriptResult.output;
  if (!scriptResult.ok) {
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

  // Negative swap proof: broadcast a revert tx to demonstrate hook enforcement onchain.
  // This is expected to revert; if it succeeds, the submission violates the HookSpec.
  let negativeTx: string | null = null;
  try {
    const negative = runForge(
      [
        'script',
        'script/V4NegativeProof.s.sol:V4NegativeProof',
        '--broadcast',
        '--rpc-url',
        rpcUrl,
        '--private-key',
        privateKey,
        '--json',
      ],
      harnessDir,
      { ...scriptEnv, PROOF_IN: 'proof.json' },
      { network: 'default' }
    );

    const chainId = Number(process.env.V4_CHAIN_ID ?? 84532);
    const broadcastPath = path.join(harnessDir, 'broadcast', 'V4NegativeProof.s.sol', String(chainId), 'run-latest.json');
    const fallbackPath = path.join(harnessDir, 'broadcast', 'V4NegativeProof.s.sol', String(chainId), 'dry-run', 'run-latest.json');
    const runPath = fs.existsSync(broadcastPath) ? broadcastPath : fallbackPath;
    if (fs.existsSync(runPath)) {
      const parsed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      const hashes: string[] = (parsed.transactions ?? parsed.receipts ?? [])
        .map((tx: any) => tx.hash ?? tx.transactionHash)
        .filter((hash: string | undefined) => !!hash);
      negativeTx = hashes.at(-1) ?? null;
    }

    if (!negativeTx) {
      throw new Error(`Unable to locate negative swap tx hash. forge ok=${negative.ok}`);
    }

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: negativeTx as Hex });
    if (receipt.status !== 'reverted') {
      throw new Error(`Negative swap tx did not revert (status=${receipt.status})`);
    }

    txIds.push(negativeTx);
    proof.txIds = txIds;
  } catch (err) {
    const message = String((err as any)?.message ?? err);
    const report: VerificationReport = {
      id: randomUUID(),
      submissionId: input.submission.id,
      status: 'FAIL',
      logs: {
        buildLog,
        testLog,
        verifierStdout: `${verifierStdout}\nnegativeProofError: ${message}`.trim(),
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

export async function runChallenge(input: {
  mode: 'mock' | 'real';
  workOrder: WorkOrder;
  submission: SubmissionPayload;
  challenge: ChallengePayload;
}) {
  if (input.mode === 'mock') {
    const outcome = process.env.V4SHM_CHALLENGE_OUTCOME ?? 'REJECTED';
    return { outcome: outcome === 'SUCCESS' ? 'SUCCESS' : 'REJECTED' } as const;
  }

  const runId = `${input.workOrder.id}_${input.submission.id}_${input.challenge.id}`;
  const runDir = path.join(runsDir, `challenge_${runId}`);
  const harnessDir = path.join(runDir, 'harness');
  const artifactDir = path.join(runDir, 'artifact');
  fs.mkdirSync(runDir, { recursive: true });
  if (!fs.existsSync(harnessDir)) {
    fs.cpSync(harnessRoot, harnessDir, { recursive: true });
  }

  checkoutGitCommit(
    { repoUrl: input.submission.artifact.repoUrl, commitSha: input.submission.artifact.commitSha },
    artifactDir
  );
  const artifactPath = resolveArtifactPath(artifactDir);

  const templateType = input.workOrder.templateType;
  const hookDest = path.join(
    harnessDir,
    'src',
    templateType === 'SWAP_CAP_HOOK' ? 'SwapCapHook.sol' : 'WhitelistHook.sol'
  );
  fs.copyFileSync(artifactPath, hookDest);

  const v4CorePath = path.join(harnessDir, 'lib', 'v4-core');
  if (!fs.existsSync(v4CorePath)) {
    throw new Error('Missing v4-core dependency. Run `forge install --no-git uniswap/v4-core` and init submodules.');
  }

  const repro = (input.challenge.reproductionSpec ?? {}) as Record<string, unknown>;
  const capAmountIn = String(input.workOrder.params?.capAmountIn ?? 1000);
  const allowlist = (input.workOrder.params?.allowlist as string[] | undefined) ?? [];

  let challengeAmountIn = repro.amountIn;
  if (typeof challengeAmountIn !== 'string' && typeof challengeAmountIn !== 'number') {
    const cap = Number(capAmountIn);
    challengeAmountIn = Number.isFinite(cap) ? cap + 1 : 1001;
  }

  let challengeTrader = repro.trader;
  if (typeof challengeTrader !== 'string') {
    challengeTrader = '0x0000000000000000000000000000000000000003';
  }

  const envBase: NodeJS.ProcessEnv = {
    ...process.env,
    TEMPLATE_TYPE: templateType,
    CAP_AMOUNT_IN: capAmountIn,
    ALLOWLIST_A: String(allowlist[0] ?? '0x0000000000000000000000000000000000000001'),
    ALLOWLIST_B: String(allowlist[1] ?? '0x0000000000000000000000000000000000000002'),
    CHALLENGE_AMOUNT_IN: String(challengeAmountIn),
    CHALLENGE_TRADER: String(challengeTrader),
  };

  const build = runForge(['build'], harnessDir, envBase, { network: 'none' });
  if (!build.ok) {
    throw new Error(`forge build failed for challenge: ${build.output}`);
  }

  // If this test fails, the challenger found a real spec violation for the provided reproduction input.
  const test = runForge(['test', '--match-path', 'test/Challenge.t.sol'], harnessDir, envBase, { network: 'none' });
  const outcome = test.ok ? 'REJECTED' : 'SUCCESS';
  return { outcome } as const;
}
