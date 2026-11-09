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
use maka_agent_facts::{accounting::ModelEvidence, execution::ModelBinding, language::Language};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{SessionStore, WorkEffects, WorkSettlementObserver},
};
use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};

async fn fixture() -> (tempfile::TempDir, RootStore, SessionStore) {
    let directory = tempfile::tempdir().unwrap();
    let owner = RootOwner::create(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        },
    )
    .unwrap();
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    let root = RootStore::open(Arc::new(owner), &migrations).await.unwrap();
    let session = root
        .create_session("auxiliary", "fixture", &serde_json::json!({}), 1)
        .await
        .unwrap();
    (directory, root, session)
}

async fn accepted(
    root: &RootStore,
    session: &SessionStore,
) -> (SessionWorkLease, WorkEffects, WorkSettlementObserver) {
    let (lease, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let observer = root
        .observe_work_settlement(lease.store().work_custody().unwrap().as_ref(), "auxiliary")
        .unwrap();
    (lease, effects, observer)
}

fn unstarted_journal(root: &RootStore, lease: &SessionWorkLease) -> Journal {
    let writer = root
        .data_writer_for_work(lease.store().work_custody().unwrap().as_ref(), "auxiliary")
        .unwrap();
    let owner = RunOwner {
        deployment: Uuid::new_v4(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
    };
    let spec = AuxiliarySpec {
        schema_version: maka_agent_state::usage::SCHEMA_VERSION,
        owner: owner.clone(),
        session: "auxiliary".into(),
        source: AuxiliarySource::ApplicationOperation {
            source: DeploymentRef {
                state_domain: "a".repeat(64),
                deployment: owner.deployment,
                revision: 1,
            },
            namespace: owner.namespace,
            operation: Uuid::new_v4(),
            fingerprint: "auxiliary-fixture".into(),
        },
        accounting: ModelEvidence {
            binding: ModelBinding {
                connection_id: "fixture".into(),
                connection_slug: "fixture".into(),
                model: "fixture".into(),
            },
            model_id: "fixture".into(),
            purpose: ModelPurpose::Main,
            quote: None,
        },
        language: Language::En,
    };
    // Keep the journal unstarted: settlement must reject the missing canonical admission.
    let (journal, _) = UsageStore::new(writer)
        .auxiliary(spec, UnixMillis(1))
        .unwrap();
    Journal::new(journal)
}

fn drained(root: &RootStore, lease: SessionWorkLease) -> JournalCustody {
    let retention = root
        .fork_work(lease.store().work_custody().unwrap().as_ref(), "auxiliary")
        .unwrap();
    JournalCustody {
        journal: unstarted_journal(root, &lease),
        physical: Some(Physical::Session(lease)),
        phase: ProviderPhase::Drained,
        retention: IdleLease(Some(retention)),
    }
}

async fn writer_available(observer: &WorkSettlementObserver) {
    tokio::time::timeout(Duration::from_secs(2), observer.wait())
        .await
        .expect("physical custody must release the Session writer")
        .unwrap();
}

#[tokio::test]
async fn undispatched_admission_drop_releases_physical_custody() {
    let (_directory, root, session) = fixture().await;
    let (lease, effects, observer) = accepted(&root, &session).await;
    let admission = IdleLease(Some(lease));
    drop(admission);
    effects.settle().await.unwrap();
    writer_available(&observer).await;
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn drained_persistence_exit_releases_custody_without_settlement() {
    let (_directory, root, session) = fixture().await;
    let (lease, effects, observer) = accepted(&root, &session).await;
    let custody = drained(&root, lease);
    drop(custody);
    effects.settle().await.unwrap();
    writer_available(&observer).await;
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejected_settlement_still_releases_confirmed_physical_custody() {
    let (_directory, root, session) = fixture().await;
    let (lease, effects, observer) = accepted(&root, &session).await;
    let custody = drained(&root, lease);
    assert!(
        custody
            .journal()
            .settle(Outcome::Success, UnixMillis(2))
            .await
            .is_err()
    );
    drop(custody);
    effects.settle().await.unwrap();
    writer_available(&observer).await;
    root.shutdown().await.unwrap();
}
