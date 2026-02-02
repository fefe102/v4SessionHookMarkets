import { TypedDataDomain, TypedDataField, Wallet, verifyTypedData } from 'ethers';
import { CHAIN_ID, PROJECT_NAME, PROJECT_VERSION, VERIFYING_CONTRACT } from './constants.js';

export const DOMAIN: TypedDataDomain = {
  name: PROJECT_NAME,
  version: PROJECT_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: VERIFYING_CONTRACT,
};

export const QuoteTypes: Record<string, TypedDataField[]> = {
  Quote: [
    { name: 'workOrderId', type: 'string' },
    { name: 'price', type: 'string' },
    { name: 'etaMinutes', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
  ],
};

export const SubmissionTypes: Record<string, TypedDataField[]> = {
  Submission: [
    { name: 'workOrderId', type: 'string' },
    { name: 'repoUrl', type: 'string' },
    { name: 'commitSha', type: 'string' },
    { name: 'artifactHash', type: 'string' },
  ],
};

export const ChallengeTypes: Record<string, TypedDataField[]> = {
  Challenge: [
    { name: 'workOrderId', type: 'string' },
    { name: 'submissionId', type: 'string' },
    { name: 'reproductionHash', type: 'string' },
  ],
};

export type QuoteMessage = {
  workOrderId: string;
  price: string;
  etaMinutes: number;
  validUntil: number;
};

export type SubmissionMessage = {
  workOrderId: string;
  repoUrl: string;
  commitSha: string;
  artifactHash: string;
};

export type ChallengeMessage = {
  workOrderId: string;
  submissionId: string;
  reproductionHash: string;
};

export async function signQuote(message: QuoteMessage, privateKey: string): Promise<string> {
  const wallet = new Wallet(privateKey);
  return wallet.signTypedData(DOMAIN, QuoteTypes, message);
}

export function recoverQuoteSigner(message: QuoteMessage, signature: string): string {
  return verifyTypedData(DOMAIN, QuoteTypes, message, signature);
}

export async function signSubmission(message: SubmissionMessage, privateKey: string): Promise<string> {
  const wallet = new Wallet(privateKey);
  return wallet.signTypedData(DOMAIN, SubmissionTypes, message);
}

export function recoverSubmissionSigner(message: SubmissionMessage, signature: string): string {
  return verifyTypedData(DOMAIN, SubmissionTypes, message, signature);
}

export async function signChallenge(message: ChallengeMessage, privateKey: string): Promise<string> {
  const wallet = new Wallet(privateKey);
  return wallet.signTypedData(DOMAIN, ChallengeTypes, message);
}

export function recoverChallengeSigner(message: ChallengeMessage, signature: string): string {
  return verifyTypedData(DOMAIN, ChallengeTypes, message, signature);
}
