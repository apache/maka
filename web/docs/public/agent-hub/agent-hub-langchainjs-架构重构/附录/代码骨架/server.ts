// HTTP 层（apps/agent/src/server.ts 的骨架）：node:http，无框架。
// 路由：POST /api/agent/chat（SSE）、GET /api/evidence/:id、GET /healthz。
// 帧格式与旧 FastAPI 完全一致：`event: <type>\ndata: <单行 JSON>\n\n`。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildAgent, runTurn } from './agent.ts';
import { EVIDENCE } from './data.ts';
import { ScriptedChatModel } from './scripted-model.ts';
import { floraPolicy } from './scripts.ts';
import type { AgentStreamEvent } from './contracts.ts';

// 契约草案：ChatRequest 进入 packages/shared/contracts.ts（ADR-0005）
export const ChatRequest = z.object({ message: z.string().trim().min(1).max(2000), threadId: z.string().min(8).max(64).optional() });

export const frame = (e: AgentStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`; // JSON.stringify 不产生换行 → 天然单行

async function pickModel(): Promise<BaseChatModel> {
  if (!process.env.OPENAI_API_KEY) return new ScriptedChatModel(floraPolicy, { delayMs: 40 }); // 离线剧本：与真实模型走同一张图
  const { createChatModel } = await import('./llm.ts'); // 真实模型：provider 表 → ChatOpenAI（WP3）
  return createChatModel();
}

export async function startServer(port = Number(process.env.AGENT_PORT ?? 8809)) {
  const agent = buildAgent({ model: await pickModel() });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return void res.end('ok');
    const ev = url.pathname.match(/^\/api\/evidence\/([\w-]+)$/);
    if (req.method === 'GET' && ev) {
      const hit = EVIDENCE[ev[1]];
      res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(JSON.stringify(hit ?? { detail: 'evidence not found' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/chat') {
      let body: unknown;
      try { body = JSON.parse(await new Response(req as never).text()); } catch { body = undefined; }
      const parsed = ChatRequest.safeParse(body);
      if (!parsed.success) { res.writeHead(422, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ detail: parsed.error.issues })); }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // 浏览器断开 → 中止模型调用（不再计费）
      const threadId = parsed.data.threadId ?? randomUUID(); // 不带 threadId = 单轮（与旧行为一致）
      for await (const e of runTurn(agent, { message: parsed.data.message, threadId }, ac.signal)) {
        if (ac.signal.aborted) break;
        res.write(frame(e));
      }
      return void res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

if (import.meta.main) {
  try { process.loadEnvFile(); } catch { /* 没有 .env 就走离线剧本 */ }
  const s = await startServer();
  console.log(`agent listening on http://127.0.0.1:${(s.address() as { port: number }).port}`);
}
