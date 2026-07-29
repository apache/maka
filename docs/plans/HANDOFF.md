# CU 工作交接 — 下次接着干

写于 2026-07-26 凌晨。本文档不进 git 提交。

新会话开工前，先读这份，再按需展开引用的文档。

---

## 一句话现状

Maka 的 CU 链路已在真机端到端验证通过（后台 AX 点击真实生效、零 pixel、不抢焦点），三个 PR 都在远端且 MERGEABLE；下一步是解锁被开关关死的动作面（R1）和把给模型的 a11y 做得比 Codex 更好（R17/R19）。

---

## 三个 PR 的状态

| PR | 内容 | 状态 |
|---|---|---|
| maka #1263 | 后台语义执行 + 遮挡窗口 zoom capture | Ready · CI 三绿 · MERGEABLE · 等 review |
| maka #1495 | e2e harness 契约自洽（修三处自相矛盾的测试假设） | MERGEABLE · 等 review |
| trycua #2210 | stable AX node identity tokens | CONFLICTING → MERGEABLE ✅ · 等 review |

trycua #2210 的备份在 `origin/backup/2210-pre-rebase @ c40481bd`（fork = hqhq1025/cua）。
maka #1263 的备份在 `fork/backup/cu-bg-qualified-20260726 @ 1a021469`。

---

## 开工前必读的环境要点

### TCC 纪律（最重要）

真机 CU 验证只要走坐标 / CGEvent 路径，就会触发 TCC 归属请求，把跑它的进程毒化：`~/Documents` 下先是目录列举 EPERM，十几分钟后扩散到读任意已有文件和 `git status` 全部 EPERM。新建文件反而不受限，所以症状容易被误判成「文件丢了」。

规矩：
- 真机验证（尤其坐标路径）在一次性会话里跑，跑前先把手头工作 commit + push
- 优先用 `cua-driver permissions grant`（经 LaunchServices 让授权归属 `com.trycua.driver` 而非调用方进程，CLI 文档原话 "This is the correct way to grant"）——本次未验证，值得先试
- 中毒后唯一解法是重开会话

AX 语义路径（`observe` / `click_element`，dispatch address = `ax`）跑十几次都没事，只有坐标路径会中招。

### 真机测试怎么跑

```bash
LAB=~/Documents/Learning/computer-use-research/codex-computer-use-lab
# 注意：launcher 里原本硬编码的 ~/Documents/Learning/codex-computer-use-lab 已失效
# PR #1495 已把它改成必须由环境变量提供

# 重置 fixture 必须三步，只跑 reset.sh 会删掉 state.json 导致后续全崩
"$LAB/test-app/stop.sh" && "$LAB/test-app/reset.sh"
CUA_LAB_BACKGROUND=1 "$LAB/test-app/launch.sh"

cd <repo>
MAKA_CU_AX_MODEL_LAB_ROOT="$LAB" \
MAKA_CU_MODEL_PROVIDER=anthropic \
MAKA_CU_MODEL_BASE_URL=http://127.0.0.1:8537 \
MAKA_CU_MODEL_API_KEY=coproxy \
MAKA_CU_MODEL_ID=claude-sonnet-5 \
MAKA_CU_AX_MODEL_SCENARIO=ax-click \
node scripts/cu-real-ax-model-e2e-launcher.mjs
```

- coproxy：8537（e2e 的 anthropic 默认端口）和 8546 都通，8538（openai 默认）不通
- 可用模型：claude-sonnet-5 / claude-opus-5 / claude-opus-4-6~4-8 / claude-sonnet-4-6 / claude-haiku-4-5
- 场景：`observe-only` / `ax-click` / `ax-multi-step` / `ambiguity` / `restart-recovery` / `intervention-recovery`
- 手工调 harness 时 `MAKA_CU_AX_MODEL_TEMP_DIR` 必须在 `os.tmpdir()` 之下（macOS 是 `/var/folders/.../T`，不是 `/tmp`），否则报 `requires launcher-owned inputs`
- 屏幕不能息屏：`caffeinate -dimsu -t 7200 &`

### 本机 node 版本不对

本机 v22.11.0 缺 `node:sqlite`，跑 `npm run test` 会得到 156 个假失败、7 个 workspace 全红。CI 用 `node-version: '22'` 解析成最新 22.x（已 unflagged）。项目没有 engines / .nvmrc，不会有任何提示。

正解是把本机 node 升到最新 22.x。临时验证可用 `NODE_OPTIONS=--experimental-sqlite`，但不要写进任何脚本或提交。

另外：本机 npm registry 指向企业 feed（`packagefeedproxy.microsoft.io`），`npm ci` 会因缺 `undici@8.8.0` 报 404。worktree `~/.codex/worktrees/cu-background-qualified-pr` 里有完整可用的 node_modules，可借用其 `node_modules/.bin/biome`。

### 别在高负载下跑测试

带着两个 Workflow 跑全量测试时 load average 冲到 23/35/25，日志里全是超时类假失败（Detached descendant still running / process did not exit / Grep timed out / cua-driver restart budget exhausted）。跑之前先 `uptime`，并停掉后台 Workflow。

---

## 待办（按优先级）

### Maka

**R1 解锁 `allowCompatibilityInputDispatch`（最高杠杆）**

一个从未接线的开关关死了 6+ 个动作。`select-backend.ts` 构造 backend 时从不传它，桌面运行时恒为 undefined，导致坐标五种点击 / scroll / drag / press_key 在原生 App 上 100% 拒绝。四道门在 `cua-driver-backend.ts` 的 1976 / 2189 / 2313 / 2366。

已验证的安全前提：坐标点击**不 warp 光标**（实测 before/after 光标坐标逐位相同，同时点击成功、frontmost 未变）。代码注释也写明 scroll 走 `scroll_wheel_at_xy → post_to_pid`，drag 是 window-local 的 down→moves→up。

新增的已知代价：坐标路径会触发 TCC 归属请求（见上文）。设计放开策略时必须把这一项算进去。

**R17 / R19 把 a11y 做得比 Codex 更好**

- R17：元素带上可用 AX action 列表。Codex 的 SKILL 要求 `perform_secondary_action` 的 action「必须是该元素在 accessibility text 里实际暴露的，不要猜」——说明它的 AX 文本带 action 列表。而 Maka 的 `observationText` 只吐 element_id/role/label/value/frame，模型只能猜。这也是 `secondary_action` 至今是空壳的根因之一。
- R19：补 enabled/disabled、focused、selected、expanded 状态位。现在模型分不清「按钮不可点」和「按钮可点但我没点对」，长流程里会反复重试失效元素。Codex 的状态位也不全，这里能直接做得更好。

**R8（是 bug 不是优化，优先级高于 R17/R19）**

坐标空间断裂：模型看到的 `element.frame` 是屏幕逻辑坐标，要提交的 coordinate 是窗口截图像素坐标，而 `observationText` 里既没有 window bounds 也没有截图尺寸。模型没有任何换算依据，也没被告知这件事。

**其余见路线图 R2-R21。**

### trycua

- **P2 补 macOS harness 证据（受阻于 TCC，需新会话）**：跑 `libs/cua-driver/tests/runners/macos-lume/run-all.sh`，把 `harness_appkit_test.rs` 的 typed case rows 贴进 PR，而不是只贴 cargo test 计数。依据 TESTING.md:63-65「Unit and protocol tests do not prove that desktop input reached a real application」——这是维护者最在意的第三件事，而仓库根本没有 macOS CI lane，所以这是唯一能替代 CI 的证据。
- **P3 拆 PR（最大单一杠杆）**：按三分清单的 A 类拆成 3-4 个各自 <400 行。拆分后跨平台那部分能被 ci-rust-linux/windows 真正验证拿到绿灯，这是 macOS 部分永远拿不到的。
- **P5 ping（等 P2/P3 完成）**：复制 #2166 的成功序列（15.2 小时合入）——技术请求和 CI 门禁请求拆成两条独立评论，各自单一诉求；另发 `@codex review` 触发机器人评审（GitHub App，不受 Actions 批准门禁）。注意整条 PR 至今只有 07-14 一次 `@`，07-20 那两条关键更新都没带。
- **独立高价值项**：Maka 打包的 `cua-driver-rs-v0.7.1-maka.2` 相对上游净 delta 已归零，继续维护 fork 构建是纯亏（丢掉 attestation 与 CI 覆盖）。应切回上游官方 release 升到 0.12.x/0.13.x，同时解除构建链路对 #2210 的依赖。要还的债：`--no-daemon-relaunch` 上游已删；embedded 改成两段式 `serve --embedded --socket <path>` + `mcp --embedded --socket <path>`。

---

## 贯穿约束

- **docs / plans 类文档一律不进 git 提交**，可放 `docs/plans/` 但保持 untracked。提交前 `git status --short | grep -v '^??'` 确认；用 `git add <具体路径>`，不用 `git add .`
- 代码 push 到 `fork`（hqhq1025），不是 `origin`（上游无 push 权限）；PR base 上游 main，head `hqhq1025:<branch>`
- 小步提 PR，不攒大分支。上一轮 95% 白做就是因为攒了大分支，期间上游合了超集（PR #985 覆盖 loop，#1255 覆盖 cursor-engine）
- **涉及「Maka 有没有 X」的判断，一律先 `git show origin/main:<path>` 核实**。本次会话连续三次误判（元素输出 / 动作面 / 审批）都是因为拿 subagent 摘要当事实
- 遇到 stacked PR：若前一个 PR 是 squash merge，`git cherry` 仍会把它的提交报成独有（patch-id 对不上），直接 `git rebase main` 会重复应用并冲突一片。用 `git rebase --onto origin/main <前一个PR分支>` 只搬 delta

---

## 相关文档

同目录下：
- `2026-07-26-cu-roadmap.md` — 完整路线图 R1-R21 + trycua 三分清单与推进状态 + 真机测试要点
- `2026-07-26-codex-cu-plugin-contract.md` — Codex CU plugin 契约分析（sky 的 10 个 API 签名、AppState 结构、四级确认策略、六条可借鉴设计决策）
- `2026-07-26-cu-semantic-landing-plan.md` — PR 落地计划（阶段 0-5 及完成情况）
- `2026-07-26-cu-research-findings.md` — 16 路 agent 调研全文，540K / 552803 字节（sha256 前缀 c223e10f58a0e00d）。含 Codex 官方二进制逆向、open-computer-use 深读、occu/permiso/cua-sample/occu-labs 对照、Maka 现状基线。**这份不可再生**，是三轮 workflow 的原始产出

### 可重建的数据（没放进仓库，丢了照下面重来）

四个参考实现的浅克隆（共 33M，都是公开仓库）：

```bash
mkdir -p /tmp/cu-study && cd /tmp/cu-study
git clone --depth 1 https://github.com/iFurySt/open-codex-computer-use occu       # MIT，Swift+Go，⭐1525
git clone --depth 1 https://github.com/zats/permiso permiso                        # Codex 权限弹窗复刻，⭐560
git clone --depth 1 https://github.com/openai/openai-cua-sample-app cua-sample     # 官方 CUA 参考，⭐1753
git clone --depth 1 https://github.com/OpenCodexLabs/open-codex-computer-use occu-labs
```

注意 occu 在沙箱里 `git status` 会异常显示大量 D（deleted），是假象，文件都在，直接读即可，不要试图 git restore。

trycua 工作副本（本地那份 3.6G 大部分是 cargo target/，rebase 成果已 push 到远端，不需要保留）：

```bash
git clone --filter=blob:none https://github.com/hqhq1025/cua /tmp/cua-fork
cd /tmp/cua-fork
git remote add upstream https://github.com/trycua/cua
git fetch upstream main
git checkout codex/stable-ax-node-identity    # 已是 rebase 完成的状态（0ed2b191）
```

Codex CU plugin 本体（只读分析对象，随 Codex 安装存在）：
`~/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000502/`（7 个文件，其中 `skills/computer-use/SKILL.md` 18K 是完整 API 契约 + 四级确认策略）


memory（新会话自动加载索引）：
`maka-cu-actual-state` · `maka-cu-real-machine-verified` · `maka-trycua-upstream` · `maka-cua-tcc-background-trap` · `maka-local-dev-env` · `maka-docs-not-committed` · `maka-cu-runtime-helper-audit` · `maka-git-fork-workflow`
