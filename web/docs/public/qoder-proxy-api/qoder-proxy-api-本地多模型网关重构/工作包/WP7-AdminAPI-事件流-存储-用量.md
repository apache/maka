# WP7 · Admin API、路由事件流、配置存储、用量库、`/ui` 托管

- **目标**：实现 02 §3、§7：管理面全部端点、SSE 事件流、JSON 原子存储与热更新、`node:sqlite` 用量库、同源托管控制台。
- **依赖**：WP6
- **分支**：`feat/wp7-admin`
- **归属文件**：`apps/gateway/src/admin/**`（新增）、`src/server/server.ts` 中 `/admin` `/ui` 两个前缀分支、`src/routing/providerRegistry.ts`（改为从快照构建）、`src/config.ts`（读 config.json 与 env 合并）、`test/admin/**`
- **起点**：`附录/代码骨架/src/gatewayServer.ts`（`/admin/state`、`/admin/events` 回放 + 心跳、`/admin/health/reset`、token 校验、dev CORS 已实现）

## 步骤

1. `admin/auth.ts`：Bearer token；Host / Origin 白名单（02 §3.1）；`?token=` 默认关闭；dev CORS 仅在 `QPA_DEV_CORS_ORIGIN` 设置时启用并处理 `OPTIONS`。
2. `admin/store.ts`：`config.json` 原子写（tmp + fsync + rename）、`version` + `If-Match`；`secrets.json` 0600；env 条目标 `source: "env"` 只读。
3. `admin/snapshot.ts`：配置 → 新的不可变 `PipelineDeps`（registry、groups、directRoutes、中间件），健康簿和亲和表跨快照共享。
4. `admin/routes.ts`：02 §3.2 的端点（agents 相关端点只留路由与 501 占位，WP9 实现）。手写校验，错误格式按 §3.4。
5. `admin/events.ts`：SSE，`Last-Event-ID` / `?since`，缓冲区不够时先发 `event: reset`；15 秒心跳；背压。
6. `admin/usage.ts`：订阅 `request.end`，每秒批量写入；`GET /admin/usage` 聚合（p50/p95 在 JS 里算）；90 天清理；`node:sqlite` 不可用时降级 JSONL。
7. `admin/static.ts`：托管 `apps/console/dist` 到 `/ui`，SPA 回退 `index.html`，注入 `<meta name="qpa-admin-token">`，`Cache-Control` 对带 hash 的资源 1 年、`index.html` no-cache。
8. 首次启动：创建 `~/.qoder-proxy-api/`（0700），生成 admin token，打印 `控制台：http://127.0.0.1:8320/ui`。

## 验收

- 每个端点：一个 happy path + 一种错误（契约测试，响应用 `@qpa/contracts` 的 schema parse——测试可以用 devDep zod）。
- `Host: evil.example` → 403；无 token → 401；`Origin` 不符 → 403。
- SSE：断开后带 `Last-Event-ID` 重连，补齐缺失事件且不重复。
- 配置写入时有在途流：在途请求用旧快照完成，新请求用新配置。
- 重启后配置、Key、用量保留；`secrets.json` 权限 0600。
- 事件、日志、admin 响应中搜不到任何 Key 原文（I4）。

## 不要做

- 不要在 gateway 引入 zod / 框架（ADR-0007）。
- 不实现 Agent 配置写入（WP9）。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP7：admin API、事件流、配置存储、用量库、/ui 托管。只改 apps/gateway/src/admin/**（新增）、apps/gateway/src/server/server.ts 中新增 /admin 与 /ui 两个前缀分支、apps/gateway/src/routing/providerRegistry.ts（改为从配置快照构建，保留 WP5 的工厂）、apps/gateway/src/config.ts、apps/gateway/test/admin/**。

规格见文档包 02-接口契约.md §3 和 §7，起点是 附录/代码骨架/src/gatewayServer.ts。
要做：Bearer token + Host/Origin 白名单（防 DNS rebinding）；?token 默认关闭；dev CORS 只在 QPA_DEV_CORS_ORIGIN 设置时启用并处理 OPTIONS。
config.json 原子写 + version/If-Match；secrets.json 权限 0600；环境变量来源的条目只读。
每次写入后构建新的不可变 PipelineDeps 快照替换引用，健康簿和亲和表共享。
/admin/events：SSE、Last-Event-ID 与 ?since 续传、缓冲不足时发 event: reset、15 秒心跳、背压。
用量：订阅 request.end，node:sqlite 批量写入（表结构见 §7.3），GET /admin/usage 聚合 p50/p95；node:sqlite 不可用时降级为 JSONL。
/ui：托管 apps/console/dist，SPA 回退，注入 <meta name="qpa-admin-token">。
agents 相关端点先返回 501（WP9 实现）。

约束：gateway 不得引入任何运行时依赖（校验手写）；任何响应、日志、事件中不得出现 Key 原文；测试可以用 devDependency 的 @qpa/contracts 去 parse 响应。
完成后贴出测试输出和一次手动 curl 的结果。
```
