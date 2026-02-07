'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function CreateWorkOrderForm() {
  const router = useRouter();
  const [title, setTitle] = useState('Try it: SwapCapHook bounty (cap amountIn per swap)');
  const [templateType, setTemplateType] = useState<'SWAP_CAP_HOOK' | 'WHITELIST_HOOK'>('SWAP_CAP_HOOK');
  const [bounty, setBounty] = useState('0.05');
  const [capAmountIn, setCapAmountIn] = useState('1000');
  const [allowlist, setAllowlist] = useState('0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002');
  const [requesterAddress, setRequesterAddress] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('Creating...');
    setLastCreatedId(null);
    const params = templateType === 'SWAP_CAP_HOOK'
      ? { capAmountIn: Number(capAmountIn) }
      : { allowlist: allowlist.split(',').map((addr) => addr.trim()) };

    const res = await fetch(`${API_BASE}/work-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        templateType,
        params,
        bounty: { currency: 'ytest.usd', amount: bounty },
        requesterAddress: requesterAddress.trim() ? requesterAddress.trim() : undefined,
      }),
    });

    if (!res.ok) {
      setStatus(`Error: ${await res.text()}`);
      return;
    }

    const data = await res.json();
    setStatus(`Created work order ${data.id}. Scroll down to Live Work Orders or click "Open work order".`);
    setLastCreatedId(String(data.id));
    router.refresh();
  }

  return (
    <form className="card form-grid" onSubmit={handleSubmit}>
      <h3>Create Work Order</h3>
      <p className="help">
        Create a bounty for agent solvers, or pick a demo template to try the marketplace end-to-end.
      </p>
      <label>
        Title
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Template
        <select className="select" value={templateType} onChange={(e) => setTemplateType(e.target.value as any)}>
          <option value="SWAP_CAP_HOOK">SwapCapHook</option>
          <option value="WHITELIST_HOOK">WhitelistHook</option>
        </select>
        <p className="help">
          SwapCap enforces a max amountIn per swap. Whitelist only allows specific traders to swap.
        </p>
      </label>
      {templateType === 'SWAP_CAP_HOOK' ? (
        <label>
          capAmountIn
          <input className="input" value={capAmountIn} onChange={(e) => setCapAmountIn(e.target.value)} />
        </label>
      ) : (
        <label>
          allowlist (comma-separated)
          <input className="input" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
        </label>
      )}
      <label>
        Bounty (ytest.usd)
        <input className="input" value={bounty} onChange={(e) => setBounty(e.target.value)} />
        <p className="help">
          Budget cap for solver quotes and milestone payouts. Keep it small for demo wallets.
        </p>
      </label>
      <label>
        Requester address (optional)
        <input className="input" value={requesterAddress} onChange={(e) => setRequesterAddress(e.target.value)} />
        <p className="help">
          If set, this address is stored as the requester for this work order and used when creating the Yellow session.
          Leave blank to use the API&apos;s configured Yellow wallet.
        </p>
      </label>
      <button className="button" type="submit">Create</button>
      {lastCreatedId ? (
        <button className="button secondary" type="button" onClick={() => router.push(`/work-orders/${lastCreatedId}`)}>
          Open work order
        </button>
      ) : null}
      {status && <p>{status}</p>}
    </form>
  );
}
