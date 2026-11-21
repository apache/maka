**This works today, with `?kind=` rather than `?type=`** — the parameter the report tried isn't the one magpie reads, so it was ignored and the list came back unchanged; the image models are one query parameter away.

## What your version already has

`/v1/models` lists image and video models when the request asks for them — added in `af9ac3d25` (2026-11-03, in releases since v0.1.2845, so your v0.1.3471 has it):

- `GET /v1/models?kind=image` — the image models, each entry carrying its `"kind"`;
- `?kind=video`, or `?kind=chat,image,video`, or `?kind=all` for the three together;
- no `kind` at all (or `?type=…`, which nothing reads) — chat models alone, **by design**: the list is fed to agents' and clients' chat pickers (OpenCode, Cherry Studio, a pasted `?format=text`), and OpenAI's own list puts gpt-image among chat models with nothing to tell them apart, so an unasked-for image model would appear in those pickers as a model to chat with (`listKinds` in `internal/gateway/gateway.go`, `TestModelsListMediaOnlyWhenAsked`);
- an unknown `kind` value is refused 400 rather than read as none — so `?kind=image` cannot silently misspell its way to an empty list either.

For a two-hop gateway like new-api, the discovery request is then `GET /v1/models?kind=image` (and `?kind=video` for `/v1/videos`), and the models it discovers are the ones `POST /v1/images/generations` takes.

Documented in `docs/subsystems/providers-accounts.md` ("Any other client asks for image and video models with `?kind=`…") and in the site's integrate docs; the report's guess paths (`/v1/models/image`, `/v1/image-models`) indeed don't exist, but the query parameter is the intended discovery route, so nothing needs adding for the report's case. If anything is worth taking from it, it's that `reference.md` itself doesn't mention `kind` where it describes `/v1/models` — the other two doc pages do.

## Verification

| Check | Result |
| --- | --- |
| `?kind=` support in the report's version | `af9ac3d25` (2026-11-03) is in release v0.1.2845; the report runs v0.1.3471 |
| Behaviour guarded by a test | `TestModelsListMediaOnlyWhenAsked` passes on upstream/main `db0f2f20d` |
| `?type=image` ignored | by construction: `listKinds` reads only `kind`; unknown query names are not params |
| Unknown `kind` value | refused 400, per `listKinds` |
| `/v1/images/generations` reachable | the report's own probe shows it working with an explicit `model` |

**Source**: internal/gateway/gateway.go (`listKinds`, `listModels`), internal/gateway/models_kind_test.go, docs/subsystems/providers-accounts.md, site/public/docs/integrate.html at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: a live `?kind=image` call against your deployment — the code path and its test say what it answers, but your server will show it in one curl.
**Attribution**: AI-written analysis; I can answer questions on it myself.
