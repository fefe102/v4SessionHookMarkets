'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function SelectBestQuoteButton(
  {
    workOrderId,
    biddingEndsAt,
  }: {
    workOrderId: string;
    biddingEndsAt: number;
  }
) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleClick() {
    if (isLoading) return;
    try {
      window.dispatchEvent(new CustomEvent('v4shm:manual-select', { detail: { workOrderId } }));
    } catch {
      // ignore
    }
    setIsLoading(true);
    setStatus('Selecting...');

    try {
      const res = await fetch(`${API_BASE}/work-orders/${workOrderId}/select?force=true`, {
        method: 'POST',
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
  const label = isBiddingOpen ? 'Close Bidding + Select' : 'Select Best Quote';

  return (
    <div>
      <button className="button" onClick={handleClick} disabled={isLoading}>
        {label}
      </button>
      {status && <p>{status}</p>}
    </div>
  );
}
