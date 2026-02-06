import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function existsDir(dirPath: string) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function checkCmd(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) return { ok: false, output: String(result.error.message ?? result.error) };
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output: out };
}

const repoRoot = path.resolve(process.cwd());
const harnessRoot = path.join(repoRoot, 'harness', 'v4-hook-harness');
const v4CoreRoot = path.join(harnessRoot, 'lib', 'v4-core');

const forge = checkCmd('forge', ['--version']);
if (!forge.ok) {
  console.error('FAIL: Foundry is not available (`forge --version` failed).');
  console.error('Install it from https://book.getfoundry.sh/getting-started/installation');
  process.exit(1);
}

if (!existsDir(harnessRoot)) {
  console.error(`FAIL: harness directory not found: ${harnessRoot}`);
  process.exit(1);
}

const forgeStdSrc = path.join(v4CoreRoot, 'lib', 'forge-std', 'src');
const solmateSrc = path.join(v4CoreRoot, 'lib', 'solmate', 'src');

if (!existsDir(v4CoreRoot) || !existsDir(forgeStdSrc) || !existsDir(solmateSrc)) {
  console.error('FAIL: v4-core dependencies are missing.');
  console.error('From `harness/v4-hook-harness`, run:');
  console.error('  forge install uniswap/v4-core --no-commit');
  console.error('  git -C lib/v4-core submodule update --init --recursive');
  process.exit(1);
}

console.log('OK: harness deps present');
console.log(`- forge: ${forge.output.split('\n')[0]}`);
console.log(`- v4-core: ${v4CoreRoot}`);

