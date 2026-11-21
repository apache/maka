// 最小网关进程：/v1/chat/completions（含工具调用的完整出口，示范 Q-P0-1 修法）+ /admin/*（控制台用）。
// 真实落地时：数据面逻辑在 qoder 的 protocols/* 与 server/server.ts，这里只演示管线如何接进去。
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ERROR_CODES, ProviderError } from "./events.ts";
import type { CanonicalMessage, CanonicalRequest } from "./events.ts";
import { httpStatusOf, peekFirst, routeStream } from "./pipeline.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { memberKey } from "./health.ts";

export interface GatewayOptions {
  agentKeys: Record<string, string>; // 下游 Key → agent id（Agent 接入时由配置写入器生成）
  adminToken: string; // /admin/* 专用，和下游 Key 分开
  maxBodyBytes?: number;
  devCorsOrigin?: string; // 仅开发：控制台 dev server 跨源访问 /admin/*。产品形态同源托管 /ui，不开 CORS
}

async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("invalid json"), { status: 400 });
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// 入口：保留工具历史与图片（Q-P0-2 修法示意）。
export function chatToCanonical(body: any): CanonicalRequest {
  const system = body.messages?.filter((m: any) => m.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : "")).join("\n");
  const messages: CanonicalMessage[] = (body.messages ?? [])
    .filter((m: any) => m.role !== "system")
    .map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" || m.content == null
        ? m.content ?? ""
        : m.content.map((p: any) => (p.type === "image_url" ? { type: "image", source: p.image_url } : { type: "text", text: p.text ?? "" })),
      toolCallId: m.tool_call_id,
      toolCalls: m.tool_calls?.map((c: any) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    }));
  return {
    model: String(body.model ?? "default"),
    system: system || undefined,
    messages,
    tools: body.tools?.map((t: any) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters ?? {} })),
    maxTokens: body.max_tokens,
  };
}

export function createGatewayServer(deps: PipelineDeps, opts: GatewayOptions) {
  const limit = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    if (opts.devCorsOrigin) {
      res.setHeader("access-control-allow-origin", opts.devCorsOrigin);
      res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    try {
      if (url.pathname.startsWith("/admin/")) {
        // 控制台同源托管在 /ui；admin token 走 header 或 EventSource 不支持 header 时走 ?token=
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
        if (token !== opts.adminToken) return json(res, 401, { error: "admin token required" });
        return admin(req, res, url, deps);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const agent = opts.agentKeys[key];
        if (!agent) return json(res, 401, { error: { message: "unknown key", type: "authentication_error" } });
        const body = await readJson(req, limit);
        const request = chatToCanonical(body);
        const stream = routeStream(request, {
          requestId: `req_${randomUUID().slice(0, 8)}`,
          agent,
          protocol: "chat",
          conversationId: req.headers["x-session-id"] ? String(req.headers["x-session-id"]) : undefined,
          signal: controller.signal,
        }, deps);
        return writeChat(res, request.model, stream, Boolean(body.stream));
      }
      json(res, 404, { error: "not found" });
    } catch (error: any) {
      if (!res.headersSent) json(res, error?.status ?? 500, { error: { message: error?.message ?? "internal error" } });
      else res.end();
    }
  });
}

async function writeChat(res: ServerResponse, model: string, stream: AsyncIterable<any>, streaming: boolean) {
  const { first, rest } = await peekFirst(stream);
  if (first?.type === "error") {
    const { status, retryAfterSec } = httpStatusOf(first.error);
    return json(res, status, { error: { message: first.error.message, code: first.error.code } }, retryAfterSec ? { "retry-after": String(retryAfterSec) } : {});
  }
  const id = `chatcmpl_${randomUUID().slice(0, 8)}`;
  const chunk = (delta: any, finish: string | null = null) => ({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const events = (async function* () { if (first) yield first; while (true) { const s = await rest.next(); if (s.done) return; yield s.value; } })();
  if (!streaming) {
    let text = "";
    const calls: any[] = [];
    let finish = "stop";
    for await (const e of events) {
      if (e.type === "text.delta") text += e.text;
      else if (e.type === "tool.start") calls[e.index] = { id: e.id, type: "function", function: { name: e.name, arguments: "" } };
      else if (e.type === "tool.arguments.delta") calls[e.index].function.arguments += e.json;
      else if (e.type === "message.end") finish = e.stopReason === "tool_use" ? "tool_calls" : e.stopReason === "length" ? "length" : "stop";
      else if (e.type === "error") return json(res, 502, { error: { message: e.error.message, code: e.error.code } });
    }
    return json(res, 200, { id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }] });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const write = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  write(chunk({ role: "assistant" }));
  for await (const e of events) {
    if (e.type === "text.delta") write(chunk({ content: e.text }));
    else if (e.type === "thinking.delta") write(chunk({ reasoning_content: e.text }));
    else if (e.type === "tool.start") write(chunk({ tool_calls: [{ index: e.index, id: e.id, type: "function", function: { name: e.name, arguments: "" } }] }));
    else if (e.type === "tool.arguments.delta") write(chunk({ tool_calls: [{ index: e.index, function: { arguments: e.json } }] }));
    else if (e.type === "message.end") write(chunk({}, e.stopReason === "tool_use" ? "tool_calls" : e.stopReason === "length" ? "length" : "stop"));
    else if (e.type === "error") write({ error: { message: e.error.message, code: e.error.code } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function admin(req: IncomingMessage, res: ServerResponse, url: URL, deps: PipelineDeps) {
  if (req.method === "GET" && url.pathname === "/admin/state") {
    const now = deps.health.now();
    return json(res, 200, {
      now,
      providers: [...deps.providers.values()].map((p) => ({ id: p.id, kind: p.kind, label: p.label, capabilities: p.capabilities() })),
      groups: [...deps.groups.values()].map((g) => ({
        ...g,
        members: g.members.map((m) => ({ ...m, restUntil: deps.health.restingUntil(m), reason: deps.health.reason(m), stats: deps.health.stats(m) })),
      })),
    });
  }
  if (req.method === "GET" && url.pathname === "/admin/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const last = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
    const send = (e: { seq: number }) => res.write(`id: ${e.seq}\nevent: route\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of deps.bus.since(last)) send(e);
    const off = deps.bus.subscribe(send);
    const beat = setInterval(() => res.write(`: ping\n\n`), 15_000); // 心跳（Q-P1-3）
    res.on("close", () => { off(); clearInterval(beat); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/admin/health/reset") {
    const providerId = url.searchParams.get("providerId") ?? "";
    const model = url.searchParams.get("model") ?? "";
    deps.health.reset({ providerId, model });
    return json(res, 200, { ok: true, member: memberKey({ providerId, model }) });
  }
  json(res, 404, { error: "not found" });
}

export { ProviderError, ERROR_CODES };
