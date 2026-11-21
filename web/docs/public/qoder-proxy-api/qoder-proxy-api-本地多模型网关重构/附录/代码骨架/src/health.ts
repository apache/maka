// 上游健康簿：每个 (providerId, model) 一条。决定"歇多久"和"能不能改道"。
// 规则借鉴 magpie reference.md「When an account runs out」，但只作用于**不同供应商/不同 Key**，
// 不做同服务多账号轮换（见 ADR-0006）。
import { ERROR_CODES } from "./events.ts";
import type { ProviderError } from "./events.ts";
import type { MemberRef } from "./routeEvents.ts";

const SEC = 1000;
const MIN = 60 * SEC;

export interface Verdict {
  reroutable: boolean; // 首字节前是否允许换下一个候选
  restMs: number; // 0 = 不歇
  reason: string; // 给人看的中文原因，直接进路由事件
}

// 纯函数，方便单测与在 04-测试 里列表格。
export function classify(error: ProviderError, strikes: number): Verdict {
  switch (error.code) {
    case ERROR_CODES.PROVIDER_RATE_LIMITED: {
      const asked = error.retryAfterMs;
      const restMs = asked && asked > 0 ? Math.min(asked, 60 * MIN) : Math.min(MIN * 2 ** strikes, 30 * MIN);
      return { reroutable: true, restMs, reason: `限流 · ${Math.ceil(restMs / SEC)} 秒后恢复` };
    }
    case ERROR_CODES.PROVIDER_AUTH_ERROR:
      return { reroutable: true, restMs: 30 * MIN, reason: "Key 被拒（401/403），请到供应商页检查" };
    case ERROR_CODES.MODEL_NOT_FOUND:
      return { reroutable: true, restMs: 10 * MIN, reason: "该供应商不提供这个模型" };
    case ERROR_CODES.PROVIDER_UNAVAILABLE:
    case ERROR_CODES.PROVIDER_TIMEOUT:
    case ERROR_CODES.PROVIDER_PROTOCOL_ERROR: {
      const restMs = Math.min(MIN * 2 ** strikes, 10 * MIN);
      return { reroutable: true, restMs, reason: `上游不可用 · 歇 ${Math.ceil(restMs / SEC)} 秒` };
    }
    case ERROR_CODES.PROVIDER_REJECTED:
    case ERROR_CODES.UNSUPPORTED_CAPABILITY:
      return { reroutable: false, restMs: 0, reason: "请求本身被拒，换谁都一样，不改道" };
    case ERROR_CODES.PROVIDER_ABORTED:
    default:
      return { reroutable: false, restMs: 0, reason: "客户端已取消" };
  }
}

interface Entry {
  restUntil: number;
  strikes: number;
  reason: string;
  ewmaFirstByteMs: number | null;
  inflight: number;
  ok: number;
  failed: number;
}

export function memberKey(m: MemberRef): string {
  return `${m.providerId}/${m.model}`;
}

export class HealthBook {
  #now: () => number;
  #entries = new Map<string, Entry>();
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  #get(m: MemberRef): Entry {
    const key = memberKey(m);
    let e = this.#entries.get(key);
    if (!e) {
      e = { restUntil: 0, strikes: 0, reason: "", ewmaFirstByteMs: null, inflight: 0, ok: 0, failed: 0 };
      this.#entries.set(key, e);
    }
    return e;
  }
  now(): number {
    return this.#now();
  }
  restingUntil(m: MemberRef): number | null {
    const e = this.#get(m);
    return e.restUntil > this.#now() ? e.restUntil : null;
  }
  reason(m: MemberRef): string {
    return this.#get(m).reason;
  }
  stats(m: MemberRef): Readonly<Entry> {
    return { ...this.#get(m) };
  }
  begin(m: MemberRef): void {
    this.#get(m).inflight++;
  }
  end(m: MemberRef): void {
    const e = this.#get(m);
    e.inflight = Math.max(0, e.inflight - 1);
  }
  firstByte(m: MemberRef, ms: number): void {
    const e = this.#get(m);
    e.ewmaFirstByteMs = e.ewmaFirstByteMs == null ? ms : Math.round(e.ewmaFirstByteMs * 0.7 + ms * 0.3);
  }
  success(m: MemberRef): void {
    const e = this.#get(m);
    e.ok++;
    e.strikes = 0;
    e.restUntil = 0;
    e.reason = "";
  }
  failure(m: MemberRef, error: ProviderError): Verdict & { restUntil?: number } {
    const e = this.#get(m);
    const verdict = classify(error, e.strikes);
    if (verdict.restMs > 0) {
      e.failed++;
      e.strikes++;
      e.restUntil = this.#now() + verdict.restMs;
      e.reason = verdict.reason;
      return { ...verdict, restUntil: e.restUntil };
    }
    return verdict;
  }
  // 用户在控制台点"立即恢复"或改了 Key 时调用。
  reset(m: MemberRef): void {
    this.#entries.delete(memberKey(m));
  }
}
