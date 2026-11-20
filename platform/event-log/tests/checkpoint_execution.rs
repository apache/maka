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
    StoreError,
    checkpoints::{
        HistorySnapshot, Manifest, ObjectRef, Scope,
        execution::{
            Claim, ClaimResult, Environment, Execution, ExecutionAuthority, Grant, Permissions,
            Renewal, Status,
        },
        repository::{
            Binding, Commit, CommitReceipt, SessionRepository, Source, VerifiedCheckpoint,
            files::FileRepository,
        },
    },
    connection::BoxFuture,
};
use maka_plugin_core::composition::InstanceId;
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use uuid::Uuid;

struct Fixture {
    directory: tempfile::TempDir,
    repository: FileRepository,
    binding: Binding,
    manifest: ObjectRef,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repository = FileRepository::open(directory.path()).unwrap();
        let source = Source {
            root_id: "a".repeat(64),
            session: "native-session".into(),
            scope: Scope {
                state_domain: "a".repeat(64),
                deployment: Uuid::new_v4(),
                namespace: InstanceId(vec![Uuid::new_v4()]),
            },
        };
        let binding = repository
            .bind(source.clone(), Uuid::new_v4())
            .await
            .unwrap();
        let objects = repository.objects();
        let history = objects.put(&mut &b"immutable history"[..]).unwrap();
        let manifest = Manifest {
            root_id: source.root_id,
            scope: source.scope,
            session_id: source.session,
            history: HistorySnapshot {
                object: history,
                inventory: vec![],
                cut: vec![],
            },
            workspace: None,
        };
        let manifest = objects
            .put(&mut &serde_json::to_vec(&manifest).unwrap()[..])
            .unwrap();
        Self {
            directory,
            repository,
            binding,
            manifest,
        }
    }
    fn claim(&self) -> Claim {
        Claim {
            activation: Uuid::new_v4(),
            binding: self.binding.clone(),
            start: None,
            permissions: Permissions {
                sandbox: maka_sandbox::Sandbox::Disabled,
                tools: Some(vec!["read_file".into()]),
            },
            lease_millis: 60_000,
        }
    }
    async fn grant(&self) -> Grant {
        granted(self.repository.claim(self.claim()).await.unwrap())
    }
    fn commit(&self) -> Commit {
        Commit {
            binding: self.binding.clone(),
            operation: Uuid::new_v4(),
            fingerprint: "b".repeat(64),
            expected_revision: None,
            manifest: self.manifest.clone(),
        }
    }
    fn verified(&self) -> VerifiedCheckpoint {
        VerifiedCheckpoint::verify(self.repository.objects().as_ref(), self.manifest.clone())
            .unwrap()
    }
}
fn granted(result: ClaimResult) -> Grant {
    match result {
        ClaimResult::Granted { grant, .. } => *grant,
        other => panic!("{other:?}"),
    }
}
struct FailedStop;
impl Environment for FailedStop {
    fn stop_and_drain(&self, _: &Grant) -> BoxFuture<'_, Result<(), StoreError>> {
        Box::pin(async {
            Err(StoreError::CleanupUnconfirmed(
                "worker is unreachable".into(),
            ))
        })
    }
}
struct ProcessEnvironment {
    grant: Grant,
    child: tokio::sync::Mutex<tokio::process::Child>,
}
impl Environment for ProcessEnvironment {
    fn stop_and_drain(&self, grant: &Grant) -> BoxFuture<'_, Result<(), StoreError>> {
        let matches = grant == &self.grant;
        Box::pin(async move {
            assert!(matches);
            let mut child = self.child.lock().await;
            child.kill().await?;
            let status = child.wait().await?;
            assert!(!status.success());
            Ok(())
        })
    }
}
async fn environment(grant: Grant) -> ProcessEnvironment {
    use tokio::io::AsyncBufReadExt;
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "echo ready; read command"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    tokio::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .await
        .unwrap();
    assert_eq!(line.trim(), "ready");
    ProcessEnvironment {
        grant,
        child: tokio::sync::Mutex::new(child),
    }
}

#[tokio::test]
async fn claim_is_durable_and_replay_does_not_reissue_or_change_permissions() {
    let f = Fixture::new().await;
    let request = f.claim();
    let first = f.repository.claim(request.clone()).await.unwrap();
    let reopened = FileRepository::open(f.directory.path()).unwrap();
    assert_eq!(reopened.claim(request.clone()).await.unwrap(), first);
    let mut changed = request;
    changed.permissions.tools = None;
    assert!(reopened.claim(changed).await.is_err());
    let mut forged = granted(first);
    forged.generation += 1;
    assert!(reopened.observe(forged).await.is_err());
}

#[tokio::test]
async fn claim_requires_exact_head_and_persisted_source() {
    let f = Fixture::new().await;
    let head = match SessionRepository::commit(&f.repository, f.commit(), f.verified())
        .await
        .unwrap()
    {
        CommitReceipt::Published { head } => head,
        _ => panic!(),
    };
    let request = f.claim();
    assert_eq!(
        f.repository.claim(request).await.unwrap(),
        ClaimResult::Conflict {
            actual: Some(head.revision)
        }
    );
    let mut request = f.claim();
    request.start = Some(head.revision);
    request.binding.source.session = "another".into();
    assert!(f.repository.claim(request).await.is_err());
}

#[tokio::test]
async fn expiry_fences_but_never_proves_the_process_stopped() {
    let f = Fixture::new().await;
    let mut request = f.claim();
    request.lease_millis = 1;
    let grant = granted(f.repository.claim(request).await.unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.repository.observe(grant.clone()).await.unwrap() == Status::Draining {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        f.repository.claim(f.claim()).await.unwrap(),
        ClaimResult::Busy
    );
    assert_eq!(
        f.repository
            .renew(Renewal {
                operation: Uuid::new_v4(),
                grant: grant.clone(),
                lease_millis: 60_000
            })
            .await
            .unwrap(),
        Status::Draining
    );
    assert!(
        ExecutionAuthority::commit(&f.repository, grant, f.commit(), f.verified())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn failed_cleanup_blocks_handoff_and_real_process_drain_allows_one_successor() {
    let f = Fixture::new().await;
    let original = f.claim();
    let grant = granted(f.repository.claim(original.clone()).await.unwrap());
    let execution = Execution::attach(Arc::new(f.repository.clone()), grant.clone())
        .await
        .unwrap();
    assert!(execution.stop(&FailedStop).await.is_err());
    assert!(execution.check().await.is_err());
    assert_eq!(
        f.repository.observe(grant.clone()).await.unwrap(),
        Status::Draining
    );
    let rejected = f.claim();
    assert_eq!(
        f.repository.claim(rejected.clone()).await.unwrap(),
        ClaimResult::Busy
    );
    let environment = environment(grant.clone()).await;
    execution.stop(&environment).await.unwrap();
    assert_eq!(
        f.repository.observe(grant.clone()).await.unwrap(),
        Status::Stopped
    );
    assert_eq!(
        f.repository.claim(rejected).await.unwrap(),
        ClaimResult::Busy,
        "original rejected claim cannot silently become successful"
    );
    let successor = f.grant().await;
    assert_eq!(successor.generation, grant.generation + 1);
    assert_eq!(granted(f.repository.claim(original).await.unwrap()), grant);
    assert!(
        Execution::attach(Arc::new(f.repository.clone()), grant.clone())
            .await
            .is_err()
    );
    assert!(
        ExecutionAuthority::commit(&f.repository, grant, f.commit(), f.verified())
            .await
            .is_err()
    );
    assert!(matches!(
        ExecutionAuthority::commit(&f.repository, successor, f.commit(), f.verified())
            .await
            .unwrap(),
        CommitReceipt::Published { .. }
    ));
}

#[tokio::test]
async fn renewal_lost_reply_returns_original_deadline_without_rearming_expired_grant() {
    let f = Fixture::new().await;
    let grant = f.grant().await;
    let request = Renewal {
        operation: Uuid::new_v4(),
        grant: grant.clone(),
        lease_millis: 120_000,
    };
    let first = f.repository.renew(request.clone()).await.unwrap();
    let reopened = FileRepository::open(f.directory.path()).unwrap();
    assert_eq!(reopened.renew(request.clone()).await.unwrap(), first);
    f.repository.revoke(grant.clone()).await.unwrap();
    assert_eq!(
        reopened.renew(request.clone()).await.unwrap(),
        first,
        "receipt reports original outcome, not current authority"
    );
    assert_eq!(reopened.observe(grant).await.unwrap(), Status::Draining);
    let mut different = request;
    different.lease_millis += 1;
    assert!(reopened.renew(different).await.is_err());
}

#[tokio::test]
async fn managed_session_cannot_bypass_fencing_and_old_commit_receipt_survives_revocation() {
    let f = Fixture::new().await;
    let grant = f.grant().await;
    let request = f.commit();
    assert!(
        SessionRepository::commit(&f.repository, request.clone(), f.verified())
            .await
            .is_err()
    );
    let receipt =
        ExecutionAuthority::commit(&f.repository, grant.clone(), request.clone(), f.verified())
            .await
            .unwrap();
    f.repository.revoke(grant.clone()).await.unwrap();
    let reopened = FileRepository::open(f.directory.path()).unwrap();
    assert_eq!(
        ExecutionAuthority::receipt(&reopened, grant.clone(), request.clone())
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        ExecutionAuthority::commit(&reopened, grant.clone(), request.clone(), f.verified())
            .await
            .unwrap(),
        receipt
    );
    let mut wrong = grant;
    wrong.activation = Uuid::new_v4();
    assert!(
        ExecutionAuthority::receipt(&reopened, wrong, request)
            .await
            .is_err()
    );
    assert!(
        SessionRepository::commit(&reopened, f.commit(), f.verified())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn generation_check_head_and_receipt_are_one_transaction() {
    let f = Fixture::new().await;
    let grant = f.grant().await;
    let request = f.commit();
    let db = rusqlite::Connection::open(f.directory.path().join("repository.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_execution_receipt BEFORE INSERT ON checkpoint_execution_commits BEGIN SELECT RAISE(ABORT, 'test interrupted execution receipt'); END;").unwrap();
    assert!(
        ExecutionAuthority::commit(&f.repository, grant.clone(), request.clone(), f.verified())
            .await
            .is_err()
    );
    assert!(
        f.repository
            .read_head(f.binding.identity.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        ExecutionAuthority::receipt(&f.repository, grant.clone(), request.clone())
            .await
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER fail_execution_receipt")
        .unwrap();
    assert!(matches!(
        ExecutionAuthority::commit(&f.repository, grant, request, f.verified())
            .await
            .unwrap(),
        CommitReceipt::Published { .. }
    ));
}

#[test]
fn claim_child() {
    let Ok(directory) = std::env::var("MAKA_EXECUTION_CHILD") else {
        return;
    };
    let request: Claim = serde_json::from_slice(
        &std::fs::read(std::env::var("MAKA_EXECUTION_CLAIM").unwrap()).unwrap(),
    )
    .unwrap();
    let repo = FileRepository::open(Path::new(&directory)).unwrap();
    use std::io::Write;
    println!("READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "go");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            repo.claim(request).await.unwrap();
        });
    // Simulate loss of a successful OR rejected response after its durable decision.
    std::process::exit(86);
}

#[tokio::test]
async fn independent_process_claim_race_has_one_winner_and_original_replies() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let f = Fixture::new().await;
    let requests = [f.claim(), f.claim()];
    let mut children = vec![];
    for (i, request) in requests.iter().enumerate() {
        let path = f.directory.path().join(format!("claim-{i}.json"));
        std::fs::write(&path, serde_json::to_vec(request).unwrap()).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "claim_child", "--nocapture"])
            .env("MAKA_EXECUTION_CHILD", f.directory.path())
            .env("MAKA_EXECUTION_CLAIM", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut reader = tokio::io::BufReader::new(child.stdout.take().unwrap());
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line.trim().ends_with("READY") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        children.push(child);
    }
    for child in &mut children {
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"go\n")
            .await
            .unwrap();
    }
    for child in &mut children {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(30), child.wait())
                .await
                .unwrap()
                .unwrap()
                .code(),
            Some(86)
        );
    }
    let reopened = FileRepository::open(f.directory.path()).unwrap();
    let a = reopened.claim(requests[0].clone()).await.unwrap();
    let b = reopened.claim(requests[1].clone()).await.unwrap();
    assert_eq!(
        [&a, &b]
            .iter()
            .filter(|r| matches!(r, ClaimResult::Granted { .. }))
            .count(),
        1
    );
    assert_eq!(
        [a, b]
            .iter()
            .filter(|r| matches!(r, ClaimResult::Busy))
            .count(),
        1
    );
}

#[derive(Clone)]
struct UnavailableAuthority {
    inner: FileRepository,
    unavailable: Arc<std::sync::atomic::AtomicBool>,
}
impl ExecutionAuthority for UnavailableAuthority {
    fn repository_identity(&self) -> &str {
        self.inner.repository_identity()
    }
    fn claim(&self, r: Claim) -> BoxFuture<'_, Result<ClaimResult, StoreError>> {
        self.inner.claim(r)
    }
    fn observe(&self, g: Grant) -> BoxFuture<'_, Result<Status, StoreError>> {
        if self.unavailable.load(std::sync::atomic::Ordering::SeqCst) {
            Box::pin(async { Err(StoreError::ConnectionClosed) })
        } else {
            self.inner.observe(g)
        }
    }
    fn renew(&self, r: Renewal) -> BoxFuture<'_, Result<Status, StoreError>> {
        self.inner.renew(r)
    }
    fn revoke(&self, g: Grant) -> BoxFuture<'_, Result<Status, StoreError>> {
        if self.unavailable.load(std::sync::atomic::Ordering::SeqCst) {
            Box::pin(async { Err(StoreError::ConnectionClosed) })
        } else {
            self.inner.revoke(g)
        }
    }
    fn stopped(
        &self,
        e: maka_event_log::checkpoints::execution::Stopped,
    ) -> BoxFuture<'_, Result<(), StoreError>> {
        self.inner.stopped(e)
    }
    fn receipt(
        &self,
        g: Grant,
        r: Commit,
    ) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        ExecutionAuthority::receipt(&self.inner, g, r)
    }
    fn commit(
        &self,
        g: Grant,
        r: Commit,
        v: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        ExecutionAuthority::commit(&self.inner, g, r, v)
    }
}

#[tokio::test]
async fn control_outage_stops_local_work_without_rearming_or_claiming_cleanup() {
    let f = Fixture::new().await;
    let grant = f.grant().await;
    let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let authority = Arc::new(UnavailableAuthority {
        inner: f.repository.clone(),
        unavailable: unavailable.clone(),
    });
    let execution = Execution::attach(authority, grant.clone()).await.unwrap();
    unavailable.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(execution.check().await.is_err());
    let process = environment(grant.clone()).await;
    assert!(execution.stop(&process).await.is_err());
    assert!(
        process.child.lock().await.try_wait().unwrap().is_some(),
        "failure to reach the control service still kills and reaps local execution"
    );
    assert_eq!(
        f.repository.claim(f.claim()).await.unwrap(),
        ClaimResult::Busy
    );
    unavailable.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        f.repository.observe(grant).await.unwrap(),
        Status::Active { .. }
    ));
    assert!(
        execution.check().await.is_err(),
        "a local failure is irreversible"
    );
}

#[tokio::test]
async fn revoke_and_publish_linearize_with_original_receipt() {
    for _ in 0..8 {
        let f = Fixture::new().await;
        let grant = f.grant().await;
        let other = FileRepository::open(f.directory.path()).unwrap();
        let request = f.commit();
        let (published, revoked) = tokio::join!(
            ExecutionAuthority::commit(&f.repository, grant.clone(), request.clone(), f.verified()),
            other.revoke(grant.clone()),
        );
        assert_eq!(revoked.unwrap(), Status::Draining);
        let receipt = ExecutionAuthority::receipt(&other, grant.clone(), request.clone())
            .await
            .unwrap();
        match published {
            Ok(result) => {
                assert_eq!(receipt, Some(result.clone()));
                assert_eq!(
                    ExecutionAuthority::commit(&other, grant.clone(), request, f.verified())
                        .await
                        .unwrap(),
                    result
                );
            }
            Err(_) => {
                assert!(receipt.is_none());
                assert!(
                    other
                        .read_head(f.binding.identity.clone())
                        .await
                        .unwrap()
                        .is_none()
                );
            }
        }
        assert!(
            ExecutionAuthority::commit(&other, grant, f.commit(), f.verified())
                .await
                .is_err()
        );
    }
}
