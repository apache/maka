# hunt53 / issue #3040 工作报告（Droid `"${VAR}"` 与 OpenCode `{env:VAR}` api key 引用被判 drift）

日期：2026-10-20。worktree `/tmp/magpie-h47`，分支 `hunt53-g-agent-env-key`，base `318697dc`（upstream/main 在作业期间前移到 `a9304efe`，按任务锁定 base 未动）。只本地修改：未 push、未发帖、未碰主 clone。

## 产物

- commit：`92c48a03102a7cf502e6f86b2724c06c3ee8fa62`（head 前 9：`92c48a031`），作者 `ggbdpq <ggbdpq@gmail.com>`。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt53/3040-agent-env-key/0001-agent-droid-opencode-env-key.patch`，SHA-256 前 16：`c26695dfd86cc5e1`（514 行）。
- 英文帖：同目录 `issue-body.md`（五段 + Source/Red/Siblings/When the read fails/Not verified/Branch/Attribution/Patch 严格顺序；零中文已校验；4 个围栏配对；内嵌 patch 与 format-patch diff 一致）。
- commit message 存稿：同目录 `commit-msg.txt`。
- 全包日志：同目录 `agent-full.log`。

## 改动面（6 文件，+307/−6）

- `internal/agent/gatewaykey.go`：`keyHolds` 旁新增共享 `envRefKey`（整值单引用 → 从本机环境读变量；名字/known 返回）与 `envRefKept`（引用 holds 或 unknown → 保留引用；known 且错 key → 字面 magpie key）。
- `internal/agent/droid.go`：`droidEnvRef`（`^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$`，只认文档写的 `${VAR_NAME}`）；Check 的 get 对 apiKey 走 envRefKey（unknown → 返回 gwKey 使 keyHolds 成立，即不报）；`setModels` 收集现有 magpie 条目的 apiKey，重建时过 `envRefKept`。
- `internal/agent/agents.go`：`openCodeEnvRef`（`^\{env:([^}]+)\}$`）；`openCodeLike` Check 同形；新增 `openCodeValue` 包 provider 值构造，`openCodeLike` 的 Sync 与 `openCodeRefAt` 的 pick 两处调用点接入 `envRefKept`。
- `internal/agent/droid_test.go`：`TestDroidWithAKeyInTheEnvironment`；`internal/agent/opencode_test.go`（新文件）：`TestOpenCodeWithAKeyInTheEnvironment`。各覆盖四 case（gateway key / magpie 自身 key / 变量未设=unknown / 错 key）+ pick + 组合值。
- `docs/subsystems/agent-wiring.md`：Hermes 行后加一行（按 b9d1cd36 先例）。

## 外部核实

- **OpenCode**：`{env:VAR}` 从 `process.env` 取值，未设替换为空串；另有 `{file:path}`（本次不覆盖，列 Left）。两代实现：
  - OpenCode 2（现行 dev）：[packages/core/src/config/variable.ts 的 substitute](https://github.com/sst/opencode/blob/dev/packages/core/src/config/variable.ts)（`/\{env:([^}]+)\}/g`，`input.env?.[name] ?? process.env[name]`），由 [packages/core/src/config.ts 的 loadFile](https://github.com/sst/opencode/blob/dev/packages/core/src/config.ts) 对每个配置文件调用；引用 commit `f09eee5002b8495bff5629bad7907a36767ab39a`（2026-10-16）。
  - OpenCode 1：[packages/opencode/src/config/config.ts 的 load](https://github.com/sst/opencode/blob/63d2b21b8fd89ee11282be7a62479b0ba2ae3f0c/packages/opencode/src/config/config.ts)（同样替换，`process.env[varName] || ""`），ref `63d2b21b`。
  - 官方文档：[opencode.ai/docs/config](https://opencode.ai/docs/config/)（Variables 节：`{env:VARIABLE_NAME}`、未设→空串、`{file:path}`）。
- **Droid**：官方文档 [Custom Models (BYOK), docs.factory.com](https://docs.factory.com/model-independence/byok)："apiKey supports environment variable references using ${VAR_NAME} syntax"，值来自环境（`export`），无 dotenv；另记载 `apiKeyHelper`（脚本，优先于 apiKey）——超出本次范围，帖内已注明。闭源二进制行为未验证，按「未证实」只做文档内的 `${VAR_NAME}` 形态。
- **Crush**（Left 依据）：[charmbracelet/crush README](https://github.com/charmbracelet/crush)："Values support the same `$VAR` and `$(command)` expansion as other config fields"。

## Hermes helper 复用情况

- 直接复用：`keyHolds`、`wiringOff`、"unknown → 返回 `at.gwKey()` 让 keyHolds 成立"的 get 模式、kept 三分支语义（holds 保 / unknown 保 / 错 key 落字面）。
- 未复用本体：`hermesKey` 读 config 旁 `.env`（Droid/OpenCode 均无 dotenv，来源不同，维护者要求 per-agent 按各自源码/文档确认）；`hermesKeptKey` 的 .env 写入半对无 dotenv 的 agent 无意义。故新增 `envRefKey`/`envRefKept` 共享对，Droid/OpenCode 共用，Hermes 路径未动。

## RED（base 318697dc，只加测试）

```
--- FAIL: TestDroidWithAKeyInTheEnvironment (0.91s)
    droid_test.go:341: a gateway key in the environment is drift: Droid's apiKey (settings.json) was changed, so magpie's gateway won't take its requests
--- FAIL: TestOpenCodeWithAKeyInTheEnvironment (0.01s)
    opencode_test.go:46: a gateway key in the environment is drift: OpenCode's apiKey (opencode.json) was changed, so magpie's gateway won't take its requests
```

## GREEN

两测试定向 `ok`；定向家族（TestDroid|TestOpenCode|TestHermes|TestKeyHolds|TestGatewayKey|TestWiring|TestAir|TestOpenChamber|TestMiMo|TestDevEco|TestCrush）`ok`。

## 消融（全文件，读断言级原文）

1. 还原 `droid.go`（留测试）→ Droid 测试红：`droid_test.go:341: a gateway key in the environment is drift: Droid's apiKey (settings.json) was changed…`；OpenCode 测试仍绿 → 恢复复绿。
2. 还原 `agents.go`（留测试）→ OpenCode 测试红：`opencode_test.go:46: a gateway key in the environment is drift: OpenCode's apiKey (opencode.json) was changed…` → 恢复复绿。
3. 还原 `gatewaykey.go` → build failed，符号闭包恰好是新 helper 本身：`undefined: envRefKey`（agents.go:816、droid.go:260）、`undefined: envRefKept`（agents.go:870、droid.go:186）→ 恢复复绿。
4. Watched(a) 变体：只去掉 Droid sync 半（envRefKept 行）→ Check 过但 sync 覆写：`droid_test.go:346: a gateway key: the user's reference was written over: magpie` → 恢复复绿。

## Watched 三查

- (a) 手动打破：消融 1/2/4 即「改回字面比较/去 sync 半」，均回红并已还原复绿。
- (b) 比较点清单（`rg 'keyHolds\(|openCodeKeyAt\(|gwKey\(\)'`）：已修 = Droid（droid.go）、openCodeLike（agents.go：OpenCode/MiMo Code/DevEco Code 同一 Check）。Left（建议维护者开 issue，不扩修）= **Crush**（agents.go，`providers.magpie.api_key`；README 证实 `$VAR`/`$(command)` 展开）、**Air** 与 **OpenChamber**（各自的 OpenCode 配置里同一 `provider.magpie.options.apiKey`，OpenCode 会展开 `{env:VAR}`，其 Check 仍字面比）。无引用形态（按各自文档一句话判定）：Gemini CLI/DeepSeek Harness（.env 值即字面）、Claude Code（settings 字面；间接手段是 apiKeyHelper 脚本）、Codex（auth.json 字面；间接手段是 env_key 命名变量）、Qwen/Kimi/Grok/MiniMax/Morph/Muse/omp/Pi/fx/Qoder/Goose（JSON/YAML/TOML 字段字面）、Cline（键存 settings store）、Zed（magpie 不写 key，Check 只比 api_url）。Roo/Kilo 无本仓库 agent。
- (c) 变量未设/不可读 → unknown：不报、sync 保留引用，由两测试的 "a variable magpie can't see" case 守卫。

## 矩阵

- 定向：ok（两新测试 + 邻居家族）。
- 全包：`go test ./internal/agent/... -count=1 -timeout 30m` = 226.8s，唯一红 `TestMothX`（mothx_test.go:154，检测态断言）；base 上还原本单全部文件后单跑同样红 → 预存（本机 darwin/arm64），与本单无关，帖与 commit 均如实注明。
- race：定向家族 `-race` ok。
- gofmt -l internal/agent：空。
- vet：本机 + `GOOS=linux GOARCH=amd64 -tags nogui` + `GOOS=windows`：ok。
- build×3：darwin/arm64、linux/amd64 `-tags nogui`、windows/amd64：ok（darwin 链接警告为预存噪音）。

## 不确定项

- Droid 闭源：展开规则止于文档所述 `${VAR_NAME}`；`${env:VAR}`、部分引用、trim 行为均未假设（正则收窄到裸变量名，其余按字面比，维持现状）。
- OpenCode `{file:path}` 未覆盖（source 证实存在，Left 注明）。
- 变量未设时 OpenCode 实际发送空串（网关必拒），magpie 判 unknown 不报——与「只有 shell 设了」无法区分，沿用 Hermes 的取舍。
- TestMothX 为本机预存红（base 复现），未修（不属本单）。
- 上游在作业期间前移 4 个提交（gateway/sessions/provider），本单 base 仍为 `318697dc`；如需可后续 rebase。
