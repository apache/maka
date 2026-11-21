// 与 qoder-proxy-api src/core/{events,errors}.ts 对齐的最小副本。
// 增量（见 02-接口契约 §1）：ProviderError 增加 retryAfterMs；新增 PROVIDER_REJECTED。

export const ERROR_CODES = Object.freeze({
  PROVIDER_AUTH_ERROR: "PROVIDER_AUTH_ERROR",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_PROTOCOL_ERROR: "PROVIDER_PROTOCOL_ERROR",
  PROVIDER_ABORTED: "PROVIDER_ABORTED",
  PROVIDER_REJECTED: "PROVIDER_REJECTED", // 新增：上游 400 / 安全拒答，属于"问题本身"，不改道
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
});
export type ProviderErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ProviderError extends Error {
  code: ProviderErrorCode;
  status: number | undefined;
  retryAfterMs: number | undefined;
  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export type StopReason = "stop" | "tool_use" | "length" | "cancelled";
export type ProviderEvent =
  | { type: "message.start"; id?: string }
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "tool.start"; index: number; id: string; name: string }
  | { type: "tool.arguments.delta"; index: number; json: string }
  | { type: "tool.end"; index: number }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "message.end"; stopReason: StopReason }
  | { type: "error"; error: ProviderError };

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: Record<string, unknown> }>;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}
export interface CanonicalRequest {
  model: string;
  system?: string;
  messages: CanonicalMessage[];
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  maxTokens?: number;
}
export interface ProviderContext {
  requestId: string;
  conversationId?: string;
  signal: AbortSignal;
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

// 契约增量：id 从 "gateway"|"cli"|"cloudAgents" 拓宽为 string，另加 kind。
export interface GatewayProvider {
  id: string;
  kind: "qoder-gateway" | "qoder-cli" | "qoder-cloudAgents" | "openai-compatible" | "anthropic-compatible";
  label: string;
  capabilities: () => Capabilities;
  listModels: () => Promise<Array<{ id: string }>>;
  stream: (request: CanonicalRequest, context: ProviderContext) => AsyncIterable<ProviderEvent>;
}

export function toProviderError(error: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "client aborted");
  if (error instanceof ProviderError) return error;
  return new ProviderError(
    ERROR_CODES.PROVIDER_UNAVAILABLE,
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
