import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

const pollMs = env.BOT_POLL_MS ? Number(env.BOT_POLL_MS) : 5000;
if (!env.BOT_POLL_MS) env.BOT_POLL_MS = String(pollMs);

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

console.log('Starting demo services...');
console.log(`- API: http://localhost:3001`);
console.log(`- Web: http://localhost:3000`);
console.log(`- LI.FI: http://localhost:3000/lifi`);
console.log(`- Bots poll: ${env.BOT_POLL_MS}ms`);

startProcess('verifier', 'pnpm', ['-C', 'apps/verifier', 'dev'], env, processes);
startProcess('api', 'pnpm', ['-C', 'apps/api', 'dev'], env, processes);
startProcess('web', 'pnpm', ['-C', 'apps/web', 'dev'], env, processes);

if (env.SOLVER_PRIVATE_KEY) {
  startProcess('solver-bot-a', 'pnpm', ['-C', 'apps/solver-bot', 'dev'], env, processes);
} else {
  console.log('WARN: SOLVER_PRIVATE_KEY missing; solver-bot-a not started');
}

if (env.SOLVER_B_PRIVATE_KEY) {
  startProcess(
    'solver-bot-b',
    'pnpm',
    ['-C', 'apps/solver-bot', 'dev'],
    {
      ...env,
      SOLVER_PRIVATE_KEY: env.SOLVER_B_PRIVATE_KEY,
      SOLVER_PRICE: env.SOLVER_B_PRICE ?? '9',
      SOLVER_ETA_MINUTES: env.SOLVER_B_ETA_MINUTES ?? '12',
    },
    processes
  );
} else {
  console.log('WARN: SOLVER_B_PRIVATE_KEY missing; solver-bot-b not started');
}

if (env.CHALLENGER_PRIVATE_KEY) {
  startProcess('challenger-bot', 'pnpm', ['-C', 'apps/challenger-bot', 'dev'], env, processes);
} else {
  console.log('WARN: CHALLENGER_PRIVATE_KEY missing; challenger-bot not started');
}

