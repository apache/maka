import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatibleProvider, parseRetryAfter, toOpenAiBody } from "../src/openaiCompatible.ts";
import { createGatewayServer } from "../src/gatewayServer.ts";
import { collect, ctx, req, setup } from "./helpers.ts";

// 假上游：按路径前缀决定行为。/ok 正常（含 reasoning + 分片工具调用 + 空 choices usage），/limited 429，/denied 401
const seen: any[] = [];
const upstream = http.createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  seen.push({ path: rq.url, auth: rq.headers.authorization, body: JSON.parse(raw) });
  if (rq.url!.startsWith("/limited")) { rs.writeHead(429, { "retry-after": "7" }); return rs.end("slow down"); }
  if (rq.url!.startsWith("/denied")) { rs.writeHead(401); return rs.end("bad key"); }
  rs.writeHead(200, { "content-type": "text/event-stream" });
  const send = (o: unknown) => rs.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ choices: [{ delta: { role: "assistant", reasoning_content: "想一想" } }] });
  send({ choices: [{ delta: { content: "查一下天气" } }] });
  send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] } }] });
  rs.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] })}\r\n\r\n`); // CRLF 分帧
  send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"杭州\"}" } }] }, finish_reason: "tool_calls" }] });
  send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });
  rs.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => upstream.close());

const provider = (id: string, path: string) => createOpenAICompatibleProvider({ id, label: id, baseUrl: `${base}/${path}`, apiKey: `sk-${id}`, models: ["m"] });

test("SSE → Canonical：思考、正文、分片工具调用、finish_reason、空 choices usage", async () => {
  const events = await collect(provider("deepseek", "ok").stream(req("deepseek-chat"), ctx()));
  assert.deepEqual(events, [
    { type: "message.start" },
    { type: "thinking.delta", text: "想一想" },
    { type: "text.delta", text: "查一下天气" },
    { type: "tool.start", index: 0, id: "call_1", name: "get_weather" },
    { type: "tool.arguments.delta", index: 0, json: '{"city":' },
    { type: "tool.arguments.delta", index: 0, json: '"杭州"}' },
    { type: "usage", inputTokens: 12, outputTokens: 5 },
    { type: "tool.end", index: 0 },
    { type: "message.end", stopReason: "tool_use" },
  ]);
  assert.equal(seen.at(-1).auth, "Bearer sk-deepseek");
});

test("HTTP 错误映射：429 带 Retry-After、401", async () => {
  await assert.rejects(collect(provider("kimi", "limited").stream(req("m"), ctx())), (e: any) => e.code === "PROVIDER_RATE_LIMITED" && e.retryAfterMs === 7000);
  await assert.rejects(collect(provider("glm", "denied").stream(req("m"), ctx())), (e: any) => e.code === "PROVIDER_AUTH_ERROR");
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
});

test("Canonical → OpenAI body：工具历史与图片不丢（Q-P0-2）", () => {
  const body: any = toOpenAiBody({
    model: "m",
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", source: { url: "data:image/png;base64,AA" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "42" },
    ],
    tools: [{ name: "f", inputSchema: { type: "object" } }],
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.equal(body.messages[2].tool_calls[0].function.name, "f");
  assert.equal(body.messages[2].content, null);
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "42" });
  assert.equal(body.tools[0].function.parameters.type, "object");
});

test("端到端：Codex → 网关 group/daily → Kimi 429 → 改道 DeepSeek，工具调用完整下发；路由事件可从 /admin/events 回放", async () => {
  const kimi = provider("kimi", "limited");
  const deepseek = provider("deepseek", "ok");
  const { deps } = setup([kimi, deepseek], [{ id: "daily", name: "Daily coding", strategy: "ordered", enabled: true, members: [{ providerId: "kimi", model: "kimi-k2" }, { providerId: "deepseek", model: "deepseek-chat" }] }]);
  const gw = createGatewayServer(deps, { agentKeys: { "qpa-codex-local": "codex" }, adminToken: "admin-secret" });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  const gwBase = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${gwBase}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer qpa-codex-local", "content-type": "application/json" },
      body: JSON.stringify({ model: "group/daily", stream: true, messages: [{ role: "user", content: "杭州天气" }], tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }] }),
    });
    assert.equal(r.status, 200);
    const sse = await r.text();
    assert.match(sse, /"reasoning_content":"想一想"/);
    assert.match(sse, /"name":"get_weather"/);
    assert.match(sse, /"finish_reason":"tool_calls"/);
    assert.ok(sse.trim().endsWith("data: [DONE]"));

    // 没带下游 Key → 401
    const unauthorized = await fetch(`${gwBase}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);

    const ac = new AbortController();
    const ev = await fetch(`${gwBase}/admin/events?token=admin-secret`, { signal: ac.signal });
    const reader = ev.body!.getReader();
    let text = "";
    while (!text.includes('"type":"request.end"')) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const types = [...text.matchAll(/"type":"([a-zA-Z.]+)"/g)].map((m) => m[1]);
    assert.deepEqual(types, ["request.start", "route.decision", "upstream.attempt", "upstream.failed", "reroute", "upstream.attempt", "upstream.firstByte", "request.end"]);
    assert.match(text, /"agent":"codex"/);
    assert.doesNotMatch(text, /杭州天气/, "路由事件不含 prompt");

    const state = await (await fetch(`${gwBase}/admin/state`, { headers: { authorization: "Bearer admin-secret" } })).json();
    assert.ok(state.groups[0].members[0].restUntil > state.now, "kimi 在歇");
    assert.equal((await fetch(`${gwBase}/admin/state`)).status, 401);
  } finally {
    gw.closeAllConnections();
    gw.close();
  }
});

test("请求体上限 → 413", async () => {
  const { deps } = setup([provider("deepseek", "ok")], []);
  const gw = createGatewayServer(deps, { agentKeys: { k: "codex" }, adminToken: "a", maxBodyBytes: 100 });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer k" }, body: "x".repeat(1000) });
    assert.equal(r.status, 413);
  } finally {
    gw.closeAllConnections();
    gw.close();
  }
});
