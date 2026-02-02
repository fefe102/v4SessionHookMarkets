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
        <h1>v4SessionHookMarket</h1>
        <p>Verifiable work market for Uniswap v4 hook modules.</p>
      </header>

      <section className="grid two">
        <CreateWorkOrderForm />
        <div className="card">
          <h3>Live Work Orders</h3>
          {workOrders.length === 0 ? (
            <p>No work orders yet. Create one to kick off the market.</p>
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
    </>
  );
}
