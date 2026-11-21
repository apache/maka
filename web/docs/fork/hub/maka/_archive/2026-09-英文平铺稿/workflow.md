# 从零到熟练：给 apache/maka 提 PR 的完整工作流

> 配套文档：[journal/](../../journal/README.md)（每单必记的经历台账）、[cases.md](cases.md)（关键转折的深度复盘）。
> 本文所有命令都在本机（Windows + Git Bash）实际跑通过，案例用的是 2026-09-01 当天完成的第一单：issue #3825 → PR #4481。
> 每完成一单，把新学到的可复用要点追加到文末「单课沉淀」区；值得展开的决策转折写进 cases.md。

## 全景：一张图记住整件事

```
L0 环境（一次性） → L1 选题 → L2 认领 → L3 分析 → L4 修复 → L5 验证 → L6 提交与跟进
   半小时搞一次        每单      1条评论     读代码      最小改动    诚实跑检查    push + 开PR + 记录
```

一个新手最该先建立的认识：**这不是五个技术步骤，而是一套信用积累系统。** 维护者凭什么合并陌生人的代码？凭每一步都留了可核验的痕迹。下面每一层都在讲"怎么留下让别人放心的痕迹"。

---

## L0 环境（一次性准备，约半小时）

| 事项 | 命令/位置 | 说明 |
| --- | --- | --- |
| fork 仓库 | GitHub 网页上点 Fork | 已有：`ggbdpq/maka` |
| 本地克隆 | `E:\ggbdpq\gh-fork\maka`，remote `origin` 指向你的 fork | 保持 `main` 跟随上游即可 |
| Git 凭据 | Git Credential Manager 存有 github.com 的 ggbdpq 令牌 | push 和 API 调用都靠它，`gh` CLI 本机没装，不用管 |
| Node | v24.19.0，经 fnm 管理 | 见下方"两个本机陷阱" |
| 依赖 | 仓库根 `npm install --ignore-scripts --no-audit --no-fund` | `--ignore-scripts` 跳过 electron 等大体积后安装，写代码用不到 |

### 两个本机陷阱（先记住，能省两小时）

1. **cd 进仓库会触发 fnm 钩子报错**，报错以退出码 1 结束时会把 `&&` 命令链拦腰截断，看起来像"git 坏了"。绕法：git 操作一律用 `git -C "E:\ggbdpq\gh-fork\maka" ...`，不 cd；必须 cd 时先 `eval "$(fnm env)" 2>/dev/null`。
2. **node_modules 可能是半截安装**（现象：包都在但 `node_modules/.bin` 是空的，报"biome 不是内部或外部命令"）。上面那条 install 命令补齐即可，本机实测 1 分钟（bin 从 0 → 207 个）。

**自检**：`git -C <仓库> status` 正常出结果；`node -v` ≥ 22.19.0；`ls node_modules/.bin | wc -l` 大于 0。

---

## L1 选题：研究 issues

### 去哪找

| 池子 | 规模（2026-09-01） | 入口 |
| --- | --- | --- |
| good first issue | 29 | https://github.com/apache/maka/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22 |
| bug | 59 | 同上，换 label `bug` |
| help wanted | 71 | 同上，换 label `help wanted` |

另有 #3522 文档审计追踪 issue（一组文档一个 PR，维护者背书，合并快）。

### 怎么判断"这单我能做"

按顺序过四道闸，全过才接：

1. **没被认领**：评论数为 0 或评论里没人说 take；issue 页 assignees 为空。
2. **范围小**：issue 里能指到具体文件/函数；描述里给出复现步骤或已知根因的优先。
3. **我能验证**：修完我能在这台机器上跑出证据（比如 Windows 路径 bug，本机就是 Windows，天然优势）。
4. **和我的知识有交集**：上次侦察过的子系统（memory、storage、cli 状态栏）优先，上手快、判断准。

**案例**：#3825（statusline 在 Windows 不缩写主目录路径）四道闸全过——0 评论、指到 `packages/cli/src/pi-transcript.ts` 的具体函数、我在 Windows 上可复现、cli 状态栏逻辑一读就懂。同一批候选里 #4002 虽然更简单（纯补测试），但已有人留言带计划认领，果断放弃——**跟人抢单是最差的开局**。

### 用 API 批量筛（网页看不过来时）

```bash
curl -s "https://api.github.com/search/issues?q=repo:apache/maka+is:open+is:issue+label:%22good%20first%20issue%22&per_page=30&sort=created&order=asc"
```

注意：github.com 网页在本机经常抓取超时，**数据一律走 api.github.com**，稳定。

**自检**：能对候选说出四道闸各自的结论；知道它属于哪个子系统。

---

## L2 认领

CONTRIBUTING 的规则是机器执行的：**在 issue 下发一条评论，正文必须是单独一个词 `take`**，放弃用 `untake`，其他文字不触发认领。

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/apache/maka/issues/3825/comments" -d '{"body":"take"}'
```

令牌只在同一命令的变量里流转，**永远不要 echo 或写进文件**。

认领后立刻建分支。**每天开工第一步：先同步远程最新代码**（一天一次就够，不用每单同步），新分支一律从 `upstream/main` 切，**绝不从本地 main 切**——本地 main 常年落后上游几十个提交，从它切的分支会复现上游早已修掉的 bug 和 flaky，白白烧掉几轮 CI（#4514 连挂两轮 e2e，根因就是分支基点落后 39 个提交）：

```bash
git -C "E:\ggbdpq\gh-fork\maka" fetch upstream main
git -C "E:\ggbdpq\gh-fork\maka" checkout -b fix/statusline-shorten-cwd-windows upstream/main
```

要点：`checkout -b` 不写起点时从当前 HEAD 切，等于从本地落后的 main 切——所以**起点 `upstream/main` 必须显式写**，且写之前必须先 fetch（fetch 的是远端引用，不更新你的本地 main，也不碰工作区）。

分支名惯例：`fix/短横线描述` 或 `docs/短横线描述`。

**新手误解纠偏**：认领不是"说一句我要做"，而是对维护者的一个公开承诺——issue 会挂上你的头像，别认领后玩失踪；做完（或放弃）都要有下文。

---

## L3 分析问题

顺序固定，不要跳：

1. **先跑再说**：能复现的先复现（Windows bug 在本机直接跑）；不能复现的至少把 issue 的每条声明对着代码核实。
2. **核对 issue 与当前代码**：issue 里的行号经常过期（代码在动），函数名/行为描述比行号可信。#3825 说问题在 `pi-transcript.ts:1520`，实际已漂到 1925 行，但函数行为和描述完全一致——这单就是真问题。
3. **读透现场**：函数谁在调、测试怎么组织的、现有测试怎么断言的。#3825 案例里发现 `shortenCwd` 早就预留了 `homeDir?` 注入参数但没导出——导出它就是现成的测试路径，不用新造。
4. **查仓库自己是否已追踪**：grep 相关关键词，看有没有 open issue 在讲同一件事（决定你该修 bug 还是先开讨论）。

产出物是一句话根因，例如：*"缩写失效是因为用 `home + '/'` 前缀匹配，Windows 路径的反斜杠永远匹配不上。"* 说不出这句话就不许进 L4。

---

## L4 解决问题

按"懒阶梯"从上往下找方案，停在第一级够用的位置：

1. 仓库里已有现成函数/模式？复用。
2. Node 标准库能做？用标准库。（#3825 的修法就是 `path.relative`，平台差异、大小写、盘符全由标准库兜住，一行顶十行）
3. 都没有，才写最小的新代码。

配套硬规则：

- **改公共函数先 grep 全部调用方**，确认改动影响面，别只顾 issue 里描述的那条路径。
- **测试跟着修走**：修 bug 必须带一个"修前会挂、修后会过"的用例；测试风格照抄同文件现有用例（`node:test` + `assert/strict`，测试名带 issue 号如 `(#3825)`）。
- **平台相关的用例用 skip 守卫**：`{ skip: process.platform !== 'win32' }`，让 POSIX CI 和 Windows 机器各自跑各自的部分。
- **新文件必须带 ASF 许可证头**（照抄同目录任意文件的头部），改老文件没这个问题。
- 想给代码加注释时只写"代码本身说不清的约束"（比如"余数保留原生分隔符"），不写"我为什么这么改"。

---

## L5 验证

### 验证矩阵（每次全跑，顺序执行）

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| 目标套件 | `node --test dist/__tests__/<文件>.test.js`（在 packages/cli，先 `npm test` 构建过一次） | 0 fail；新增用例全过 |
| 全仓格式 | `npm run format:check` | "Checked N files. No fixes applied."（格式不合规先 `./node_modules/.bin/biome format --write <文件>`） |
| ASF 头 | `npm run check:asf-headers` | Every source file carries the ASF header |
| 相关包构建+测试 | packages/cli 下 `npm test` | build 成功；套件失败逐个定性（见下） |

### 失败定性三步（这是 L5 的真功夫）

套件红了不要慌，按顺序问：

1. **跟我的改动有导入关系吗？** grep 失败模块是否 import 我改的文件。零关系 → 大概率预存问题。
2. **单跑还挂吗？** 本机实测：5 个 spawn 重度的脚本测试合跑互相踩全红，单跑全绿——这是并发踩踏，不是代码 bug。
3. **仓库自己是否已追踪这个问题？** 例：`runtime-host-update-reconciliation` 的 `fsync EPERM` 就是 open issue #3898 追踪的 Windows 已知缺口。

定性为环境/预存问题的，**在 PR 里如实写明**（哪条失败、什么错误码、指向哪个已知 issue、为什么与本改动无关），绝不能藏着或谎报全绿。透明本身就是信用。

---

## L6 提交 PR 与跟进

### 提交

提交信息三要素：`type(scope): 摘要` + 正文讲清根因与修法 + 尾注。AI 参与了实质工作就带 `Generated-by` 尾注（这是仓库的明文要求）：

```
fix(cli): abbreviate home-relative Windows paths in the status line

<根因一句话>

<修法与测试安排>

Fixes #3825

Generated-by: GLM-5.3-Flash (ZCode)
```

`Fixes #N` = 合并即关单；只是背景引用用 `Refs #N`。写消息用文件：`git commit -F <消息文件>`，免引号转义。

### 推送与开 PR

```bash
git -C "E:\ggbdpq\gh-fork\maka" push -u origin <分支名>
```

`gh` 没装，用 API 开 PR（PR 正文先写成文件，走模板四段：Summary / Verification / AI use / Checklist；行为有变的在最后一项勾 Yes 并说明）：

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/apache/maka/pulls" \
  -d @payload.json
# payload: {"title":"...","head":"ggbdpq:<分支名>","base":"main","body":"<正文>"}
```

### 提交后

- **当天**：在 [journal/](../../journal/README.md) 记一节（动机/改动/验证/后果/经验一条，模板在文内）。
- **3 天无审核信号**：PR 下留一句 gentle ping（一句话即可，别催第二遍）。
- **收到 review 意见**：修复优先级最高，压过一切新单；每条意见都要有回应（改了 or 解释为什么不改）。
- **参照系**：同仓库文档审计 PR 有当天 19 分钟合并的记录（#3555），代码 PR 正常也要等维护者轮次，别用小时级预期折磨自己。

---

## 常见坑速查表（本机实测）

| 症状 | 根因 | 绕法 |
| --- | --- | --- |
| 命令链莫名中断，只看到 fnm 报错 | cd 钩子以退出码 1 截断 `&&` | 用 `git -C`，或先 `eval "$(fnm env)" 2>/dev/null` |
| `biome 不是内部或外部命令` | node_modules 半截安装，`.bin` 为空 | `npm install --ignore-scripts --no-audit --no-fund` |
| 网页抓取 github.com 超时 | 网络路径不通 | 数据一律走 `api.github.com` |
| 测试日志看不到摘要 | `npm test \| tail -30` 把中间输出吞了 | 输出重定向到文件再 grep |
| 脚本测试合跑全红单跑全绿 | spawn 并发互踩 | 分文件单跑定性，别当代码 bug |
| PR 里想引用行号 | 代码在动，行号会漂 | 引函数名/行为，不引行号 |
| 证书令牌泄漏风险 | echo/落文件 | 只在单命令的 shell 变量里流转 |
| PR 连续两轮在**不同** e2e spec 上红 | 分支基点落后，在复现上游已修掉的 flaky | `git log <基点>..upstream/main -- <e2e目录>` 找防抖修复；rebase 到最新 upstream/main 后还红，才轮到"请人 re-run" |
| PR 标题被指出没带 scope | CONTRIBUTING.md:85：标题=`<type>(<scope>): <summary>`，且 squash 后标题就是 main 的提交名 | 开 PR 前读 CONTRIBUTING 提交规范段；整行照抄同系列已合并单的标题再改名词（审计轨=`docs(architecture)`） |
| CI 挂 "inventory is stale / does not match generator output" | 给生成文档手加了 frontmatter（--check 与再生成输出逐字节比对） | 改任何 docs/ 文件前先 grep 文件头 `Generated by`/`Do not edit manually`，或 grep scripts/ 找谁写它；生成文档零改动 |
| Build CLI 挂 `audit failed {"summary":"","detail":""}` | npm audit 注册端抽风，与 PR 内容无关 | 本地复跑同条 audit 命令确认恢复后，amend 换 SHA 强推重触发（rerun API 需 admin 权限） |
| 测试卡死在 `Downloading Electron binary...` | 上游 bump 了 electron 版本，`--ignore-scripts` 安装跳过二进制下载，旧缓存不匹配 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`（镜像秒下），再重跑测试 |
| 推送后 CI 挂 Check formatting | 手写的多行函数调用不合 Biome 单行宽度（09 号文档红3 的第 N 次复发） | **push 前本地必跑 `npm run format:check`**，别让 CI 当格式检查器；违规文件用 `node_modules/.bin/biome format --write <file>` 修 |
| merge/reset 落到了错误的分支上 | checkout 失败退出码被 `| tail` 管道吃掉、或 reset 前没验分支（本session 两次踩） | 破坏性操作与分支校验写**同一条命令**：`B=$(git branch --show-current); [ "$B" = "期望分支" ] && git reset/merge ...`；`stash pop` 前先 `stash list` 确认栈顶是自己刚压的 |
| CI 挂 `Check renderer architecture`：`nonTriviaTokens changed; expected X, received X+1` | app-shell.tsx 在冻结区（legacyAppShell.files），token 数与账本**精确相等**，加一个 prop 都死；改台账=作弊且基线随 merge base 浮动（03-maka机制与棘轮.md 早写明，本次没读付出两轮 CI） | **冻结文件一个字节不碰**：改动挪去非冻结面（如 side-chat panel）；开工碰 desktop 前先读 `03-maka机制与棘轮.md`；本地 `node scripts/check-renderer-architecture.mjs --base upstream/main` 过了再推 |
| CI 挂 `feature imports must use index, testing, or stories` | 测试/feature 代码深链 `ports.js` 等私有路径 | feature 类型 import 只走 index/testing 入口；没有的 re-export 加到 testing.ts |
| `npm install --ignore-scripts` 后 ui/desktop tsc 报"属性不存在" | root postinstall 的 patch-package（apply-dependency-patches.mjs）被跳过，@astryxdesign/core 等六个包补丁缺失，酷似 main 预存类型断裂 | 补跑 `node scripts/apply-dependency-patches.mjs` 再重建；定责三步法之前先确认补丁跑过 |

---

## 从熟练到高手的下一步

1. **当前水平**（L1-L6 能独立走通）：认领轨小修 + 单文件文档审计，即 #3825 这类单子。
2. **近期升级**（9 月内）：接 #3522 审计轨的中型组（3-5 份文档，如 A3 Workflow state，issue 已标注 SQLite 表名线索）；开始碰 desktop/runtime-host 热点区的 bug 单。
3. **进阶标志**（10-12 月）：能独立走功能轨——先在 Discussions/Feature issue 里把方案谈拢再动代码（参考仓库里两个已核实的缺口：结构化记忆检索无消费方、PENDING.md 审查队列未接桌面端）；一个 PR 里能预判维护者会问什么并提前写进 Verification。

每完成一单，回 L1 检查四道闸有没有新的体会；每踩一个新坑，补进上面的速查表。这份文档是活的。

## 单课沉淀（每单追加一条，写"下次直接能用"的要点）

<!-- 追加格式：### #PR号 ｜ 一句话主题 → 2-4 条要点 -->

### #4481 ｜ statusline Windows 路径缩写
- issue 行号会过期，核对行为描述而不是行号。
- `homeDir?` 这类孤儿可选参数是前人留的测试注入点，导出函数即得完整测试路径。
- 平台语义函数（path/fs）的用例必须按 `process.platform` 用 skip 守卫拆分，否则必挂一半平台。
- 套件失败先定性再动手：查导入关系 → 单文件重跑 → 查仓库已知 issue（本单的 fsync EPERM = #3898 追踪的缺口）。
- 后台跑测试别用 `| tail`，摘要会被吞；输出重定向到文件再 grep。

### #4485 ｜ 快捷键标签平台正确显示
- 显示 bug 先画「数据 → 解析 → 渲染」全链路，逐环定性，真实病灶往往比 issue 列的少一半（本单 30 处 → 实改 2 处）。
- 双用途数据（既展示又解析成快捷键注册）不能按显示需求单方面改，改了热键就坏。
- 纯逻辑放进有测试跑道的包（ui 有 node --test），渲染残壳留在原文件；写之前先确认验证跑道在哪。
- 平台判定沿用设计系统 Kbd 的既有约定（navigator.platform 回退），保证相邻显示一致。

### #4488 ｜ flaky 的 TLS 握手测试
- intermittent flaky 先查"两套超时合约并存"：单次阻塞操作的超时与整体 deadline 各自为政，负载下必炸；修法是把每次等待绑到剩余总预算，不是盲加重试或调大数字。
- 三个信号锁定这类根因：间歇失败 + 只有轮次最多的子用例中招 + 每轮共享一个独立计时器。
- 报"Cannot reproduce"前先实测当前 main：issue 里的报错文案在代码库 grep 不到，多半已被上游改掉（本晚的 #3938 就是这么放弃的——放弃也是选题的一部分）。

### 2026-09-02 批量日 ｜ 5 单并发的工作法升级
- **先 take 再动手**：0 评论≠没被认领，评论区和 assignee 要逐个点开看；批量筛池用全量 `/issues` 列表比按标签搜更全（能捞到没打标签的新单）。
- **全量失败的定性升级**：stash 改动 → 干净树跑同一批失败套件 → 对比失败数/名单逐位一致 = 预存问题铁证，一份证据同时服务自检和 PR 表格。
- **上游 main 自己会红**：ui typecheck 因依赖未发布 canary 而挂时，确认 `noEmitOnError` 未设置（tsc 照样 emit）→ 套件照跑 → PR 如实记录预存错误清单，不背锅也不谎报。
- **每个分支独立重建依赖**：`packages/*/dist` 是 gitignored 的跨分支共享物，切分支后 ui dist 还是上个分支的产物，desktop typecheck 会报出"只存在于分支间"的幽灵错误；切分支先重建被依赖包。
- **git stash 用 `git -C`，别在 cd 后的 `&&` 链里做**：fnm 钩子一次截断能把 stash/pop 状态搞成半完成；tsc 永远用 `node_modules/.bin/tsc` 绝对路径（npx 会拉到假 tsc 包）。
- **文档审计的先例优先**：查同系列已完成组怎么处理字段（无 frontmatter 的文档不加、有 `last_verified` 的才刷新），一行都不多改；"文档自称冻结的常量"先 `git log -S` 查升版记录再判漂移。
- **被依赖阻塞的 take**：地基 slice 被他人认领时，留依赖评论保留 take（排在依赖链末端不挡任何人），把今晚的槽位换成审计轨——不空转也不违约。

### 2026-09-05 CI 自检日 ｜ 标题 scope 与生成文档两连坑（#4801/#4506/#4816）
- **标题必须带 scope**：CONTRIBUTING.md:85 明确 `<type>(<scope>): <summary>`，squash 合并后标题就是 main 上的提交名。当初照抄了同系列已合并单（#4518 `docs(architecture): audit ...`）的标题句式却漏了括号，5 单全中；开 PR 前先读 CONTRIBUTING 的提交规范段，或整行复制同系列标题再改名词，别只抄句式。
- **生成文档零改动**：`docs/windows-test-inventory.md` 和 `docs/astryx-surface-file-inventory.md` 都是生成物，CI 的 `--check` 与再生成输出逐字节比对，手加 frontmatter 必挂（#4801 自己踩、#4816 换个会话又踩——教训没写进文档就会重复犯）。改任何 docs/ 文件前：grep 文件头 `Generated by`/`Do not edit manually`，或 grep scripts/ 找哪个脚本写它；生成文档保持字节不变，核验结论写进 PR 正文即可。
- **CI 红叉排查套路**：`commits/{sha}/check-runs` 拿失败项 → `runs/{id}/jobs` 定位步骤 → 拉 job 日志 grep `##\[error\]`；`audit failed {"summary":"","detail":""}` = npm audit 注册端抽风，与 PR 内容无关，本地复跑同条命令确认恢复再触发。
- **无 admin 重跑 CI 的办法**：rerun API 403，就 `commit --amend --no-edit` 换 SHA 强推重触发（内容零变化，diff 新旧 head 为空先验证）；批量改历史提交在独立克隆（make-ggbdpq/maka）里 checkout -B + amend -F + force-with-lease，别碰正在用的工作区。

### #4814/#4815 ｜ 门控测试、epoch 同号撞车与退出链路取证
- 测试等一个"由构造保证"的时点，不赌固定时长：owner-loss 场景用 test-only 入口把 composition 创建停在 release 文件后并写 stall 标记，kill 前先等标记——顺序由构造保证。固定 sleep 有两个隐藏漏洞：测试端停顿超过 sleep 会静默变成 post-bind 场景；sleep 只是附加延迟不是启动上限，"sleep+grace 覆盖全部合法退出"的推导不成立。
- epoch 同号撞车（两个 PR 各自 bump 到同一号，合并时互相吸收）：解法=常量取 main 数字+1，epoch 日志保留上游全部条目、自己的条目改记新号；用 `node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD` 验证输出 "epoch moved" 且退出码 0。
- 断言观察真实 PID 而非 kernel 的 `closed` promise（资源清完≠进程退出）；本地 Windows 对这类孙进程是强杀（无 JS exit 事件、无 uncaught 探针响应），探针全静默=被外部终止，跨平台结论只认 CI。
- 调试后台进程退出链路：tmpdir 时间戳文件探针 + `process.on('exit'/'uncaughtException')` 落盘处理器，比读代码猜机制快；探针全静默本身就是"被强杀"的证据。
- 定性"预存类型错误"三步：`git diff main --stat -- <目录>` 看差异面 → 看 upstream 同款测试代码 → grep 自己的文件是否在报错清单；三步都干净就是 main 预存，别顺手修（ui 包 4 个类型错误实证）。

### #4815 二轮 ｜ 冻结区棘轮、composer 并集与 admission 边界统一
- **上游 opt-in 开关撞上本 PR 无条件放行时，并集=按语义分家**：#5003 的 `allowAttachmentOnlySend` 管"附件独发"、#4804 管"quote 算内容"——前者归上游开关、后者无条件放行，再给没传开关的既有调用面（side-chat panel）补 opt-in；先 grep 全仓调用方确认开关语义是活的再定解法。
- **同一结构化消息只许一个清理边界**：staged quotes 走 `consumeOnAdmission` 后，新加的附件消费也挂同一 admission 回调（send/steer 的 `onAdmitted` 参数）；panel 不看乐观返回值清东西——`outcome_unknown` 期间一切保持 staged，late admitted 在 reconcile 时补触发、retracted 原样释放可重试。
- **测试 harness 的回调包装改签名时参数类型显式写全**：隐式 any（TS7006）会把全部既有单参调用点连锁炸成 TS2554。
- **跨会话接力前先读 03-maka机制与棘轮.md**：app-shell 冻结区/改台账必死都是 06 号写过的旧知识，本轮没读付出两轮 CI；git merge 对上游重构过的同名文件会静默保留你的行——**推送前 `git diff upstream/main -- <冻结文件>` 必须为零**。

### #5265 ｜ TUI 测试输入分块、biome 段错误与本地 exclude
- **TUI 测试喂键必须 text 与 '\r' 分两次 `terminal.input()`**：`input('text\r')` 整块进编辑器会被当 paste 缓冲，内嵌回车不触发提交（waitFor 超时且无任何报错指向真因）；怀疑提交没发生时先对照现有测试的喂键写法，再怀疑实现。
- **红证要能编译**：行为变更先加类型面（接口字段）再跑测试，红的就是行为而不是 TS2339；类型+行为一起留到实现后，红证就没了。
- **biome 整仓 format:check 在本机段错误 139（确定性复现）**：退路=对改动文件逐个 `biome check --formatter-enabled=true --linter-enabled=false <file>`（exit 0 即格式干净），PR 里如实写"整仓闸由 CI 跑"。
- **`.mimosa/` 未被 ignore 会毒化 asf-headers 与 git status**：写进 `.git/info/exclude`（纯本地、不 tracked、不进 PR）即可，别去改上游 .gitignore；check 脚本设计上"untracked 且未 ignore"就审计，本地 scratch 本就该走 exclude。
- **基线对照别用 stash**：stash 只回退 tracked 源码，dist 构建产物还在，旧源码编不过（联合类型来自新 dist）反而浪费时间；用 `git worktree add` 物化干净提交点独立建链跑测试，结论才站得住。
- **cli 包的 npm 名是 `maka-agent` 不是 `@maka/cli`**：`npm --workspace maka-agent run build`；其 build:workspace-deps 里还藏着 @maka/mcp 和 @maka/eval，漏建会报 TS2307。
