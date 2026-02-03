'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { WidgetConfig, ChainType } from '@lifi/widget';

const LiFiWidget = dynamic(async () => (await import('@lifi/widget')).LiFiWidget, { ssr: false });

export default function LiFiWidgetClient(props: { toChainId: number; requesterAddress: string | null }) {
  const [mode, setMode] = useState<'fund' | 'cashout'>('fund');
  const [toAddress, setToAddress] = useState<string>(props.requesterAddress ?? '');
  const [formUpdateKey, setFormUpdateKey] = useState<string>(() => String(Date.now()));

  const config = useMemo(() => {
    const toAddressConfig = toAddress.trim()
      ? { address: toAddress.trim(), chainType: 'EVM' as ChainType }
      : undefined;

    const base: WidgetConfig = {
      integrator: process.env.NEXT_PUBLIC_LIFI_INTEGRATOR ?? 'v4SessionHookMarket',
      // Keep widget state shareable via URL for demos/screen recordings.
      buildUrl: true,
      formUpdateKey,
      toChain: props.toChainId,
      toAddress: toAddressConfig,
      appearance: 'light',
      // Keep wallet config minimal: injected wallets work without any extra keys.
      walletConfig: {
        // Prefer internal wallet menu to avoid requiring external providers.
        forceInternalWalletManagement: true,
      },
      // Provide public RPCs to reduce rate-limits during demos.
      sdkConfig: {
        rpcUrls: {
          [props.toChainId]: [
            'https://sepolia.base.org',
            'https://base-sepolia-rpc.publicnode.com',
            'https://base-sepolia.drpc.org',
            'https://base-sepolia.gateway.tenderly.co',
          ],
        },
      },
    };

    if (mode === 'cashout') {
      return {
        ...base,
        // Default cashout: start on Base Sepolia and let the user choose the destination.
        fromChain: props.toChainId,
        toChain: undefined,
        toAddress: undefined,
      };
    }

    return base;
  }, [formUpdateKey, mode, props.toChainId, toAddress]);

  return (
    <div className="grid">
      <div className="grid two">
        <button
          className={`button ${mode === 'fund' ? '' : 'secondary'}`}
          type="button"
          onClick={() => {
            setMode('fund');
            setFormUpdateKey(String(Date.now()));
          }}
        >
          Fund Requester
        </button>
        <button
          className={`button ${mode === 'cashout' ? '' : 'secondary'}`}
          type="button"
          onClick={() => {
            setMode('cashout');
            setFormUpdateKey(String(Date.now()));
          }}
        >
          Cash Out
        </button>
      </div>

      {mode === 'fund' ? (
        <label>
          To address (EVM)
          <input
            className="input"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            placeholder="0x..."
          />
          <div className="grid two" style={{ marginTop: 8 }}>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setToAddress(props.requesterAddress ?? '');
                setFormUpdateKey(String(Date.now()));
              }}
              disabled={!props.requesterAddress}
            >
              Use requester
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setToAddress('');
                setFormUpdateKey(String(Date.now()));
              }}
            >
              Use connected wallet
            </button>
          </div>
        </label>
      ) : (
        <p className="muted">
          Cash out starts from Base Sepolia and lets you bridge/swap to any supported destination.
        </p>
      )}

      <div style={{ minHeight: 720 }}>
        <LiFiWidget {...config} />
      </div>
    </div>
  );
}
