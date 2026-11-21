I took this one and checked it against ZCode's own source (`zai-org/ZCode` main, files fetched today) plus magpie main (`f24829636af07d270ae902d132dbe5f76563629f`). Verdict up front: all four symptoms trace outside the two files magpie writes — this is a judgment, not a patch. Each magpie-side fix the report suggests is either impossible by ZCode's schema, wouldn't reach the complaint, or would make the failure worse. Receipts below; there is no branch or patch because nothing in magpie's write surface should change.

**1. The raw ids — ZCode has no name channel for rule-based models**

The picker's label for a model that comes from `provider_config.json` rules is the model id, hardcoded: `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts`, `toModelOption` → `label: model.modelId`. And the rule schema has no name leaf at all: `packages/provider/src/config/rule-data-schema.ts` builds `providerModelConfigRuleSchema` from `{providerId, modelId, config}` with `.strict()`, and `config` accepts only `enabled` / `properties` / `optionSpecs` (`packages/shared/src/model-config.ts`). The file is read through a strict zod parse (`packages/provider-node/src/provider-config-file-codec.ts`, `storedProviderConfigSchema.parse`), so a `name` key magpie added to a model rule would fail ZCode's decode of the whole file — magpie's own comment on this path already says "ZCode checks the file strictly", which is why it keeps only keys ZCode itself took. Writing the name would make the models leave the picker, not gain a label.

The remaining workaround — writing the display name *as* the `modelId`, so `label: model.modelId` renders it — I considered and rejected: magpie's display names are not unique identifiers (with plain names set, two providers can serve one name; magpie's own Claude Desktop listing suffixes duplicated names with the id for exactly that reason), and renaming would strand the selection every existing ZCode install has already persisted under today's ids.

**2. The output cap — the real number lives in the plugin, and inventing one is worse**

What magpie does today is deliberate and test-pinned: a model whose output isn't known gets no `maxOutputTokens`, in both files (`internal/agent/zcode.go`, the two `outputOr(m, zcodeOutput(maxTokens(m))) > 0` guards; `TestZCodeOutputAndReasoning` fails on "unknown output … written"). Two facts make writing a fallback the wrong move here:

- In ZCode, `maxOutputTokens.max` is not a slider ceiling — it is the per-turn budget: `docs/model-request-output-tokens.md` → `effectiveMaxOutputTokens = model.optionSpecs.maxOutputTokens.max`, mapped onto the request (`max_tokens` for Anthropic Messages). Whatever number magpie writes, ZCode asks Qoder for it.
- magpie cannot know 48,000. The only writer that knows Qoder's real cap is the plugin, which hardcodes `limit: { …, output: 0 }` in both `configModel()` and `runtimeModel()` because Qoder's listing has no output field (as the report shows). magpie writing its own cap (`zcodeMaxOutput`, 128000) would put the #2972 pathology into every turn: ZCode asks 128000, Qoder truncates at 48000 with `finish_reason: length`, and the reply reaches the agent as a success that may have said nothing — worse than today's honest stop at ZCode's own 32k fallback. Notably, ZCode's own maintenance log (`docs/builtin-provider-maintenance/configuration.md`) records revision 32 raising the built-in baseline for models without a rule from 32000 to `maxOutputTokens.max=128000` (the dated entries around it are 2026-10-26/27, after the 3.16.2 this was filed against) — so current ZCode already does to itself, by baseline, what the report asks magpie to do.

The report's first suggested fix is the right one, and #2972 scoped it the same way: `packages/qoder` in the plugins repo should publish a real output cap. magpie's chain picks that up with zero changes — the plugin's `limit.output` lands in the catalog (`internal/provider/models.go`, `replyLimit`: the model's own output, then models.dev, then the user's Max), flows through `maxTokens`/`outputOr` into both ZCode files, and `TestZCodeOutputAndReasoning` exercises exactly that path with a real number. I'd gladly take that plugins-lane patch.

**3. The persistence failure — ZCode's known draft-session timing, not the id**

The FK in that log line is not on the model id. ZCode's sessions schema puts it on the session row: `session_entry.session_id … references session(id)` (`apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`). ZCode's own design doc for model selection (`apps/zcode-cli/docs/design/v2/tui-model-selection.md`) says that on a draft session — no `session` row yet — writing the `runtime/model_selection` entry fails exactly this constraint and calls it a known timing condition, "not a persistence failure" (the doc's words, translated), to be logged as `persist_deferred` while `persist_failed` is reserved for a session that was persisted. The same doc defines the runtime contract as splitting the ref on the *first* slash precisely because "model ids may themselves contain `/`". So:

- Slash-free ids (the report's suggestion) would not fix the FK — the constraint never touches the id — and renaming ids in place would strand existing selections for no gain.
- The reporter's log has two possible readings, both ZCode-side: either the session was in fact a draft and ZCode misclassified the write as `persist_failed` instead of `persist_deferred`, or the session row was persisted and the insert genuinely failed. Either way it's worth reporting upstream to `zai-org/ZCode` with that log line; magpie has no key on this path (the Windows SQLite file is ZCode's own).

**4. The vision badge — the plugin's flag**

`inputFormat.supportsImage` mirrors what the plugin publishes (`is_vl` → image in its model list); magpie writes what its catalog says, the same for every agent. Gating on a strict `is_vl === true` belongs in `packages/qoder` too.

**What would actually close this**

- Plugins lane: `packages/qoder` publishes its real output cap (and gates the vision flag) — magpie then forwards both everywhere, on every ZCode version, with no magpie change.
- ZCode upstream: a name channel for rule-based models (today `label: model.modelId`), and the `model_selection` persist misclassification — the report's log plus the citations above are most of the upstream report already.

Verified locally: magpie `f24829636`'s write path re-read end to end (`internal/agent/zcode.go` for both files, `internal/agent/route.go` `maxTokens`/`outputOr`, `internal/provider/models.go` `replyLimit`) and `TestZCodeOutputAndReasoning` confirms omit-when-unknown is pinned, not accidental. Not verified against a live ZCode 3.16.2/3.17 install — the ZCode citations are from its public main, and the reporter's log is the only runtime evidence; it matches the draft-session reading.

Credit to @huangchulan578527086-netizen for the report and for tracing both config files — the `provider_config.json` vs `config.json` split in the report is what pointed this investigation at the right file.

AI use: analysis written with AI assistance (GLM-5.3-Flash via ZCode, as ggbdpq); every file cited above was fetched and read in full during this investigation.


