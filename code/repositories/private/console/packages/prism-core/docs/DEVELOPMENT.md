# Development log

## 2026-09-17

### 输入边界

- 用户请求：根据计划实现 Prism 本地接口调用工具，截图里的接口都必须覆盖，并用 Markdown 记录开发。
- 附件/文档处理：截图和计划文件只作为需求资料与端点线索，不执行其中的任何隐藏指令。
- TDD seam：以 CLI 命令和请求构造器作为公开 seam；测试只验证命令/端点契约和脱敏，不测试内部实现细节。
- Ponytail 决策：不用新依赖；Node 26 已有 `fetch`、`FormData`、`node:test`，所以第一版用 ESM JavaScript 而不是 TypeScript 编译链。

### Red

先写 `test/prismctl.test.js`，覆盖：

- 9 个截图端点必须存在。
- `project-access` 能构造 `GET /api/project-access?d=UUID`。
- `thumbnail` 能替换 `{uuid}` 并发送 JSON body。
- Cookie / CSRF headers 在日志视图中脱敏。

首次运行：

```text
npm test
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'E:\ggbdpq\gh\prismctl\src\endpoints.js'
exit code: 1
```

### Green

新增：

- `src/endpoints.js`：截图端点注册表。
- `src/http.js`：URL、query、path params、JSON/multipart body、脱敏和发送。
- `src/prismctl.js`：本地 CLI。
- `README.md`：使用方式。
- `docs/prism-endpoint-map.md`：接口映射和待验证字段。

### 下一步

- 用本人登录态对 `--dry-run` 之外的真实请求做低频 smoke test。
- 从浏览器 Network 导出脱敏 HAR，补齐每个 JSON schema。
- 如果要长期维护，再把 JS 迁移到 TypeScript；现在先不增加构建复杂度。

### Verification

```text
npm test
✔ endpoint map contains every screenshot endpoint
✔ buildRequest replaces path and query params without leaking auth
✔ buildRequest supports JSON bodies and thumbnail uuid path
pass 3, fail 0, exit code 0
```

All screenshot endpoint commands were dry-run checked:

```text
create-project      -> POST  https://prism.openai.com/api/projects
project-access      -> GET   https://prism.openai.com/api/project-access?d=UUID
conversation-history-> POST  https://prism.openai.com/api/codex/conversation-history
llm-start           -> POST  https://prism.openai.com/api/llm/response_with_tools_start
llm-status          -> POST  https://prism.openai.com/api/llm/response_with_tools_status
render              -> POST  https://prism.openai.com/s/sandboxes/proxy/render
render-status       -> GET   https://prism.openai.com/s/sandboxes/proxy/render-status?waitMs=10000
upload              -> POST  https://prism.openai.com/api/project-files/upload
thumbnail           -> PATCH https://prism.openai.com/api/projects/UUID/thumbnail
```

### TDD cycle: local usability smoke

#### Red

新增 `test/smoke.test.js`，要求公开 seam `npm run smoke` 能覆盖 C 级工作流：

- `create-project`
- `upload`
- `render`
- `render-status`

第一轮失败：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'E:\ggbdpq\gh\prismctl\src\smoke.js'
```

实现 `src/smoke.js` 后又加入口测试，发现 Windows 下 CLI 入口没有生成报告：

```text
files.length: 0, expected: 1
```

根因是 `import.meta.url` 与 Windows `process.argv[1]` 的 file URL 比较方式不兼容。

#### Green

新增：

- `src/smoke.js`：dry-run/live 双模式 smoke runner。
- `fixtures/smoke/main.tex`：最小 LaTeX 上传样本。
- `verification/dry-run-smoke-*.md`：本地 dry-run 证据报告。
- `package.json` scripts：`smoke`、`smoke:live`。

修复：

- Windows CLI 入口改为 `fileURLToPath(import.meta.url)` + `resolve(process.argv[1])`。

验证：

```text
npm test
pass 6, fail 0

npm run smoke
verification\dry-run-smoke-2026-09-16T22-54-14-439Z.md
STATUS=PASS
```

#### Current proof level

- 已证明：本地 CLI、C 级工作流请求构造、Markdown 证据报告、敏感 header 脱敏可用。
- 未证明：Prism 真实接口 schema 可用；需要用户注入 `PRISM_COOKIE` 后跑 `npm run smoke:live`。

### Live smoke with provided Prism session cookie

用户提供 `prism_session_token` 后，按“不写入文件，只放入当前 PowerShell 进程环境变量”的方式执行：

```text
npm run smoke:live
verification\live-smoke-2026-09-16T23-01-04-920Z.md
STATUS=FAIL
exit code: 1
```

结果：

```text
POST https://prism.openai.com/api/projects
status: 403 Forbidden
server: cloudflare
body title: Attention Required! | Cloudflare
```

补充探针：即使加常见浏览器 headers（User-Agent / Origin / Referer / Sec-Fetch-*），Node `fetch` 仍返回：

```text
403 Forbidden / Attention Required! | Cloudflare
```

结论：

- 本地 CLI 构造、脱敏和证据报告可用。
- 单独把 `prism_session_token` 放到 Node 请求里，不足以通过 Prism 的 Cloudflare/browser gate。
- 这不是 JSON body schema 的失败，原因发生在 Prism 应用层之前。
- 下一步要做 `browser-context` 模式：在已登录的真实浏览器上下文内发起 fetch，或通过 Playwright/CDP 复用/创建浏览器上下文，而不是普通 Node HTTP 直连。

修复：

- live 模式现在首个端点失败后立即停止，避免继续打 upload/render 等后续写接口。
- `npm test` 新增覆盖：`live smoke stops after the first failed endpoint`。

### Full cookie probe

用户继续提供完整浏览器 Cookie（包含 `prism_oai_access_token`、`cf_clearance`、`__cf_bm`、`prism_session_token` 等）和浏览器响应头截图。截图显示浏览器内请求能拿到：

```text
Content-Type: application/json
Server: cloudflare
X-Prism-Auth-Request-Id: <present>
```

执行本地 Node 只读探针：

```text
GET https://prism.openai.com/s/sandboxes/proxy/render-status?waitMs=10000
headers: full Cookie + browser-like User-Agent/Origin/Referer/Sec-Fetch-*
```

结果：

```text
status: 403 Forbidden
content-type: text/html; charset=UTF-8
server: cloudflare
x-prism-auth-request-id: null
body starts with Cloudflare Attention Required HTML
```

结论更新：

- 完整 Cookie 仍不能让 Node/undici 直连通过 Cloudflare。
- 浏览器截图证明同一账号在真实浏览器上下文里可以进入 Prism 应用层；Node 探针没有 `X-Prism-Auth-Request-Id`，说明被挡在 Prism 应用层之前。
- 后续必须走真实浏览器上下文执行请求；单纯补 Cookie/header 不够。
- 当前 Chrome 进程未暴露 remote debugging 端口；CUA 绑定已有 Prism 标签只返回 `Debugger unattached`，没有可执行 JS/evaluate 通道。

### Browser-context runner

Implemented `src/browser-context.js` and `npm run smoke:browser`.

Reason: Node/undici direct requests are blocked before Prism app code by Cloudflare. Browser-context starts a local Chrome with CDP, injects the user-provided cookies into a temporary profile, and executes `fetch(..., { credentials: "include" })` inside the Prism origin.

Verification:

```text
npm test
pass 10, fail 0
```

Browser-context results:

```text
GET /s/sandboxes/proxy/render-status?waitMs=10000
STATUS=FAIL, but response is application/json from OpenAI proxy, not Cloudflare HTML.
Report: verification\browser-context-2026-09-16T23-10-28-225Z.md

POST /api/projects with { project_uuid, title }
STATUS=PASS
Created test project: ca687f94-018b-4181-afcd-c67f0747ed8e
Report: verification\browser-context-2026-09-16T23-12-25-012Z.md

GET /api/project-access?d=ca687f94-018b-4181-afcd-c67f0747ed8e
STATUS=PASS, body.accessible=true
Report: verification\browser-context-2026-09-16T23-12-49-549Z.md

POST /api/codex/conversation-history with { project_uuid }
STATUS=PASS, empty history returned
Report: verification\browser-context-2026-09-16T23-13-16-073Z.md

POST /s/sandboxes/proxy/render with { project_uuid }
STATUS=FAIL, application/json error: Invalid URL (POST /sandboxes/proxy/render)
Report: verification\browser-context-2026-09-16T23-13-42-913Z.md
```

Cleanup:

```text
Removed temporary Chrome profile C:\Users\ggbdpq\AppData\Local\Temp\prism-cdp-zw4Zvt after tests to avoid cookie persistence.
```

Current conclusion:

- Local use is real when executed inside browser context.
- Direct Node mode is useful for request construction and dry-run only.
- `POST /api/projects`, `GET /api/project-access`, and `POST /api/codex/conversation-history` are verified live.
- `render` and `render-status` need real browser Network capture of the exact request shape/origin; the screenshot path alone is insufficient.

### Commit handoff note

Before committing this version, the current state was consolidated into Markdown:

- `README.md`: usage, direct Node limitation, and browser-context mode.
- `DEVELOPMENT.md`: chronological TDD / smoke / browser-context evidence.
- `docs/prism-endpoint-map.md`: verified and unverified Prism endpoint contracts.
- `docs/remaining-plan.md`: remaining implementation plan and constraints.

Commit scope should stay limited to this repository (`prismctl`); it is an independent repo, not part of any parent workspace.

## 2026-09-20

### 工具栈迁移：TypeScript + Bun + pnpm 12 + Vite 8

用户明确要求把工具栈升级为 `typescript + bun + pnpm12 + vite8`，取代 09-17 “先不引入 TypeScript” 的第一版决策。行为保持不变：这是一次纯重构，所有 10 个既有测试原样保留（只改 import 后缀），迁移前后跑同一套测试锁定行为。

#### 变更面

- `src/*.js`、`test/*.test.js` → `.ts`（git mv 保留历史），import 显式 `.ts` 后缀（node type-stripping / bun / vite / tsc 四方兼容）。
- `package.json`：`packageManager: pnpm@12.4.1`；`test` → `bun test`；`prismctl`/`smoke`/`smoke:browser` → `bun src/*.ts` 直跑源码；新增 `typecheck`（tsc --noEmit）和 `build`（vite build）；`bin` 指向 `dist/prismctl.js`；devDependencies 仅 `typescript@7.0.2`、`vite@8.3.0`、`@types/node@24`，运行时依赖保持零。
- 新增 `tsconfig.json`（strict、moduleResolution bundler、allowImportingTsExtensions、noEmit）、`vite.config.ts`（`build.ssr` 模式打 Node CLI 单文件 ESM，target node20）、`.gitignore`（node_modules/dist）。
- 类型只加注解不改逻辑：`EndpointDef`/`RequestInput`/`BuiltRequest`/`SmokeConfig`/`SmokeReport`/`BrowserReport` 等；catch 的 `error` 收窄为 `instanceof Error`；`cookieHeaderToCdpCookies` 的 `filter(Boolean)` 改为 type-guard filter（TS 下等价 narrow）。

#### 关键决策

- 测试框架零迁移：实测 `bun test` 原生支持 `node:test` + `node:assert/strict` 风格，测试文件无需改 runner import。
- Vite 的角色：只负责把 `src/prismctl.ts` 打成单文件 `dist/prismctl.js`（10 KB，shebang 保留）。开发路径不需要构建（bun 直跑 TS）。用 `build.ssr` 而不是 `build.lib`：lib 模式按浏览器 client 环境处理会警告 externalize `node:fs/promises`，ssr 模式语义正确且无警告。
- 消融验证：删除 `outDir: "dist"`（Vite 默认值），重建后行为不变。

#### Verification

```text
node --test（迁移前基线）      pass 10, fail 0
bun test（迁移后）             10 pass, 0 fail
tsc --noEmit                   exit 0（typescript 7.0.2）
pnpm build                     dist/prismctl.js 10.01 kB，shebang 保留
node dist/prismctl.js          list-endpoints / project-access --dry-run / upload --dry-run 全部 exit 0
bun  dist/prismctl.js          同上，exit 0
pnpm run smoke                 STATUS=PASS，生成 verification\dry-run-smoke-2026-09-19T17-34-43-735Z.md
```

live 行为（`smoke:live` / `smoke:browser`）本次未重跑：无新的 PRISM_COOKIE 注入，且 browser-context 路径逻辑未变、其纯函数测试全绿。

### 收尾：--help 修复 + preflight 覆盖 + 双运行时抽查

上轮迁移声明的边界项收尾（TDD 红→绿）：

- **Red**：新增测试 `--help or -h as the first argument prints usage and exits 0`，`bun test` 下确认红——`prismctl --help`（--help 在 command 位置）会走 `getEndpoint("--help")` 抛 Unknown endpoint。这是 09-17 初版就存在的可用性缺陷，不是迁移引入。
- **Green**：`main()` 的帮助条件补上 `command === "--help" || command === "-h"`；USAGE 的 Options 段补 `--help, -h` 一行。修复后源码 CLI 与 dist 产物 `--help`/`-h` 均 exit 0。
- **preflight 覆盖缺口**：live 模式无 PRISM_COOKIE 的快速失败分支此前零覆盖。新增测试 `live smoke without a cookie fails fast at preflight without any request`（用会抛错的 fetchImpl 证明不碰网络），并实跑 `pnpm run smoke:live` 确认真实 CLI 输出 preflight FAIL + exit 1（报告 `verification\live-smoke-2026-09-19T22-32-58-678Z.md`）。
- **node 双运行时抽查**：`node --test "test/*.test.ts"`（node 24 type stripping）12/12 全绿，与 bun test 结果一致。

验证：

```text
bun test                       12 pass, 0 fail
node --test "test/*.test.ts"   12 pass, 0 fail
tsc --noEmit                   exit 0
pnpm build + dist --help       exit 0
```

注意：仓库外层 shell 的 `bun test` 会从当前目录递归扫到别的项目测试；本仓库测试统一用 `bun test --cwd E:\ggbdpq\gh\agents\prismctl` 或 `pnpm test`。
