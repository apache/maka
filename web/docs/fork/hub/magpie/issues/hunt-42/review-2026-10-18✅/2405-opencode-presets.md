# #2405 复查（C 路 provider/agent，2026-10-18）

审计基线：worktree `/private/tmp/magpie-rev-c-prov`，HEAD = upstream/main = `d783df46cbac9021e26a6bd71ca0b55544552eb2`（2026-10-17）。fork 分支 `hunt24-a-opencode-presets` 现指向 `43d47e0b`（基 `ebf3f48f` 2026-10-17，issue 正文所引 `36c7d330`/基 `4a6bf80f` 之后已统一 rebase）。

## verdict：PUSH

材料在最新 main 上完整成立，名单经 2026-10-18 现抓 models.dev 复核无漂移缺口。最小推进动作 = 发英文 ping（稿见文末），主打「今日复验红绿 + 上游目录 10-18 重审无新增可映射 id」。

## ① 现状复核

- 缺陷仍在：`internal/provider/import_opencode.go` 的 `openCodePresets` 在 `d783df46` 上仍只有 19 个 id，15 个 id 逐个 grep 全部 MISSING（zhipuai、zai、alibaba、alibaba-cn、minimax、modelscope、kilo、cline-pass、kimi-code-plan-cn/global、stepfun-step-plan、stepfun-ai-step-plan、volcengine-coding-plan、alibaba-token-plan-cn、tencent-token-plan）。
- 维护者未动该区域：`git log --since=2026-10-13 --oneline upstream/main -- internal/provider/import_opencode.go` → 仅 `7ea0e047`（#2413，CC Switch/Alma 的 Gemini 端点，与 OpenCode preset 表无关）与源头 `37fec124`。同题无 PR：`gh pr list --search 2405` → `[]`；`git log --grep '#2405' upstream/main` → 空。
- skip 路径未变：`readOpenCodeAuth` 里 `pr == nil → skip = "it has no base URL"` 原样（该函数在基线后唯一改动是 `imported(...)` 的 endpoints 多传一个 `""`，与本单映射表无关）。

## ② 我方交付核对

fork tip `43d47e0b` 的 diff 与 issue 描述一致：`openCodePresets` +15 行映射 + 注释块写明排除理由；新增 `TestImportOpenCodeVendorPresets`（15 id 表驱动，断言落到同名 preset、无 skip、Chat/Key 正确——测的是公开行为不是实现）。`git diff ebf3f48f 43d47e0b` 对 `d783df46` `git apply --check` → **APPLIES CLEAN**。

## ③ 名单时效攻击（本单最大打回点，已重审）

2026-10-18 现抓 `https://models.dev/api.json`（5,805,476 字节，232 个 provider，10-15 时为 230）：

- 15 个 id 全部仍在，api 主机逐一与 magpie preset 主机相同。上游漂移 4 行，方向都对 preset 有利：
  - `minimax`: `https://api.minimax.io` → `https://api.minimax.io/anthropic/v1`（preset：Chat `api.minimax.io/v1`、Anthropic `api.minimax.io/anthropic`，同主机）
  - `kilo`: `https://api.kilo.ai` → `https://api.kilo.ai/api/gateway`（preset 主机 `api.kilo.ai`，`kilo.go:57` 主机级判定）
  - `alibaba-token-plan-cn`: 加 `.../compatible-mode/v1`（preset `bailian-token-plan` 同主机同路径，`decide_bailian_test.go:41` 佐证）
  - `tencent-token-plan`: `api.lkeap.cloud.tencent.com` → `.../plan/v3`（preset `tencent-cloud` 默认端点即 `/plan/v3`）
- 新增 2 个 provider 里没有可映射的漏网：对表中缺失的 198 个 id 做了「api 主机 = 某 preset 主机」与「同族域」双查——同主机的 15 个全部落在 patch 已声明排除的理由内（region/plan 歧义、已迁社区插件、cloudflare 需 account id）；同族的 `alibaba-coding-plan`/`alibaba-coding-plan-cn` 落在 `coding(.intl).dashscope.aliyuncs.com`，magpie 无该主机 preset（rg 全仓无 `coding.dashscope` preset），不属于「同址」规则射程。
- 排除一致性抽查：`zhipuai-coding-plan` 被排除而非映射——zhipu preset 确有 api/coding 两 region（`presets.go:172-173`），但 `openCodePresets` 表结构只能映射到 preset 默认端点，把 plan key 放到按量付费默认端点是构造性错误，排除成立；`minimax-cn` id 的 api 主机是 `api.minimax.cn`，magpie `minimax-cn` preset 在 `api.minimaxi.com`（不同域），不同址、正确未映射。

## ④ RED 消融（BASELINE / ABLATION 分开，沙盒 HOME + 缓存钉死）

| 步骤 | 命令（`GOTOOLCHAIN=auto go test -tags nogui -count=1`，HOME=/tmp/revc-home） | 结果 | exit |
| --- | --- | --- | --- |
| GREEN（d783df46 + patch） | `-run TestImportOpenCodeVendorPresets ./internal/provider/` | `ok ... 1.011s` | 0 |
| ABLATION RED（`git checkout -- import_opencode.go` 保留测试） | 同上 | 15 行 `skipped: it has no base URL`（import_opencode_test.go:253，与 10-17 评论逐行同形），`FAIL` | 1 |
| 复 GREEN（补回产品 hunk） | `-run 'TestImportOpenCodeVendorPresets\|TestImportOpenCodeAuth\|TestImportOpenCodeAuthWithoutXDG'` | `ok ... 0.932s`（既有夹具断言未动） | 0 |

## ⑤ 对抗攻击其余各项

- 前提证据：models.dev 是 OpenCode id 的真实来源（`37fec124` 注释自述），快照关系成立。
- 热路径代价：静态 map 查表，导入时一次，无热路径。
- 默认覆盖用户自设值：不适用（只新增映射，不写用户配置）。
- 兄弟路径：导入面其余 skip 理由（oauth/wellknown、空 key）未受影响，夹具测试绿。
- 平台面：路径逻辑未改（沿用 `37fec124`），issue 已声明未做 Windows 桌面手工验证——口径清晰。

## ⑥ 不自信清单

- 15 个厂商真实连通未逐家实测（导入只把 key 放到 preset 既有端点；zhipuai/zai plan key 的 `RetryZhipuCoding` 自愈路径未实测，issue 已声明）。
- `siliconflow`（.com）排除的 region 先例由原始 commit 自述，未独立复现 OpenCode 侧行为。
- 上游 models.dev 仍会再漂：名单是快照型交付，合并后仍需偶发维护——这是规则本身属性，不阻塞本单。
- 消融 RED 那一次 run 的 exit code 最初被管道 tail 吃掉，后已用 `pipefail` 重跑补得 exit=1（15 行计数复核）。

## ⑦ 英文 ping 稿（可直接发）

> Gentle nudge on this one — the patch still stands on today's tip (`d783df46`): `git apply --check` is clean, `TestImportOpenCodeVendorPresets` passes with it and fails without it, all fifteen ids still skipping as "it has no base URL" on the unfixed tree.
>
> I also re-audited models.dev today (232 providers now, two more than when the issue was filed): all fifteen ids are still there, each still at the host its magpie preset serves, and the four whose `api` URL gained a path since 10-15 (minimax, kilo, both token plans) moved closer to the presets' own paths. Nothing new showed up that the table's rule would want: the only ids left at a preset's host are the ones the patch already excludes with a reason (region/plan ambiguity, retired plugin subscriptions, Cloudflare's account-id-in-endpoint), and Alibaba's new coding-plan ids sit on hosts magpie has no preset for.
>
> The change is 15 table rows, one comment, and a table-driven test. The branch is [hunt24-a-opencode-presets](https://github.com/ggbdpq/magpie/tree/hunt24-a-opencode-presets), `git am`-able, author attribution preserved. Happy to adjust any of the exclusion calls if you'd draw them differently.
