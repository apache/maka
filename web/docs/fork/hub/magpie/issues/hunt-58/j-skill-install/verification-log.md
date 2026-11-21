# hunt58 Lane J — 技能安装 "unexpected end of JSON input" 侦查与验证日志

日期：2026-10-21。基线 `f5b0157420a4491f6e707b49a8af8e87ea8050a1`（=upstream/main）。
工作树：`/tmp/magpie-r58-j`，分支 `hunt58-j-skill-install-json`。
上游素材：#3045 楼内跟评 [6319927119](https://github.com/yetone/magpie/issues/3045#issuecomment-6319927119)（ye4241，2026-10-21T15:37:38Z，正文仅一张截图）。

## 定性结论

**Route A（TDD patch）**。存在干净的代码级缺陷：`apiGet` 丢弃 `io.ReadAll` 错误，
应答体半路被切断时（200 + 截断体）一路走到 `json.Unmarshal`，把"应答在途中被切断"
伪装成"GitHub 的文件清单看不懂：unexpected end of JSON input"。修共享读取器
（code-standards「A failed read…fix the shared reader」条款），同型兄弟 `latestRTK` 同修。

## 代码路径（file:line，基线 f5b0157420）

- 截图报错文案出处：`internal/library/skillnew.go:184`（`repoTree`）。
- 缺陷点：`internal/library/skillcheck.go:177`（`apiGet`）`body, _ := io.ReadAll(...)`——读体错误丢弃。
- 安装 UI 链路：添加技能 → `fetchSkillFiles`（`internal/library/skilltree.go:79`）→ `repoTree` → `apiGet`；
  更新检查的"发现新技能"同走 `repoTree`（`internal/library/skillnew.go:213`）。
- 同型兄弟：`internal/library/rtk_upgrade.go:299`（`latestRTK`）同弃读体错误后 `json.Unmarshal`。
- 对照（做对了的）：`fetchBlob`（`internal/library/skilltree.go:292`）检查了 `io.ReadAll` 的 err。
- `source.Do` 只看响应头即返回（`internal/source/source.go:226-232`），体完整性全靠 `apiGet` 把关；
  无 token 时请求可落 `gh-proxy.com` 镜像（`MAGPIE_MIRRORS=on`），镜像中途断流同样进这个坑。

## 假设清单逐条结局

| 假设 | 结局 |
| --- | --- |
| a. 60 次/时限流（403 体是合法 JSON，parse 应成功）与报错不符 | **证伪（实况）**：本机探针实测 403 体为合法 JSON 且含 "rate limit"，走 `ghtoken.LimitedBy` 会给出友好限流提示，不是截图文案。见下方 curl 原始输出。 |
| b. fetch 后不查 res.ok/status，空体直接 JSON.parse → 透传 SyntaxError | **部分证实**：状态码是有查的（`code != 200` 给 "GitHub answered %d"），但 200+空体/截断体（源自被丢弃的读体错误）确实透传天书。修的就是这一半。 |
| c. 该 fetch 未走代理/镜像设置 | **证伪（对 apiGet）**：`apiGet` 走 `source.Do`，镜像逻辑齐全；有 token 不落镜像（凭证不外泄）。截断体来源不是"没配代理"，是"读了半截没人报错"。 |
| 附加：仓库太大触发截断 | **证伪（gh api 实测）**：stablyai/orca 树 39,667 条、`truncated:false`，GitHub 自身应答完整可解析；GitHub 树应答上限 7MB 带 truncated 标志，也低于 apiGet 的 8MB LimitReader。 |

## curl 探针原始输出（单次诊断请求，2026-10-21）

```
--- repo info ---
HTTP 403
--- tree probe ---
HTTP 403 size=279
{"message":"API rate limit exceeded for 58.152.58.246. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)","documentation_url":"h
--- truncated flag ---
truncated: None entries: 0
--- rate limit ---
{
  "resources": {
    "code_search": {
      "limit": 60,
      "remaining": 0,
      "reset": 1792599969,
      "used": 60
    },
    "core": {
      "limit": 60,
      "remaining": 0,
      "reset": 1792599969,
      "used": 60
    },
    "graphql": {
      "limit": 0,
      "remaining": 0,
```

（本机共享出口 IP 未凭证额度当时已耗尽——恰好实证假设 a 的限流路径给出的是另一套友好提示。）

改用已认证 gh api（诊断目的）：

```
$ gh api repos/stablyai/orca --jq '{full_name, size_kb: .size, default_branch: .default_branch}'
{"default_branch":"main","full_name":"stablyai/orca","size_kb":1533778}
$ gh api "repos/stablyai/orca/git/trees/HEAD?recursive=1" --jq '{truncated: .truncated, entries: (.tree | length)}'
{"entries":39667,"truncated":false}
```

## RED（修复前，pinned-cache 沙箱 HOME）

```
$ go test -run 'TestAPIGetShortAnswer|TestLatestRTKCutAnswer' ./internal/library/
--- FAIL: TestLatestRTKCutAnswer (1.74s)
    rtk_upgrade_test.go:77: said: unexpected end of JSON input
--- FAIL: TestAPIGetShortAnswer (0.01s)
    skillcheck_test.go:198: a cut-short answer wasn't noticed
    skillcheck_test.go:206: an empty answer wasn't noticed
FAIL
```

要点：`TestLatestRTKCutAnswer` 在旧代码下复现出与截图一字不差的
`unexpected end of JSON input`——天书来源钉死。

（首次 RED 尝试的形态修正：panic 前不 Flush 时服务端连头部都没发出，客户端在
Do 阶段收到 EOF，模拟成"连不上"而非"体被切断"；加 `w.(http.Flusher).Flush()`
让头部先到、体半路断，才是报告者的场景。）

## GREEN（修复后）

```
$ go test -run 'TestAPIGetShortAnswer|TestLatestRTKCutAnswer' -v ./internal/library/
=== RUN   TestLatestRTKCutAnswer
--- PASS: TestLatestRTKCutAnswer (1.74s)
=== RUN   TestAPIGetShortAnswer
--- PASS: TestAPIGetShortAnswer (0.01s)
PASS
```

## 消融

仅移除"空 200 体"检查（保留读体错误检查）重跑：

```
--- FAIL: TestAPIGetShortAnswer (1.89s)
    skillcheck_test.go:206: an empty answer wasn't noticed
FAIL
```

空体检查承重，恢复。读体错误检查同理由 RED 案例第一断言承重（旧代码 err==nil）。

## 矩阵

- `gofmt -l`（4 个改动文件）：clean。
- `go vet ./...`：仅 `internal/gui/trayimage_darwin.go` 预存 cgo 警告（不在本次 diff）。
- `GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...`：过。
- `go build ./...`、`GOOS=linux go build -tags nogui ./...`、`GOOS=windows go build ./...`：过
  （ld "newer macOS version" 为本机工具链预存噪声）。
- 新测试 `go test -race -count=3 -run 'TestAPIGetShortAnswer|TestLatestRTKCutAnswer' ./internal/library/`：
  `ok 32.923s`。
- 受影响包全量 `go test -tags nogui -count=1 ./internal/library/`（pinned-cache 沙箱 HOME）：
  `ok 66.511s`。全仓套件未跑（hunt 兄弟车道 d-3045 同口径：矩阵=受影响包全量；改动只落
  internal/library），交付帖 Not verified 已如实披露。
- 消费方断言检查：gui/cli/ui 无任何测试断言旧文案（唯一命中 provider-file-error.test.cjs
  是本地 providers.json 文件报错，与本路径无关）。

## 提交与交付物

- 提交：`f0d77936212645940a5fbad673a1f3b579f3f7ec`（分支 `hunt58-j-skill-install-json`，基线
  `f5b0157420a4491f6e707b49a8af8e87ea8050a1`，4 文件 +58/−2）。身份行已验：author=committer
  = `ggbdpq <ggbdpq@gmail.com>`（`git -c user.name=... -c user.email=...` 方式）。未 push。
- patch：`0001-library-a-GitHub-answer-cut-off-on-the-way-is-said.patch`（148 行），
  SHA-256 前 16 = `f9ccb6544348e153`。
- 交付帖 `3045-comment.body.md`：开头一句划清与 #3045 原题（Codex 图片预算）的界限；
  三件套自检各 ≥1（Attribution 逐字行、details/summary+sha16、branch 行 head SHA），
  嵌入 patch 与 patch 文件 diff 逐字节一致。

## 过程事故（如实记）

后台全仓套件跑到第 8 分钟时发现**两个**并发 `go test -tags nogui` 实例（两套 build 目录，
来源不明，疑似后台任务被重复拉起），互相抢 CPU 且可能拖出时序 flake——全部停掉，改跑
受影响包全量（先例口径），全仓套件如实披露未跑。

## 修复内容

- `internal/library/skillcheck.go` `apiGet`：读体错误不再丢弃（"couldn't read GitHub's answer: %w"）；
  200+空体回 "GitHub answered nothing"（置于 304-缓存回退与 ETag 缓存写入之后/之前各就其位：
  空体不再有入 ETag 缓存的路径）。
- `internal/library/rtk_upgrade.go` `latestRTK`：同型修复（读体错误不丢）。
- 测试：`TestAPIGetShortAnswer`（截断体+空体）、`TestLatestRTKCutAnswer`（截断体）。
  httptest 伪造"头部已到、体半路被切断"（Content-Length 1000 + Flush + panic(ErrAbortHandler)），
  不触网，符合仓库「A test never reaches the network」标准。

## 未验证/不自信项

- 报告者端当时确切是哪种传输失败（代理重置/镜像断流/网络抖动）无法从截图判定；三种来源
  在旧代码里汇成同一条天书。空体之外的"完整但截断的 JSON"（中间人返回半截且干净收尾）仍会
  显示 "wasn't understood"——但那条信息此刻字面上为真（体确实完整到达只是不是合法 JSON）。
- 报告者是否开了 `MAGPIE_MIRRORS`/镜像开关未知；不影响修复正确性。
