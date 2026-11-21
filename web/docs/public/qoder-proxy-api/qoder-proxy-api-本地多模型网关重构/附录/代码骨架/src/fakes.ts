// 测试与演示用的脚本化 Provider：按顺序消费"剧本"，每次 stream 调用取下一幕。
import { ERROR_CODES, ProviderError } from "./events.ts";
import type { GatewayProvider, ProviderEvent, Capabilities } from "./events.ts";

export type Act =
  | { kind: "ok"; text: string; delayMs?: number }
  | { kind: "fail"; code: keyof typeof ERROR_CODES; retryAfterMs?: number; delayMs?: number }
  | { kind: "failAfter"; text: string; code: keyof typeof ERROR_CODES } // 已输出部分内容后失败
  | { kind: "hang" }; // 一直不回，直到 signal 中止

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "aborted"));
    }, { once: true });
  });

export function scripted(id: string, acts: Act[] | (() => Act), caps: Partial<Capabilities> = {}): GatewayProvider & { calls: string[] } {
  const queue = Array.isArray(acts) ? [...acts] : null;
  const calls: string[] = [];
  return {
    id,
    kind: "openai-compatible",
    label: id,
    calls,
    capabilities: () => ({ tools: true, vision: false, thinking: false, ...caps }),
    listModels: async () => [{ id: "m" }],
    async *stream(request, context): AsyncGenerator<ProviderEvent> {
      calls.push(request.model);
      const act = queue ? queue.shift() ?? { kind: "ok", text: "default" } : (acts as () => Act)();
      if ("delayMs" in act && act.delayMs) await sleep(act.delayMs, context.signal);
      yield { type: "message.start" };
      if (act.kind === "hang") {
        await sleep(10 ** 9, context.signal);
        return;
      }
      if (act.kind === "fail") throw new ProviderError(ERROR_CODES[act.code], `${id} failed: ${act.code}`, { retryAfterMs: act.retryAfterMs });
      for (const word of act.text.split(" ")) yield { type: "text.delta", text: word + " " };
      if (act.kind === "failAfter") throw new ProviderError(ERROR_CODES[act.code], `${id} broke mid-stream`);
      yield { type: "usage", inputTokens: 100, outputTokens: act.text.length };
      yield { type: "message.end", stopReason: "stop" };
    },
  };
}
