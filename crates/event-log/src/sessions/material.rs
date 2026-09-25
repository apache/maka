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

use crate::{EventLog, StoreError};
use maka_runtime::tool_call::{RejectionKind, ToolRejection};
use maka_runtime::{
    artifact::content_digest,
    event::{Fact, InvocationOutcome, RuntimeEvent, ToolOutcome},
    model::ModelEvent,
};
use serde_json::{Value, json};
use sqlx::Connection;

// Walk only reverse references of one retired Session, including archive writers.
// UNION deduplicates diamonds; active owners short-circuit the search.
const RETAINED: &str = "
WITH RECURSIVE owners(id) AS (
    VALUES(?1)
    UNION
    SELECT h.session_id FROM owners o
      JOIN event_log e ON e.event_session=o.id
      JOIN session_history_members h ON h.sequence=e.sequence
    UNION
    SELECT h.session_id FROM owners o
      JOIN event_log e ON e.event_session=o.id
      JOIN session_history_members h ON h.archive_sequence=e.sequence
    UNION
    SELECT h.session_id FROM owners o
      JOIN event_log e ON e.event_session=o.id
      JOIN session_revision_sources h ON h.sequence=e.sequence
)
SELECT EXISTS(SELECT 1 FROM owners JOIN session_control ON session_control.id=owners.id)";

#[derive(Debug, PartialEq, Eq)]
pub enum MaterialCollection {
    Done,
    Retained(String),
    Collected,
}

impl EventLog {
    /// One Session and at most eight bodies per writer job. Advance the scan
    /// past Retained Sessions; retry the same cursor after Collected.
    /// Proof, payload retirement and body removal share the canonical writer.
    pub async fn collect_session_material(
        &self,
        after: Option<&str>,
    ) -> Result<MaterialCollection, StoreError> {
        self.validate_root()?;
        let after = after.map(str::to_owned);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let session: Option<String> = sqlx::query_scalar(
                "SELECT DISTINCT e.event_session FROM event_log e INDEXED BY event_material_owner
                 WHERE e.event_json IS NOT NULL AND e.event_session IS NOT NULL
                 AND (?1 IS NULL OR e.event_session>?1) AND (
                   EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=e.event_session
                     AND r.remove_session=1 AND r.completed=1)
                   OR (NOT EXISTS(SELECT 1 FROM session_control WHERE id=e.event_session)
                     AND EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id)))
                 ORDER BY e.event_session LIMIT 1"
            ).bind(after).fetch_optional(&mut *tx).await?;
            let Some(session) = session else {
                tx.rollback().await?;
                let free: i64 = sqlx::query_scalar("PRAGMA freelist_count").fetch_one(&mut *connection).await?;
                if free == 0 { return Ok(MaterialCollection::Done); }
                let incremental: i64 = sqlx::query_scalar("PRAGMA auto_vacuum").fetch_one(&mut *connection).await?;
                if incremental != 2 { return Err(StoreError::UnsupportedDatabase); }
                sqlx::query("PRAGMA incremental_vacuum(128)").execute(connection).await?;
                return Ok(MaterialCollection::Collected);
            };
            // A previously collected body proves this owner set was already
            // released. All owners were removed, so none can publish new copies.
            let released: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM event_log WHERE event_session=? AND event_json IS NULL)"
            ).bind(&session).fetch_one(&mut *tx).await?;
            if !released && sqlx::query_scalar::<_, bool>(RETAINED)
                .bind(&session).fetch_one(&mut *tx).await?
            {
                return Ok(MaterialCollection::Retained(session));
            }
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT event_id, event_json FROM event_log WHERE event_session=?
                 AND event_json IS NOT NULL ORDER BY sequence LIMIT 8"
            ).bind(session).fetch_all(&mut *tx).await?;
            for (id, body) in rows {
                let event: RuntimeEvent = serde_json::from_str(&body)?;
                let proof = retained(&event);
                sqlx::query("DELETE FROM tool_result_payloads WHERE event_id=?")
                    .bind(&id).execute(&mut *tx).await?;
                let surface: Option<String> = sqlx::query_scalar(
                    "DELETE FROM model_request_compositions WHERE event_id=? RETURNING digest"
                ).bind(&id).fetch_optional(&mut *tx).await?;
                if let Some(surface) = surface {
                    sqlx::query("DELETE FROM request_compositions WHERE digest=?1
                        AND NOT EXISTS (SELECT 1 FROM model_request_compositions WHERE digest=?1)")
                        .bind(surface).execute(&mut *tx).await?;
                }
                sqlx::query("UPDATE event_log SET retained_json=?, body_digest=?, event_json=NULL WHERE event_id=?")
                    .bind(serde_json::to_string(&proof)?).bind(content_digest(body.as_bytes()))
                    .bind(&id).execute(&mut *tx).await?;
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(MaterialCollection::Collected)
        })).await
    }
}

/// Minimal original fields used by accounting and terminal proof. This is not
/// a RuntimeEvent and must never enter replay, input projection or recovery.
fn retained(event: &RuntimeEvent) -> Value {
    let fact = match &event.fact {
        Fact::MessageImported { source, .. } => json!({"source":source}),
        Fact::InvocationOpened { configuration, .. } => json!({
            "configuration": configuration.as_ref().map(|config| json!({"model": config.model}))
        }),
        Fact::ModelRequested {
            step_id,
            model_id,
            purpose,
            ..
        } => json!({"step_id":step_id,"model_id":model_id,"purpose":purpose}),
        Fact::ModelCompleted { step_id, output } => {
            json!({"step_id":step_id,"output":{"usage":output.usage}})
        }
        Fact::ModelInterrupted { step_id, status } => json!({"step_id":step_id,"status":status}),
        Fact::ModelObserved {
            step_id,
            event: ModelEvent::Finished { usage, .. },
        } => json!({"step_id":step_id,"event":{"kind":"finished","data":{"usage":usage}}}),
        Fact::ToolDispatched { call, name, .. } => json!({"call":call,"name":name}),
        Fact::ToolRejected {
            call, name, reason, ..
        } => {
            let kind = match reason {
                ToolRejection::Unavailable => RejectionKind::Unavailable,
                ToolRejection::InvalidInput { .. } => RejectionKind::InvalidInput,
                ToolRejection::PolicyDenied { .. } => RejectionKind::PolicyDenied,
                ToolRejection::PreparationFailed { .. } => RejectionKind::PreparationFailed,
                ToolRejection::ExclusiveConflict => RejectionKind::ExclusiveConflict,
                ToolRejection::Cancelled => RejectionKind::Cancelled,
            };
            json!({"call":call,"name":name,"reason":{"kind":kind}})
        }
        Fact::ToolSettled { outcome, .. } => json!({"outcome":{"kind":match outcome {
            ToolOutcome::Succeeded { .. } => "succeeded",
            ToolOutcome::Failed { .. } => "failed",
            ToolOutcome::Unknown { .. } => "unknown",
        }}}),
        Fact::InvocationEnded { outcome } => {
            let outcome = match outcome {
                InvocationOutcome::Completed => json!({"kind":"completed"}),
                InvocationOutcome::Failed { class, .. } => json!({"kind":"failed","class":class}),
                InvocationOutcome::Cancelled { source } => {
                    json!({"kind":"cancelled","source":source})
                }
                InvocationOutcome::HandoffPaused { pause } => {
                    json!({"kind":"handoff_paused","pause":{"intent":pause.intent}})
                }
                InvocationOutcome::ContextCompactFinished { outcome } => {
                    json!({"kind":"context_compact_finished","outcome":outcome})
                }
            };
            json!({"outcome":outcome})
        }
        Fact::ExecutorStarted { .. }
        | Fact::ExecutorObserved { .. }
        | Fact::ExecutorCompleted { .. }
        | Fact::MessageSteered { .. }
        | Fact::ContextCheckpointRecorded { .. }
        | Fact::ToolResultArchived { .. }
        | Fact::ModelObserved { .. }
        | Fact::ToolNotified { .. } => json!({}),
    };
    json!({"id":event.id,"invocation":event.invocation,"recorded_at":event.recorded_at,"fact":fact})
}
