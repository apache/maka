/**
 * workflow 域进程内事件总线（原 EventService HTTP POST → gateway /internal/events 的单进程降栈）
 * SSE 端点订阅 emit；保留全部历史供重放（原版 gateway events 路由语义）。
 */

export interface WorkflowEvent {
  type: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: string;
}

type Listener = (event: WorkflowEvent) => void;

const g = globalThis as typeof globalThis & {
  __workflowEvents?: { seq: number; history: WorkflowEvent[]; listeners: Set<Listener> };
};

function bus() {
  if (!g.__workflowEvents) {
    g.__workflowEvents = { seq: 0, history: [], listeners: new Set() };
  }
  return g.__workflowEvents;
}

export function emit(type: string, data: Record<string, unknown>): WorkflowEvent {
  const b = bus();
  const event: WorkflowEvent = { type, data, seq: ++b.seq, timestamp: new Date().toISOString() };
  b.history.push(event);
  if (b.history.length > 1000) b.history.splice(0, b.history.length - 1000);
  for (const l of b.listeners) {
    try {
      l(event);
    } catch {
      // 单个订阅者异常不阻断广播
    }
  }
  return event;
}

export function subscribe(listener: Listener): () => void {
  bus().listeners.add(listener);
  return () => bus().listeners.delete(listener);
}

export function history(afterSeq = 0, limit = 200): WorkflowEvent[] {
  return bus()
    .history.filter((e) => e.seq > afterSeq)
    .slice(-limit);
}
