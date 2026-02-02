import fs from 'node:fs';
import path from 'node:path';

export type WorkOrderEvent = {
  id: string;
  workOrderId: string;
  type: string;
  createdAt: number;
  payload: unknown;
};

export class EventBus {
  private listeners = new Map<string, Set<(event: WorkOrderEvent) => void>>();
  private logPath: string | null;

  constructor(logPath?: string) {
    this.logPath = logPath ?? null;
    if (this.logPath) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    }
  }

  subscribe(workOrderId: string, handler: (event: WorkOrderEvent) => void) {
    const set = this.listeners.get(workOrderId) ?? new Set();
    set.add(handler);
    this.listeners.set(workOrderId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(workOrderId);
    };
  }

  emit(event: WorkOrderEvent) {
    if (this.logPath) {
      fs.appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, 'utf8');
    }
    const set = this.listeners.get(event.workOrderId);
    if (!set) return;
    for (const handler of set) handler(event);
  }
}
