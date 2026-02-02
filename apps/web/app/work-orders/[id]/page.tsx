import Link from 'next/link';
import { fetchJson } from '../../../lib/api';
import EndSessionButton from '../../components/EndSessionButton';
import type { WorkOrder, QuotePayload, SubmissionPayload, PaymentEvent, VerificationReport } from '@v4shm/shared';

export default async function WorkOrderPage({ params }: { params: { id: string } }) {
  const id = params.id;
  let workOrder: WorkOrder | null = null;
  let quotes: QuotePayload[] = [];
  let submissions: SubmissionPayload[] = [];
  let payments: PaymentEvent[] = [];
  let report: VerificationReport | null = null;

  try {
    workOrder = await fetchJson<WorkOrder>(`/work-orders/${id}`);
    quotes = await fetchJson<QuotePayload[]>(`/work-orders/${id}/quotes`);
    submissions = await fetchJson<SubmissionPayload[]>(`/work-orders/${id}/submissions`);
    payments = await fetchJson<PaymentEvent[]>(`/work-orders/${id}/payments`);
    try {
      report = await fetchJson<VerificationReport>(`/work-orders/${id}/verification`);
    } catch {
      report = null;
    }
  } catch {
    workOrder = null;
  }

  if (!workOrder) {
    return (
      <div className="card">
        <p>Work order not found.</p>
        <Link href="/" className="button secondary">Back</Link>
      </div>
    );
  }

  return (
    <>
      <header>
        <Link href="/" className="button secondary">Back</Link>
        <h1>{workOrder.title}</h1>
        <p>{workOrder.id}</p>
      </header>

      <section className="grid two">
        <div className="card">
          <h3>Status</h3>
          <p className="badge">{workOrder.status}</p>
          <p>Template: {workOrder.templateType}</p>
          <p>Bounty: {workOrder.bounty.amount} {workOrder.bounty.currency}</p>
          <p>Bidding ends: {new Date(workOrder.bidding.biddingEndsAt).toLocaleTimeString()}</p>
          {workOrder.status === 'PASSED_PENDING_CHALLENGE' ? (
            <div className="section">
              <EndSessionButton workOrderId={workOrder.id} />
            </div>
          ) : null}
        </div>
        <div className="card">
          <h3>Selection</h3>
          <p>Selected quote: {workOrder.selection.selectedQuoteId ?? 'n/a'}</p>
          <p>Selected solver: {workOrder.selection.selectedSolverId ?? 'n/a'}</p>
        </div>
      </section>

      <section className="section grid two">
        <div className="card">
          <h3>Quotes</h3>
          {quotes.length === 0 ? <p>No quotes yet.</p> : (
            <div className="grid">
              {quotes.map((quote) => (
                <div key={quote.id} className="card">
                  <p>{quote.solverAddress}</p>
                  <p>{quote.price} / ETA {quote.etaMinutes}m</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Submissions</h3>
          {submissions.length === 0 ? <p>No submissions yet.</p> : (
            <div className="grid">
              {submissions.map((submission) => (
                <div key={submission.id} className="card">
                  <p>{submission.solverAddress}</p>
                  <p>{submission.artifact.commitSha.slice(0, 8)}...</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section grid two">
        <div className="card">
          <h3>Verification Report</h3>
          {report ? (
            <>
              <p>Status: {report.status}</p>
              <p>Hook: {report.proof.hookAddress}</p>
              <p>Pool ID: {report.proof.poolId.slice(0, 10)}...</p>
              <p>TxIDs: {report.proof.txIds.length}</p>
            </>
          ) : (
            <p>Not verified yet.</p>
          )}
        </div>
        <div className="card">
          <h3>Payments</h3>
          {payments.length === 0 ? <p>No payments yet.</p> : (
            <div className="grid">
              {payments.map((payment) => (
                <div key={payment.id} className="card">
                  <p>{payment.type}</p>
                  <p>{payment.amount} {'->'} {payment.toAddress.slice(0, 10)}...</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
