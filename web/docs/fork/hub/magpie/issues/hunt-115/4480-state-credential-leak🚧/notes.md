# hunt-115 / #4480 — /api/state 泄漏裸 GitHub token 与 legacy LAN key

日期：2026-11-01 ｜ 结论：**让位**（Logic769 方案先行），降级发英文诊断帖

## 让位判定
- c=1（2026-10-31 08:34 UTC）不是维护者表态，是 Logic769 宣布 fix 就绪：fork 分支 `Logic769/magpie` → `fix/gui-state-credentials`，commit `fe270b3`（完整描述+验证），属方案先行占坑。
- upstream 截至 `9d08993c8bd4`（开工 SHA）未修：`state()`（internal/gui/api.go:2595）仍 `Settings: settings.Load()`；无引用 #4480 的提交。
- 未发 take，未推分支，未交竞争补丁。

## 诊断事实（兄弟面盘点）
- 全量 settings 序列化到页面的只有两处：`state()`（裸——本 bug）与 `settingsState()` /api/settings（已掩码：`s.LANKey=""`+token 掩码，先例规则）。
- `lastKnown()`（?last=1）把 `settings.Load()` 回填——Logic769 补丁同点覆盖。
- `keptFile()` 落盘副本整块清掉 Settings（磁盘干净）。
- POST /api/profile/{action} 内嵌 state()、POST /api/sync 直接返回 state()——修 state() 一处全覆盖。
- `boot.js` 只挑 lang/theme/textSize 等非秘密字段。
- 前端 app.js 只读 /api/settings 的 `githubTokenMask/githubTokenFrom/githubTokenRefused`，从不消费 state 里的 `githubToken/lanKey`（尸体字段）。
- **不改项及理由**：`proxy`/`proxyCustom`/`otel.headers` 是设置表单回写字段（app.js:20750、22657 真消费），掩码会打断表单——与 token/lanKey 不同类。

## 验证（在 detached worktree @9d08993c 实测）
- `git am` logic769-fe270b3.patch → 干净应用（基线 90518de2 落后 393 提交，d307aa648 重写 /api/state 写路径但未动 state() 构造行）→ 新 SHA 5c07a6c86。
- GREEN：`go test ./internal/gui -run TestLastKnownState -count=1 -tags nogui` → ok 1.245s。
- RED（消融：api.go+laststate.go 回退 upstream、测试保留）：三红齐发——`state carried the credentials: token "ghp_secret1519" lanKey "sk-lan-1519"` / `last-known state carried the credentials` / `the page was served the credentials`（laststate_test.go:68,94,97）。
- `gofmt -l` 三触及文件干净；`go vet -tags nogui ./internal/gui` 干净（exit 0）。
- 改动包全量 `go test ./internal/gui -count=1 -tags nogui`：193s，仅 1 红 `TestProxyCheckSaysAProxyPassedBy`（proxy 检查端点 HTTP 502）；基线父提交 9d08993c 单跑同红 → **本机预存**，与补丁无关。
- 未验证：GOOS=linux/windows vet/build、internal/gui 之外的套件（帖内 Not verified 已声明）。

## 发布
- 诊断帖：https://github.com/yetone/magpie/issues/4480#issuecomment-6558109389 （ggbdpq，2026-11-01T12:44:16Z，2696 字符，GET 回读一致）
- 稿件：diagnostic-post.md（自检：零中文、SHA 引用 6 处、表格行间无空行、无 AI use 段）
- Logic769 补丁存档：logic769-fe270b3.patch（sha256 前 16：`6c67f3621dbe0bd4`）

## 备注
- 若 Logic769 的补丁长期无人拾取，本记录可直接复用诊断与验证结论再评估接手。
