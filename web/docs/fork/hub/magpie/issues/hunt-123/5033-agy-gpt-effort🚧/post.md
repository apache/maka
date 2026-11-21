I took this and read the effort surfaces for the Antigravity CLI at current main (`7785c4278`). Short version: there is no dropped wire here to fix — Antigravity's own convention for thinking effort is the **model id itself**, and GPT models don't come in the tiered id families that convention reads. Making them switchable is a catalog-design call, so no patch from me; the one option is at the bottom. Credit @hong65201 for the report.

**How effort reaches a model through Antigravity CLI**

- Antigravity's picker doesn't carry a separate effort control for arbitrary models — it switches **tiered ids**: `gemini-3.7-flash-low`, `-high`, and so on, Google's own variant ids. That's the only effort signal the agy integration speaks.
- magpie already honors it in both directions: inbound, a tiered id's level becomes the request's effort ("one whose id already says its level … the effort asked for picked that id", `thinkingConfig` in `codeassist.go`); outbound to an Antigravity account, the asked effort picks the variant id (`AntigravitySentID`, `modelprefs.go` — `nearestEffort` over the family's levels).
- A GPT model has no variant family (`AntigravityVariants` says no), so its id goes out unchanged and there is no level for agy's picker to offer — what you saw. This is the same shape as the T3-family gap recorded on #4601 (each agent family has its own effort surface: T3 gets `t3Capabilities` option descriptors, Antigravity gets tiered ids, Codex got its word-list levels in #4909), not a relay defect.

**The one option, for the maintainer**

Synthesize tiered catalog entries for GPT models on the agy surface — serve `gpt-6.1-sol-low/-medium/-high` as ids that map to the effort magpie puts on the translated request (the inbound tiered-id path already turns a level-suffixed id into an effort, so the receiving half exists). That's new catalog surface with UI consequences (agy would show them as separate models), and whether Antigravity's picker renders extra ids well is Antigravity's own behavior — a design call rather than a bug fix. If it lands, the same synthesis would serve any model whose vendor exposes effort but no variants.

**Not verified:** no agy installation here — the picker's behavior for extra ids is read from the integration's conventions (`agy.go`, the tiered-id comments) and your report, not reproduced; nothing above was tested against Antigravity's UI.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
