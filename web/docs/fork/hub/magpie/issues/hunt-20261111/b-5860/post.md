**Verdict** — everything the report says about the current state checks out, and there is a family shape that fits; what needs the maintainer's call is which of the three shapes to build, since two of them add a new credential surface and none can be verified against a real account from here.

## The current state, confirmed in the code

- The `baidu-qianfan` preset (`internal/provider/presets.go`) names Chat/Responses/Anthropic endpoints for its personal, team and pay-as-you-go variants and **no balance of any kind** — hence `magpie quota baidu-qianfan` answering "no balance endpoint known for it", exactly as pasted.
- The balance machinery (`internal/provider/balance.go`) has two shapes: built-in readers keyed by API host (DeepSeek, Moonshot, OpenRouter, StepFun, SiliconFlow, Zhipu, AiHubMix — all API-key endpoints), and a custom `BalanceURL` + `BalancePath` whose optional `BalanceToken` is sent "as the whole Authorization header in place of the key's". **There is no way to send a `Cookie` header today**, which matches the report's reading.
- So with Baidu refusing the key on its quota endpoint (302 to login, with or without `Authorization`, as the report measured — I cannot re-measure without an account), no amount of preset wiring inside the existing shapes can light this card up.

## The family shape that fits

`internal/provider/stepfun_plan.go` is the precedent for "the platform tells its plan only to a sign-in": the user signs in on the platform, a bookmarklet copies the session, magpie keeps it (`stepfun-auth.json`, one per provider), renews and asks as the page does. A Qianfan reader would be that shape minus the renewal — the report's endpoint is the console's own XHR (`console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource`, `Cookie` + `X-Requested-With`), the response shape is documented in the report and mirrored by the DSH plugin's write-up it links, and the items logic (skip `Released`, take the active non-expired one, credits vs tokens by `billingMode`) is straightforward to read.

Two things keep this a verdict rather than a patch from me:

1. **It adds a credential surface** — a pasted console cookie that expires in weeks, a "sign in again" state, a GUI panel — the same weight of decision as StepFun's was, and not mine to make. A lighter variant with the same reach is a generic extra-header field on the custom balance source (the report's option 2); that helps every console-only vendor, but it is still a new field in the editor's contract.
2. **The protocol is unverified on magpie's side** — the shape comes from the console bundle and a third-party plugin, the team-plan path is explicitly unverified even by the report, and I have no Qianfan account to test against (the report's author kindly offered to).

## The three shapes, for the call

| Option | What it adds | Fits the codebase |
| --- | --- | --- |
| Built-in reader, StepFun style (report's option 1) | bookmarklet/paste, `qianfan-auth.json`, the reader, a card with used/total + expiry, a stale-cookie state | yes — `stepfun_plan.go` is the template; no renewal call exists, so the session just ages |
| Generic balance header field (report's option 2, extended) | one field (`BalanceHeader` or similar) on the custom balance source; preset ships `BalanceURL`/`BalancePath` prefilled | yes — extends `balanceSource` without a new auth-file family |
| Docs-only (report's fallback) | a line where the preset is described: Qianfan's plan quota has no key-readable endpoint | trivial |

Any of the three would be worth having; the second is the cheapest thing that actually lights the card up, and the reporter has a Personal plan and offered to test.

**Verification**

| Check | Result |
| --- | --- |
| Preset has no balance | confirmed: `presets.go` baidu-qianfan block names endpoints only |
| No Cookie channel in balance | confirmed: `balance.go` `balanceSource` — token goes as Authorization, nothing else |
| Host-keyed readers are API-key endpoints | confirmed: deepseek/moonshot/openrouter/stepfun/siliconflow/zhipu/aihubmix blocks |
| StepFun sign-in precedent exists | confirmed: `stepfun_plan.go` (paste, auth file, ask as the page does) |
| Baidu 302 without Cookie | NOT-RUN — needs a Qianfan account (report measured it) |
| Endpoint response shape | NOT-RUN — from the report and the DSH write-up, not against a live account |

**Source**: internal/provider/presets.go (baidu-qianfan), internal/provider/balance.go (`balanceSource`, host readers), internal/provider/stepfun_plan.go (sign-in reader precedent) at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: the console endpoint's behaviour and shape against a live account; the team-plan sibling path; the cookie's actual lifetime.
**Attribution**: AI-written analysis; I can answer questions on it myself.
