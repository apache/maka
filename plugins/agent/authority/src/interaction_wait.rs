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

use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_event_log::SessionStore;

pub async fn wait(
    store: &SessionStore,
    expected: &InteractionRecord,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<InteractionOutcome, &'static str> {
    let id = &expected.request_id;
    let mut commits = store
        .subscribe_session_commits(&expected.session_id)
        .map_err(|_| "interaction_store_closed")?;
    loop {
        let record = store
            .interaction(id)
            .await
            .map_err(|_| "interaction_read_unavailable")?
            .ok_or("interaction_missing")?;
        if let Some(outcome) = record.outcome {
            return Ok(outcome);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return store.commit_interaction_outcome(id, InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled, committed_at: crate::now(),
                }).await.map_err(|_| "interaction_closure_unavailable")?.record.outcome.ok_or("interaction_outcome_missing");
            }
            result = commits.changed() => result.map_err(|_| "interaction_store_closed")?,
        }
    }
}
pub async fn withdraw(
    store: &SessionStore,
    expected: &InteractionRecord,
) -> Result<Option<InteractionOutcome>, &'static str> {
    let Some(record) = store
        .interaction(&expected.request_id)
        .await
        .map_err(|_| "interaction_cleanup_unconfirmed")?
    else {
        return Ok(None);
    };
    if record.session_id != expected.session_id
        || record.turn_id != expected.turn_id
        || record.run_id != expected.run_id
        || record.request != expected.request
    {
        return Err("interaction_cleanup_identity_conflict");
    }
    let record = if record.outcome.is_none() {
        store
            .commit_interaction_outcome(
                &record.request_id,
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: crate::now(),
                },
            )
            .await
            .map_err(|_| "interaction_cleanup_unconfirmed")?
            .record
    } else {
        record
    };
    Ok(record.outcome)
}

/// The admitted call retains custody until publication or withdrawal is reconciled.
pub async fn publish(
    store: &SessionStore,
    context: &maka_host_runtime::application::Context,
    invocation: &maka_agent_facts::event::Invocation,
    record: &InteractionRecord,
) -> Result<Option<InteractionOutcome>, String> {
    let mut ticket = context
        .scope()
        .resources
        .reserve()
        .map_err(|e| e.to_string())?;
    ticket.start();
    let result = async {
        let committed = store
            .establish_run_interaction(invocation, record)
            .await
            .map_err(|_| "interaction_publication_unavailable")?;
        if !committed.matches {
            return Err("interaction_identity_conflict");
        }
        wait(store, record, &context.scope().cancellation).await
    }
    .await;
    match result {
        Ok(outcome) => {
            ticket.complete(Ok(()));
            Ok(Some(outcome))
        }
        Err(error) => match withdraw(store, record).await {
            Ok(Some(outcome)) => {
                ticket.complete(Ok(()));
                Ok(Some(outcome))
            }
            Ok(None) => {
                ticket.complete(Ok(()));
                Ok(None)
            }
            Err(cleanup) => {
                ticket.complete(Err(cleanup.into()));
                Err(error.into())
            }
        },
    }
}
