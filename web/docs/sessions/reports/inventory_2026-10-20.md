# 盘点报告 inventory — 2026-10-20

- C 盘：总 465.5 GB，可用 202.1 GB（执行前基线）
- 扫描方式：对 C 盘只读；NTFS junction 跳过；大户扫描 8 进程并行；DB 经只读连接 backup 到 E 盘副本（14:20）后读取
- 脱敏规则：sk- / gh?_ / AKIA / Bearer / password= / 私钥 / glm-长串 → `[REDACTED]`（短模型名如 glm-5.3 保留）

## 1. 会话源盘点

| 路径 | 工具 | 类别 | 大小 | 文件数 | 时间范围 | 风险级别 | 建议 | 是否需要退出程序 |
|---|---|---|---|---|---|---|---|---|
| `C:\Users\802165\claude\projects` | claude | 会话原始文件 | 115.0 MB | 252 | 2026-06-03 ~ 2026-10-14 | C | 先归档(raw/md)再谈清理；清了会减少 Magpie 历史统计 | 否 |
| `C:\Users\802165\codex\archived_sessions` | codex | 会话原始文件 | 7.3 MB | 24 | 2026-09-01 ~ 2026-10-17 | C | 先归档再谈清理 | 否 |
| `C:\Users\802165\codex\sessions` | codex | 会话原始文件 | 103.5 MB | 145 | 2026-09-01 ~ 2026-10-20 | C | 先归档再谈清理 | 否 |
| `C:\Users\802165\cursor\agent-transcripts` | cursor | 会话原始文件 | 9.2 MB | 68 | 2026-09-14 ~ 2026-10-20 | C | 先归档再谈清理 | 否 |
| `C:\Users\802165\factory\sessions` | factory | 会话原始文件 | 24.9 MB | 84 | 2026-10-12 ~ 2026-10-16 | C | 先归档再谈清理 | 否 |
| `C:\Users\802165\kimi\sessions` | kimi | 会话原始文件 | 3.9 MB | 35 | 2026-07-17 ~ 2026-07-31 | C | 先归档再谈清理 | 否 |
| `C:\Users\802165\zcode\rollout` | zcode | 会话原始文件 | 11.3 MB | 3 | 2026-10-20 ~ 2026-10-20 | B | model-io-* 归档后保留最新，其余可清 | 否 |

### 1.1 Magpie sessions.json 收录对照

- 逐会话对照见 `sessions_crossref_2026-10-20.tsv`（indexed_by_magpie=Y/N）
- claude: 已收录 252 / 未收录 0
- codex: 已收录 169 / 未收录 0
- cursor: 已收录 30 / 未收录 38
- factory: 已收录 28 / 未收录 56
- kimi: 已收录 7 / 未收录 28
- zcode: 已收录 0 / 未收录 3

## 2. ZCode 数据库结构（副本读取）

### zcode-cli-db（源 489.6 MB，副本 `E:\cc\guahub\sessions\_tmp\db\zcode-cli-db.sqlite`）

| 表 | 行数 | 字段 |
|---|---|---|
| schema_migration | 24 | id(TEXT), checksum(TEXT), app_version(TEXT), time_applied(INTEGER) |
| session | 293 | id(TEXT), project_id(TEXT), workspace_id(TEXT), parent_id(TEXT), slug(TEXT), directory(TEXT), path(TEXT), title(TEXT), version(TEXT), share_url(TEXT), summary_additions(INTEGER), summary_deletions(INTEGER), summary_files(INTEGER), summary_diffs(TEXT), revert(TEXT), permission(TEXT), time_created(INTEGER), time_updated(INTEGER), time_compacting(INTEGER), time_archived(INTEGER), task_type(TEXT), title_source(TEXT), title_message_id(TEXT), time_title_updated(INTEGER), trace_id(TEXT), time_deleted(INTEGER), last_outcome(TEXT) |
| message | 29980 | id(TEXT), session_id(TEXT), time_created(INTEGER), time_updated(INTEGER), data(TEXT), sequence(INTEGER) |
| part | 114919 | id(TEXT), message_id(TEXT), session_id(TEXT), time_created(INTEGER), time_updated(INTEGER), data(TEXT), sequence(INTEGER) |
| todo | 611 | session_id(TEXT), content(TEXT), status(TEXT), priority(TEXT), position(INTEGER), time_created(INTEGER), time_updated(INTEGER) |
| session_entry | 5740 | id(TEXT), session_id(TEXT), type(TEXT), time_created(INTEGER), time_updated(INTEGER), data(TEXT) |
| permission | 0 | project_id(TEXT), time_created(INTEGER), time_updated(INTEGER), data(TEXT) |
| input_history | 100 | id(TEXT), project_id(TEXT), session_id(TEXT), text(TEXT), kind(TEXT), time_created(INTEGER), attachments(TEXT) |
| local_setting | 39 | scope(TEXT), scope_id(TEXT), namespace(TEXT), key(TEXT), value(TEXT), schema_version(INTEGER), time_created(INTEGER), time_updated(INTEGER) |
| session_target | 1 | session_id(TEXT), target_id(TEXT), objective(TEXT), status(TEXT), token_budget(INTEGER), tokens_used(INTEGER), time_used_seconds(INTEGER), time_created(INTEGER), time_updated(INTEGER), summary_title(TEXT), active_input_id(TEXT), active_run_started_at(INTEGER), active_run_last_seen_at(INTEGER) |
| workflow_definition | 0 | id(TEXT), name(TEXT), source(TEXT), trusted(INTEGER), enabled(INTEGER), script_path(TEXT), script_hash(TEXT), meta_json(TEXT), time_created(INTEGER), time_updated(INTEGER), scope(TEXT) |
| workflow_run | 0 | id(TEXT), definition_id(TEXT), name(TEXT), kind(TEXT), parent_session_id(TEXT), cwd(TEXT), script_path(TEXT), script_hash(TEXT), args_json(TEXT), args_hash(TEXT), status(TEXT), current_phase(TEXT), budget_total(INTEGER), budget_spent(INTEGER), stats_json(TEXT), failure_json(TEXT), time_created(INTEGER), time_started(INTEGER), time_updated(INTEGER), time_completed(INTEGER) |
| workflow_activity | 0 | id(TEXT), run_id(TEXT), parent_activity_id(TEXT), call_index(INTEGER), call_path(TEXT), attempt(INTEGER), type(TEXT), phase(TEXT), label(TEXT), input_hash(TEXT), prompt(TEXT), opts_json(TEXT), status(TEXT), child_session_id(TEXT), result_json(TEXT), error_json(TEXT), time_created(INTEGER), time_started(INTEGER), time_updated(INTEGER), time_completed(INTEGER) |
| workflow_event | 0 | id(TEXT), run_id(TEXT), sequence(INTEGER), type(TEXT), phase(TEXT), activity_id(TEXT), payload_json(TEXT), time_created(INTEGER) |
| session_task_link | 0 | id(TEXT), root_workflow_run_id(TEXT), parent_link_id(TEXT), activity_id(TEXT), parent_session_id(TEXT), child_session_id(TEXT), role(TEXT), depth(INTEGER), path(TEXT), phase(TEXT), label(TEXT), agent_type(TEXT), model(TEXT), status(TEXT), time_created(INTEGER), time_updated(INTEGER) |
| model_usage | 13399 | id(TEXT), logical_request_id(TEXT), attempt_index(INTEGER), session_id(TEXT), turn_id(TEXT), trace_id(TEXT), span_id(TEXT), assistant_message_id(TEXT), parent_user_message_id(TEXT), query_source(TEXT), provider_id(TEXT), model_id(TEXT), variant(TEXT), agent(TEXT), mode(TEXT), task_type(TEXT), status(TEXT), started_at(INTEGER), first_token_at(INTEGER), completed_at(INTEGER), duration_ms(INTEGER), time_to_first_token_ms(INTEGER), finish_reason(TEXT), tool_call_count(INTEGER), input_tokens(INTEGER), output_tokens(INTEGER), reasoning_tokens(INTEGER), cache_creation_input_tokens(INTEGER), cache_read_input_tokens(INTEGER), provider_total_tokens(INTEGER), computed_total_tokens(INTEGER), retry_count(INTEGER), retryable(INTEGER), cancelled_by_user(INTEGER), context_exceeded(INTEGER), error_type(TEXT), error_code(TEXT), error_message(TEXT), raw_usage_json(TEXT), provider_metadata_json(TEXT) |
| turn_usage | 889 | session_id(TEXT), turn_id(TEXT), trace_id(TEXT), user_message_id(TEXT), status(TEXT), started_at(INTEGER), first_model_start_at(INTEGER), first_token_at(INTEGER), completed_at(INTEGER), duration_ms(INTEGER), time_to_first_token_ms(INTEGER), model_request_count(INTEGER), model_retry_count(INTEGER), tool_call_count(INTEGER), tool_error_count(INTEGER), input_tokens(INTEGER), output_tokens(INTEGER), reasoning_tokens(INTEGER), cache_creation_input_tokens(INTEGER), cache_read_input_tokens(INTEGER), computed_total_tokens(INTEGER), retryable(INTEGER), cancelled_by_user(INTEGER), context_exceeded(INTEGER), error_type(TEXT), error_code(TEXT) |
| tool_usage | 15540 | id(TEXT), session_id(TEXT), turn_id(TEXT), trace_id(TEXT), tool_call_id(TEXT), tool_name(TEXT), side_effect_scope(TEXT), read_only(INTEGER), destructive(INTEGER), approval_status(TEXT), status(TEXT), started_at(INTEGER), first_output_at(INTEGER), completed_at(INTEGER), duration_ms(INTEGER), time_to_first_output_ms(INTEGER), exit_code(INTEGER), output_bytes(INTEGER), stdout_bytes(INTEGER), stderr_bytes(INTEGER), truncated(INTEGER), retry_count(INTEGER), retryable(INTEGER), cancelled_by_user(INTEGER), error_type(TEXT), error_code(TEXT), error_message(TEXT) |
| session_input | 1765 | id(TEXT), session_id(TEXT), kind(TEXT), delivery(TEXT), payload(TEXT), admitted_sequence(INTEGER), promoted_sequence(INTEGER), promoted_message_id(TEXT), status(TEXT), status_reason(TEXT), time_created(INTEGER), time_updated(INTEGER) |
| dwf_run | 0 | id(TEXT), parent_session_id(TEXT), cwd(TEXT), name(TEXT), script_text(TEXT), script_hash(TEXT), args_json(TEXT), tool_call_id(TEXT), resumed_from(TEXT), caps_max_concurrency(INTEGER), spent_tokens(INTEGER), status(TEXT), result_json(TEXT), failure_json(TEXT), time_created(INTEGER), time_updated(INTEGER) |
| dwf_actor | 0 | id(INTEGER), run_id(TEXT), site_id(TEXT), ordinal(INTEGER), name(TEXT), persona_json(TEXT), resolved_model(TEXT), session_id(TEXT), time_created(INTEGER), time_updated(INTEGER) |
| dwf_node | 0 | id(INTEGER), run_id(TEXT), site_id(TEXT), ordinal(INTEGER), kind(TEXT), actor_site_id(TEXT), actor_ordinal(INTEGER), actor_seq(INTEGER), input_hash(TEXT), input_json(TEXT), status(TEXT), result_json(TEXT), error_json(TEXT), stats_json(TEXT), message_boundary(INTEGER), artifact_id(TEXT), time_created(INTEGER), time_updated(INTEGER) |
| dwf_event | 0 | id(INTEGER), run_id(TEXT), sequence(INTEGER), type(TEXT), payload_json(TEXT), time_created(INTEGER) |
| zcode_database_identity | 0 | scope(TEXT), identity(TEXT) |

**schema_migration** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "0001_base_session_store", "checksum": "60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462", "app_version": "0.2.0", "time_applied": "1782801700192"}
{"id": "0002_local_setting", "checksum": "22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465", "app_version": "0.2.0", "time_applied": "1782801700194"}
```

**session** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "project_id": "proj_c-users-802165-.agents", "workspace_id": "None", "parent_id": "None", "slug": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "directory": "C:\\Users\\802165\\.agents", "path": "C:\\Users\\802165\\.agents", "title": "嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Skills，项目路径是C:\\Users\\8021...", "version": "0.15.0", "share_url": "None", "summary_additions": "None", "summary_deletions": "None", "summary_files": "None", "summary_diffs": "None", "revert": "None", "permission": "{\"mode\":\"build\"}", "time_created": "1782802615237", "time_updated": "1782819892415", "time_compacting": "None", "time_archived": "None", "task_type": "interactive", "title_source": "first_input", "title_message_id": "None", "time_title_updated": "1782802615237", "trace_id": "7d036067-11ca-48b9-aa2f-1ef4e3bb01f9", "time_deleted": "None", "last_outcome": "None"}
{"id": "sess_subagent_agent_9e24d1ff-5690-41fd-ad81-bb22c95a6359", "project_id": "proj_c-users-802165-.agents", "workspace_id": "None", "parent_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "slug": "sess_subagent_agent_9e24d1ff-5690-41fd-ad81-bb22c95a6359", "directory": "C:\\Users\\802165\\.agents", "path": "C:\\Users\\802165\\.agents", "title": "你是一个侦察兵，正在探索 C:\\Users\\802165\\.agents 这个 skills 仓库。你的任务是采样...", "version": "0.15.0", "share_url": "None", "summary_additions": "None", "summary_deletions": "None", "summary_files": "None", "summary_diffs": "None", "revert": "None", "permission": "{\"mode\":\"yolo\"}", "time_created": "1782802738964", "time_updated": "1782802883030", "time_compacting": "None", "time_archived": "None", "task_type": "subagent_child", "title_source": "first_input", "title_message_id": "None", "time_title_updated": "1782802738964", "trace_id": "7d036067-11ca-48b9-aa2f-1ef4e3bb01f9", "time_deleted": "None", "last_outcome": "None"}
```

**message** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "msg_mr0an9w0_2e2822a8-09cd-4a43-86e9-5cea1036b2ec", "session_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "time_created": "1782802615249", "time_updated": "1782802615249", "data": "{\"role\":\"user\",\"time\":{\"created\":1782802615249},\"agent\":\"zcode-agent\",\"model\":{\"providerID\":\"builtin:bigmodel-coding-plan\",\"modelID\":\"GLM-5.2\"},\"co...", "sequence": "0"}
{"id": "msg_mr0an9wf_ed1b9b80-ccd9-46c4-9457-8e991f667a7d", "session_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "time_created": "1782802615263", "time_updated": "1782802663689", "data": "{\"role\":\"assistant\",\"time\":{\"created\":1782802615263,\"completed\":1782802663689},\"parentID\":\"msg_mr0an9w0_2e2822a8-09cd-4a43-86e9-5cea1036b2ec\",\"mode...", "sequence": "1"}
```

**part** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "part_mr0an9w5_105423e6-29f3-4886-9299-2246519cd926", "message_id": "msg_mr0an9w0_2e2822a8-09cd-4a43-86e9-5cea1036b2ec", "session_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "time_created": "1782802615249", "time_updated": "1782802615253", "data": "{\"type\":\"text\",\"text\":\"嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Skills，项目路径是C:\\\\Users\\\\802165\\\\.agents。了解我们现在的全局通用Skills这块具体包含哪些内容，具体是怎么工作的。但是！暂时不要动任何代码/文件。...", "sequence": "0"}
{"id": "part_mr0an9wl_bb9540f9-45e3-48b0-9420-d3b10050f16c", "message_id": "msg_mr0an9wf_ed1b9b80-ccd9-46c4-9457-8e991f667a7d", "session_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "time_created": "1782802615269", "time_updated": "1782802615269", "data": "{\"type\":\"step-start\"}", "sequence": "2"}
```

**todo** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"session_id": "sess_da8ef3a2-9510-4054-bd3d-76eaeb4835a5", "content": "修复 toolbox：补 src/data/capability-dimensions + database-products（源：inbox/ggbdpq-site）", "status": "completed", "priority": "high", "position": "0", "time_created": "1788152259501", "time_updated": "1788152259501"}
{"session_id": "sess_da8ef3a2-9510-4054-bd3d-76eaeb4835a5", "content": "修复 blog：补 src/data/articles（moments/articles/seriesList/growthEntries）", "status": "completed", "priority": "high", "position": "1", "time_created": "1788152259501", "time_updated": "1788152259501"}
```

**session_entry** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6:runtime:bash_shell_selection", "session_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "type": "runtime/bash_shell_selection", "time_created": "1782802615242", "time_updated": "1782802615242", "data": "{\"dialect\":\"git-bash\",\"display\":{\"name\":\"Git Bash\"},\"id\":\"auto:git-bash\",\"label\":\"Git Bash\",\"path\":\"D:\\\\WEBDEV\\\\Git\\\\bin\\\\bash.exe\",\"source\":\"auto-..."}
{"id": "sess_subagent_agent_9e24d1ff-5690-41fd-ad81-bb22c95a6359:runtime:bash_shell_selection", "session_id": "sess_subagent_agent_9e24d1ff-5690-41fd-ad81-bb22c95a6359", "type": "runtime/bash_shell_selection", "time_created": "1782802738967", "time_updated": "1782802738967", "data": "{\"dialect\":\"git-bash\",\"display\":{\"name\":\"Git Bash\"},\"id\":\"auto:git-bash\",\"label\":\"Git Bash\",\"path\":\"D:\\\\WEBDEV\\\\Git\\\\bin\\\\bash.exe\",\"source\":\"auto-..."}
```

**input_history** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "input_mvc7jkfh_362590da-c322-4bc2-a05d-7cc7352d7384", "project_id": "proj_e-cc", "session_id": "sess_4a2000ae-c167-472b-8255-e422431d09d6", "text": "你是什么大模型", "kind": "prompt", "time_created": "1792230126893", "attachments": "None"}
{"id": "input_mvc7l0st_c4352eac-93e4-4328-a783-3ef294b10144", "project_id": "proj_e-cc-guahub-fork-maka-hub", "session_id": "sess_d25c583e-2e6f-4a21-a62d-693f39a90f2a", "text": "[$ponytail](C:\\\\Users\\\\802165\\\\.zcode\\\\skills\\\\ponytail\\\\SKILL.md) 你看看这四个PR，是否有新的进展和评论。", "kind": "prompt", "time_created": "1792230194765", "attachments": "[{\"type\":\"image\",\"path\":\"image.png\",\"content\":\"zcode-artifact://sess_d25c583e-2e6f-4a21-a62d-693f39a90f2a/tool-result-c2c80121-675a-490a-98b8-d0332..."}
```

**local_setting** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"scope": "project", "scope_id": "proj_c-users-802165-.agents", "namespace": "permission", "key": "ruleset", "value": "{\"version\":1,\"allow\":[{\"toolName\":\"Bash\",\"ruleContent\":\"cd \\\"C:\\\\Users\\\\802165\\\\.agents\\\" && find categories -path \\\"*proto-to-prd/SKILL.md\\\" -exec...", "schema_version": "1", "time_created": "1782803305943", "time_updated": "1782803305943"}
{"scope": "project", "scope_id": "proj_e-projects-frontend-beauty-smart-advisor", "namespace": "permission", "key": "ruleset", "value": "{\"version\":1,\"allow\":[{\"ruleContent\":\"find \\\"E:\\\\Projects\\\\frontend\\\\beauty-smart-advisor\\\\src\\\\pages\\\\serviceComplete\\\" -type f | head -50 && echo...", "schema_version": "1", "time_created": "1787980905622", "time_updated": "1788586850737"}
```

**session_target** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"session_id": "sess_75e9e885-0c3e-45d3-8f8b-a491e1a02c36", "target_id": "target_mtqnt5k1_658c8af3-2462-4e8d-89d5-ee2371c0e68c", "objective": "我在本地下载了一份wx_key，路径是E:\\guahub\\gh\\open\\social\\ycccccccy__wx_key，你看看你还需要那些资料；", "status": "complete", "token_budget": "None", "tokens_used": "10356288", "time_used_seconds": "3370", "time_created": "1788750409825", "time_updated": "1788753814284", "summary_title": "提供wx_key本地路径询问所需资料", "active_input_id": "None", "active_run_started_at": "None", "active_run_last_seen_at": "None"}
```

**model_usage** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "usage_model_main_turn_msg_mu9ftlw7_a5b586af-5f7a-4547-b665-843cc9f185f2_0", "logical_request_id": "msg_mu9ftlw7_a5b586af-5f7a-4547-b665-843cc9f185f2", "attempt_index": "0", "session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_f9a965c0-abf1-48f0-870b-c95fecf0192e", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "span_id": "e7333caa-4051-43", "assistant_message_id": "msg_mu9ftlw7_a5b586af-5f7a-4547-b665-843cc9f185f2", "parent_user_message_id": "msg_mu9ftlut_044c711f-2e74-4088-9e70-00cab922398b", "query_source": "main_turn", "provider_id": "20655669-52ef-45a8-a7b8-1068e4905f29", "model_id": "deepseek-flash", "variant": "max", "agent": "zcode-agent", "mode": "yolo", "task_type": "interactive", "status": "completed", "started_at": "1789885851415", "first_token_at": "1789885853757", "completed_at": "1789885874161", "duration_ms": "22746", "time_to_first_token_ms": "2342", "finish_reason": "tool-calls", "tool_call_count": "1", "input_tokens": "239469", "output_tokens": "4075", "reasoning_tokens": "4001", "cache_creation_input_tokens": "0", "cache_read_input_tokens": "238976", "provider_total_tokens": "243544", "computed_total_tokens": "243544", "retry_count": "0", "retryable": "0", "cancelled_by_user": "0", "context_exceeded": "0", "error_type": "None", "error_code": "None", "error_message": "None", "raw_usage_json": "{\"inputTokens\":239469,\"outputTokens\":4075,\"totalTokens\":243544,\"cacheReadTokens\":238976,\"reasoningTokens\":4001}", "provider_metadata_json": "{\"rawFinishReason\":\"tool_calls\"}"}
{"id": "usage_model_main_turn_msg_mu9fu3s9_1fa35450-7890-44d9-96ce-980a87758f36_0", "logical_request_id": "msg_mu9fu3s9_1fa35450-7890-44d9-96ce-980a87758f36", "attempt_index": "0", "session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_f9a965c0-abf1-48f0-870b-c95fecf0192e", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "span_id": "4e776b0e-3c0c-49", "assistant_message_id": "msg_mu9fu3s9_1fa35450-7890-44d9-96ce-980a87758f36", "parent_user_message_id": "msg_mu9ftlut_044c711f-2e74-4088-9e70-00cab922398b", "query_source": "main_turn", "provider_id": "20655669-52ef-45a8-a7b8-1068e4905f29", "model_id": "deepseek-flash", "variant": "max", "agent": "zcode-agent", "mode": "yolo", "task_type": "interactive", "status": "completed", "started_at": "1789885874601", "first_token_at": "None", "completed_at": "1789885876783", "duration_ms": "2182", "time_to_first_token_ms": "None", "finish_reason": "tool-calls", "tool_call_count": "1", "input_tokens": "245142", "output_tokens": "62", "reasoning_tokens": "0", "cache_creation_input_tokens": "0", "cache_read_input_tokens": "243456", "provider_total_tokens": "245204", "computed_total_tokens": "245204", "retry_count": "0", "retryable": "0", "cancelled_by_user": "0", "context_exceeded": "0", "error_type": "None", "error_code": "None", "error_message": "None", "raw_usage_json": "{\"inputTokens\":245142,\"outputTokens\":62,\"totalTokens\":245204,\"cacheReadTokens\":243456,\"reasoningTokens\":0}", "provider_metadata_json": "{\"rawFinishReason\":\"tool_calls\"}"}
```

**turn_usage** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_f9a965c0-abf1-48f0-870b-c95fecf0192e", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "user_message_id": "msg_mu9ftlut_044c711f-2e74-4088-9e70-00cab922398b", "status": "completed", "started_at": "1789885851351", "first_model_start_at": "1789885851424", "first_token_at": "1789885853757", "completed_at": "1789885973279", "duration_ms": "121928", "time_to_first_token_ms": "2406", "model_request_count": "13", "model_retry_count": "0", "tool_call_count": "12", "tool_error_count": "0", "input_tokens": "3346401", "output_tokens": "16158", "reasoning_tokens": "12836", "cache_creation_input_tokens": "0", "cache_read_input_tokens": "3333376", "computed_total_tokens": "3362559", "retryable": "0", "cancelled_by_user": "0", "context_exceeded": "0", "error_type": "None", "error_code": "None"}
{"session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_b0e34ce6-4765-44bf-a942-a38490f73743", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "user_message_id": "msg_mu9fwxku_496b5d59-e13d-4e39-9e57-37a556f6e28a", "status": "completed", "started_at": "1789886006512", "first_model_start_at": "1789886006561", "first_token_at": "1789886008478", "completed_at": "1789886024991", "duration_ms": "18479", "time_to_first_token_ms": "1966", "model_request_count": "3", "model_retry_count": "0", "tool_call_count": "2", "tool_error_count": "0", "input_tokens": "806918", "output_tokens": "2177", "reasoning_tokens": "1673", "cache_creation_input_tokens": "0", "cache_read_input_tokens": "802944", "computed_total_tokens": "809095", "retryable": "0", "cancelled_by_user": "0", "context_exceeded": "0", "error_type": "None", "error_code": "None"}
```

**tool_usage** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "usage_tool_sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45_call_00_1LRkwbfb7LzLb4Z3NOGU2182", "session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_f9a965c0-abf1-48f0-870b-c95fecf0192e", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "tool_call_id": "call_00_1LRkwbfb7LzLb4Z3NOGU2182", "tool_name": "Read", "side_effect_scope": "none", "read_only": "1", "destructive": "0", "approval_status": "none", "status": "completed", "started_at": "1789885874113", "first_output_at": "1789885874565", "completed_at": "1789885874565", "duration_ms": "437", "time_to_first_output_ms": "437", "exit_code": "0", "output_bytes": "5817", "stdout_bytes": "0", "stderr_bytes": "0", "truncated": "0", "retry_count": "0", "retryable": "0", "cancelled_by_user": "0", "error_type": "None", "error_code": "None", "error_message": "None"}
{"id": "usage_tool_sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45_call_00_ET_AULbEEoUTQTbBWsKg12a9848", "session_id": "sess_e3621c00-d0b7-4105-8a60-fe16f5c88d45", "turn_id": "turn_f9a965c0-abf1-48f0-870b-c95fecf0192e", "trace_id": "580fe15e-d64c-495b-b7ba-150a48f7286a", "tool_call_id": "call_00_ET_AULbEEoUTQTbBWsKg12a9848", "tool_name": "Read", "side_effect_scope": "none", "read_only": "1", "destructive": "0", "approval_status": "none", "status": "completed", "started_at": "1789885876746", "first_output_at": "1789885876803", "completed_at": "1789885876803", "duration_ms": "42", "time_to_first_output_ms": "43", "exit_code": "0", "output_bytes": "25845", "stdout_bytes": "0", "stderr_bytes": "0", "truncated": "0", "retry_count": "0", "retryable": "0", "cancelled_by_user": "0", "error_type": "None", "error_code": "None", "error_message": "None"}
```

**session_input** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "queue_01a04bf5-c176-74fd-9673-0059b5ac86b8", "session_id": "sess_dd78e2ba-cf83-4e18-9c61-47efc4b380b8", "kind": "sendText", "delivery": "startNow", "payload": "{\"text\":\"[$skill-doctor](C:\\\\\\\\Users\\\\\\\\802165\\\\\\\\.zcode\\\\\\\\skills\\\\\\\\skill-doctor\\\\\\\\SKILL.md) 你帮我分析一下E:\\\\Projects\\\\frontend\\\\beauty-smart-advisor...", "admitted_sequence": "0", "promoted_sequence": "0", "promoted_message_id": "msg_mtdxlkwj_7225e32e-37f8-4b49-b5f3-ce6b3731b09d", "status": "promoted", "status_reason": "None", "time_created": "1787980792212", "time_updated": "1787980792359"}
{"id": "queue_01a04c05-59b4-7d28-bfff-bf28af501eb5", "session_id": "sess_848dceff-04f5-46ba-b63d-fcef9a805706", "kind": "sendText", "delivery": "startNow", "payload": "{\"text\":\"嘿 GLM-5.3-Flash，请你像一个新来的侦察兵一样，仔细探索cursor-loc。了解我们现在的本地Cursor界面汉化工具具体包含哪些内容，具体是怎么工作的。但是！暂时不要动任何代码/文件。我需要你先成为这个系统的专家。\",\"intent\":{\"sourceComm...", "admitted_sequence": "0", "promoted_sequence": "0", "promoted_message_id": "msg_mtdy7ix6_87cf3c49-26ff-46f9-9707-7df2f8cdaad4", "status": "promoted", "status_reason": "None", "time_created": "1787981814209", "time_updated": "1787981816217"}
```

### zcode-tasks-index（源 5.7 MB，副本 `E:\cc\guahub\sessions\_tmp\db\zcode-tasks-index.sqlite`）

| 表 | 行数 | 字段 |
|---|---|---|
| tasks | 168 | workspace_key(TEXT), workspace_path(TEXT), workspace_identity(TEXT), task_id(TEXT), title(TEXT), task_status(TEXT), provider(TEXT), mode(TEXT), model(TEXT), migration_source(TEXT), forked_from_task_id(TEXT), created_at(INTEGER), updated_at(INTEGER), unread_at(INTEGER), pinned(INTEGER), archived(INTEGER), deleted(INTEGER), title_overridden(INTEGER), meta_json(TEXT), searchable_text(TEXT), last_unread_at(INTEGER), cron_automation_id(TEXT), off_peak_task_id(TEXT), host_id(TEXT), root_path(TEXT), project_id(TEXT), execution_directories(TEXT), sort_order(INTEGER), cli_title(TEXT), handoff_pending(INTEGER), cli_title_source(TEXT), cli_created_at(INTEGER), cli_updated_at(INTEGER), cli_last_outcome(TEXT), cli_deleted(INTEGER) |
| task_groups | 1 | group_id(TEXT), title(TEXT), color(TEXT), created_at(INTEGER), updated_at(INTEGER) |
| task_group_members | 1 | group_id(TEXT), workspace_key(TEXT), workspace_path(TEXT), workspace_identity(TEXT), task_id(TEXT), sort_order(INTEGER), added_at(INTEGER), created_at(INTEGER), updated_at(INTEGER) |
| task_group_view_node_orders | 163 | node_type(TEXT), node_key(TEXT), sort_order(INTEGER), created_at(INTEGER), updated_at(INTEGER) |
| task_group_workspace_bootstraps | 0 | workspace_key(TEXT), group_id(TEXT), created_at(INTEGER), updated_at(INTEGER) |
| automations | 1 | automation_id(TEXT), title(TEXT), cron_expr(TEXT), prompt(TEXT), model(TEXT), provider(TEXT), mode(TEXT), thought_level(TEXT), workspace_key(TEXT), workspace_path(TEXT), workspace_identity(TEXT), target_task_id(TEXT), bot_delivery_target(TEXT), location_kind(TEXT), recurring(INTEGER), max_runs(INTEGER), end_at(INTEGER), schedule_rule(TEXT), schedule_edited_by_user(INTEGER), run_count(INTEGER), scheduled_run_count(INTEGER), enabled(INTEGER), lifecycle_status(TEXT), next_run_at(INTEGER), last_run_at(INTEGER), running(INTEGER), claimed_at(INTEGER), dispatch_status(TEXT), dispatch_attempts(INTEGER), retry_at(INTEGER), last_error(TEXT), created_at(INTEGER), updated_at(INTEGER), model_selection(TEXT), project_id(TEXT), host_id(TEXT), additional_directories(TEXT) |
| automation_runs | 22 | run_id(TEXT), automation_id(TEXT), workspace_key(TEXT), scheduled_at(INTEGER), trigger(TEXT), dispatch_status(TEXT), outcome(TEXT), session_id(TEXT), error(TEXT), attempts(INTEGER), created_at(INTEGER), updated_at(INTEGER), model_selection(TEXT) |
| off_peak_tasks | 0 | off_peak_task_id(TEXT), server_ticket_id(TEXT), title(TEXT), conversation_id(TEXT), session_id(TEXT), prompt(TEXT), permission_mode(TEXT), model(TEXT), thought_level(TEXT), workspace_key(TEXT), workspace_path(TEXT), workspace_identity(TEXT), status(TEXT), queued_at(INTEGER), started_at(INTEGER), ended_at(INTEGER), failure_reason(TEXT), files_changed(INTEGER), settled_at(INTEGER), history_deleted_at(INTEGER), registered_at(INTEGER), schedulable(INTEGER), queue_position(INTEGER), next_poll_at(INTEGER), claim_running(INTEGER), claimed_at(INTEGER), attempt_count(INTEGER), last_error(TEXT), created_at(INTEGER), updated_at(INTEGER), model_selection(TEXT), project_id(TEXT), host_id(TEXT), additional_directories(TEXT) |
| tasks_schema_migration | 5 | id(TEXT), checksum(TEXT), time_applied(INTEGER) |
| task_group_admissions | 162 | workspace_key(TEXT), task_id(TEXT), system_kind(TEXT), user_organized(INTEGER), creation_id(TEXT) |
| schema_migration | 3 | id(TEXT), checksum(TEXT), app_version(TEXT), applied_at(INTEGER) |
| hosts | 1 | host_id(TEXT), kind(TEXT), target_json(TEXT), membership_id(TEXT), position(INTEGER), last_connection_status(TEXT), last_connection_error(TEXT), last_opened_at(INTEGER) |
| projects | 11 | project_id(TEXT), host_id(TEXT), name(TEXT), name_overridden(INTEGER), position(INTEGER), pinned(INTEGER), pinned_at(INTEGER), deleted(INTEGER), deleted_at(INTEGER), created_at(INTEGER), updated_at(INTEGER) |
| project_roots | 11 | project_id(TEXT), root_path(TEXT), position(INTEGER), is_primary(INTEGER) |
| remote_project_entries | 0 | entry_id(TEXT), host_id(TEXT), remote_project_id(TEXT), cached_name(TEXT), cached_roots_json(TEXT), legacy_workspace_json(TEXT), last_synced_at(INTEGER), initial_position(INTEGER) |

**tasks** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"workspace_key": "C:\\Users\\802165\\.agents", "workspace_path": "C:\\Users\\802165\\.agents", "workspace_identity": "None", "task_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "title": "嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Skills，项目路径是C:\\Users\\8021...", "task_status": "error", "provider": "glm", "mode": "build", "model": "builtin:bigmodel-coding-plan/GLM-5.2", "migration_source": "None", "forked_from_task_id": "None", "created_at": "1782802615237", "updated_at": "1782819892423", "unread_at": "None", "pinned": "0", "archived": "0", "deleted": "0", "title_overridden": "0", "meta_json": "{\"taskId\":\"sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6\",\"traceId\":\"7d036067-11ca-48b9-aa2f-1ef4e3bb01f9\",\"title\":\"嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Ski...", "searchable_text": "嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Skills，项目路径是C:\\Users\\802165\\.agents。了解我们现在的全局通用Skills这块具体包含哪些内容，具体是怎么工作的。但是！暂时不要动任何代码/文件。我需要你先成为这个系统的专家。", "last_unread_at": "0", "cron_automation_id": "None", "off_peak_task_id": "None", "host_id": "local", "root_path": "C:\\Users\\802165\\.agents", "project_id": "None", "execution_directories": "None", "sort_order": "None", "cli_title": "嘿 GLM-5.2，请你像一个新来的侦察兵一样，仔细探索全局通用Skills，项目路径是C:\\Users\\8021...", "handoff_pending": "8", "cli_title_source": "default", "cli_created_at": "1782802615237", "cli_updated_at": "1782819892423", "cli_last_outcome": "error", "cli_deleted": "0"}
{"workspace_key": "E:\\Projects\\frontend\\beauty-smart-advisor", "workspace_path": "E:\\Projects\\frontend\\beauty-smart-advisor", "workspace_identity": "None", "task_id": "sess_dd78e2ba-cf83-4e18-9c61-47efc4b380b8", "title": "分析 serviceComplete 服务完成开发模块", "task_status": "completed", "provider": "glm", "mode": "build", "model": "builtin:bigmodel-coding-plan/GLM-5.3-Flash", "migration_source": "None", "forked_from_task_id": "None", "created_at": "1787980792198", "updated_at": "1787998636258", "unread_at": "None", "pinned": "0", "archived": "0", "deleted": "0", "title_overridden": "0", "meta_json": "{\"taskId\":\"sess_dd78e2ba-cf83-4e18-9c61-47efc4b380b8\",\"traceId\":\"c037c5db-7181-4294-a6b9-13868249d5e9\",\"title\":\"分析 serviceComplete 服务完成开发模块\",\"works...", "searchable_text": "[$skill-doctor](C:\\\\Users\\\\802165\\\\.zcode\\\\skills\\\\skill-doctor\\\\SKILL.md) 你帮我分析一下E:\\Projects\\frontend\\beauty-smart-advisor\\src\\pages\\serviceComple...", "last_unread_at": "1787984662787", "cron_automation_id": "None", "off_peak_task_id": "None", "host_id": "local", "root_path": "E:\\Projects\\frontend\\beauty-smart-advisor", "project_id": "None", "execution_directories": "None", "sort_order": "None", "cli_title": "分析 serviceComplete 服务完成开发模块", "handoff_pending": "8", "cli_title_source": "default", "cli_created_at": "1787980792198", "cli_updated_at": "1787998636258", "cli_last_outcome": "completed", "cli_deleted": "0"}
```

**task_groups** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"group_id": "zcode-default-group-cron", "title": "cron", "color": "blue", "created_at": "1788771931090", "updated_at": "1788771931090"}
```

**task_group_members** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"group_id": "zcode-default-group-cron", "workspace_key": "E:\\guahub\\gh\\fork\\maka", "workspace_path": "E:\\guahub\\gh\\fork\\maka", "workspace_identity": "None", "task_id": "sess_9112f374-d908-44db-9997-41f0f28697ad", "sort_order": "None", "added_at": "1788771931090", "created_at": "1788771931090", "updated_at": "1788771931090"}
```

**task_group_view_node_orders** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"node_type": "task", "node_key": "[\"E:\\\\Projects\\\\frontend\\\\beauty-smart-advisor\",\"sess_dd78e2ba-cf83-4e18-9c61-47efc4b380b8\"]", "sort_order": "161", "created_at": "1787980793726", "updated_at": "1792475959139"}
{"node_type": "task", "node_key": "[\"C:\\\\Users\\\\802165\\\\vibe\\\\inbox\\\\cursor-loc\",\"sess_848dceff-04f5-46ba-b63d-fcef9a805706\"]", "sort_order": "160", "created_at": "1787981817102", "updated_at": "1792475959139"}
```

**automations** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"automation_id": "automation-7eda9f43-153d-46b0-ab5c-2b14bb6f3775", "title": "每天 9 点同步 maka 本地 main 分支", "cron_expr": "0 9 * * *", "prompt": "同步 apache/maka 本地 main 分支。执行：git -C \"E:\\ggbdpq\\gh-fork\\maka\" fetch upstream main:main（该 refspec 只做 fast-forward，不会切分支、不改工作区）。若报 schannel SSL 握手失败则等...", "model": "builtin:bigmodel-coding-plan/GLM-5.3-Flash", "provider": "glm", "mode": "edit", "thought_level": "max", "workspace_key": "E:\\guahub\\gh\\fork\\maka", "workspace_path": "E:\\guahub\\gh\\fork\\maka", "workspace_identity": "None", "target_task_id": "sess_9112f374-d908-44db-9997-41f0f28697ad", "bot_delivery_target": "None", "location_kind": "local", "recurring": "1", "max_runs": "None", "end_at": "None", "schedule_rule": "None", "schedule_edited_by_user": "0", "run_count": "10", "scheduled_run_count": "10", "enabled": "0", "lifecycle_status": "paused", "next_run_at": "1791939600000", "last_run_at": "1790643907381", "running": "0", "claimed_at": "None", "dispatch_status": "idle", "dispatch_attempts": "0", "retry_at": "None", "last_error": "None", "created_at": "1788771931080", "updated_at": "1791870595294", "model_selection": "{\"providerId\":\"account:bigmodel-individual-coding-plan\",\"modelId\":\"GLM-5.3-Flash\",\"options\":{\"reasoningLevel\":\"max\"}}", "project_id": "None", "host_id": "local", "additional_directories": "[]"}
```

**automation_runs** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"run_id": "automation-7eda9f43-153d-46b0-ab5c-2b14bb6f3775:1788829200000", "automation_id": "automation-7eda9f43-153d-46b0-ab5c-2b14bb6f3775", "workspace_key": "E:\\guahub\\gh\\fork\\maka", "scheduled_at": "1788829200000", "trigger": "schedule", "dispatch_status": "dispatched", "outcome": "succeeded", "session_id": "sess_9112f374-d908-44db-9997-41f0f28697ad", "error": "None", "attempts": "1", "created_at": "1788829480219", "updated_at": "1788829585714", "model_selection": "None"}
{"run_id": "automation-7eda9f43-153d-46b0-ab5c-2b14bb6f3775:1788915600000", "automation_id": "automation-7eda9f43-153d-46b0-ab5c-2b14bb6f3775", "workspace_key": "E:\\guahub\\gh\\fork\\maka", "scheduled_at": "1788915600000", "trigger": "schedule", "dispatch_status": "skipped", "outcome": "None", "session_id": "None", "error": "computer_asleep_or_app_not_running", "attempts": "0", "created_at": "1788928227511", "updated_at": "1788928227511", "model_selection": "None"}
```

**tasks_schema_migration** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "0001_adopt_task_schema", "checksum": "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17", "time_applied": "1789645275841"}
{"id": "0002_provider_selection", "checksum": "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc", "time_applied": "1789645275841"}
```

**task_group_admissions** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"workspace_key": "C:\\Users\\802165\\.agents", "task_id": "sess_d9fa6dee-ff27-4be1-90f0-a1aaced803d6", "system_kind": "None", "user_organized": "0", "creation_id": "None"}
{"workspace_key": "E:\\Projects\\frontend\\beauty-smart-advisor", "task_id": "sess_dd78e2ba-cf83-4e18-9c61-47efc4b380b8", "system_kind": "None", "user_organized": "1", "creation_id": "None"}
```

**schema_migration** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"id": "0005_projects", "checksum": "ac00a61c7c45a5ceb3814b1487901372c5580eb6eb8d31bde5bcdfbd1ed0f0da", "app_version": "3.12.0", "applied_at": "1792390829707"}
{"id": "0006_default_workspace_tasks", "checksum": "688bfe3cb7548ffb5ccbade2f5d71c05b14452a2aa32e5ace2e60f313680eaa4", "app_version": "3.12.0", "applied_at": "1792390829707"}
```

**hosts** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"host_id": "local", "kind": "local", "target_json": "None", "membership_id": "None", "position": "0", "last_connection_status": "None", "last_connection_error": "None", "last_opened_at": "None"}
```

**projects** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"project_id": "06a8919f-0272-4545-b3a2-aeb8ec056c5a", "host_id": "local", "name": "requirements-analysis", "name_overridden": "0", "position": "0", "pinned": "0", "pinned_at": "None", "deleted": "0", "deleted_at": "None", "created_at": "1792390829589", "updated_at": "1792390829589"}
{"project_id": "b5f81aad-5968-4782-a5af-177f9fd632a3", "host_id": "local", "name": "homing-miniapp-workbench", "name_overridden": "0", "position": "1", "pinned": "0", "pinned_at": "None", "deleted": "0", "deleted_at": "None", "created_at": "1792390829589", "updated_at": "1792390829589"}
```

**project_roots** 脱敏样本（2 条，字段值截断 150 字符）：
```json
{"project_id": "06a8919f-0272-4545-b3a2-aeb8ec056c5a", "root_path": "E:\\Projects\\requirements-analysis", "position": "0", "is_primary": "1"}
{"project_id": "b5f81aad-5968-4782-a5af-177f9fd632a3", "root_path": "E:\\Projects\\frontend\\homing-miniapp-workbench", "position": "0", "is_primary": "1"}
```

## 3. C:\Users\802165 目录体积 Top 40

| 目录 | 大小 | 文件数 | 时间范围 |
|---|---|---|---|
| AppData | 122.0 GB | 843408 | ? ~ 2026-10-20 |
| Documents | 11.7 GB | 92216 | 2017-08-02 ~ 2026-10-20 |
| .cache | 7.2 GB | 42176 | 1980-01-01 ~ 2026-10-20 |
| .zcode | 3.1 GB | 10239 | 2026-06-30 ~ 2026-10-20 |
| .codex | 2.4 GB | 21795 | 1970-01-01 ~ 2026-10-20 |
| .trae-cn | 2.3 GB | 16106 | 2026-04-16 ~ 2026-08-06 |
| go | 2.1 GB | 205914 | 2026-08-12 ~ 2026-10-17 |
| .qoder | 1.5 GB | 20394 | 2026-04-16 ~ 2026-10-15 |
| .rustup | 1.3 GB | 65908 | 2026-08-27 ~ 2026-08-27 |
| .grok | 1001.5 MB | 58 | 2026-08-31 ~ 2026-10-20 |
| .wechat-intelligence-hub | 980.1 MB | 5 | 2026-09-07 ~ 2026-09-07 |
| .workbuddy-ai | 677.8 MB | 29989 | 2024-11-07 ~ 2026-10-20 |
| .cargo | 556.5 MB | 12187 | 1970-01-01 ~ 2026-10-20 |
| KimiData | 536.0 MB | 15550 | 1985-10-26 ~ 2026-10-17 |
| .cc-switch | 503.0 MB | 79 | 2026-06-01 ~ 2026-10-20 |
| .vscode | 483.3 MB | 7726 | 2026-04-16 ~ 2026-10-17 |
| .claude | 436.2 MB | 11125 | 2026-05-14 ~ 2026-10-20 |
| Downloads | 421.1 MB | 143 | 2026-04-16 ~ 2026-10-20 |
| .codegeex | 336.4 MB | 17108 | 2019-07-13 ~ 2026-04-24 |
| .workbuddy | 282.6 MB | 4622 | 2024-01-01 ~ 2026-10-20 |
| .mimo2codex | 275.4 MB | 10 | 2026-05-29 ~ 2026-05-29 |
| .fnm | 273.8 MB | 5984 | 2024-11-07 ~ 2026-08-18 |
| bin | 268.7 MB | 1 | 2026-10-12 ~ 2026-10-12 |
| .ai | 227.7 MB | 15174 | 2026-08-24 ~ 2026-10-20 |
| .git | 176.2 MB | 1365 | 2026-09-01 ~ 2026-10-20 |
| .factory | 165.9 MB | 382 | 2026-10-12 ~ 2026-10-16 |
| CLIProxyAPI | 152.9 MB | 45 | 2026-05-13 ~ 2026-10-20 |
| .bun | 140.6 MB | 7577 | 2026-05-14 ~ 2026-10-20 |
| .kimi-work | 124.0 MB | 31 | 1980-01-01 ~ 2026-10-17 |
| .amp | 118.3 MB | 16 | 2026-04-30 ~ 2026-04-30 |
| TraceEagle | 110.1 MB | 5744 | 2026-08-12 ~ 2026-08-12 |
| .codebuddy | 107.3 MB | 10438 | 2026-04-16 ~ 2026-10-20 |
| .cursor-byok-v3 | 94.3 MB | 57 | 2026-08-27 ~ 2026-09-30 |
| .antigravity-ide | 81.0 MB | 2873 | 2026-08-17 ~ 2026-08-17 |
| .antigravity | 81.0 MB | 2873 | 2026-08-03 ~ 2026-08-17 |
| .config | 80.4 MB | 3839 | 2021-10-17 ~ 2026-10-20 |
| .kimi | 66.1 MB | 468 | 2026-04-27 ~ 2026-07-16 |
| .lingma | 63.0 MB | 2797 | 2026-10-14 ~ 2026-10-14 |
| orca | 56.7 MB | 5013 | 2026-09-03 ~ 2026-09-03 |
| .qoder-cn | 55.6 MB | 8176 | 2026-08-06 ~ 2026-10-13 |

## 4. 缓存与已知大户明细

| 项 | 路径 | 大小 | 文件数 | 时间范围 |
|---|---|---|---|---|
| npm cache | `C:\Users\802165\AppData\Local\npm-cache` | 6.1 GB | 53068 | 2025-03-20 ~ 2026-10-20 |
| pnpm store | `C:\Users\802165\AppData\Local\pnpm\store` | 4.1 GB | 186924 | 2026-06-05 ~ 2026-10-20 |
| pnpm root | `C:\Users\802165\AppData\Local\pnpm` | 4.8 GB | 189325 | 2026-06-05 ~ 2026-10-20 |
| yarn cache | `C:\Users\802165\AppData\Local\Yarn\Cache` | 0 B | 0 | - |
| bun install cache | `C:\Users\802165\.bun\install\cache` | 128.9 MB | 6816 | 2026-05-14 ~ 2026-10-20 |
| uv cache | `C:\Users\802165\AppData\Local\uv` | 981.8 MB | 32853 | 2026-04-07 ~ 2026-10-19 |
| pip cache | `C:\Users\802165\AppData\Local\pip` | 121.0 MB | 200 | 2026-04-18 ~ 2026-09-08 |
| WSL (Packages) | `C:\Users\802165\AppData\Local\Packages` | 823.1 MB | 5685 | 2001-01-01 ~ 2026-10-20 |
| Cursor roaming | `C:\Users\802165\AppData\Roaming\Cursor` | 3.5 GB | 6294 | 2025-07-31 ~ 2026-10-20 |
| Cursor (.cursor) | `C:\Users\802165\.cursor` | 39.4 MB | 4836 | 2026-09-04 ~ 2026-10-20 |
| VS Code roaming | `C:\Users\802165\AppData\Roaming\Code` | 3.4 GB | 12525 | - ~ 2026-10-20 |
| %TEMP% | `C:\Users\802165\AppData\Local\Temp` | 18.4 GB | 153996 | 2012-09-22 ~ 2026-10-20 |
| .claude 其它 | `C:\Users\802165\.claude` | 436.2 MB | 11125 | 2026-05-14 ~ 2026-10-20 |
| .cache | `C:\Users\802165\.cache` | 7.2 GB | 42176 | 1980-01-01 ~ 2026-10-20 |
| @zcodedesktop-updater | `C:\Users\802165\AppData\Local\@zcodedesktop-updater` | 364.2 MB | 5 | 2026-10-19 ~ 2026-10-19 |
| magpie 配置 | `C:\Users\802165\.config\magpie` | 8.6 MB | 146 | 2026-10-12 ~ 2026-10-20 |
| magpie 缓存 | `C:\Users\802165\.cache\magpie` | 185.5 MB | 813 | 2026-10-12 ~ 2026-10-20 |
| zcode cli | `C:\Users\802165\.zcode\cli` | 1.6 GB | 10104 | 2026-08-24 ~ 2026-10-20 |
| zcode v2 | `C:\Users\802165\.zcode\v2` | 1.5 GB | 114 | 2026-06-30 ~ 2026-10-20 |
| Roaming/ZCode | `C:\Users\802165\AppData\Roaming\ZCode` | 483.1 MB | 1268 | 2026-08-24 ~ 2026-10-20 |
| npm (~/.npm) | `C:\Users\802165\.npm` | 0 B | 0 | - |
| pnpm (~/.pnpm-store) | `C:\Users\802165\.pnpm-store` | 0 B | 0 | - |
| gradle caches | `C:\Users\802165\.gradle\caches` | 0 B | 0 | - |
| maven repo | `C:\Users\802165\.m2\repository` | 0 B | 0 | - |
| NuGet packages | `C:\Users\802165\.nuget\packages` | 0 B | 0 | - |
| NuGet cache | `C:\Users\802165\AppData\Local\NuGet` | 0 B | 0 | - |
| Docker (vhdx 所在) | `C:\Users\802165\AppData\Local\Docker` | 0 B | 0 | - |
| WSL (Local/wsl) | `C:\Users\802165\AppData\Local\wsl` | 0 B | 0 | - |
| Windsurf | `C:\Users\802165\AppData\Roaming\Windsurf` | 0 B | 0 | - |
| Trae | `C:\Users\802165\AppData\Roaming\Trae` | 0 B | 0 | - |
| JetBrains local | `C:\Users\802165\AppData\Local\JetBrains` | 0 B | 0 | - |

### 4.1 vhdx 虚拟盘（只报告，不处理）

- 未找到 vhdx/vhd

### 4.2 %TEMP% 按前缀分组 Top 25

| 分组 | 大小 | 文件数 | 最新 mtime |
|---|---|---|---|
| cursor-sandbox-cache | 6.8 GB | 66230 | 2026-10-20 |
| go268-cache | 1.3 GB | 9283 | 2026-10-17 |
| guahub-review | 733.8 MB | 28326 | 2026-10-20 |
| DingTalkUpdate_v4_9.0.1.260920012-9.0.2.261011003 | 732.5 MB | 4275 | 2026-10-11 |
| workbuddy-update-x64 | 474.7 MB | 1 | 2026-10-16 |
| magpie-* | 456.2 MB | 5279 | 2026-10-13 |
| go-build666274766 | 321.4 MB | 78 | 2026-10-13 |
| multica-pg | 296.1 MB | 3750 | 2026-10-14 |
| go-build989869859 | 260.8 MB | 4 | 2026-10-13 |
| go-build4097049461 | 248.3 MB | 8 | 2026-10-12 |
| vscode-stable-user-x64 | 231.8 MB | 3 | 2026-10-15 |
| nsuD073.tmp | 216.3 MB | 1 | 2026-10-11 |
| nsxCCD8.tmp | 216.3 MB | 1 | 2026-09-07 |
| vscode-stable-user-x64-f9nu0z2gti6 | 205.3 MB | 2 | 2026-10-15 |
| vscode-stable-user-x64-73731kz66tr | 205.2 MB | 1 | 2026-10-13 |
| vscode-stable-user-x64-fe7zbl7nmd9 | 205.1 MB | 1 | 2026-10-16 |
| vscode-stable-user-x64-egw59zmz2yq | 205.1 MB | 2 | 2026-10-20 |
| vscode-stable-user-x64-chttn4csv8d | 202.9 MB | 1 | 2026-09-16 |
| vscode-stable-user-x64-o6hxyfbbey | 202.9 MB | 1 | 2026-09-16 |
| vscode-stable-user-x64-wkauriojadd | 202.9 MB | 1 | 2026-09-15 |
| vscode-stable-user-x64-ihjo3hgpn2 | 202.9 MB | 1 | 2026-09-14 |
| vscode-stable-user-x64-juuuxqo0us | 202.9 MB | 1 | 2026-09-14 |
| vscode-stable-user-x64-nbamvbd1wfl | 202.1 MB | 1 | 2026-09-23 |
| vscode-stable-user-x64-lv5ki5ug63b | 202.1 MB | 1 | 2026-09-24 |
| vscode-stable-user-x64-qteyul3anm | 202.0 MB | 1 | 2026-09-22 |

### 4.3 AppData 二级分布（Top 25 每区）

**AppData\Local**

| 目录 | 大小 | 文件数 | 时间范围 |
|---|---|---|---|
| Google | 20.5 GB | 57103 | 1980-01-01 ~ 2026-10-20 |
| go-build | 20.5 GB | 52941 | 2026-08-12 ~ 2026-10-17 |
| Temp | 18.4 GB | 153998 | 2012-09-22 ~ 2026-10-20 |
| npm-cache | 6.1 GB | 53068 | 2025-03-20 ~ 2026-10-20 |
| pnpm | 4.8 GB | 189325 | 2026-06-05 ~ 2026-10-20 |
| Programs | 3.5 GB | 4883 | 2026-04-16 ~ 2026-10-14 |
| pnpm-cache | 2.9 GB | 16203 | 2026-05-08 ~ 2026-10-20 |
| Doubao | 1.7 GB | 15005 | 2012-09-22 ~ 2026-10-17 |
| Factory | 1.6 GB | 166 | 2026-10-12 ~ 2026-10-14 |
| ms-playwright | 1.5 GB | 1559 | 2026-05-22 ~ 2026-10-13 |
| Microsoft | 1.4 GB | 25633 | 2001-01-01 ~ 2026-10-20 |
| OpenAI | 1.1 GB | 3086 | 2026-04-16 ~ 2026-10-17 |
| DingTalk_133 | 1.0 GB | 7177 | 1980-01-01 ~ 2026-10-20 |
| uv | 981.8 MB | 32853 | 2026-04-07 ~ 2026-10-19 |
| kimi-desktop-updater | 846.2 MB | 4 | 2026-10-17 ~ 2026-10-17 |
| Packages | 823.2 MB | 5685 | 2001-01-01 ~ 2026-10-20 |
| env-kit | 679.6 MB | 264 | 2026-09-07 ~ 2026-09-07 |
| MongoDBCompass | 650.6 MB | 349 | 2026-08-24 ~ 2026-08-27 |
| Fork | 555.5 MB | 7539 | 2025-07-02 ~ 2026-10-17 |
| @deepseek-aidsh-desktop-updater | 552.5 MB | 5 | 2026-10-17 ~ 2026-10-17 |
| Qianwen | 534.5 MB | 6592 | 1980-01-01 ~ 2026-09-02 |
| Figma | 514.1 MB | 85 | 2026-09-16 ~ 2026-09-18 |
| DoubaoWork | 436.1 MB | 8046 | 2012-09-22 ~ 2026-08-27 |
| @genieworkbuddy-desktop-updater | 420.7 MB | 1 | 2026-10-19 ~ 2026-10-19 |
| @zcodedesktop-updater | 364.2 MB | 5 | 2026-10-19 ~ 2026-10-19 |

**AppData\LocalLow**

| 目录 | 大小 | 文件数 | 时间范围 |
|---|---|---|---|
| Tencent | 387.6 MB | 134 | ? ~ 2026-10-20 |
| Intel | 92.5 MB | 37 | 2026-04-16 ~ 2026-10-20 |
| Microsoft | 8.5 MB | 632 | 2026-08-27 ~ 2026-10-20 |
| AMD | 0 B | 0 | - |
| MSLiveStickerWhiteList | 0 B | 0 | - |

**AppData\Roaming**

| 目录 | 大小 | 文件数 | 时间范围 |
|---|---|---|---|
| Cursor | 3.5 GB | 6294 | 2025-07-31 ~ 2026-10-20 |
| Code | 3.4 GB | 12525 | - ~ 2026-10-20 |
| npm | 3.2 GB | 66438 | 2026-06-18 ~ 2026-10-20 |
| DingTalk | 2.6 GB | 8622 | 2025-04-23 ~ 2026-10-20 |
| Tencent | 2.6 GB | 4477 | 2026-04-16 ~ 2026-10-20 |
| Codex | 1.9 GB | 2927 | 1980-01-01 ~ 2026-10-20 |
| Notion | 1.5 GB | 21207 | 2026-10-13 ~ 2026-10-20 |
| hubstudio-client | 604.0 MB | 3472 | 1980-01-01 ~ 2026-09-07 |
| dd-doc | 577.9 MB | 5637 | 2026-09-04 ~ 2026-10-20 |
| ZCode | 483.1 MB | 1268 | 2026-08-24 ~ 2026-10-20 |
| QQEX | 429.7 MB | 4037 | 2024-07-01 ~ 2026-08-13 |
| yuque-desktop | 353.9 MB | 1964 | 2026-08-18 ~ 2026-09-08 |
| uv | 256.1 MB | 18019 | 2026-04-07 ~ 2026-10-19 |
| Qoder | 236.5 MB | 407 | 2026-04-16 ~ 2026-10-15 |
| kimi-desktop | 162.7 MB | 2511 | 2026-08-04 ~ 2026-10-17 |
| Antigravity | 143.3 MB | 260 | 2026-04-16 ~ 2026-08-24 |
| orca | 110.9 MB | 348 | 2026-08-17 ~ 2026-09-23 |
| magpie-windows-amd64.exe | 101.8 MB | 585 | 2001-01-01 ~ 2026-10-20 |
| Lingma | 81.8 MB | 184 | 2026-10-14 ~ 2026-10-14 |
| cursor-byok-windows-amd64.exe | 77.3 MB | 439 | 2001-01-01 ~ 2026-08-13 |
| kingsoft | 70.6 MB | 42 | 2026-08-27 ~ 2026-10-20 |
| Figma | 70.5 MB | 371 | 2026-09-18 ~ 2026-09-18 |
| 360DownLoad | 54.2 MB | 1 | 2026-04-16 ~ 2026-04-16 |
| Grok Bot | 53.3 MB | 654 | 2026-09-08 ~ 2026-10-20 |
| Antigravity IDE | 43.8 MB | 209 | 2026-08-17 ~ 2026-08-20 |

