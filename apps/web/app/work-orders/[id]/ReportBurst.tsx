'use client';

import { useEffect, useRef, useState } from 'react';

type BurstKind = 'pass' | 'fail';

export default function ReportBurst({ status }: { status: string | null }) {
  const prevStatusRef = useRef<string | null>(null);
  const [burst, setBurst] = useState<{ kind: BurstKind; nonce: number } | null>(null);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (!status) return;
    if (status === prev) return;

    if (status === 'PASS') setBurst({ kind: 'pass', nonce: Date.now() });
    if (status === 'FAIL') setBurst({ kind: 'fail', nonce: Date.now() });
  }, [status]);

  useEffect(() => {
    if (!burst) return;
    const timeout = window.setTimeout(() => setBurst(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [burst]);

  if (!burst) return null;

  const emoji = burst.kind === 'pass' ? '🎆' : '💥';
  const label = burst.kind === 'pass' ? 'Verification passed' : 'Verification failed';

  return (
    <div key={burst.nonce} className={`burst burst-${burst.kind}`} aria-label={label}>
      <span className="burst-emoji">{emoji}</span>
    </div>
  );
}

