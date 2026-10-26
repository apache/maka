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

use crate::RunError;
use maka_agent_facts::event::Invocation;
use maka_event_log::root_store::SessionStore;
use tokio_util::sync::CancellationToken;

/// Host-owned canonical requests pause model progress, not cell execution or
/// client observation. No UI connection, timeout, or second pending counter owns
/// this boundary. The producers/Host remain responsible for committing outcomes.
pub(super) async fn wait_until_clear(
    log: &SessionStore,
    invocation: &Invocation,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    // Subscribe before reading so an answer cannot land in a missed-wakeup gap.
    let mut commits = log.subscribe_session_commits(&invocation.session_id)?;
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let pending = log.pending_interactions(&invocation.session_id).await?;
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        if !pending.iter().any(|record| {
            record.turn_id == invocation.turn_id && record.run_id == invocation.run_id
        }) {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(RunError::Cancelled),
            changed = commits.changed() => changed.map_err(|_| {
                RunError::Internal("interaction commit observation closed".into())
            })?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::interaction::ClosureReason;
    use maka_agent_facts::interaction::InteractionOutcome;
    use maka_agent_facts::interaction::InteractionQuestion;
    use maka_agent_facts::interaction::InteractionRecord;
    use maka_agent_facts::interaction::InteractionRequest;
    use maka_agent_facts::interaction::QuestionOption;
    use std::time::Duration;

    #[tokio::test]
    async fn canonical_wait_is_run_scoped_waits_for_every_outcome_and_cancels_without_answering() {
        let (_directory, root) = crate::test_support::root().await;
        let log = crate::test_support::session(&root, "session").await;
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        for (request_id, run_id) in [("first", "run"), ("second", "run"), ("foreign", "other")] {
            log.establish_interaction(&InteractionRecord {
                session_id: invocation.session_id.clone(),
                turn_id: invocation.turn_id.clone(),
                run_id: run_id.into(),
                request_id: request_id.into(),
                created_at: 1,
                request: InteractionRequest::Question {
                    tool_use_id: request_id.into(),
                    questions: vec![InteractionQuestion {
                        question: "Continue?".into(),
                        options: vec![
                            QuestionOption {
                                label: "Yes".into(),
                                description: None,
                            },
                            QuestionOption {
                                label: "No".into(),
                                description: None,
                            },
                        ],
                    }],
                },
                outcome: None,
            })
            .await
            .unwrap();
        }
        let cancellation = CancellationToken::new();
        let waiting = wait_until_clear(&log, &invocation, &cancellation);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        log.commit_interaction_outcome(
            "first",
            InteractionOutcome::QuestionAnswer {
                answers: vec![Some("Yes".into())],
                committed_at: 2,
            },
        )
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err(),
            "another request still owns the pause"
        );
        log.commit_interaction_outcome(
            "second",
            InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                committed_at: 3,
            },
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(1), &mut waiting)
            .await
            .unwrap()
            .unwrap();
        // An answer committed before subscription is also visible; an unrelated
        // Run in this Session is neither awaited nor mutated.
        wait_until_clear(&log, &invocation, &cancellation)
            .await
            .unwrap();
        let other = Invocation {
            run_id: "other".into(),
            ..invocation.clone()
        };
        let blocked = wait_until_clear(&log, &other, &cancellation);
        tokio::pin!(blocked);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut blocked)
                .await
                .is_err()
        );
        cancellation.cancel();
        assert!(matches!(blocked.await, Err(RunError::Cancelled)));
        assert!(
            log.interaction("foreign")
                .await
                .unwrap()
                .unwrap()
                .outcome
                .is_none()
        );
    }
}
