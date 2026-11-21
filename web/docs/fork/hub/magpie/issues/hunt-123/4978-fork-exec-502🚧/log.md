# hunt-123 / Lane D / #4978 工作日志（2026-11-04）

结局：**缺陷可修 → patch + 分析帖，take 占坑，已发布 + GET 回读**。
take：https://github.com/yetone/magpie/issues/4978#issuecomment-6613544954
帖：https://github.com/yetone/magpie/issues/4978#issuecomment-6613921262（GET 回读过：13328B，五段+三件套 16/16 探针全中）
帖稿：delivery-post.md（本目录）；patch 副本：0001-claude-an-interactive-run-over-one-environment-entry-s.patch（SHA-256 前 16：`2a20e9fc4f361ee9`）。

## 交付物
- 分支 `fix/4978-fork-exec-502` @ `dc954ac28ee134d7a844a1e4f368eaecd8039034`（基线=发布时 upstream/main tip `c360d9d30`，开工时 7785c4278 后中途快进）。
- commit：`claude: an interactive run over one environment entry's safeguards is refused before its exec (NickWilde18)`，作者 ggbdpq <ggbdpq@gmail.com>，尾注 Fixes #4978 + Generated-by。

## 根因链（静态验证于 /private/tmp/mg122-d）
1. 交互式 run 的 safeguards 经单个 env 项 `CLAUDE_CODE_EXTRA_BODY` 传递（startRun，claude_subscription.go L1141 区），`claudeExtraBody` 无尺寸上限；交互式 Claude Code 仅在启动时读一次。
2. 客户端 auto-mode classifier context 每工具批增长（#4804：prior_turn_context 逐批加条目）；Linux execve 单串上限 `MAX_ARG_STRLEN`=131072（32 页）。
3. 超限后每次 exec 助手（magpie 自身 re-exec）必 E2BIG："fork/exec ~/.local/bin/magpie: argument list too long" → serveSubscription L6135 默认 502 → Claude Code 客户端重试 → 同墙撞死。与 issue 报错逐字吻合。
4. **版本判定**：#4804 的"每批重启"驱动已被 3088872e6（首发布 v0.1.2817 > 报告者 v0.1.2766）摘除——易变部分变化不再重启。但任何新 run 启动（resume、取消后 replay、kept-safeguards 变更、idle 逐出）仍带当刻全量 safeguards 进单项——420k/470k 会话该值已过 128KiB，硬失败在 main 仍可达。
5. 排除项：prompt 走 stdin（L1227 注释明说）、token/系统提示走文件、mcpConfig 小常量；E2BIG 报错文本即 execve 参数面，fd/进程上限不成立。兄弟面：`--json-schema` 同吃 argv 单串上限（无报告，未动）。

## 修法（最小面）
- `maxArgStrlen=131072` 常量 + startRun 内 pre-exec 守卫：`len("CLAUDE_CODE_EXTRA_BODY=")+len(tuiBody) >= maxArgStrlen` → cleanup + log.Printf 尺寸（报告者 ask 2）+ `&tuiRefusal{claudeTUIErr(...)}`。
- tuiRefusal=400：不轮账户、Claude Code 不再重试（#4778 先例），文案自带 print-mode 出路（报告者 ask 1 的 fallback 形态；settings 文件交付因无法本机验证交互式 Claude Code 是否应用 settings.env 而留给维护者）。
- 3 文件 47 行：守卫+常量（claude_subscription.go）、`TestClaudeTUISafeguardsOverOneEnvEntryRefused`（claude_tui_extra_body_test.go）、`askCode` 携带 h.extra 一词改动（claude_room_test.go）。

## 验证矩阵
- TDD：RED（未修 tip 200 启动）→ 守卫 → GREEN；消融（回退守卫只留测试）→ 红（0.9s），恢复 → 绿。
- 定向家族 + 全量 `internal/gateway` `-tags nogui`：ok 598.9s 零失败（本机已知 5 个预存红未触发）。
- `-race` safeguards/交互 spawn 家族：ok 3.8s；gofmt/vet/build 全净。
- 真实字节数 200093 由测试日志取回，非估算。

## 未验证（帖内明说）
- E2BIG 本体未在本机复现（darwin/arm64 无单串上限、无 Linux 机/真实订阅/470k 会话）；守卫按长度在 exec 前触发，测试平台无关地钉住。
- settings 文件交付方案未尝试（closed-source 客户端行为不可本机验证；静默丢 safeguards 不可接受）。
