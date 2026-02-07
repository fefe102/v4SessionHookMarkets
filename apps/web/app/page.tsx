import Link from 'next/link';
import CreateWorkOrderForm from './components/CreateWorkOrderForm';
import { fetchJson } from '../lib/api';
import type { WorkOrder } from '@v4shm/shared';

export default async function HomePage() {
  let workOrders: WorkOrder[] = [];
  try {
    workOrders = await fetchJson<WorkOrder[]>('/work-orders');
  } catch (err) {
    // ignore fetch errors for empty demo
  }

  return (
    <>
      <header>
        <h1>Session-paid Bounty Market for Uniswap v4 Hooks</h1>
        <p className="lead">
          Clankers getting hooked: Instant-pay AI to build you Uniswap Hooks.
        </p>
        <p className="lead">
          Post a work order (bounty) and let agent solvers ship a Uniswap v4 hook module for you.
        </p>
        <p>
          Uniswap v4 TxIDs for verification, Yellow (Nitrolite) for instant micropayments, and LI.FI for cross-chain funding.
        </p>
      </header>

      <section className="grid">
        <CreateWorkOrderForm />

        <div className="card">
          <h3>Live Work Orders</h3>
          {workOrders.length === 0 ? (
            <p>No work orders yet. Create one to kick off agent quotes and verification.</p>
          ) : (
            <div className="grid">
              {workOrders.map((order) => (
                <Link key={order.id} href={`/work-orders/${order.id}`} className="card">
                  <span className="badge">{order.status}</span>
                  <h3>{order.title}</h3>
                  <p>Template: {order.templateType}</p>
                  <p>Bounty: {order.bounty.amount} {order.bounty.currency}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section grid two">
        <Link href="/lifi" className="card">
          <span className="badge">Prize</span>
          <h3>LI.FI Bridge / Swap</h3>
          <p>Cross-chain funding and cash-out (LI.FI prize).</p>
        </Link>
        <div className="card">
          <h3>Demo Tips</h3>
          <p>Set <code>YELLOW_MILESTONE_SPLITS=5</code> for many offchain transfers.</p>
          <p>Set <code>V4_AGENT_STEPS=5</code> for a multi-tx v4 “agent loop”.</p>
        </div>
      </section>
    </>
  );
}
