# prismctl —— OpenAI Prism 本地接口学习工具

`prismctl` 是 [OpenAI Prism](https://prism.openai.com/)（AI-first LaTeX/科研工作台）的本地接口调用与学习工具原型。它不保存登录凭证，只从环境变量或命令行读取本人已登录会话所需的 headers，然后调用 Prism Web 端观察到的接口。

## 安装与测试

工具栈：TypeScript + Bun（运行时/测试）+ pnpm 12（包管理）+ Vite 8（bin 打包）。

```powershell
cd E:\ggbdpq\gh\agents\prismctl
pnpm install
pnpm test          # bun test，10 个用例
pnpm run prismctl -- list-endpoints
pnpm typecheck     # tsc --noEmit
pnpm build         # vite 构建 dist/prismctl.js（node/bun 均可直接运行）
```

## 会话输入

推荐只在当前 shell 注入：

```powershell
$env:PRISM_COOKIE = '从本人浏览器复制的 Cookie'
$env:PRISM_CSRF_TOKEN = '如果请求需要 CSRF，就填这里'
```

不要把 Cookie、Authorization、CSRF 写进仓库或 Markdown。

## 截图接口命令覆盖

```powershell
pnpm run prismctl -- create-project --json '{"name":"Test"}'
pnpm run prismctl -- project-access --d UUID
pnpm run prismctl -- conversation-history --json '{"projectId":"UUID"}'
pnpm run prismctl -- llm-start --json '{"projectId":"UUID","message":"hello"}'
pnpm run prismctl -- llm-status --json '{"responseId":"ID"}'
pnpm run prismctl -- render --json '{"projectId":"UUID"}'
pnpm run prismctl -- render-status --wait-ms 10000
pnpm run prismctl -- upload --file .\main.tex --field projectId=UUID
pnpm run prismctl -- thumbnail --uuid UUID --json '{"thumbnailUrl":"data:image/png;base64,..."}'
```

先用 `--dry-run` 看脱敏后的 URL、method、headers 和 body 是否会被发送：

```powershell
pnpm run prismctl -- project-access --d UUID --dry-run
```

## 简化说明

- ponytail: 零运行时依赖不变——devDependencies 只有 `typescript`、`vite`、`@types/node`。请求仍用原生 `fetch`/`FormData`，测试仍写 `node:test` 风格由 `bun test` 执行。
- 这些是 Prism Web 内部接口观察工具，不是官方稳定 API；端点字段要以本人浏览器抓包结果继续校准。

## 本地可用性验证

本项目把“可用”分两层：

1. **dry-run 可用**：本地 CLI 能生成 C 级工作流请求：创建项目 → 上传 `.tex` → render → render-status，并生成 Markdown 证据报告。
2. **live 可用**：注入本人 Prism 登录态后，对本人账号/本人项目执行真实请求，报告记录脱敏后的请求和响应。

先跑 dry-run：

```powershell
cd E:\ggbdpq\gh\agents\prismctl
pnpm run smoke
```

会生成：

```text
verification\dry-run-smoke-*.md
```

真实 smoke test：

```powershell
$env:PRISM_COOKIE = '从本人浏览器 DevTools 复制的 Cookie'
$env:PRISM_CSRF_TOKEN = '如果 Prism 请求里存在 CSRF，就填这里'
$env:PRISM_PROJECT_ID = '可选：已有测试项目 UUID；没有则尝试从 create-project 响应中提取'
$env:PRISM_UPLOAD_FILE = 'fixtures\smoke\main.tex'

pnpm run smoke:live
```

如果 Prism 的真实 body schema 与默认猜测不同，用这些环境变量覆盖：

```powershell
$env:PRISM_CREATE_PROJECT_JSON = '{"name":"prismctl-smoke"}'
$env:PRISM_UPLOAD_FIELDS_JSON = '{"projectId":"UUID"}'
$env:PRISM_RENDER_JSON = '{"projectId":"UUID"}'
$env:PRISM_RENDER_STATUS_QUERY_JSON = '{"waitMs":"10000"}'
```

`smoke:live` 非 2xx 不代表本地工具不能运行，通常代表 Prism 端点 schema/auth 已变化；把生成的 `verification\live-smoke-*.md` 脱敏后用于更新 `docs/prism-endpoint-map.md`。

## 当前 live 结论

已用临时 `PRISM_COOKIE` 执行过 `pnpm run smoke:live`。结果不是 schema 错，而是 Cloudflare 在 Prism 应用层前返回 403：

```text
server: cloudflare
status: 403 Forbidden
title: Attention Required! | Cloudflare
```

所以当前 Node 直连模式只能证明本地请求构造和报告系统；要真正稳定调用 Prism，需要新增 `browser-context` 模式：在已登录的真实浏览器上下文里执行请求，复用浏览器已通过的 Cloudflare/登录状态。

### Why full cookies still fail from Node

即使把浏览器里完整 Cookie 复制给 Node，请求仍返回 Cloudflare `403 Attention Required`，并且没有 `X-Prism-Auth-Request-Id`。这说明请求没有进入 Prism 应用层。浏览器 Network 截图里的成功响应有 `Content-Type: application/json` 和 `X-Prism-Auth-Request-Id`，差异点不是 Cookie 字段数量，而是浏览器上下文/Cloudflare 指纹。

下一阶段优化目标：`browser-context` runner，而不是继续给 Node 直连补 header。

## Browser-context mode

`pnpm run smoke:browser` starts a local Chrome with CDP and executes `fetch` inside `https://prism.openai.com`, using browser-origin credentials. This is the mode that actually reaches Prism behind Cloudflare.

```powershell
$env:PRISM_COOKIE = '完整 Prism Cookie，仅放当前 shell，不写文件'
$env:PRISM_BROWSER_PATH = '/api/projects'
$env:PRISM_BROWSER_METHOD = 'POST'
$env:PRISM_BROWSER_BODY_JSON = '{"project_uuid":"<uuid>","title":"prismctl-browser-smoke"}'
pnpm run smoke:browser
```

Verified live:

- `POST /api/projects` requires body `{ "project_uuid": "...", "title": "..." }` and returned 200.
- `GET /api/project-access?d=<uuid>` returned `{ "accessible": true, ... }`.
- `POST /api/codex/conversation-history` accepts `{ "project_uuid": "..." }` and returned an empty history for the new project.

Not yet solved:

- `/s/sandboxes/proxy/render` and `/s/sandboxes/proxy/render-status` reach JSON application/proxy responses in browser-context, but the guessed direct fetch shape returns `Invalid URL`; capture the exact browser Network request before wrapping these.

Security hygiene:

- The temporary Chrome profile used for the Cookie-injected run was deleted after verification.
