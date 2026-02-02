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

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async connect() {
    if (this.ws) return;
    this.ws = new WebSocket(this.wsUrl);
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
          reject(new Error('RPC timeout'));
        }
      }, 15000);
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
  private sessionSigner?: (payload: any) => Promise<Hex>;
  private authSigner?: (payload: any) => Promise<Hex>;
  private nitroliteClient?: NitroliteClient;
  private assetToken?: Address;
  private assetDecimals = 6;
  private chainId = 84532;
  private channelId?: Hex;
  private currentAllowanceUnits?: bigint;
  private custodyAddress?: Address;
  private adjudicatorAddress?: Address;

  constructor(options: YellowClientOptions) {
    this.mode = options.mode;
    this.apiUrl = options.apiUrl;
  }

  getRequesterAddress(): string | null {
    return this.walletAddress ?? null;
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
      const assets = config?.assets ?? [];
      const network = networks.find((net: any) => Number(net.chain_id ?? net.chainId) === this.chainId);
      const asset = assets.find((a: any) => Number(a.chain_id ?? a.chainId) === this.chainId && a.symbol === 'ytest.usd');

      if (!network || !asset) {
        throw new Error('Unable to resolve Yellow config for selected chain');
      }

      this.assetToken = (asset.token ?? asset.asset) as Address;
      this.assetDecimals = Number(asset.decimals ?? 6);
      this.custodyAddress = (network.custody_address ?? network.custodyAddress) as Address;
      this.adjudicatorAddress = (network.adjudicator_address ?? network.adjudicatorAddress) as Address;
    }

    const requestedUnits = toUnits(allowanceTotal, this.assetDecimals);
    if (this.sessionSigner && this.currentAllowanceUnits && requestedUnits <= this.currentAllowanceUnits) {
      return;
    }

    const sessionPrivateKey = generatePrivateKey();
    this.sessionSigner = createECDSAMessageSigner(sessionPrivateKey);

    const allowanceUnits = requestedUnits.toString();

    const authRequest = await createAuthRequestMessage({
      address: account.address,
      session_key: privateKeyToAccount(sessionPrivateKey).address,
      application: process.env.YELLOW_APP_NAME ?? 'v4-session-hook-market',
      allowances: [
        {
          asset: this.assetToken,
          amount: allowanceUnits,
        },
      ],
      expires_at: BigInt(Math.floor(Date.now() / 1000) + 60 * 60),
      scope: process.env.YELLOW_SCOPE ?? 'work_orders',
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
        scope: process.env.YELLOW_SCOPE ?? 'work_orders',
        session_key: privateKeyToAccount(sessionPrivateKey).address,
        expires_at: BigInt(Math.floor(Date.now() / 1000) + 60 * 60),
        allowances: [
          {
            asset: this.assetToken,
            amount: allowanceUnits,
          },
        ],
      },
      { name: process.env.YELLOW_EIP712_DOMAIN ?? 'Nitrolite' }
    );

    const verifyMessage = await createAuthVerifyMessageFromChallenge(this.authSigner, challenge);
    await this.rpc.send(verifyMessage);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    this.nitroliteClient = new NitroliteClient({
      publicClient: publicClient as any,
      walletClient: walletClient as any,
      stateSigner: new WalletStateSigner(walletClient as any) as any,
      addresses: {
        custody: this.custodyAddress as Address,
        adjudicator: this.adjudicatorAddress as Address,
      },
      chainId: this.chainId,
      challengeDuration: BigInt(600),
    });

    this.currentAllowanceUnits = requestedUnits;

    if (process.env.YELLOW_ENABLE_CHANNELS === 'true') {
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
    if (!result?.channel || !result?.state || !result?.serverSignature) return;

    const channel = convertRPCToClientChannel(result.channel);
    const unsignedInitialState = {
      intent: result.state.intent as any,
      version: BigInt(result.state.version),
      data: result.state.stateData as Hex,
      allocations: result.state.allocations.map((allocation: any) => ({
        token: allocation.token,
        destination: allocation.destination,
        amount: BigInt(allocation.amount),
      })),
    };

    const createResult = await this.nitroliteClient.createChannel({
      channel,
      unsignedInitialState,
      serverSignature: result.serverSignature as Hex,
    });

    this.channelId = createResult.channelId as Hex;

    const allocateAmount = BigInt(result.state.allocations?.[0]?.amount ?? 0n);
    if (allocateAmount > 0n) {
      const resizeMessage = await createResizeChannelMessage(this.sessionSigner, {
        channel_id: createResult.channelId,
        allocate_amount: allocateAmount,
        funds_destination: this.walletAddress as Address,
      });
    const resizeResponse = await this.rpc.send(resizeMessage);
    const resizeResult = (getResult(resizeResponse as any) ?? resizeResponse.res?.[2]) as any;
      if (resizeResult?.state && resizeResult?.serverSignature) {
        await this.nitroliteClient.resizeChannel({
          resizeState: {
            channelId: createResult.channelId,
            serverSignature: resizeResult.serverSignature,
            intent: resizeResult.state.intent as any,
            version: BigInt(resizeResult.state.version),
            data: resizeResult.state.stateData as Hex,
            allocations: resizeResult.state.allocations.map((allocation: any) => ({
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

  async createSession(input: { workOrderId: string; allowanceTotal: string; solverAddress: string; requesterAddress?: string | null }) {
    if (this.mode === 'mock') {
      const requester = input.requesterAddress ?? '0x0000000000000000000000000000000000000001';
      const participants = [requester, input.solverAddress];
      return {
        sessionId: `yellow_mock_${randomUUID()}`,
        allowanceTotal: input.allowanceTotal,
        participants,
        allocations: participants.map((participant, index) => ({
          participant,
          amount: index === 0 ? input.allowanceTotal : '0',
        })),
        version: 0,
      } satisfies YellowSessionState;
    }

    await this.initReal(input.allowanceTotal);

    if (!this.rpc || !this.sessionSigner || !this.assetToken) {
      throw new Error('Yellow client not initialized');
    }

    const requester = (input.requesterAddress ?? this.walletAddress) as string | undefined;
    if (!requester) {
      throw new Error('Missing requester address for Yellow session');
    }
    const participants = [requester, input.solverAddress];
    const allowanceUnits = toUnits(input.allowanceTotal, this.assetDecimals).toString();
    const allocations = participants.map((participant, index) => ({
      asset: this.assetToken as string,
      amount: index === 0 ? allowanceUnits : '0',
      participant: participant as Address,
    }));

    const message = await createAppSessionMessage(this.sessionSigner, {
      definition: {
        application: `v4shm-${input.workOrderId}`,
        protocol: RPCProtocolVersion.NitroRPC_0_4,
        participants: participants as Hex[],
        weights: participants.map(() => 1),
        quorum: participants.length,
        challenge: 600,
        nonce: Math.floor(Date.now() / 1000),
      },
      allocations,
      session_data: JSON.stringify({ workOrderId: input.workOrderId }),
    });

    const response = await this.rpc.send(message);
    const result = (getResult(response as any) ?? response.res?.[2]) as any;
    const sessionId = result?.app_session_id ?? result?.appSessionId;
    if (!sessionId) {
      throw new Error('Missing app session id from Yellow');
    }

    return {
      sessionId,
      allowanceTotal: input.allowanceTotal,
      participants,
      allocations: participants.map((participant, index) => ({
        participant,
        amount: index === 0 ? input.allowanceTotal : '0',
      })),
      version: 0,
    } satisfies YellowSessionState;
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

    await this.initReal(input.sessionState?.allowanceTotal ?? input.allowanceTotal ?? input.event.amount);

    if (!this.rpc || !this.sessionSigner || !this.assetToken) {
      throw new Error('Yellow client not initialized');
    }

    if (!input.sessionState) {
      const message = await createTransferMessage(this.sessionSigner, {
        destination: input.event.toAddress as Address,
        allocations: [
          {
            asset: this.assetToken as string,
            amount: toUnits(input.event.amount, this.assetDecimals).toString(),
          },
        ],
      });
      await this.rpc.send(message);
      return {
        transferId: randomUUID(),
        sessionState: null,
      };
    }

    const payer = input.sessionState.participants[0];
    const payee = input.event.toAddress;
    const amountUnits = toUnits(input.event.amount, this.assetDecimals);

    const allocationMap = new Map(
      input.sessionState.allocations.map((allocation) => [
        allocation.participant.toLowerCase(),
        toUnits(allocation.amount, this.assetDecimals),
      ])
    );

    const payerKey = payer.toLowerCase();
    const payeeKey = payee.toLowerCase();
    const payerBalance = allocationMap.get(payerKey) ?? 0n;
    if (payerBalance < amountUnits) {
      throw new Error('Insufficient session balance for transfer');
    }

    allocationMap.set(payerKey, payerBalance - amountUnits);
    allocationMap.set(payeeKey, (allocationMap.get(payeeKey) ?? 0n) + amountUnits);

    const newAllocations = Array.from(allocationMap.entries()).map(([participant, amount]) => ({
      asset: this.assetToken as string,
      amount: amount.toString(),
      participant: participant as Address,
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
      throw new Error('Yellow transfer failed');
    }

    return {
      transferId: randomUUID(),
      sessionState: {
        ...input.sessionState,
        allocations: Array.from(allocationMap.entries()).map(([participant, amount]) => ({
          participant,
          amount: fromUnits(amount, this.assetDecimals),
        })),
        version,
      },
    };
  }

  async closeSession(input: { workOrderId: string; sessionState: YellowSessionState }) {
    if (this.mode === 'mock') {
      return {
        settlementTxId: `yellow_mock_settlement_${randomUUID()}`,
        workOrderId: input.workOrderId,
        apiUrl: this.apiUrl ?? null,
      };
    }

    await this.initReal(input.sessionState.allowanceTotal);

    if (!this.rpc || !this.sessionSigner || !this.assetToken) {
      throw new Error('Yellow client not initialized');
    }

    const allocations = input.sessionState.allocations.map((allocation) => ({
      asset: this.assetToken as string,
      amount: toUnits(allocation.amount, this.assetDecimals).toString(),
      participant: allocation.participant as Address,
    }));

    const message = await createCloseAppSessionMessage(this.sessionSigner, {
      app_session_id: input.sessionState.sessionId as Hex,
      allocations,
      session_data: JSON.stringify({ workOrderId: input.workOrderId }),
    });

    await this.rpc.send(message);

    if (process.env.YELLOW_ENABLE_CHANNELS === 'true' && this.channelId) {
      const closeMessage = await createCloseChannelMessage(
        this.sessionSigner,
        this.channelId,
        (this.walletAddress ?? '0x0000000000000000000000000000000000000000') as Address
      );
      await this.rpc.send(closeMessage);
    }

    return {
      settlementTxId: randomUUID(),
      workOrderId: input.workOrderId,
      apiUrl: this.apiUrl ?? null,
    };
  }
}
