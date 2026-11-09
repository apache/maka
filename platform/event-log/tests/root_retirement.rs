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

use futures_util::poll;
use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    applications::operations::{Dispatch, DispatchClaim, OperationRequest},
    connection::Query,
    content, root,
    root_store::{DataChange, DataWriter, OperationStore},
    sessions::{SessionRemovalResult, SessionRetirement},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationResult},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn open() -> (tempfile::TempDir, RootStore) {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        root::RootOwner::create(
            &directory.path().join("root"),
            &root::RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = RootStore::open(owner, ROOT_MIGRATIONS).await.unwrap();
    (directory, store)
}

async fn dispatch(root: &RootStore, target: &str) -> (OperationStore, DispatchClaim) {
    let request = OperationRequest {
        source: root
            .commit_application(
                Uuid::new_v4(),
                0,
                Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "service".into(),
        method: "change".into(),
        contract: Contract {
            name: "changes".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "change".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"target": target}),
        capture: None,
        origin: json!({"kind": "composition_test"}),
    };
    let operation = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request).await.unwrap() else {
        panic!("original request must obtain one real claim");
    };
    operation.start_operation(&claim).unwrap();
    (operation, claim)
}

const SOURCE: &[u8] = b"the concrete domain's original source";
fn source_digest() -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(SOURCE)))
}
struct Domain {
    remove: bool,
    busy: bool,
    digest: Option<String>,
    commits: Arc<AtomicUsize>,
}
impl Domain {
    fn new(remove: bool, busy: bool, commits: &Arc<AtomicUsize>) -> Self {
        Self {
            remove,
            busy,
            digest: None,
            commits: commits.clone(),
        }
    }
}
impl Statement for Domain {
    type Value = Arc<AtomicUsize>;
    type Output = ();
    const PREPARE_OFF_THREAD: bool = true;
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.digest = Some(source_digest());
        Ok(self)
    }
    fn execute(self, db: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let applied: bool = if self.remove {
            db.query_row("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id='target' AND remove_session=1 AND completed=0)", [], |row| row.get(0))?
        } else {
            db.query_row(
                "SELECT archived FROM session_control WHERE id='target'",
                [],
                |row| row.get(0),
            )?
        };
        assert!(
            applied,
            "Root metadata/fence must precede the concrete domain statement"
        );
        let digest = self.digest.ok_or_else(|| {
            StoreError::InvalidTransition("domain source was not prepared".into())
        })?;
        content::put(db, &digest, SOURCE)?;
        if self.busy {
            return Err(StoreError::SessionBusy);
        }
        Ok(Prepared {
            value: self.commits,
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(commits: Self::Value) {
        commits.fetch_add(1, Ordering::AcqRel);
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::SessionBusy)
    }
}
struct Source;
impl Query for Source {
    type Output = Option<Vec<u8>>;
    fn execute(self, db: &Connection) -> Result<Self::Output, StoreError> {
        content::read(db, &source_digest())
    }
}
async fn prepare(
    root: &RootStore,
    writer: &DataWriter,
    expected: u64,
    domain: Domain,
) -> (Value, DataChange) {
    if domain.remove {
        let (state, change) = root
            .prepare_session_removal("target", expected, writer, domain)
            .await
            .unwrap();
        assert_eq!(state, SessionRetirement::Removing);
        (json!({"removed":"target"}), change)
    } else {
        let (record, change) = root
            .prepare_session_archived::<Value, _>("target", expected, true, 11, writer, domain)
            .await
            .unwrap();
        (serde_json::to_value(record).unwrap(), change)
    }
}

#[tokio::test]
async fn abandoned_prepare_and_domain_busy_leave_metadata_source_and_returned_unchanged() {
    for remove in [false, true] {
        let (_directory, root) = open().await;
        root.create_session("target", "original", &json!({}), 7)
            .await
            .unwrap();
        let before = root.get_session::<Value>("target").await.unwrap().unwrap();
        let writer = root.data_writer().unwrap();
        let commits = Arc::new(AtomicUsize::new(0));
        let (_, change) = prepare(
            &root,
            &writer,
            before.revision,
            Domain::new(remove, false, &commits),
        )
        .await;
        assert_eq!(
            root.get_session::<Value>("target").await.unwrap(),
            Some(before.clone())
        );
        assert_eq!(writer.query(Source).await.unwrap(), None);
        drop(change);
        assert_eq!(root.session_retirement("target").await.unwrap(), None);
        assert_eq!(commits.load(Ordering::Acquire), 0);

        let (operation, claim) = dispatch(&root, "target").await;
        let (value, change) = prepare(
            &root,
            &writer,
            before.revision,
            Domain::new(remove, true, &commits),
        )
        .await;
        assert!(matches!(
            change
                .commit(&claim, OperationResult::Success { value })
                .await,
            Err(StoreError::SessionBusy)
        ));
        assert_eq!(
            root.get_session::<Value>("target").await.unwrap(),
            Some(before)
        );
        assert_eq!(root.session_retirement("target").await.unwrap(), None);
        assert_eq!(writer.query(Source).await.unwrap(), None);
        assert_eq!(commits.load(Ordering::Acquire), 0);
        assert_eq!(
            operation
                .operation_observation()
                .await
                .unwrap()
                .unwrap()
                .outcome,
            OperationOutcome::Unresolved
        );
        operation
            .record_operation_outcome(
                &claim,
                OperationOutcome::Returned {
                    result: OperationResult::Failure {
                        diagnostic: "domain is busy".into(),
                    },
                },
            )
            .await
            .unwrap();
        operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
        drop(claim);
        root.close().await.unwrap();
    }
}

#[tokio::test]
async fn metadata_source_and_original_returned_commit_together_without_repeating_domain_cleanup() {
    for remove in [false, true] {
        let (_directory, root) = open().await;
        root.create_session("target", "original", &json!({}), 7)
            .await
            .unwrap();
        let before = root.get_session::<Value>("target").await.unwrap().unwrap();
        let writer = root.data_writer().unwrap();
        let commits = Arc::new(AtomicUsize::new(0));
        let (operation, claim) = dispatch(&root, "target").await;
        let (value, change) = prepare(
            &root,
            &writer,
            before.revision,
            Domain::new(remove, false, &commits),
        )
        .await;
        let returned = OperationResult::Success {
            value: value.clone(),
        };
        let observation = change.commit(&claim, returned.clone()).await.unwrap();
        assert_eq!(observation.reference, *claim.reference());
        assert_eq!(
            observation.outcome,
            OperationOutcome::Returned {
                result: returned.clone()
            }
        );
        assert_eq!(writer.query(Source).await.unwrap().as_deref(), Some(SOURCE));
        assert_eq!(commits.load(Ordering::Acquire), 1);
        let expected = if remove {
            assert!(root.get_session::<Value>("target").await.unwrap().is_none());
            assert_eq!(
                root.session_retirement("target").await.unwrap(),
                Some(SessionRetirement::Removing)
            );
            before.revision
        } else {
            let actual = root.get_session::<Value>("target").await.unwrap().unwrap();
            assert_eq!(serde_json::to_value(&actual).unwrap(), value);
            actual.revision
        };
        let (_, retried) = prepare(
            &root,
            &writer,
            expected,
            Domain::new(remove, true, &commits),
        )
        .await;
        assert_eq!(retried.commit(&claim, returned).await.unwrap(), observation);
        assert_eq!(commits.load(Ordering::Acquire), 1);
        operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
        drop(claim);
        root.close().await.unwrap();
    }
}

#[tokio::test]
async fn foreign_actual_writer_cannot_prepare_session_retirement() {
    let (_directory, root) = open().await;
    let (_foreign_directory, foreign) = open().await;
    root.create_session("target", "original", &json!({}), 7)
        .await
        .unwrap();
    let before = root.get_session::<Value>("target").await.unwrap().unwrap();
    let writer = foreign.data_writer().unwrap();
    let commits = Arc::new(AtomicUsize::new(0));
    assert!(matches!(
        root.prepare_session_archived::<Value, _>(
            "target",
            before.revision,
            true,
            11,
            &writer,
            Domain::new(false, false, &commits)
        )
        .await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(matches!(
        root.prepare_session_removal(
            "target",
            before.revision,
            &writer,
            Domain::new(true, false, &commits)
        )
        .await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert_eq!(
        root.get_session::<Value>("target").await.unwrap(),
        Some(before)
    );
    assert_eq!(root.session_retirement("target").await.unwrap(), None);
    root.close().await.unwrap();
    foreign.close().await.unwrap();
}

#[tokio::test]
async fn retirement_wait_wakes_on_physical_release_without_a_sql_commit_or_metadata_lock_cycle() {
    let (_directory, root) = open().await;
    let session = root
        .create_session("target", "original", &json!({}), 7)
        .await
        .unwrap();
    assert!(matches!(
        root.wait_session_retirement_work("target").await,
        Err(StoreError::InvalidTransition(_))
    ));
    let before = root.get_session::<Value>("target").await.unwrap().unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    assert!(matches!(
        root.begin_session_removal("target", before.revision)
            .await
            .unwrap(),
        SessionRemovalResult::Accepted(SessionRetirement::Removing)
    ));
    {
        let waiting = root.wait_session_retirement_work("target");
        tokio::pin!(waiting);
        assert!(poll!(&mut waiting).is_pending());
        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut waiting)
                .await
                .is_err()
        );
        assert!(matches!(
            tokio::time::timeout(
                Duration::from_secs(2),
                root.finish_session_retirement("target")
            )
            .await
            .unwrap(),
            Err(StoreError::SessionBusy)
        ));
        effects.settle().await.unwrap();
        work.finish();
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(
        root.finish_session_retirement("target").await.unwrap(),
        SessionRetirement::Removed
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn plugin_configuration_and_original_returned_share_one_cas_transaction() {
    use maka_plugin_core::{
        scope::Scope,
        storage::{Data, Mutation, Namespace},
    };
    let (_directory, root) = open().await;
    let writer = root.data_writer().unwrap();
    let namespace = Namespace::new("source-config", Scope::Profile).unwrap();
    let source = || Mutation {
        key: "source".into(),
        expected_revision: None,
        data: Data::Present(json!({"original": true})),
    };
    let (_, abandoned) = root
        .prepare_plugin_data_batch(&namespace, vec![source()], &writer)
        .unwrap();
    drop(abandoned);
    assert_eq!(root.plugin_data(&namespace, "source").await.unwrap(), None);

    let (operation, claim) = dispatch(&root, "configuration").await;
    let (records, change) = root
        .prepare_plugin_data_batch(&namespace, vec![source()], &writer)
        .unwrap();
    let returned = OperationResult::Success {
        value: serde_json::to_value(&records).unwrap(),
    };
    let observation = change.commit(&claim, returned.clone()).await.unwrap();
    assert_eq!(
        observation.outcome,
        OperationOutcome::Returned {
            result: returned.clone()
        }
    );
    assert_eq!(
        root.plugin_data(&namespace, "source")
            .await
            .unwrap()
            .as_ref(),
        records.first()
    );
    // The same original receipt wins before today's now-stale compare.
    let (_, replay) = root
        .prepare_plugin_data_batch(&namespace, vec![source()], &writer)
        .unwrap();
    assert_eq!(replay.commit(&claim, returned).await.unwrap(), observation);
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);

    let (rejected, claim) = dispatch(&root, "conflicting configuration").await;
    let (_, change) = root
        .prepare_plugin_data_batch(
            &namespace,
            vec![
                Mutation {
                    key: "other".into(),
                    expected_revision: None,
                    data: Data::Present(json!("must roll back")),
                },
                source(),
            ],
            &writer,
        )
        .unwrap();
    assert!(matches!(
        change
            .commit(&claim, OperationResult::Success { value: json!(null) })
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    assert_eq!(root.plugin_data(&namespace, "other").await.unwrap(), None);
    assert_eq!(
        root.plugin_data(&namespace, "source")
            .await
            .unwrap()
            .as_ref(),
        records.first()
    );
    assert_eq!(
        rejected
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    );
    rejected
        .record_operation_outcome(
            &claim,
            OperationOutcome::Returned {
                result: OperationResult::Failure {
                    diagnostic: "configuration revision changed".into(),
                },
            },
        )
        .await
        .unwrap();
    rejected
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);

    let (_foreign_directory, foreign) = open().await;
    assert!(matches!(
        root.prepare_plugin_data_batch(&namespace, vec![source()], &foreign.data_writer().unwrap()),
        Err(StoreError::InvalidTransition(_))
    ));
    foreign.close().await.unwrap();
    root.close().await.unwrap();
}

struct MetadataDomain {
    busy: bool,
    digest: Option<String>,
}
impl Statement for MetadataDomain {
    type Value = ();
    type Output = ();
    const PREPARE_OFF_THREAD: bool = true;
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.digest = Some(source_digest());
        Ok(self)
    }
    fn execute(self, db: &Connection) -> Result<Prepared<()>, StoreError> {
        let title: String = db.query_row(
            "SELECT json_extract(configuration,'$.title') FROM session_control WHERE id='target'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            title, "changed",
            "metadata must precede the concrete domain statement"
        );
        content::put(
            db,
            &self.digest.ok_or_else(|| {
                StoreError::InvalidTransition("metadata domain was not prepared".into())
            })?,
            SOURCE,
        )?;
        if self.busy {
            return Err(StoreError::SessionBusy);
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::SessionBusy)
    }
}

#[tokio::test]
async fn prepared_metadata_allows_live_preferences_but_fences_same_attachment_permission_changes() {
    use maka_sandbox::workspace::{BindingStamp, PermissionBasis};
    let (_directory, root) = open().await;
    let reference = root
        .attach_workspace("fixture", &json!({"selection":"opaque domain workspace"}))
        .await
        .unwrap();
    let session = root
        .create_session(
            "target",
            "original",
            &json!({"title":"original", "workspace":reference, "boundary_revision":0}),
            7,
        )
        .await
        .unwrap();
    let before = root.get_session::<Value>("target").await.unwrap().unwrap();
    let basis = PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: reference.id,
            permission_epoch: 0,
        },
    };
    let (work, effects) = session
        .work_scope(Some(basis))
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let writer = root.data_writer().unwrap();
    let update = |configuration: &mut Value| {
        configuration["title"] = json!("changed");
        Ok(())
    };
    let (choice, abandoned) = root
        .prepare_session_metadata(
            "target",
            before.revision,
            update,
            &writer,
            MetadataDomain {
                busy: false,
                digest: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(choice.revision, before.revision + 1);
    assert_eq!(
        root.get_session::<Value>("target").await.unwrap(),
        Some(before.clone())
    );
    drop(abandoned);
    assert!(matches!(
        root.prepare_session_metadata(
            "target",
            before.revision,
            |configuration: &mut Value| {
                configuration["boundary_revision"] = json!(1);
                Ok(())
            },
            &writer,
            MetadataDomain {
                busy: false,
                digest: None
            }
        )
        .await,
        Err(StoreError::SessionBusy)
    ));
    let (operation, claim) = dispatch(&root, "target").await;
    let (choice, change) = root
        .prepare_session_metadata(
            "target",
            before.revision,
            update,
            &writer,
            MetadataDomain {
                busy: true,
                digest: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        change
            .commit(
                &claim,
                OperationResult::Success {
                    value: serde_json::to_value(choice).unwrap()
                }
            )
            .await,
        Err(StoreError::SessionBusy)
    ));
    assert_eq!(
        root.get_session::<Value>("target").await.unwrap(),
        Some(before.clone())
    );
    assert_eq!(writer.query(Source).await.unwrap(), None);
    assert_eq!(
        operation
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    );
    let (choice, change) = root
        .prepare_session_metadata(
            "target",
            before.revision,
            update,
            &writer,
            MetadataDomain {
                busy: false,
                digest: None,
            },
        )
        .await
        .unwrap();
    let returned = OperationResult::Success {
        value: serde_json::to_value(&choice).unwrap(),
    };
    assert_eq!(
        change
            .commit(&claim, returned.clone())
            .await
            .unwrap()
            .outcome,
        OperationOutcome::Returned { result: returned }
    );
    assert_eq!(
        root.get_session::<Value>("target").await.unwrap(),
        Some(choice.clone())
    );
    assert_eq!(writer.query(Source).await.unwrap().as_deref(), Some(SOURCE));
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);
    effects.settle().await.unwrap();
    work.finish();
    let (operation, claim) = dispatch(&root, "target").await;
    let (permission, change) = root
        .prepare_session_metadata(
            "target",
            choice.revision,
            |configuration: &mut Value| {
                configuration["boundary_revision"] = json!(1);
                Ok(())
            },
            &writer,
            MetadataDomain {
                busy: false,
                digest: None,
            },
        )
        .await
        .unwrap();
    change
        .commit(
            &claim,
            OperationResult::Success {
                value: serde_json::to_value(&permission).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        permission.configuration["workspace"],
        choice.configuration["workspace"]
    );
    assert_eq!(permission.configuration["boundary_revision"], 1);
    assert!(matches!(
        session.work_scope(Some(basis)).await,
        Err(StoreError::PermissionRevoked)
    ));
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);
    root.close().await.unwrap();
}
