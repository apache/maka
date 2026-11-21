## Diagnosis: `provider_config.json` cannot carry a model display name — the picker never reads one

I dug into ZCode's own code (the shipped app bundle, not magpie) to check whether ZCode 3.14+ supports a display-name field that magpie could write into `provider_config.json`. Conclusion up front: **it does not.** The model-rule schema has no name field at any level, the file is validated with a strict (unknown-keys-rejected) schema on both read and write, and the model picker hardcodes each row's visible text to the raw `modelId`. There is no field magpie could add that would change what the picker shows.

### What I checked

**1. A live install (ZCode 3.15.3, macOS app bundle).** My `~/.zcode/v2/config.json` (legacy) has 37 magpie model entries, each with a friendly `name`; my `~/.zcode/v2/provider_config.json` has 37 `providerModelRules` entries with exactly the shape you quoted (`modelId`, `providerId`, `config.properties`, `config.optionSpecs`) and no name-ish key anywhere. Same split as your machine — and the picker behaves the same way you describe, which is itself a hint that the legacy `name` is not what the picker reads.

**2. The schema of `provider_config.json`** (extracted from `app.asar` → `out/host/index.js`, with identical copies in `out/main/chunk-ZCWQ2IP2.js` and `out/scheduler/index.js`). The personal provider config is a zod schema; the model-rule entry is:

```js
tF = z.object({ templateId, modelId, config }).strict()
ep = tF.omit({ templateId: true }).extend({ providerId })   // providerModelRules items
gh = z.object({ providerModelRules: z.array(ep), manualProviderModelRules: z.array(oC) })
      .strict().superRefine(...)
```

Because `tF` is `.strict()`, an entry allows exactly `{modelId, providerId, config}` — nothing else. The `config` object is strict too, and every field inside it is enumerated:

- `config`: `{enabled?, properties?, optionSpecs?}` (strict)
- `properties`: only `contextWindow?`, `inputFormat?` (`supportsImage?`, `supportsVideo?`, `supportsPdf?`), `outputFormat?`, `supportsToolCall?`, `supportsJsonSchemaOutput?`, `supportsNativeWebSearch?`, `supportsMidConversationSystem?`, `requiresMfjsToolSchema?`
- `optionSpecs`: only `reasoningLevel?`, `maxOutputTokens?`

There is no `name`, `label`, `title`, or `displayName` anywhere in this chain. The same strict shapes appear in all three bundles I inspected.

**3. The file is validated with that strict schema on read and on write.** The reader does `models: lF(...)` where `lF(e)` starts with `gh.parse(e)`, and ZCode's own writer serializes through the same schema (`toPersonalJSON()` → `gh.parse(...)`). So a `name` key injected into an entry is not a harmless extra: the strict parse throws on unknown keys (config load fails and ZCode goes into its personal-config recovery path), or — where only the outer document schema sees the key first — the key survives at most until the next time ZCode rewrites the file, at which point it is stripped. It is never displayed either way.

**4. The picker's row text is hardcoded to the raw id.** `createModelSelectionProviderOption` (in `out/host/index.js`) builds what the picker renders:

```js
{ id: providerId, label: providerName?.trim() || providerId,
  models: models.map(m => ({ id: providerId + "/" + m.modelId, label: m.modelId })) }
```

The per-model `label` is literally `m.modelId`. There is no per-model display-name lookup in the row model at all. Only the provider-level prefix comes from a stored field: the provider rule's `providerName`.

**5. Cross-check against your own report.** Your legacy `config.json` already carries `"name": "OFM-DS-V4.1-Flash"` for `group/ofm-deepseek-v4.1-flash`, and ZCode 3.14.1 still shows the raw id — exactly what step 4 predicts: the picker never consults a per-model name from any file.

### About the schema citation in the issue

Two likely sources of the "entries have `name`" reading, both real fields but on other surfaces:

- The **legacy** `config.json` (OpenCode-style) model schema does have `name: string().optional()` — that's the file magpie writes friendly names into today.
- Provider **rules** (not model rules) do have a display field: `providerName` (`{providerId, templateId?, providerName?, enabled?, config}` strict). That only renames the row prefix.
- The model-selection option type does have a `label` field, but as shown in step 4 it is populated from `modelId`, not from any stored name — so writing a name cannot reach it.

One caveat: I verified against 3.15.3's bundle; I did not install 3.14.1. But your own `provider_config.json` from 3.14.1 matches this schema key-for-key, and magpie's 3.14 support (which was written against ZCode 3.14's own schemas) produces exactly these shapes.

### What magpie could (and could not) do

- **Nothing today reaches the picker per model.** The suggested fix 1 (add `name` to `providerModelRules[].config`) is not implementable: the strict schema has no such key, and injecting one breaks or gets stripped (step 3).
- The only writable display surface is the provider-level `providerName`. magpie already writes `providerName: "magpie"` and preserves a name the user set in ZCode's settings, so the prefix is already user-controllable — but the model part of the row stays raw.
- Suggested fix 2's alias route (human-readable model ids) would change the model ids sent in request payloads and break existing sessions/pickers; it is a naming redesign, not a display fix, so I don't think it belongs in this issue.

Per-model friendly names in ZCode's picker need an upstream change in ZCode (a name/label field in the model-rule schema plus the picker reading it). I'd suggest taking this to ZCode's own channel; from magpie's side the behavior you see is ZCode's schema and picker doing what they do, not something magpie forgot to populate.
