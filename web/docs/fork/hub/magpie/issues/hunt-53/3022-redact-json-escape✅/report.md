# #3022 内置邮箱脱敏破坏历史 tool arguments 的 JSON 转义 — 狩猎报告

分支 `hunt53-f-redact-json-escape`（base `318697dc` = upstream/main），head **`d6a8df9c`**（全 SHA `d6a8df9c8c1ce4905a9f78591e936d491448b19a`）。

- patch：`0001-redact-a-mask-match-in-tool-arguments-never-starts-at-an-escape.patch`，SHA-256 前 16 **`b95c245b76fbf05f`**
- 帖草稿：`issue-body.md`（英文，五段 + 规定尾部，零中文已核）
- commit message：`commit-msg.txt`；中间态修复备份：`fix.diff`；gateway 日志：`gateway-redact.log`
- 叠加检查：两 patch 干净叠加，`go test ./internal/redact/...` 绿 → 帖内已写 "applies cleanly on top of the #2946 patch as well"
- 未 push、未发帖；主 clone 未动；stack worktree 已 remove；`.issue-3022.json` 已删

## 改动面（4 文件，+97/−9）

| 文件 | 改动 |
|---|---|
| `internal/redact/redact.go` | `mask`/`takes` 加 `jsonText bool` 参数；`takes` 中 jsonText 时拒「匹配起点前反斜杠数为奇数」（转义引导） |
| `internal/redact/json.go` | MaskJSON 的 walk fn 传 `asJSON(key, "")`（复用 Restore 侧既有判断：arguments/partial_json 是 JSON 文本载体） |
| `internal/redact/scrub.go` | 传 `false`（归档清洗是纯文本） |
| `internal/redact/escape_test.go`（新增） | 报告场景端到端 + 真邮箱仍遮 + 一层 JSON 的 Windows 路径照遮 |

## 三条机理假设的验证结论（全部成立，探针钉死）

1. **EMAIL 把 `n@mcp.tool` 当邮箱** — 成立。探针（base）：match `"n@mcp.tool"` at [28:38]，left=`\` 不在 bound（`alnum+"._%+-"`，语义见 `takes` redact.go:505「匹配两侧字符不得属于该集合」），right=`(` 不在，`realEmail("n@mcp.tool")=true`，`takes=true`。markers 的作用：文本含 `@` 才跑正则（`containsAny`）。
2. **walk 解一层后把内层 JSON 文本（`\n` 为两字符）交 mask** — 成立。探针 `%q` 显示 decoded arguments 中 `\\n`（字节 `\`+`n`）；json.go value()（313 行）只解外层转义。
3. **替换留 `\`+占位符 → `\{` 非法 → 内层 JSON 破坏 → 上游 400** — 成立。修前输出 `...\{{EMAIL_gclnmmco}}()...`，外层 `json.Valid` 过、内层 `json.Valid` **false**。`\u0040` 绕过原因：去掉 `@` 字面 → markers 不中 → 规则整个跳过。

## RED / GREEN 原文

RED（base 三产品文件还原、测试保留）：

```
    escape_test.go:31: 2 masked, want 1: {"messages":[{"role":"user","content":"write {{EMAIL_y22z2iun}} about the demo"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\"command\":\"print('before')\\{{EMAIL_fbpoezfb}}()\\ndef demo():\\n    return 1\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"done"}]}
--- FAIL: TestMaskJSONKeepsArgumentsJSON (0.00s)
FAIL
FAIL	github.com/yetone/magpie/internal/redact	0.944s
```

GREEN：`--- PASS: TestMaskJSONKeepsArgumentsJSON` / `ok`。占位符哈希每次随机（key 随机），非差异。

## 修法演进（两次修正，均有测试证据）

1. 初探针（一次性 probe_test.go）钉死机理后删除。
2. 初版测试构造错误：`json.Marshal(map)` 生成 object，而协议里 `arguments` 是承载内层 JSON 文本的**字符串**——第一次红是假红（cannot unmarshal object），重写为双层编码（`json.Marshal(string(inner))`）后才是真红。
3. 修复第一版（`takes` 无条件拒前一字符 `\`）打破既有 `TestMoreKinds`/`TestMoreKindsJSON`（`C:\Users\Rina Kato`、`C:\Users\rkato` 单反斜杠路径**必须遮**）——这两个失败暴露了正确分层：一层 JSON 字符串里的单 `\` 替换后由外层 `jsonEscape` 重新转义，本就安全；破坏只发生在**值本身是 JSON 文本**时。终版：`jsonText bool` + 奇偶判据（奇=转义引导拒，偶=`\\` 完整转义对放行）。
4. 操作失误两次（`git -C` 目标打错的 am、checkout 丢修复），均恢复无损，修复以产物目录 `fix.diff` 持久化后再操作。

## 消融（终版）

`git diff upstream/main > fix.diff` → checkout 还原 redact.go/json.go/scrub.go、保留 escape_test.go → 跑定向读原文（上 RED 块，断言级 `2 masked, want 1`）→ `git apply fix.diff` → 复绿 `ok`。`git diff --name-status upstream/main` = 三产品文件 + 新测试。

## Watched 三查

**(a) 打破**：奇偶守卫短路（`if false && c%2 == 1`）→ `FAIL`；还原重放 → `ok`。中间版另做过 `'/'` 变体打破 → `FAIL`。

**(b) bound 全清单**（判据：破坏 ⟺ match 起点前是奇数连续 `\`；合法 JSON 字符串中 `\` 后只能是 `" \ / b f n r t u`）：

- **会被打到、修复同拒**：EMAIL（`\n@mcp.tool` 本单）；API_KEY `npm_…`（起点 n，`\n` 后）；API_KEY `…_sk_…`（起点任意小写字母）；MAC（起点 hex 含 b/f，`\b`/`\f`）；IPv6（同上）；home 路径 USERNAME、userhost #1、BUCKET #2/#3（模式前缀可为 `\`，此三类默认关）。
- **打不到（结构性）**：起点为数字（ID_CARD/PHONE/BANK_CARD/SSN/IBAN/IPv4——`\`+数字是非法转义）；起点为大写（IBAN/AKIA——转义第二字符是小写）；match 与前文之间有引号/冒号/标签（SECRET/PASSWORD/PASSPORT/BIRTHDAY/SERIAL/HostName-User 行规则/s3:// bucket）；PRIVATE_KEY 起点 `-`（`\-` 非法）。
- **`\t` 后数字**（任务提示的疑点）：PHONE/BANK_CARD 的 left=`t` 不在 digits → **遮**，但 `\t` 转义完整保留、JSON 不破坏、遮的是 tab 后真值——正确行为，不改。ID_CARD/IBAN 等因 bound 含 alnum 被拒——既有语义，不改。
- **knownSpans**（known.go:172 standsAlone）不走 takes，EMAIL 分支同样放行 `\`；修后规则层不再产生 `n@mcp.tool` 这类假 known 值，存量随重启消失——不扩大。
- **TERM（Words）** 不走 takes、无边界概念是既有语义——不动。
- 调用方不改理由：3 处 mask 调用即全部（Mask/scrub/MaskJSON walk fn），签名变更闭环于包内；gateway/provider/gui 等走导出面（Mask/MaskJSON/Scrub/Restore），签名未变。

**(c) 坏 JSON 输入**：截断 body（`{"a":`）→ walk 失败 → `Mask` 纯文本原路径（n=0 原样）；内层坏 JSON（`"{not json but a string"`）→ 外层合法、字符串照扫（n=0 原样）。今天与修后**路径一致**（walk 失败 fallback 与字符串照扫都不变）；输出差异仅在「奇数 `\`+match」处不遮——即修复目标本身。

## 兄弟面探针（奇偶中间版 + 终版测试覆盖）

- 嵌套 JSON 内 Windows 路径：`{"cwd":"C:\\Users\\nico\\proj"}` 经 arguments → `C:\\Users\\{{USERNAME_ypj574kq}}\\proj`，内层 `json.Valid`=**true**——`\\` 完整转义对放行，语义保留。
- **终版下普通文本单反斜杠路径照遮**（`TestMoreKinds`、`TestMoreKindsJSON`、escape_test body2 全绿）——中间版探针观察到的 fail-open 已被终版消除，仅在 jsonText=true 的字符串里存在（合法内层 JSON 不可能有单 `\U`，实际只拒转义孤儿）。
- 真实 fail-open 面：arguments 内层文本中紧跟转义字母的真值（`\njo@quill.dev`）不遮；修前是遮错值 `njo@quill.dev` 且破坏 JSON。

## 矩阵（逐项）

| 项 | 命令 | 结果 |
|---|---|---|
| 定向 | `go test ./internal/redact/ -run TestMaskJSONKeepsArgumentsJSON -count=1 -v` | PASS |
| 全包 | `go test ./internal/redact/... -count=1` | ok |
| 消费方抽查 | `go test ./internal/gateway/ -run 'Redact|redact|Mask' -count=1`（后台，日志落产物目录） | ok，exit=0 |
| race 定向 | `go test ./internal/redact -race -run 'TestMaskJSONKeepsArgumentsJSON\|TestMaskJSON\|TestMoreKinds'` | ok |
| gofmt | `gofmt -l internal/redact/` | 空 |
| vet | `go vet ./internal/redact` | clean |
| build | darwin/arm64 `go build ./...`；linux/amd64 `-tags nogui`；windows/amd64 | 全 ok（darwin 有预存 ld/clang 警告，非本次引入） |
| 叠加 | stack worktree：am #2946 → am 本单 → 全包 | 干净叠加，ok，worktree 已 remove |
| 提交身份 | `git config user.name / user.email` | ggbdpq / ggbdpq@gmail.com ✓ |

## 不确定项

- 真 Ollama Cloud 端到端未跑（任务明令不跑真上游）；上游 400 的推断链条由单测锁定的「内层 JSON 非法」一环支撑。
- issue 引用的行号（redact.go#L133/json.go#L385）按 `318697dc` 核对一致；帖内 file:line 均按该 base。
- `\r\n@decorator`、多装饰器、Windows 路径+装饰器混合等报告回归清单未逐一补测试（任务范围：报告场景 + 负例守卫 + 兄弟守卫）；机理同源（奇偶判据不分行尾形态），如实写进帖内 Not verified。
- 长驻进程若在升级前已把 `n@mcp.tool` 之类假值存入 known 内存表，升级行为不变（knownSpans 不走 takes），重启即清——已写进帖内 Siblings。
