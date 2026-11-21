**Verdict** — the models come from the models.dev catalog, and models.dev has not listed Meta's Muse models for google-vertex yet (checked live today); there is no magpie-side filter dropping them, and no magpie change can add them without inventing their Vertex ids. The list heals itself when models.dev lists them.

## Where the google-vertex list comes from

magpie's catalog is models.dev's `api.json`, fetched at most a day stale, refreshed every hour while magpie runs (`internal/catalog/fresh.go`; a bundled snapshot is the build-time fallback, `internal/catalog/bundled.go`). A google-vertex provider's model list is that catalog's `google-vertex` entry. A model whose id carries a publisher slash (`deepseek-ai/deepseek-v4.1-flash-maas`) is served on Vertex's OpenAI-compatible partner endpoint (`VertexPartner` in `internal/provider/vertex.go`); that slash rule is the whole filter — there is no publisher allow-list in magpie that could be dropping Meta.

## What models.dev answers today (fetched 2026-11-11)

`https://models.dev/api.json`, the `google-vertex` entry: 63 models, by publisher — 43 without a slash (Gemini et al.), `xai` 7, **`meta` 3** (`meta/llama-4-maverick-17b-128e-instruct-maas`, `meta/llama-3.3-70b-instruct-maas`, `meta/llama-4-scout-17b-16e-instruct-maas`), `zai-org` 3 (the GLM ones the report sees), `deepseek-ai` 2, `openai` 2 (the gpt-oss ones), `moonshotai` 1, `qwen` 1, `google` 1.

So the other partner families the report names are there because models.dev lists them, and **Muse Wonder / Spark 1.3 / Ember are not listed at all** — announced 2026-11-09, two days before this check. That is the whole gap; magpie is reading its source faithfully.

Also worth noting: models.dev does carry three Meta models for google-vertex, so "no Meta entry at all" in the report's list suggests its catalog cache was older still, or the search was for "Muse". A magpie left running refreshes hourly; a restart refetches when stale.

## What would actually add Muse

1. **models.dev lists them** — then every magpie has them within a day, with prices, nothing to change here. This is the fix that requires nobody to guess.
2. **Until then, by hand**: a model added to the provider with its real Vertex id works today — the slash rule routes it to the partner endpoint exactly as the Llama ones. But the real id is the missing external fact: the report gives display names only, and Google's Model Garden page for the preview (or the project's own model list) is where the id shape (`meta/muse-…`? a `-maas` suffix like the others? an endpoint id?) has to come from. Hard-coding guessed ids into a preset would be inventing them, which I won't do.

## Verification

| Check | Result |
| --- | --- |
| Catalog source | `internal/catalog/fresh.go`: models.dev, ≤24h stale, hourly refresh |
| Partner filter | `internal/provider/vertex.go` `VertexPartner`: the publisher slash, no publisher allow-list |
| models.dev google-vertex live | 63 models; `meta` = 3 Llama maas; no Muse — fetched 2026-11-11 |
| DeepSeek / GLM / gpt-oss present | confirmed in the same fetch (`deepseek-ai` 2, `zai-org` 3, `openai` 2) |
| Muse's real Vertex model id | NOT-RUN — needs Google's Model Garden docs or the reporter's project; the report names none |
| Self-heal after models.dev adds Muse | code-read (`fresh.go` refresh path); no live google-vertex account here |

**Source**: internal/catalog/fresh.go, internal/catalog/bundled.go, internal/provider/vertex.go (`VertexPartner`), models.dev api.json fetched 2026-11-11, at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: Muse's actual Vertex ids and serving mode (public preview may also mean endpoint-based, not model-based, serving — the Model Garden page decides); whether models.dev's google-vertex entry gains them and when.
**Attribution**: AI-written analysis; I can answer questions on it myself.
