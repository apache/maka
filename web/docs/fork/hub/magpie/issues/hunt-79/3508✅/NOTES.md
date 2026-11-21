# hunt79-f-3508 过程笔记

Issue: library: an MCP server signed in to in Codex itself still says "needs sign-in"
Take comment: https://github.com/yetone/magpie/issues/3508#issuecomment-6386991262
基线: a84d2ec8（任务书钉定；upstream/main 已到 b97e0aa2 但 4 个新提交均未触及 internal/library/）

## codex-rs 格式核实（源码对照，2026-10-25 实测）

报告者说格式是 StoredOAuthTokens（server_name, url, client_id, token_response, expires_at, …）——**不准确**。
那是内存结构（oauth.rs `pub struct StoredOAuthTokens`，token_response 是 WrappedOAuthTokenResponse）。
磁盘文件 `$CODEX_HOME/.credentials.json` 是 `BTreeMap<String, FallbackTokenEntry>`（oauth.rs FALLBACK_FILENAME、FallbackTokenEntry）：

- key = `compute_store_key(server_name, url)` = `{name}|{16hex sha256 of {"type":"http","url":url,"headers":{}}}`（executor 名用 `:` 分隔）
- entry 字段：server_name(必填), server_url(必填), issuer(可选), client_id(必填), access_token(必填), expires_at(可选毫秒), refresh_token(可选), scopes(可选), executor_owned(可选 bool)
- host 查询匹配（load_oauth_tokens_from_file_with_lock_held）：entry.server_url == url && entry.server_name == 查询名（查询名 local: 前缀剥离）；**executor_owned 条目永不匹配 host 查询**
- 文件时机：`mcp_oauth_credentials_store`（config.toml，无 _mode 后缀）= file，或 auto（默认）+ keyring 不可用（resolved_store.rs Backend::File / config mod.rs 938-940 行注释 "auto (default): keyring if available, otherwise file"）
- 源文件路径：
  - codex-rs/rmcp-client/src/oauth.rs（105 行 StoredOAuthTokens、857 FALLBACK_FILENAME、862 FallbackTokenEntry、881 load_oauth_tokens_from_file、1056 compute_store_key）
  - codex-rs/rmcp-client/src/oauth/resolved_store.rs（Backend::File/Keyring、resolve policy）
  - codex-rs/core/src/config/mod.rs（4541 mcp_oauth_credentials_store → _mode）
  - codex-rs/cli/src/mcp_cmd.rs（codex mcp login → mcp_oauth_credentials_store_mode）

## magpie 侧事实

- 模板 14b10f11：readOwnSignIns 只读 claude（claudeCredentialsOf 锚 t.Settings 旁）；mcp_check.go 的 healthKey/checkServer 已 agent 无关，**本单 mcp_check.go 零改动**；GUI client.js nameOf 通用，**GUI 零改动**；docs/subsystems/library.md 第 22 行需扩一句。
- Codex target：host = "codex"，t.MCP.Path = codexDir()/config.toml；WSL = "codex@wsl:X"，t.MCP.Path = <distro home>/.codex/config.toml（UNC 直读）。credentials 锚点 = Dir(t.MCP.Path)/.credentials.json。
- 本机 ~/.codex/.credentials.json 不存在（实测）→ fixture 按 codex-rs 源码构造，帖内如实说明。
- sandbox(t) 已写 ~/.codex/config.toml，codex 默认是靶；agent.FakeWSL 造 distro 靶。

## 假设（动手前钉住）

1. 计数规则 = access_token 或 refresh_token 非空且 URL 非空（与 Claude 变体同型：无 token = 未完成登录）；executor_owned=true 跳过；不看 expires_at（模板同款，"是否持有登录"而非"token 是否仍有效"）。
2. 不前置检查 mcp_oauth_credentials_store 配置（文件存在才读；永不读 keyring——issue 红线）。
3. 读失败/解析失败 → 该 target 留空，check 自己的答案成立（失败读取语义，测试钉住 "{not json"）。
4. 名字匹配 = entry.server_name == 库服务器名（magpie 写入两边同名），URL 同 signInKey（trim 尾 /）。

## RED/GREEN/消融/矩阵（结果回填）

（进行中）

## RED（2026-10-25，基线 a84d2ec8 + 新测试）
go test -tags nogui -count=1 -run TestCheckNamesCodexSignedInItself ./internal/library/
FAIL: TestCheckNamesCodexSignedInItself (1.98s)
    mcp_agent_signin_test.go:178: signed in in codex@wsl:Ubuntu, the check says {State:auth Tools:0 ToolList:[] Why: Code:401 Detail: OAuth:true SignIn:<nil> AgentSignIn:[] Step: Waited:0 Checked:[] At:1792861527185}

## GREEN（a84d2ec8 + 修复）
go test -tags nogui -count=1 -run 'TestCheckNamesCodexSignedInItself|TestCheckNamesAgentsSignedInThemselves' ./internal/library/
ok github.com/yetone/magpie/internal/library 2.374s（两测试同绿）

## 消融（只动产品文件、测试保留，全部回红后恢复）
A. codexCredentialsOf 恒返回 ""（旧行为）→ RED L178 "signed in in codex@wsl:Ubuntu, the check says {State:auth ... AgentSignIn:[]}"
B. 删 executor_owned 跳过 → RED L200 "only the executor's sign-in counted ... AgentSignIn:[codex@wsl:Ubuntu]"
C. 删无 token 判断 → RED L181 "a sign-in with no token counted ... AgentSignIn:[codex@wsl:Ubuntu]"

## 兄弟面（rg 全查，改/不改理由）
- mcp_check.go healthKey/checkServer/ServerHealth.AgentSignIn：agent 无关管道，零改动（rg 证实全部消费方仅此一处）
- GUI client.js nameOf=agentOf(id)?.name||id 通用渲染 + i18n 模板已备：零改动
- provider/codex_store.go(Codex auth.json)、CodexKeychain、provider/claude_dirs.go(Claude 账户 .credentials.json)：模型账户/账户登录面，非 MCP OAuth store，红线"永不读 keyring"，不动
- wslTargetOf codex 分支已给 t.MCP.Path（distro home/.codex/config.toml），codexCredentialsOf 派生即覆盖 distro
- docs/subsystems/library.md L22：同步扩一句（模板先例同 commit 改 doc）

## 读失败语义
os.ReadFile err → skip；json.Unmarshal err → skip。该 target 留空：check 自己的 401/auth 答案成立（"未知"，不按未登录、也不虚报已登录）。测试第 4 段 "{not json" + executor 段钉住。

## 矩阵（全绿）
gofmt -l 空；vet darwin/linux nogui/windows OK；build darwin/windows/linux nogui OK（darwin 链接 cgo 警告预存）；
包全量 -tags nogui -count=1 ./internal/library/ ok 70.6s；两登录测试 -race ok。

## 发布
push origin hunt79-f-3508 → ls-remote head 766a6775afc7144aa83f148be0ec1c94facf6964 == 帖中 sha；
fetch upstream 复查零新提交触及目标文件；评论查重仅 take；交付帖 #issuecomment-6387146157；
GET 回读九项全 PASS（中文仅 patch 围栏内 docs diff 预存署名，正文零中文；sha16 往返一致）。
产物：/tmp/magpie-hunt79-f/{3508.patch, magpie-hunt79-f-post-head.md, posted.json, NOTES.md}
