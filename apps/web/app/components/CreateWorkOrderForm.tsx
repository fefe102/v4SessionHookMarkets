'use client';

import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function CreateWorkOrderForm() {
  const [title, setTitle] = useState('Swap cap demo');
  const [templateType, setTemplateType] = useState<'SWAP_CAP_HOOK' | 'WHITELIST_HOOK'>('SWAP_CAP_HOOK');
  const [bounty, setBounty] = useState('10');
  const [capAmountIn, setCapAmountIn] = useState('1000');
  const [allowlist, setAllowlist] = useState('0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002');
  const [status, setStatus] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('Creating...');
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
      }),
    });

    if (!res.ok) {
      setStatus(`Error: ${await res.text()}`);
      return;
    }

    const data = await res.json();
    setStatus(`Created work order ${data.id}`);
  }

  return (
    <form className="card form-grid" onSubmit={handleSubmit}>
      <h3>Create Work Order</h3>
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
      </label>
      <button className="button" type="submit">Create</button>
      {status && <p>{status}</p>}
    </form>
  );
}
