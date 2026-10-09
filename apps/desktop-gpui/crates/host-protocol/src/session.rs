/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Session vocabulary shared by catalog, turn, and subscription payloads.
//!
//! Sources are in `packages/core/src/` unless noted; each enum names the
//! constant its literals come from.

wire_enum! {
    /// `SESSION_STATUSES` (`session.ts`). `review` and `done` are legacy
    /// statuses that `decodeSessionStatus` (`runtime-host/src/protocol/session-status.ts`)
    /// reads as `active`.
    pub enum SessionStatus {
        Active = "active" | "review" | "done",
        Running = "running",
        WaitingForUser = "waiting_for_user",
        Blocked = "blocked",
        Aborted = "aborted",
    }
}

wire_enum! {
    /// `SESSION_BLOCKED_REASONS` (`session.ts`).
    pub enum SessionBlockedReason {
        NoRealConnection = "NO_REAL_CONNECTION",
        Auth = "auth",
        PermissionRequired = "permission_required",
        ToolFailed = "tool_failed",
        Unknown = "unknown",
    }
}

wire_enum! {
    /// `PersistedBackendKind` (`session.ts`): `BackendKind` plus the legacy
    /// `fake` backend that old rows still carry.
    pub enum PersistedBackendKind {
        AiSdk = "ai-sdk",
        PluginExecutor = "plugin-executor",
        Fake = "fake",
    }
}

wire_enum! {
    /// `PERMISSION_MODES` (`permission.ts`).
    pub enum PermissionMode {
        Explore = "explore",
        Ask = "ask",
        Bypass = "bypass",
    }
}

wire_enum! {
    /// `COLLABORATION_MODES` (`collaboration.ts`).
    pub enum CollaborationMode {
        Agent = "agent",
        Plan = "plan",
    }
}

wire_enum! {
    /// `ORCHESTRATION_MODES` (`orchestration.ts`).
    pub enum OrchestrationMode {
        Default = "default",
        Swarm = "swarm",
        Graph = "graph",
    }
}

wire_enum! {
    /// `ThinkingLevel` (`model-thinking.ts`).
    pub enum ThinkingLevel {
        Off = "off",
        Minimal = "minimal",
        Low = "low",
        Medium = "medium",
        High = "high",
        Xhigh = "xhigh",
        Max = "max",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_statuses_read_as_active() {
        for legacy in ["\"review\"", "\"done\""] {
            let status: SessionStatus = serde_json::from_str(legacy).expect("decode");
            assert_eq!(status, SessionStatus::Active);
        }
        assert_eq!(serde_json::to_string(&SessionStatus::Active).expect("encode"), "\"active\"");
    }

    #[test]
    fn blocked_reason_keeps_upper_case_literal() {
        let reason: SessionBlockedReason =
            serde_json::from_str("\"NO_REAL_CONNECTION\"").expect("decode");
        assert_eq!(reason, SessionBlockedReason::NoRealConnection);
    }
}
