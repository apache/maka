# #2946 redact gaps — rebase onto 318697dc（进行中）

## 步骤 1：读全 + 假设

环境核验：/tmp/magpie-h42 分支 hunt53-r2-redact-gaps，HEAD=318697dcea4ebd7514606a298a56fba9773d893d = upstream/main，工作树干净。

读取清单：
- issue #2946 全文（五领域：ark- 前缀键 / *_KEY、*_PASS 大写赋值名 / Authorization+Cookie 头 / JSON 字段名 / 落盘共用 options）
- 我方原帖 comment 6274744399 全文（含内嵌 patch）
- 原提交 6be8e04cca4a043b07f932acbfd33e6d3fcd5621（基线 e4ac5e87）
- 冲突提交 c0dad80da12289ae0746a6d6574b546b1eae6e09（redact, pii: 本地模型找 PII，#1977）
- 新发现：e4ac5e87..318697dc 触及 internal/redact/ 的提交共两个：c0dad80d 与 3806014a（中文人名，只新增 zhname.go/zhname_test.go、改 model.go，**不触及** json.go/redact.go/scrub.go，与本次冲突无关）
- 新 main 上 internal/redact/json.go、redact.go、scrub.go 全文
- 测试文件 redact_test.go / rules_test.go 在 e4ac5e87..318697dc 间零改动（diff --stat 为空）

### 假设（执行前写下）

五领域在新结构里的落点与存留：
1. **ark- 前缀键**：落点仍是 redact.go `rules` 值规则表。c0dad80d 未加 ark- 规则。→ 假设仍缺，保留。
2. **_KEY/_PASS 大写赋值名**：落点仍是 `rules` 新 SECRET 规则 + `notAPlainKey` helper。c0dad80d 未动该区域（只动 Options/Mask/mask 尾部）。→ 假设仍缺，保留。
3. **Authorization/Cookie 头**：文本侧落点仍是 `rules` 新 SECRET 头行规则；归档侧 ScrubHeader 已有。c0dad80d 未动。→ 假设仍缺，保留。
4. **JSON 字段名**：落点是 json.go `MaskJSON` walk 回调（插 namedSecret）+ scrub.go `secretName` 加 `_pass`。c0dad80d **改了同一回调**（`masked` 闭包 + Model 预扫）＝冲突点。PII 模型默认关（settings.RedactModel off by default）、找 PERSON/ADDRESS/PHONE/EMAIL/ACCOUNT 及自由文本里的 SECRET，不是「字段名叫 api_key 就掩值」。→ 假设仍缺，保留，适配新回调结构。
5. **落盘共用 options**：原 patch 即不覆盖（#1074/#1078 领域）。→ 维持不动。

c0dad80d 是否让某领域已被覆盖：**否**。依据：Model 仅在 settings.RedactModel 开启时接入（默认关）；其输出是文本内 span（人名/地址/电话等），与四领域的结构性规则缺口正交。

冲突预测与解法预案：
- json.go：原 patch 把 walk 回调 `keepIn || signed` 改成四段（data:/signed → namedSecret → keepIn → mask）；新 main 该行已是 `!masked(...)`（masked = !keepIn && 不在 signed 内）+ 回调前多了 Model 预扫。解法：保留上游 masked 闭包与 Model 预扫不动；第二遍 walk 内按原顺序插入：data:/signed 短路 → `!under(defs) && namedSecret` 整段掩 → `!masked` 短路 → mask()。namedSecret 的值会进 Model 预扫的 texts（masked 闭包不知道 namedSecret）——多余但零行为差异（值整段被掩），为最小改动不优化。
- redact.go：rules 表区与 secretValue 上下文未变 → 预期干净。
- scrub.go：c0dad80d 未触碰 → 预期干净。
- 测试文件：预期干净套用。

### RED 原文

命令：`git checkout 6be8e04c -- internal/redact/redact_test.go internal/redact/rules_test.go`（干净套用，无需桥接）→ `GOTOOLCHAIN=auto go test ./internal/redact/ -count=1`，exit=1：

```
--- FAIL: TestMaskJSONNamedSecrets (0.00s)
    redact_test.go:245: api_key: not masked as a secret: {"api_key":"Qm27wVb9nLx4tRk8Ps3d"}
    redact_test.go:245: client_secret: not masked as a secret: {"client_secret":"randomvalue42x"}
    redact_test.go:245: db_pass: not masked as a secret: {"db_pass":"Hr7jTm2qwXz94"}
    redact_test.go:245: access_key_id: not masked as a secret: {"access_key_id":"AKIAIOSFODNN7EXAMPLE"}
    redact_test.go:245: Authorization: not masked as a secret: {"Authorization":"Bearer zq83Mw2vNx7kRt5"}
    redact_test.go:245: Cookie: not masked as a secret: {"Cookie":"sid=Yn41Pc8wLd2mQs6"}
    redact_test.go:245: apiKey: not masked as a secret: {"apiKey":"plainrandomvalue1"}
--- FAIL: TestMaskArkKey (0.00s)
    rules_test.go:109: "ARK_KEY=ark-6f2a9d47-1c3b-8e5f-a7d9-0b4c2e6f8a1d": 0 masked: …
    rules_test.go:109: "the ark key is ark-93be1f6c-7a2d-4b8e-9c0f-5d3a7e1b9c2a": 0 masked: …
    rules_test.go:109: "{\"notes\":\"relay key ark-2e7c4a19-…\": 0 masked: …
--- FAIL: TestMaskUpperEnvNames (0.00s)
    rules_test.go:153: "SERVICE_X_KEY=Vt57wQx2mLp9kNr4Zc8b": 0 masked: …
    rules_test.go:153: "FOO_KEY=Jw83hT6yQv2nRs9Xd5ke": 0 masked: …
    rules_test.go:153: "DB_PASS=\"Mr4tQw9xZb7n\"": 0 masked: …
    rules_test.go:153: "DB_PASS=Kp8vHs3wTn6j": 0 masked: …
--- FAIL: TestMaskAuthHeaders (0.00s)
    rules_test.go:182: "Authorization: Bearer mfa_9x2kQ7wLr4Tz": 0 masked, want 1: …
    rules_test.go:182: "authorization: Basic Zm9vYmFyYmF6": 0 masked, want 1: …
    rules_test.go:182: "Cookie: sid=8f3kz9a1x2c4": 0 masked, want 1: …
    rules_test.go:182: "cookie: session=deadbeef42": 0 masked, want 1: …
    rules_test.go:182: "POST /v1 HTTP/1.1\nAuthorization: …\nCookie: …\n": 0 masked, want 2: …
FAIL
FAIL	github.com/yetone/magpie/internal/redact	0.794s
```

全包基线：仅四个新测试红，预存测试（含 TestMaskGatewayKey 负例）全绿。ARK_API_KEY= 行与 JWT 行本来就绿（名字规则/TOKEN 规则），符合原帖描述。**无领域被 c0dad80d 覆盖，四领域全部保留。**

### GREEN 原文

cherry-pick 冲突：仅 `internal/redact/json.go`（UU），与预测一致；redact.go、scrub.go、两测试文件自动并入。
解法：上游 `masked` 闭包与 Model 预扫原样保留；walk 回调内按原顺序插入 data:/signed 短路 → `!under(defs) && namedSecret` 整段掩 → `!masked` 短路 → mask()。
`GOTOOLCHAIN=auto go test ./internal/redact/ -count=1` → exit=0：

```
ok  	github.com/yetone/magpie/internal/redact	1.131s
```

新提交：`cc7cf36bd387ba00b69df34a6b58688584d82cfc`，author/committer 均 `ggbdpq <ggbdpq@gmail.com>`，commit message 与原提交逐字一致（含 `Generated-by: GLM-5.3-Flash (ZCode)`），`git log -1 --format=%B` 已核对。无领域剔除，message 未改动。stat：5 files changed, 231 insertions(+), 2 deletions(-)。

### 消融记录（保留测试，逐个还原产品文件）

| 还原文件 | exit | FAIL 原文（断言级） |
|---|---|---|
| `git checkout upstream/main -- internal/redact/json.go` | 1 | TestMaskJSONNamedSecrets 7 行全红（api_key/client_secret/db_pass/access_key_id/Authorization/Cookie/apiKey 各 not masked as a secret） |
| `git checkout upstream/main -- internal/redact/redact.go` | 1 | TestMaskArkKey 3 行 + TestMaskUpperEnvNames 4 行 + TestMaskAuthHeaders 5 行全红（原文同 RED 段） |
| `git checkout upstream/main -- internal/redact/scrub.go` | 1 | 仅 `redact_test.go:245: db_pass: not masked as a secret: {"db_pass":"Hr7jTm2qwXz94"}` |

三次消融编译全过，**无一次 build failed，零桥接**。还原后复绿：`ok … 0.816s`（exit=0）。

### 三查

**(a) 变异回红**（每处打断→对应行红→`git checkout HEAD --` 还原）：

| 变异 | 结果 |
|---|---|
| ark- 规则 `ark-` → `arkz-` | prose 行 + JSON body 行红；ARK_KEY= 行靠大写 env 规则存活（独立覆盖）；ARK_API_KEY= 行靠名字规则存活 |
| 大写规则 KEY 分支 `(?:KEY\|PASS)` → `(?:KEYX\|PASS)` | SERVICE_X_KEY/FOO_KEY 两行红；DB_PASS 行绿 |
| 大写规则 PASS 分支 → `(?:KEY\|PASSX)` | DB_PASS 两行红；KEY 行绿 |
| 头规则 `(?:authorization\|cookie)` → `(?:xuthorization\|cooxie)` | 5 行不透明值全红；JWT 行靠 TOKEN 规则存活 |
| namedSecret `key != ""` → `key == ""` | 7 行 JSON 全红 |
| notAPlainKey return → `true` | SORT_KEY/PUBLIC_KEY/PROMPT_CACHE_KEY 三行红（被误掩），小写负例与正例行全绿 |

六处变异各自恰好打红自己的行，互不越界。

**(b) 调用方清单**（`rg -n 'redact\.[A-Z]' internal/ --type go -l`，全部不改）：
- `internal/gateway/`（archive/capture/conversations/gateway.go）：出站掩码走 masking→MaskJSON/Mask（新规则自动生效），归档走 Scrub*（secretName 与请求侧名字一致化是本单意图）；其测试在消费方矩阵中跑。
- `internal/masking/masking.go`：settings→Options 接线，本单未动 Options，无需改。
- `internal/gui/api.go`：设置 UI 按 kinds/rules 列表渲染，本单未新增 kind（SECRET/API_KEY 已存在），无需改。
- `internal/otlp/otel_sessions.go`、`internal/sessions/gateway.go`：Scrub* 消费方，`_pass` 名字一致化使其归档侧同步受益，行为一致化正是 issue 诉求；其测试在矩阵中跑。
- `internal/pii/`（find/serve.go）、`internal/settings/`、`plugins/redact/`：模型/设置/用户规则，与本单正交，未触碰。

**(c) 不可解析 JSON / 非字符串值**（临时探针测试，跑后已删）：
- 截断坏 JSON `{"api_key": "plainrandomvalue1"` → 回退文本掩码，值被名字规则掩为 `{{SECRET_kcprt4gf}}`（输出保持原文坏形，回退路径语义与改前一致）。
- 纯文本 `Authorization: Bearer zz9x8y7w6v` 经 MaskJSON → 头规则掩（n=1）。
- `{"api_key": 12345}`（数字值）逐字节原样（walk 只见字符串）。
- `{"api_key": ""}` 空串原样（len<8 守卫）。
预存 `TestMaskJSON` 的 `plain := { "a" : [1, 2.5e3, true, null, "xé"] }` 行同时锁定非字符串值逐字节通过，全程绿。

### 矩阵

| 项 | 命令 | exit | 结果 |
|---|---|---|---|
| 定向 -v | `GOTOOLCHAIN=auto go test ./internal/redact/ -count=1 -v 2>&1 \| tail -40` | 0 | PASS（含 TestMaskGatewayKey、TestChineseNames） |
| 全包 | `GOTOOLCHAIN=auto go test ./internal/redact/... -count=1` | 0 | `ok … 0.904s` |
| race | `GOTOOLCHAIN=auto go test -race ./internal/redact/ -count=1` | 0 | `ok … 3.740s` |
| gofmt | `gofmt -l $(git diff --name-only upstream/main -- '*.go')` | 0 | 空输出 |
| vet | `GOTOOLCHAIN=auto go vet ./internal/redact/` | 0 | 无输出 |
| build darwin arm64 | `GOOS=darwin GOARCH=arm64 GOTOOLCHAIN=auto go build ./...` | 0 | ok（仅 ld 版本警告） |
| build linux amd64 | `GOOS=linux GOARCH=amd64 GOTOOLCHAIN=auto go build ./...` | 1 | 失败在 wails v3.0.0-beta.24 自身 `webview_window_linux.go`（`undefined: pointer`，模块缓存文件，非仓库 diff）；`go build ./internal/redact/... ./internal/masking/...`（linux）= ok（exit 0） |
| build windows amd64 | `GOOS=windows GOARCH=amd64 GOTOOLCHAIN=auto go build ./...` | 0 | ok |
| 消费方 | `go test ./internal/gateway ./internal/usage ./internal/sessions ./internal/otlp ./internal/settings ./plugins/redact ./internal/masking ./internal/gui -count=1` | 1（仅因 gui） | gateway `ok 348.980s`、usage `ok 24.617s`、sessions `ok 32.657s`、otlp `ok 11.918s`、settings `ok 28.593s`、plugins/redact `ok 5.073s`；masking 无测试文件；gui 唯一红 `TestProxyCheckSaysAProxyPassedBy`（`proxycheck_test.go:100: … Error:HTTP 502 …, the proxy asked 0 times`）——在干净 318697dc 上单独复跑同样红（HTTP 502/asked 0 times），定性预存；随后 `go test ./internal/redact -count=1`=`ok 1.010s` 复绿 |

注：`internal/routing/` 在本仓库不存在（简报猜测的包名）；`internal/usage/` 存在并已纳入后台跑。

### 产出

- patch：`0001-redact-the-mask-covers-ark-keys-_KEY-_PASS-names-aut.patch`（产物目录）
- sha256 前 16：`8982602d692e9648`
- 新 head：`cc7cf36bd387ba00b69df34a6b58688584d82cfc`（分支 hunt53-r2-redact-gaps，主线程 force-push 用原分支名 hunt48-b-redact-gaps）

### 不确定项

- internal/gui 的 `TestProxyCheckSaysAProxyPassedBy` 在新基线（318697dc）上仍预存红（本单已在干净基线单独复跑定性：同样 HTTP 502 / proxy asked 0 times）；commit message 里引的旧基线号仍是 e4ac5e87（message 按纪律逐字保留，未改）。
- linux `go build ./...` 失败点在 wails v3.0.0-beta.24 模块自身文件（模块缓存路径），未在 e4ac5e87 上重跑同命令对照（原交付已记录同类预存；且失败文件不在本仓 diff 内）。
- PII 模型（#1977）未端到端跑过（默认关、需下载 GGUF）；本单未触碰其预扫逻辑，named secret 的值会进预扫 texts（masked 闭包不知道 namedSecret），行为无差异（值整段被掩），属已接受的最小适配。
- `internal/routing` 包在本仓不存在；usage 为实际存在的消费方并已跑绿。

### 终态

- /tmp/magpie-h42：分支 hunt53-r2-redact-gaps，HEAD=cc7cf36bd387ba00b69df34a6b58688584d82cfc，工作树干净（git status 无输出）。
- 产物：report.md、comment.md、consumers.log、0001-redact-the-mask-covers-ark-keys-_KEY-_PASS-names-aut.patch（均在产物目录）。
- 未 push、未发帖、未动主 clone、未动其他 /tmp/magpie-h*。


