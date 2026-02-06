import Link from 'next/link';
import { fetchJson } from '../../../lib/api';
import LiveRefresher from './LiveRefresher';
import EndSessionButton from '../../components/EndSessionButton';
import SelectBestQuoteButton from '../../components/SelectBestQuoteButton';
import type { WorkOrder, QuotePayload, SubmissionPayload, PaymentEvent, VerificationReport } from '@v4shm/shared';

export default async function WorkOrderPage({ params }: { params: { id: string } }) {
  const id = params.id;
  let workOrder: WorkOrder | null = null;
  let quotes: QuotePayload[] = [];
  let submissions: SubmissionPayload[] = [];
  let payments: PaymentEvent[] = [];
  let report: VerificationReport | null = null;
  let solverStats: Array<{ stats: any; reputation: any }> = [];

  try {
    workOrder = await fetchJson<WorkOrder>(`/work-orders/${id}`);
    quotes = await fetchJson<QuotePayload[]>(`/work-orders/${id}/quotes`);
    submissions = await fetchJson<SubmissionPayload[]>(`/work-orders/${id}/submissions`);
    payments = await fetchJson<PaymentEvent[]>(`/work-orders/${id}/payments`);
    try {
      solverStats = await fetchJson<Array<{ stats: any; reputation: any }>>(`/solvers`);
    } catch {
      solverStats = [];
    }
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

  const reputationMap = new Map(
    solverStats.map((row) => [String(row.stats?.solverAddress ?? '').toLowerCase(), row.reputation])
  );
  const paidMilestones = new Set(
    payments
      .filter((payment) => payment.milestoneKey)
      .map((payment) => payment.milestoneKey as string)
  );

  return (
    <>
      <header>
        <Link href="/" className="button secondary">Back</Link>
        <h1>{workOrder.title}</h1>
        <p>{workOrder.id}</p>
        <LiveRefresher workOrderId={workOrder.id} />
      </header>

      <section className="grid two">
        <div className="card">
          <h3>Status</h3>
          <p className="badge">{workOrder.status}</p>
          <p>Template: {workOrder.templateType}</p>
          <p>Bounty: {workOrder.bounty.amount} {workOrder.bounty.currency}</p>
          <p>Bidding ends: {new Date(workOrder.bidding.biddingEndsAt).toLocaleTimeString()}</p>
          {workOrder.status === 'BIDDING' ? (
            <div className="section">
              <SelectBestQuoteButton
                workOrderId={workOrder.id}
                biddingEndsAt={workOrder.bidding.biddingEndsAt}
              />
            </div>
          ) : null}
          <p>Challenge: {workOrder.challenge?.status ?? 'n/a'}</p>
          {workOrder.deadlines?.challengeEndsAt ? (
            <p>Challenge ends: {new Date(workOrder.deadlines.challengeEndsAt).toLocaleTimeString()}</p>
          ) : null}
          {workOrder.deadlines?.patchEndsAt ? (
            <p>Patch ends: {new Date(workOrder.deadlines.patchEndsAt).toLocaleTimeString()}</p>
          ) : null}
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
          <p>Selected at: {workOrder.selection.selectedAt ? new Date(workOrder.selection.selectedAt).toLocaleTimeString() : 'n/a'}</p>
          <p>Yellow session: {workOrder.yellow.yellowSessionId ?? 'n/a'}</p>
          <p>Settlement: {workOrder.yellow.settlementTxId ?? 'n/a'}</p>
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
                  <p>Reputation: {reputationMap.get(quote.solverAddress.toLowerCase())?.score ?? 'n/a'}</p>
                  {quote.id === workOrder.selection.selectedQuoteId ? <p className="badge">Selected</p> : null}
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
              {report.proof.txIds.length > 0 ? (
                <div className="grid">
                  {report.proof.txIds.map((tx) => (
                    <div key={tx} className="card">
                      <p>{tx.slice(0, 12)}...</p>
                    </div>
                  ))}
                </div>
              ) : null}
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
                  {payment.milestoneKey ? <p>{payment.milestoneKey}</p> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="card">
          <h3>Milestones</h3>
          <div className="grid">
            {workOrder.milestones.payoutSchedule.map((milestone) => (
              <div key={milestone.key} className="card">
                <p>{milestone.key}</p>
                <p>{milestone.percent}%</p>
                <p>{paidMilestones.has(milestone.key) ? 'Paid' : 'Pending'}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
