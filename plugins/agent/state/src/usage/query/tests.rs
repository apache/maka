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

//! Canonical accounting/projector/Query checks, not physical Root writer tests.
use super::*;
use crate::usage::{
    auxiliary::{RebuildAuxiliary, source_key},
    index::index_auxiliary,
};
use maka_agent_facts::{
    accounting::{AuxiliarySource, Outcome, Tokens},
    artifact::content_digest,
    context::ModelPurpose,
    execution::ModelBinding,
    language::Language,
    model::ModelUsage,
    pricing::{Pricing, Quote},
};
use maka_event_log::{applications::operations::OperationRequest, content, writeback::Statement};
use maka_plugin_core::{
    composition::InstanceId,
    contract::Contract,
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome},
};
use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

fn database() -> Connection {
    initialize(Connection::open_in_memory().unwrap())
}
fn initialize(db: Connection) -> Connection {
    db.pragma_update(None, "foreign_keys", true).unwrap();
    db.execute_batch(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../platform/event-log/migrations/0001_runtime.sql"
    )))
    .unwrap();
    for migration in crate::MIGRATIONS {
        db.execute_batch(migration.sql).unwrap();
    }
    db
}
fn owner() -> RunOwner {
    RunOwner {
        deployment: Uuid::from_u128(1),
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
    }
}
fn query() -> UsageQuery {
    UsageQuery {
        from: 0.0,
        to: 1000.0,
        owner: Some(owner()),
        session_id: Some("usage-test".into()),
        through: None,
    }
}
fn quote(input: f64, output: f64) -> Quote {
    Quote {
        provider_id: "provider".into(),
        revision: 7,
        pricing: Some(Pricing {
            model_key: "provider:model".into(),
            input_usd_per_million: input,
            output_usd_per_million: output,
            cache_read_usd_per_million: None,
            cache_write_usd_per_million: None,
        }),
    }
}
fn json_content<T: Serialize>(db: &Connection, value: &T) -> (i64, ContentRef) {
    let bytes = serde_json::to_vec(value).unwrap();
    let reference = ContentRef {
        digest: content_digest(&bytes),
        bytes: u64::try_from(bytes.len()).unwrap(),
    };
    (
        content::put(db, &reference.digest, &bytes).unwrap(),
        reference,
    )
}
fn operation_source(db: &Connection, operation: Uuid) -> AuxiliarySource {
    let contract: Contract = serde_json::from_value(json!({
        "name": "test.auxiliary", "version": 1, "transport": "local",
        "interface": { "kind": "service", "methods": { "generate": {
            "mode": "mutation", "input": { "type": "object" },
            "output": { "type": "object" }, "resources": {}
        } } }
    }))
    .unwrap();
    let request = OperationRequest {
        source: DeploymentRef {
            state_domain: "1".repeat(64),
            deployment: owner().deployment,
            revision: 1,
        },
        namespace: owner().namespace,
        consumer: owner().namespace,
        export: "auxiliary".into(),
        method: "generate".into(),
        contract: contract.clone(),
        operation,
        input: json!({}),
        capture: None,
        origin: json!({"kind":"test"}),
    };
    let reference = request.reference().unwrap();
    let mut original = serde_json::to_value(&request).unwrap();
    original["contract"] = serde_json::to_value(&reference.contract).unwrap();
    db.execute("INSERT INTO application_operation_contracts(digest,contract_json) VALUES(?,?) ON CONFLICT(digest) DO NOTHING",
        params![reference.contract.digest,serde_json::to_string(&contract).unwrap()]).unwrap();
    db.execute("INSERT INTO application_operations(deployment,namespace,operation,source_revision,request_json,outcome_json,cleanup_json,contract_digest) VALUES(?,?,?,?,?,?,?,?)",
        params![reference.source.deployment.to_string(),serde_json::to_string(&reference.namespace).unwrap(),operation.to_string(),1,
            serde_json::to_string(&original).unwrap(),serde_json::to_string(&OperationOutcome::Unresolved).unwrap(),
            serde_json::to_string(&OperationCleanup::Unconfirmed).unwrap(),reference.contract.digest]).unwrap();
    AuxiliarySource::ApplicationOperation {
        source: reference.source,
        namespace: reference.namespace,
        operation,
        fingerprint: reference.fingerprint,
    }
}
// These fixtures seed only typed canonical accounting bytes. Native source admission,
// live dispatch authority and physical writer custody are intentionally outside this test.
struct Auxiliary {
    request: Uuid,
    spec: AuxiliarySpec,
    reference: ContentRef,
}
impl Auxiliary {
    fn spec(db: &Connection, request: Uuid, quote: Option<Quote>) -> AuxiliarySpec {
        AuxiliarySpec {
            schema_version: SCHEMA_VERSION,
            owner: owner(),
            session: "usage-test".into(),
            source: operation_source(db, request),
            accounting: ModelEvidence {
                binding: ModelBinding {
                    connection_id: "connection".into(),
                    connection_slug: "connection".into(),
                    model: "model".into(),
                },
                model_id: "model".into(),
                purpose: ModelPurpose::Summary,
                quote,
            },
            language: Language::En,
        }
    }
    fn start(db: &Connection, request: Uuid, quote: Option<Quote>) -> Self {
        let spec = Self::spec(db, request, quote);
        let (content_id, reference) = json_content(db, &spec);
        db.execute("INSERT INTO agent_usage_aux_specs(request,owner,session,source_key,spec_content_id) VALUES(?,?,?,?,?)",
            params![request.to_string(),serde_json::to_string(&spec.owner).unwrap(),spec.session,source_key(&spec).unwrap(),content_id]).unwrap();
        let fixture = Self {
            request,
            spec,
            reference,
        };
        fixture.event(
            db,
            10,
            AuxiliaryEvent::Started {
                spec: fixture.reference.clone(),
            },
        );
        fixture
    }
    fn event(&self, db: &Connection, at: i64, event: AuxiliaryEvent) {
        let (body, _) = json_content(db, &event);
        db.execute(
            "INSERT INTO agent_usage_aux_events(id,request,at,body_content_id) VALUES(?,?,?,?)",
            params![
                Uuid::new_v4().to_string(),
                self.request.to_string(),
                at,
                body
            ],
        )
        .unwrap();
        let sequence = u64::try_from(db.last_insert_rowid()).unwrap();
        index_auxiliary(
            db,
            self.request,
            sequence,
            UnixMillis(at),
            &event,
            &self.spec,
        )
        .unwrap();
    }
}
fn report(db: &Connection, query: UsageQuery) -> UsageReport {
    summary::Read {
        query,
        group: None,
        after: None,
        domain: "root-test".into(),
    }
    .execute(db)
    .unwrap()
}
fn totals(db: &Connection, query: UsageQuery) -> SessionUsageTotals {
    summary::SessionTotals {
        query,
        domain: "root-test".into(),
    }
    .execute(db)
    .unwrap()
}

#[test]
fn frozen_cut_and_captured_quote_survive_auxiliary_rebuild() {
    let db = database();
    let original = Auxiliary::start(&db, Uuid::from_u128(10), Some(quote(2.0, 3.0)));
    let mut newer_quote = quote(200.0, 300.0);
    newer_quote.revision = 8;
    let pending = Auxiliary::start(&db, Uuid::from_u128(11), Some(newer_quote));
    let before = report(&db, query());
    assert_eq!(before.summary.models.calls, 0);
    assert_eq!(before.summary.pending.models, 2);
    let mut frozen = query();
    frozen.through = Some(before.through);
    assert_eq!(
        totals(&db, frozen.clone()).input,
        Tokens {
            known: 0,
            missing: 2
        }
    );

    // Cross a replay page boundary with real canonical usage observations.
    for count in 1..=130 {
        original.event(
            &db,
            20,
            AuxiliaryEvent::UsageObserved {
                usage: ModelUsage {
                    input_tokens: Some(count),
                    ..Default::default()
                },
            },
        );
    }
    original.event(
        &db,
        20,
        AuxiliaryEvent::UsageObserved {
            usage: ModelUsage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(1_000_000),
                cache_read_tokens: Some(0),
                cache_write_tokens: Some(0),
                reasoning_tokens: None,
            },
        },
    );
    original.event(
        &db,
        30,
        AuxiliaryEvent::Settled {
            outcome: Outcome::Success,
        },
    );
    let old = report(&db, frozen.clone());
    assert_eq!(old.summary.pending.models, 2);
    assert_eq!(old.summary.models.calls, 0);
    assert_eq!(
        totals(&db, frozen.clone()).output,
        Tokens {
            known: 0,
            missing: 2
        }
    );
    let current = report(&db, query());
    assert_eq!(current.summary.models.calls, 1);
    assert_eq!(current.summary.pending.models, 1);
    assert_eq!(
        current.summary.models.input,
        Tokens {
            known: 1_000_000,
            missing: 0
        }
    );
    assert_eq!(current.summary.models.cost.known_usd, 5.0);
    assert_eq!(
        totals(&db, query()).output,
        Tokens {
            known: 1_000_000,
            missing: 1
        }
    );

    let tx = db.unchecked_transaction().unwrap();
    RebuildAuxiliary(original.request).execute(&tx).unwrap();
    tx.commit().unwrap();
    // The full pricing-authority schema is absent; replay must use the persisted quote,
    // not the newer, different quote on the still-pending request.
    let rebuilt = report(&db, query());
    assert_eq!(rebuilt.summary, current.summary);
    assert_eq!(report(&db, frozen.clone()).summary, old.summary);
    assert_eq!(
        totals(&db, frozen.clone()).input,
        Tokens {
            known: 0,
            missing: 2
        }
    );
    let pending_count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM agent_usage_calls WHERE request=?",
            [format!("auxiliary:{}", pending.request)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending_count, 1);

    let mut different = frozen;
    different.to = 999.0;
    assert!(matches!(
        summary::Read {
            query: different,
            group: None,
            after: None,
            domain: "root-test".into()
        }
        .execute(&db),
        Err(StoreError::InvalidTransition(_))
    ));
}

#[test]
fn timestamp_ties_page_without_repeats_or_gaps() {
    let db = database();
    let mut expected = Vec::new();
    for id in 100..=132 {
        let request = Uuid::from_u128(id);
        let item = Auxiliary::start(&db, request, None);
        item.event(
            &db,
            30,
            AuxiliaryEvent::Settled {
                outcome: Outcome::Unknown,
            },
        );
        expected.push(format!("auxiliary:{request}"));
    }
    expected.sort();
    let first = activity::Read {
        query: query(),
        selection: Selection::default(),
        after: None,
        domain: "root-test".into(),
    }
    .execute(&db)
    .unwrap();
    assert_eq!(first.total, 33);
    assert_eq!(first.attempts.len(), 32);
    let cursor = first.next_cursor.expect("one lookahead attempt");
    let mut next = query();
    next.through = Some(first.through);
    let second = activity::Read {
        query: next,
        selection: Selection::default(),
        after: Some(cursor),
        domain: "root-test".into(),
    }
    .execute(&db)
    .unwrap();
    assert_eq!(second.total, 33);
    assert_eq!(second.attempts.len(), 1);
    assert!(second.next_cursor.is_none());
    let actual: Vec<_> = first
        .attempts
        .into_iter()
        .chain(second.attempts)
        .map(|activity| match activity {
            Activity::Model(attempt) => attempt.request_id,
            Activity::Tool(_) => panic!("model canonical source became a tool"),
        })
        .collect();
    assert_eq!(actual, expected);
}

#[test]
fn original_source_is_not_readmitted_by_new_request_or_quote_revision() {
    let db = database();
    let original = Uuid::from_u128(200);
    let spec = Auxiliary::spec(&db, original, Some(quote(2.0, 3.0)));
    let started = |request, spec: &AuxiliarySpec| {
        let bytes: std::sync::Arc<[u8]> = serde_json::to_vec(spec).unwrap().into();
        let reference = ContentRef {
            digest: content_digest(&bytes),
            bytes: u64::try_from(bytes.len()).unwrap(),
        };
        AuxiliaryWrite::new(
            request,
            UnixMillis(10),
            AuxiliaryEvent::Started { spec: reference },
            Some(bytes),
        )
    };
    let apply = |write: AuxiliaryWrite| {
        let tx = db.unchecked_transaction().unwrap();
        let prepared = write.prepare().unwrap().execute(&tx).unwrap();
        let changed = prepared.changed;
        if changed {
            tx.commit().unwrap();
        } else {
            tx.rollback().unwrap();
        }
        (changed, AuxiliaryWrite::committed(prepared.value))
    };
    let write = started(original, &spec);
    let (changed, result) = apply(write.clone());
    assert!(changed);
    assert!(result.is_ok());
    let (changed, result) = apply(write.clone());
    assert!(!changed);
    assert!(result.is_ok());
    let rows: (i64, i64, i64) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM agent_usage_aux_specs),
                (SELECT COUNT(*) FROM agent_usage_aux_events),
                (SELECT COUNT(*) FROM agent_usage_calls)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(rows, (1, 1, 1));

    let replacement = Uuid::from_u128(201);
    let mut changed_spec = spec;
    let mut newer_quote = quote(200.0, 300.0);
    newer_quote.revision = 8;
    changed_spec.accounting.quote = Some(newer_quote);
    let (changed, result) = apply(started(replacement, &changed_spec));
    assert!(!changed);
    assert!(matches!(result,Err(Error::SourceAlreadyAdmitted { request }) if request==original));
    let rows: (i64, i64, i64) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM agent_usage_aux_specs),
                (SELECT COUNT(*) FROM agent_usage_aux_events),
                (SELECT COUNT(*) FROM agent_usage_calls)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(rows, (1, 1, 1));
}

#[test]
fn settled_partial_auxiliary_usage_survives_rebuild_and_reopen_without_readmission() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("usage.sqlite");
    let db = initialize(Connection::open(&path).unwrap());
    let original = Auxiliary::start(&db, Uuid::from_u128(300), Some(quote(2.0, 3.0)));
    original.event(
        &db,
        20,
        AuxiliaryEvent::UsageObserved {
            usage: ModelUsage {
                input_tokens: Some(77),
                ..Default::default()
            },
        },
    );
    original.event(
        &db,
        30,
        AuxiliaryEvent::Settled {
            outcome: Outcome::Success,
        },
    );

    let settled = report(&db, query());
    let meter = totals(&db, query());
    assert_eq!(settled.summary.models.calls, 1);
    assert_eq!(settled.summary.pending.models, 0);
    assert_eq!(
        settled.summary.models.input,
        Tokens {
            known: 77,
            missing: 0
        }
    );
    assert_eq!(
        settled.summary.models.output,
        Tokens {
            known: 0,
            missing: 1
        }
    );
    assert_eq!(
        meter.input,
        Tokens {
            known: 77,
            missing: 0
        }
    );
    assert_eq!(
        meter.output,
        Tokens {
            known: 0,
            missing: 1
        }
    );
    let mut frozen = query();
    frozen.through = Some(settled.through);
    let original_bytes = content::read(&db, &original.reference.digest)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<AuxiliarySpec>(&original_bytes).unwrap(),
        original.spec
    );
    let captured_quote: String = db
        .query_row(
            "SELECT quote_json FROM agent_usage_calls WHERE request=?",
            [format!("auxiliary:{}", original.request)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        Some(serde_json::from_str::<Quote>(&captured_quote).unwrap()),
        original.spec.accounting.quote
    );

    let started = |request, spec: &AuxiliarySpec| {
        let bytes: std::sync::Arc<[u8]> = serde_json::to_vec(spec).unwrap().into();
        let reference = ContentRef {
            digest: content_digest(&bytes),
            bytes: u64::try_from(bytes.len()).unwrap(),
        };
        AuxiliaryWrite::new(
            request,
            UnixMillis(40),
            AuxiliaryEvent::Started { spec: reference },
            Some(bytes),
        )
    };
    let apply = |db: &Connection, write: AuxiliaryWrite| -> Result<_, StoreError> {
        let tx = db.unchecked_transaction()?;
        let prepared = write.prepare()?.execute(&tx)?;
        let changed = prepared.changed;
        if changed {
            tx.commit()?;
        } else {
            tx.rollback()?;
        }
        Ok((changed, AuxiliaryWrite::committed(prepared.value)))
    };
    let counts = |db: &Connection| -> (i64, i64, i64) {
        db.query_row(
            "SELECT (SELECT count(*) FROM agent_usage_aux_specs), (SELECT count(*) FROM agent_usage_aux_events), (SELECT count(*) FROM agent_usage_calls)",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap()
    };
    let canonical_counts = counts(&db);
    assert_eq!(canonical_counts, (1, 3, 1));
    assert!(matches!(
        apply(&db, started(original.request, &original.spec)),
        Err(StoreError::EventConflict)
    ));
    let (changed, result) = apply(&db, started(Uuid::from_u128(301), &original.spec)).unwrap();
    assert!(!changed);
    assert!(
        matches!(result, Err(Error::SourceAlreadyAdmitted { request }) if request == original.request)
    );
    assert_eq!(counts(&db), canonical_counts);
    assert_eq!(report(&db, query()).summary, settled.summary);
    assert_eq!(totals(&db, query()), meter);

    let tx = db.unchecked_transaction().unwrap();
    RebuildAuxiliary(original.request).execute(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(report(&db, query()).summary, settled.summary);
    assert_eq!(report(&db, frozen.clone()).summary, settled.summary);
    assert_eq!(totals(&db, query()), meter);
    assert_eq!(
        content::read(&db, &original.reference.digest).unwrap(),
        Some(original_bytes.clone())
    );
    db.close().unwrap();

    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    assert_eq!(report(&db, query()).summary, settled.summary);
    assert_eq!(totals(&db, query()), meter);
    let mut newer_spec = original.spec.clone();
    let mut newer_quote = quote(200.0, 300.0);
    newer_quote.revision = 8;
    newer_spec.accounting.quote = Some(newer_quote);
    assert_eq!(
        source_key(&newer_spec).unwrap(),
        source_key(&original.spec).unwrap()
    );
    let (changed, result) = apply(&db, started(Uuid::from_u128(302), &newer_spec)).unwrap();
    assert!(!changed);
    assert!(
        matches!(result, Err(Error::SourceAlreadyAdmitted { request }) if request == original.request)
    );
    let tx = db.unchecked_transaction().unwrap();
    RebuildAuxiliary(original.request).execute(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(counts(&db), canonical_counts);
    assert_eq!(report(&db, query()).summary, settled.summary);
    assert_eq!(report(&db, frozen).summary, settled.summary);
    assert_eq!(totals(&db, query()), meter);
    assert_eq!(
        content::read(&db, &original.reference.digest).unwrap(),
        Some(original_bytes)
    );
    let persisted_quote: String = db
        .query_row(
            "SELECT quote_json FROM agent_usage_calls WHERE request=?",
            [format!("auxiliary:{}", original.request)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_quote, captured_quote);
    db.close().unwrap();
}
