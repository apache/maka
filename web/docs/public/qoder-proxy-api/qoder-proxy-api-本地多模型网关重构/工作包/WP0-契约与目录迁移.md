# WP0 · 契约与目录迁移

- **目标**：把仓库变成 pnpm workspace（`apps/gateway` + `packages/contracts`），落地 02 的类型增量，其余工作包都基于它开分支。
- **依赖**：无
- **分支**：`feat/wp0-contracts`
- **归属文件**：根 `package.json` `pnpm-workspace.yaml`；`apps/gateway/**` 的移动；`apps/gateway/src/core/{errors,provider}.ts`（只做加法）；`apps/gateway/src/routing/routeEvents.ts`（只放类型）；`packages/contracts/**`；`scripts/architectureCheck.ts`

## 步骤

1. **提交 1（纯移动）**：`git mv src test scripts tsconfig.json apps/gateway/`（`README.md`、`LICENSE`、`CLAIMS.md` 留根目录）。修正 `bin`、`scripts` 的相对路径。此提交不改任何文件内容以外的东西，`git log --stat -M` 只有 rename。
2. 根目录 `pnpm-workspace.yaml`：`packages: [apps/*, packages/*, examples/*]`。
3. **提交 2（契约）**：
   - `core/errors.ts`：`ProviderError` 加 `retryAfterMs?`；`ERROR_CODES` 加 `PROVIDER_REJECTED`（骨架 `events.ts`）。
   - `core/provider.ts`：`QoderProvider` → `GatewayProvider`（保留类型别名），`id: string`，加 `kind`、`label`；现有三个 provider 补上 `kind`/`label`。
   - `routing/routeEvents.ts`：复制骨架里的 `RouteEvent`、`MemberRef` 类型（**只放类型和 `RouteEventBus` 签名**，实现留给 WP6）。
4. `packages/contracts`：把原型 `附录/console-原型/src/contracts.ts` 迁过来，导出 zod schema 与 `z.infer` 类型：`RouteEvent`、`RouteGroup`、`Provider`、`AgentIntegration`、`AdminState`、`AdminError`、`UsageRow`。
5. `scripts/architectureCheck.ts` 加规则：`routing ↛ protocols`；`apps/gateway` 不得 import `zod` 或 `@qpa/contracts`；`admin ↛ providers/*/`内部文件。把它加进 `pnpm check`（现在不在 npm scripts 里）。
6. 加一个契约一致性测试：`packages/contracts/test/events.test.ts` 读取一份 fixture（骨架 e2e 产出的 8 个事件 JSON），全部 `safeParse` 成功。

## 验收

- `pnpm -r test`：原 89 个用例在新路径下全绿。
- `pnpm check`（typecheck + lint + architectureCheck）通过；故意在 gateway 里 `import "zod"` 时 check 失败。
- `apps/gateway/package.json` 的 `dependencies` 为空。

## 不要做

- 不要在移动提交里改代码。
- 不要实现路由逻辑、不要改协议映射。
- 不要升级 TypeScript 大版本（仓库是 5.9；升级另开 PR）。

## Cursor 提示词

```text
你在 qoder-proxy-api 仓库做 WP0：契约与目录迁移。只改这些文件：根 package.json、pnpm-workspace.yaml、apps/gateway/**（移动）、apps/gateway/src/core/errors.ts、apps/gateway/src/core/provider.ts、apps/gateway/src/routing/routeEvents.ts、packages/contracts/**、apps/gateway/scripts/architectureCheck.ts。

步骤：
1. 第一个 commit 只做 git mv：把 src/ test/ scripts/ tsconfig.json 移到 apps/gateway/，修正 package.json 里 bin 和 scripts 的路径。跑 `pnpm --filter qoder-proxy-api test` 确认 89 个测试仍然全绿后再提交。
2. 第二个 commit 落地契约（参照文档包 02-接口契约.md §1、§2 和 附录/代码骨架/src/events.ts、routeEvents.ts）：
   - ProviderError 增加可选 retryAfterMs；ERROR_CODES 增加 PROVIDER_REJECTED。
   - QoderProvider 改名 GatewayProvider（保留 export type QoderProvider = GatewayProvider），id 改成 string，新增 kind 与 label，三个现有 provider 补上这两个字段。
   - routing/routeEvents.ts 只放 RouteEvent / MemberRef 类型和 RouteEventBus 的接口签名，不写实现。
3. 新建 packages/contracts（name @qpa/contracts，依赖 zod 4），从 附录/console-原型/src/contracts.ts 迁入 schema，并补 AdminState、AdminError、UsageRow。加一个测试：读取 fixtures/route-events.json 全部 safeParse 成功。
4. architectureCheck.ts 增加规则：routing 不得 import protocols；apps/gateway 不得 import zod 或 @qpa/contracts；admin 不得 import providers 的内部文件。把它加入 package.json 的 check 脚本。

约束：apps/gateway 的 dependencies 必须保持为空；不要改任何协议映射或路由行为；不要升级 TypeScript。
完成后贴出：git log --stat -M 前两个提交摘要、pnpm -r test 输出、pnpm check 输出。
```
