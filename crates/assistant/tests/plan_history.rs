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

use maka_assistant::plan::{
    Command, Error, Phase, ProposalStatus, Snapshot, repository::Repository,
};
use maka_event_log::EventLog;
use std::sync::{Arc, atomic::Ordering};
use support::{Storage, draft, host_receipt, request};

async fn advance(repository: &Repository, state: &mut Snapshot, id: &str, command: Command) {
    *state = repository
        .apply(&request(id, state.revision, command), state.revision + 1)
        .await
        .unwrap();
}
fn approval(state: &Snapshot) -> Command {
    let p = state.proposal.as_ref().unwrap();
    Command::Approve {
        grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
        proposal_id: p.id.clone(),
        proposal_revision: p.revision,
        behavior: Default::default(),
    }
}
async fn rejects(repository: &Repository, state: &Snapshot, command: Command) {
    assert!(matches!(
        repository
            .apply(&request("rejected", state.revision, command), 100)
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(&repository.current().await.unwrap(), state);
}

#[tokio::test]
async fn revisions_replanning_and_admission_recovery_do_not_reuse_stale_authority() {
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&temp.path().join("state.sqlite"))
            .await
            .unwrap(),
    );
    let repository = Repository::new(Storage::new(log.clone()), "planner", "session").unwrap();
    let mut state = Snapshot::default();
    advance(
        &repository,
        &mut state,
        "draft",
        Command::Propose {
            turn_id: "turn".into(),
            artifact: draft(),
        },
    )
    .await;
    let old = state.proposal.clone().unwrap();
    advance(
        &repository,
        &mut state,
        "revise",
        Command::Revise {
            proposal_id: old.id.clone(),
        },
    )
    .await;
    rejects(&repository, &state, approval(&state)).await;
    advance(
        &repository,
        &mut state,
        "draft_2",
        Command::Propose {
            turn_id: "turn_2".into(),
            artifact: draft(),
        },
    )
    .await;
    assert_eq!(
        state.proposal.as_ref().unwrap().supersedes.as_ref(),
        Some(&old.id)
    );
    assert_eq!(state.proposal.as_ref().unwrap().plan_id, old.plan_id);
    rejects(
        &repository,
        &state,
        Command::Approve {
            grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
            proposal_id: old.id,
            proposal_revision: old.revision,
            behavior: Default::default(),
        },
    )
    .await;
    let p = state.proposal.as_ref().unwrap().id.clone();
    advance(
        &repository,
        &mut state,
        "abandon",
        Command::Abandon { proposal_id: p },
    )
    .await;
    assert_eq!(
        state.proposal.as_ref().unwrap().status,
        ProposalStatus::Abandoned
    );
    rejects(&repository, &state, approval(&state)).await;
    advance(
        &repository,
        &mut state,
        "draft_3",
        Command::Propose {
            turn_id: "turn_3".into(),
            artifact: draft(),
        },
    )
    .await;
    let approve = approval(&state);
    advance(&repository, &mut state, "approve", approve).await;
    let execution = state.execution.clone().unwrap();
    let id = execution.id.clone();
    // Pending admission cannot be replanned or assigned a new request.
    for command in [
        Command::Resume {
            grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
            execution_id: id.clone(),
        },
        Command::Propose {
            turn_id: "turn_4".into(),
            artifact: draft(),
        },
        Command::Reject {
            execution_id: id.clone(),
            request_digest: "wrong".into(),
            reason: "refused".into(),
        },
    ] {
        rejects(&repository, &state, command).await;
    }
    advance(
        &repository,
        &mut state,
        "refused",
        Command::Reject {
            execution_id: id.clone(),
            request_digest: execution.request.digest().unwrap(),
            reason: "Host definitively refused admission".into(),
        },
    )
    .await;
    advance(
        &repository,
        &mut state,
        "replan",
        Command::Propose {
            turn_id: "turn_4".into(),
            artifact: draft(),
        },
    )
    .await;
    assert_eq!(
        state
            .proposal
            .as_ref()
            .unwrap()
            .source_execution_id
            .as_ref(),
        Some(&id)
    );
    rejects(
        &repository,
        &state,
        Command::Resume {
            grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
            execution_id: id.clone(),
        },
    )
    .await;
    advance(
        &repository,
        &mut state,
        "cancel_source",
        Command::Cancel {
            grant: None,
            execution_id: id,
            reason: "withdraw original work".into(),
        },
    )
    .await;
    rejects(&repository, &state, approval(&state)).await;
    // A fresh revision can explicitly propose work after its old source is cancelled.
    assert_eq!(
        state.proposal.as_ref().unwrap().status,
        ProposalStatus::RevisionRequested
    );
    advance(
        &repository,
        &mut state,
        "fresh",
        Command::Propose {
            turn_id: "turn_5".into(),
            artifact: draft(),
        },
    )
    .await;
    assert!(
        state
            .proposal
            .as_ref()
            .unwrap()
            .source_execution_id
            .is_none()
    );
    let approve = approval(&state);
    advance(&repository, &mut state, "approve_fresh", approve).await;
    let id = state.execution.as_ref().unwrap().id.clone();
    let accepted = host_receipt(&state, "accepted");
    advance(
        &repository,
        &mut state,
        "accept",
        Command::Accept {
            execution_id: id.clone(),
            receipt: accepted.clone(),
        },
    )
    .await;
    advance(
        &repository,
        &mut state,
        "interrupt",
        Command::Interrupt {
            execution_id: id.clone(),
            invocation: accepted.invocation.clone(),
            reason: "Host stopped the exact invocation".into(),
        },
    )
    .await;
    let stale_digest = state.execution.as_ref().unwrap().request.digest().unwrap();
    advance(
        &repository,
        &mut state,
        "resume",
        Command::Resume {
            grant: maka_plugins::authorization::Id(uuid::Uuid::from_u128(1)),
            execution_id: id.clone(),
        },
    )
    .await;
    rejects(
        &repository,
        &state,
        Command::Accept {
            execution_id: id.clone(),
            receipt: accepted,
        },
    )
    .await;
    rejects(
        &repository,
        &state,
        Command::Reject {
            execution_id: id,
            request_digest: stale_digest,
            reason: "late rejection".into(),
        },
    )
    .await;
    assert!(matches!(
        state.execution.unwrap().phase,
        Phase::AwaitingAdmission
    ));
    drop(repository);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}

#[tokio::test]
async fn history_is_bounded_frozen_and_exact_retries_share_one_revision() {
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&temp.path().join("state.sqlite"))
            .await
            .unwrap(),
    );
    let storage = Storage::new(log.clone());
    let repository = Repository::new(storage.clone(), "planner", "session").unwrap();
    let mut artifact = draft();
    artifact.overview = Some("\\".repeat(12 * 1024));
    let propose = request(
        "draft",
        0,
        Command::Propose {
            turn_id: "turn".into(),
            artifact: artifact.clone(),
        },
    );
    let (a, b) = tokio::join!(repository.apply(&propose, 1), repository.apply(&propose, 2));
    let mut state = a.unwrap();
    assert_eq!(state, b.unwrap());
    let approve = request("approve", state.revision, approval(&state));
    storage.lose_reply.store(true, Ordering::SeqCst);
    assert!(repository.apply(&approve, 3).await.is_err());
    state = repository.apply(&approve, 4).await.unwrap();
    let id = state.execution.as_ref().unwrap().id.clone();
    let accepted = host_receipt(&state, "first");
    advance(
        &repository,
        &mut state,
        "accept",
        Command::Accept {
            execution_id: id.clone(),
            receipt: accepted.clone(),
        },
    )
    .await;
    for i in 0..10 {
        let steps = state.execution.as_ref().unwrap().steps.clone();
        advance(
            &repository,
            &mut state,
            &format!("progress_{i}"),
            Command::Progress {
                execution_id: id.clone(),
                invocation: accepted.invocation.clone(),
                steps,
            },
        )
        .await;
    }
    let page = repository.history(None, 0).await.unwrap();
    let through = page.through_revision;
    assert!(page.next_after.is_some());
    assert!(
        page.snapshots.len() < 8,
        "byte budget must paginate before the item budget"
    );
    assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
    let mut next = page.next_after;
    let mut history = page.snapshots;
    advance(
        &repository,
        &mut state,
        "interrupt",
        Command::Interrupt {
            execution_id: id,
            invocation: accepted.invocation,
            reason: "root finished without completing the plan".into(),
        },
    )
    .await;
    while let Some(after) = next {
        let page = repository.history(Some(through), after).await.unwrap();
        assert!(!page.snapshots.is_empty());
        assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
        next = page.next_after;
        history.extend(page.snapshots);
    }
    assert_eq!(
        history.iter().map(|s| s.revision).collect::<Vec<_>>(),
        (1..=through).collect::<Vec<_>>()
    );
    assert_eq!(
        repository.receipt(&approve).await.unwrap().unwrap(),
        history[1]
    );
    assert!(
        repository
            .history(Some(state.revision + 1), 0)
            .await
            .is_err()
    );
    assert!(
        repository
            .history(Some(through), through + 1)
            .await
            .is_err()
    );
    assert!(
        repository
            .history(Some(through), through)
            .await
            .unwrap()
            .snapshots
            .is_empty()
    );
    drop(repository);
    drop(storage);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}
