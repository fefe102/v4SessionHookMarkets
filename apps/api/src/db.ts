import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const dataDir = process.env.V4SHM_DATA_DIR
  ? path.resolve(repoRoot, process.env.V4SHM_DATA_DIR)
  : path.join(repoRoot, 'data');

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'app.sqlite');

export type WorkOrderRecord = {
  id: string;
  createdAt: number;
  status: string;
  payload: unknown;
};

export type QuoteRecord = {
  id: string;
  workOrderId: string;
  createdAt: number;
  payload: unknown;
};

export type SubmissionRecord = {
  id: string;
  workOrderId: string;
  createdAt: number;
  payload: unknown;
};

export type VerificationReportRecord = {
  id: string;
  submissionId: string;
  createdAt: number;
  status: string;
  payload: unknown;
};

export type PaymentEventRecord = {
  id: string;
  workOrderId: string;
  createdAt: number;
  type: string;
  payload: unknown;
};

export type SolverStatsRecord = {
  solverAddress: string;
  payload: unknown;
};

export function createDb() {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_orders (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS work_orders_status_idx
      ON work_orders(status);

    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS quotes_work_order_idx
      ON quotes(work_order_id);

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS submissions_work_order_idx
      ON submissions(work_order_id);

    CREATE TABLE IF NOT EXISTS verification_reports (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS verification_reports_submission_idx
      ON verification_reports(submission_id);

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS payment_events_work_order_idx
      ON payment_events(work_order_id);

    CREATE TABLE IF NOT EXISTS solver_stats (
      solver_address TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
  `);

  const insertWorkOrderStmt = db.prepare(
    'INSERT INTO work_orders (id, created_at, status, payload_json) VALUES (?, ?, ?, ?)'
  );
  const updateWorkOrderStmt = db.prepare(
    'UPDATE work_orders SET status = ?, payload_json = ? WHERE id = ?'
  );
  const getWorkOrderStmt = db.prepare(
    'SELECT id, created_at, status, payload_json FROM work_orders WHERE id = ?'
  );
  const listWorkOrdersStmt = db.prepare(
    'SELECT id, created_at, status, payload_json FROM work_orders ORDER BY created_at DESC'
  );
  const listWorkOrdersByStatusStmt = db.prepare(
    'SELECT id, created_at, status, payload_json FROM work_orders WHERE status = ? ORDER BY created_at DESC'
  );

  const insertQuoteStmt = db.prepare(
    'INSERT INTO quotes (id, work_order_id, created_at, payload_json) VALUES (?, ?, ?, ?)'
  );
  const listQuotesStmt = db.prepare(
    'SELECT id, work_order_id, created_at, payload_json FROM quotes WHERE work_order_id = ? ORDER BY created_at ASC'
  );

  const insertSubmissionStmt = db.prepare(
    'INSERT INTO submissions (id, work_order_id, created_at, payload_json) VALUES (?, ?, ?, ?)'
  );
  const listSubmissionsStmt = db.prepare(
    'SELECT id, work_order_id, created_at, payload_json FROM submissions WHERE work_order_id = ? ORDER BY created_at ASC'
  );

  const insertVerificationReportStmt = db.prepare(
    'INSERT INTO verification_reports (id, submission_id, created_at, status, payload_json) VALUES (?, ?, ?, ?, ?)'
  );
  const getVerificationReportBySubmissionStmt = db.prepare(
    'SELECT id, submission_id, created_at, status, payload_json FROM verification_reports WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1'
  );
  const getVerificationReportByIdStmt = db.prepare(
    'SELECT id, submission_id, created_at, status, payload_json FROM verification_reports WHERE id = ? LIMIT 1'
  );

  const insertPaymentEventStmt = db.prepare(
    'INSERT INTO payment_events (id, work_order_id, created_at, type, payload_json) VALUES (?, ?, ?, ?, ?)'
  );
  const listPaymentEventsStmt = db.prepare(
    'SELECT id, work_order_id, created_at, type, payload_json FROM payment_events WHERE work_order_id = ? ORDER BY created_at ASC'
  );

  const upsertSolverStatsStmt = db.prepare(
    'INSERT INTO solver_stats (solver_address, payload_json) VALUES (?, ?) ON CONFLICT(solver_address) DO UPDATE SET payload_json = excluded.payload_json'
  );
  const getSolverStatsStmt = db.prepare(
    'SELECT solver_address, payload_json FROM solver_stats WHERE solver_address = ? LIMIT 1'
  );
  const listSolverStatsStmt = db.prepare(
    'SELECT solver_address, payload_json FROM solver_stats ORDER BY solver_address ASC'
  );

  return {
    insertWorkOrder(record: WorkOrderRecord) {
      insertWorkOrderStmt.run(
        record.id,
        record.createdAt,
        record.status,
        JSON.stringify(record.payload)
      );
    },
    updateWorkOrder(record: WorkOrderRecord) {
      updateWorkOrderStmt.run(record.status, JSON.stringify(record.payload), record.id);
    },
    getWorkOrder(id: string): WorkOrderRecord | null {
      const row = getWorkOrderStmt.get(id) as
        | { id: string; created_at: number; status: string; payload_json: string }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        payload: JSON.parse(row.payload_json),
      };
    },
    listWorkOrders(status?: string): WorkOrderRecord[] {
      const rows = (status ? listWorkOrdersByStatusStmt.all(status) : listWorkOrdersStmt.all()) as Array<{
        id: string;
        created_at: number;
        status: string;
        payload_json: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        payload: JSON.parse(row.payload_json),
      }));
    },
    insertQuote(record: QuoteRecord) {
      insertQuoteStmt.run(
        record.id,
        record.workOrderId,
        record.createdAt,
        JSON.stringify(record.payload)
      );
    },
    listQuotes(workOrderId: string): QuoteRecord[] {
      const rows = listQuotesStmt.all(workOrderId) as Array<{
        id: string;
        work_order_id: string;
        created_at: number;
        payload_json: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        workOrderId: row.work_order_id,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload_json),
      }));
    },
    insertSubmission(record: SubmissionRecord) {
      insertSubmissionStmt.run(
        record.id,
        record.workOrderId,
        record.createdAt,
        JSON.stringify(record.payload)
      );
    },
    listSubmissions(workOrderId: string): SubmissionRecord[] {
      const rows = listSubmissionsStmt.all(workOrderId) as Array<{
        id: string;
        work_order_id: string;
        created_at: number;
        payload_json: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        workOrderId: row.work_order_id,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload_json),
      }));
    },
    insertVerificationReport(record: VerificationReportRecord) {
      insertVerificationReportStmt.run(
        record.id,
        record.submissionId,
        record.createdAt,
        record.status,
        JSON.stringify(record.payload)
      );
    },
    getVerificationReportBySubmission(submissionId: string): VerificationReportRecord | null {
      const row = getVerificationReportBySubmissionStmt.get(submissionId) as
        | {
            id: string;
            submission_id: string;
            created_at: number;
            status: string;
            payload_json: string;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        submissionId: row.submission_id,
        createdAt: row.created_at,
        status: row.status,
        payload: JSON.parse(row.payload_json),
      };
    },
    getVerificationReportById(reportId: string): VerificationReportRecord | null {
      const row = getVerificationReportByIdStmt.get(reportId) as
        | {
            id: string;
            submission_id: string;
            created_at: number;
            status: string;
            payload_json: string;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        submissionId: row.submission_id,
        createdAt: row.created_at,
        status: row.status,
        payload: JSON.parse(row.payload_json),
      };
    },
    insertPaymentEvent(record: PaymentEventRecord) {
      insertPaymentEventStmt.run(
        record.id,
        record.workOrderId,
        record.createdAt,
        record.type,
        JSON.stringify(record.payload)
      );
    },
    listPaymentEvents(workOrderId: string): PaymentEventRecord[] {
      const rows = listPaymentEventsStmt.all(workOrderId) as Array<{
        id: string;
        work_order_id: string;
        created_at: number;
        type: string;
        payload_json: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        workOrderId: row.work_order_id,
        createdAt: row.created_at,
        type: row.type,
        payload: JSON.parse(row.payload_json),
      }));
    },
    upsertSolverStats(record: SolverStatsRecord) {
      upsertSolverStatsStmt.run(record.solverAddress, JSON.stringify(record.payload));
    },
    getSolverStats(solverAddress: string): SolverStatsRecord | null {
      const row = getSolverStatsStmt.get(solverAddress) as
        | { solver_address: string; payload_json: string }
        | undefined;
      if (!row) return null;
      return {
        solverAddress: row.solver_address,
        payload: JSON.parse(row.payload_json),
      };
    },
    listSolverStats(): SolverStatsRecord[] {
      const rows = listSolverStatsStmt.all() as Array<{
        solver_address: string;
        payload_json: string;
      }>;
      return rows.map((row) => ({
        solverAddress: row.solver_address,
        payload: JSON.parse(row.payload_json),
      }));
    },
  };
}
