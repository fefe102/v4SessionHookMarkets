import { keccak256, toUtf8Bytes } from 'ethers';

export type ProofResult = {
  chainId: number;
  hookAddress: string;
  tokenAAddress: string;
  tokenBAddress: string;
  poolKey: Record<string, unknown>;
  poolId: string;
  txIds: string[];
};

export async function runMockV4Proof(input: {
  workOrderId: string;
  submissionId: string;
  chainId: number;
}): Promise<ProofResult> {
  const seed = `${input.workOrderId}:${input.submissionId}`;
  const hash = keccak256(toUtf8Bytes(seed));
  const addr = (suffix: string) => `0x${hash.slice(2, 38)}${suffix}`.slice(0, 42);
  return {
    chainId: input.chainId,
    hookAddress: addr('01'),
    tokenAAddress: addr('02'),
    tokenBAddress: addr('03'),
    poolKey: { fee: 3000, tickSpacing: 60, hook: addr('01') },
    poolId: keccak256(toUtf8Bytes(`${seed}:pool`)),
    txIds: [
      keccak256(toUtf8Bytes(`${seed}:deploy`)),
      keccak256(toUtf8Bytes(`${seed}:init`)),
      keccak256(toUtf8Bytes(`${seed}:liquidity`)),
      keccak256(toUtf8Bytes(`${seed}:swap`)),
    ],
  };
}
