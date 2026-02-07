'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE } from '../../lib/api';

export default function SelectQuoteButton(
  {
    workOrderId,
    quoteId,
    biddingEndsAt,
  }: {
    workOrderId: string;
    quoteId: string;
    biddingEndsAt: number;
  }
) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleClick() {
    if (isLoading) return;
    setIsLoading(true);
    setStatus('Selecting...');

    const isBiddingOpen = Date.now() < biddingEndsAt;
    const url = `${API_BASE}/work-orders/${workOrderId}/select${isBiddingOpen ? '?force=true' : ''}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteId }),
      });

      if (!res.ok) {
        setStatus(`Error: ${await res.text()}`);
        return;
      }

      setStatus('Selected.');
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  const isBiddingOpen = Date.now() < biddingEndsAt;
  const label = isBiddingOpen ? 'Close + Pick' : 'Pick This Quote';

  return (
    <div>
      <button className="button secondary" onClick={handleClick} disabled={isLoading}>
        {label}
      </button>
      {status && <p className="help">{status}</p>}
    </div>
  );
}

