## 环境

magpie **0.1.1263**（upstream/main `1d227a7e`）· gateway，路由组 Patience（#1418 机制）· 任意 agent（流式与非流式都命中）

## 现象

一个**不支持 SSE** 的上游/中转（对 `stream:true` 回 200 + 完整 JSON，真实世界的 relay 里不少见）在 magpie 这里失败为 502 `did not stream`。这个失败是**确定性的**——请求发多少次，回答都不会变成流——但它被当成了「过一会儿就好了」的瞬态故障：

1. `passing()`（最后一个成员的同者重试）把它当 502 再问 2 次（1s + 2s）；
2. 然后进入组 Patience（`busy()`/`replan`，#1418）——`busy()` 认为 502 且非 response protection 就是「a member may be over in a moment」——**把 Patience 预算整个烧完**：`replanRounds` 12 轮退避（生产 2s,4s,8s,16s,30s…），默认 `PatienceDefault` 60s 下约 5 轮，上限 240s 下约 11 轮 ≈ 270 秒纯退避；
3. 每一轮都是一次真实的上游请求（计费/限速计数），agent 在流上等满预算后拿到 502。

合计：**同一个注定失败的请求被发 15 次**（1 首次 + 2 同者重试 + 12 replan），默认设置下 agent 白等约 60 秒，日志和 Routing 页多出 14 条一模一样的 try。对照组就在同文件里：response protection 的 502（同样确定性）被 `busy()` 显式排除了，`did not stream` 的 502 漏了。

## 最小复现

新增的测试在修复前（upstream/main `1d227a7e`）失败：

```
--- FAIL: TestStreamlessMemberIsAskedOnce (1.28s)
    --- FAIL: TestStreamlessMemberIsAskedOnce/whole (0.88s)
        streamless_member_test.go:41: a member that never streams was asked 15 times
    --- FAIL: TestStreamlessMemberIsAskedOnce/stream (0.40s)
        streamless_member_test.go:41: a member that never streams was asked 15 times
```

复现步骤：`fresh(t)` 沙盒里存一个 scripted 厂商（对任何请求回 `200, application/json, chatOK`——即「忽略 stream:true 回整块 JSON」），存成单成员路由组；向 `/v1/messages` 发 `stream` 与非 `stream` 请求各一次。两种都数到 `a.n == 15`，trace 的 15 条 try 全是 `status=502 fail=other`，`Again` 序列 1,2,2,4,8,16,30…30ms（测试里 `retryPause=1ms`；生产同构，只是退避按秒放大到 Patience 预算）。

## 根因

`internal/gateway/patience.go` 的 `busy()`：

```go
case 408, 500, 502, 503, 504, 529:
    return failure(status, body) == failOther && !protectionRefused(status, body)
```

「did not stream」的 502 满足 `failure(...)==failOther`，也不匹配 `protectionRefused`，于是进入 `busyNow` → `replan()` 12 轮。同理 `internal/gateway/fallback.go` 的 `passing()` 对 502 一律 `return wait, again < lastRetries`。

而这条 502 的来源是确定性的协议失配（`gateway.go` 的 "the provider ignored stream:true; … give up cleanly"、`fallback.go` settle 的 "a 200 that is no reply of the protocol's"）：**"give up cleanly" 的失败被两层「再等等」机制反复捡了回来**。

## 修法（很小）

判定文案已收敛为一个常量 `didNotStream`（`patience.go`，四处生成点共用），然后两个消费点各加一行排除：

- `busy()`：`&& !strings.Contains(string(body), didNotStream)`；
- `passing()`：502 分支里命中即 `return 0, false`。

组内 failover **保持不变**（`retryable()` 对 502 仍为 true，下一个支持流式的成员照常被问，有护栏测试锁定）；只是不再对同一个成员做无意义的反复重问，最后一个成员的失败立刻到达 agent。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增 `TestStreamlessMemberIsAskedOnce`（whole + stream 两场景） | 修前红（15 次），修后绿（1 次，agent 拿到 502 + "did not stream"） |
| 消融回红（只摘 `busy()`/`passing()` 两处排除，保留常量与文案收敛） | 同形转红（15 次） |
| 新增 `TestStreamlessMemberHandsOnToTheNextMember`（a 不流式、b 流式） | 修前修后都绿：a 1 次 → b 1 次接住（failover 未被本修破坏） |
| 定向邻居：`TestQuietNotAReplyLastFails`、`TestPatience*`、`TestStreamOverflow*`、`TestCodexOverflowInGroupNotAskedAgain`、`TestAgentGoneInTheRetryPause`、`TestRelayInputCap`、`TestOverflowGoesToAMemberWithRoom` | ok（文案收敛未破坏对 "did not stream" 文本的既有断言） |
| `go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/gateway/` | ok（300s） |
| `gofmt -l internal/` | 干净 |
| `go vet -tags nogui`（darwin + GOOS=linux + GOOS=windows，gateway/provider/usage 三包） | 过 |
| `go build` + GOOS=linux/windows `go build -tags nogui` | 过（darwin 的 trayimage cgo `-Wenum-conversion` 警告为本机已知） |

## 没跑什么

- 同 proto 直通路径（Chat agent + Chat vendor）观察到一个**相邻疑点**，本修未动：直通时 vendor 回 200 非流 JSON 会**原样透传**给要流的 agent（trace 记 `status=200` 成功，`did not stream` 检查只在翻译路径上）。它是否有意（直通 = 不解析）值得维护者定夺，与本次的确定性重试是两个面。
- 真实不支持 SSE 的 relay 未实测（本机以 scripted httptest 厂商复现其行为：200 + application/json）。
- GUI 的 Routing 页对 15 条 try 的渲染未单独验证（修后不再产生，无需适配）。

## 补丁与分支

- 分支：[ggbdpq/magpie@hunt29-gw-streamless-retry](https://github.com/ggbdpq/magpie/tree/hunt29-gw-streamless-retry)（基于 upstream/main `1d227a7e`，commit `f9e09ca7`）
- 合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
From f9e09ca773be8a9274497d12328513c55dde3fb5 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 07:17:12 +0800
Subject: [PATCH] gateway: a member that answers a stream request with a whole
 reply is asked once, not fifteen times
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An upstream that answered a stream request with a whole JSON reply — a
relay that doesn't speak SSE — failed as a 502 "did not stream", and
magpie read that 502 as a failure a moment may mend: the same-one retries
(passing) asked it twice more, then the group's patience (busy, #1418)
kept asking it for up to the whole Patience budget — 12 replan rounds,
about 270s of pauses, 14 more requests that failed the same way each
time. The agent waited the budget out and got the 502.

The reply never reads as a stream, however often the request goes out,
so the failure isn't one a pause can mend: busy() and passing() now
leave it alone (didNotStream), and the four places that word the error
share one constant. A group still moves on to the next member, whose API
may stream; a streamless last member fails at once instead of after the
budget.

What changed
- patience.go: busy() and passing() don't take a "did not stream" 502
  for a moment's trouble; the wording lives in one constant.
- gateway.go, continuation.go, search.go, fallback.go: the four error
  wordings use it.
- streamless_member_test.go: the member is asked once, whole agent or
  streaming, and the group still hands on to a member that streams.
- docs/subsystems/gateway-routing.md: the busy list names it.

Run:
- TestStreamlessMemberIsAskedOnce red on 1d227a7e (asked 15 times,
  whole and streaming), green with the fix; the ablated change (the two
  exclusions taken back out, constants kept) went red the same way.
- TestStreamlessMemberHandsOnToTheNextMember green before and after:
  the next member is still asked, once.
- Targeted: TestQuietNotAReplyLastFails, TestPatience*,
  TestStreamOverflow*, TestCodexOverflowInGroupNotAskedAgain,
  TestAgentGoneInTheRetryPause, TestRelayInputCap,
  TestOverflowGoesToAMemberWithRoom: ok.
- Full suite: go test -tags nogui -p 2 -timeout 45m
  ./internal/gateway/ at 1d227a7e + this change: ok (300s).
- gofmt -l internal/: clean. go vet -tags nogui ./internal/gateway/
  ./internal/provider/ ./internal/usage/ on darwin, GOOS=linux and
  GOOS=windows: ok. go build and GOOS=linux/windows go build -tags
  nogui: ok (darwin's trayimage_darwin.go cgo -Wenum-conversion warning
  is the machine's known one).

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md         |  2 +-
 internal/gateway/continuation.go           |  2 +-
 internal/gateway/fallback.go               |  7 ++-
 internal/gateway/gateway.go                |  2 +-
 internal/gateway/patience.go               | 14 ++++-
 internal/gateway/search.go                 |  2 +-
 internal/gateway/streamless_member_test.go | 72 ++++++++++++++++++++++
 7 files changed, 94 insertions(+), 7 deletions(-)
 create mode 100644 internal/gateway/streamless_member_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 4b8be8b4..db62db73 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -93,7 +93,7 @@ recorded as a prediction failure (`noPrediction`).
    - A pause rule (`Rule.Pause`, `pause=<model>`; John on Discord: a model of the group paused in its vendor's peak hours) leaves the model it names out of the group while it holds (`provider.PausedOut`, on `ruleClock`): the group's own rules and each nested group's on the way down to a member, a group named taking all its models, and a model named taking it wherever a group in the group has it (#625). It runs before planning, on every request rather than once a turn, so the model is not first, not a failover, and not kept by affinity, and comes back as soon as the hours end. It holds by hours, days, agents and folders only (`cleanRules` refuses another condition), and is not a send-to rule: `Matches`, `MatchRule`, `ThenUses`, `Ruled` and the compaction rules leave it out. A send-to rule naming a paused model finds it unready and the group routes as without it. The trace keeps what was paused (`GroupRef.Paused`), and the Routing page says so. Every model paused answers 503 (`pausedError`) naming each rule. Embeddings go by the same pauses; manual groups have no rules (`Live`), so none pause there. A pause by folder (#1606, Ti800: a subscription's quota kept for the long task in one folder, `pause=<model> except-folders=~/big-task`) reads the folder only when such a pause is on the way (`provider.PausesByFolder`, then `workDir`): outside its except-folders, which includes a request that says no folder (a subagent's or a small model's that doesn't), the model is left out; with `folders=`, only requests known to be in them. Embeddings and System One's decision calls have no folder. `Paused.Folder`/`ByFolder` carry what was read, and the Routing page says the folder or that none was said. `rules_pause_test.go`, `TestPauseByFolder`, `TestPauseByFolderRule`, `TestParsePauseByFolder`, `routing-pause-folder.test.cjs`.
 3. Candidates come from `planGroup` for a group or `plan` for a provider. They are filtered by `sealedReaders` and `allowedCandidates`. An account past its share is held out of the candidates (`capHeld`): a usage cap's share, each window at its own where the account gives it one (`AccountWindowCaps`, willz on Discord: 50% of the five hours, 40% of the week) and at the account's cap otherwise, or 100% of a window for a Codex account set not to spend its credits (`provider.HoldCaps`, `WindowCaps.Of`, `CodexNoCredits`). A ChatGPT account's call on `codex-auto-review`, which OpenAI counts in no window, is held by no usage cap, only by credits it may not spend (`freeOnChatGPT`, #1593, `TestAccountCapLetsAutoReviewThrough`). The account is held while any window is past its own share, and `cappedError` and the trace name the fullest such window's share and cap. When every candidate is held and one held for its credits spends its resets by itself, `autoReset` spends a reset on it and it is tried (`planned.held`); otherwise a capped or barred set returns `cappedError` or `barredError`. Then `affine` moves the conversation's last answerer first, unless it is resting or nearly used up. An `X-Magpie-Account` header (`AccountHeader`) pins the request to one account: only that account is tried, and when it can't answer the caller is told why.
 4. The candidate loop calls `attempt` on each candidate in turn, through a `holdWriter`. The writer holds the reply until it is clearly passing. A candidate that fails before anything is sent rests (`failure`): out of credit for 30 minutes, out of quota until reset, rate limited until retry-after, otherwise a minute and longer on repeats: doubled each time, up to `longestRetry` (10 minutes) for a failure and `longestRateRest` (30 minutes) for a rate limit back as soon as its rest is over, or up to the provider's own `restCap` in minutes (`Provider.RestCapOr`, at most `MaxQuotaRest`; `magpie provider rest-cap <id> 4h`, #2008: a free key down for hours was asked every 10 minutes). A time the vendor names stands over it as before (`TestOwnRestCap`). The failure count is kept per key or account (`restKey`), and any of its models' answers clears it (`served`). Each model's own count (`restID`) is kept beside it and cleared only by that model's answer (`servedCandidate`): once it is past the account's, a sibling model answered since it last did, so the failure is the model's and it climbs its own ladder and rests alone, its siblings still served (#2241, weizsw: an Antigravity seat's gemini-3.5-flash-lite rested a minute 41 times of 43 while gemini-3.8-flash kept answering; `TestModelLadderClimbsPastSiblingAnswers`). Every model failing with no answer between still climbs the account's ladder and rests the account, and a candidate naming no model has the account's count alone. `rest-cap <id> off` (`provider.RestCapOff`, `restCap: -1`) is for a relay or account pool whose unknown errors come now and then and pass by the next request (Kismet Alan on Discord): a failure that says nothing of why (`failOther`: a 5xx, a dropped connection) then rests nobody and isn't counted, its trace rest `by: "off"` with no time left. A 401 or 403, a model not served, an account's window full, a rate limit (magpie's own 30-minute cap), quota, credit and a restriction still rest it as before (`TestRestCapOff`). The shortest cap otherwise is a minute, the first rest; `rest-cap <id> 30s` is turned away and names `off`. A 400, 403, 404 or 422 that says the model isn't served (`unservedWords`) and says nothing of quota, credit or a rate limit rests only that key's or account's model (`modelRefused`, keyed by `restID`, its backoff counted apart): its other models are still served first in order (#1235, SenseNova's 403 "model is not available in the current token plan"). A Google account's Code Assist (the Antigravity and Gemini CLI built-ins) answering 404 `NOT_FOUND` ("Requested entity was not found.") rests its model the same way, as its endpoint is the same for every model (`codeAssistModelMissing`; Packing1 on Discord: Argon, listed for a Google AI Pro account, answered 404 and rested the whole account; `TestCodeAssistMissingModelRestsTheModel`). A refusal for want of quota, credit or rate, for an account its vendor restricted, or for a verify it asks of its account there, from another computer's magpie (a Remote magpie provider, LAN share) rests only the model it was about (`remoteModelRest`, keyed by `restID`, in `restAfterMarked` and `rateRest`): that magpie serves each of its models from its own providers and rests them itself, so one out of quota there says nothing of the others (bigsteven on Discord: a 429 for one model rested every model on the remote for the 3 hours it named, so a group never moved on to the remote's other models; `TestRemoteMagpieQuotaRestsTheModel`, `TestRemoteMagpieRestrictedRestsTheModel`). Its key refused, the computer unreachable, or the key's own limit there (`keyLimited`'s 429, which carries `X-Magpie-Limit-Reset`, `remoteKeyLimitHeader`), still rests it whole: #2077's reporter had a Claude Code session limit on the other magpie refuse its Qoder models here (`TestRemoteMagpieRestsTheModel`, two gateways over HTTP; `TestRemoteMagpieKeyLimitRestsTheKey`). A 400, 404, 410 or 422 that says the model is retired (`retiredWords`: OpenCode Zen's 410 `ModelDeprecated` "Model exo-free has been deprecated.", whose own model list still names it; MOMO on Discord) rests only that model the same way, is retryable so a group's next member or another provider of it is asked, and is remembered (`provider.Retire`, `retired.json` beside `providers.json`): the model leaves that provider's entries in the catalog (`buildEntries`), so /v1/models, every agent's model list and the found groups go without it, until a request on it is answered again (`Unretire` in `servedCandidate`) or a week has passed. A refresh of the vendor's list doesn't bring it back early, since that list is where it still is. A `provider/model` request for it is still sent. A 400 or 422 that says this upstream's API can't take the request's shape (`shapeWords`: xAI's 422 "unknown item type" (#350), OpenAI's "Unknown parameter", and a limit of a model's own on tool schemas, OpenCode Go's 400 "JSON schema exceeds the maximum nesting depth of 10 levels" on muse-spark-1.3-contributor, #1870) rests nobody: the next candidate is asked once (`shapeRefused`, `failShape`), and the last one's error reaches the agent. A request missing what every API requires ("field required") isn't one, nor is a 200 that mentions it. Command Code's Provider API turning a request away with nothing but a trace id (`unsaidWords`: `{"message":"invalid request error trace_id: <hex>","type":"invalid_request_error"}`, a 400, or a 422 before) is handled the same way: it turns away a request whose history and asked-for output together are over a limit below the model's listed context (the reporter's A/B: one ~748K-token agent conversation answered 200 with `max_completion_tokens` 64000 and this 400 with 384000, the model's listed max output), which another member's model may take, and the key is fine (#2313, `TestGroupFailsOverCommandCodesBare400`). Its overflow, which names the model's context length before the trace id, and an error that names a `param`, aren't one. A relay's own cap on one request's input that says so (`tooLongRe`: B.ai's 400 "Input token exceed the limit", on a 380K request under the model's 1M window; #2445, worksyang) is taken as an overflow (`overflowed`), which no word list of `retryable` matched: a group's next member that may hold the request is asked (`withRoom`, `failOverflow`), nobody rests, another account of the same model isn't asked, and with no member left the agent is told the conversation is too long, so it compacts. A rate limit worded with input tokens (`paceWords`) isn't one, and a plain bad request is still asked of nobody else (`TestRelayInputCapGoesToTheNextMember`). A subscription account that fails any other way with a window full, by magpie's latest reading of its windows, rests until that window renews. Both quota rests and window rests are held to `longestQuota` (8 days), so a reset time read wrong (a year off) doesn't bench the account for that long. The next candidate is then tried. A failed provider waits `fallbackCooldown` (1 minute) at the back. A WorkBuddy account the vendor restricted (#1849: 403 `{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity",…}}`) rests `restrictedRest` (2 hours) as `restricted` (`failRestricted`), not the minutes of an unknown failure: only WorkBuddy lifting the restriction, after the user's appeal, brings it back. Both shapes are known: the built-in's `wbExplain` and the plugin's `explained()` (0.1.17, the mover's `min`) end the error with `provider.WBRestrictedHint` (`restrictedSaid`), and the vendor's own body, its code 11140 or its words (`provider.WBRestricted`), counts only from a WorkBuddy candidate (`restrictedRefused`, `isWorkBuddy`), as another vendor's 11140 is its own. Bare "request illegal" isn't matched. WorkBuddy's 11128 channel refusal stays `promptRefused` and rests nobody. The Routing page names it "account restricted by the vendor", says the appeal is the way back, and gives the account's row a button that lifts the rest (`/api/gateway/unrest`) once the vendor has. Every other rest a key or account takes (quota, rate limit, retry-after, a failure's backoff) can be lifted by hand the same way (#1869): "Try now" on its row on the Routing page and beside its rest note in the provider's key list. It ends the rest only: the backoff count stays, and a refusal after it rests the key again the usual way. The vendor's safety filter refusing a reply rests nobody, whether it refuses the turn before any of the reply is said or once some of it has been said (`refused`, `refusedAfter`). Its note on the try (and in the error the agent gets when nobody is left) is the vendor's reason, with Anthropic's `stop_details` category and explanation when it gave them (`refusedDetail`, #1768: "safety filter: refusal (category cyber)"); none is made up when it gave none. `stop_details` is carried through the IR (`Event.StopDetails`), so a Claude subscription run through the claude CLI and a translated Anthropic route keep it for an Anthropic client too. How many more candidates a refusal before any of the reply is asked of is Settings' `RefusalRetries` (`refusalAsksAgain`, counted per request in the candidate loop; a group's other members count too): unset, every one left (#248); 0, none (#1925, DD on Discord). When nobody is left, an agent on Anthropic's Messages API gets the held refusal itself, the vendor's 200 with `stop_reason` `refusal` and its `stop_details`, streamed or whole (`holdWriter.handBack`), since that is what Claude Code switches to its fallback model on; a 400 is only an API error to it. Codex and Chat clients still get `failTo`'s 400 (`refusedStatus`), which they don't ask again for. `TestRefusalRetries*` in [`refusal_retries_test.go`](../../internal/gateway/refusal_retries_test.go) cover keys, a group and the Claude subscription. The ChatGPT backend's 502 "response protection is unavailable" is about the request's content, not the account: the same history fails the same on each of its accounts and models. It rests nobody, isn't tried again after a moment, and isn't asked of the provider's other accounts or models; another provider left in a group is asked once (`protectionRefused`, `elsewhere`). One cause is known (#1270): a history that replays the backend's own `web_search_call` in a request that doesn't declare the `web_search` tool is refused so, whatever the account, model or turn (a plain turn, a thread's description, a compaction, Codex's own text compaction for a custom provider with `tools: []`). Every request to the ChatGPT backend with such a history therefore declares cached-only search (`{"type":"web_search","external_web_access":false}`, `provider.DeclareSearch`): an account's in `codexBody`, Codex's own sign-in relayed in `codexUpstreamOn`. It goes in the tools, or for Responses Lite (its header, `reasoning.context` `all_turns`, or an `additional_tools` item already there), which refuses a top-level `web_search`, in the `additional_tools` item. A request that offered no tools gets `tool_choice` `none` so the model can't search; one with a forced choice keeps it. A history without a search, or a request that declares search already, is relayed unchanged. siwc, API-key requests to openai.com and the legacy `/responses/compact` are left as they were.
-5. The last candidate's error reaches the agent, with one exception for a group (#1418, `patience.go`). When every member has failed in a way that passes (`busy`: 408, 500, 502, 503, 504 or 529 that isn't a proxy, a quota or response protection, or a 429 that is a short rate limit, not a plan or credit), and nothing of the reply has been sent, the members that failed so are asked again in turn after a pause (`replan`). The pause is `retryPause` doubled each round up to `replanLongest()` (30 times `retryPause`, 30s), and never shorter than the soonest Retry-After; a member whose Retry-After ends past the pause is asked after the others. This goes on while the group's `Patience` lasts. `replanRounds` (12) is only a backstop that never comes first: the pauses alone add up to `PatienceLongest` in 11 rounds (with 6, a group set to 240s gave up after 90s of pauses, real-jacket on #1418; `TestPatienceIsUsedUp`). The budget is the group's `Patience`, counted from the first time every member had failed, when the agent would have had the error (`waitFrom`; `Group.Waits`: 0 is `PatienceDefault`, 60s; -1, `PatienceOff`, turns it off; at most `PatienceLongest`, 240s). A pause that would end past the budget isn't taken, and the agent gets the error. While another member is busy too, the last one isn't first tried again alone (`passing`): the members take turns, and once the budget has begun, the same-one retries aren't taken either. While the budget lasts, the last candidate's failure is held (`newHoldWriter`), and a streaming agent is kept alive through the pause with SSE comments (`pauseAlive`). The try is traced with `Again` (the pause), `Replan` (how many are asked again) and `Patience` (the budget in seconds). The group editor's "Every member busy" row sets it. A plain provider keeps only the same-one retries `passing` gives the last one left. An agent that goes away in either pause (the same-one retry's or a group's replan) ends the request there with 499: nobody is asked again, and the try whose pause it was is marked `Gone` (#1894, heng91: a relay down while its proxy was off, the agent's window closed). The Routing page says the agent canceled the request before the retry and lists it as canceled, rather than ending its story on "tried again in 2s", a retry that never came (`TestAgentGoneInTheRetryPause`, `routing-agent-gone.test.cjs`). A try that answered is recorded (`served`, `answered`) for routing, affinity and usage. A try is added to the route's `Tries` only as it is asked, so a later try is the record that the gateway went on from this one, and the Routing page tells what came of a try from that, never from where it stood in the order (#2281, xishuchkui-code: an Antigravity 502 empty reply that went on to the next account was told as "an error another account wouldn't fix, so Claude Code gets it"). The one case the record can't show is the last try left out of its allowance after an earlier failure that wasn't one, where the agent is told the earlier error: that try is marked `Earlier` (`routing-went-on.test.cjs`).
+5. The last candidate's error reaches the agent, with one exception for a group (#1418, `patience.go`). When every member has failed in a way that passes (`busy`: 408, 500, 502, 503, 504 or 529 that isn't a proxy, a quota, response protection, or an upstream that answered a stream request with a whole reply, which fails the same however often it is asked (`didNotStream`; the same-one retries of `passing` leave it alone too), or a 429 that is a short rate limit, not a plan or credit), and nothing of the reply has been sent, the members that failed so are asked again in turn after a pause (`replan`). The pause is `retryPause` doubled each round up to `replanLongest()` (30 times `retryPause`, 30s), and never shorter than the soonest Retry-After; a member whose Retry-After ends past the pause is asked after the others. This goes on while the group's `Patience` lasts. `replanRounds` (12) is only a backstop that never comes first: the pauses alone add up to `PatienceLongest` in 11 rounds (with 6, a group set to 240s gave up after 90s of pauses, real-jacket on #1418; `TestPatienceIsUsedUp`). The budget is the group's `Patience`, counted from the first time every member had failed, when the agent would have had the error (`waitFrom`; `Group.Waits`: 0 is `PatienceDefault`, 60s; -1, `PatienceOff`, turns it off; at most `PatienceLongest`, 240s). A pause that would end past the budget isn't taken, and the agent gets the error. While another member is busy too, the last one isn't first tried again alone (`passing`): the members take turns, and once the budget has begun, the same-one retries aren't taken either. While the budget lasts, the last candidate's failure is held (`newHoldWriter`), and a streaming agent is kept alive through the pause with SSE comments (`pauseAlive`). The try is traced with `Again` (the pause), `Replan` (how many are asked again) and `Patience` (the budget in seconds). The group editor's "Every member busy" row sets it. A plain provider keeps only the same-one retries `passing` gives the last one left. An agent that goes away in either pause (the same-one retry's or a group's replan) ends the request there with 499: nobody is asked again, and the try whose pause it was is marked `Gone` (#1894, heng91: a relay down while its proxy was off, the agent's window closed). The Routing page says the agent canceled the request before the retry and lists it as canceled, rather than ending its story on "tried again in 2s", a retry that never came (`TestAgentGoneInTheRetryPause`, `routing-agent-gone.test.cjs`). A try that answered is recorded (`served`, `answered`) for routing, affinity and usage. A try is added to the route's `Tries` only as it is asked, so a later try is the record that the gateway went on from this one, and the Routing page tells what came of a try from that, never from where it stood in the order (#2281, xishuchkui-code: an Antigravity 502 empty reply that went on to the next account was told as "an error another account wouldn't fix, so Claude Code gets it"). The one case the record can't show is the last try left out of its allowance after an earlier failure that wasn't one, where the agent is told the earlier error: that try is marked `Earlier` (`routing-went-on.test.cjs`).
 
 ## Constraints and failure behavior
 
diff --git a/internal/gateway/continuation.go b/internal/gateway/continuation.go
index d707b3f4..1e22a426 100644
--- a/internal/gateway/continuation.go
+++ b/internal/gateway/continuation.go
@@ -518,7 +518,7 @@ func (s *Server) streamTranslated(w http.ResponseWriter, r *http.Request, p prov
 				// one event stream would be wrong, so give up cleanly
 				b, _ := io.ReadAll(io.LimitReader(rd, 1<<20))
 				res.Body.Close()
-				failed = p.Name + " did not stream: " + provider.APIError(b, "unexpected reply")
+				failed = p.Name + " " + didNotStream + ": " + provider.APIError(b, "unexpected reply")
 				if !cont.resume {
 					return writeError(w, from, 502, failed), failed
 				}
diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 229be1e2..d7d6477c 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1270,6 +1270,8 @@ var retryPause = time.Second
 
 // passing says whether a failure is one that may be gone a moment later,
 // and how long to wait before trying the same one again, the again'th time.
+// An upstream that answered a stream request with a whole reply
+// (didNotStream) isn't one: it fails the same every time it is asked.
 func passing(status int, header http.Header, body []byte, again int) (time.Duration, bool) {
 	wait := retryPause << again
 	if d := retryAfter(header, time.Now()); d > 0 {
@@ -1279,6 +1281,9 @@ func passing(status int, header http.Header, body []byte, again int) (time.Durat
 	case wait > longestPause:
 		return 0, false
 	case status == 408, status == 500, status == 502, status == 503, status == 504, status == 529:
+		if strings.Contains(string(body), didNotStream) {
+			return 0, false
+		}
 		return wait, again < lastRetries
 	case status == 429:
 		// a relay's 429 often says nothing of when (#503: "负载已饱和，请稍
@@ -2176,7 +2181,7 @@ func (h *holdWriter) settle() {
 		// stream's headers: it can't go as that stream, so it failed, as
 		// a translated reply that didn't stream does, for the next to
 		// answer
-		h.failure, h.failMsg = http.StatusBadGateway, "did not stream: "+provider.APIError(h.held.Bytes(), "unexpected reply")
+		h.failure, h.failMsg = http.StatusBadGateway, didNotStream+": "+provider.APIError(h.held.Bytes(), "unexpected reply")
 	}
 }
 
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 17d8afd4..e50d4815 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5438,7 +5438,7 @@ func (s *Server) translate(w http.ResponseWriter, r *http.Request, p provider.Pr
 		// the provider ignored stream:true; read the whole reply as one
 		// event stream would be wrong, so give up cleanly
 		b, _ := io.ReadAll(io.LimitReader(rd, 1<<20))
-		msg := p.Name + " did not stream: " + provider.APIError(b, "unexpected reply")
+		msg := p.Name + " " + didNotStream + ": " + provider.APIError(b, "unexpected reply")
 		return writeError(w, from, 502, msg), msg
 	}
 	// a Gemini reply that says nothing is a failure, not a turn's end
diff --git a/internal/gateway/patience.go b/internal/gateway/patience.go
index d5f1b328..d6bf0304 100644
--- a/internal/gateway/patience.go
+++ b/internal/gateway/patience.go
@@ -4,11 +4,18 @@ import (
 	"context"
 	"net/http"
 	"slices"
+	"strings"
 	"time"
 
 	"github.com/yetone/magpie/internal/provider"
 )
 
+// didNotStream is in the error for an upstream that answered a stream
+// request with a whole reply: no ask of it will read as a stream, however
+// often it goes out, so it is no failure a moment may mend — the same-one
+// retries (passing) and a group's patience (busy) both leave it alone.
+const didNotStream = "did not stream"
+
 // A group's patience (#1418): when every member has failed in a way that
 // passes — overloaded, busy, rate limited for a moment — and nothing of a
 // reply has gone to the agent, the request isn't ended on the last one's
@@ -45,11 +52,14 @@ type busyTry struct {
 // busy says whether a failure is one a member may be over in a moment:
 // overloaded, unavailable, timed out, or a rate limit that isn't the
 // plan's or the money's. A proxy that refused the connection, a quota used
-// up or response protection's 502 isn't.
+// up, response protection's 502, or an upstream that answered a stream
+// request with a whole reply (didNotStream) isn't: each fails the same
+// however often it is asked.
 func busy(status int, body []byte) bool {
 	switch status {
 	case 408, 500, 502, 503, 504, 529:
-		return failure(status, body) == failOther && !protectionRefused(status, body)
+		return failure(status, body) == failOther && !protectionRefused(status, body) &&
+			!strings.Contains(string(body), didNotStream)
 	case 429:
 		return failure(status, body) == failRate && !creditWords.Match(wordsOf(body))
 	}
diff --git a/internal/gateway/search.go b/internal/gateway/search.go
index 6a066ea2..62598a04 100644
--- a/internal/gateway/search.go
+++ b/internal/gateway/search.go
@@ -1079,7 +1079,7 @@ func (s *Server) askTranslated(p provider.Provider, to provider.Protocol, model
 		if !sse {
 			b, _ := io.ReadAll(io.LimitReader(rd, 1<<20))
 			res.Body.Close()
-			return nil, 502, p.Name + " did not stream: " + provider.APIError(b, "unexpected reply")
+			return nil, 502, p.Name + " " + didNotStream + ": " + provider.APIError(b, "unexpected reply")
 		}
 		events := make(chan Event, 16)
 		go func() {
diff --git a/internal/gateway/streamless_member_test.go b/internal/gateway/streamless_member_test.go
new file mode 100644
index 00000000..68507e23
--- /dev/null
+++ b/internal/gateway/streamless_member_test.go
@@ -0,0 +1,72 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A member that answers a stream request with a whole JSON reply — a relay
+// that doesn't speak SSE — fails the same way every time it is asked: the
+// request is never read as a stream, however often it goes out. It is a
+// failure of how the member answers, not of the moment it is asked in, so
+// the group's patience doesn't keep asking it, and the one left isn't tried
+// again on the chance a moment mends it. The next member of a group is
+// asked, as its API may stream (#1418's patience is for what passes).
+func TestStreamlessMemberIsAskedOnce(t *testing.T) {
+	for _, c := range []struct {
+		name  string
+		query string
+	}{
+		{"whole", ``},
+		{"stream", `"stream":true,`},
+	} {
+		t.Run(c.name, func(t *testing.T) {
+			fresh(t)
+			a := &scripted{replies: []reply{{200, "application/json", chatOK}}}
+			scriptedOn(t, "a", provider.Chat, a)
+			if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m"}, Routing: provider.Ordered}); err != nil {
+				t.Fatal(err)
+			}
+			s := New()
+			rec := httptest.NewRecorder()
+			req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"group/g","max_tokens":50,`+c.query+`"messages":[{"role":"user","content":"hi"}]}`))
+			s.Handler().ServeHTTP(rec, req)
+			if rec.Code != 502 || !strings.Contains(rec.Body.String(), "did not stream") {
+				t.Fatalf("%d %s", rec.Code, rec.Body.String())
+			}
+			if a.n != 1 {
+				t.Errorf("a member that never streams was asked %d times", a.n)
+			}
+		})
+	}
+}
+
+// The group still moves on from it: the next member, whose API streams, is
+// asked and answers.
+func TestStreamlessMemberHandsOnToTheNextMember(t *testing.T) {
+	fresh(t)
+	a := &scripted{replies: []reply{{200, "application/json", chatOK}}}
+	b := &scripted{replies: []reply{{200, "text/event-stream", sse(
+		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
+		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`,
+		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
+	)}}}
+	scriptedOn(t, "a", provider.Chat, a)
+	scriptedOn(t, "b", provider.Chat, b)
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"group/g","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
+	s.Handler().ServeHTTP(rec, req)
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hello") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	if a.n != 1 || b.n != 1 {
+		t.Errorf("asked a %d times and b %d", a.n, b.n)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
