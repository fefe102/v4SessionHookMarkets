import { spawnSync } from 'node:child_process';
import path from 'node:path';

function run(cmd: string, args: string[], cwd: string) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
}

const repoRoot = path.resolve(process.cwd());
const harnessRoot = path.join(repoRoot, 'harness', 'v4-hook-harness');
const v4CoreRoot = path.join(harnessRoot, 'lib', 'v4-core');

console.log('Installing v4 harness dependencies...');
run('forge', ['install', 'uniswap/v4-core', '--no-commit'], harnessRoot);
run('git', ['submodule', 'update', '--init', '--recursive'], v4CoreRoot);
console.log('OK: harness deps installed');

