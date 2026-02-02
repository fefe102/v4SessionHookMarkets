import { sha256, toUtf8Bytes } from 'ethers';

export function sha256Hex(input: string): string {
  return sha256(toUtf8Bytes(input));
}
