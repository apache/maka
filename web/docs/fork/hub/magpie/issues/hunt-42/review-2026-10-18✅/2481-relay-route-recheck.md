# #2481 复查报告（rev/a-gw 路，2026-10-18）

审计基线：upstream/main `d783df46`。我方分支 `hunt30-gw-relay-route` @ `8a7ea989`（父 `ebf3f48f`，已在 upstream/main 内——分支曾在 issue 所引 7597c132/f4958d93 之后 rebase 过一次）。

## ① 现状复核：缺陷仍在，无人修

- 当前 main `codex_backend.go` 仍只有三个 record 相关出口接 Route：成功口 `call.Route = tr.ID`（:1136），而 401 拒钥口（:1053）与空体失败口（:1067）的 `s.record(Call{...})` 仍无 Route；`tr` 仅在 `rest == "/responses"` 分支打开（:869），401 口对 compact 转发也可达（tr 为 nil），修法的判空前提不变。
- `git log -E --grep '#2481' upstream/main` 零命中；`gh pr list --search 2481` 空。
- 10-16 后 codex_backend.go 有 5 个维护者提交（bf931f82、45b8c725、9f9bfc16、a2c4aab1、9b04c4e2），无一个碰这两个出口的 Route。

## ② ③ 落树与消融（d783df46 全新跑）

`git apply --check /tmp/rev-a-2481-full.patch`（分支 8a7ea989 对 merge-base 的 diff）→ **APPLIES-CLEAN**，无需 rebase。

**BASELINE（带修复）**：
```
$ GOTOOLCHAIN=auto go test -tags nogui -count=1 -run 'TestCodexKeyRefusedCarriesItsRoute|TestCodexEmptyFailureCarriesItsRoute' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.052s   # EXIT=0
$ ... -count=3 -race ...
ok  	github.com/yetone/magpie/internal/gateway	2.159s   # EXIT=0
```
**ABLATION（只拆 codex_backend.go）**：
```
--- FAIL: TestCodexKeyRefusedCarriesItsRoute (0.11s)
    codex_backend_test.go:214: route 1792295108060: no call in the ring, so Request and response says the request is gone though its call is one of the last 40
--- FAIL: TestCodexEmptyFailureCarriesItsRoute (0.00s)
    codex_backend_test.go:242: route 1792295108063: no call in the ring, ...
```
gofmt -l 两文件空。patch 已存 `2481-applies-onto-d783df46.patch`，worktree 已 reset。

## ④ 对抗攻击

- **是否动维护者敏感区（ring/trace 数据结构形状）**：不动。diff +10/-3，只是给两个失败出口的 Call 补 `Route` 字段（401 口经 `refused := Call{...}; if tr != nil { refused.Route = tr.ID }`），零新结构、零热路径代价（只在两个失败出口执行）。
- **测试测实现还是行为**：`s.RouteCall(st.Routes[0].ID)`——正是 GUI "Request and response" 按钮走的 `GET /api/gateway/call?route=` 同款入口，断言 401 的 call 能被找到，行为级。
- **兄弟路径**：`rg 's.record(Call{'` 全 gateway 包扫过——codex_backend.go 两出口即 af601541 漏的全部；embeddings.go/draw.go 的 record 出口不开 Routing route（无 `trace.beginFor`），没有 Routing 行可点，不在本 bug 形状内；gateway.go:1617 `turnedAway` / :2190 `pinTo` 早退出口在 `call.Route = tr.ID`（:3441，尾部）之前 record——**可能同形状，但这两个出口是否发生在 tr 打开之后未逐一验证，登记为疑问**（见不自信清单）。
- **与维护者既有裁决冲突**：无。af601541 是维护者自己的 feature，commit message 声称 "set where serve, the Codex backend and a refused title record it"——本 patch 是把它声称的事补齐，不是改他的决定。
- **前提强度**：401 场景=中转签发的 key 留在 ~/.codex/auth.json（main 上 codexKeyRefused 注释原文就是这个场景，真实性强）；空体 ≥400 是 #409 先例形状。两个测试的 fake 都是 401/空体直答，与真实上游字节形状一致性中等（见不自信清单）。

## ⑤ 收益三句话

用 Codex 直连（API key 被上游拒，或上游无字失败）的用户，在 Routing 页点这次请求的「Request and response」时，现在得到 404 和"最近 40 条会保留到 magpie 退出、可以开请求存档"的双错提示；patch 后按得到这次调用的请求/响应体，与成功请求一致。这完成维护者自己 af601541 的 feature 承诺。

## ⑥ Verdict：PUSH

材料完整：干净可落、双红消融新鲜、race 绿、行为级断言、零代价、补的是维护者自家 feature 的漏口。**下一步最小动作**：发下方英文 ping（不催促，只报复验事实）。

## 不自信清单

1. 维护者两天无回的原因未知；ping 稿按"排队"假设写，若他在等别的（如想自己改 ring 形状）会落空。
2. serve 的 `turnedAway`/`pinTo` 早退出口与 `tr` 打开的先后未验证——若 tr 先开而 Route 后赋值，serve 自身存在同形状漏口，可能是后续新单。
3. 测试的 fake 上游是构造形状（401 JSON/空体），未对真实中转的 401 字节核验。
4. 分支 head 8a7ea989 与 issue 正文引用的 f4958d93 不同（分支被 rebase 过）——若维护者按正文 SHA 去拉会发现对不上，ping 稿里写明当前 head 缓解。

## 英文稿（ping，礼貌不催促）

```markdown
Still here on today's `main` (`d783df46`) — re-verified this morning:

- The patch applies clean. With `internal/gateway/codex_backend.go`
  reverted and the two tests kept, both fail by assertion —
  `no call in the ring, so Request and response says the request is
  gone` — at the same two exits as before (the 401 key-refusal record
  and the empty-body ≥400 record; the success exit's `call.Route` is
  untouched by anything since). With the patch, both green; `-race
  -count=3` ok.

No rush — posting the re-check in case it slipped past. The branch is
at [`hunt30-gw-relay-route`](https://github.com/ggbdpq/magpie/tree/hunt30-gw-relay-route)
(head `8a7ea989`, rebased after the issue went up, so it is not the
`f4958d93` named in the body).
```
