import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

function parseDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

type ListenCheck = 'available' | 'in_use' | 'unsupported';

async function checkListen(port: number, host: string): Promise<ListenCheck> {
  return await new Promise<ListenCheck>((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE' || code === 'EACCES') return resolve('in_use');
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return resolve('unsupported');
      return resolve('in_use');
    });

    server.once('listening', () => {
      server.close(() => resolve('available'));
    });

    server.listen({ port, host });
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  // Most dev servers bind to all interfaces (0.0.0.0 / ::). If a port is occupied on any non-loopback
  // interface, binding to 0.0.0.0 / :: will fail (even if 127.0.0.1 is free), so check these first.
  const [allV4, allV6] = await Promise.all([checkListen(port, '0.0.0.0'), checkListen(port, '::')]);

  if (allV4 === 'in_use' || allV6 === 'in_use') return false;
  if (allV4 === 'available' || allV6 === 'available') return true;

  // Some dev environments allow binding to localhost but not 0.0.0.0/:: (unsupported), so fall back.
  const [loopV4, loopV6] = await Promise.all([checkListen(port, '127.0.0.1'), checkListen(port, '::1')]);

  if (loopV4 === 'in_use' || loopV6 === 'in_use') return false;
  return loopV4 === 'available' || loopV6 === 'available';
}

async function pickPort(
  requestedPort: number,
  label: string,
  opts: { strict: boolean; reserved: Set<number> }
): Promise<number> {
  if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
    throw new Error(`${label} port must be a positive integer (got: ${requestedPort})`);
  }

  let port = requestedPort;
  for (let attempts = 0; attempts < 200; attempts++) {
    if (!opts.reserved.has(port) && (await isPortAvailable(port))) {
      opts.reserved.add(port);
      return port;
    }

    if (opts.strict) {
      throw new Error(`${label} port ${requestedPort} is not available (set a different ${label}_PORT)`);
    }
    port++;
  }

  throw new Error(`Unable to find an available ${label} port starting from ${requestedPort}`);
}

function startProcess(
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  processes: ChildProcess[]
) {
  const child = spawn(cmd, args, {
    env,
    stdio: 'inherit',
    // On Windows pnpm is usually a .cmd. Keeping shell=false is fine on Unix-like dev envs.
    shell: process.platform === 'win32',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`${name} exited via signal ${signal}`);
    } else {
      console.error(`${name} exited with code ${code}`);
    }
    // If any core process dies, shut everything down.
    for (const proc of processes) {
      try {
        proc.kill('SIGINT');
      } catch {
        // ignore
      }
    }
    process.exit(code ?? 1);
  });

  processes.push(child);
  return child;
}

const repoRoot = path.resolve(process.cwd());
const dotEnv = parseDotEnv(path.join(repoRoot, '.env'));
const env: NodeJS.ProcessEnv = { ...process.env, ...dotEnv };

const pollMs = env.BOT_POLL_MS ? Number(env.BOT_POLL_MS) : 1000;
if (!env.BOT_POLL_MS) env.BOT_POLL_MS = String(pollMs);

function setIfMissing(key: string, value: string) {
  const current = env[key];
  if (typeof current !== 'string' || current.trim() === '') {
    env[key] = value;
    return true;
  }
  return false;
}

type Hex = `0x${string}`;

function normalizePrivateKey(value: string): Hex | null {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as Hex;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return (`0x${trimmed}`) as Hex;
  return null;
}

function generatePrivateKey(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

function ensureDemoPrivateKey(key: string, label: string) {
  const existing = env[key];
  const normalized = typeof existing === 'string' ? normalizePrivateKey(existing) : null;
  if (normalized) {
    env[key] = normalized;
    return;
  }

  const generated = generatePrivateKey();
  env[key] = generated;
  const address = privateKeyToAccount(generated).address;
  console.log(`INFO: ${key} missing; generated ${label} demo key (${address}). Set ${key} in .env to override.`);
}

function parseNodeMajor(version: string) {
  const cleaned = version.trim().replace(/^v/, '');
  const major = Number(cleaned.split('.')[0]);
  return Number.isFinite(major) ? major : null;
}

let pnpmNodeMajor: number | null = null;
try {
  pnpmNodeMajor = parseNodeMajor(execSync('pnpm node -v', { env, encoding: 'utf8' }));
} catch {
  pnpmNodeMajor = null;
}

const useVoltaForChildren = pnpmNodeMajor !== null && pnpmNodeMajor < 22;

function detectVoltaNodeVersion() {
  try {
    const nodePath = execSync('volta which node', { env, encoding: 'utf8' }).trim();
    const match = nodePath.match(/\/node\/(\d+\.\d+\.\d+)\//);
    if (match?.[1]) return match[1];
    return null;
  } catch {
    return null;
  }
}

function resolveDemoNodeVersion() {
  const requested = env.DEMO_NODE_VERSION?.trim();
  if (requested && /^\d+\.\d+\.\d+$/.test(requested)) return requested;

  const installed = useVoltaForChildren ? detectVoltaNodeVersion() : null;
  if (installed) return installed;

  // Fall back to requested (even if it's "22"); this may require network for Volta.
  return requested || '22.0.0';
}

const demoNodeVersion = resolveDemoNodeVersion();

function pnpmCmd(pnpmArgs: string[]) {
  if (!useVoltaForChildren) return { cmd: 'pnpm', args: pnpmArgs };
  return { cmd: 'volta', args: ['run', '--node', demoNodeVersion, 'pnpm', ...pnpmArgs] };
}

const processes: ChildProcess[] = [];

process.on('SIGINT', () => {
  for (const proc of processes) {
    try {
      proc.kill('SIGINT');
    } catch {
      // ignore
    }
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const proc of processes) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  process.exit(0);
});

async function main() {
  if (useVoltaForChildren) {
    console.log(`INFO: pnpm is running with Node ${pnpmNodeMajor}; using Volta Node ${demoNodeVersion} for child processes`);
  }

  const demoDefaults: string[] = [];
  if (setIfMissing('YELLOW_MILESTONE_SPLITS', '5')) demoDefaults.push('YELLOW_MILESTONE_SPLITS=5');
  if (setIfMissing('V4_AGENT_STEPS', '5')) demoDefaults.push('V4_AGENT_STEPS=5');
  if (setIfMissing('V4SHM_DEMO_ACTIONS', 'true')) demoDefaults.push('V4SHM_DEMO_ACTIONS=true');
  if (setIfMissing('V4SHM_QUIET_LOGS', 'true')) demoDefaults.push('V4SHM_QUIET_LOGS=true');
  if (setIfMissing('BOT_POLL_MS', '1000')) demoDefaults.push('BOT_POLL_MS=1000');
  if (setIfMissing('BOT_QUOTE_DELAY_MS_MIN', '5000')) demoDefaults.push('BOT_QUOTE_DELAY_MS_MIN=5000');
  if (setIfMissing('BOT_QUOTE_DELAY_MS_MAX', '15000')) demoDefaults.push('BOT_QUOTE_DELAY_MS_MAX=15000');
  if (demoDefaults.length > 0) {
    console.log(`INFO: using demo defaults (${demoDefaults.join(', ')})`);
  }

  const autoPricesEnabled = env.V4SHM_DEMO_AUTOPRICES !== 'false';
  if (autoPricesEnabled) {
    function parseAmount(value: string | undefined): number | null {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (trimmed === '') return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function clampDemoPrice(key: string, demoValue: string, opts: { maxAllowed: number }) {
      const current = parseAmount(env[key]);
      if (current !== null && current <= opts.maxAllowed) return;
      if (typeof env[key] === 'string' && env[key]?.trim() !== '' && env[key] !== demoValue) {
        console.log(
          `INFO: overriding ${key}=${env[key]} with ${demoValue} for demo (set V4SHM_DEMO_AUTOPRICES=false to disable)`
        );
      } else if (!env[key]) {
        console.log(`INFO: using ${key}=${demoValue} for demo (set V4SHM_DEMO_AUTOPRICES=false to disable)`);
      }
      env[key] = demoValue;
    }

    // Keep values in the "I only have a tiny demo wallet" range.
    clampDemoPrice('SOLVER_PRICE', '0.05', { maxAllowed: 0.5 });
    clampDemoPrice('SOLVER_B_PRICE', '0.04', { maxAllowed: 0.5 });
  }

  if (env.VERIFIER_MODE === 'real') {
    const v4CoreRoot = path.join(repoRoot, 'harness', 'v4-hook-harness', 'lib', 'v4-core');
    const forgeStdSrc = path.join(v4CoreRoot, 'lib', 'forge-std', 'src');
    const solmateSrc = path.join(v4CoreRoot, 'lib', 'solmate', 'src');
    if (!fs.existsSync(forgeStdSrc) || !fs.existsSync(solmateSrc)) {
      console.log('WARN: verifier is in real mode, but harness deps are missing. Run `pnpm harness:install`.');
    }
  }

  const reservedPorts = new Set<number>();
  const webPort = await pickPort(env.WEB_PORT ? Number(env.WEB_PORT) : 3000, 'WEB', {
    strict: Boolean(env.WEB_PORT),
    reserved: reservedPorts,
  });
  const apiPort = await pickPort(env.API_PORT ? Number(env.API_PORT) : 3001, 'API', {
    strict: Boolean(env.API_PORT),
    reserved: reservedPorts,
  });
  const verifierPort = await pickPort(env.VERIFIER_PORT ? Number(env.VERIFIER_PORT) : 3002, 'VERIFIER', {
    strict: Boolean(env.VERIFIER_PORT),
    reserved: reservedPorts,
  });

  env.API_URL = `http://localhost:${apiPort}`;
  env.VERIFIER_URL = `http://localhost:${verifierPort}`;
  env.NEXT_PUBLIC_API_BASE = env.API_URL;

  console.log('Starting demo services...');
  console.log(`- API: http://localhost:${apiPort}`);
  console.log(`- Web: http://localhost:${webPort}`);
  console.log(`- LI.FI: http://localhost:${webPort}/lifi`);
  console.log(`- Bots poll: ${env.BOT_POLL_MS}ms`);

  const verifier = pnpmCmd(['-C', 'apps/verifier', 'dev']);
  startProcess('verifier', verifier.cmd, verifier.args, { ...env, PORT: String(verifierPort) }, processes);

  const api = pnpmCmd(['-C', 'apps/api', 'dev']);
  startProcess('api', api.cmd, api.args, { ...env, PORT: String(apiPort) }, processes);

  const web = pnpmCmd(['-C', 'apps/web', 'exec', 'next', 'dev', '-p', String(webPort)]);
  startProcess(
    'web',
    web.cmd,
    web.args,
    env,
    processes
  );

  if (env.V4SHM_DEMO_AUTOKEYS !== 'false') {
    ensureDemoPrivateKey('SOLVER_PRIVATE_KEY', 'solver-bot-a');
    ensureDemoPrivateKey('SOLVER_B_PRIVATE_KEY', 'solver-bot-b');
  }

  if (env.SOLVER_PRIVATE_KEY) {
    const solverBot = pnpmCmd(['-C', 'apps/solver-bot', 'dev']);
    startProcess('solver-bot-a', solverBot.cmd, solverBot.args, env, processes);
  } else {
    console.log('WARN: SOLVER_PRIVATE_KEY missing; solver-bot-a not started');
  }

  if (env.SOLVER_B_PRIVATE_KEY) {
    const solverBot = pnpmCmd(['-C', 'apps/solver-bot', 'dev']);
    startProcess(
      'solver-bot-b',
      solverBot.cmd,
      solverBot.args,
      {
        ...env,
        SOLVER_PRIVATE_KEY: env.SOLVER_B_PRIVATE_KEY,
        SOLVER_PRICE: env.SOLVER_B_PRICE ?? '0.04',
        SOLVER_ETA_MINUTES: env.SOLVER_B_ETA_MINUTES ?? '12',
      },
      processes
    );
  } else {
    console.log('WARN: SOLVER_B_PRIVATE_KEY missing; solver-bot-b not started');
  }

  if (env.CHALLENGER_PRIVATE_KEY) {
    const challengerBot = pnpmCmd(['-C', 'apps/challenger-bot', 'dev']);
    startProcess('challenger-bot', challengerBot.cmd, challengerBot.args, env, processes);
  } else {
    console.log('WARN: CHALLENGER_PRIVATE_KEY missing; challenger-bot not started');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
