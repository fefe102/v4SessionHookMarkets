#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseEther,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

type CliOptions = {
  amount?: string;
  rpcUrl?: string;
  dryRun: boolean;
  extraAddresses: Address[];
};

type Target = {
  label: string;
  address: Address;
};

const KEY_ENV_NAMES = [
  { name: 'YELLOW_PRIVATE_KEY', label: 'yellow' },
  { name: 'V4_PRIVATE_KEY', label: 'verifier' },
  { name: 'SOLVER_PRIVATE_KEY', label: 'solver' },
  { name: 'CHALLENGER_PRIVATE_KEY', label: 'challenger' },
] as const;

function parseEnvFile(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const env = parseEnvFile(envPath);
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizePrivateKey(value: string, label: string): `0x${string}` {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return (`0x${trimmed}` as `0x${string}`);
  throw new Error(`${label} is not a 32-byte hex private key`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, extraAddresses: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm sometimes forwards a literal `--` when running scripts with args.
    if (arg === '--') {
      continue;
    }
    if (arg === '--amount') {
      options.amount = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--rpc') {
      options.rpcUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--addresses') {
      const raw = argv[i + 1] ?? '';
      i += 1;
      const list = raw.split(',').map((item) => item.trim()).filter(Boolean);
      for (const entry of list) {
        if (!isAddress(entry)) {
          throw new Error(`Invalid address in --addresses: ${entry}`);
        }
        options.extraAddresses.push(entry as Address);
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`\nFund Base Sepolia addresses used by this repo.\n\nUsage:\n  pnpm tsx scripts/fund-base-sepolia.ts [--amount 0.01] [--rpc <url>] [--dry-run]\n\nOptions:\n  --amount      Target balance for each address (default: 0.01)\n  --rpc         Override RPC URL (default: FUND_RPC_URL, V4_RPC_URL, YELLOW_RPC_URL, or BASE_SEPOLIA_RPC_URLS[0])\n  --dry-run     Print actions without sending transactions\n  --addresses   Comma-separated extra addresses to fund\n\nEnvironment:\n  FUNDING_PRIVATE_KEY  Private key that pays for funding\n  FUND_AMOUNT          Same as --amount\n  FUND_RPC_URL         Same as --rpc\n  FUND_TARGET_ADDRESSES Comma-separated extra addresses to fund\n`);
}

function getRpcUrl(override?: string): string {
  if (override) return override;
  if (process.env.FUND_RPC_URL) return process.env.FUND_RPC_URL;
  if (process.env.V4_RPC_URL) return process.env.V4_RPC_URL;
  if (process.env.YELLOW_RPC_URL) return process.env.YELLOW_RPC_URL;
  const fallback = process.env.BASE_SEPOLIA_RPC_URLS?.split(',').map((url) => url.trim()).filter(Boolean)[0];
  if (fallback) return fallback;
  throw new Error('Missing RPC URL. Set FUND_RPC_URL or V4_RPC_URL or YELLOW_RPC_URL.');
}

function collectTargets(extraAddresses: Address[], fundingAddress: Address): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();

  for (const entry of KEY_ENV_NAMES) {
    const value = process.env[entry.name];
    if (!value) continue;
    try {
      const key = normalizePrivateKey(value, entry.name);
      const account = privateKeyToAccount(key);
      const address = account.address as Address;
      if (address.toLowerCase() === fundingAddress.toLowerCase()) continue;
      if (seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      targets.push({ label: entry.label, address });
    } catch (err) {
      throw new Error(`${entry.name}: ${(err as Error).message}`);
    }
  }

  for (const address of extraAddresses) {
    if (address.toLowerCase() === fundingAddress.toLowerCase()) continue;
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    targets.push({ label: 'extra', address });
  }

  return targets;
}

function collectExtraAddresses(): Address[] {
  const list = process.env.FUND_TARGET_ADDRESSES?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  const extra: Address[] = [];
  for (const entry of list) {
    if (!isAddress(entry)) {
      throw new Error(`Invalid address in FUND_TARGET_ADDRESSES: ${entry}`);
    }
    extra.push(entry as Address);
  }
  return extra;
}

async function main() {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));

  const fundingKeyRaw = process.env.FUNDING_PRIVATE_KEY;
  if (!fundingKeyRaw) {
    throw new Error('Missing FUNDING_PRIVATE_KEY. Export it in your shell or .env.');
  }
  const fundingKey = normalizePrivateKey(fundingKeyRaw, 'FUNDING_PRIVATE_KEY');
  const fundingAccount = privateKeyToAccount(fundingKey);
  const fundingAddressEnv = process.env.FUNDING_ADDRESS;
  if (fundingAddressEnv) {
    if (!isAddress(fundingAddressEnv)) {
      throw new Error(`FUNDING_ADDRESS is not a valid address: ${fundingAddressEnv}`);
    }
    if (fundingAddressEnv.toLowerCase() !== fundingAccount.address.toLowerCase()) {
      throw new Error(`FUNDING_ADDRESS (${fundingAddressEnv}) does not match FUNDING_PRIVATE_KEY (${fundingAccount.address})`);
    }
  }

  const rpcUrl = getRpcUrl(options.rpcUrl);
  const amount = options.amount ?? process.env.FUND_AMOUNT ?? '0.01';
  const targetWei = parseEther(amount);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
    account: fundingAccount,
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) {
    throw new Error(`RPC chainId ${chainId} does not match Base Sepolia (${baseSepolia.id}).`);
  }

  const extraAddresses = [...collectExtraAddresses(), ...options.extraAddresses];
  const targets = collectTargets(extraAddresses, fundingAccount.address as Address);
  if (!targets.length) {
    console.log('No funding targets found. Set solver/verifier/yellow/challenger keys or pass --addresses.');
    return;
  }

  console.log(`Funding account: ${fundingAccount.address}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Target balance: ${amount} ETH`);

  const fundingBalance = await publicClient.getBalance({ address: fundingAccount.address });
  console.log(`Funding balance: ${formatEther(fundingBalance)} ETH`);

  let totalNeeded = 0n;
  const plans: Array<{ target: Target; current: bigint; send: bigint }> = [];

  for (const target of targets) {
    const current = await publicClient.getBalance({ address: target.address });
    const send = current >= targetWei ? 0n : targetWei - current;
    plans.push({ target, current, send });
    totalNeeded += send;
  }

  if (totalNeeded === 0n) {
    console.log('All targets already meet or exceed the target balance.');
    return;
  }

  console.log(`Total required (excludes gas): ${formatEther(totalNeeded)} ETH`);

  if (fundingBalance < totalNeeded) {
    throw new Error('Funding account balance is insufficient for the planned transfers.');
  }

  for (const plan of plans) {
    const { target, current, send } = plan;
    if (send === 0n) {
      console.log(`Skip ${target.label} ${target.address} (balance ${formatEther(current)} ETH)`);
      continue;
    }
    console.log(`Send ${formatEther(send)} ETH to ${target.label} ${target.address} (current ${formatEther(current)} ETH)`);
    if (options.dryRun) continue;

    const hash = await walletClient.sendTransaction({
      to: target.address,
      value: send,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  Tx: ${hash} (status ${receipt.status})`);
  }

  if (options.dryRun) {
    console.log('Dry run complete. No transactions were broadcast.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
