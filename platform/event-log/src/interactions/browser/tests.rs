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

use super::*;
use maka_agent_facts::interaction::{ClosureReason, GrantCapability, InteractionRecord};
use maka_agent_facts::workspace::BindingStamp;
use rusqlite::{Connection, StatementStatus, params};
use serde_json::{Value, json};

fn target() -> GrantTarget {
    GrantTarget {
        provider_id: "provider".into(),
        contract_id: "contract".into(),
        server_id: "desktop_browser".into(),
        tool_name: "cua_repl".into(),
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin {
            origin: "https://example.com".into(),
        },
    }
}

fn request(
    id: &str,
    created_at: u64,
    target: GrantTarget,
    basis: Option<PermissionBasis>,
) -> InteractionRecord {
    InteractionRecord {
        session_id: "session".into(),
        turn_id: format!("{id}-turn"),
        run_id: format!("{id}-run"),
        request_id: id.into(),
        created_at,
        request: InteractionRequest::ClientCapability {
            tool_use_id: format!("{id}-tool"),
            target,
            basis,
        },
        outcome: None,
    }
}

fn outcome(decision: Decision, committed_at: u64) -> InteractionOutcome {
    InteractionOutcome::ClientCapabilityDecision {
        decision,
        committed_at,
    }
}

async fn fixture() -> (tempfile::TempDir, EventLog, PermissionBasis) {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("browser.sqlite"))
        .await
        .unwrap();
    let reference = log
        .attach_workspace("browser", &json!({"path":"/workspace"}))
        .await
        .unwrap();
    log.create_session(
        "session",
        "create",
        &json!({"workspace":reference,"boundary_revision":4}),
        1,
    )
    .await
    .unwrap();
    let basis = PermissionBasis {
        boundary_revision: 4,
        binding: BindingStamp {
            id: reference.id,
            permission_epoch: reference.permission_epoch_at_attach,
        },
    };
    (directory, log, basis)
}

async fn decide(log: &EventLog, record: &InteractionRecord, value: Decision, time: u64) {
    assert!(log.establish_interaction(record).await.unwrap().matches);
    assert!(
        log.commit_interaction_outcome(&record.request_id, outcome(value, time))
            .await
            .unwrap()
            .matches
    );
}

#[tokio::test]
async fn actual_browser_decisions_follow_outcome_time_and_survive_reopen() {
    let (directory, log, basis) = fixture().await;
    let target = target();
    let cancelled = request("cancelled", 50, target.clone(), Some(basis));
    log.establish_interaction(&cancelled).await.unwrap();
    log.commit_interaction_outcome(
        "cancelled",
        InteractionOutcome::Closure {
            reason: ClosureReason::ProducerCancelled,
            committed_at: 999,
        },
    )
    .await
    .unwrap();
    log.establish_interaction(&request("pending", 60, target.clone(), Some(basis)))
        .await
        .unwrap();
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        None
    );

    let older = request("older", 10, target.clone(), Some(basis));
    log.establish_interaction(&older).await.unwrap();
    decide(
        &log,
        &request("newer", 20, target.clone(), Some(basis)),
        Decision::Allow,
        30,
    )
    .await;
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        Some(Decision::Allow)
    );
    log.commit_interaction_outcome("older", outcome(Decision::Deny, 40))
        .await
        .unwrap();
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        Some(Decision::Deny),
        "the later answer wins even when its prompt was created earlier"
    );
    assert!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .is_some(),
        "the browser projection must not rewrite generic allow grants"
    );
    let retried = log
        .commit_interaction_outcome("newer", outcome(Decision::Allow, 1000))
        .await
        .unwrap();
    assert_eq!(retried.record.outcome, Some(outcome(Decision::Allow, 30)));
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        Some(Decision::Deny),
        "an idempotent response retry cannot move the actual decision time"
    );
    let conflicting = log
        .commit_interaction_outcome("older", outcome(Decision::Allow, 2000))
        .await
        .unwrap();
    assert!(!conflicting.matches);
    assert_eq!(
        conflicting.record.outcome,
        Some(outcome(Decision::Deny, 40))
    );
    log.close().await.unwrap();

    let log = EventLog::open(&directory.path().join("browser.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        Some(Decision::Deny)
    );
    for (id, value) in [("tie-z", Decision::Allow), ("tie-a", Decision::Deny)] {
        decide(
            &log,
            &request(id, 5, target.clone(), Some(basis)),
            value,
            41,
        )
        .await;
    }
    assert_eq!(
        log.browser_origin_decision("session", &target, &basis)
            .await
            .unwrap(),
        Some(Decision::Allow),
        "equal outcome timestamps use the documented request-id tie-breaker"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn browser_decisions_require_the_exact_target_and_current_complete_basis() {
    let (_directory, log, basis) = fixture().await;
    let original = target();
    decide(
        &log,
        &request("denied", 10, original.clone(), Some(basis)),
        Decision::Deny,
        20,
    )
    .await;
    let mut alternatives = Vec::new();
    for field in 0..7 {
        let mut changed = original.clone();
        match field {
            0 => changed.provider_id = "another-provider".into(),
            1 => changed.contract_id = "another-contract".into(),
            2 => changed.server_id = "another-server".into(),
            3 => changed.tool_name = "another-tool".into(),
            4..=6 => {
                changed.scope = GrantScope::BrowserOrigin {
                    origin: [
                        "https://other.example.com",
                        "http://example.com",
                        "https://example.com:8443",
                    ][field - 4]
                        .into(),
                };
            }
            _ => unreachable!(),
        }
        alternatives.push(changed);
    }
    for (index, alternative) in alternatives.into_iter().enumerate() {
        decide(
            &log,
            &request(
                &format!("alternative-{index}"),
                30,
                alternative.clone(),
                Some(basis),
            ),
            Decision::Allow,
            100 + index as u64,
        )
        .await;
        assert_eq!(
            log.browser_origin_decision("session", &alternative, &basis)
                .await
                .unwrap(),
            Some(Decision::Allow)
        );
        assert_eq!(
            log.browser_origin_decision("session", &original, &basis)
                .await
                .unwrap(),
            Some(Decision::Deny)
        );
    }
    decide(
        &log,
        &request("unbound", 40, original.clone(), None),
        Decision::Allow,
        1000,
    )
    .await;
    assert_eq!(
        log.browser_origin_decision("session", &original, &basis)
            .await
            .unwrap(),
        Some(Decision::Deny)
    );
    for changed in [
        PermissionBasis {
            boundary_revision: 5,
            ..basis
        },
        PermissionBasis {
            binding: BindingStamp {
                id: uuid::Uuid::new_v4(),
                ..basis.binding
            },
            ..basis
        },
        PermissionBasis {
            binding: BindingStamp {
                permission_epoch: basis.binding.permission_epoch + 1,
                ..basis.binding
            },
            ..basis
        },
    ] {
        assert_eq!(
            log.browser_origin_decision("session", &original, &changed)
                .await
                .unwrap(),
            None
        );
    }
    let revision = log
        .get_session::<Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.update_session_permissions::<Value, _>("session", revision, 50, |configuration| {
        configuration["boundary_revision"] = json!(5);
        Ok(())
    })
    .await
    .unwrap();
    let current = PermissionBasis {
        boundary_revision: 5,
        ..basis
    };
    for requested in [basis, current] {
        assert_eq!(
            log.browser_origin_decision("session", &original, &requested)
                .await
                .unwrap(),
            None
        );
    }
    decide(
        &log,
        &request("renewed", 60, original.clone(), Some(current)),
        Decision::Allow,
        61,
    )
    .await;
    assert_eq!(
        log.browser_origin_decision("session", &original, &current)
            .await
            .unwrap(),
        Some(Decision::Allow)
    );
    let computer = GrantTarget {
        capability: GrantCapability::ComputerUse,
        scope: GrantScope::Capability {},
        ..original
    };
    assert!(
        log.browser_origin_decision("session", &computer, &current)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn browser_decisions_validate_the_winning_canonical_record() {
    let (_directory, log, basis) = fixture().await;
    let target = target();
    let mut winner = request("winner", 10, target.clone(), Some(basis));
    decide(&log, &winner, Decision::Deny, 20).await;
    winner.created_at = 11;
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE interaction_requests SET record_json=? WHERE request_id='winner'",
                )
                .bind(serde_json::to_string(&winner).unwrap())
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(matches!(
        log.browser_origin_decision("session", &target, &basis).await,
        Err(StoreError::InvalidTransition(message)) if message == "stored interaction identity changed"
    ));
    log.close().await.unwrap();
}

fn insert(db: &Connection, record: &InteractionRecord, result: Option<InteractionOutcome>) {
    db.execute(
        "INSERT INTO interaction_requests VALUES(?,?,?,?)",
        params![
            record.request_id,
            record.session_id,
            record.created_at as i64,
            serde_json::to_string(record).unwrap()
        ],
    )
    .unwrap();
    if let Some(result) = result {
        db.execute(
            "INSERT INTO interaction_outcomes VALUES(?,?)",
            params![record.request_id, serde_json::to_string(&result).unwrap()],
        )
        .unwrap();
    }
}

#[test]
fn browser_decision_lookup_uses_exact_identity_index_as_unrelated_history_grows() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&crate::schema::fixture(|_, name| {
        matches!(
            name,
            "interaction_requests"
                | "interaction_outcomes"
                | "interaction_session_pending"
                | "interaction_browser_origin_decision"
        )
    }))
    .unwrap();
    let basis = PermissionBasis {
        boundary_revision: 4,
        binding: BindingStamp {
            id: uuid::Uuid::from_u128(7),
            permission_epoch: 0,
        },
    };
    for (id, created, result) in [
        ("newer-allow", 20, Some(outcome(Decision::Allow, 30))),
        ("winning-deny", 10, Some(outcome(Decision::Deny, 40))),
        ("pending", 50, None),
        (
            "cancelled",
            60,
            Some(InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                committed_at: 1000,
            }),
        ),
    ] {
        insert(&db, &request(id, created, target(), Some(basis)), result);
    }
    let binding = basis.binding.id.to_string();
    let parameters = params![
        "session",
        "provider",
        "contract",
        "desktop_browser",
        "cua_repl",
        "https://example.com",
        4_i64,
        binding,
        0_i64
    ];
    let mut previous = None;
    for (start, end) in [(0, 1000), (1000, 10000)] {
        db.execute_batch("BEGIN").unwrap();
        for index in start..end {
            let mut other = request(&format!("history-{index}"), index, target(), Some(basis));
            match index % 3 {
                0 => {
                    let InteractionRequest::ClientCapability { target, .. } = &mut other.request
                    else {
                        unreachable!()
                    };
                    target.scope = GrantScope::BrowserOrigin {
                        origin: "https://other.example.com".into(),
                    };
                }
                1 => {
                    let InteractionRequest::ClientCapability { basis, .. } = &mut other.request
                    else {
                        unreachable!()
                    };
                    basis.as_mut().unwrap().boundary_revision = 3;
                }
                _ => other.session_id = "other-session".into(),
            }
            insert(&db, &other, Some(outcome(Decision::Allow, 10000 + index)));
        }
        db.execute_batch("COMMIT").unwrap();
        let mut query = db.prepare(BROWSER_ORIGIN_DECISION).unwrap();
        assert_eq!(
            query
                .query_row(parameters, |row| row.get::<_, String>(0))
                .unwrap(),
            "winning-deny"
        );
        let steps = query.get_status(StatementStatus::VmStep);
        assert_eq!(query.get_status(StatementStatus::FullscanStep), 0);
        if let Some(previous) = previous {
            assert_eq!(
                steps, previous,
                "unrelated history must not enter the decision sort"
            );
        }
        previous = Some(steps);
        let plan: Vec<String> = db
            .prepare(&format!("EXPLAIN QUERY PLAN {BROWSER_ORIGIN_DECISION}"))
            .unwrap()
            .query_map(parameters, |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|step| step
                .contains("SEARCH request USING INDEX interaction_browser_origin_decision")),
            "{plan:?}"
        );
        assert!(
            plan.iter().any(|step| step
                .contains("SEARCH outcome USING INDEX sqlite_autoindex_interaction_outcomes_1")),
            "{plan:?}"
        );
        assert!(
            plan.iter().all(|step| !step.starts_with("SCAN ")),
            "{plan:?}"
        );
        eprintln!(
            "SQLite {} history={end} matching_decisions=2 vm_steps={steps} plan={plan:?}",
            rusqlite::version()
        );
    }
}
