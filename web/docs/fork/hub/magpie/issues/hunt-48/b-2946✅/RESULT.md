# Hunt48-B · yetone/magpie#2946 脱敏缺口

日期：2026-10-19 · 工作树：`/tmp/magpie-h15`（分支 `hunt48-b-redact-gaps`，基线 upstream/main `e4ac5e87`）· 未推送、未回帖

## 产出

- Commit：`6be8e04cca4a043b07f932acbfd33e6d3fcd5621`（作者 ggbdpq <ggbdpq@gmail.com>，单提交，5 文件 +232/−3）
- Patch：`0001-redact-the-mask-covers-ark-keys-_KEY-_PASS-names-aut.patch`，sha256 前 16 = `730bc5f317a2cb26`（379 行，已存本目录）
- 英文回帖稿：`2946-comment.body.md`（457 行，无中文，patch 已嵌入 `<details>`+```patch``` 围栏）

## 逐条核对：reporter 的五个领域在 main 上的现状

| # | 领域 | 现状 | 处理 |
|---|---|---|---|
| 1 | `ark-` 密钥 | **部分成立**。`ARK_API_KEY=ark-…` 因名字含 `api_key` 走名字规则本来就被掩；`ARK_KEY=`、行文裸值、请求体内取值不掩。注意探针结论：同一进程里先出现过 `ARK_API_KEY=` 会让后续行经 knownSpans「假绿」，测试每行必须用独立值 | 加 `API_KEY` 值规则 `ark-[A-Za-z0-9][A-Za-z0-9_-]{15,}`（redact.go:111），要求字母数字同在 |
| 2 | `*_KEY`/`*_PASS` 大写赋值名 | 成立。`SERVICE_X_KEY=`/`FOO_KEY=`/`DB_PASS=` 全漏 | 新 `SECRET` 规则（redact.go:131）只认大写结尾；`notAPlainKey`（redact.go:217）挡掉大写的 `SORT_KEY`/`PUBLIC_KEY`/`PROMPT_CACHE_KEY`/`CACHE_KEY` |
| 3 | `Authorization:`/`Cookie:` 不透明值 | 成立（出站文本）。归档侧 `ScrubHeader` 本就按头名全红 | 新 `SECRET` 头行规则（redact.go:135），整值一个占位符，JWT 从 TOKEN 变 SECRET（仍一次掩码） |
| 4 | JSON 字段名不参与判断 | 成立。`{"api_key":随机值}` 等漏出；`access_key_id` 被 `isID` 整体跳过（AKIA 值规则本来认得，但跳过发生在规则之前） | `MaskJSON` 在豁免之前按名字掩值（json.go:352/386）；顺序 = data:→sealed→名字→defs→旧豁免→值规则；`signature`/`encrypted_content`/`data:` 仍原样（#1911 不复发）；`SecretName` 增加 `^pass$|_pass$`（scrub.go:25），归档与出站同名同判 |
| 5 | 归档/OTLP/session 不带自定义规则 | reporter 自己已指向 #1074 / PR #1078 | 不动，只在 Siblings 里说明 |

## TDD：RED → GREEN

- RED（main 上跑，逐行独立值，避免 known 污染）：`TestMaskArkKey`（3 行红，`ARK_API_KEY=` 行本来就绿）、`TestMaskUpperEnvNames`（4 行红）、`TestMaskAuthHeaders`（5 行红，JWT 行绿）、`TestMaskJSONNamedSecrets`（7 行红）。
- GREEN：包内全部测试过（`go test -count=1 ./internal/redact/` ok）。
- 负例（必须不掩）全程绿：`sort_key`、`cache_key`、`public_key`、`db_pass=`（小写）、`SORT_KEY`/`PUBLIC_KEY`/`PROMPT_CACHE_KEY`（大写走 notAPlainKey）、`the authorization is required`、`cookies: 3`、JSON 的 `sort_key`/`cache_key`/`prompt_cache_key`/`public_key`/`signature`/`data`。

## 消融与变异

- 消融：三个产品文件（redact.go/json.go/scrub.go）恢复 upstream、测试保留 → 与初始 RED 完全同集合，无多无少；恢复修复 → 全绿。
- 变异（每处断其规则、看对应行红、负例始终绿）：
  - M1 ark 规则失效 → 行文/JSON 行红；`ARK_KEY=` 行因大写规则独立覆盖仍绿（双保险，记录在案）。
  - M2 `KEY` 分支失效 → `SERVICE_X_KEY`/`FOO_KEY` 红两行；M2b `PASS` 分支失效 → 两行 `DB_PASS` 红。
  - M3 头规则失效 → 5 行红；JWT 行靠 TOKEN 规则仍绿。
  - M4 `namedSecret` 关闭 → 7 行 JSON 全红（`access_key_id` 回到 isID 跳过）。
  - M5 `notAPlainKey` 恒真 → 三个大写负例全红，其余不动。
  - M6 `SecretName` 去掉 `_pass` → `db_pass` 行红。

## 验证矩阵

| 项 | 结果 |
|---|---|
| `go test -count=1 ./internal/redact/` | ok |
| 调用方包：gateway(326s)/sessions/otlp/settings/plugins/redact | 全 ok；masking 无测试文件 |
| internal/gui | 1 个失败 `TestProxyCheckSaysAProxyPassedBy`——**预存**：用 upstream 代码原样复跑同样 502、proxy asked 0 times |
| `gofmt -l internal/redact/` | 干净 |
| `go vet` darwin/linux/windows（redact、masking） | 干净 |
| `go build .` | darwin arm64 ok / windows amd64 ok / linux amd64 失败——wails v3.0.0-beta.24 自身 `menu_linux.go` `undefined: pointer`，与本次改动无关（触碰及调用方包对 linux 单独构建 exit=0） |

## 边界决策及理由

`*_KEY`/`_PASS` 采用「只认大写结尾」而不是「不区分大小写 + sort/cache/public 黑名单」：reporter 的原文就是「大写赋值名」，`.env` 约定大写是密钥、代码里小写 `*_key` 是排序/缓存/公钥，用大小写本身当边界零黑名单；大写里的四个例外（`SORT_KEY` 等）再由 `notAPlainKey` 显式挡掉并进测试。JSON 侧字段名是小写世界，不能照抄大小写边界，故只放行 `SecretName` 既有名单 + `_pass` 结尾（`db_pass` 是 reporter 的 JSON 例子；`_key` 结尾的小写名一律不放行，`sort_key`/`cache_key`/`public_key` 自然不中）。

## 不确定项

1. `ark-` 真实密钥格式未见官方文档给出定长（公开文档只写 `ark-xxxx`）；规则取 ≥16 位且字母数字同在，中转站若发全字母短 key 会漏（漏比误掩安全，可后续放宽）。
2. 未在真实 Volcano Ark / 中转站流量上验证，样本全部是 reporter 的形状 + 合成值。
3. `Authorization: Bearer <JWT>` 的占位符 kind 从 TOKEN 变 SECRET——掩码次数与还原不变，但若下游有依赖 kind 名的消费方需留意（仓库内未发现）。
4. `continuation_token` 这类「名字含 token 的分页游标」在 JSON 里现在会按名掩掉（归档侧今天已如此，属既有语义的延伸）；若某工具的游标需要 vendor 校验，会被占位符替代——还原机制可兜底用户侧，vendor 侧看到的是占位符。
5. gui 的预存失败（proxy check 502）未深查根因，与本单无关，已用 upstream 复跑定性。
