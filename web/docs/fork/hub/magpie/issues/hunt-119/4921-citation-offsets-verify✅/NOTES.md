# 4921 citation-offsets 验证车道 — 对照与验证记录（2026-11-03）

## 对象
- 我方 patch: fix/4921-citation-schema @ 57dc7b420（base a3768cdd1，已发 issue，patch 附帖）
- skygunner fork 分支: fix/4921-citation-offsets @ fcea11649（base 8abdf53a8 旧 tip，fork 仓 skygunner/magpie，"offered for review; not a claim"）
- 验证基线: upstream/main tip cb7d7f9aa（当日 fetch，比主线程核时的 173b7e274 新 1 commit：4bac5eed2 usage rows，动 codex_backend.go +8 / gateway.go ~+20，不碰两案 hunk 面）

## ③ VERDICT: PASS（其分支在 tip 绿+机制无回归）
- `git cherry-pick --no-commit fcea11649` 落 cb7d7f9aa：auto-merge 全清，零冲突
- `go build -tags nogui ./internal/gateway/` ok
- 其 3 个新测试（`TestCitationsWithoutOffsetsAskedAgainWithout` / `TestCitationsWithoutOffsetsNotSentToCodexBackend` / `TestWholeAsStreamDropsCitationsWithoutOffsets`）：ok（1.163s）
- 扫描/重写一致性 + fuzz 种子（`TestCodexRewritesAsBefore` / `TestCodexRewritesLeaveTurnUndecoded` / `FuzzCodexRewritesAsBefore`，含其新增 rewrite 条目+wasWithoutOffsetlessCitations oracle+5 个 mark）：ok
- `gofmt -l` 其 6 个触达文件：clean；`go vet -tags nogui ./internal/gateway/`：clean
- 未复跑：其 red-on-base ablation（其帖记录在 8abdf53a8 上做过）；其全套件未跑（宿主预存病 TestCodexPoolSaysTheClientsVersion 与两 diff 无关）
- 我方 57dc7b420 同 tip cherry-pick 也零冲突，我方 3 测试+parity+fuzz 种子均 ok —— 两版都在今日 tip 上验证过

## ② 对照表（发帖核心）
| 面 | 我方 57dc7b420 | 其 fcea11649 |
|---|---|---|
| 下游缝（reply 侧） | tidyCitations 在 responsesWholeEvents 逐 item 循环内清洗，盖全 4 出口（annotation.added/content_part.done/output_item.done/response.completed） | dropOffsetlessCitations 在事件循环前整体预洗 output，同样盖全 4 出口（其测试数 example.com/w 出现 4 次证 4 出口） |
| 判定规则 | 双 offset 缺一即丢（absent 或 null）；文本与带 offset 引用原样 | 同规则（annotationLacksOffsets）；细微差：非对象 annotation 我方丢、其方留（schema 上不可能是非对象，纯边角） |
| 上游缝-ChatGPT backend | codexInputAs item 循环内剥（bytes.Contains "annotations" 守卫，未点名不解码） | codexUpstreamOn 整体剥（同一批请求、漏斗再往下一层）；同样守卫 |
| 上游缝-Codex API key base (api.openai.com/v1) | 覆盖（codexInput 在 base 选择前跑） | 不覆盖（其剥被 `base == provider.CodexBase` 门住） |
| 上游缝-passthrough openai.com/Azure/codex 账号 | 不覆盖 | 预剥 |
| 上游缝-passthrough 其它 relay | 不覆盖 | 400 点名参数→retry-without 一次+provider 记忆（#1411 同型：refused append@5935 → markUnfit@6006；s.unfit 进程内 map，伪键 "citation offsets\x00model" 与 routing 的 fits 真键不撞；代价=每 provider+model 每进程一次多余请求；其测试断言 2 问后 1 问） |
| 已毒线程自愈 | backend 路径下一 turn 愈 | backend 愈 + openai/azure 立即愈 + relay 一拒后愈（更宽） |
| magpie 模型经 codex 账号 | !magpieModel 守卫不碰 | 无条件剥（无害但有损：magpie 模型本可收 offsetless 引用） |
| drop 而非补 0 | fail-closed 同判（schema 要真 offset；vendor 没说位置；补 0 会高亮无关文本；丢引用留文本） | 同判同理由 |
| 测试 | 3 测试（whole-stream 4 出口逐事件断言；codexInput 单测含 magpie 模型/干净线程不碰；scan 谓词单测）+3 fuzz mark 扩 codexInputAs oracle；base 上 ablation 红 | 3 端到端测试（relay retry 问数断言；backend 预剥含 own sign-in；whole-stream 4 处计数）+codexRewrites 新条目+独立 oracle+5 fuzz mark；其 base 上 ablation 红（其帖记录，我未复跑） |

## ④ 兼容性判定
- 共存：可以——函数名零碰撞（我方 tidyCitations/citationWithoutOffsets/hasCitationWithoutOffsets/dropCitationsWithoutOffsets vs 其方 dropOffsetlessCitations/annotationLacksOffsets/itemCitesWithoutOffsets/withoutOffsetlessCitations/refusesCitationOffsets/citationOffsetRefused），hunk 锚点不同，两版各自都能干净落 tip；但合并=双缝双剥（幂等无害冗余），收一版即可。
- 若收其版：我方版行为面几乎全被覆盖，唯两窄面成增量（API-key base 路径剥、!magpieModel 守卫）；我方测试对其树仍绿（测的是 codexInputAs，函数仍在剥）。
- 若收我方版：其 passthrough 预剥+retry-without+ unfit 记忆（gateway.go 两 hunk+codexUpstreamOn 一 hunk）是自包含增量值得单独跟——relay 覆盖是我方版唯一缺的、reporter 群形态可能撞到的面。
- 一句话：两案下游缝等价、backend 缝等价；其版在 passthrough 宽、我方版在 API-key base 与 magpie 模型守卫两窄面宽；共存无害但无必要。

## ⑤ 回帖
- gh issue comment 4921（验证背书+两案并陈英文帖），回读 ID 见主线程报告。

## 不自信项
- 其 red-on-base ablation 未复跑（信任其帖记录；机制上 drop 谓词与整链同构，可信度高）
- 真 Ark 账号两边都没实测（双方帖都声明）
- relay retry 的"多 relay 轮换"面（provider A 记忆后 turn 换 provider B）：其伪键按 providerID 分键，各 provider 各记各的，机制无冲突但无专门测试
