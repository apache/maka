---
name: document-api-endpoint
description: Document and type a Sentry API endpoint. Write or fix @extend_schema decorators, specify response TypedDicts, type request parameters, correct type drift between the declared schema and the runtime response, and validate the generated spec. Use when asked to "document an endpoint", "add OpenAPI docs", "add/fix @extend_schema", "type an endpoint response", "fix the response type", "fix type drift", "reuse a response type", "split an overloaded endpoint", "specify the response schema", "add a TypedDict response", "migrate a legacy api-docs path", "fix a parameter type", or "make an endpoint public" / "promote an endpoint" (promotion is one section here).
---

# Document & Type a Sentry API Endpoint

Add or fix OpenAPI docs for a Sentry endpoint with drf-spectacular. Full reference is at https://develop.sentry.dev/backend/api/public/, the most useful section to you will be https://develop.sentry.dev/backend/api/public/#5-method-decorator. This skill captures the non-obvious lessons on top of it. Most of the work is making the declared schema match what the endpoint actually returns. Before documenting, identify which endpoint class serves the route and what it does; the MCP tool that calls it is usually the fastest way to confirm its behavior. Promoting a PRIVATE/EXPERIMENTAL endpoint to PUBLIC is one application (see below).

## Workflow

1. Class-level `@extend_schema(tags=[...])` — use the closest existing `OPENAPI_TAGS` entry.
2. Method-level `@extend_schema(operation_id=..., parameters=[...], responses={...}, examples=...)`.
3. Reuse `src/sentry/apidocs/parameters.py` and `examples/*.py`; ensure `owner = ApiOwner.<TEAM>` is set.
4. If a legacy `api-docs/paths/**/*.json` covers the path, remove it (see lesson 4).
5. Validate, then verify against the live endpoint (lesson 1).

## Lessons

### 1. Carefully compare what the code does vs declared types

Ideally, hit the live endpoint with a real token and diff the keys and types against your TypedDict. Serializers are sometimes inaccurate. Look out for counts coming back as floats instead of integers, IDs declared `int` emitted as strings, nested types declaring the wrong number of fields. Correct the declared type to match runtime.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://us.sentry.io/api/0/<endpoint>" | jq 'keys'
```

### 2. Reuse the canonical response type

Match the codebase's `XxxResponseOptional(TypedDict, total=False)` mixin (main class declares required fields). Nullable-vs-absent: `T | None` = key always present, value may be null; `NotRequired[T]` = key only set under a condition (e.g. an `expand` query param). Reuse the existing canonical type instead of re-declaring a second or third copy in a `*_types.py`. If there's no clean canonical type to reuse (e.g. a payload proxied from another service like vroom/profiling), type it `dict[str, Any]` rather than inventing a new mirror, and confirm the shape from the owning service's repo, not just the serializer.

### 3. Infer the type. Avoid `cast` and `# type: ignore`

When a serializer returns a base type plus extra fields, refactor the producing code so the response type is inferred rather than forced.

### 4. Legacy doc migration is all-or-nothing per path

Delete the `api-docs/paths/**/*.json` file AND its `$ref` in `api-docs/openapi.json`. drf-spectacular's `APPEND_PATHS` does not merge HTTP methods, so once any method on a path uses `@extend_schema`, all _legacy_ methods on that path vanish — migrate every method on the path in one commit.

## Promoting to PUBLIC

Do the workflow above, then on the concrete endpoint only (leave siblings PRIVATE):

- Bump `publish_status[<METHOD>]` → `PUBLIC` and set `owner = ApiOwner.<TEAM>`.
- Remove the method from `API_OWNERSHIP_ALLOWLIST_DONT_MODIFY` in the same change as the flip.
- If the endpoint is redundant or being renamed, delete or deprecate the old version in its own change first, then stack the publish on top.
- Note in the PR if scopes widen (`event:read` → `event:{admin,read,write}`) — that's drf-spectacular regenerating from `permission_classes`, documentation-only.

The change reaches the `@sentry/api` SDK / MCP only after `sentry-api-schema` regenerates downstream.

## Validate

```bash
make build-api-docs
pnpm run validate-api-examples
.venv/bin/pytest -q --reuse-db tests/apidocs/endpoints/<area>/test_<name>.py
.venv/bin/prek run -q --files <changed paths>
```
