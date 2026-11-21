// 演示：启动一个带假上游与自动流量的网关，供控制台原型 live 模式连接。
//   node src/demoServer.ts            → http://127.0.0.1:8320 ，admin token = demo
// 控制台：pnpm dev 后打开 http://localhost:5173/?live=http://127.0.0.1:8320&token=demo
import { HealthBook } from "./health.ts";
import { RouteEventBus } from "./routeEvents.ts";
import { scripted } from "./fakes.ts";
import type { Act } from "./fakes.ts";
import { parseRouteGroups } from "./routeGroups.ts";
import { routeStream } from "./pipeline.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { createGatewayServer } from "./gatewayServer.ts";

let kimiTurn = 0;
const ok = (text: string, delayMs: number): Act => ({ kind: "ok", text, delayMs });
const providers = [
  scripted("deepseek", () => ok("好的，我先读一下 src/routing/modelRouter.ts", 300 + Math.random() * 500), { thinking: true }),
  scripted("kimi", () => (++kimiTurn % 4 === 0 ? { kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 6000 } : ok("收到", 600)), { vision: true }),
  scripted("glm", () => ok("这里是 GLM 的回答", 500 + Math.random() * 900)),
  scripted("qoder", () => ok("Qoder 网关应答", 800)),
];
const groups = parseRouteGroups([
  { id: "daily-coding", name: "Daily coding", strategy: "smart", members: [{ providerId: "deepseek", model: "deepseek-chat" }, { providerId: "qoder", model: "auto" }, { providerId: "glm", model: "glm-4.6" }] },
  { id: "cheap-and-fast", name: "Cheap and fast", strategy: "ordered", members: [{ providerId: "deepseek", model: "deepseek-chat" }, { providerId: "glm", model: "glm-4.6" }, { providerId: "kimi", model: "kimi-k2" }] },
  { id: "long-context", name: "Long context", strategy: "smart", members: [{ providerId: "kimi", model: "kimi-k2" }, { providerId: "deepseek", model: "deepseek-reasoner" }, { providerId: "glm", model: "glm-4.6" }] },
]);
const deps: PipelineDeps = {
  providers: new Map(providers.map((p) => [p.id, p])),
  groups: new Map(groups.map((g) => [g.id, g])),
  directRoutes: new Map(),
  defaultProviderId: "qoder",
  health: new HealthBook(),
  bus: new RouteEventBus(),
  affinity: new Map(),
};
const server = createGatewayServer(deps, {
  agentKeys: { "qpa-claude-code": "claude-code", "qpa-codex": "codex", "qpa-opencode": "opencode" },
  adminToken: "demo",
  devCorsOrigin: "*",
});
const port = Number(process.env.PORT ?? 8320);
server.listen(port, "127.0.0.1", () => console.log(`demo gateway on http://127.0.0.1:${port}  (admin token: demo)`));

const agents = ["claude-code", "codex", "opencode"];
setInterval(async () => {
  const agent = agents[Math.floor(Math.random() * agents.length)];
  const group = groups[Math.floor(Math.random() * groups.length)];
  for await (const _ of routeStream(
    { model: `group/${group.id}`, messages: [{ role: "user", content: "demo" }] },
    { requestId: `req_${Date.now().toString(36)}`, agent, protocol: agent === "claude-code" ? "messages" : agent === "codex" ? "responses" : "chat", conversationId: `${agent}-session`, signal: AbortSignal.timeout(10_000) },
    deps,
  )) {
    /* 丢弃正文，只为产生路由事件 */
  }
}, Number(process.env.DEMO_INTERVAL_MS ?? 1500));
