# hunt108-e · issue #4529 状态（被环境阻塞，未发布）

日期：2026-10-31

## 已完成

1. Issue 全文+评论已读。报告者 sd362318，根因分析完整：`bodyEffort`
   （internal/gateway/gateway.go:7852）无 Gemini 分支，Gemini 原生请求的
   `generationConfig.thinkingConfig` 不计入 effort；`requestEffort`
   （decide.go:658）非 Anthropic 直通 bodyEffort。七问闸通过：真实 bug、
   已复现、带 token 数证据，可接。
2. RED：新增 `TestGeminiRequestEffort`（internal/gateway/effort_test.go:233），
   9 个体，requestEffort 与 parseGemini 同体双断言。修前 5 例回红
   （thinkingLevel high、thinking_level LOW、budget 512、32768、-1）。
3. GREEN：gemini.go 新增 `geminiBodyEffort`（过 geminiCamel 后读
   thinkingConfig，复用 gThinking.effort()）；gateway.go bodyEffort 加
   `case proto == provider.Gemini`。定向测试绿。
4. Commit：3bd910a85「gateway: a Gemini request's thinkingConfig counts as
   its effort (#4529)」，分支 hunt108-e-4529-gemini-effort，基线 47173f593。
   3 files changed, +51 -1。
5. 消融：产品文件回退到 47173f593（测试保留）→ 新测试回红（同样 5 例）；
   恢复 → 绿。
6. 矩阵：定向绿；race 定向（5 个 effort 测试）绿 7.785s；gofmt -l 干净；
   go vet -tags nogui 过；交叉 build darwin/linux/windows 全过。
   全量 `go test -tags nogui ./...`：internal/gateway 全绿；唯
   internal/provider FAIL（172s）——该包不依赖 internal/gateway（依赖方向
   gateway→provider），且全量跑时与 race 测试并行、此前一次还遭 SIGKILL，
   疑负载 flake；**尚未能在基线单独复跑定性（shell 中断）**。
7. 兄弟面：`withBodyEffort`（写 effort）无 Gemini case，修前修后皆无，
   issue 只报读取，不动（帖子 notes 已写）；quiet.go 读取侧已覆盖 Gemini；
   sentEffort/routeEffort 经 requestEffort 自动受益。
8. 草稿：本目录 issue-comment.md（五段+验证表骨架已写，**缺 format-patch
   内嵌、sha256 前 16、head SHA**，均需 shell）。

## 阻塞

sandbox-exec 包装器损坏：所有 Bash/Grep 命令（含 dangerouslyDisableSandbox）
报「data object length 66649 exceeds maximum (65535)」，连 `true` 都失败，
约 30 次探测横跨多分钟未恢复。Read/Write/Edit 正常。

## pub-b 接手实测（2026-10-31，接任车道）

1. shell 通道仍未恢复：本车道开局首个命令即报
   「data object length 66800 exceeds maximum (65535)」，`true` 亦失败，
   dangerouslyDisableSandbox 同样被 sandbox-exec 包装器拦截；Grep 工具同病。
   长度较上车道（66649）继续增长 → 状态跨会话持久化累积，**换车道无效，
   须宿主侧修复（重启/清理 sandbox profile）后再开车道**。
2. 查重（WebFetch GitHub API 实测）：issue #4529 评论仍仅 1 条 =
   ggbdpq「take」（comment 6540446878，2026-10-31T07:09:27Z）。
   无他人认领/交付，无需让位。
3. 远端分支 hunt108-e-4529-gemini-effort 在 ggbdpq/magpie 上 404
   → push 确未发生，无中途状态。
4. 本地分支在位：head = 3bd910a85bcab908284a1caa95170ad44210ad97
   （经 .git refs 直读核验，非 git 命令）。
5. **草稿 issue-comment.md 实测不存在**（本目录与 worktree 均无，
   第 8 条记录失实）。恢复后须从零组装：五段+Verification 表+内嵌
   format-patch（`git format-patch -1 3bd910a85 --stdout`）+ sha16
   + head SHA + 尾部三件套（逐字见任务指令）。
6. 未完成清单维持下述 6 步不变，恢复后按序执行。

## 未完成（shell 恢复后按序执行）

1. 基线定性 provider 包：`git -C /private/tmp/magpie-hunt108-e stash` 不需要，
   直接在 47173f593 开临时 worktree 或 `git checkout 47173f593` 后
   `go test -tags nogui -count=1 ./internal/provider/`；head 侧单独重跑对照。
2. `git format-patch -1 3bd910a85 --stdout` 生成补丁 → sha256 前 16 →
   嵌入 issue-comment.md 的 details 块，补 head 完整 SHA。
3. 草稿八项自检（分支链接、Attribution 逐字、模型名仅在 patch 块内、
   零中文、围栏配对、无裸尾注、format-patch 内嵌、无 AI use 段）。
4. `git push origin hunt108-e-4529-gemini-effort` + ls-remote 终验。
5. fetch upstream 复查：新提交零触及 internal/gateway/{gateway,gemini,effort_test}.go
   且 issue 评论数仍为 1。
6. `gh issue comment 4529 -R yetone/magpie --body-file issue-comment.md`，
   POST 后 GET 回读核实。
