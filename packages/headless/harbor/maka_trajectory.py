"""Build an ATIF trajectory from Maka's immutable RuntimeEvent JSONL."""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
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
        r"(?:bearer\s+|basic\s+)?[^\s,;\"']+"
    ),
    re.compile(r"(?i)([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+(?=@)"),
    re.compile(
        r"(?i)([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)=)"
        r"[^&#\s]+"
    ),
    re.compile(
        r"(?i)((?:--?(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|cookie|set-cookie|password|secret)"
        r"|(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|cookie|set-cookie|password|secret))"
        r"(?:\s+|\s*[:=]\s*))(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
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
        if not source.is_file() or _sniff_image_media_type(source) != mime_type:
            raise _IncompleteTrajectoryEvidence("image_artifact_content_mismatch")
        try:
            assets_root = self.trajectory_root / "trajectory-assets"
            assets_root.mkdir(parents=True, exist_ok=True)
            assets_root = assets_root.resolve(strict=True)
            assets_root.relative_to(trajectory_root)
            digest = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()
            filename = f"{digest}{_IMAGE_EXTENSIONS[mime_type]}"
            target = assets_root / filename
            shutil.copyfile(source, target)
            if _sniff_image_media_type(target) != mime_type:
                raise OSError
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
        metadata_path = self.artifact_root / "metadata.jsonl"
        try:
            raw = metadata_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise _IncompleteTrajectoryEvidence("image_artifact_metadata_missing") from None
        records: dict[str, dict[str, Any]] = {}
        try:
            for line in raw.splitlines():
                if not line.strip():
                    continue
                record = json.loads(line)
                artifact_id = record.get("id") if isinstance(record, dict) else None
                if not isinstance(artifact_id, str) or not artifact_id or artifact_id in records:
                    raise ValueError
                records[artifact_id] = record
        except (json.JSONDecodeError, ValueError):
            raise _IncompleteTrajectoryEvidence("image_artifact_metadata_invalid") from None
        self._records = records
        return records


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
        value.get("kind") not in {"image", "pdf", "doc", "code", "other"}
        or not isinstance(value.get("name"), str)
        or not isinstance(value.get("mimeType"), str)
        or isinstance(value.get("bytes"), bool)
        or not isinstance(value.get("bytes"), int)
        or value.get("bytes") < 0
    ):
        return False
    ref = value.get("ref")
    if not isinstance(ref, dict) or not isinstance(ref.get("kind"), str):
        return False
    if ref["kind"] == "session_file":
        return (
            isinstance(ref.get("sessionId"), str)
            and bool(ref["sessionId"])
            and isinstance(ref.get("relativePath"), str)
            and bool(ref["relativePath"])
        )
    if ref["kind"] == "workspace_file":
        return isinstance(ref.get("relativePath"), str) and bool(ref["relativePath"])
    if ref["kind"] == "external_file":
        return isinstance(ref.get("absolutePath"), str) and bool(ref["absolutePath"])
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
    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, (int, float))
        or not math.isfinite(timestamp)
    ):
        return False
    if not isinstance(event.get("partial"), bool):
        return False
    if event.get("role") not in {"user", "model", "tool", "system"}:
        return False
    if event.get("author") not in {"user", "agent", "tool", "system"}:
        return False
    if "branch" in event and not isinstance(event["branch"], str):
        return False
    if "status" in event and event["status"] not in _TERMINAL_STATUSES | {"streaming"}:
        return False
    if "actions" in event and not isinstance(event["actions"], dict):
        return False
    if "refs" in event and not isinstance(event["refs"], dict):
        return False
    return "content" not in event or _is_runtime_content(event["content"])


def _is_runtime_content(content: Any) -> bool:
    if not isinstance(content, dict):
        return False
    kind = content.get("kind")
    if kind == "text":
        return (
            set(content) <= {"kind", "text", "displayText", "attachments", "quotes", "steering"}
            and isinstance(content.get("text"), str)
            and ("displayText" not in content or isinstance(content["displayText"], str))
            and ("attachments" not in content or (
                isinstance(content["attachments"], list)
                and all(_is_attachment_ref(item) for item in content["attachments"])
            ))
            and ("quotes" not in content or (
                isinstance(content["quotes"], list)
                and all(_is_quote_ref(item) for item in content["quotes"])
            ))
            and ("steering" not in content or content["steering"] is True)
        )
    if kind == "thinking":
        return (
            set(content) <= {"kind", "text", "signature"}
            and isinstance(content.get("text"), str)
            and ("signature" not in content or isinstance(content["signature"], str))
        )
    if kind == "function_call":
        return (
            set(content) <= {"kind", "id", "name", "args"}
            and isinstance(content.get("id"), str)
            and isinstance(content.get("name"), str)
            and "args" in content
        )
    if kind == "function_response":
        return (
            set(content) <= {"kind", "id", "name", "result", "isError"}
            and isinstance(content.get("id"), str)
            and isinstance(content.get("name"), str)
            and "result" in content
            and ("isError" not in content or isinstance(content["isError"], bool))
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
    metadata_path: Path,
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

        records: dict[str, dict[str, Any]] = {}
        for line in metadata_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            artifact_id = record.get("id") if isinstance(record, dict) else None
            if not isinstance(artifact_id, str) or not artifact_id or artifact_id in records:
                raise ValueError
            records[artifact_id] = record
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
