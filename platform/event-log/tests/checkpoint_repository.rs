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

#![cfg(unix)]

use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    checkpoints::{
        Head, HistorySnapshot, ObjectRef, PublicationRequest, PublicationState, Scope,
        repository::{
            Binding, BoundHead, Commit, CommitReceipt, SessionIdentity, SessionRepository, Source,
            Storage, VerifiedCheckpoint, files::FileRepository,
        },
    },
    connection::BoxFuture,
    root::{RootNamespaces, RootOwner},
};
use maka_plugin_core::composition::InstanceId;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;

fn scope() -> Scope {
    Scope {
        state_domain: "a".repeat(64),
        deployment: Uuid::from_u128(1),
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
    }
}
fn reference(bytes: &[u8]) -> ObjectRef {
    ObjectRef {
        digest: hex::encode(Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    }
}
fn request() -> PublicationRequest {
    PublicationRequest {
        operation: Uuid::new_v4(),
        fingerprint: "b".repeat(64),
        expected_revision: None,
        confirmed_subtree_digest: "c".repeat(64),
        history: HistorySnapshot {
            object: reference(b"history"),
            inventory: vec![],
            cut: vec![],
        },
        workspace: None,
    }
}
fn material() -> fs::File {
    let mut f = tempfile::tempfile().unwrap();
    f.write_all(b"history").unwrap();
    f
}
fn owner(base: &Path, create: bool) -> Arc<RootOwner> {
    let namespaces = RootNamespaces {
        ownership: base.join("ownership"),
        control: base.join("control"),
    };
    Arc::new(
        if create {
            RootOwner::create(&base.join("root"), &namespaces)
        } else {
            RootOwner::open(&base.join("root"), &namespaces)
        }
        .unwrap(),
    )
}
async fn open(base: &Path, create: bool, storage: Option<Storage>) -> RootStore {
    RootStore::open_with_checkpoint_storage(owner(base, create), ROOT_MIGRATIONS, storage)
        .await
        .unwrap()
}
async fn session(store: &RootStore) {
    store
        .create_session("session", "create", &json!({"title":"fixture"}), 1)
        .await
        .unwrap();
}
fn head(state: PublicationState) -> Head {
    match state {
        PublicationState::Published { head } => head,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn exact_checkout_rejects_an_intact_manifest_from_another_session() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let storage = repo.storage(Uuid::new_v4()).unwrap();
    let store = open(base.path(), true, Some(storage.clone())).await;
    session(&store).await;
    store
        .create_session("other", "create-other", &json!({}), 1)
        .await
        .unwrap();
    let a = store.history_checkpoints("session", scope()).await.unwrap();
    let b = store.history_checkpoints("other", scope()).await.unwrap();
    let binding = a.binding().await.unwrap();
    let mut saved = head(a.publish(request(), material()).await.unwrap().state);
    let other = head(b.publish(request(), material()).await.unwrap().state);
    VerifiedCheckpoint::verify(repo.objects().as_ref(), other.manifest.clone()).unwrap();
    saved.manifest = other.manifest;
    let db = rusqlite::Connection::open(external.path().join("repository.sqlite")).unwrap();
    db.execute(
        "UPDATE checkpoint_repository_heads SET head_json=? WHERE session_id=?",
        rusqlite::params![
            serde_json::to_string(&saved).unwrap(),
            binding.identity.session.to_string()
        ],
    )
    .unwrap();
    let result = storage
        .checkout_exact(binding.identity, saved.revision)
        .await;
    store.shutdown().await.unwrap();
    assert!(
        result.is_err(),
        "an intact foreign Manifest must not pass logical Session checkout"
    );
}

#[tokio::test]
async fn local_recovery_reverifies_material_after_fresh_capture_loses_its_witness() {
    for missing in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let store = open(base.path(), true, None).await;
        session(&store).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let original = request();
        let db_path = base
            .path()
            .join("root")
            .join(maka_event_log::root::ROOT_DATABASE);
        let db = rusqlite::Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TRIGGER fail_head BEFORE INSERT ON history_checkpoint_heads BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(history.publish(original.clone(), material()).await.is_err());
        assert!(matches!(
            history
                .receipt(original.clone())
                .await
                .unwrap()
                .unwrap()
                .state,
            PublicationState::Prepared { .. }
        ));
        store.shutdown().await.unwrap();
        drop(history);
        drop(store);
        db.execute_batch("DROP TRIGGER fail_head").unwrap();
        drop(db);
        if missing {
            fs::remove_file(
                base.path()
                    .join("root/history-checkpoints/objects")
                    .join(&original.history.object.digest),
            )
            .unwrap();
        }
        let store = open(base.path(), false, None).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let result = history.receipt(original).await.unwrap().unwrap();
        if missing {
            assert!(matches!(result.state, PublicationState::Unavailable { .. }));
            assert!(history.read_head().await.unwrap().is_none());
        } else {
            assert_eq!(history.read_head().await.unwrap(), Some(head(result.state)));
        }
        store.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn local_capture_rejects_corrupt_deduplicated_objects_without_advancing_head() {
    let base = tempfile::tempdir().unwrap();
    let store = open(base.path(), true, None).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let mut next = request();
    let saved = head(
        history
            .publish(next.clone(), material())
            .await
            .unwrap()
            .state,
    );
    fs::write(
        base.path()
            .join("root/history-checkpoints/objects")
            .join(&next.history.object.digest),
        b"corrupt",
    )
    .unwrap();
    next.operation = Uuid::new_v4();
    next.expected_revision = Some(saved.revision);
    assert!(history.publish(next, material()).await.is_err());
    assert_eq!(history.read_head().await.unwrap(), Some(saved));
    store.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "manual local capture I/O baseline: 3 fresh 100 MiB workspaces"]
async fn local_workspace_capture_baseline() {
    use maka_event_log::checkpoints::{WorkspaceCapture, WorkspaceConsistency};
    for sample in 0..3 {
        let base = tempfile::tempdir().unwrap();
        let store = open(base.path(), true, None).await;
        session(&store).await;
        let source = base.path().join("project");
        fs::create_dir(&source).unwrap();
        for index in 0..10u8 {
            fs::write(
                source.join(format!("file-{index}.bin")),
                vec![index; 10 * 1024 * 1024],
            )
            .unwrap();
        }
        let workspace = store
            .workspace(
                cap_std::fs::Dir::open_ambient_dir(&source, cap_std::ambient_authority()).unwrap(),
            )
            .await
            .unwrap();
        let fence = store.fence_workspace(&workspace).await.unwrap();
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let mut publication = request();
        publication.workspace = Some(WorkspaceCapture {
            root: source,
            consistency: WorkspaceConsistency::CallerConfirmedQuiescent,
        });
        let started = std::time::Instant::now();
        let saved = head(
            history
                .publish_fenced(publication, material(), &fence)
                .await
                .unwrap()
                .state,
        );
        eprintln!(
            "local capture sample={sample} files=10 bytes=104857600 elapsed_ms={}",
            started.elapsed().as_millis()
        );
        drop(fence);
        history.checkout_exact(saved.revision).await.unwrap();
        store.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn local_and_shared_publication_use_the_same_behavior_contract() {
    for shared in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let repo = FileRepository::open(external.path()).unwrap();
        let agent = Uuid::new_v4();
        let storage = shared.then(|| repo.storage(agent).unwrap());
        let store = open(base.path(), true, storage.clone()).await;
        session(&store).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let binding = history.binding().await.unwrap();
        let original = request();
        let r1 = head(
            history
                .publish(original.clone(), material())
                .await
                .unwrap()
                .state,
        );
        assert_eq!(history.read_head().await.unwrap(), Some(r1.clone()));
        let mut bytes = String::new();
        history
            .checkout_exact(r1.revision)
            .await
            .unwrap()
            .snapshot
            .read_to_string(&mut bytes)
            .unwrap();
        assert_eq!(bytes, "history");
        assert_eq!(
            head(
                history
                    .publish(original.clone(), material())
                    .await
                    .unwrap()
                    .state
            ),
            r1
        );
        let mut different = original.clone();
        different.fingerprint = "d".repeat(64);
        assert!(history.publish(different, material()).await.is_err());
        let conflict = request();
        assert!(
            matches!(history.publish(conflict.clone(),material()).await.unwrap().state,PublicationState::Conflict {actual:Some(r)} if r==r1.revision)
        );
        let mut next = request();
        next.expected_revision = Some(r1.revision);
        let r2 = head(history.publish(next, material()).await.unwrap().state);
        assert_ne!(r1.revision, r2.revision);
        assert!(history.checkout_exact(r1.revision).await.is_err());
        assert_eq!(
            head(
                history
                    .receipt(original.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .state
            ),
            r1
        );
        let mut wrong_scope = scope();
        wrong_scope.deployment = Uuid::new_v4();
        assert!(
            store
                .history_checkpoints("session", wrong_scope)
                .await
                .unwrap()
                .read_head()
                .await
                .is_err()
        );
        store.shutdown().await.unwrap();
        assert!(history.read_head().await.is_err());
        drop(history);
        drop(store);
        let store = open(base.path(), false, storage.clone()).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        assert_eq!(history.binding().await.unwrap(), binding);
        assert_eq!(history.read_head().await.unwrap(), Some(r2.clone()));
        if let Some(storage) = storage {
            store.shutdown().await.unwrap();
            drop(history);
            drop(store);
            fs::remove_dir_all(base.path()).unwrap();
            let mut checked = storage
                .checkout_exact(binding.identity.clone(), r2.revision)
                .await
                .unwrap();
            let mut content = String::new();
            checked.snapshot.read_to_string(&mut content).unwrap();
            assert_eq!(content, "history");
            let mut wrong = binding.identity.clone();
            wrong.agent = Uuid::new_v4();
            assert!(storage.checkout_exact(wrong, r2.revision).await.is_err());
            fs::write(
                external.path().join("objects").join(&r2.manifest.digest),
                b"corrupt",
            )
            .unwrap();
            assert!(
                storage
                    .checkout_exact(binding.identity, r2.revision)
                    .await
                    .is_err()
            );
        } else {
            store.shutdown().await.unwrap();
        }
    }
}

struct LoseReply {
    inner: FileRepository,
    lose: AtomicBool,
}
impl SessionRepository for LoseReply {
    fn identity(&self) -> &str {
        self.inner.identity()
    }
    fn object_store_identity(&self) -> &str {
        self.inner.object_store_identity()
    }
    fn lookup(&self, s: Source, a: Uuid) -> BoxFuture<'_, Result<Option<Binding>, StoreError>> {
        self.inner.lookup(s, a)
    }
    fn bind(&self, s: Source, a: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>> {
        self.inner.bind(s, a)
    }
    fn read_head(
        &self,
        s: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<BoundHead>, StoreError>> {
        self.inner.read_head(s)
    }
    fn receipt(&self, c: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        self.inner.receipt(c)
    }
    fn commit(
        &self,
        c: Commit,
        v: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        Box::pin(async move {
            let result = self.inner.commit(c, v).await?;
            if self.lose.swap(false, Ordering::SeqCst) {
                Err(StoreError::OperationUnknown)
            } else {
                Ok(result)
            }
        })
    }
}
#[tokio::test]
async fn lost_commit_reply_recovers_original_head_without_recapture_or_local_fallback() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let agent = Uuid::new_v4();
    let storage = Storage::new(
        repo.objects(),
        Arc::new(LoseReply {
            inner: repo.clone(),
            lose: AtomicBool::new(true),
        }),
        agent,
    )
    .unwrap();
    let store = open(base.path(), true, Some(storage)).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let original = request();
    let database = rusqlite::Connection::open(external.path().join("repository.sqlite")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON checkpoint_repository_receipts
             BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;",
        )
        .unwrap();
    assert!(history.publish(original.clone(), material()).await.is_err());
    let binding = history.binding().await.unwrap();
    assert!(
        repo.read_head(binding.identity.clone())
            .await
            .unwrap()
            .is_none()
    );
    let receipts: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM checkpoint_repository_receipts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);
    database.execute_batch("DROP TRIGGER fail_receipt").unwrap();
    drop(database);
    assert!(history.publish(original.clone(), material()).await.is_err());
    let committed = repo
        .read_head(binding.identity.clone())
        .await
        .unwrap()
        .unwrap()
        .head;
    assert_eq!(
        head(
            history
                .receipt(original.clone())
                .await
                .unwrap()
                .unwrap()
                .state
        ),
        committed
    );
    store.shutdown().await.unwrap();
    drop(history);
    drop(store);
    let reopened = RootStore::open(owner(base.path(), false), ROOT_MIGRATIONS).await;
    assert!(reopened.is_err());
    drop(reopened);
    let store = open(base.path(), false, Some(repo.storage(agent).unwrap())).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    assert_eq!(
        head(history.receipt(original).await.unwrap().unwrap().state),
        committed
    );
    assert_eq!(
        repo.read_head(binding.identity)
            .await
            .unwrap()
            .map(|bound| bound.head),
        Some(committed)
    );
    store.shutdown().await.unwrap();
}

#[test]
fn commit_child() {
    let Ok(directory) = std::env::var("MAKA_REPOSITORY_CHILD") else {
        return;
    };
    let request: Commit = serde_json::from_slice(
        &fs::read(std::env::var("MAKA_REPOSITORY_REQUEST").unwrap()).unwrap(),
    )
    .unwrap();
    let repo = FileRepository::open(Path::new(&directory)).unwrap();
    let verified =
        VerifiedCheckpoint::verify(repo.objects().as_ref(), request.manifest.clone()).unwrap();
    println!("READY");
    std::io::stdout().flush().unwrap();
    let mut go = String::new();
    std::io::stdin().read_line(&mut go).unwrap();
    assert_eq!(go.trim(), "go");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            repo.commit(request, verified).await.unwrap();
        });
    // Deliberately lose the reply after a real durable commit.
    std::process::exit(86);
}
#[tokio::test]
async fn independent_processes_arbitrate_and_replay_the_original_commit() {
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let agent = Uuid::new_v4();
    let source = Source {
        root_id: "a".repeat(64),
        scope: scope(),
        session: "source".into(),
    };
    let binding = repo.bind(source.clone(), agent).await.unwrap();
    assert_eq!(
        FileRepository::open(external.path())
            .unwrap()
            .bind(source.clone(), agent)
            .await
            .unwrap(),
        binding
    );
    assert!(repo.bind(source, Uuid::new_v4()).await.is_err());
    let objects = repo.objects();
    let object = objects.put(&mut &b"history"[..]).unwrap();
    let manifest = maka_event_log::checkpoints::Manifest {
        root_id: binding.source.root_id.clone(),
        scope: scope(),
        session_id: "source".into(),
        history: HistorySnapshot {
            object,
            inventory: vec![],
            cut: vec![],
        },
        workspace: None,
    };
    let manifest = objects
        .put(&mut &serde_json::to_vec(&manifest).unwrap()[..])
        .unwrap();
    let requests: Vec<_> = (0..2)
        .map(|_| Commit {
            binding: binding.clone(),
            operation: Uuid::new_v4(),
            fingerprint: "f".repeat(64),
            expected_revision: None,
            manifest: manifest.clone(),
        })
        .collect();
    let mut children = vec![];
    for (i, request) in requests.iter().enumerate() {
        let file = external.path().join(format!("request-{i}.json"));
        fs::write(&file, serde_json::to_vec(request).unwrap()).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "commit_child", "--nocapture"])
            .env("MAKA_REPOSITORY_CHILD", external.path())
            .env("MAKA_REPOSITORY_REQUEST", file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(child.stdout.take().unwrap());
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line.trim().ends_with("READY") {
                    break;
                }
            }
        })
        .await
        .expect("repository child reached commit barrier");
        children.push(child);
    }
    for child in &mut children {
        use tokio::io::AsyncWriteExt;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"go\n")
            .await
            .unwrap();
    }
    for child in &mut children {
        let status = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait())
            .await
            .expect("repository child completed")
            .unwrap();
        assert_eq!(status.code(), Some(86));
    }
    let restarted = FileRepository::open(external.path()).unwrap();
    let mut winners = 0;
    for request in requests {
        let receipt = restarted.receipt(request.clone()).await.unwrap().unwrap();
        if matches!(receipt, CommitReceipt::Published { .. }) {
            winners += 1;
        }
        let verified = VerifiedCheckpoint::verify(objects.as_ref(), manifest.clone()).unwrap();
        assert_eq!(
            restarted.commit(request.clone(), verified).await.unwrap(),
            receipt
        );
        let mut different = request;
        different.fingerprint = "e".repeat(64);
        assert!(restarted.receipt(different).await.is_err());
    }
    assert_eq!(winners, 1);
}

#[tokio::test]
async fn workspace_closure_survives_source_removal_and_missing_objects_are_rejected() {
    use maka_event_log::checkpoints::{WorkspaceCapture, WorkspaceConsistency};
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let storage = repo.storage(Uuid::new_v4()).unwrap();
    let store = open(base.path(), true, Some(storage.clone())).await;
    session(&store).await;
    let source = base.path().join("project");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("answer.txt"), b"saved answer").unwrap();
    let workspace = store
        .workspace(
            cap_std::fs::Dir::open_ambient_dir(&source, cap_std::ambient_authority()).unwrap(),
        )
        .await
        .unwrap();
    let fence = store.fence_workspace(&workspace).await.unwrap();
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let mut publication = request();
    publication.workspace = Some(WorkspaceCapture {
        root: source.clone(),
        consistency: WorkspaceConsistency::CallerConfirmedQuiescent,
    });
    let saved = head(
        history
            .publish_fenced(publication, material(), &fence)
            .await
            .unwrap()
            .state,
    );
    drop(fence);
    fs::write(source.join("answer.txt"), b"later edit").unwrap();
    let binding = history.binding().await.unwrap();
    let checked = storage
        .checkout_exact(binding.identity.clone(), saved.revision)
        .await
        .unwrap();
    let manifest = checked.manifest.workspace.unwrap();
    let inventory: serde_json::Value =
        serde_json::from_reader(repo.objects().read(&manifest.inventory).unwrap()).unwrap();
    let object: ObjectRef =
        serde_json::from_value(inventory["entries"][0]["object"].clone()).unwrap();
    let mut content = String::new();
    repo.objects()
        .read(&object)
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "saved answer");
    let db = rusqlite::Connection::open_with_flags(
        base.path()
            .join("root")
            .join(maka_event_log::root::ROOT_DATABASE),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let local_heads: i64 = db
        .query_row("SELECT count(*) FROM history_checkpoint_heads", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(local_heads, 0);
    drop(db);
    store.shutdown().await.unwrap();
    drop(history);
    drop(store);
    fs::remove_dir_all(base.path()).unwrap();
    assert!(
        storage
            .checkout_exact(binding.identity.clone(), saved.revision)
            .await
            .is_ok()
    );
    fs::remove_file(external.path().join("objects").join(object.digest)).unwrap();
    assert!(
        storage
            .checkout_exact(binding.identity, saved.revision)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn invalid_payload_and_unverified_manifest_cannot_advance_head() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let agent = Uuid::new_v4();
    let store = open(base.path(), true, Some(repo.storage(agent).unwrap())).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let binding = history.binding().await.unwrap();
    let mut wrong = request();
    wrong.history.object = reference(b"different history");
    assert!(history.publish(wrong, material()).await.is_err());
    assert!(
        repo.read_head(binding.identity.clone())
            .await
            .unwrap()
            .is_none()
    );
    let absent = reference(b"missing history");
    let manifest = maka_event_log::checkpoints::Manifest {
        root_id: binding.source.root_id.clone(),
        scope: scope(),
        session_id: "session".into(),
        history: HistorySnapshot {
            object: absent,
            inventory: vec![],
            cut: vec![],
        },
        workspace: None,
    };
    let reference = repo
        .objects()
        .put(&mut &serde_json::to_vec(&manifest).unwrap()[..])
        .unwrap();
    assert!(VerifiedCheckpoint::verify(repo.objects().as_ref(), reference).is_err());
    assert!(repo.read_head(binding.identity).await.unwrap().is_none());
    store.shutdown().await.unwrap();
}

struct ReadBarrier {
    inner: Arc<dyn maka_event_log::checkpoints::repository::ImmutableObjectStore>,
    entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl maka_event_log::checkpoints::repository::ImmutableObjectStore for ReadBarrier {
    fn identity(&self) -> &str {
        self.inner.identity()
    }
    fn put(&self, source: &mut dyn Read) -> Result<ObjectRef, StoreError> {
        self.inner.put(source)
    }
    fn read(&self, reference: &ObjectRef) -> Result<fs::File, StoreError> {
        let entered = self.entered.lock().unwrap().take();
        if let Some(entered) = entered {
            entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(30))
                .map_err(|e| StoreError::InvalidTransition(e.to_string()))?;
        }
        self.inner.read(reference)
    }
}
#[tokio::test]
async fn exact_checkout_rejects_head_movement_during_object_verification() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let agent = Uuid::new_v4();
    let store = open(base.path(), true, Some(repo.storage(agent).unwrap())).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let binding = history.binding().await.unwrap();
    let saved = head(history.publish(request(), material()).await.unwrap().state);
    let (entered, wait) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let objects = Arc::new(ReadBarrier {
        inner: repo.objects(),
        entered: std::sync::Mutex::new(Some(entered)),
        release: std::sync::Mutex::new(released),
    });
    let storage = Storage::new(objects, Arc::new(repo.clone()), agent).unwrap();
    let identity = binding.identity.clone();
    let reading =
        tokio::spawn(async move { storage.checkout_exact(identity, saved.revision).await });
    tokio::time::timeout(std::time::Duration::from_secs(30), wait)
        .await
        .unwrap()
        .unwrap();
    let commit = Commit {
        binding,
        operation: Uuid::new_v4(),
        fingerprint: "e".repeat(64),
        expected_revision: Some(saved.revision),
        manifest: saved.manifest.clone(),
    };
    let verified = VerifiedCheckpoint::verify(repo.objects().as_ref(), saved.manifest).unwrap();
    let result = repo.commit(commit, verified).await;
    release.send(()).unwrap();
    assert!(matches!(result.unwrap(), CommitReceipt::Published { .. }));
    assert!(reading.await.unwrap().is_err());
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn verified_bytes_cannot_be_committed_under_a_different_source() {
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let source = Source {
        root_id: "a".repeat(64),
        scope: scope(),
        session: "original".into(),
    };
    let agent = Uuid::new_v4();
    let original = repo.bind(source.clone(), agent).await.unwrap();
    let other = repo
        .bind(
            Source {
                session: "other".into(),
                ..source
            },
            agent,
        )
        .await
        .unwrap();
    let objects = repo.objects();
    let body = objects.put(&mut &b"history"[..]).unwrap();
    let manifest = maka_event_log::checkpoints::Manifest {
        root_id: original.source.root_id,
        scope: scope(),
        session_id: "original".into(),
        history: HistorySnapshot {
            object: body,
            inventory: vec![],
            cut: vec![],
        },
        workspace: None,
    };
    let manifest = objects
        .put(&mut &serde_json::to_vec(&manifest).unwrap()[..])
        .unwrap();
    let verified = VerifiedCheckpoint::verify(objects.as_ref(), manifest.clone()).unwrap();
    let wrong = Commit {
        binding: other.clone(),
        operation: Uuid::new_v4(),
        fingerprint: "b".repeat(64),
        expected_revision: None,
        manifest,
    };
    assert!(repo.commit(wrong, verified).await.is_err());
    assert!(repo.read_head(other.identity).await.unwrap().is_none());
    let unrelated = tempfile::tempdir().unwrap();
    let unrelated = FileRepository::open(unrelated.path()).unwrap();
    assert!(Storage::new(unrelated.objects(), Arc::new(repo), agent).is_err());
}

#[tokio::test]
async fn head_lookup_does_not_claim_an_unpublished_sessions_scope() {
    for shared in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let repo = FileRepository::open(external.path()).unwrap();
        let store = open(
            base.path(),
            true,
            shared.then(|| repo.storage(Uuid::new_v4()).unwrap()),
        )
        .await;
        session(&store).await;
        let mut probe_scope = scope();
        probe_scope.deployment = Uuid::new_v4();
        let probe = store
            .history_checkpoints("session", probe_scope)
            .await
            .unwrap();
        assert!(probe.read_head().await.unwrap().is_none());
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let saved = head(history.publish(request(), material()).await.unwrap().state);
        assert_eq!(history.read_head().await.unwrap(), Some(saved));
        assert!(probe.read_head().await.is_err());
        store.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn shared_binding_rejects_a_scope_different_from_the_published_source() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let store = open(
        base.path(),
        true,
        Some(repo.storage(Uuid::new_v4()).unwrap()),
    )
    .await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    history.publish(request(), material()).await.unwrap();
    let original = history.binding().await.unwrap();
    let mut wrong_scope = scope();
    wrong_scope.deployment = Uuid::new_v4();
    let wrong = store
        .history_checkpoints("session", wrong_scope)
        .await
        .unwrap();
    assert!(wrong.binding().await.is_err());
    assert_eq!(history.binding().await.unwrap(), original);
    store.shutdown().await.unwrap();
}

struct TemporaryReadFailure {
    inner: Arc<dyn maka_event_log::checkpoints::repository::ImmutableObjectStore>,
    fail: AtomicBool,
}
impl maka_event_log::checkpoints::repository::ImmutableObjectStore for TemporaryReadFailure {
    fn identity(&self) -> &str {
        self.inner.identity()
    }
    fn put(&self, source: &mut dyn Read) -> Result<ObjectRef, StoreError> {
        self.inner.put(source)
    }
    fn read(&self, reference: &ObjectRef) -> Result<fs::File, StoreError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "temporary object-store timeout",
            )
            .into());
        }
        self.inner.read(reference)
    }
}
#[tokio::test]
async fn temporary_object_read_failure_keeps_original_publication_recoverable() {
    let base = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let repo = FileRepository::open(external.path()).unwrap();
    let agent = Uuid::new_v4();
    let storage = Storage::new(
        Arc::new(TemporaryReadFailure {
            inner: repo.objects(),
            fail: AtomicBool::new(true),
        }),
        Arc::new(repo.clone()),
        agent,
    )
    .unwrap();
    let store = open(base.path(), true, Some(storage)).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let original = request();
    assert!(history.publish(original.clone(), material()).await.is_err());
    assert!(matches!(
        history
            .receipt(original.clone())
            .await
            .unwrap()
            .unwrap()
            .state,
        PublicationState::Prepared { .. }
    ));
    assert!(history.read_head().await.unwrap().is_none());
    store.shutdown().await.unwrap();
    drop(history);
    drop(store);
    let store = open(base.path(), false, Some(repo.storage(agent).unwrap())).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let recovered = head(
        history
            .receipt(original.clone())
            .await
            .unwrap()
            .unwrap()
            .state,
    );
    let wrong_material = tempfile::tempfile().unwrap();
    assert_eq!(
        head(
            history
                .publish(original, wrong_material)
                .await
                .unwrap()
                .state
        ),
        recovered
    );
    assert_eq!(history.read_head().await.unwrap(), Some(recovered));
    store.shutdown().await.unwrap();
}

#[test]
fn rejecting_an_unrelated_database_does_not_change_its_journal_mode() {
    let external = tempfile::tempdir().unwrap();
    let path = external.path().join("repository.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE unrelated(value); INSERT INTO unrelated VALUES(42);")
        .unwrap();
    drop(db);
    assert!(matches!(
        FileRepository::open(external.path()),
        Err(StoreError::UnsupportedDatabase)
    ));
    let db = rusqlite::Connection::open(&path).unwrap();
    let mode: String = db
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    let value: i64 = db
        .query_row("SELECT value FROM unrelated", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, 42);
}

#[test]
fn concurrent_repository_initialization_agrees_on_one_identity() {
    let external = tempfile::tempdir().unwrap();
    let start = std::sync::Barrier::new(8);
    std::thread::scope(|threads| {
        let clients: Vec<_> = (0..8)
            .map(|_| {
                threads.spawn(|| {
                    start.wait();
                    FileRepository::open(external.path())
                })
            })
            .collect();
        let clients: Vec<_> = clients.into_iter().map(|c| c.join().unwrap()).collect();
        assert!(
            clients.iter().all(Result::is_ok),
            "{:?}",
            clients
                .iter()
                .filter_map(|r| r.as_ref().err())
                .collect::<Vec<_>>()
        );
        let identity = clients[0].as_ref().unwrap().identity();
        assert!(
            clients
                .iter()
                .all(|r| r.as_ref().unwrap().identity() == identity)
        );
    });
}

#[tokio::test]
async fn legacy_local_head_remains_readable_and_accepts_a_successor() {
    let base = tempfile::tempdir().unwrap();
    let store = open(base.path(), true, None).await;
    session(&store).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    let original = request();
    let saved = head(
        history
            .publish(original.clone(), material())
            .await
            .unwrap()
            .state,
    );
    store.shutdown().await.unwrap();
    drop(history);
    drop(store);
    // Model a pre-repository Root: its existing Head and publication receipt are retained.
    let db = rusqlite::Connection::open(
        base.path()
            .join("root")
            .join(maka_event_log::root::ROOT_DATABASE),
    )
    .unwrap();
    db.execute_batch(
        "DELETE FROM checkpoint_repository_sources;
        DELETE FROM checkpoint_repository_sessions;
        DELETE FROM checkpoint_repository_receipts;
        DELETE FROM checkpoint_repository_settings;",
    )
    .unwrap();
    drop(db);
    let store = open(base.path(), false, None).await;
    let history = store.history_checkpoints("session", scope()).await.unwrap();
    assert_eq!(history.read_head().await.unwrap(), Some(saved.clone()));
    let mut bytes = String::new();
    history
        .checkout_exact(saved.revision)
        .await
        .unwrap()
        .snapshot
        .read_to_string(&mut bytes)
        .unwrap();
    assert_eq!(bytes, "history");
    assert_eq!(
        head(history.receipt(original).await.unwrap().unwrap().state),
        saved
    );
    let mut next = request();
    next.expected_revision = Some(saved.revision);
    let successor = head(history.publish(next, material()).await.unwrap().state);
    assert_ne!(successor.revision, saved.revision);
    assert_eq!(history.read_head().await.unwrap(), Some(successor));
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn execution_bootstrap_preserves_unique_head_and_cannot_downgrade_authority() {
    use maka_event_log::checkpoints::execution::{
        Claim, ClaimResult, Execution, ExecutionAuthority, Permissions,
    };
    for shared in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let repo = Arc::new(FileRepository::open(external.path()).unwrap());
        let agent = Uuid::new_v4();
        let plain = repo.storage(agent).unwrap();
        let store = open(base.path(), true, shared.then_some(plain.clone())).await;
        session(&store).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        let (binding, start) = if shared {
            let binding = history.binding().await.unwrap();
            let revision =
                head(history.publish(request(), material()).await.unwrap().state).revision;
            (binding, Some(revision))
        } else {
            let source = Source {
                root_id: store.owned_root().unwrap().root_id().into(),
                scope: scope(),
                session: "session".into(),
            };
            (repo.bind(source, agent).await.unwrap(), None)
        };
        store.shutdown().await.unwrap();
        drop(history);
        drop(store);
        let ClaimResult::Granted { grant, .. } = repo
            .claim(Claim {
                activation: Uuid::new_v4(),
                binding: binding.clone(),
                start,
                permissions: Permissions {
                    sandbox: maka_sandbox::Sandbox::Disabled,
                    tools: None,
                },
                lease_millis: 60_000,
            })
            .await
            .unwrap()
        else {
            panic!("claim rejected");
        };
        let grant = *grant;
        let execution = Execution::attach(repo.clone(), grant.clone())
            .await
            .unwrap();
        let storage = plain.clone().with_execution(execution.clone()).unwrap();
        let store = open(base.path(), false, Some(storage)).await;
        let history = store.history_checkpoints("session", scope()).await.unwrap();
        assert_eq!(history.binding().await.unwrap(), binding);
        let mut next = request();
        next.expected_revision = start;
        let saved = head(history.publish(next, material()).await.unwrap().state);
        assert_eq!(
            repo.read_head(binding.identity.clone())
                .await
                .unwrap()
                .unwrap()
                .head,
            saved
        );
        // Local fail-closed cancellation alone must fence commits, even if the
        // control service still observes an active generation.
        execution.cancellation().cancel();
        let mut denied = request();
        denied.expected_revision = Some(saved.revision);
        assert!(history.publish(denied, material()).await.is_err());
        assert_eq!(
            repo.read_head(binding.identity)
                .await
                .unwrap()
                .unwrap()
                .head,
            saved
        );
        store.shutdown().await.unwrap();
        drop(history);
        drop(store);
        for storage in [None, Some(plain)] {
            assert!(
                RootStore::open_with_checkpoint_storage(
                    owner(base.path(), false),
                    ROOT_MIGRATIONS,
                    storage
                )
                .await
                .is_err(),
                "execution configuration cannot silently fall back to an unrestricted repository"
            );
        }
        repo.revoke(grant).await.unwrap();
    }
}
