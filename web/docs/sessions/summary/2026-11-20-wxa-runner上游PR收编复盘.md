# wxa-runner 上游 PR 收编复盘（2026-11-03 ~ 11-09）

## 一句话结论

wxa-runner PR #112 经历「提修复 → review 引导归因修正 → 上游 #114 收编覆盖 → 道歉+署名承诺 → PR 转型回归测试」完整闭环，根因归属已获维护者书面确认（发版说明将注明）；**但收口时发现修前红基线存在 stale-dist 混杂，向维护者报告的「harness 局限」结论未验证，需重建基线复跑后再定**。

## 案例：PR #112 全周期（供下次同形任务复用）

**问题与触发**：官方 npx wxa-runner（基础库上限 3.7.0）跑 Taro 3.4.3 项目（171 页面/19 分包）白屏，app.js 报 `Fatal: unexpected loadSdkSubPackage case`；修复启动后又出现分包页 `t.addEventListener is not a function`。

**根因链（三轮迭代后定稿）**：基础库伴生 SDK 子包（WAAppAd/WACloud 等）浏览器运行时无加载机制 → ① `wx.cloud` 惰性 getter 走 loadSdkSubPackage 抛 Fatal 炸 app.js；② 全局挂的 `__cloudSDKMain__`/`ADSDK`/`__splashAdFloatWindowSDK__` 读取即抛存取器（`setting 'inject'`）→ ③ Taro 全局垫片 `br[e]=i[e]` 全量拷贝宿主全局时踩雷，**垫片模块加载失败、br 半成品**（`br.addEventListener` 本是空函数 no-op 占位，还没挂上）→ 分包页报错是 ③ 的下游症状，非独立缺口。垫片探测 `t.document.createElement` 恒真（自带假体），正常环境监听注册走 no-op 不报错。

**关键转折**：
1. 初版把 ③ 当独立缺口提了 jsTransform 扩展点 + 项目侧 codemod；维护者四问（完整堆栈/devtools 实测/**探测条件**/codemod 内容）引导深挖 → 归因修正 → 撤 jsTransform，按维护者倾向改 runner 环境对齐（degradeThrowingGlobals）。
2. 11-04 四问后 11-05 维护者自提 #114（机制与本 PR 两个 commit 重合，提交说明点名"Taro 遍历全局"场景、未引用本 PR）——中间经历了「悬案」期（用户拍板不撤不关不指控，时间线自证）。
3. 11-09 维护者主动道歉（"一天没等到回复就先做了修复，没同步一声"）+ 承诺发版说明注明根因出处 + 给三选一：实测新版本 / rebase 修新问题 / **改成贴近真实场景的回归测试**。选第三条：分支 rebase 到最新 main，撤两个 fix commit，重写为单 commit 回归 e2e（`tests/e2e/taroWindowShim.test.ts`：真实垫片形态 + hasOwnProperty/atob 细节 + 先读 wx.cloud 再拷贝 + 分包页 navigateTo 导航 + 注册断言）。PR 现单 commit 无冲突待合入。

**下次复用条件**：上游贡献被维护者以自修方式收编时，处置随表态走——无表态前不撤不关不指控；认账后按其给出的替代形态转型（回归测试是常见落点），根因署名（release notes 注明）可争取。完整时序与项目级坑（wxa-runner 本机规范：oxfmt 只格式化自建文件、husky 被 pnpm builds 卡住用 --no-verify、commitlint CI 复查、基础库 3.7.0 上限）已在 auto-memory `wxa-runner-fork-browser-debug.md`。

## 待验证项已闭环（2026-11-20）：stale-dist 混杂实锤，「harness 局限」结论撤销

重建基线复跑（`git checkout 82b6b73` → `pnpm build` → 桥接测试文件 → vitest）：**两条用例全红**（页面数据为空 = `try{void wx.cloud}` 触发 Fatal/加载尝试 → 残骸存取器留全局 → 垫片拷贝抛错 → app.js/垫片模块加载即崩）；切回修复分支重建后 2 passed。红绿双向确认：

- **回归测试是标准 red-capable 测试**——`tests/e2e/taroWindowShim.test.ts` 在修复前基线必红、修复后必绿；
- 11-09 向维护者报告的「测试项目复现不了存取器安装时机，修前也绿」**结论错误**，根因是取基线时未重建 dist（stale-dist 混杂，见 pitfalls M10 扩充条目）；
- PR #112 终态：11-16 被维护者转为 issue 并关闭归档，回归测试 commit（7a69e24）未合入上游；**CHANGELOG 0.13.1 致谢已兑现**（9574fa6：「感谢 @ggbdpq 在 #112 中定位了根因：Taro 全局垫片逐个拷贝全局属性时读到伴生 SDK 存取器抛错、垫片只初始化了一半……并在真实 Taro 3.4.3 项目（171 页面/19 分包）上验证了修复」）。

**后续可选项（未执行，待用户决定）**：测试现已证明红绿有效，且维护者 11-09 明确说过「更贴近真实项目的回归测试我们很乐意合进来」——可单独开一个只含该测试的 PR（含本次红绿证据表）；但线程已归档，也可就此收口不追。fork 仓库已迁至 `E:\cc\code\github\miniprogram\wxa-runner`。

## Skill 增量建议（只提议，未改）

1. **workflow.md §4 review 与新评论 节**｜现有规则只覆盖「照办前验证」｜建议追加一条：`reviewer 的机制性提问可能是归因探测而非改码指令：回答前把「为什么不崩」挖到底层占位/守卫层（如 no-op 函数占位、恒真探测），归因可能整体修正并改变交付形态（fix→test）——排查到「能跑通」就停会留下错误归因（wxa-runner #112 判例：addEventListener 报错实为垫片半成品下游症状）`｜检验场景：维护者问「为什么开发者工具里不崩」——只答环境差异是浅层，挖出占位层才算合格回复。
2. **delivery.md §5 收编对账**｜让位帖只覆盖关闭形态｜建议追加：`上游自修覆盖且出处未标注时，表态前不撤不关不指控（时间线与证据自证）；维护者承认出处后按其给出的替代形态转型（常见：真实项目回归测试），release notes 署名可主动争取`｜检验场景：同形 PR 被上游 36 小时内收编，处置路径应先等表态再选转型或让位。
3. **pitfalls.md 新增 M 条目**｜三道程序消融节无「e2e 基线须重建构建产物」规则｜建议追加：`e2e/运行态测试的基线红必须重建 dist/runtime 等构建产物（RUNTIME_DIR 类路径指向产物，checkout 只切源码）；用旧产物取的"修前绿"是混杂结论。佐证：修复在 dist 则取证名单为空，与「未安装」不可区分`｜检验场景：对含构建步骤的仓取基线红，检查清单应有「重建产物」一项。

## 常用命令

```bash
# e2e 基线红绿对照（正确版：切基线后必须重建产物）
git -C <fork> checkout <base-sha> && pnpm -C <fork> build && pnpm -C <fork> exec vitest run <test路径>
git -C <fork> checkout -            # 回到工作分支
# 成功信号：测试在基线红、在修复分支绿；副作用：build 覆盖 dist（回到分支后需再 build）
```

其余高频命令（fork runner 启动、gh 读评论、MCP Chrome 清理）已录 auto-memory，不重复。

## 不适用边界

- 「上游收编=参考了你的 PR」是推断不是实证：本案例靠维护者道歉坐实，缺道歉的场合不得对外主张。
- wxa-runner 仓规（oxfmt/commitlint/husky 坑）是该项目特例，未晋升通用规则；若后续接手该仓再按 gua-pr-patch 入口读 fork docs（若建 hub 条目）。
