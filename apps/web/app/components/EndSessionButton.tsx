'use client';

import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function EndSessionButton({ workOrderId }: { workOrderId: string }) {
  const [status, setStatus] = useState<string | null>(null);

  async function handleClick() {
    setStatus('Settling...');
    const res = await fetch(`${API_BASE}/work-orders/${workOrderId}/end-session?force=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    if (!res.ok) {
      setStatus(`Error: ${await res.text()}`);
      return;
    }

    const json = (await res.json()) as any;
    const txid = String(json?.settlement?.settlementTxId ?? '');
    setStatus(txid ? `Session settled (tx: ${txid})` : 'Session settled');
  }

  return (
    <div>
      <button className="button" onClick={handleClick}>End Session</button>
      {status && <p>{status}</p>}
    </div>
  );
}
