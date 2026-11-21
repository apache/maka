# apache/maka 八个 PR 的评审修复与 #5805 依赖审计九层排障

> 时间跨度：2026-09-28 ~ 2026-09-29（Zcode 会话）
> 仓库：apache/maka（fork: ggbdpq/maka，本地 `E:\ggbdpq\gh-fork\maka`）
> 活文档：`E:\ggbdpq\gh-fork\docs\maka\pr\`（**已随仓库搬家从 `E:\guahub\docs\...` 迁移**，旧路径不存在）

---

## 一、问题背景与目标

用户在 apache/maka 持续贡献，本会话内 open PR 从 4 个涨到 8 个。目标：

1. 按固定开场流程（fetch upstream → 查在途 → 扫新评论 → 探冲突 → 修复）处理全部在途 PR 的 review 意见与 CI 红；
2. CI 红逐一定性（自己引入 vs 上游预存 vs 环境抖动），不谎报全绿；
3. 新单 #5805 的依赖审计门九层"洋葱"红全部剥到 18/18 全绿；
4. 交付可直接发微信群的两行版 review 求审消息；
5. 附带任务：gh-fork 下提交身份统一为 `ggbdpq <ggbdpq@gmail.com>`。

**最终结论**：八单全部进入"代码工作完成、CI 全绿、对最新 main merge-tree CLEAN、无未回应 review 意见"的等审稳态。#5805 经九轮修复达 18/18 全绿。

---

## 二、八个 PR 的最终状态与关键修复

| PR | head | 状态 | 本会话关键动作 |
|---|---|---|---|
| #5265 TUI rewind quotes | b48832dbf | 绿，Changes requested 三轮全闭环 | retracting 标志（toggle + mid-turn /session + idle /session 三个入口 + 重入拒绝）；部分由并行会话接力 |
| #5274 quotes restage | e39891bf | 绿，确认无遗留 P0-P3 | 空行修复、4 个 P2、Regenerate footer、5 个 P3；后续增量由并行会话接力 |
| #5709 usage filter | 46e457cdb | 绿 | epoch 撞号三次（196→197→198→199），每次按口诀顺延 |
| #5744 allowlist | 58d09e0a8 | 6/6 绿 | fsevents P2、防漂移守卫脚本、#4865 同名撞车协调评论 |
| #5791 startup profile | c044a0d2e | 13/13 绿 | review 正面，无待办 |
| #5800 hydration benchmark | 01eee8c5c | 绿 | 幻觉 finding 澄清评论（"openforai PASS"行不存在） |
| #5804 usage tab-entry spec | 1128be449 | 绿 | 同上（姊妹单同款幻觉） |
| #5805 retire benchmark | edd1df172 | **18/18 绿** | 九层依赖审计排障（见下） |

另报上游 issue **#5777**（main 预存 ACP 测试超时，父子提交对照定性）。

---

## 三、#5805 依赖审计九层"洋葱"排障（本会话最大工程）

每修一层暴露下一层。完整链条与修法：

| 层 | 红因 | 修法 | 失败尝试 |
|---|---|---|---|
| 1 | undici@7.29.0 公告（GHSA-3wwx-pv8p-q78v） | 先 retrigger | **retrigger 无效**：lockfile 钉死版本，release 树按 lock 安装不重新解析 |
| 2 | lockfile 钉死 7.29.0×3 + 6.28.0 | package.json overrides 按依赖者钉修复版 | 裸 `npm update` ERESOLVE（peer 冲突），需 `--legacy-peer-deps` |
| 3 | update 重解析**静默剪掉 6 个无关解析条目**（gpt-tokenizer/stylex 链/invariant）→ npm ci 拒装 | 完整 `npm install` 找回 | 本地 `npm install` 成功 ≠ 树自洽 |
| 4 | squirrel-windows peer 缺失（ELSPROBLEMS） | desktop devDependencies 显式声明 26.16.1 | overrides 不作用于 peerDependencies |
| 5 | ip-address@10.4.0 双 SSRF 公告 | override 钉 10.7.2（express-rate-limit/socks 范围都兼容） | — |
| 6 | @stylexjs/stylex@0.19.1 无 LICENSE | notices 生成器的 MIT override key 是**精确版本号**（0.19.0→0.19.1） | — |
| 7 | 两份 THIRD_PARTY_NOTICES 产物未随闭包同步 | `npm run generate:third-party-notices` + `--target cli` 重生成提交 | 生成器内部跑 npm ls，本地 node_modules 半删会绊倒 |
| 8 | release-cli-package.mjs **硬编码** undici@8.10.2 两处；lockfile 36 个 npmmirror URL；knip 拦 squirrel | re-key 8.11.2；URL 改回 npmjs.org（integrity 不变）；knip.json ignoreDependencies 豁免 | knip.json 单行数组超 biome 行宽 → format 修复 |
| 9 | undici 升级的**真实行为回归**：7.30.0 ProxyAgent 让 eval 测试收到意外 CONNECT；scoped-fetch-transport 挂死 755s | **版本回walk**：@ai-sdk → 7.29.1（最小修复版）、runtime → 8.10.2（原主线，本就过修复线） | 7.30.0 跨 minor 是行为风险；runtime 降 7.30.0 为 @slack peer 反而引入更大回归 |
| 10 | @slack 自嵌套 override 与 runtime dedupe 8.10.2 矛盾 → 全树 invalid | **删 override**，保 lockfile 手写嵌套条目（@slack/.../undici@7.30.0 满足 ^7 peer） | override 与手写嵌套条目互斥 |
| 11 | notices 又过期（缺 7.29.1/8.10.2）——回walk 也是闭包变化 | notices 重生成复跑（`edd1df172`） | notices 是动态产物，每次闭包变化都要重跑 |

**结果**：`edd1df172` 18/18 全绿（test attempt 1 撞 ACP 预存 flaky，attempt 2 过）。

---

## 四、核心经验（可迁移）

### 依赖审计门排障方法论

1. **CI 红先查 job 的 head_sha 与失败步骤名**——PR 的 CI 跑 merge preview 树，上游 main 自己红会传染所有未含修复的 PR（本次 d74f25311 漏改 inventory Summary 传染两单，上游以 #5779 自修）；
2. **"本机复现不了"本身是数据**——把嫌疑收敛到 CI 树与本机树的差异（merge preview）；
3. **动 lockfile 的提交必须本地 `npm ci` 自证**——`npm install` 成功 ≠ 树自洽（legacy update 静默剪枝不报错）；
4. **lockfile 连锁 checklist**（六处缺一不可）：override/update → notices 重生成 ×2（desktop + cli）→ release 闭包硬编码版本同步 → knip/registry 卫生 → 每次**版本集合再变化**（含回walk）全链复跑；
5. **npm overrides 语义三律**：不作用于 peerDependencies（只能宿主显式声明满足）；不支持范围键映射（yarn 语法）；与手写 lockfile 嵌套条目**互斥**（dedupe 实装与 override 要求不一致时逐处标 invalid）；
6. **依赖安全修复选"最小行为变化"版本**（7.29.1 而非 7.30.0）；两难时保"消费者已验证"的一侧（runtime 的 8.x 不该为 peer 降级）；
7. **ELSPROBLEMS 的排查半径是全部条目**，判定者靠 `npm ls <pkg>` 树形输出的 "from <来源>" 定位；
8. **rerun-failed-jobs 需 admin**——Contributor 只能空提交 retrigger；时序敏感测试（race/budget/timeout 语义）单条失败 + 本机三连绿即可定性 flaky。

### Review 处理纪律

1. **评论声称的修复一律 git show/grep 到 head 重验**，不信回复文字；
2. **证伪 review 前必须列全量触面（--stat 不截断）+ 全仓同名文件 grep**——本次"Regenerate footer 复活"我查错同名文件（ui 包 vs desktop contract）错判为幻觉，翻车成本是更正+道歉（hqhq1025 也栽在同一处，reviewer 逐字对比才钉死）；
3. **幻觉 finding 的正确回应是中性澄清**（陈述核查事实、请 reviewer 指明位置），不是"已更新"；
4. **PR 正文声称与实现不一致的 finding 先 diff 正文时间线**——可能已在后续提交修好（#5274 附件 scope 一例）；
5. **fence 类修复按"枚举全部入口"收敛**（#5265 堵了 toggle/mid-turn/idle-session 三入口 + 重入），逐个堵会被 review 逐轮找出残留路径。

### 定性方法论

- 上游预存红钉死到具体 merge commit（父子对照）是 PR 评论里最省口舌的证据形态；
- 纯净 main worktree 同构对照是定性"预存 vs 引入"的金标准；
- 多会话并行时，**任何 head/结论在下判断前必须重新拉 API**（本次三个单的 head 被并行会话推进过）。

---

## 五、重要配置与命令

### git 身份（本会话固化，已写 AGENTS.md 执行区与 maka commands.md）

```ini
# C:\Users\802165\.gitconfig 追加
[includeIf "gitdir:E:/ggbdpq/gh-fork/"]
    path = .gitconfig-ggbdpq
# .gitconfig-ggbdpq 内容：[user] name=ggbdpq email=ggbdpq@gmail.com
```
外加 maka/CLIProxyAPI 仓库本地双保险。历史"关天豪 <ggbdpq@gmail.com>"提交不改写（email 正确，贡献图已计入）。新 clone 异常先 `git config --show-origin user.name user.email` 核对来源。

### #5805 的最终依赖形态（package.json overrides，按依赖者钉）

```json
"@ai-sdk/provider-utils": { "undici": "7.29.1" },
"@electron/get": { "undici": "7.30.0" },
"@jackwener/opencli": { "undici": "6.29.0" },
"node-gyp": { "undici": "6.29.0" },
"unifont": { "undici": "8.11.2" }
```
runtime 精确钉 `"undici": "8.10.2"`（@slack peer ^7 由 lockfile 嵌套条目 `@slack/socket-mode/node_modules/undici@7.30.0` 满足，**无 override**）。desktop devDependencies 显式声明 `electron-builder-squirrel-windows: 26.16.1`。

### 关键命令

```bash
# undici 类修复后的 lockfile 重解析组合
npm update <pkg> --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm install --ignore-scripts --no-audit --no-fund        # 找回被剪条目
npm ci --ignore-scripts --no-audit --no-fund              # 推送前自证（必做）
npm ls --workspace maka-agent --omit=dev --all --json     # release 闭包校验
npm run generate:third-party-notices && npm run generate:cli-third-party-notices
npm run check:third-party-notices && npm run check:cli-third-party-notices
node scripts/check-renderer-architecture.mjs --write      # 账本重定价
node scripts/windows-test-inventory.mjs --check           # Windows skip 清单
node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD  # 先 commit 再跑
node scripts/check-allow-scripts.mjs                      # #5744 新守卫
npm view <pkg>@<ver> dist.integrity --json                # 手写 lockfile 条目三元组
```

---

## 六、遗留问题与后续建议

1. **等审批**：八单全部等 approving review（分支保护要求）。3 天无信号带各单 head SHA gentle ping；群聊两行消息已交付用户。
2. **#5709 epoch 连锁**：#4751（epoch 199 声明者，open）若先合并，#5709 合并前需 merge main 顺延到 200。
3. **#5744 vs #4865 撞车**：同名守卫脚本 `scripts/check-allow-scripts.mjs` 两套实现（lockfile 比对 vs npm 11.19 prune）。已在 #5744 留协调评论表态愿意让位或重基——等维护者定。
4. **#5805 的 @ai-sdk 7.29.1 后续**：7.30.0 的 ProxyAgent CONNECT 行为变化值得单独报 issue 上游（本次为守安全线选择了回walk）。
5. **本地环境**：maka 仓库 node_modules 有 rm 权限拒绝残留（prismjs/es-toolkit 等目录被句柄锁），后续会话若 npm 异常先 `cmd //c "rd /s /q node_modules"` 强删重装；gh CLI 已 auth login（scopes repo/read:org/workflow），`git credential fill` 通道已弃用。
6. **#5265 结构性 follow-up**（review 提议、未实施）：driver 调用传 expected session id 关闭整类竞态；per-session draft handoff 让撤回内容跨切换可恢复。

---

## 新会话快速恢复上下文

**现状**：apache/maka 的 8 个 open PR（#5265/#5274/#5709/#5744/#5791/#5800/#5804/#5805）全部处于等审稳态——CI 全绿、无未回应意见、对 main merge-tree CLEAN。#5805 经九轮依赖审计排障达 18/18。上游 issue #5777（ACP 预存 flaky）在案。

**关键决策**：依赖安全修复一律 overrides 按依赖者钉最小修复版 + lockfile 连锁 checklist 六处同步；CI 红先定性（上游预存/自己引入/环境抖动）再动手；多会话并行下任何 head 结论先重拉 API。

**下一步**：等维护者审批；有新 review 按固定开场流程（fetch → 逐单评论 → merge-tree → 修复）处理；#5709 合并前看 #4751 的 epoch 是否已进 main；3 天无信号 gentle ping（用户已有两行版消息模板）。所有排障教训与 #5805 九轮档案在 `E:\ggbdpq\gh-fork\docs\maka\pr\journal\claims.md` 的 09-28/09-29 条目。
