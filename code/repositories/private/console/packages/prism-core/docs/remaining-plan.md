# Remaining Plan

## Current verified state

- `dry-run` mode verifies endpoint coverage, request construction, Markdown evidence generation, and secret redaction.
- Node direct `live` mode is blocked by Cloudflare before Prism application code.
- `browser-context` mode reaches Prism from a real Chrome origin and is the valid local execution strategy.
- Verified live in browser-context:
  - `POST /api/projects`
  - `GET /api/project-access?d=UUID`
  - `POST /api/codex/conversation-history`

## Verified contracts

```json
POST /api/projects
{
  "project_uuid": "uuid",
  "title": "string"
}
```

```json
POST /api/codex/conversation-history
{
  "project_uuid": "uuid"
}
```

`GET /api/project-access?d=UUID` returns `accessible`, `project`, and `userRole`.

## Evidence files

- `verification/browser-context-2026-09-16T23-12-25-012Z.md`: project creation succeeded.
- `verification/browser-context-2026-09-16T23-12-49-549Z.md`: project access succeeded.
- `verification/browser-context-2026-09-16T23-13-16-073Z.md`: conversation history succeeded.
- `verification/browser-context-2026-09-16T23-13-42-913Z.md`: render endpoint reached JSON app/proxy layer but guessed URL/schema is wrong.

## Remaining work

1. Capture the exact browser Network payloads for:
   - `POST /api/project-files/upload`
   - `POST /s/sandboxes/proxy/render`
   - `GET /s/sandboxes/proxy/render-status?waitMs=10000`
   - `POST /api/llm/response_with_tools_start`
   - `POST /api/llm/response_with_tools_status`
2. Update `docs/prism-endpoint-map.md` with exact request body/query/header shape from captured traffic.
3. Promote browser-context probes into named commands, for example:
   - `npm run prism:browser:create-project`
   - `npm run prism:browser:project-access`
   - `npm run prism:browser:conversation-history`
4. Add a cleanup command for browser-context temporary profiles and keep Cookie handling process-local only.
5. Add a full C-level browser workflow once upload/render schemas are verified:
   - create project
   - upload `.tex`
   - render
   - poll render status
6. Only after the browser workflow is stable, consider a thin MCP wrapper over the existing CLI.

## Constraints

- Do not persist raw cookies, access tokens, refresh tokens, or Cloudflare clearance tokens.
- Do not keep Cookie-injected Chrome profiles after verification.
- Do not rely on Node direct mode for live Prism calls; use it only for dry-run and regression checks.
- Keep implementation dependency-free unless CDP ergonomics becomes the bottleneck.
