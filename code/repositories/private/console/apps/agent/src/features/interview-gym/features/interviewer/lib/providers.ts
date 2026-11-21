import type { ProviderConfig } from "@ig/state/store";
import { parseSSE } from "./sse";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  temperature?: number;
  maxTokens?: number;
}

// 六期并入适配：中继由独立 proxy.mjs（8787）改为 agent 应用内 route handler（单进程宪法），
// 同源 /api/interview-gym/relay，协议不变：x-llm-target 头指真实 Base URL。
const PROXY_ORIGIN = "/api/interview-gym";

// viaProxy 时走本地中继绕过 CORS：真实地址放 x-llm-target 头，中继不落盘任何 Key
function resolveRequest(cfg: ProviderConfig, path: string): { url: string; target?: string } {
  if (cfg.viaProxy) return { url: `${PROXY_ORIGIN}/relay${path}`, target: cfg.baseUrl };
  return { url: `${cfg.baseUrl}${path}` };
}

function headersFor(cfg: ProviderConfig, target?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target) headers["x-llm-target"] = target;
  if (cfg.kind === "anthropic") {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // 直连 Anthropic 必须显式允许浏览器调用；走中继时无害
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `LLM 请求失败（HTTP ${res.status}）：${text.slice(0, 300)}`;
}

async function openaiChat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const { url, target } = resolveRequest(cfg, "/chat/completions");
  const res = await fetch(url, {
    method: "POST",
    signal: opts.signal,
    headers: headersFor(cfg, target),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = "";
  for await (const data of parseSSE(res.body)) {
    try {
      const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = json.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        opts.onDelta?.(delta);
      }
    } catch {
      // 单行坏数据直接跳过，不打断整场会话
    }
  }
  return full;
}

async function anthropicChat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const { url, target } = resolveRequest(cfg, "/v1/messages");
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const res = await fetch(url, {
    method: "POST",
    signal: opts.signal,
    headers: headersFor(cfg, target),
    body: JSON.stringify({
      model: cfg.model,
      system: system || undefined,
      messages: rest,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
    }),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = "";
  for await (const data of parseSSE(res.body)) {
    try {
      const json = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
      const delta = json.type === "content_block_delta" ? (json.delta?.text ?? "") : "";
      if (delta) {
        full += delta;
        opts.onDelta?.(delta);
      }
    } catch {
      // 跳过坏行
    }
  }
  return full;
}

export async function chatCompletion(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!cfg.apiKey && cfg.baseUrl !== "http://localhost:11434/v1") {
    throw new Error(`「${cfg.label}」还没有填写 API Key，请到设置页补上`);
  }
  return cfg.kind === "anthropic"
    ? anthropicChat(cfg, messages, opts)
    : openaiChat(cfg, messages, opts);
}

// 设置页的「测试连接」：发一个极小请求验证 Key 与网络
export async function testProvider(cfg: ProviderConfig): Promise<string> {
  const text = await chatCompletion(cfg, [{ role: "user", content: "回复 OK 两个字母即可" }], {
    maxTokens: 8,
  });
  return text.trim().slice(0, 50) || "（空响应，但连通了）";
}
