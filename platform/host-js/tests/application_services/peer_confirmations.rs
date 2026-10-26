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
use maka_event_log::applications::intents::{CallerConfirmation, RecordedIntent};
use maka_host_runtime::application::{Binding, Client, PreparedMutation};
use maka_plugin_core::deployment::DeploymentRef;

struct PeerEvidence {
    binding: Binding,
    source: DeploymentRef,
    consumer: InstanceId,
    request: Uuid,
}
struct PeerPolicy {
    issuer: Issuer,
    allow: AtomicBool,
    confirmation: AtomicUsize,
    recovery: AtomicBool,
}
impl Policy for PeerPolicy {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        let evidence = self
            .issuer
            .evidence::<PeerEvidence>(invocation.scope)
            .ok_or("missing authenticated peer evidence")?;
        if !self.allow.load(Ordering::SeqCst)
            || invocation.consumer != evidence.binding.consumer()
            || invocation.provider != evidence.binding.provider()
            || invocation.export != evidence.binding.export()
            || invocation.contract != evidence.binding.contract()
            || invocation.method != "echo"
        {
            return Err("original invocation grant denied".into());
        }
        Ok(())
    }
    fn confirm_peer_mutation(
        &self,
        invocation: Invocation<'_>,
        intent: &CallerConfirmation,
    ) -> Result<()> {
        match self.confirmation.load(Ordering::SeqCst) {
            0 => return Err("peer trust revoked".into()),
            2 => panic!("confirmation probe panic"),
            _ => {}
        }
        let evidence = self
            .issuer
            .evidence::<PeerEvidence>(invocation.scope)
            .unwrap();
        if intent.caller != evidence.source
            || intent.consumer != evidence.consumer
            || intent.reference.operation != evidence.request
        {
            return Err("caller confirmation differs from authenticated original request".into());
        }
        // A UI consumer is not the Host consumer that owns this captured import.
        assert_ne!(intent.consumer, *invocation.consumer.instance());
        Ok(())
    }
    fn recover(&self, invocation: RecoveryInvocation<'_>) -> Result<()> {
        if self
            .issuer
            .evidence::<PeerEvidence>(invocation.scope)
            .is_some()
            && self.recovery.load(Ordering::SeqCst)
        {
            Ok(())
        } else {
            Err("historical grant denied".into())
        }
    }
}
struct PeerEffect {
    caller_database: std::path::PathBuf,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    calls: Arc<AtomicUsize>,
    fail_cleanup: Arc<AtomicBool>,
}
impl Handler for PeerEffect {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let database = self.caller_database.clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let calls = self.calls.clone();
        let fail_cleanup = self.fail_cleanup.clone();
        Box::pin(async move {
            let connection = rusqlite::Connection::open_with_flags(
                journal_database(
                    &database,
                    "application_intents",
                    context.operation().unwrap().operation,
                ),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let raw: String = connection
                .query_row(
                    "SELECT reference_json FROM application_intents WHERE operation=?",
                    [context.operation().unwrap().operation.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<maka_plugin_core::operation::RecoveryRef>(&raw).unwrap(),
                *context.operation().unwrap(),
                "actual caller commit must precede callback"
            );
            if let Some(text) = context.attachments().get("text") {
                assert_eq!(text.read(0..5)?, b"xxxxx");
            }
            calls.fetch_add(1, Ordering::SeqCst);
            started.add_permits(1);
            permit(&release).await;
            if fail_cleanup.load(Ordering::SeqCst) {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("peer executor cleanup unconfirmed".into()));
            }
            Ok(input)
        })
    }
}
struct Fixture {
    host: Application,
    client: Client,
    binding: Binding,
    host_store: Arc<RootStore>,
    caller_store: Arc<RootStore>,
    source: DeploymentRef,
    policy: Arc<PeerPolicy>,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    calls: Arc<AtomicUsize>,
    fail_cleanup: Arc<AtomicBool>,
    default_policy: bool,
    _host_dir: tempfile::TempDir,
    _caller_dir: tempfile::TempDir,
}
impl Fixture {
    async fn new(default_policy: bool) -> Self {
        Self::with_resources(default_policy, true).await
    }
    async fn with_resources(default_policy: bool, resources: bool) -> Self {
        let (_host_dir, _, host_store) = store().await;
        let (_caller_dir, _, caller_store) = store().await;
        let (provider, consumer, mut declared) = remote_mutation_packages();
        let Interface::Service { methods } = &mut declared.interface else {
            unreachable!()
        };
        if resources {
            methods.get_mut("echo").unwrap().resources = BTreeMap::from([(
                "text".into(),
                ResourceType {
                    name: "example.Bytes".into(),
                    version: 1,
                }
                .required(),
            )]);
        }
        let rewrite = |old: Package| {
            let mut entry =
                old.manifest().application.as_ref().unwrap().entries[&EntryTarget::Host].clone();
            for value in entry.exports.values_mut() {
                value.contract = declared.clone();
            }
            for value in entry.imports.values_mut() {
                value.contract = declared.clone();
            }
            let source = old
                .file("host.mjs")
                .map(|v| std::str::from_utf8(v).unwrap().to_owned());
            package(&old.manifest().id, entry, source)
        };
        let provider = rewrite(provider);
        let consumer = rewrite(consumer);
        let deployment = Uuid::new_v4();
        host_store
            .commit_application(
                deployment,
                0,
                input(&provider, &consumer),
                vec![],
                vec![provider, consumer],
            )
            .await
            .unwrap();
        let source = ui_caller_source(
            &caller_store,
            Uuid::new_v4(),
            0,
            declared.clone(),
            "original-host",
        )
        .await;
        let issuer = Issuer::default();
        let policy = Arc::new(PeerPolicy {
            issuer: issuer.clone(),
            allow: AtomicBool::new(true),
            confirmation: AtomicUsize::new(1),
            recovery: AtomicBool::new(false),
        });
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let fail_cleanup = Arc::new(AtomicBool::new(false));
        let gate: Arc<dyn Policy> = if default_policy {
            Arc::new(Grant(issuer.clone()))
        } else {
            policy.clone()
        };
        let host = Application::start_from_store(
            host_store.clone(),
            deployment,
            registry_contract(
                Arc::new(PeerEffect {
                    caller_database: _caller_dir.path().join("root"),
                    started: started.clone(),
                    release: release.clone(),
                    calls: calls.clone(),
                    fail_cleanup: fail_cleanup.clone(),
                }),
                declared,
            ),
            issuer,
            gate,
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        host.ready().await.unwrap();
        let client = host.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        Self {
            host,
            client,
            binding,
            host_store,
            caller_store,
            source,
            policy,
            started,
            release,
            calls,
            fail_cleanup,
            default_policy,
            _host_dir,
            _caller_dir,
        }
    }
    fn scope(&self, request: Uuid) -> Scope {
        if self.default_policy {
            return scope(&self.policy.issuer, true);
        }
        self.policy
            .issuer
            .issue_with(
                Identity::Remote {
                    request_id: request,
                },
                PeerEvidence {
                    binding: self.binding.clone(),
                    source: self.source.clone(),
                    consumer: id(41),
                    request,
                },
                CancellationToken::new(),
            )
            .unwrap()
    }
    async fn prepare(
        &self,
        operation: Uuid,
        size: usize,
    ) -> (PreparedMutation, Scope, std::sync::Weak<Bytes>) {
        let scope = self.scope(operation);
        let (attachments, weak) = bytes(size);
        let prepared = self
            .client
            .prepare_mutation(
                self.binding.clone(),
                "echo".into(),
                json!("original"),
                scope.clone(),
                operation,
                attachments.into(),
            )
            .await
            .unwrap();
        (prepared, scope, weak)
    }
    async fn record(&self, prepared: &PreparedMutation) -> (RecordedIntent, CallerConfirmation) {
        let recorded = self
            .caller_store
            .record_application_intent(
                self.source.clone(),
                id(41),
                prepared.reference().clone(),
                json!({"draft":"caller-local-correlation"}),
            )
            .await
            .unwrap();
        // Exercise actual observation serialization. It cannot reconstruct the token.
        let bytes = serde_json::to_vec(&recorded.intent().confirmation()).unwrap();
        assert!(
            !std::str::from_utf8(&bytes)
                .unwrap()
                .contains("caller-local-correlation")
        );
        let intent = serde_json::from_slice(&bytes).unwrap();
        (recorded, intent)
    }
    async fn assert_no_effect(&self, reference: &maka_plugin_core::operation::RecoveryRef) {
        assert_eq!(self.calls.load(Ordering::SeqCst), 0);
        assert!(
            self.host_store
                .operation(reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            self.host_store
                .application_intents(reference.source.deployment, id(2), 0, 128)
                .await
                .unwrap()
                .is_empty(),
            "peer dispatch cannot create a substitute Host caller intent"
        );
    }
    async fn close(self) {
        self.host.shutdown().await.unwrap();
        drop(self.host);
        drop(self.client);
        drop(self.binding);
        drop(self.policy);
        close(self.host_store).await;
        close(self.caller_store).await;
    }
}

#[tokio::test]
async fn ordinary_admission_does_not_trust_peer_confirmation() {
    let f = setup(Fixture::new(true)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let (prepared, scope, weak) = f.prepare(Uuid::new_v4(), 5).await;
        let reference = prepared.reference().clone();
        let (recorded, intent) = f.record(&prepared).await;
        assert!(
            f.client
                .mutate_from_peer(prepared, intent)
                .await
                .err()
                .unwrap()
                .contains("not authorized")
        );
        scope.finish().await.unwrap();
        assert!(weak.upgrade().is_none());
        f.assert_no_effect(&reference).await;
        drop(recorded);
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn peer_observations_cannot_substitute_caller_identity_reference_or_shape() {
    let f = setup(Fixture::new(false)).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        for mode in [
            "caller",
            "consumer",
            "reference",
            "cursor",
            "cursor-overflow",
            "domain",
            "empty-consumer",
            "deep-consumer",
            "nil-consumer",
            "oversized-reference",
            "request",
        ] {
            let (prepared, scope, weak) = if mode == "request" {
                let scope = f.scope(Uuid::new_v4());
                let (attachments, weak) = bytes(5);
                let prepared = f
                    .client
                    .prepare_mutation(
                        f.binding.clone(),
                        "echo".into(),
                        json!("original"),
                        scope.clone(),
                        Uuid::new_v4(),
                        attachments.into(),
                    )
                    .await
                    .unwrap();
                (prepared, scope, weak)
            } else {
                f.prepare(Uuid::new_v4(), 5).await
            };
            let reference = prepared.reference().clone();
            let (recorded, mut intent) = f.record(&prepared).await;
            match mode {
                "caller" => intent.caller.revision += 1,
                "consumer" => intent.consumer = id(42),
                "reference" => intent.reference.operation = Uuid::new_v4(),
                "cursor" => intent.cursor = 0,
                "cursor-overflow" => intent.cursor = i64::MAX as u64 + 1,
                "domain" => intent.caller.state_domain = "bad".into(),
                "empty-consumer" => intent.consumer.0.clear(),
                "deep-consumer" => intent.consumer.0 = vec![Uuid::new_v4(); 65],
                "nil-consumer" => intent.consumer = id(0),
                "oversized-reference" => {
                    intent.reference.contract.digest = format!("sha256-{}", "x".repeat(512 * 1024));
                }
                "request" => {}
                _ => unreachable!(),
            }
            assert!(
                f.client.mutate_from_peer(prepared, intent).await.is_err(),
                "{mode}"
            );
            scope.finish().await.unwrap();
            assert!(weak.upgrade().is_none(), "{mode}");
            f.assert_no_effect(&reference).await;
            drop(recorded);
        }
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn peer_confirmation_cannot_override_final_revocation_or_retirement() {
    for mode in ["grant", "peer", "cancel", "retire"] {
        let f = setup(Fixture::new(false)).await;
        tokio::time::timeout(Duration::from_secs(30), async {
            let (prepared, scope, weak) = f.prepare(Uuid::new_v4(), 5).await;
            let reference = prepared.reference().clone();
            let (recorded, intent) = f.record(&prepared).await;
            match mode {
                "grant" => f.policy.allow.store(false, Ordering::SeqCst),
                "peer" => f.policy.confirmation.store(0, Ordering::SeqCst),
                "cancel" => scope.cancellation.cancel(),
                "retire" => f.client.retire(f.binding.provider().clone()).await.unwrap(),
                _ => unreachable!(),
            }
            assert!(
                f.client.mutate_from_peer(prepared, intent).await.is_err(),
                "{mode}"
            );
            scope.finish().await.unwrap();
            assert!(weak.upgrade().is_none());
            f.assert_no_effect(&reference).await;
            drop(recorded);
            f.close().await;
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn confirmation_panic_preserves_an_independent_accepted_executor() {
    let f = setup(Fixture::new(false)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let (original, original_scope, original_weak) = f.prepare(Uuid::new_v4(), 5).await;
        let (original_token, intent) = f.record(&original).await;
        let accepted = f.client.mutate_from_peer(original, intent).await.unwrap();
        permit(&f.started).await;
        let (probe, probe_scope, weak) = f.prepare(Uuid::new_v4(), 5).await;
        let reference = probe.reference().clone();
        let (token, intent) = f.record(&probe).await;
        f.policy.confirmation.store(2, Ordering::SeqCst);
        assert!(
            f.client
                .mutate_from_peer(probe, intent)
                .await
                .err()
                .unwrap()
                .contains("panicked")
        );
        assert!(
            probe_scope.finish().await.is_err(),
            "policy panic cannot acknowledge Scope cleanup"
        );
        assert!(weak.upgrade().is_none());
        assert!(original_weak.upgrade().is_some());
        assert!(
            f.host_store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
        f.release.add_permits(1);
        let completion = accepted.completion().await;
        assert_eq!(returned(completion.reply), json!("original"));
        assert!(completion.cleanup.is_ok());
        original_scope.finish().await.unwrap();
        assert!(original_weak.upgrade().is_none());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        drop((original_token, token));
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn lost_peer_observer_does_not_settle_or_release_failed_executor_resources() {
    for fail in [false, true] {
        let f = setup(Fixture::new(false)).await;
        tokio::time::timeout(Duration::from_secs(30), async {
            let (prepared, scope, weak) = f.prepare(Uuid::new_v4(), 64 * 1024 * 1024).await;
            let reference = prepared.reference().clone();
            let journal = f.host_store.operation(&reference).unwrap();
            let (token, intent) = f.record(&prepared).await;
            let accepted = f.client.mutate_from_peer(prepared, intent).await.unwrap();
            permit(&f.started).await;
            drop(accepted);
            assert!(weak.upgrade().is_some());
            f.fail_cleanup.store(fail, Ordering::SeqCst);
            f.release.add_permits(1);
            // The original Scope's ticket is an independent actual settlement observer.
            assert_eq!(scope.finish().await.is_err(), fail);
            assert_eq!(weak.upgrade().is_some(), fail);
            assert_eq!(f.calls.load(Ordering::SeqCst), 1);
            f.policy.recovery.store(true, Ordering::SeqCst);
            let recovery = f
                .client
                .recover(
                    f.binding.consumer().clone(),
                    reference.clone(),
                    f.scope(Uuid::new_v4()),
                )
                .await;
            let observation = if fail {
                let error = recovery.err().unwrap();
                assert!(
                    error.contains("not active") || error.contains("retired"),
                    "failed provider retires its dependent consumer: {error}"
                );
                assert!(f.host_store.shutdown().await.is_err());
                assert!(journal.operation_observation().await.is_err());
                persisted_operation(&f._host_dir.path().join("root"), &reference)
            } else {
                recovery.unwrap().unwrap()
            };
            assert_eq!(
                observation.outcome,
                OperationOutcome::Returned {
                    value: json!("original")
                }
            );
            if fail {
                assert!(matches!(
                    observation.cleanup,
                    OperationCleanup::Failed { .. }
                ));
            } else {
                assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
            }
            if fail {
                let (extra, extra_weak) = bytes(5);
                let error = f
                    .client
                    .prepare_mutation(
                        f.binding.clone(),
                        "echo".into(),
                        json!("original"),
                        f.scope(Uuid::new_v4()),
                        Uuid::new_v4(),
                        extra.into(),
                    )
                    .await
                    .err()
                    .unwrap();
                assert!(
                    error.contains("budget"),
                    "failed work must retain the original resource permits: {error}"
                );
                assert!(extra_weak.upgrade().is_none());
                assert!(f.host.shutdown().await.is_err());
                drop(token);
                drop(f);
                assert!(
                    weak.upgrade().is_some(),
                    "failed cleanup retains actual original payload and budget"
                );
            } else {
                drop(token);
                f.close().await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn peer_duplicate_cannot_read_historical_value_without_independent_recovery_grant() {
    let f = setup(Fixture::with_resources(false, false)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let operation = Uuid::new_v4();
        let original_scope = f.scope(operation);
        let prepared = f.client.prepare_mutation(f.binding.clone(), "echo".into(), json!("original"),
            original_scope.clone(), operation, Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        let (token, intent) = f.record(&prepared).await;
        let accepted = f.client.mutate_from_peer(prepared, intent).await.unwrap();
        permit(&f.started).await; f.release.add_permits(1);
        let completion = accepted.completion().await;
        assert_eq!(returned(completion.reply), json!("original")); assert!(completion.cleanup.is_ok());
        original_scope.finish().await.unwrap(); drop(token);
        for recovery in [false, true] {
            f.policy.recovery.store(recovery, Ordering::SeqCst);
            let scope = f.scope(operation);
            let prepared = f.client.prepare_mutation(f.binding.clone(), "echo".into(), json!("original"),
                scope.clone(), operation, Attachments::new().into()).await.unwrap();
            assert_eq!(prepared.reference(), &reference);
            let (token, intent) = f.record(&prepared).await;
            let completion = f.client.mutate_from_peer(prepared, intent).await.unwrap().completion().await;
            assert_eq!(completion.reply.reference, reference);
            if recovery { assert_eq!(returned(completion.reply), json!("original")); }
            else { assert!(matches!(completion.reply.receipt, Receipt::Unavailable { diagnostic } if diagnostic.contains("historical grant denied"))); }
            assert!(completion.cleanup.is_ok()); scope.finish().await.unwrap(); drop(token);
            assert_eq!(f.calls.load(Ordering::SeqCst), 1, "historical lookup cannot repeat effect");
        }
        f.close().await;
    }).await.unwrap();
}
