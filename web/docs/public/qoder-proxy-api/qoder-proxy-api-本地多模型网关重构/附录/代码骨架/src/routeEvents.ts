// 路由事件：网关"正在做的决定"。控制台路由页、用量统计、日志都只消费这一种语言。
// 规则：事件里不放 prompt / 回复正文 / Key，只放路由元数据。

export type MemberRef = { providerId: string; model: string };
export type CandidateState = "ready" | "resting" | "skipped";

export type RouteEvent =
  | { type: "request.start"; requestId: string; at: number; agent: string; alias: string; groupId: string | null; protocol: string }
  | {
      type: "route.decision";
      requestId: string;
      at: number;
      strategy: "ordered" | "smart" | "direct";
      candidates: Array<MemberRef & { state: CandidateState; reason: string; restUntil?: number }>;
    }
  | { type: "upstream.attempt"; requestId: string; at: number; member: MemberRef; attempt: number }
  | { type: "upstream.firstByte"; requestId: string; at: number; member: MemberRef; ms: number }
  | {
      type: "upstream.failed";
      requestId: string;
      at: number;
      member: MemberRef;
      code: string;
      status?: number;
      restUntil?: number;
      reroutable: boolean;
    }
  | { type: "reroute"; requestId: string; at: number; from: MemberRef; to: MemberRef; reason: string }
  | {
      type: "request.end";
      requestId: string;
      at: number;
      outcome: "ok" | "error" | "cancelled";
      member: MemberRef | null;
      ms: number;
      reroutes: number;
      errorCode?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };

export type Listener = (event: RouteEvent & { seq: number }) => void;

// 有界环形缓冲 + 订阅：/admin/events 连上时先回放最近 N 条（Last-Event-ID 续传），再推实时。
export class RouteEventBus {
  #seq = 0;
  #ring: Array<RouteEvent & { seq: number }> = [];
  #capacity: number;
  #listeners = new Set<Listener>();
  constructor(capacity = 500) {
    this.#capacity = capacity;
  }
  emit(event: RouteEvent): void {
    const stamped = { ...event, seq: ++this.#seq };
    this.#ring.push(stamped);
    if (this.#ring.length > this.#capacity) this.#ring.shift();
    for (const listener of this.#listeners) {
      try {
        listener(stamped);
      } catch {
        // 订阅方异常不能影响数据面。
      }
    }
  }
  since(seq: number): Array<RouteEvent & { seq: number }> {
    return this.#ring.filter((e) => e.seq > seq);
  }
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
