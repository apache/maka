> 校注（2026-11-07）：下方「状态：未动手」是 2026-10-04 产生时的记录，原文不改。journal 后续记录：[13-评审维护-卷05](../journal/13-评审维护-卷05.md) 记 10-05 开出 cursor 提案 issue [#5964](https://github.com/apache/maka/issues/5964)；[12-认领轨-卷02](../journal/12-认领轨-卷02.md) 的 PR-034 记 10-10 take #5964 并交付 PR [#6039](https://github.com/apache/maka/pull/6039)（单 A cursor 适配器）。本地 upstream/main ancestry 含 `368f5c9a3`「feat(storage): import Cursor sessions via the state.vscdb adapter (#6039)」（2026-10-18），提示已合入；PR 终态未用 GitHub 核实（需 `gh pr view 6039 -R apache/maka`）。单 B（kimi-chat-exporter 导入）在 journal 中未见开工记录。

# maka 贡献单：外部会话导入扩展 —— cursor 适配器 + kimi 导入

- 产生日期：2026-10-04（由 ZCode 会话探查沉淀，事实均已本机核实）
- 仓库（Mac）：`/Users/ggbdpq/cc/code/fork/maka-hub/maka`（本地 main + worktrees `make-pr1..5`）
- 状态：**未动手**。这是大单（适配器单件 800–1600 行 + 千行级测试），**先开 issue 对齐维护者，拿到信号再写代码**。
- 拆单纪律：cursor 和 kimi 是两个独立 PR，不跨组。

---

## 0. 一句话背景

maka 已内置"外部会话导入"体系（external session import），现支持 codex / claude-code / opencode 三家的本地会话记录导入桌面端。本单补两个缺口：

- **单 A**：Cursor（IDE）的本地会话库适配器 —— 数据在本地 SQLite，纯读文件，可行性已实测。
- **单 B**：kimi 网页版对话导入 —— kimi 数据在服务端，**不做调 API 版**（违反契约 + 鉴权敏感），做"导入 kimi-chat-exporter 导出产物"的适配器。

## 1. 体系地图（读代码先看这些）

| 部件 | 位置 | 要点 |
|---|---|---|
| 契约 | `packages/core/src/external-session.ts:272` | `ExternalSessionAdapter` 三方法：`detect()` / `listSessionPage(query)`（分页 key 对调用方不透明）/ `readSession(id)` → `ExternalMakaSession{sourceSessionId, metadata{name,cwd}, messages: StoredMessage[]}` |
| 限额 | 同文件 `:236` | `EXTERNAL_SESSION_LIMIT_KINDS`：transcript_bytes / record_bytes / records / converted_bytes / messages |
| 注册表 | `packages/storage/src/external-session-adapters.ts` | `createExternalSessionAdapterRegistry([Codex, ClaudeCode, OpenCode])`，新适配器在此加一行 |
| 导入器 | `packages/storage/src/external-session-importer.ts:47` | `ExternalSessionImporter`，消费 `readSession` 落库 |
| 稳定分页 | `packages/storage/src/offset-external-session-catalog.ts` | catalog 查询哈希 |
| 现成骨架 | `claude-code-session-adapter.ts`（1341 行）/ `codex-session-adapter.ts`（1632，含 node:sqlite 用法）/ `opencode-session-adapter.ts`（810） | 测试样板：`__tests__/claude-code-session-adapter.test.ts`（1180 行） |
| 桌面链路 | `apps/desktop/src/main/runtime-host-external-sessions-ipc-main.ts` → `src/preload/external-session-catalog.ts` → `src/renderer/settings/import-tasks-settings-page.tsx` | 现有 UI 不用大动 |

**硬化三件套（评审必查，#5125 同款思路）**：
1. 五种限额全部生效且有测试触发路径；
2. 输入当不可信：标题/`cwd`(≤4KB 字节)/查询文本(≤200 字符)清洗，路径黑名单含零宽字符与双向控制符（参考 `CODEX_UNSAFE_PATH_CHARS`）；
3. 错误不外泄：错误类型不携带源路径、transcript 内容、原始错误（`ExternalSessionLimitError` 注释是原话）。

## 2. 单 A：cursor-session-adapter

### 2.1 数据源（2026-10-04 本机实测，Mac）

- 库文件：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`（普通 SQLite，node:sqlite `DatabaseSync` 可读，codex 适配器已有先例）。
- 表：`ItemTable`、`cursorDiskKV`、`composerHeaders`。
- `cursorDiskKV` 键布局（key → value 为 JSON 文本）：
  - `composerData:<uuid>`：**532 条**，会话元数据。样本字段：`_v`(实测 10)、`composerId`、`fullConversationHeadersOnly[]`（bubble 索引）、`conversationMap{}`、`context{...}`、`status`。最大单条 822KB。
  - `bubbleId:<composerId>:<bubbleId>`：**40435 条**，单条消息正文，最大 800KB+。
- 探测命令（**路径带空格，sqlite3 URI `mode=ro` 打不开 exit 14，必须先拷贝**）：
  ```bash
  cp "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" /tmp/cursor-state-ro.db
  sqlite3 /tmp/cursor-state-ro.db "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';"
  rm /tmp/cursor-state-ro.db
  ```

### 2.2 设计映射

- `detect()`：库文件存在且能只读打开。
- `listSessionPage()`：`key LIKE 'composerData:%' ORDER BY key LIMIT ?` 分页；从 composerData 取标题/时间（字段名以实测 JSON 为准，缺省回退 fs mtime），复用 `externalSessionMatchesQuery` + 清洗。
- `readSession()`：按 `fullConversationHeadersOnly` 逐个拉 `bubbleId:<composerId>:<...>` → 映射 `StoredMessage[]`；空 headers 的 composer 视为空会话，不报错。
- Options：`stateDbPath?`（默认上述路径），限额常量命名照 `CLAUDE_TRANSCRIPT_*` 风格。
- **三个坑**：① 只读打开，绝不写；运行中的 Cursor 在写库，测试与真实读取都用"拷贝快照"或只读连接，打开失败要归类为可重试错误而不是崩溃；② `_v` 是私有版本号，按版本分派解析、未知版本降级跳过该字段而不是整条拒绝；③ 单 bubble 可达 800KB，`record_bytes` 限额必须留足并在超限时走 `ExternalSessionLimitError`。
- 诚实声明（PR 正文要写）：state.vscdb 是 Cursor 内部存储、非公开契约；maka 读 codex/claude 同为非公开格式，先例一致；容错策略=字段缺失降级不致命。

### 2.3 验收判据（DoD）

- [ ] 注册表接入后，桌面导入页能看到 Cursor 会话目录并导入一条真实会话。
- [ ] `__tests__/cursor-session-adapter.test.ts`：fixture 用代码在临时目录建 mini state.vscdb（含 composerData + bubbleId + 空会话 + 超限记录四类样本），先写"修前会挂"的用例。
- [ ] 限额五类各有触发测试；错误消息不含路径与内容。
- [ ] 本机真实验证：detect()=true，目录列出数量级 ≈532，抽一条导入成功。
- [ ] `npm run format:check` + `npm run check:asf-headers` 绿；测试输出落文件再 grep，别接 tail。

## 3. 单 B：kimi 导入适配器

### 3.1 关键分岔（issue 里要先对齐的）

- ❌ **不做**"借登录态调 kimi.com API"版：`ExternalSessionAdapter` 契约假设源在本机（`detect()` 无参数无鉴权）；ASF 项目代理第三方闭源服务的 token/cookie 管理敏感且本机无法稳定验证。
- ✅ **做**"读 [micooz/kimi-chat-exporter](https://github.com/micooz/kimi-chat-exporter) 导出产物"版：该插件（Chrome MV3，MIT）借登录态分页拉 kimi.com 官方接口，输出自包含 ZIP：`markdown/`（每会话一个 .md）、`raw/`（原始响应 JSON 原样保留）、`assets/<chat-id>/`、`report.md`、`error.log`。**解析对象选 raw/ 的 JSON**（结构化、含思考链/工具调用/分支），markdown 版不做。

### 3.2 设计映射

- Options：`kimiExportRoot?`（指向解压后的导出目录）。**没有默认路径**——导出 ZIP 落在哪由用户决定，"如何让用户指定路径"是桌面 UI 的讨论点（现有三适配器都是固定路径，这是单 B 在 issue 里要问维护者的第一个问题）。
- `detect()`：root 存在且含 `raw/`；`listSessionPage()` 列 `raw/` 下会话文件；`readSession()` 解析单会话 JSON → `StoredMessage[]`。
- ⚠️ **raw/ 的确切 schema 未实测**（本单唯一未验证项）：动手前先装插件导一次自己的 kimi 对话拿真实样本，按样本定解析器，禁止照想象写 schema。ZIP 解压建议用 node:sqlite 同款 stdlib 思路——`node:zlib` + 手解或引入已有依赖，先看 maka 现有依赖里有没有 unzip 能力，没有就要求用户解压后选目录（更懒、更稳）。
- 清洗与限额套件照单 A。

### 3.3 验收判据（DoD）

- [ ] 真实导出样本入库（样本放 `__tests__/fixtures/`，脱敏）。
- [ ] schema 解析对未知字段容错（样本迭代一版 + 缺字段降级测试）。
- [ ] 其余同单 A（限额/清洗/错误/格式/头检查）。

## 4. 执行流程（新对话照此走）

1. **开场固定流程**：`git fetch upstream main && git fetch origin` → 查在途 PR 是否已合并（merged → 台账移出在途）→ 扫在途 PR 新评论（review 修复优先于一切新单）→ 排雷占坑（search open PR 正文 `Fixes #N` / "will open a PR"）→ 查 `mergeable_state`，dirty 先 merge upstream/main 解冲突。
2. **先 issue 后代码**：各开一个 issue（cursor 一单、kimi 一单）陈述动机 + 实测数据 + 设计要点 + 风险声明，等维护者信号；拿到 OK 后 issue 下评论认领（正文恰一词 `take`）。
3. **分支**：显式从 `upstream/main` 切（`git -C ... checkout -b <fix/xxx> upstream/main`），绝不从本地 main 切；动手前 `git branch --show-current` 确认（每日自动任务会切回 main）。多单串行，别在上一单分支顺手提交。
4. **验证矩阵**：改动包测试单跑 → `npm run format:check`（只认横幅计数/退出码）→ `npm run check:asf-headers`；失败先定性再改；不可验证的部分在 PR 里明说，绝不谎报全绿。
5. **提交**：`type(scope): 摘要` + 根因/修法正文 + `Fixes #N` + `Generated-by: GLM-5.3-Flash (ZCode)` 尾注；消息用 `-F` 文件。作者必须为 `ggbdpq <ggbdpq@gmail.com>`（新 clone 先 `git config --show-origin user.name user.email` 核对）。
6. **PR 正文四段**：Summary / Verification 表 / AI use / Checklist。
7. **收尾**：`pr/` 台账新增条目（11-15 号平铺，当前编到 15；epoch 撞号按口诀顺延）+ `pr/README.md` 索引更新；3 天无审核信号 gentle ping。

## 5. 本机环境备忘（Mac）

- node 由 fnm 管；重测试落文件再 grep，spawn 重度合跑会互踩。
- `node:sqlite` 需要当前 node 版本支持（codex 适配器已在用，说明工具链 OK）。
- 顺带发现（不在本单范围）：zcode 会话在 `~/.zcode/cli/rollout/model-io-sess_*.jsonl`，形态接近 claude code，将来可做 ClaudeCode 变体单。

## 6. 风险清单

| 风险 | 定性 | 缓解 |
|---|---|---|
| Cursor schema 漂移（`_v` 已实测到 10） | 真实存在 | 版本分派 + 降级解析 + PR 明示非公开契约 |
| raw/ kimi schema 未实测 | 未验证项 | 动手前必须先导出真实样本 |
| 大单超 200 行选题闸门 | 流程风险 | issue 先行对齐，维护者点头才开工 |
| 上游已有别人做同功能 | 占坑风险 | 开场排雷必查 |
