import { randomUUID } from 'node:crypto';
import type { PaymentEvent } from '@v4shm/shared';

export type YellowClientOptions = {
  mode: 'mock' | 'real';
  apiUrl?: string;
};

export class YellowClient {
  private mode: YellowClientOptions['mode'];
  private apiUrl?: string;

  constructor(options: YellowClientOptions) {
    this.mode = options.mode;
    this.apiUrl = options.apiUrl;
  }

  async createSession(input: { workOrderId: string; allowanceTotal: string }) {
    if (this.mode === 'mock') {
      return {
        sessionId: `yellow_mock_${randomUUID()}`,
        allowanceTotal: input.allowanceTotal,
      };
    }

    throw new Error('YELLOW_MODE=real is not implemented yet. Use mock mode for local demo.');
  }

  async transfer(event: PaymentEvent) {
    if (this.mode === 'mock') {
      return {
        transferId: `yellow_mock_transfer_${randomUUID()}`,
        to: event.toAddress,
        amount: event.amount,
      };
    }

    throw new Error('YELLOW_MODE=real is not implemented yet. Use mock mode for local demo.');
  }

  async closeSession(input: { workOrderId: string }) {
    if (this.mode === 'mock') {
      return {
        settlementTxId: `yellow_mock_settlement_${randomUUID()}`,
        workOrderId: input.workOrderId,
        apiUrl: this.apiUrl ?? null,
      };
    }

    throw new Error('YELLOW_MODE=real is not implemented yet. Use mock mode for local demo.');
  }
}
