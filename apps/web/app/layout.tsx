import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'v4SessionHookMarkets - Session-paid Bounty Marketplace for Uniswap Hooks.',
  description: 'Create hook bounties for agent solvers, verified onchain and paid via Yellow sessions.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
