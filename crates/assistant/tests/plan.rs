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

#[path = "support/plan.rs"]
mod support;

use maka_assistant::plan::{Command, Error, Phase, Progress, StepStatus, repository::Repository};
use maka_event_log::EventLog;
use maka_plugins::storage::StoreError;
use std::sync::{Arc, atomic::Ordering};
use support::{Storage, draft, host_receipt, request};

#[tokio::test]
async fn plan_receipts_survive_lost_replies_restart_and_competing_approvals() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let storage = Storage::new(log.clone());
    let repository = Repository::new(storage.clone(), "planner", "session").unwrap();
    let submit = request(
        "propose",
        0,
        Command::Propose {
            turn_id: "planning".into(),
            artifact: draft(),
        },
    );
    storage.lose_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        repository.apply(&submit, 1).await,
        Err(Error::Storage(StoreError::OutcomeUnknown(_)))
    ));
    let proposed = repository.apply(&submit, 2).await.unwrap();
    assert_eq!(proposed.revision, 1);
    assert_eq!(proposed.proposal.as_ref().unwrap().submitted_at, 1);
    let proposal = proposed.proposal.as_ref().unwrap();
    let approval = Command::Approve {
        grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
        proposal_id: proposal.id.clone(),
        proposal_revision: proposal.revision,
        behavior: "example.plan.execute".to_owned().try_into().unwrap(),
    };
    let peer = Repository::new(storage.clone(), "planner", "session").unwrap();
    let a = request("approve_a", 1, approval.clone());
    let b = request("approve_b", 1, approval);
    let (a, b) = tokio::join!(repository.apply(&a, 3), peer.apply(&b, 3));
    let approved = match (a, b) {
        (Ok(state), Err(Error::Conflict)) | (Err(Error::Conflict), Ok(state)) => state,
        other => panic!("exactly one approval must commit: {other:?}"),
    };
    assert!(matches!(
        approved.execution.as_ref().unwrap().phase,
        Phase::AwaitingAdmission
    ));
    assert_eq!(repository.apply(&submit, 4).await.unwrap(), proposed);
    let mut changed = submit.clone();
    changed.command = Command::Propose {
        turn_id: "different_turn".into(),
        artifact: draft(),
    };
    assert!(matches!(
        repository.apply(&changed, 4).await,
        Err(Error::Conflict)
    ));
    for (entry, session) in [("other-entry", "session"), ("planner", "other-session")] {
        let other = Repository::new(storage.clone(), entry, session).unwrap();
        let draft = other.apply(&submit, 4).await.unwrap();
        let proposal = draft.proposal.unwrap();
        let pending = other
            .apply(
                &request(
                    "approve_a",
                    1,
                    Command::Approve {
                        grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
                        proposal_id: proposal.id,
                        proposal_revision: 1,
                        behavior: "example.plan.execute".to_owned().try_into().unwrap(),
                    },
                ),
                4,
            )
            .await
            .unwrap();
        assert_ne!(
            pending.execution.unwrap().request.operation_id,
            approved.execution.as_ref().unwrap().request.operation_id
        );
    }
    drop(peer);
    drop(repository);
    drop(storage);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let storage = Storage::new(log.clone());
    let repository = Repository::new(storage, "planner", "session").unwrap();
    assert_eq!(repository.current().await.unwrap(), approved);
    assert_eq!(repository.receipt(&submit).await.unwrap(), Some(proposed));

    let execution = approved.execution.as_ref().unwrap();
    let id = execution.id.clone();
    let receipt = host_receipt(&approved, "first");
    let mut wrong = receipt.clone();
    wrong.content_digest = "sha256:wrong".into();
    assert!(matches!(
        repository
            .apply(
                &request(
                    "wrong_receipt",
                    2,
                    Command::Accept {
                        execution_id: id.clone(),
                        receipt: wrong,
                    }
                ),
                5
            )
            .await,
        Err(Error::Conflict)
    ));
    let accept = request(
        "accepted",
        2,
        Command::Accept {
            execution_id: id.clone(),
            receipt: receipt.clone(),
        },
    );
    let active = repository.apply(&accept, 5).await.unwrap();
    let interrupted = repository
        .apply(
            &request(
                "interrupted",
                active.revision,
                Command::Interrupt {
                    execution_id: id.clone(),
                    invocation: receipt.invocation.clone(),
                    reason: "Host run interrupted".into(),
                },
            ),
            6,
        )
        .await
        .unwrap();
    let resumed = repository
        .apply(
            &request(
                "resume",
                interrupted.revision,
                Command::Resume {
                    grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
                    execution_id: id.clone(),
                },
            ),
            7,
        )
        .await
        .unwrap();
    assert_ne!(
        resumed.execution.as_ref().unwrap().request.operation_id,
        execution.request.operation_id
    );
    let next_receipt = host_receipt(&resumed, "second");
    let active = repository
        .apply(
            &request(
                "accepted_next",
                resumed.revision,
                Command::Accept {
                    execution_id: id.clone(),
                    receipt: next_receipt.clone(),
                },
            ),
            8,
        )
        .await
        .unwrap();
    let progress = |invocation| Command::Progress {
        execution_id: id.clone(),
        invocation,
        steps: ["implement", "verify"]
            .map(|id| Progress {
                id: id.into(),
                status: StepStatus::Completed,
                note: None,
            })
            .into(),
    };
    assert!(matches!(
        repository
            .apply(
                &request(
                    "stale_progress",
                    active.revision,
                    progress(receipt.invocation)
                ),
                9
            )
            .await,
        Err(Error::Conflict)
    ));
    let completed = repository
        .apply(
            &request(
                "complete",
                active.revision,
                progress(next_receipt.invocation.clone()),
            ),
            10,
        )
        .await
        .unwrap();
    assert!(matches!(
        completed.execution.as_ref().unwrap().phase,
        Phase::Active { .. }
    ));
    let settled = repository
        .apply(
            &request(
                "settle",
                completed.revision,
                Command::Settle {
                    execution_id: id,
                    invocation: next_receipt.invocation,
                    outcome: maka_assistant::plan::Settlement::Completed,
                },
            ),
            11,
        )
        .await
        .unwrap();
    assert!(matches!(
        settled.execution.unwrap().phase,
        Phase::Completed { .. }
    ));
    assert_eq!(repository.apply(&accept, 11).await.unwrap().revision, 3);
    drop(repository);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}
