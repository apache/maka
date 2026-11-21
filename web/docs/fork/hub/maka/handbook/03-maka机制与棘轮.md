# maka 机制与棘轮（冻结区 / 撞号 / 检查器）

架构棘轮排障复盘（PR #4514）

## 问题表现

PR #4514（desktop 面板心跳）CI 的 `test` job 反复挂，换过三种死法：

| 轮次 | 挂的步骤 | 报错 |
| --- | --- | --- |
| 1 | test 内多个用例 | `AssertionError: expected to not match /needs\.plan\.outputs/` 等——其实是 main 被并发合并搞红，PR 基于 red main |
| 2（rebase 后） | `Check renderer architecture` | `environmentCapabilities changed; expected {}, received {"clearInterval":1,"setInterval":1}` + `hookCalls changed` |
| 3（更新台账后） | 同上 | 换成 `hookCalls debt increased from 15 to 18`、`nonTriviaTokens debt increased from 15779 to 15786` |
| 4（抽取后） | `Astryx surface inventory` | `astryx surface inventory is stale; run: npm run astryx:surface-inventory:write` |

## 触发条件

PR 把秒表（setInterval/clearInterval + useState/useRef/useEffect 各 +1）直接写进了 `apps/desktop/src/renderer/agent-graph-panel.tsx`。这个文件是仓库"架构棘轮"重点看管的 legacy 文件。

## 规则拼图（逐条验证过）

### 基础设施

- 台账：`apps/desktop/renderer-architecture.json`
- 检查脚本：`apps/desktop/scripts/check-renderer-architecture.mjs`，支持 `--write`（重生成台账）和 `--base <commit>`
- CI 步骤名 `Check renderer architecture`，等价本地命令：`node scripts/check-renderer-architecture.mjs --base <PR base SHA>`
- 本地跑需要 `@babel/parser`：`npm install --no-save --ignore-scripts @babel/parser`

### zone 划分（`zoneFor`）

| 路径 | zone |
| --- | --- |
| `src/renderer/features/<name>/**` | feature |
| `src/renderer/{application,bootstrap,composition,shell}/` | 同名 zone |
| `src/renderer/platform/desktop/` | platform |
| 其余 `src/renderer/**` | **legacy** |

### legacy 文件的两层冻结

legacy 文件登记在台账 `legacyAppShell.files`（根文件如 app-shell.tsx）和 `legacyAppShell.closure`（传递闭包如 agent-graph-panel.tsx），指标分两组：

| 指标组 | 适用段 | 内容 |
| --- | --- | --- |
| capability 指标 | files + closure | bridgePaths、dependencyPaths、environmentCapabilities、hookCalls、lifecycleMethods、actionFactories、unresolvedDependencies |
| 全量指标 | 仅 files | 上面全部 + importDeclarations、importSpecifiers、**nonTriviaTokens** |

两层校验，缺一不可：

1. **台账一致性**：分支实际 vs 分支台账 → 台账 `--write` 可修。
2. **单调棘轮**：分支实际 vs **base 树重推导值**（脚本用 git worktree 物化 base 提交重新分析源码）→ **改台账没用**，这是设计意图：数字只许减不许增。

app-shell.tsx 属于 files 段，**连一个 token 都不许涨**——加一个 `renderLiveStatus={X}` prop（7 个 token）直接死。

### 关键禁令（每条都在本地验证过会报什么错）

| 规则 | 后果 |
| --- | --- |
| 只剩 platform zone 可以直接调浏览器环境 API（setInterval 等） | feature/application/composition/shell 里写 setInterval → `xx code directly accesses browser environment capabilities` |
| feature 禁止 import platform/shell/bootstrap/composition/main/preload | `feature imports a forbidden Desktop/shell module` |
| feature 禁止 import 其他 feature | `feature X imports feature Y` |
| feature/新增文件不许进 legacy 闭包、legacy 不许引 feature 私有路径 | feature 引 legacy 是新边 → 禁止；引 feature 必须走 index 公共入口 |
| dependencyPaths 按 **import 语句的模块名** 计数 | 往**已存在**的语句里加具名导入 = 计数不变 = 免费；新增一条语句 = 总量 +1 = 死（替换式迁移除外） |
| composition → legacy 只有一条合法边 | `LEGACY_APP_SHELL_ADAPTER → LEGACY_APP_SHELL_MODULE`，其余全禁 |
| 检查器只扫 `apps/desktop` 的 src/stories/e2e | **packages/ui 完全不在扫描范围内** |

## 修复方案（最终落地）

把秒表整体抽到扫描范围外的共享 UI 包，面板往已有 import 语句加一个 specifier：

- 新增 `packages/ui/src/agent-graph-live-status.tsx`：`AgentGraphLiveStatus` 组件（spinner + 秒表 + children 包裹），直接用 setInterval（包内无棘轮）
- `packages/ui/src/index.ts` 导出
- 面板：`import { AgentGraphLiveStatus, IconButton, ... } from '@maka/ui'`（原语句加名，`dependencyPaths['@maka/ui']` 计数不变），JSX 用组件包住原状态行，删掉内联秒表
- 新文件登记：仓库根跑 `npm run astryx:surface-inventory:write`，更新 `docs/astryx-surface-file-inventory.md/.paths`
- **台账零改动**——capability 指标全部回到 base 基数

走过的弯路（都被规则拦下，别再试）：改台账、render-prop 从 app-shell 注入（app-shell token 冻结）、feature 组件 + services context 注入 ticker（feature 禁引 platform，feature 内禁 setInterval）。

## 2026-09-08 复发记录（#4815，两条新弯路 + 一条铁律补强）

为加 `allowAttachmentOnlySend` 又撞了一次 files 段精确相等棘轮，两条文档没记过的新弯路：

1. **token 抵消法**：在冻结文件里提取重复表达式成 const，把净 token 变化凑回 0——本地对 upstream/main 能凑绿，但 CI 的 base 是 PR merge base，账本值随 base 漂移，任何对文件的改动都过不了稳定的检。
2. **`--write` 改账本**：单调棘轮那层拿 base 树重推导值比对，改自己账本没用；且"账本一致层"被改过=自欺，必须 `git checkout` 还原。

**铁律补强：冻结文件的唯一稳态是字节不动。** opt-in 这类必要改动挪去非冻结面（本次挪进 side-chat panel 的 Composer）；git merge 会对上游重构过的同名文件静默保留你的行——推送前 `git diff upstream/main -- <冻结文件>` 必须为零。

同轮另撞一条非 token 规则：feature 测试从 `ports.js` 深链类型 → `feature imports must use index, testing, or stories`；没有的 re-export 加进 `testing.ts`。

失败样本：11aa81e32 的 CI（`Check renderer architecture` 两行报错），修复样本：816e6dc5a。

## 验证方式

```bash
## 桌面架构检查（必须 pass）
cd apps/desktop && node scripts/check-renderer-architecture.mjs --base <merge-base SHA>

## ui 包类型检查 + 单测（预存在的 @maka/core 未构建错误先 cd packages/core && npm run build）
cd packages/ui && npx tsc -p tsconfig.json --noEmit
npx tsx --test src/__tests__/agent-graph-live-status.test.tsx   # 4 个用例全过

## surface 清单
npm run astryx:surface-inventory   # 仓库根，输出 coverage: ok
```

最终 CI：test job 19m52s pass。

## 预防建议

1. 动 `apps/desktop/src/renderer` 下任何 legacy 文件前，先本地跑一遍 checker，比推送后等 CI 快 20 分钟。
2. 面板要加定时器/Hook/新 import 之前，默认自己被冻结——新逻辑去 `packages/ui` 或对应 feature。
3. packages/ui 新增任何源文件，提交前顺手跑 `npm run astryx:surface-inventory:write`。
4. 台账 `renderer-architecture.json` 出现 diff 通常是别的文件变了，先弄清谁变的再决定提交还是回退；它救不了单调棘轮。

## 第二轮 rebase 补充（review 修复推送后）

PR 等 review 期间 main 会继续移动，`mergeable_state` 变 `dirty` 就是冲突信号，处理方式：

- 顺序：`git checkout main` → `git merge --ff-only upstream/main` → 回 PR 分支 → `git rebase main`。**ff-only 必须在 main 分支上执行**——在 feature 分支上跑会对 feature 分支做 merge 然后 abort（无害但白做一次）。
- 这次唯一冲突是 `docs/astryx-surface-file-inventory.md`（自动生成文件，两边都动过）。生成文件冲突**不手改**：`git checkout --ours <file>` 清掉冲突标记后跑 `npm run astryx:surface-inventory:write` 按当前源码树重新生成，再 `git add`、`git rebase --continue`。
- rebase 到新 base 后，本地以**新 main SHA** 为 `--base` 再跑一遍 checker 确认，再推。
- `stableArgsJson` 这类新逻辑 rebase 后如果 main 也改了同一文件，注意语义冲突（git 能自动合并但行为打架），本轮未遇到，记录备查。

## 2026-09-13 追加：棘轮冲突解法（merge 场景，WorkHub 案例）

merge upstream/main 撞进 `renderer-architecture.json` 时，冲突两边（HEAD 值 / upstream 值）**都不要信**——两边各自改过目标文件，合并后的真值大概率是第三个数。

解法顺序：
1. 先把代码冲突全部解完（冻结文件的最终内容定了，token 数才有意义）。
2. 直接跑 plain 模式 `node scripts/check-renderer-architecture.mjs`（不带 `--base`）：它对比台账与实际，报 `expected X, received Y`——**received 就是真值**，写回台账。
3. 本机只有 `--base` 模式 segfault，plain 模式稳定可用；CI 与 plain 模式一致。
4. 复跑确认 `Renderer architecture check passed.`

实测案例：#4815 九撞合并，app-shell.tsx 冲突 HEAD=13523 / upstream=13402，真值 13394（两边各改过，净变小是合法的——棘轮只禁涨不禁缩）。

另：`nonTriviaTokens` 的计数含**行注释**（每行注释各计 1 token）——改冻结文件里注释的行数等于改 token 数，注释必须保持基线行数；side-chat 等 biome 忽略目录里的缩进问题 biome 不报，需手工对齐。

## 2026-09-13 追加：merge 跑步机与 epoch 撞号（#4815 九撞沉淀）

- **多 merge commit 的长命分支别再 rebase**：分支已经靠 merge 追 main 时，继续 `git merge upstream/main` + 解冲突才是对的；rebase 会把几十个 merge 提交全部重写。
- **epoch 撞号解算口诀**：常量取 `main 当前号 + 1`（顺延最大号），epoch 日志保留上游全部条目、自己的条目改记新号；`node scripts/protocol-epoch-check.mjs --base upstream/main` 输出 "epoch moved" 且 exit 0 才算过。
- **守卫读的是提交不是暂存区**：`--base` 模式取 `HEAD:文件`，合并进行中（未 commit）时读到旧值假报"回退"——**先 commit 合并再跑守卫**。
- **防撞号三查**：push 前 `git fetch upstream` 重跑守卫；合并窗口期（别人连合 protocol PR 时）当天内尽快合并；CI 红先看是不是又撞了。
- **冻结文件检查**：merge 后 `git diff upstream/main -- <冻结文件>` 必须为空，git 会静默保留你的行。
