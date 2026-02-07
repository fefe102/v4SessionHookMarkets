import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  RPCAppStateIntent,
  RPCProtocolVersion,
  createAppSessionMessage,
  createAuthRequestMessage,
  createAuthVerifyMessageFromChallenge,
  createCloseAppSessionMessage,
  createCreateChannelMessage,
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createGetAssetsMessageV2,
  createGetConfigMessageV2,
  createResizeChannelMessage,
  createSubmitAppStateMessage,
  createCloseChannelMessage,
  createTransferMessage,
  convertRPCToClientChannel,
  getRequestId,
  getMethod,
  getResult,
  NitroliteClient,
  StateIntent,
  WalletStateSigner,
} from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { PaymentEvent } from '@v4shm/shared';

export type YellowClientOptions = {
  mode: 'mock' | 'real';
  apiUrl?: string;
};

export type YellowSessionState = {
  sessionId: string;
  participants: string[];
  allocations: Array<{ participant: string; amount: string }>;
  version: number;
  allowanceTotal: string;
};

type RpcResponse = {
  res?: [number, string, any, number?];
  err?: [number, string, any, number?];
};

function toUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  const padded = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+/, '') || '0';
  return BigInt(padded);
}

function fromUnits(value: bigint, decimals: number): string {
  const raw = value.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals) || '0';
  const frac = raw.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

class YellowRpcClient {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private pending = new Map<number, { resolve: (res: RpcResponse) => void; reject: (err: Error) => void }>();
  private timeoutMs: number;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.timeoutMs = Number(process.env.YELLOW_RPC_TIMEOUT_MS ?? 60000);
  }

  async connect() {
    // Reconnect if the socket is closed/stale.
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) return;
      if (this.ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve, reject) => {
          if (!this.ws) return reject(new Error('WebSocket not initialized'));
          this.ws.on('open', () => resolve());
          this.ws.on('error', (err: Error) => reject(err));
        });
        return;
      }
      this.ws = null;
    }
    this.ws = new WebSocket(this.wsUrl);
    this.ws.on('close', () => {
      this.ws = null;
    });
    this.ws.on('error', () => {
      this.ws = null;
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as RpcResponse;
        const requestId = message.res?.[0] ?? message.err?.[0];
        if (typeof requestId !== 'number') return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.resolve(message);
      } catch {
        // ignore malformed messages
      }
    });
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not initialized'));
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err: Error) => reject(err));
    });
  }

  async send(message: string): Promise<RpcResponse> {
    await this.connect();
    if (!this.ws) throw new Error('WebSocket not connected');
    const parsed = JSON.parse(message);
    const requestId = getRequestId(parsed) ?? parsed?.req?.[0];
    if (typeof requestId !== 'number') {
      throw new Error('RPC message missing request id');
    }
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          // Force a reconnect for the next request.
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
          this.ws = null;
          reject(new Error('RPC timeout'));
        }
      }, this.timeoutMs);
    });
    this.ws.send(message);
    return response;
  }
}

export class YellowClient {
  private mode: YellowClientOptions['mode'];
  private apiUrl?: string;

  private rpc?: YellowRpcClient;
  private walletAddress?: Address;
  private publicClient?: ReturnType<typeof createPublicClient>;
  private sessionPrivateKey?: Hex;
  private sessionSigner?: (payload: any) => Promise<Hex>;
  private authSigner?: (payload: any) => Promise<Hex>;
  private nitroliteClient?: NitroliteClient;
  private assetToken?: Address;
  private assetSymbol?: string;
  private assetDecimals = 6;
  private chainId = 84532;
  private channelId?: Hex;
  private currentAllowanceUnits?: bigint;
  private allowanceMultiplier = 1;
  private custodyAddress?: Address;
  private adjudicatorAddress?: Address;

  constructor(options: YellowClientOptions) {
    this.mode = options.mode;
    this.apiUrl = options.apiUrl;
  }

  getRequesterAddress(): string | null {
    return this.walletAddress ?? null;
  }

  private resetSessionAuth() {
    // Keep the existing session key so we can continue operating on already-created app sessions.
    this.authSigner = undefined;
    this.currentAllowanceUnits = undefined;
    // Channel state is tied to the session key, but this repo uses channels only optionally.
    // Clear them to avoid a mismatch if users toggle channel mode.
    this.nitroliteClient = undefined;
    this.channelId = undefined;
  }

  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const message = String((err as any)?.message ?? err);
        if (attempt === 0) {
          const lower = message.toLowerCase();
          if (lower.includes('authentication required')) {
            // The Yellow sandbox sometimes requires re-auth after WS reconnects.
            this.resetSessionAuth();
            continue;
          }
          if (lower.includes('insufficient session key allowance')) {
            // The Yellow sandbox can report "0 available" allowance for an otherwise valid session key.
            // Rotating the session key and re-authing is the most reliable recovery (and is safe for
            // already-created app sessions because signatures are tied to the wallet participant).
            this.sessionPrivateKey = undefined;
            this.sessionSigner = undefined;
            this.allowanceMultiplier = 1;
            this.resetSessionAuth();
            continue;
          }
          if (lower.includes('session key') && lower.includes('expired')) {
            // If Yellow considers the current session key expired, we can't re-auth it reliably.
            // Rotate the session key and re-auth.
            this.sessionPrivateKey = undefined;
            this.sessionSigner = undefined;
            this.allowanceMultiplier = 1;
            this.resetSessionAuth();
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  private async initReal(allowanceTotal: string) {
    if (this.mode !== 'real') return;

    const wsUrl = process.env.YELLOW_WS_URL ?? 'wss://clearnet-sandbox.yellow.com/ws';
    const rpcUrl = process.env.YELLOW_RPC_URL;
    const privateKey = process.env.YELLOW_PRIVATE_KEY as Hex | undefined;
    if (!rpcUrl || !privateKey) {
      throw new Error('YELLOW_RPC_URL and YELLOW_PRIVATE_KEY are required for real mode');
    }

    const account = privateKeyToAccount(privateKey);
    if (!this.walletAddress) {
      this.walletAddress = account.address;
    }
    this.chainId = Number(process.env.YELLOW_CHAIN_ID ?? 84532);

    if (!this.rpc) {
      this.rpc = new YellowRpcClient(wsUrl);
    }

    if (!this.assetToken || !this.custodyAddress || !this.adjudicatorAddress) {
      const configResponse = await this.rpc.send(createGetConfigMessageV2());
      const config = (getResult(configResponse as any) ?? configResponse.res?.[2]) as any;
      const networks = config?.networks ?? [];
      const network = networks.find((net: any) => Number(net.chain_id ?? net.chainId) === this.chainId);

      const assetsResponse = await this.rpc.send(createGetAssetsMessageV2(this.chainId));
      const assetsPayload = (getResult(assetsResponse as any) ?? assetsResponse.res?.[2]) as any;
      const assets = assetsPayload?.assets ?? [];
      const asset = assets.find(
        (a: any) => Number(a.chain_id ?? a.chainId) === this.chainId && a.symbol === 'ytest.usd'
      );

      if (!network || !asset) {
        throw new Error('Unable to resolve Yellow config for selected chain');
      }

      this.assetToken = (asset.token ?? asset.asset) as Address;
      this.assetSymbol = String(asset.symbol ?? 'ytest.usd');
      this.assetDecimals = Number(asset.decimals ?? 6);
      this.custodyAddress = (network.custody_address ?? network.custodyAddress) as Address;
      this.adjudicatorAddress = (network.adjudicator_address ?? network.adjudicatorAddress) as Address;
    }

    const configuredAllowanceTotal = process.env.YELLOW_ALLOWANCE_TOTAL;
    const effectiveAllowanceTotal = configuredAllowanceTotal
      ?? (this.allowanceMultiplier > 1
        ? (Number(allowanceTotal) * this.allowanceMultiplier).toFixed(2)
        : allowanceTotal);

    const requestedUnits = toUnits(effectiveAllowanceTotal, this.assetDecimals);
    if (this.sessionSigner && this.currentAllowanceUnits && requestedUnits <= this.currentAllowanceUnits && this.authSigner) {
      return;
    }

    if (!this.sessionPrivateKey) {
      this.sessionPrivateKey = generatePrivateKey();
    }
    this.sessionSigner = createECDSAMessageSigner(this.sessionPrivateKey);
    const sessionKeyAddress = privateKeyToAccount(this.sessionPrivateKey).address;

    // Yellow auth policy uses decimal strings (e.g. "10.20"), not raw units.
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    const appName = process.env.YELLOW_APP_NAME ?? 'v4-session-hook-market';
    const scope = process.env.YELLOW_SCOPE ?? 'transfer,app.create,app.state';
    // Yellow expects the EIP-712 domain name to match the application name.
    const authDomainName = appName;
    const asset = this.assetSymbol ?? 'ytest.usd';

    const authRequest = await createAuthRequestMessage({
      address: account.address,
      session_key: sessionKeyAddress,
      application: appName,
      allowances: [
        {
          asset,
          amount: effectiveAllowanceTotal,
        },
      ],
      expires_at: expiresAt,
      scope,
    });

    const challengeResponse = await this.rpc.send(authRequest);
    const challenge = (getResult(challengeResponse as any) as any)?.challenge_message ?? (challengeResponse.res?.[2] as any)?.challenge_message;
    if (!challenge) {
      throw new Error('Missing auth challenge from Yellow');
    }

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    this.authSigner = createEIP712AuthMessageSigner(
      walletClient as any,
      {
        scope,
        session_key: sessionKeyAddress,
        expires_at: expiresAt,
        allowances: [
          {
            asset,
            amount: effectiveAllowanceTotal,
          },
        ],
      },
      // Yellow expects the EIP-712 domain name to match the application name.
      { name: authDomainName }
    );

    const verifyMessage = await createAuthVerifyMessageFromChallenge(this.authSigner, challenge);
    const verifyResponse = await this.rpc.send(verifyMessage);
    const verifyResult = (getResult(verifyResponse as any) ?? verifyResponse.res?.[2]) as any;
    if (!verifyResult || verifyResult.success !== true) {
      const err = verifyResult?.error ? `: ${verifyResult.error}` : '';
      throw new Error(`Yellow auth verify failed${err}`);
    }

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
    this.publicClient = publicClient as any;

    this.currentAllowanceUnits = requestedUnits;

    // Channels are optional for this repo's demo flow. Only initialize the on-chain
    // client when we actually intend to create/resize/close channels.
    if (process.env.YELLOW_ENABLE_CHANNELS === 'true') {
      const challengeDurationSeconds = BigInt(process.env.YELLOW_CHALLENGE_DURATION_SECONDS ?? 3600);
      this.nitroliteClient = new NitroliteClient({
        publicClient: publicClient as any,
        walletClient: walletClient as any,
        stateSigner: new WalletStateSigner(walletClient as any) as any,
        addresses: {
          custody: this.custodyAddress as Address,
          adjudicator: this.adjudicatorAddress as Address,
        },
        chainId: this.chainId,
        // Nitrolite enforces a minimum challenge duration (3600 seconds).
        challengeDuration: challengeDurationSeconds,
      });
      await this.ensureChannel();
    }
  }

  private async ensureChannel() {
    if (!this.rpc || !this.sessionSigner || !this.nitroliteClient || !this.assetToken) return;
    if (this.channelId) return;

    const createChannelMessage = await createCreateChannelMessage(this.sessionSigner, {
      chain_id: this.chainId,
      token: this.assetToken,
    });
    const channelResponse = await this.rpc.send(createChannelMessage);
    const result = (getResult(channelResponse as any) ?? channelResponse.res?.[2]) as any;
    const channel = result?.channel;
    const state = result?.state;
    const serverSignature = result?.serverSignature ?? result?.server_signature;
    if (!channel || !state || !serverSignature) return;

    const clientChannel = convertRPCToClientChannel(channel);
    const stateData = (state.stateData ?? state.state_data ?? state.stateData) as Hex;
    const unsignedInitialState = {
      intent: state.intent as any,
      version: BigInt(state.version),
      data: stateData,
      allocations: state.allocations.map((allocation: any) => ({
        token: allocation.token,
        destination: allocation.destination,
        amount: BigInt(allocation.amount),
      })),
    };

    const createResult = await this.nitroliteClient.createChannel({
      channel: clientChannel,
      unsignedInitialState,
      serverSignature: serverSignature as Hex,
    });

    this.channelId = createResult.channelId as Hex;
    if (this.publicClient) {
      await this.publicClient.waitForTransactionReceipt({ hash: createResult.txHash as Hex });
    }

    const allocateTotal = process.env.YELLOW_CHANNEL_ALLOCATE_TOTAL;
    const allocateAmount = allocateTotal ? toUnits(allocateTotal, this.assetDecimals) : 0n;
    if (allocateAmount > 0n) {
      const resizeMessage = await createResizeChannelMessage(this.sessionSigner, {
        channel_id: createResult.channelId,
        allocate_amount: allocateAmount,
        funds_destination: this.walletAddress as Address,
      });
    const resizeResponse = await this.rpc.send(resizeMessage);
    const resizeResult = (getResult(resizeResponse as any) ?? resizeResponse.res?.[2]) as any;
      const resizeState = resizeResult?.state;
      const resizeServerSig = resizeResult?.serverSignature ?? resizeResult?.server_signature;
      const resizeStateData = (resizeState?.stateData ?? resizeState?.state_data ?? resizeState?.stateData) as Hex | undefined;
      if (resizeState && resizeServerSig && resizeStateData) {
        await this.nitroliteClient.resizeChannel({
          resizeState: {
            channelId: createResult.channelId,
            serverSignature: resizeServerSig,
            intent: resizeState.intent as any,
            version: BigInt(resizeState.version),
            data: resizeStateData,
            allocations: resizeState.allocations.map((allocation: any) => ({
              token: allocation.token,
              destination: allocation.destination,
              amount: BigInt(allocation.amount),
            })),
          },
          proofStates: [],
        });
      }
    }
  }

  async createSession(input: {
    workOrderId: string;
    allowanceTotal: string;
    allocationTotal: string;
    solverAddresses: string[];
    requesterAddress?: string | null;
  }) {
    if (this.mode === 'mock') {
      const requester = input.requesterAddress ?? '0x0000000000000000000000000000000000000001';
      const solverSet = new Set<string>();
      const solvers: string[] = [];
      for (const addr of input.solverAddresses) {
        const lower = addr.toLowerCase();
        if (solverSet.has(lower)) continue;
        solverSet.add(lower);
        solvers.push(addr);
      }
      const participants = [requester, ...solvers];
      return {
        sessionId: `yellow_mock_${randomUUID()}`,
        allowanceTotal: input.allowanceTotal,
        participants,
        allocations: participants.map((participant, index) => ({
          participant,
          amount: index === 0 ? input.allocationTotal : '0',
        })),
        version: 0,
      } satisfies YellowSessionState;
    }

    return this.withAuthRetry(async () => {
      await this.initReal(input.allowanceTotal);

      if (!this.rpc || !this.sessionSigner || !this.assetSymbol) {
        throw new Error('Yellow client not initialized');
      }

      const requester = (input.requesterAddress ?? this.walletAddress) as string | undefined;
      if (!requester) {
        throw new Error('Missing requester address for Yellow session');
      }
      // Stable ordering matters: requester is always index 0 (payer),
      // and we preserve the given solver order after de-duping.
      const solverSet = new Set<string>();
      const solvers: string[] = [];
      for (const addr of input.solverAddresses) {
        const lower = addr.toLowerCase();
        if (solverSet.has(lower)) continue;
        solverSet.add(lower);
        solvers.push(addr);
      }
      const participants = [requester, ...solvers];
      const allocations = participants.map((participant, index) => ({
        asset: this.assetSymbol as string,
        amount: index === 0 ? input.allocationTotal : '0',
        participant: participant as Address,
      }));

      const message = await createAppSessionMessage(this.sessionSigner, {
        definition: {
          // Must match the application name used in the auth_request policy.
          application: process.env.YELLOW_APP_NAME ?? 'v4-session-hook-market',
          protocol: RPCProtocolVersion.NitroRPC_0_4,
          participants: participants as Hex[],
          weights: participants.map(() => 1),
          // We want the requester-delegated session key to be able to update app state
          // without requiring co-signature from the solver (quorum of 1).
          quorum: 1,
          challenge: Number(process.env.YELLOW_CHALLENGE_DURATION_SECONDS ?? 3600),
          nonce: Math.floor(Date.now() / 1000),
        },
        allocations,
        session_data: JSON.stringify({ workOrderId: input.workOrderId }),
      });

      const response = await this.rpc.send(message);
      if (getMethod(response as any) === 'error' || response.err) {
        const errResult = (getResult(response as any) ?? response.res?.[2]) as any;
        throw new Error(`Yellow create session failed: ${errResult?.error ?? 'unknown error'}`);
      }
      const result = (getResult(response as any) ?? response.res?.[2]) as any;
      const sessionId = result?.app_session_id ?? result?.appSessionId ?? result?.appSessionID;
      if (!sessionId) {
        throw new Error('Missing app session id from Yellow');
      }

      const initialVersion = Number(result?.version ?? 0);
      return {
        sessionId,
        allowanceTotal: input.allowanceTotal,
        participants,
        allocations: participants.map((participant, index) => ({
          participant,
          amount: index === 0 ? input.allocationTotal : '0',
        })),
        version: initialVersion,
      } satisfies YellowSessionState;
    });
  }

  async transfer(input: {
    workOrderId: string;
    event: PaymentEvent;
    sessionState?: YellowSessionState | null;
    allowanceTotal?: string | null;
  }) {
    if (this.mode === 'mock') {
      return {
        transferId: `yellow_mock_transfer_${randomUUID()}`,
        sessionState: input.sessionState ?? null,
      };
    }

    return this.withAuthRetry(async () => {
      await this.initReal(input.sessionState?.allowanceTotal ?? input.allowanceTotal ?? input.event.amount);

      if (!this.rpc || !this.sessionSigner || !this.assetSymbol) {
        throw new Error('Yellow client not initialized');
      }

      if (!input.sessionState) {
        const message = await createTransferMessage(this.sessionSigner, {
          destination: input.event.toAddress as Address,
          allocations: [
            {
              asset: this.assetSymbol as string,
              amount: input.event.amount,
            },
          ],
        });
        const response = await this.rpc.send(message);
        if (getMethod(response as any) === 'error' || response.err) {
          const errResult = (getResult(response as any) ?? response.res?.[2]) as any;
          throw new Error(`Yellow transfer failed: ${errResult?.error ?? 'unknown error'}`);
        }
        const result = (getResult(response as any) ?? response.res?.[2]) as any;
        return {
          transferId: String(result?.transactions?.[0]?.id ?? randomUUID()),
          sessionState: null,
        };
      }

      const payer = input.sessionState.participants[0];
      const payee = input.event.toAddress;
      const amountUnits = toUnits(input.event.amount, this.assetDecimals);

      // Preserve the original-cased participant addresses, because the server treats
      // participant strings as exact identifiers (checksum casing matters).
      const canonicalParticipants = new Map<string, string>();
      for (const participant of input.sessionState.participants) {
        canonicalParticipants.set(participant.toLowerCase(), participant);
      }

      const allocationMap = new Map(
        input.sessionState.allocations.map((allocation) => [
          allocation.participant.toLowerCase(),
          toUnits(allocation.amount, this.assetDecimals),
        ])
      );

      const payerKey = payer.toLowerCase();
      const payeeKey = payee.toLowerCase();
      canonicalParticipants.set(payeeKey, payee);
      const payerBalance = allocationMap.get(payerKey) ?? 0n;
      if (payerBalance < amountUnits) {
        throw new Error('Insufficient session balance for transfer');
      }

      allocationMap.set(payerKey, payerBalance - amountUnits);
      allocationMap.set(payeeKey, (allocationMap.get(payeeKey) ?? 0n) + amountUnits);

      const newAllocations = Array.from(allocationMap.entries()).map(([participant, amount]) => ({
        asset: this.assetSymbol as string,
        amount: fromUnits(amount, this.assetDecimals),
        participant: (canonicalParticipants.get(participant) ?? participant) as Address,
      }));

      const version = input.sessionState.version + 1;
      const message = await createSubmitAppStateMessage(this.sessionSigner, {
        app_session_id: input.sessionState.sessionId as Hex,
        intent: RPCAppStateIntent.Operate,
        version,
        allocations: newAllocations,
        session_data: JSON.stringify({ paymentEventId: input.event.id, workOrderId: input.workOrderId }),
      });

      const response = await this.rpc.send(message);
      if (getMethod(response as any) === 'error' || response.err) {
        const errResult = (getResult(response as any) ?? response.err?.[2] ?? response.res?.[2]) as any;
        const err = errResult?.error ? `: ${errResult.error}` : '';
        throw new Error(`Yellow transfer failed${err}`);
      }

      const result = (getResult(response as any) ?? response.res?.[2]) as any;
      return {
        transferId: String(result?.version ?? randomUUID()),
        sessionState: {
          ...input.sessionState,
          allocations: Array.from(allocationMap.entries()).map(([participant, amount]) => ({
            participant: canonicalParticipants.get(participant) ?? participant,
            amount: fromUnits(amount, this.assetDecimals),
          })),
          version,
        },
      };
    });
  }

  async closeSession(input: { workOrderId: string; sessionState: YellowSessionState }) {
    if (this.mode === 'mock') {
      return {
        settlementTxId: `yellow_mock_settlement_${randomUUID()}`,
        workOrderId: input.workOrderId,
        apiUrl: this.apiUrl ?? null,
      };
    }

    return this.withAuthRetry(async () => {
      await this.initReal(input.sessionState.allowanceTotal);

      if (!this.rpc || !this.sessionSigner || !this.assetSymbol) {
        throw new Error('Yellow client not initialized');
      }

      const allocations = input.sessionState.allocations.map((allocation) => ({
        asset: this.assetSymbol as string,
        amount: allocation.amount,
        participant: allocation.participant as Address,
      }));

      const message = await createCloseAppSessionMessage(this.sessionSigner, {
        app_session_id: input.sessionState.sessionId as Hex,
        allocations,
        session_data: JSON.stringify({ workOrderId: input.workOrderId }),
      });

      const response = await this.rpc.send(message);
      if (getMethod(response as any) === 'error' || response.err) {
        const errResult = (getResult(response as any) ?? response.res?.[2]) as any;
        throw new Error(`Yellow close session failed: ${errResult?.error ?? 'unknown error'}`);
      }

      if (process.env.YELLOW_ENABLE_CHANNELS === 'true') {
        try {
          await this.ensureChannel();
          if (!this.channelId || !this.nitroliteClient) {
            throw new Error('Missing nitrolite channel state');
          }
          const fundDestination = (this.walletAddress ?? '0x0000000000000000000000000000000000000000') as Address;
          const closeMessage = await createCloseChannelMessage(this.sessionSigner, this.channelId, fundDestination);
          const closeResponse = await this.rpc.send(closeMessage);
          const closeResult = (getResult(closeResponse as any) ?? closeResponse.res?.[2]) as any;

          const channelId = (closeResult?.channelId ?? closeResult?.channel_id ?? this.channelId) as Hex;
          const state = closeResult?.state;
          const serverSignature = closeResult?.serverSignature ?? closeResult?.server_signature;
          const stateData = (state?.stateData ?? state?.state_data ?? state?.stateData) as Hex | undefined;
          if (!state || !serverSignature || !stateData) {
            throw new Error('Missing close_channel params from server');
          }

          const txHash = await this.nitroliteClient.closeChannel({
            stateData,
            finalState: {
              channelId,
              intent: StateIntent.FINALIZE,
              version: BigInt(state.version),
              data: stateData,
              allocations: state.allocations.map((allocation: any) => ({
                token: allocation.token,
                destination: allocation.destination,
                amount: BigInt(allocation.amount),
              })),
              serverSignature,
            },
          });

          if (this.publicClient) {
            await this.publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
          }

          return {
            settlementTxId: String(txHash),
            workOrderId: input.workOrderId,
            apiUrl: this.apiUrl ?? null,
          };
        } catch (err) {
          // Fall back to an offchain receipt if channel close/settlement is not available.
          // This keeps the demo flow running even when the onchain custody token is unfunded.
          const message = String((err as any)?.message ?? err);
          return {
            settlementTxId: `yellow_channel_close_failed:${message}`,
            workOrderId: input.workOrderId,
            apiUrl: this.apiUrl ?? null,
          };
        }
      }

      return {
        settlementTxId: randomUUID(),
        workOrderId: input.workOrderId,
        apiUrl: this.apiUrl ?? null,
      };
    });
  }
}
