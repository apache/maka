// 通用 OpenAI 兼容 Provider（DeepSeek / Kimi / GLM / 硅基流动 / 本地 vLLM、Ollama 等）。
// 只依赖 Node 24 全局 fetch。它是"跨供应商改道"的另一端：每个实例 = 一个供应商 + 一把 Key。
import { ERROR_CODES, ProviderError } from "./events.ts";
import type { Capabilities, CanonicalMessage, CanonicalRequest, GatewayProvider, ProviderContext, ProviderEvent } from "./events.ts";

export interface OpenAICompatibleOptions {
  id: string; // 例如 "deepseek"
  label: string; // 例如 "DeepSeek"
  baseUrl: string; // 例如 "https://api.deepseek.com/v1"
  apiKey: string;
  models: string[];
  capabilities?: Partial<Capabilities>;
  firstByteTimeoutMs?: number;
}

function toOpenAiMessage(m: CanonicalMessage): Record<string, unknown> {
  const content = typeof m.content === "string"
    ? m.content
    : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: p.source }));
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: typeof content === "string" && content ? content : null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content };
}

export function toOpenAiBody(request: CanonicalRequest): Record<string, unknown> {
  const messages = [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    ...request.messages.map(toOpenAiMessage),
  ];
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.tools?.length
      ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
      : {}),
  };
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function errorFromStatus(status: number, body: string, retryAfter: string | null): ProviderError {
  const msg = `upstream HTTP ${status}: ${body.slice(0, 200)}`;
  if (status === 401 || status === 403) return new ProviderError(ERROR_CODES.PROVIDER_AUTH_ERROR, msg, { status });
  if (status === 429) return new ProviderError(ERROR_CODES.PROVIDER_RATE_LIMITED, msg, { status, retryAfterMs: parseRetryAfter(retryAfter) });
  if (status === 404) return new ProviderError(ERROR_CODES.MODEL_NOT_FOUND, msg, { status });
  if (status === 400 || status === 422) return new ProviderError(ERROR_CODES.PROVIDER_REJECTED, msg, { status });
  if (status === 408 || status === 504) return new ProviderError(ERROR_CODES.PROVIDER_TIMEOUT, msg, { status });
  return new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, msg, { status });
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): GatewayProvider {
  const caps: Capabilities = { tools: true, vision: false, thinking: false, ...opts.capabilities };
  return {
    id: opts.id,
    kind: "openai-compatible",
    label: opts.label,
    capabilities: () => caps,
    listModels: async () => opts.models.map((id) => ({ id })),
    async *stream(request: CanonicalRequest, context: ProviderContext): AsyncGenerator<ProviderEvent> {
      let response: Response;
      // 只限制"等到响应头"的时间；流开始后不再计时（长回答可以跑很久）。
      const firstByte = new AbortController();
      const timer = setTimeout(() => firstByte.abort(new DOMException("first byte timeout", "TimeoutError")), opts.firstByteTimeoutMs ?? 60_000);
      try {
        response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(toOpenAiBody(request)),
          signal: AbortSignal.any([context.signal, firstByte.signal]),
        });
      } catch (error) {
        if (context.signal.aborted) throw new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "client aborted");
        const timeout = firstByte.signal.aborted;
        throw new ProviderError(timeout ? ERROR_CODES.PROVIDER_TIMEOUT : ERROR_CODES.PROVIDER_UNAVAILABLE, String(error), { cause: error });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok || !response.body) {
        throw errorFromStatus(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
      }
      yield { type: "message.start" };
      const open = new Map<number, boolean>();
      let stop: "stop" | "tool_use" | "length" = "stop";
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") break;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new ProviderError(ERROR_CODES.PROVIDER_PROTOCOL_ERROR, `bad SSE json: ${data.slice(0, 80)}`);
        }
        if (chunk.error) throw new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, String(chunk.error.message ?? "upstream error"));
        if (chunk.usage) yield { type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue; // 空 choices（include_usage 收尾块）
        const delta = choice.delta ?? {};
        if (delta.reasoning_content) yield { type: "thinking.delta", text: delta.reasoning_content };
        if (delta.content) yield { type: "text.delta", text: delta.content };
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          if (!open.has(index)) {
            open.set(index, true);
            yield { type: "tool.start", index, id: call.id ?? `call_${index}`, name: call.function?.name ?? "" };
          }
          if (call.function?.arguments) yield { type: "tool.arguments.delta", index, json: call.function.arguments };
        }
        if (choice.finish_reason) stop = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "length" : "stop";
      }
      for (const index of open.keys()) yield { type: "tool.end", index };
      yield { type: "message.end", stopReason: stop };
    },
  };
}
