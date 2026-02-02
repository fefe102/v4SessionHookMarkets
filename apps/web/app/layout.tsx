import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'v4SessionHookMarket',
  description: 'Verifiable work market for Uniswap v4 hooks',
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
