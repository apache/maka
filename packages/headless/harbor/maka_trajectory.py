"""Build an ATIF trajectory from Maka's immutable RuntimeEvent JSONL."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Optional


_REDACTED = "[REDACTED]"
_TERMINAL_STATUSES = {"completed", "failed", "aborted", "cancelled"}
_IMAGE_MEDIA_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}
_IMAGE_EXTENSIONS = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_SENSITIVE_KEY_PARTS = {
    "api_key",
    "access_key",
    "access_token",
    "authorization",
    "client_secret",
    "cookie",
    "credential",
    "credentials",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "secret",
}
_SENSITIVE_COMPACT_KEY_PARTS = {
    "apikey",
    "accesskey",
    "accesstoken",
    "authtoken",
    "clientsecret",
    "idtoken",
    "privatekey",
    "refreshtoken",
    "sessiontoken",
}
_QUOTED_FIELD_PATTERN = re.compile(
    r"(?P<key_quote>[\"'])(?P<key>[A-Za-z][A-Za-z0-9_-]*)(?P=key_quote)"
    r"(?P<separator>\s*:\s*)"
    r"(?P<value_quote>[\"'])(?P<value>(?:\\.|[^\\])*?)(?P=value_quote)"
)
_SECRET_PATTERNS = (
    re.compile(
        r"(?im)((?:set-cookie|cookie)\s*:\s*)"
        r"(?:\"[^\"]*\"|'[^']*'|[^\r\n,;]+(?:[;,]\s*[^\r\n,;]+)*)"
    ),
    re.compile(
        r"(?i)((?:authorization|x-api-key|api-key)\s*:\s*)"
        r"(?:\"[^\"]*\"|'[^']*'|(?:bearer\s+|basic\s+)?(?:\"[^\"]*\"|'[^']*'|[^\s,;\"']+))"
    ),
    re.compile(r"(?i)([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+(?=@)"),
    re.compile(
        r"(?i)([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)=)"
        r"[^&#\s]+"
    ),
    re.compile(
        r"(?i)(?<![A-Za-z0-9_])((?:--?(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?key|auth[-_]?token|access[-_]?token|token|cookie|set[-_]?cookie|password|passwd|secret|credentials?|private[-_]?key|refresh[-_]?token|client[-_]?secret))"
        r"(?:\s*[:=]\s*|\s+))(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    ),
    re.compile(
        r"(?im)(^[ \t]*(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|cookie|set-cookie|password|secret)"
        r"\s*:\s*|(?<![A-Za-z0-9_-])(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|cookie|set-cookie|password|secret)"
        r"\s*=\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    ),
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
    ),
    re.compile(
        r"(?i)([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)"
        r"[A-Z0-9_]*\s*=\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    ),
)


@dataclass
class TrajectoryEvidence:
    steps: list[dict[str, Any]]
    artifact_kind: str
    reason: Optional[str]
    terminal_status: Optional[str]
    runtime_event_count: int


@dataclass
class _AgentStep:
    timestamp: Optional[str]
    key: Optional[tuple[str, str, str, str]]
    message_parts: list[str] = field(default_factory=list)
    reasoning_parts: list[str] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    observation_results: list[dict[str, Any]] = field(default_factory=list)
    runtime_event_ids: list[str] = field(default_factory=list)

    def to_step(self, step_id: int) -> dict[str, Any]:
        step: dict[str, Any] = {
            "step_id": step_id,
            "source": "agent",
            "message": "\n".join(part for part in self.message_parts if part),
            "llm_call_count": 1,
        }
        if self.timestamp is not None:
            step["timestamp"] = self.timestamp
        if self.reasoning_parts:
            step["reasoning_content"] = "\n".join(
                part for part in self.reasoning_parts if part
            )
        if self.tool_calls:
            step["tool_calls"] = self.tool_calls
        if self.observation_results:
            step["observation"] = {"results": self.observation_results}
        if self.runtime_event_ids:
            step["extra"] = {"maka_runtime_event_ids": self.runtime_event_ids}
        return redact_value(step)


class _IncompleteTrajectoryEvidence(ValueError):
    pass


_RUNTIME_REF_KEYS = ("invocationId", "runId", "sessionId", "turnId")
_RUNTIME_ACTION_KEYS = {
    "stateDelta",
    "artifactDelta",
    "permissionRequest",
    "permissionDecision",
    "permissionAnswerAccepted",
    "permissionClosureAccepted",
    "userQuestionRequest",
    "userQuestionAnswerAccepted",
    "transferToAgent",
    "endInvocation",
    "tokenUsage",
    "toolDispatch",
    "toolRecovery",
    "runtimeProtocol",
}
_RUNTIME_EVENT_REF_KEYS = {
    "storedMessageId",
    "traceEventId",
    "toolCallId",
    "providerEventId",
    "providerRequestTraceId",
    "artifactId",
    "operationId",
    "stepId",
    "sourceInvocationId",
    "sourceRunId",
    "sourceTurnId",
    "sourceRuntimeEventHighWater",
}
# These value constraints mirror Core's RuntimeEvent decoder. The shared
# accept/reject corpus exercises both implementations at their public boundary.
_TOOL_CATEGORIES = {
    "read",
    "web_read",
    "file_write",
    "fs_destructive",
    "shell_safe",
    "shell_unsafe",
    "git_destructive",
    "network_send",
    "privileged",
    "browser",
    "computer_use",
    "custom_tool",
    "subagent",
}
_TOOL_PERMISSION_REASONS = {
    "shell_dangerous",
    "file_write",
    "fs_destructive",
    "network",
    "git_destructive",
    "privileged",
    "browser",
    "computer_use",
    "custom",
}
_TOOL_RECOVERY_MODES = {
    "replay_safe",
    "idempotent",
    "reconcile",
    "reattach",
    "never_auto_retry",
}
_PREFIX_CHANGE_REASONS = {
    "first_turn",
    "system_prompt_changed",
    "tool_schema_changed",
    "provider_options_changed",
    "model_or_provider_changed",
    "history_projection_changed",
    "stable",
    "unknown",
}
_TOKEN_USAGE_NUMBER_KEYS = {
    "cacheHitInput",
    "cacheMissInput",
    "cacheWriteInput",
    "reasoning",
    "total",
    "runtimeSteps",
    "cacheRead",
    "cacheCreation",
    "costUsd",
    "contextRemaining",
}
_TOKEN_USAGE_KEYS = {
    "input",
    "output",
    *_TOKEN_USAGE_NUMBER_KEYS,
    "cacheMissInputSource",
    "rawFinishReason",
    "systemPromptHash",
    "prefixHash",
    "prefixChangeReason",
    "requestShapeHash",
    "requestShapeChangeReason",
    "promptSegments",
    "contextBudget",
}
_CONTEXT_BUDGET_REQUIRED_KEYS = {
    "enabled",
    "estimatedTokensBefore",
    "estimatedTokensAfter",
    "keptTurns",
    "droppedTurns",
    "keptEvents",
    "droppedEvents",
}
_CONTEXT_BUDGET_NUMBER_KEYS = {
    "maxHistoryEstimatedTokens",
    "maxHistoryTurns",
    "prunedToolResults",
    "prunedToolResultEstimatedTokensBefore",
    "prunedToolResultEstimatedTokensAfter",
    "archivePlaceholders",
    "archiveWriteFailures",
    "unarchivedToolResults",
    "activePrunedToolResults",
    "activeArchiveFailures",
    "activeEstimatedTokensSaved",
    "archiveRetrievalEligibleTurns",
    "retrievedArchiveToolResults",
    "retrievedArchiveEstimatedTokens",
    "archiveRetrievalSkipped",
    "archiveRetrievalFailures",
    "historySearchMatches",
    "historyAroundRetrievedEvents",
    "historyAroundEstimatedTokens",
    "historyAroundSkippedEvents",
    "synthesisCacheBlocksLoaded",
    "synthesisCacheLoadSkipped",
    "synthesisCacheLoadFailures",
    "synthesisCacheBlocksAvailable",
    "synthesisCacheBlocksSelected",
    "synthesisCacheEstimatedTokens",
    "synthesisCacheSkipped",
    "synthesisCacheInvalidated",
    "synthesisCacheWritesAttempted",
    "synthesisCacheBlocksWritten",
    "synthesisCacheWriteEstimatedTokens",
    "synthesisCacheWriteSkipped",
    "synthesisCacheWriteFailures",
    "synthesisCacheEvicted",
    "historyCompactBlocksLoaded",
    "historyCompactLoadSkipped",
    "historyCompactLoadFailures",
    "historyCompactBlocksAvailable",
    "historyCompactBlocksSelected",
    "historyCompactedTurns",
    "historyCompactedEvents",
    "historyCompactedEstimatedTokensBefore",
    "historyCompactedEstimatedTokensAfter",
    "historyCompactSkipped",
    "historyCompactWritesAttempted",
    "historyCompactBlocksWritten",
    "historyCompactWriteEstimatedTokens",
    "historyCompactWriteSkipped",
    "historyCompactWriteFailures",
    "highWaterSeq",
}
_CONTEXT_BUDGET_REASON_COUNT_KEYS = {
    "archivePlaceholderReasonCounts",
    "archiveRetrievalSkippedReasonCounts",
    "archiveRetrievalFailureReasonCounts",
    "synthesisCacheLoadSkippedReasonCounts",
    "synthesisCacheSkippedReasonCounts",
    "synthesisCacheInvalidationReasonCounts",
    "synthesisCacheWriteSkippedReasonCounts",
    "synthesisCacheEvictionReasonCounts",
    "historyCompactLoadSkippedReasonCounts",
    "historyCompactSkippedReasonCounts",
    "historyCompactWriteSkippedReasonCounts",
}
_CONTEXT_BUDGET_STRING_LIST_KEYS = {
    "synthesisCacheBlockIds",
    "synthesisCacheWrittenBlockIds",
    "historyCompactBlockIds",
    "historyCompactCoverageHashes",
    "historyCompactWrittenBlockIds",
}
_CONTEXT_BUDGET_KEYS = _CONTEXT_BUDGET_REQUIRED_KEYS | _CONTEXT_BUDGET_NUMBER_KEYS | (
    _CONTEXT_BUDGET_REASON_COUNT_KEYS
    | _CONTEXT_BUDGET_STRING_LIST_KEYS
    | {
        "policyName",
        "semanticCompactEnabled",
        "semanticCompactMode",
        "compactionDecisions",
        "archiveRetrievalMode",
        "synthesisCacheEnabled",
        "synthesisCacheMode",
        "historyCompactEnabled",
        "historyCompactMode",
        "highWaterName",
        "highWaterReason",
        "highWaterRequestShapeHashBefore",
        "highWaterRequestShapeHashAfter",
        "historyRewriteVersion",
        "historyRewriteResetReason",
        "historyRewriteGate",
    }
)
_COMPACTION_DECISION_REQUIRED_KEYS = {"stage", "sourceKind", "decision"}
_COMPACTION_DECISION_NUMBER_KEYS = {
    "coveredTurns",
    "coveredRuntimeEvents",
    "coveredToolCalls",
    "coveredProviderMessages",
    "estimatedTokensBefore",
    "estimatedTokensAfter",
    "estimatedTokensSaved",
    "candidateEstimatedTokens",
    "preservedHeadEstimatedTokens",
    "preservedTailEstimatedTokens",
    "acceptedProjectionEstimatedTokens",
    "compactCallInputTokens",
    "compactCallOutputTokens",
    "compactCallCacheReadInputTokens",
    "compactCallCacheWriteInputTokens",
    "compactCallTotalTokens",
}
_COMPACTION_DECISION_KEYS = _COMPACTION_DECISION_REQUIRED_KEYS | (
    _COMPACTION_DECISION_NUMBER_KEYS
    | {
        "phase",
        "boundaryKind",
        "boundaryIds",
        "coveredTurns",
        "coveredRuntimeEvents",
        "coveredToolCalls",
        "coveredProviderMessages",
        "coverageHashes",
        "reason",
        "failOpenReason",
        "skippedReasonCounts",
        "validationReasonCounts",
    }
)
_TOOL_BOUNDARY_PROTOCOL = "t1_after_preflight_v1"
_INTERACTION_ID_MAX_BYTES = 256
_INTERACTION_TOOL_NAME_MAX_BYTES = 256
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class _ImageArtifactResolver:
    def __init__(self, artifact_store_root: Path, trajectory_root: Path):
        self.artifact_root = artifact_store_root / "artifacts"
        self.trajectory_root = trajectory_root
        self._records: Optional[dict[str, dict[str, Any]]] = None

    def resolve(
        self, value: dict[str, Any], event: dict[str, Any]
    ) -> list[dict[str, Any]]:
        mime_type = value.get("mimeType")
        ref = value.get("ref")
        if mime_type not in _IMAGE_MEDIA_TYPES or not isinstance(ref, dict):
            raise _IncompleteTrajectoryEvidence("image_reference_invalid")
        artifact_id = ref.get("relativePath")
        session_id = ref.get("sessionId")
        if (
            ref.get("kind") != "session_file"
            or not isinstance(artifact_id, str)
            or not artifact_id
            or not isinstance(session_id, str)
            or session_id != event.get("sessionId")
        ):
            raise _IncompleteTrajectoryEvidence("image_reference_invalid")

        record = self._artifact_records().get(artifact_id)
        if record is None:
            raise _IncompleteTrajectoryEvidence("image_artifact_missing")
        if (
            record.get("sessionId") != session_id
            or record.get("kind") != "image"
            or record.get("status") != "live"
            or record.get("mimeType") != mime_type
        ):
            raise _IncompleteTrajectoryEvidence("image_artifact_metadata_mismatch")
        relative_path = record.get("relativePath")
        if not isinstance(relative_path, str) or not _is_safe_artifact_path(relative_path):
            raise _IncompleteTrajectoryEvidence("image_artifact_path_invalid")

        try:
            artifact_root = self.artifact_root.resolve(strict=True)
            source = (artifact_root / relative_path).resolve(strict=True)
            trajectory_root = self.trajectory_root.resolve(strict=True)
            source.relative_to(artifact_root)
        except (OSError, RuntimeError, ValueError):
            raise _IncompleteTrajectoryEvidence("image_artifact_unavailable") from None
        size_bytes = record.get("sizeBytes")
        try:
            content_matches = (
                source.is_file()
                and isinstance(size_bytes, int)
                and not isinstance(size_bytes, bool)
                and size_bytes >= 0
                and source.stat().st_size == size_bytes
                and _sniff_image_media_type(source) == mime_type
            )
        except OSError:
            content_matches = False
        if not content_matches:
            raise _IncompleteTrajectoryEvidence("image_artifact_content_mismatch")
        try:
            assets_root = self.trajectory_root / "trajectory-assets"
            assets_root.mkdir(parents=True, exist_ok=True)
            assets_root = assets_root.resolve(strict=True)
            assets_root.relative_to(trajectory_root)
            digest = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()
            filename = f"{digest}{_IMAGE_EXTENSIONS[mime_type]}"
            target = assets_root / filename
            temporary_fd, temporary_name = tempfile.mkstemp(
                dir=assets_root, prefix=f".{filename}.", suffix=".tmp"
            )
            os.close(temporary_fd)
            temporary_target = Path(temporary_name)
            try:
                shutil.copyfile(source, temporary_target)
                if _sniff_image_media_type(temporary_target) != mime_type:
                    raise OSError
                os.replace(temporary_target, target)
            finally:
                try:
                    temporary_target.unlink()
                except FileNotFoundError:
                    pass
            trajectory_path = target.relative_to(trajectory_root).as_posix()
        except (OSError, RuntimeError, ValueError):
            raise _IncompleteTrajectoryEvidence("image_artifact_materialization_failed") from None
        return [
            {
                "type": "image",
                "source": {"media_type": mime_type, "path": trajectory_path},
            }
        ]

    def _artifact_records(self) -> dict[str, dict[str, Any]]:
        if self._records is not None:
            return self._records
        self._records = _read_artifact_records(self.artifact_root.parent)
        return self._records


def load_runtime_trajectory(
    runtime_events_path: Optional[Path],
    fallback_status: Optional[str] = None,
    expected_runtime_refs: Optional[dict[str, Any]] = None,
    artifact_store_root: Optional[Path] = None,
    trajectory_root: Optional[Path] = None,
) -> TrajectoryEvidence:
    if runtime_events_path is None or not runtime_events_path.is_file():
        return summary_trajectory("runtime_events_missing", fallback_status)
    try:
        raw = runtime_events_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return summary_trajectory("runtime_events_unreadable", fallback_status)

    events: list[dict[str, Any]] = []
    try:
        for line in raw.splitlines():
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                return summary_trajectory("runtime_event_not_object", fallback_status)
            events.append(value)
    except (json.JSONDecodeError, RecursionError, UnicodeError):
        return summary_trajectory("runtime_events_invalid_jsonl", fallback_status)
    if not events:
        return summary_trajectory("runtime_events_empty", fallback_status)
    return build_runtime_trajectory(
        events,
        fallback_status,
        expected_runtime_refs,
        artifact_store_root,
        trajectory_root,
    )


def build_runtime_trajectory(
    events: list[dict[str, Any]],
    fallback_status: Optional[str] = None,
    expected_runtime_refs: Optional[dict[str, Any]] = None,
    artifact_store_root: Optional[Path] = None,
    trajectory_root: Optional[Path] = None,
) -> TrajectoryEvidence:
    if not _complete_runtime_refs(expected_runtime_refs):
        return summary_trajectory("runtime_refs_incomplete", fallback_status, len(events))
    ordered_steps: list[Any] = []
    agent_steps_by_key: dict[tuple[str, str, str, str], _AgentStep] = {}
    calls_by_id: dict[tuple[str, str, str, str], _AgentStep] = {}
    response_ids: set[tuple[str, str, str, str]] = set()
    active_legacy_agent_step: Optional[_AgentStep] = None
    terminal_event: Optional[dict[str, Any]] = None
    terminal_status: Optional[str] = None
    saw_user = False
    previous_identity: Optional[tuple[str, str, str, str]] = None
    previous_was_terminal = False
    expected_session_id = expected_runtime_refs["sessionId"]
    image_resolver = (
        _ImageArtifactResolver(artifact_store_root, trajectory_root)
        if artifact_store_root is not None and trajectory_root is not None
        else None
    )

    for event in events:
        if not _is_runtime_event(event):
            return summary_trajectory(
                "runtime_event_schema_invalid", fallback_status, len(events)
            )
        identity = _runtime_identity(event)
        if identity is None or identity[2] != expected_session_id:
            return summary_trajectory(
                "runtime_identity_mismatch", fallback_status, len(events)
            )
        if (
            previous_identity is not None
            and identity != previous_identity
            and not previous_was_terminal
        ):
            return summary_trajectory(
                "runtime_identity_mismatch", fallback_status, len(events)
            )
        previous_identity = identity
        if event.get("partial") is True:
            previous_was_terminal = False
            continue
        status = _terminal_status(event)
        previous_was_terminal = status is not None
        terminal_step = None
        if status is not None:
            terminal_event = event
            terminal_status = status
            terminal_step = _terminal_step(event, status)
            active_legacy_agent_step = None

        content = event.get("content")
        if not isinstance(content, dict):
            if terminal_step is not None:
                ordered_steps.append(terminal_step)
            continue
        kind = content.get("kind")
        role = event.get("role")

        if role == "user" and kind == "text":
            text = content.get("text")
            if not isinstance(text, str):
                return summary_trajectory(
                    "invalid_user_text", fallback_status, len(events)
                )
            extra: dict[str, Any] = {"maka_runtime_event_id": _event_id(event)}
            if "displayText" in content:
                extra["maka_display_text"] = redact_value(content["displayText"])
            if "origin" in content:
                extra["maka_origin"] = redact_value(content["origin"])
            if "attachments" in content:
                extra["maka_attachments"] = redact_value(content["attachments"])
            if "quotes" in content:
                extra["maka_quotes"] = redact_value(content["quotes"])
            if content.get("steering") is True:
                extra["maka_steering"] = True
            step: dict[str, Any] = {
                "source": "user",
                "message": redact_text(text),
                "extra": extra,
            }
            timestamp = _timestamp(event)
            if timestamp is not None:
                step["timestamp"] = timestamp
            ordered_steps.append(step)
            saw_user = True
            active_legacy_agent_step = None
            if terminal_step is not None:
                ordered_steps.append(terminal_step)
            continue

        if role == "model" and kind in {"text", "thinking", "function_call"}:
            key = _model_step_key(event, kind)
            if key is not None:
                agent_step = agent_steps_by_key.get(key)
                if agent_step is None:
                    agent_step = _AgentStep(timestamp=_timestamp(event), key=key)
                    agent_steps_by_key[key] = agent_step
                    ordered_steps.append(agent_step)
            else:
                agent_step = active_legacy_agent_step
                if agent_step is None:
                    agent_step = _AgentStep(timestamp=_timestamp(event), key=None)
                    ordered_steps.append(agent_step)
            active_legacy_agent_step = agent_step
            agent_step.runtime_event_ids.append(_event_id(event))

            if kind == "text":
                text = content.get("text")
                if not isinstance(text, str):
                    return summary_trajectory(
                        "invalid_model_text", fallback_status, len(events)
                    )
                agent_step.message_parts.append(redact_text(text))
            elif kind == "thinking":
                text = content.get("text")
                if not isinstance(text, str):
                    return summary_trajectory(
                        "invalid_model_thinking", fallback_status, len(events)
                    )
                agent_step.reasoning_parts.append(redact_text(text))
            else:
                call_id = content.get("id")
                name = content.get("name")
                if (
                    not isinstance(call_id, str)
                    or not call_id
                    or not isinstance(name, str)
                    or not name
                ):
                    return summary_trajectory(
                        "invalid_tool_call", fallback_status, len(events)
                    )
                correlation_id = _tool_correlation_id(event, call_id)
                scoped_call_id = _scoped_id(event, correlation_id)
                if scoped_call_id in calls_by_id:
                    return summary_trajectory(
                        "duplicate_tool_call_id", fallback_status, len(events)
                    )
                args = content.get("args")
                arguments = redact_value(args)
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments}
                agent_step.tool_calls.append(
                    {
                        "tool_call_id": correlation_id,
                        "function_name": name,
                        "arguments": arguments,
                        "extra": {
                            "maka_runtime_event_id": _event_id(event),
                            **(
                                {
                                    "maka_provider_options": redact_value(
                                        content["providerOptions"]
                                    )
                                }
                                if "providerOptions" in content
                                else {}
                            ),
                            **(
                                {"maka_provider_tool_call_id": call_id}
                                if call_id != correlation_id
                                else {}
                            ),
                        },
                    }
                )
                calls_by_id[scoped_call_id] = agent_step
            if terminal_step is not None:
                ordered_steps.append(terminal_step)
            continue

        if role == "tool" and kind == "function_response":
            call_id = content.get("id")
            if not isinstance(call_id, str) or not call_id:
                return summary_trajectory(
                    "invalid_tool_response", fallback_status, len(events)
                )
            correlation_id = _tool_correlation_id(event, call_id)
            scoped_call_id = _scoped_id(event, correlation_id)
            agent_step = calls_by_id.get(scoped_call_id)
            if agent_step is None:
                return summary_trajectory(
                    "unpaired_tool_response", fallback_status, len(events)
                )
            if scoped_call_id in response_ids:
                return summary_trajectory(
                    "duplicate_tool_response", fallback_status, len(events)
                )
            response_ids.add(scoped_call_id)
            try:
                observation_content = _observation_content(
                    content.get("result"), event, image_resolver
                )
            except _IncompleteTrajectoryEvidence as exc:
                return summary_trajectory(str(exc), fallback_status, len(events))
            agent_step.observation_results.append(
                {
                    "source_call_id": correlation_id,
                    "content": observation_content,
                    "extra": {
                        "is_error": content.get("isError") is True,
                        "maka_runtime_event_id": _event_id(event),
                        **(
                            {"maka_provider_tool_response_id": call_id}
                            if call_id != correlation_id
                            else {}
                        ),
                        **(
                            {"tool_name": content["name"]}
                            if isinstance(content.get("name"), str) and content["name"]
                            else {}
                        ),
                    },
                }
            )
            agent_step.runtime_event_ids.append(_event_id(event))
            active_legacy_agent_step = None
            if terminal_step is not None:
                ordered_steps.append(terminal_step)
            continue

        if role == "system" and kind == "text":
            step = {
                "source": "system",
                "message": redact_text(content["text"]),
                "extra": {"maka_runtime_event_id": _event_id(event)},
            }
            timestamp = _timestamp(event)
            if timestamp is not None:
                step["timestamp"] = timestamp
            ordered_steps.append(step)
            active_legacy_agent_step = None
        elif role == "system" and kind == "error":
            message = content.get("message")
            if not isinstance(message, str):
                return summary_trajectory(
                    "invalid_runtime_error", fallback_status, len(events)
                )
            step = {
                "source": "system",
                "message": f"Runtime error: {redact_text(message)}",
                "extra": {
                    "maka_runtime_event_id": _event_id(event),
                    **(
                        {"error_code": content["code"]}
                        if isinstance(content.get("code"), str)
                        else {}
                    ),
                    **(
                        {"error_reason": content["reason"]}
                        if isinstance(content.get("reason"), str)
                        else {}
                    ),
                },
            }
            timestamp = _timestamp(event)
            if timestamp is not None:
                step["timestamp"] = timestamp
            ordered_steps.append(redact_value(step))
            active_legacy_agent_step = None
        elif content is not None:
            return summary_trajectory(
                "unsupported_runtime_event_lane", fallback_status, len(events)
            )

        if terminal_step is not None:
            ordered_steps.append(terminal_step)

    if terminal_event is None:
        return summary_trajectory(
            "terminal_event_missing", fallback_status, len(events)
        )
    if not saw_user:
        return summary_trajectory("user_event_missing", fallback_status, len(events))
    if set(calls_by_id) != response_ids:
        return summary_trajectory("tool_response_missing", fallback_status, len(events))

    assert terminal_status is not None
    if fallback_status == "completed" and terminal_status != "completed":
        return summary_trajectory(
            "terminal_status_mismatch", fallback_status, len(events)
        )
    if not _terminal_matches_expected_refs(terminal_event, expected_runtime_refs):
        return summary_trajectory(
            "terminal_identity_mismatch", fallback_status, len(events)
        )

    steps: list[dict[str, Any]] = []
    for index, item in enumerate(ordered_steps, start=1):
        if isinstance(item, _AgentStep):
            steps.append(item.to_step(index))
        else:
            item["step_id"] = index
            steps.append(redact_value(item))
    return TrajectoryEvidence(
        steps=steps,
        artifact_kind="full",
        reason=None,
        terminal_status=terminal_status,
        runtime_event_count=len(events),
    )


def summary_trajectory(
    reason: str,
    fallback_status: Optional[str],
    runtime_event_count: int = 0,
) -> TrajectoryEvidence:
    status = fallback_status if fallback_status in _TERMINAL_STATUSES else "finished"
    return TrajectoryEvidence(
        steps=[
            {
                "step_id": 1,
                "source": "system",
                "message": f"Maka trajectory summary: invocation {status}",
                "extra": {
                    "maka_artifact_kind": "summary",
                    "maka_summary_reason": reason,
                },
            }
        ],
        artifact_kind="summary",
        reason=reason,
        terminal_status=fallback_status
        if fallback_status in _TERMINAL_STATUSES
        else None,
        runtime_event_count=runtime_event_count,
    )


def redact_value(value: Any, depth: int = 0) -> Any:
    if depth > 32:
        return "[REDACTED:MAX_DEPTH]"
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, nested in value.items():
            string_key = str(key)
            if _is_sensitive_key(string_key):
                redacted[string_key] = _REDACTED
            else:
                redacted[string_key] = redact_value(nested, depth + 1)
        return redacted
    if isinstance(value, list):
        return [redact_value(item, depth + 1) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(str(value))


def redact_text(value: str) -> str:
    redacted = _QUOTED_FIELD_PATTERN.sub(_redact_quoted_secret_field, value)
    for pattern in _SECRET_PATTERNS:
        if pattern.groups:
            redacted = pattern.sub(
                lambda match: f"{match.group(1)}{_REDACTED}", redacted
            )
        else:
            redacted = pattern.sub(_REDACTED, redacted)
    return redacted


def _redact_quoted_secret_field(match: re.Match[str]) -> str:
    if not _is_sensitive_key(match.group("key")):
        return match.group(0)
    return (
        f"{match.group('key_quote')}{match.group('key')}{match.group('key_quote')}"
        f"{match.group('separator')}{match.group('value_quote')}"
        f"{_REDACTED}{match.group('value_quote')}"
    )


def _is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key).replace("-", "_").lower()
    compact = normalized.replace("_", "")
    return (
        normalized == "token"
        or normalized.endswith("_token")
        or normalized in _SENSITIVE_KEY_PARTS
        or any(normalized.endswith(f"_{part}") for part in _SENSITIVE_KEY_PARTS)
        or any(compact.endswith(part) for part in _SENSITIVE_COMPACT_KEY_PARTS)
    )


def _model_step_key(
    event: dict[str, Any], kind: Any
) -> Optional[tuple[str, str, str, str]]:
    refs = event.get("refs")
    if not isinstance(refs, dict):
        return None
    candidate = (
        refs.get("stepId") if kind == "function_call" else refs.get("providerEventId")
    )
    return _scoped_id(event, candidate) if isinstance(candidate, str) and candidate else None


def _complete_runtime_refs(value: Any) -> bool:
    return isinstance(value, dict) and all(
        isinstance(value.get(key), str) and bool(value[key]) for key in _RUNTIME_REF_KEYS
    )


def _runtime_identity(event: dict[str, Any]) -> Optional[tuple[str, str, str, str]]:
    if not all(
        isinstance(event.get(key), str) and bool(event[key]) for key in _RUNTIME_REF_KEYS
    ):
        return None
    return tuple(event[key] for key in _RUNTIME_REF_KEYS)  # type: ignore[return-value]


def _is_attachment_ref(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if (
        set(value) != {"kind", "name", "mimeType", "bytes", "ref"}
        or not _is_string_choice(value.get("kind"), {"image", "pdf", "doc", "code", "other"})
        or not isinstance(value.get("name"), str)
        or not isinstance(value.get("mimeType"), str)
        or not _is_nonnegative_safe_integer(value.get("bytes"))
    ):
        return False
    ref = value.get("ref")
    if not isinstance(ref, dict) or not isinstance(ref.get("kind"), str):
        return False
    if ref["kind"] == "session_file":
        return (
            set(ref) == {"kind", "sessionId", "relativePath"}
            and isinstance(ref.get("sessionId"), str)
            and isinstance(ref.get("relativePath"), str)
        )
    if ref["kind"] == "workspace_file":
        return (
            set(ref) == {"kind", "relativePath"}
            and isinstance(ref.get("relativePath"), str)
        )
    if ref["kind"] == "external_file":
        return (
            set(ref) == {"kind", "absolutePath"}
            and isinstance(ref.get("absolutePath"), str)
        )
    return False


def _is_quote_ref(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and set(value) <= {"text", "label", "sourceTurnId"}
        and isinstance(value.get("text"), str)
        and ("label" not in value or isinstance(value["label"], str))
        and ("sourceTurnId" not in value or isinstance(value["sourceTurnId"], str))
    )


def _scoped_id(event: dict[str, Any], value: str) -> tuple[str, str, str, str]:
    return (
        str(event["invocationId"]),
        str(event["runId"]),
        str(event["turnId"]),
        value,
    )


def _tool_correlation_id(event: dict[str, Any], fallback: str) -> str:
    refs = event.get("refs")
    if not isinstance(refs, dict):
        return fallback
    tool_call_id = refs.get("toolCallId")
    return tool_call_id if isinstance(tool_call_id, str) and tool_call_id else fallback


def _is_runtime_event(event: dict[str, Any]) -> bool:
    allowed_keys = {
        "id",
        "invocationId",
        "runId",
        "sessionId",
        "turnId",
        "ts",
        "branch",
        "partial",
        "role",
        "author",
        "status",
        "content",
        "actions",
        "refs",
    }
    if set(event) - allowed_keys:
        return False
    if not all(
        isinstance(event.get(key), str) and bool(event[key])
        for key in ("id", "invocationId", "runId", "sessionId", "turnId")
    ):
        return False
    timestamp = event.get("ts")
    if not _is_finite_number(timestamp):
        return False
    if not isinstance(event.get("partial"), bool):
        return False
    if not _is_string_choice(event.get("role"), {"user", "model", "tool", "system"}):
        return False
    if not _is_string_choice(
        event.get("author"), {"user", "host", "agent", "tool", "system"}
    ):
        return False
    if "branch" in event and not isinstance(event["branch"], str):
        return False
    if "status" in event and not _is_string_choice(
        event["status"], _TERMINAL_STATUSES | {"streaming"}
    ):
        return False
    if "actions" in event and not _is_runtime_actions(event["actions"]):
        return False
    if "refs" in event and not _is_runtime_refs(event["refs"]):
        return False
    return "content" not in event or _is_runtime_content(event["content"])


def _is_runtime_actions(actions: Any) -> bool:
    if not isinstance(actions, dict) or set(actions) - _RUNTIME_ACTION_KEYS:
        return False
    if "permissionClosureAccepted" in actions and set(actions) != {"permissionClosureAccepted"}:
        return False
    return (
        ("stateDelta" not in actions or isinstance(actions["stateDelta"], dict))
        and (
            "artifactDelta" not in actions
            or _is_runtime_artifact_delta(actions["artifactDelta"])
        )
        and (
            "permissionRequest" not in actions
            or _is_permission_request(actions["permissionRequest"])
        )
        and (
            "permissionDecision" not in actions
            or _is_permission_decision(actions["permissionDecision"])
        )
        and (
            "permissionAnswerAccepted" not in actions
            or _is_answer_accepted(actions["permissionAnswerAccepted"])
        )
        and (
            "permissionClosureAccepted" not in actions
            or _is_permission_closure(actions["permissionClosureAccepted"])
        )
        and (
            "userQuestionRequest" not in actions
            or _is_user_question_request(actions["userQuestionRequest"])
        )
        and (
            "userQuestionAnswerAccepted" not in actions
            or _is_answer_accepted(actions["userQuestionAnswerAccepted"])
        )
        and (
            "transferToAgent" not in actions
            or isinstance(actions["transferToAgent"], str)
        )
        and (
            "endInvocation" not in actions
            or isinstance(actions["endInvocation"], bool)
        )
        and (
            "tokenUsage" not in actions
            or _is_runtime_token_usage(actions["tokenUsage"])
        )
        and (
            "toolDispatch" not in actions
            or _is_runtime_tool_dispatch(actions["toolDispatch"])
        )
        and (
            "toolRecovery" not in actions
            or _is_tool_recovery_fact(actions["toolRecovery"])
        )
        and (
            "runtimeProtocol" not in actions
            or _is_runtime_protocol(actions["runtimeProtocol"])
        )
    )


def _is_runtime_artifact_delta(value: Any) -> bool:
    return isinstance(value, dict) and all(
        isinstance(item, (str, bool)) or _is_finite_number(item)
        for item in value.values()
    )


def _is_permission_request(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    common = (
        isinstance(value.get("requestId"), str)
        and isinstance(value.get("toolUseId"), str)
        and isinstance(value.get("toolName"), str)
        and _is_string_choice(value.get("category"), _TOOL_CATEGORIES)
    )
    if not common:
        return False
    if value.get("kind") == "tool_permission":
        return (
            _has_exact_shape(
                value,
                {
                    "kind",
                    "requestId",
                    "toolUseId",
                    "toolName",
                    "category",
                    "reason",
                    "args",
                    "rememberForTurnAllowed",
                },
                {"hint"},
            )
            and _is_string_choice(value.get("reason"), _TOOL_PERMISSION_REASONS)
            and isinstance(value.get("rememberForTurnAllowed"), bool)
            and _is_optional_string(value, "hint")
        )
    if value.get("kind") == "additional_permissions":
        return (
            _has_exact_shape(
                value,
                {
                    "kind",
                    "requestId",
                    "toolUseId",
                    "toolName",
                    "category",
                    "reason",
                    "additionalPermissions",
                    "cwd",
                    "justification",
                    "intentHash",
                    "permissionsHash",
                    "risk",
                    "alsoApprovesToolExecution",
                    "availableDecisions",
                },
                {"hint"},
            )
            and value.get("reason") == "additional_permissions"
            and _is_additional_permission_profile(value.get("additionalPermissions"))
            and _has_boolean_shape(
                value.get("risk"),
                {"outsideWorkspace", "protectedMetadata", "networkEnabled"},
            )
            and all(
                isinstance(value.get(key), str)
                for key in ("cwd", "justification", "intentHash", "permissionsHash")
            )
            and isinstance(value.get("alsoApprovesToolExecution"), bool)
            and value.get("availableDecisions") == ["allow_once", "deny"]
            and _is_optional_string(value, "hint")
        )
    return (
        value.get("kind") == "sandbox_escalation"
        and _has_exact_shape(
            value,
            {
                "kind",
                "requestId",
                "toolUseId",
                "toolName",
                "category",
                "reason",
                "command",
                "cwd",
                "justification",
                "intentHash",
                "commandHash",
                "trigger",
                "risk",
                "alsoApprovesToolExecution",
                "availableDecisions",
            },
            {"hint"},
        )
        and value.get("toolName") == "Bash"
        and value.get("reason") == "sandbox_escalation"
        and all(
            isinstance(value.get(key), str)
            for key in ("command", "cwd", "justification", "intentHash", "commandHash")
        )
        and _is_string_choice(value.get("trigger"), {"proactive", "sandbox_denial"})
        and _has_true_shape(
            value.get("risk"),
            {
                "unsandboxedExecution",
                "unrestrictedFileSystem",
                "unrestrictedNetwork",
                "protectedMetadataExposed",
            },
        )
        and isinstance(value.get("alsoApprovesToolExecution"), bool)
        and value.get("availableDecisions") == ["allow_once", "deny"]
        and _is_optional_string(value, "hint")
    )


def _is_additional_permission_profile(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) - {"fileSystem", "network"}:
        return False
    file_system = value.get("fileSystem")
    network = value.get("network")
    entries: list[Any] = []
    if "fileSystem" in value:
        if not _has_exact_shape(file_system, {"entries"}) or not isinstance(
            file_system.get("entries"), list
        ):
            return False
        entries = file_system["entries"]
        if len(entries) > 32 or not all(_is_additional_permission_entry(item) for item in entries):
            return False
    if "network" in value and not (
        _has_exact_shape(network, {"enabled"}) and network.get("enabled") is True
    ):
        return False
    if not entries and "network" not in value:
        return False
    compacted_entries = _compact_additional_permission_entries(entries)
    normalized: dict[str, Any] = {}
    if compacted_entries:
        normalized["fileSystem"] = {"entries": compacted_entries}
    if "network" in value:
        normalized["network"] = {"enabled": True}
    serialized = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    return _utf8_length(serialized, escaped_lone_surrogates=True) <= 64 * 1024


def _is_additional_permission_entry(value: Any) -> bool:
    if not _has_exact_shape(value, {"path", "access", "scope"}):
        return False
    path = value.get("path")
    return (
        isinstance(path, str)
        and _is_normalized_absolute_path(path)
        and _utf16_length(path) <= 4096
        and _is_string_choice(value.get("access"), {"read", "write"})
        and _is_string_choice(value.get("scope"), {"exact", "subtree"})
    )


def _is_normalized_absolute_path(value: str) -> bool:
    if not value.startswith("/") or "\0" in value or "\\" in value:
        return False
    if len(value) > 1 and value.endswith("/"):
        return False
    return not any(
        index > 0 and segment in {"", ".", ".."}
        for index, segment in enumerate(value.split("/"))
    )


def _compact_additional_permission_entries(entries: list[Any]) -> list[dict[str, str]]:
    compacted: list[dict[str, str]] = []
    for entry in entries:
        if any(_additional_permission_covers(existing, entry) for existing in compacted):
            continue
        compacted = [
            existing
            for existing in compacted
            if not _additional_permission_covers(entry, existing)
        ]
        compacted.append(
            {
                "path": entry["path"],
                "access": entry["access"],
                "scope": entry["scope"],
            }
        )
    return compacted


def _additional_permission_covers(existing: dict[str, str], candidate: dict[str, str]) -> bool:
    if candidate["access"] == "write" and existing["access"] != "write":
        return False
    if existing["scope"] == "exact":
        return candidate["scope"] == "exact" and existing["path"] == candidate["path"]
    root = existing["path"]
    return root == "/" or candidate["path"] == root or candidate["path"].startswith(f"{root}/")


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _is_permission_decision(value: Any) -> bool:
    return (
        _has_exact_shape(
            value,
            {"requestId", "decision"},
            {"rememberForTurn", "reviewer", "rationale", "riskLevel", "toolName"},
        )
        and isinstance(value.get("requestId"), str)
        and _is_string_choice(value.get("decision"), {"allow", "deny"})
        and (
            "rememberForTurn" not in value
            or isinstance(value.get("rememberForTurn"), bool)
        )
        and (
            "reviewer" not in value
            or _is_string_choice(value.get("reviewer"), {"user", "auto_review"})
        )
        and _is_optional_string(value, "rationale")
        and (
            "riskLevel" not in value
            or _is_string_choice(
                value.get("riskLevel"), {"low", "medium", "high", "critical"}
            )
        )
        and (
            "toolName" not in value
            or _is_bounded_nonempty_string(value.get("toolName"), _INTERACTION_TOOL_NAME_MAX_BYTES)
        )
    )


def _is_answer_accepted(value: Any) -> bool:
    return _has_exact_shape(value, {"requestId"}) and _is_bounded_nonempty_string(
        value.get("requestId"), _INTERACTION_ID_MAX_BYTES
    )


def _is_permission_closure(value: Any) -> bool:
    return (
        _has_exact_shape(value, {"requestId", "reason"})
        and _is_bounded_nonempty_string(value.get("requestId"), _INTERACTION_ID_MAX_BYTES)
        and value.get("reason") == "timed_out"
    )


def _is_user_question_request(value: Any) -> bool:
    return (
        _has_exact_shape(value, {"requestId", "toolUseId", "questions"})
        and isinstance(value.get("requestId"), str)
        and isinstance(value.get("toolUseId"), str)
        and isinstance(value.get("questions"), list)
        and all(_is_user_question(item) for item in value["questions"])
    )


def _is_user_question(value: Any) -> bool:
    return (
        _has_exact_shape(value, {"question", "options"})
        and isinstance(value.get("question"), str)
        and isinstance(value.get("options"), list)
        and all(_is_user_question_option(item) for item in value["options"])
    )


def _is_user_question_option(value: Any) -> bool:
    return (
        _has_exact_shape(value, {"label"}, {"description"})
        and isinstance(value.get("label"), str)
        and _is_optional_string(value, "description")
    )


def _is_runtime_token_usage(value: Any) -> bool:
    if not _has_exact_shape(value, {"input", "output"}, _TOKEN_USAGE_KEYS - {"input", "output"}):
        return False
    if not _is_finite_number(value.get("input")) or not _is_finite_number(value.get("output")):
        return False
    if any(key in value and not _is_finite_number(value[key]) for key in _TOKEN_USAGE_NUMBER_KEYS):
        return False
    return (
        (
            "cacheMissInputSource" not in value
            or _is_string_choice(value.get("cacheMissInputSource"), {"explicit", "derived"})
        )
        and all(
            _is_optional_string(value, key)
            for key in ("rawFinishReason", "systemPromptHash", "prefixHash", "requestShapeHash")
        )
        and (
            "prefixChangeReason" not in value
            or _is_string_choice(value.get("prefixChangeReason"), _PREFIX_CHANGE_REASONS)
        )
        and (
            "requestShapeChangeReason" not in value
            or _is_string_choice(value.get("requestShapeChangeReason"), _PREFIX_CHANGE_REASONS)
        )
        and (
            "promptSegments" not in value
            or (
                isinstance(value.get("promptSegments"), list)
                and all(_is_prompt_segment(item) for item in value["promptSegments"])
            )
        )
        and (
            "contextBudget" not in value
            or _is_context_budget(value.get("contextBudget"))
        )
    )


def _is_prompt_segment(value: Any) -> bool:
    return (
        _has_exact_shape(
            value,
            {"kind", "chars", "estimatedTokens"},
            {"messageCount", "eventCount", "toolCount"},
        )
        and _is_string_choice(
            value.get("kind"),
            {"system_prompt", "tool_schema", "prior_history", "current_user", "turn_tail"},
        )
        and _is_finite_number(value.get("chars"))
        and _is_finite_number(value.get("estimatedTokens"))
        and all(
            key not in value or _is_finite_number(value[key])
            for key in ("messageCount", "eventCount", "toolCount")
        )
    )


def _is_context_budget(value: Any) -> bool:
    if not _has_exact_shape(
        value,
        _CONTEXT_BUDGET_REQUIRED_KEYS,
        _CONTEXT_BUDGET_KEYS - _CONTEXT_BUDGET_REQUIRED_KEYS,
    ):
        return False
    if not isinstance(value.get("enabled"), bool):
        return False
    required_numbers = _CONTEXT_BUDGET_REQUIRED_KEYS - {"enabled"}
    if any(not _is_finite_number(value.get(key)) for key in required_numbers):
        return False
    if any(
        key in value and not _is_finite_number(value[key])
        for key in _CONTEXT_BUDGET_NUMBER_KEYS
    ):
        return False
    if any(
        key in value and not _is_string_number_record(value[key])
        for key in _CONTEXT_BUDGET_REASON_COUNT_KEYS
    ):
        return False
    if any(
        key in value and not _is_string_list(value[key])
        for key in _CONTEXT_BUDGET_STRING_LIST_KEYS
    ):
        return False
    if any(
        key in value and not isinstance(value[key], bool)
        for key in (
            "semanticCompactEnabled",
            "synthesisCacheEnabled",
            "historyCompactEnabled",
        )
    ):
        return False
    compaction_decisions = value.get("compactionDecisions")
    return (
        all(
            _is_optional_string(value, key)
            for key in (
                "policyName",
                "highWaterName",
                "highWaterRequestShapeHashBefore",
                "highWaterRequestShapeHashAfter",
                "historyRewriteVersion",
                "historyRewriteResetReason",
                "historyRewriteGate",
            )
        )
        and (
            "semanticCompactMode" not in value
            or _is_string_choice(
                value["semanticCompactMode"],
                {"off", "validate_only", "prepare_step_dry_run", "replace"},
            )
        )
        and (
            "compactionDecisions" not in value
            or (
                isinstance(compaction_decisions, list)
                and all(_is_compaction_decision(item) for item in compaction_decisions)
            )
        )
        and (
            "archiveRetrievalMode" not in value
            or _is_string_choice(
                value["archiveRetrievalMode"], {"eager", "history_search_gated"}
            )
        )
        and (
            "synthesisCacheMode" not in value
            or _is_string_choice(
                value["synthesisCacheMode"],
                {"off", "lookup", "read_write", "write_only", "fallback_archive_retrieval"},
            )
        )
        and (
            "historyCompactMode" not in value
            or _is_string_choice(
                value["historyCompactMode"],
                {"off", "deterministic", "lookup", "read_write"},
            )
        )
        and (
            "highWaterReason" not in value
            or _is_string_choice(
                value["highWaterReason"],
                {
                    "archive_prune",
                    "history_search_gated_retrieval",
                    "synthesis_cache_write",
                    "synthesis_cache_select",
                    "history_compact",
                    "manual_reset",
                    "system_change",
                    "tools_change",
                    "log_rewrite",
                },
            )
        )
    )


def _is_compaction_decision(value: Any) -> bool:
    if not _has_exact_shape(
        value,
        _COMPACTION_DECISION_REQUIRED_KEYS,
        _COMPACTION_DECISION_KEYS - _COMPACTION_DECISION_REQUIRED_KEYS,
    ):
        return False
    if any(
        key in value and not _is_finite_number(value[key])
        for key in _COMPACTION_DECISION_NUMBER_KEYS
    ):
        return False
    return (
        _is_string_choice(value.get("stage"), {"priorReplay", "activeStep"})
        and _is_string_choice(value.get("sourceKind"), {"runtimeEvents", "providerMessages"})
        and _is_string_choice(value.get("decision"), {"unchanged", "replaced", "failedOpen"})
        and (
            "phase" not in value
            or _is_string_choice(value["phase"], {"pre_turn", "mid_turn"})
        )
        and all(
            _is_optional_string(value, key)
            for key in ("boundaryKind", "reason", "failOpenReason")
        )
        and all(
            key not in value or _is_string_list(value[key])
            for key in ("boundaryIds", "coverageHashes")
        )
        and all(
            key not in value or _is_string_number_record(value[key])
            for key in ("skippedReasonCounts", "validationReasonCounts")
        )
    )


def _is_runtime_tool_dispatch(value: Any) -> bool:
    return (
        _has_exact_shape(
            value,
            {
                "protocol",
                "operationId",
                "providerToolCallId",
                "toolName",
                "canonicalArgsHash",
                "recoveryMode",
            },
        )
        and value.get("protocol") == _TOOL_BOUNDARY_PROTOCOL
        and all(
            isinstance(value.get(key), str)
            for key in ("operationId", "providerToolCallId", "toolName", "canonicalArgsHash")
        )
        and _is_string_choice(value.get("recoveryMode"), _TOOL_RECOVERY_MODES)
    )


def _is_runtime_protocol(value: Any) -> bool:
    return _has_exact_shape(value, {"toolBoundary"}) and value.get(
        "toolBoundary"
    ) == _TOOL_BOUNDARY_PROTOCOL


def _is_tool_recovery_fact(value: Any) -> bool:
    if (
        not _has_exact_shape(value, {"kind", "version", "payload"})
        or isinstance(value.get("version"), bool)
        or value.get("version") != 1
    ):
        return False
    payload = value.get("payload")
    if value.get("kind") == "maka.tool.reconcile_result":
        return _is_tool_reconcile_result(payload)
    return value.get("kind") == "maka.tool.recovery_decision" and _is_tool_recovery_decision(
        payload
    )


def _is_tool_reconcile_result(value: Any) -> bool:
    return (
        _has_exact_shape(
            value,
            {"protocol", "operationId", "observation", "observationSchema", "observationDigest"},
        )
        and value.get("protocol") == "tool_reconcile_v1"
        and _is_nonempty_string(value.get("operationId"))
        and _is_string_choice(
            value.get("observation"),
            {"matches_expected_state", "matches_prior_state", "diverged", "unreadable"},
        )
        and value.get("observationSchema") == "state_identity_v1"
        and isinstance(value.get("observationDigest"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", value["observationDigest"]) is not None
    )


def _is_tool_recovery_decision(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    evidence_ids = value.get("evidenceEventIds")
    if not (
        value.get("protocol") == "tool_recovery_v1"
        and _is_nonempty_string(value.get("operationId"))
        and isinstance(evidence_ids, list)
        and bool(evidence_ids)
        and all(_is_nonempty_string(item) for item in evidence_ids)
        and len(set(evidence_ids)) == len(evidence_ids)
    ):
        return False
    if value.get("disposition") == "completed":
        return (
            _has_exact_shape(
                value,
                {
                    "protocol",
                    "operationId",
                    "disposition",
                    "reasonCode",
                    "outcomeEventId",
                    "evidenceEventIds",
                },
            )
            and value.get("reasonCode") == "reconcile_matches_expected_state"
            and _is_nonempty_string(value.get("outcomeEventId"))
        )
    return (
        value.get("disposition") == "parked"
        and _has_exact_shape(
            value,
            {"protocol", "operationId", "disposition", "reasonCode", "evidenceEventIds"},
        )
        and _is_string_choice(
            value.get("reasonCode"),
            {"reconcile_matches_prior_state", "reconcile_diverged", "reconcile_unreadable"},
        )
    )


def _has_exact_shape(value: Any, required: set[str], optional: set[str] | None = None) -> bool:
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return required <= keys <= required | (optional or set())


def _has_boolean_shape(value: Any, keys: set[str]) -> bool:
    return _has_exact_shape(value, keys) and all(isinstance(value[key], bool) for key in keys)


def _has_true_shape(value: Any, keys: set[str]) -> bool:
    return _has_exact_shape(value, keys) and all(value[key] is True for key in keys)


def _is_optional_string(value: dict[str, Any], key: str) -> bool:
    return key not in value or isinstance(value[key], str)


def _is_bounded_nonempty_string(value: Any, max_bytes: int) -> bool:
    return _is_nonempty_string(value) and _utf8_length(value) <= max_bytes


def _utf8_length(value: str, *, escaped_lone_surrogates: bool = False) -> int:
    length = 0
    index = 0
    while index < len(value):
        code_point = ord(value[index])
        if code_point <= 0x7F:
            length += 1
        elif code_point <= 0x7FF:
            length += 2
        elif 0xD800 <= code_point <= 0xDBFF:
            if index + 1 < len(value) and 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                length += 4
                index += 1
            else:
                length += 6 if escaped_lone_surrogates else 3
        elif 0xDC00 <= code_point <= 0xDFFF:
            length += 6 if escaped_lone_surrogates else 3
        elif code_point <= 0xFFFF:
            length += 3
        else:
            length += 4
        index += 1
    return length


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _is_string_choice(value: Any, choices: set[str]) -> bool:
    return isinstance(value, str) and value in choices


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_string_number_record(value: Any) -> bool:
    return isinstance(value, dict) and all(_is_finite_number(item) for item in value.values())


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _is_nonnegative_safe_integer(value: Any) -> bool:
    return (
        _is_finite_number(value)
        and value == math.trunc(value)
        and 0 <= value <= _MAX_SAFE_INTEGER
    )


def _is_runtime_refs(refs: Any) -> bool:
    if not isinstance(refs, dict) or set(refs) - _RUNTIME_EVENT_REF_KEYS:
        return False
    string_refs = _RUNTIME_EVENT_REF_KEYS - {"sourceRuntimeEventHighWater"}
    if any(key in refs and not isinstance(refs[key], str) for key in string_refs):
        return False
    if "sourceRuntimeEventHighWater" not in refs:
        return True
    return _is_nonnegative_safe_integer(refs["sourceRuntimeEventHighWater"])


def _is_runtime_content(content: Any) -> bool:
    if not isinstance(content, dict):
        return False
    kind = content.get("kind")
    if kind == "text":
        return (
            set(content) <= {
                "kind",
                "text",
                "displayText",
                "origin",
                "attachments",
                "quotes",
                "steering",
                "providerOptions",
            }
            and isinstance(content.get("text"), str)
            and ("displayText" not in content or isinstance(content["displayText"], str))
            and ("origin" not in content or _is_turn_origin(content["origin"]))
            and ("attachments" not in content or (
                isinstance(content["attachments"], list)
                and all(_is_attachment_ref(item) for item in content["attachments"])
            ))
            and ("quotes" not in content or (
                isinstance(content["quotes"], list)
                and all(_is_quote_ref(item) for item in content["quotes"])
            ))
            and ("steering" not in content or content["steering"] is True)
            and (
                "providerOptions" not in content
                or isinstance(content["providerOptions"], dict)
            )
        )
    if kind == "thinking":
        return (
            set(content) <= {"kind", "text", "signature", "providerOptions"}
            and isinstance(content.get("text"), str)
            and ("signature" not in content or isinstance(content["signature"], str))
            and (
                "providerOptions" not in content
                or isinstance(content["providerOptions"], dict)
            )
        )
    if kind == "function_call":
        return (
            set(content)
            <= {
                "kind",
                "id",
                "name",
                "args",
                "providerOptions",
                "providerExecuted",
            }
            and isinstance(content.get("id"), str)
            and isinstance(content.get("name"), str)
            and "args" in content
            and (
                "providerOptions" not in content
                or isinstance(content["providerOptions"], dict)
            )
            and (
                "providerExecuted" not in content
                or isinstance(content["providerExecuted"], bool)
            )
        )
    if kind == "function_response":
        return (
            set(content)
            <= {
                "kind",
                "id",
                "name",
                "result",
                "isError",
                "providerExecuted",
                "providerOutput",
            }
            and isinstance(content.get("id"), str)
            and isinstance(content.get("name"), str)
            and "result" in content
            and ("isError" not in content or isinstance(content["isError"], bool))
            and (
                "providerExecuted" not in content
                or isinstance(content["providerExecuted"], bool)
            )
        )
    if kind == "error":
        return (
            set(content) <= {"kind", "code", "reason", "message", "details"}
            and isinstance(content.get("message"), str)
            and ("code" not in content or isinstance(content["code"], str))
            and ("reason" not in content or isinstance(content["reason"], str))
            and (
                "details" not in content
                or isinstance(content["details"], dict)
                or (
                    isinstance(content["details"], list)
                    and all(isinstance(item, str) for item in content["details"])
                )
            )
        )
    return False


def _is_turn_origin(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("kind") == "automation":
        return set(value) == {"kind", "automationId"} and isinstance(
            value.get("automationId"), str
        )
    return (
        value.get("kind") == "agent_graph"
        and set(value) == {"kind", "graphId", "wakeId", "attemptId"}
        and all(
            isinstance(value.get(key), str)
            for key in ("graphId", "wakeId", "attemptId")
        )
    )


def _terminal_status(event: dict[str, Any]) -> Optional[str]:
    status = event.get("status")
    if status in _TERMINAL_STATUSES:
        return str(status)
    actions = event.get("actions")
    if isinstance(actions, dict) and actions.get("endInvocation") is True:
        return "completed"
    return None


def _terminal_matches_expected_refs(
    terminal_event: dict[str, Any],
    expected_runtime_refs: Optional[dict[str, Any]],
) -> bool:
    if not _complete_runtime_refs(expected_runtime_refs):
        return False
    return _runtime_identity(terminal_event) == tuple(
        expected_runtime_refs[key] for key in _RUNTIME_REF_KEYS
    )


def _terminal_step(event: dict[str, Any], status: str) -> dict[str, Any]:
    step: dict[str, Any] = {
        "source": "system",
        "message": f"Maka invocation {status}",
        "extra": {
            "maka_runtime_event_id": _event_id(event),
            "maka_terminal_status": status,
        },
    }
    timestamp = _timestamp(event)
    if timestamp is not None:
        step["timestamp"] = timestamp
    return step


def _observation_content(
    value: Any,
    event: dict[str, Any],
    image_resolver: Optional[_ImageArtifactResolver],
) -> Any:
    if isinstance(value, dict) and value.get("kind") == "image":
        if image_resolver is None:
            raise _IncompleteTrajectoryEvidence("image_artifact_store_missing")
        return image_resolver.resolve(value, event)
    redacted = redact_value(value)
    if isinstance(redacted, str) or redacted is None:
        return redacted
    return json.dumps(
        redacted, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def referenced_image_artifact_paths(
    runtime_events_path: Path,
    artifact_store_root: Path,
) -> list[str]:
    """Return validated artifact-root-relative paths needed by image RuntimeEvents."""
    references: dict[str, tuple[str, str]] = {}
    try:
        for line in runtime_events_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            content = event.get("content") if isinstance(event, dict) else None
            result = content.get("result") if isinstance(content, dict) else None
            if not isinstance(result, dict) or result.get("kind") != "image":
                continue
            ref = result.get("ref")
            if not isinstance(ref, dict) or ref.get("kind") != "session_file":
                raise ValueError
            artifact_id = ref.get("relativePath")
            session_id = ref.get("sessionId")
            mime_type = result.get("mimeType")
            if (
                not isinstance(artifact_id, str)
                or not artifact_id
                or not isinstance(session_id, str)
                or mime_type not in _IMAGE_MEDIA_TYPES
                or session_id != event.get("sessionId")
            ):
                raise ValueError
            reference = (session_id, mime_type)
            if artifact_id in references and references[artifact_id] != reference:
                raise ValueError
            references[artifact_id] = reference

        records = _read_artifact_records(artifact_store_root)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, AttributeError):
        return []

    paths: list[str] = []
    for artifact_id, (session_id, mime_type) in references.items():
        record = records.get(artifact_id)
        relative_path = record.get("relativePath") if isinstance(record, dict) else None
        if (
            not isinstance(relative_path, str)
            or not _is_safe_artifact_path(relative_path)
            or record.get("sessionId") != session_id
            or record.get("kind") != "image"
            or record.get("status") != "live"
            or record.get("mimeType") != mime_type
        ):
            return []
        paths.append(relative_path)
    return paths


def _read_artifact_records(artifact_store_root: Path) -> dict[str, dict[str, Any]]:
    database_path = artifact_store_root / "runtime.sqlite"
    if not database_path.exists():
        raise _IncompleteTrajectoryEvidence("image_artifact_metadata_missing")
    if database_path.is_symlink() or not database_path.is_file():
        raise _IncompleteTrajectoryEvidence("image_artifact_metadata_invalid")

    connection: Optional[sqlite3.Connection] = None
    try:
        canonical_root = artifact_store_root.resolve(strict=True)
        canonical_database = database_path.resolve(strict=True)
        canonical_database.relative_to(canonical_root)
        connection = sqlite3.connect(
            f"{canonical_database.as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise ValueError
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError
        schema = connection.execute(
            "SELECT version FROM operational_schema_migrations WHERE scope = 'artifact'"
        ).fetchone()
        if schema != (1,):
            raise ValueError
        rows = connection.execute(
            """
            SELECT artifact_id, session_id, created_at, status, relative_path, record_json
            FROM artifact_records
            ORDER BY created_at, storage_key
            """
        ).fetchall()
    except (OSError, sqlite3.Error, TypeError, ValueError):
        raise _IncompleteTrajectoryEvidence("image_artifact_metadata_invalid") from None
    finally:
        if connection is not None:
            connection.close()

    records: dict[str, dict[str, Any]] = {}
    try:
        for artifact_id, session_id, created_at, status, relative_path, serialized in rows:
            record = json.loads(serialized)
            record_id = record.get("id") if isinstance(record, dict) else None
            if (
                not isinstance(record_id, str)
                or not record_id
                or record_id in records
                or artifact_id != record_id
                or session_id != record.get("sessionId")
                or created_at != record.get("createdAt")
                or status != record.get("status")
                or relative_path != record.get("relativePath")
            ):
                raise ValueError
            records[record_id] = record
    except (json.JSONDecodeError, TypeError, ValueError):
        raise _IncompleteTrajectoryEvidence("image_artifact_metadata_invalid") from None
    return records


def _is_safe_artifact_path(value: str) -> bool:
    if (
        not value
        or "\\" in value
        or "\x00" in value
        or "//" in value
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
    ):
        return False
    path = PurePosixPath(value)
    return (
        not path.is_absolute()
        and all(part not in {"", ".", ".."} for part in value.split("/"))
        and all(part not in {"", ".", ".."} for part in path.parts)
    )


def _sniff_image_media_type(path: Path) -> Optional[str]:
    try:
        with path.open("rb") as file:
            header = file.read(16)
    except OSError:
        return None
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _event_id(event: dict[str, Any]) -> str:
    value = event.get("id")
    return value if isinstance(value, str) and value else "unknown"


def _timestamp(event: dict[str, Any]) -> Optional[str]:
    value = event.get("ts")
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        return None
    try:
        return (
            datetime.fromtimestamp(value / 1000, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except (OverflowError, OSError, ValueError):
        return None
