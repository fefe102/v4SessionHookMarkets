export type WorkOrderStatus =
  | 'DRAFT'
  | 'BIDDING'
  | 'SELECTED'
  | 'VERIFYING'
  | 'PASSED_PENDING_CHALLENGE'
  | 'CHALLENGED'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export type WorkOrderTemplate = 'SWAP_CAP_HOOK' | 'WHITELIST_HOOK';

export type WorkOrder = {
  id: string;
  createdAt: number;
  status: WorkOrderStatus;
  title: string;
  templateType: WorkOrderTemplate;
  params: Record<string, unknown>;
  bounty: { currency: string; amount: string };
  requesterAddress?: string | null;
  bidding: { biddingEndsAt: number };
  deadlines: {
    deliveryEndsAt: number | null;
    verifyEndsAt: number | null;
    challengeEndsAt: number | null;
    patchEndsAt: number | null;
  };
  selection: {
    selectedQuoteId: string | null;
    selectedSolverId: string | null;
    selectedAt?: number | null;
    attemptedQuoteIds?: string[];
  };
  challenge: {
    status: 'NONE' | 'OPEN' | 'REJECTED' | 'PATCH_WINDOW' | 'PATCH_PASSED' | 'PATCH_FAILED';
    challengeId: string | null;
    challengerAddress: string | null;
    pendingRewardAmount: string | null;
  };
  yellow: {
    yellowSessionId: string | null;
    sessionAssetAddress: string | null;
    allowanceTotal: string | null;
    participants?: string[];
    allocations?: Array<{ participant: string; amount: string }>;
    sessionVersion?: number;
  };
  milestones: {
    payoutSchedule: Array<{ key: string; percent: number }>;
  };
  artifacts: {
    harnessVersion: string | null;
    harnessHash: string | null;
  };
  verification: {
    verificationReportId: string | null;
  };
};

export type QuotePayload = {
  id: string;
  workOrderId: string;
  solverAddress: string;
  price: string;
  etaMinutes: number;
  validUntil: number;
  signature: string;
  createdAt: number;
};

export type SubmissionPayload = {
  id: string;
  workOrderId: string;
  solverAddress: string;
  artifact: {
    kind: 'GIT_COMMIT';
    repoUrl: string;
    commitSha: string;
    artifactHash: string;
  };
  signature: string;
  createdAt: number;
};

export type VerificationReport = {
  id: string;
  submissionId: string;
  status: 'PASS' | 'FAIL';
  logs: {
    buildLog: string;
    testLog: string;
    verifierStdout: string;
  };
  proof: {
    chainId: number;
    hookAddress: string;
    tokenAAddress: string;
    tokenBAddress: string;
    poolKey: Record<string, unknown>;
    poolId: string;
    txIds: string[];
  };
  metrics: {
    gasUsedSwap?: string;
    latencySeconds: number;
  };
  producedAt: number;
  artifactHash: string;
};

export type PaymentEvent = {
  id: string;
  workOrderId: string;
  type: 'QUOTE_REWARD' | 'MILESTONE' | 'CHALLENGE_REWARD' | 'REFUND';
  toAddress: string;
  amount: string;
  yellowTransferId?: string | null;
  milestoneKey?: string | null;
  createdAt: number;
};

export type ChallengePayload = {
  id: string;
  workOrderId: string;
  submissionId: string;
  challengerAddress: string;
  reproductionSpec: Record<string, unknown>;
  signature: string;
  createdAt: number;
};
