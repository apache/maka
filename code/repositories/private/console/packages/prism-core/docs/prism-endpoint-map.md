# Prism endpoint map

来源：用户截图 + `learn-prism-local-interface-tool-plan.md`。本表记录的是本地工具必须覆盖的接口；字段契约仍需通过本人账号、本人项目、脱敏 HAR 继续验证。

| CLI command | Method | Path | 截图含义 | 当前工具支持 |
|---|---:|---|---|---|
| `create-project` | POST | `/api/projects` | 建项目 | JSON body |
| `project-access` | GET | `/api/project-access?d=UUID` | 项目访问权 | `--d UUID` / `--query d=UUID` |
| `conversation-history` | POST | `/api/codex/conversation-history` | Codex 会话 | JSON body |
| `llm-start` | POST | `/api/llm/response_with_tools_start` | AI 调用入口 | JSON body |
| `llm-status` | POST | `/api/llm/response_with_tools_status` | 轮询状态 | JSON body |
| `render` | POST | `/s/sandboxes/proxy/render` | LaTeX 编译启动 | JSON body |
| `render-status` | GET | `/s/sandboxes/proxy/render-status?waitMs=10000` | LaTeX 编译状态 | `--wait-ms 10000`，默认 10000 |
| `upload` | POST | `/api/project-files/upload` | 项目文件上传 | multipart `--file` + `--field` |
| `thumbnail` | PATCH | `/api/projects/{uuid}/thumbnail` | 更新项目缩略图 | `--uuid UUID` + JSON body |

## 待抓包确认

- 每个 POST/PATCH 的真实 body schema。
- 是否需要 CSRF header、request id、message header 或其他 OpenAI 前端专用 header。
- `render-status` 是否还需要 project/job id 等 query。
- `upload` 的 multipart 字段名是否固定为 `file`，是否需要 `projectId`、path、parent id。
- `llm-start` / `llm-status` 的响应 id 字段名、轮询结束态和错误态。

## Smoke verification

Dry-run C 级工作流已通过：

```text
npm run smoke
verification\dry-run-smoke-2026-09-16T22-54-14-439Z.md
STATUS=PASS
```

这证明本地工具能构造以下工作流请求：

1. `POST /api/projects`
2. `POST /api/project-files/upload`
3. `POST /s/sandboxes/proxy/render`
4. `GET /s/sandboxes/proxy/render-status?waitMs=10000`

下一步 live 证据以 `verification\live-smoke-*.md` 为准。

## Live result 2026-09-17

`verification\live-smoke-2026-09-16T23-01-04-920Z.md` 显示：

- `POST /api/projects` 在 Prism 应用层前被 Cloudflare 拒绝。
- 响应：`403 Forbidden`，HTML title 为 `Attention Required! | Cloudflare`。
- 普通 Node HTTP 调用暂不能作为最终调用方式；需要 browser-context runner。

## Browser-context verified contracts

| Endpoint | Live status | Verified request | Evidence |
|---|---:|---|---|
| `POST /api/projects` | PASS | JSON `{ "project_uuid": "uuid", "title": "string" }` | `verification\browser-context-2026-09-16T23-12-25-012Z.md` |
| `GET /api/project-access?d=UUID` | PASS | query `d=<project uuid>` | `verification\browser-context-2026-09-16T23-12-49-549Z.md` |
| `POST /api/codex/conversation-history` | PASS | JSON `{ "project_uuid": "uuid" }` | `verification\browser-context-2026-09-16T23-13-16-073Z.md` |
| `POST /s/sandboxes/proxy/render` | APP ERROR | guessed JSON `{ "project_uuid": "uuid" }` returns `Invalid URL (POST /sandboxes/proxy/render)` | `verification\browser-context-2026-09-16T23-13-42-913Z.md` |
| `GET /s/sandboxes/proxy/render-status?waitMs=10000` | APP ERROR | direct fetch returns `Invalid URL (GET /sandboxes/proxy/render-status)` | `verification\browser-context-2026-09-16T23-10-28-225Z.md` |

Browser-context changed the failure mode from Cloudflare HTML 403 to JSON application/proxy responses, proving local browser-context execution works.
