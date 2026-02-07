import Link from 'next/link';
import { fetchJson } from '../../lib/api';
import LiFiWidgetClient from './widget-client';

type AppConfig = {
  chainId: number;
  yellow: {
    mode: 'mock' | 'real';
    asset: { symbol: string; chainId: number; token: string; decimals: number };
    requesterAddress: string | null;
    enableChannels: boolean;
  };
  verifier: {
    chainId: number;
    address: string | null;
  };
};

export default async function LiFiPage() {
  let config: AppConfig | null = null;
  try {
    config = await fetchJson<AppConfig>('/config');
  } catch {
    config = null;
  }

  return (
    <>
      <header>
        <Link href="/" className="button secondary">Back</Link>
        <h1>LI.FI Prize</h1>
        <p>Bridge/swap cross-chain to fund the requester or cash out to another chain.</p>
      </header>

      <section className="grid two">
        <div className="card">
          <h3>Preset</h3>
          <p>Target chain: {config?.chainId ?? 84532} (Base Sepolia)</p>
          <p>Requester: {config?.yellow.requesterAddress ?? 'n/a'}</p>
          <p>Verifier: {config?.verifier.address ?? 'n/a'}</p>
          <p>Yellow mode: {config?.yellow.mode ?? 'n/a'} (channels: {String(config?.yellow.enableChannels ?? false)})</p>
          <p className="muted">
            Note: Yellow payouts are offchain; LI.FI is an onchain bridge/swap rail for entering/exiting the
            chain used by the demo.
          </p>
        </div>
        <div className="card">
          <h3>Bridge</h3>
          <LiFiWidgetClient
            toChainId={config?.chainId ?? 84532}
            requesterAddress={config?.yellow.requesterAddress ?? null}
          />
        </div>
      </section>
    </>
  );
}
