'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE } from '../../../lib/api';

type QuoteLite = { id: string; price: string; etaMinutes: number; createdAt: number };

function parsePrice(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function pickLowest(quotes: QuoteLite[]): QuoteLite | null {
  if (quotes.length === 0) return null;
  return [...quotes].sort((a, b) => {
    const priceDiff = parsePrice(a.price) - parsePrice(b.price);
    if (priceDiff !== 0) return priceDiff;
    const etaDiff = a.etaMinutes - b.etaMinutes;
    if (etaDiff !== 0) return etaDiff;
    return a.createdAt - b.createdAt;
  })[0];
}

export default function AutoPickQuote({
  workOrderId,
  workOrderStatus,
  selectedQuoteId,
  quotes,
}: {
  workOrderId: string;
  workOrderStatus: string;
  selectedQuoteId: string | null;
  quotes: QuoteLite[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [thirdQuoteSeenAt, setThirdQuoteSeenAt] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const manualOverrideRef = useRef(false);
  const quotesRef = useRef<QuoteLite[]>(quotes);

  quotesRef.current = quotes;

  useEffect(() => {
    function cancel() {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function onManualSelect(event: Event) {
      const detail = (event as CustomEvent).detail as { workOrderId?: string } | undefined;
      if (detail?.workOrderId !== workOrderId) return;
      manualOverrideRef.current = true;
      cancel();
      setStatus(null);
    }

    window.addEventListener('v4shm:manual-select', onManualSelect);
    return () => {
      window.removeEventListener('v4shm:manual-select', onManualSelect);
      cancel();
    };
  }, [workOrderId]);

  useEffect(() => {
    if (quotes.length < 3) return;
    if (thirdQuoteSeenAt !== null) return;
    setThirdQuoteSeenAt(Date.now());
  }, [quotes.length, thirdQuoteSeenAt]);

  useEffect(() => {
    function cancel() {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    if (timerRef.current !== null) return;
    if (workOrderStatus !== 'BIDDING') return;
    if (selectedQuoteId) return;
    if (manualOverrideRef.current) return;
    if (thirdQuoteSeenAt === null) return;

    const dueAt = thirdQuoteSeenAt + 3000;
    const delayMs = Math.max(0, dueAt - Date.now());
    setStatus('Auto-picking lowest quote...');

    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      setStatus(null);

      // Bail if the user selected during the delay.
      if (manualOverrideRef.current) return;

      const lowest = pickLowest(quotesRef.current);
      if (!lowest) return;

      try {
        const res = await fetch(`${API_BASE}/work-orders/${workOrderId}/select?force=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quoteId: lowest.id }),
        });
        if (!res.ok) return;
        router.refresh();
      } catch {
        // ignore; user can still pick manually
      }
    }, delayMs);

    return () => {
      cancel();
    };
  }, [selectedQuoteId, thirdQuoteSeenAt, workOrderId, workOrderStatus, router]);

  useEffect(() => {
    if (!selectedQuoteId) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatus(null);
  }, [selectedQuoteId]);

  return status ? <p className="help">{status}</p> : null;
}
