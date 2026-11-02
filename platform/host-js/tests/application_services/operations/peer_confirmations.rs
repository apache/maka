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
use maka_event_log::applications::intents::CallerConfirmation;
use maka_host_runtime::application::{Binding, Client, PreparedMutation};
use maka_plugin_core::deployment::DeploymentRef;

struct PeerEvidence {
    binding: Binding,
    source: DeploymentRef,
    request: Uuid,
}
struct PeerPolicy {
    issuer: Issuer,
    allow: AtomicBool,
    confirmation: AtomicBool,
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
        let evidence = self
            .issuer
            .evidence::<PeerEvidence>(invocation.scope)
            .unwrap();
        if !self.confirmation.load(Ordering::SeqCst)
            || intent.caller != evidence.source
            || intent.consumer != id(41)
            || intent.reference.operation != evidence.request
        {
            return Err("caller confirmation differs from authenticated original request".into());
        }
        Ok(())
    }
}
struct PeerEffect(Arc<AtomicUsize>);
impl Handler for PeerEffect {
    fn call(&self, _: String, input: Value, _: Context) -> BoxFuture<'static, Result<Value>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(input) })
    }
}
struct Fixture {
    host: Application,
    client: Client,
    binding: Binding,
    store: Arc<RootStore>,
    source: DeploymentRef,
    policy: Arc<PeerPolicy>,
    calls: Arc<AtomicUsize>,
    default_policy: bool,
    _directory: tempfile::TempDir,
}
impl Fixture {
    async fn new(default_policy: bool) -> Self {
        let (_directory, _, store) = store().await;
        let (provider, consumer, declared) = remote_mutation_packages();
        let deployment = Uuid::new_v4();
        let mut source = store
            .commit_application(
                deployment,
                0,
                input(&provider, &consumer),
                vec![],
                vec![provider, consumer],
            )
            .await
            .unwrap();
        // This is the authenticated remote caller's source, not a local caller intent.
        source.deployment = Uuid::new_v4();
        let issuer = Issuer::default();
        let policy = Arc::new(PeerPolicy {
            issuer: issuer.clone(),
            allow: AtomicBool::new(true),
            confirmation: AtomicBool::new(true),
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let gate: Arc<dyn Policy> = if default_policy {
            Arc::new(Grant(issuer.clone()))
        } else {
            policy.clone()
        };
        let host = Application::start_from_store(
            store.clone(),
            deployment,
            registry_contract(Arc::new(PeerEffect(calls.clone())), declared),
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
            store,
            source,
            policy,
            calls,
            default_policy,
            _directory,
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
                    request,
                },
                CancellationToken::new(),
            )
            .unwrap()
    }
    async fn prepare(&self, request: Uuid) -> (PreparedMutation, Scope) {
        let scope = self.scope(request);
        let prepared = self
            .client
            .prepare_mutation(
                self.binding.clone(),
                "echo".into(),
                json!("original"),
                scope.clone(),
                request,
                Attachments::new().into(),
            )
            .await
            .unwrap();
        (prepared, scope)
    }
    fn confirmation(&self, prepared: &PreparedMutation) -> CallerConfirmation {
        CallerConfirmation {
            caller: self.source.clone(),
            consumer: id(41),
            reference: prepared.reference().clone(),
            cursor: 1,
        }
    }
    async fn assert_no_effect(&self, reference: &maka_plugin_core::operation::RecoveryRef) {
        assert_eq!(self.calls.load(Ordering::SeqCst), 0);
        assert!(
            self.store
                .operation(reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
    }
    async fn close(self) {
        self.host.shutdown().await.unwrap();
        drop(self.host);
        drop(self.client);
        drop(self.binding);
        drop(self.policy);
        close(self.store).await;
    }
}

#[tokio::test]
async fn ordinary_admission_does_not_trust_peer_confirmation() {
    let f = Fixture::new(true).await;
    let (prepared, scope) = f.prepare(Uuid::new_v4()).await;
    let reference = prepared.reference().clone();
    let intent = f.confirmation(&prepared);
    assert!(
        f.client
            .mutate_from_peer(prepared, intent)
            .await
            .err()
            .unwrap()
            .contains("not authorized")
    );
    scope.finish().await.unwrap();
    f.assert_no_effect(&reference).await;
    f.close().await;
}

#[tokio::test]
async fn peer_confirmation_requires_the_authenticated_caller_and_request() {
    let f = Fixture::new(false).await;
    for field in ["caller", "consumer", "reference"] {
        let (prepared, scope) = f.prepare(Uuid::new_v4()).await;
        let reference = prepared.reference().clone();
        let mut intent = f.confirmation(&prepared);
        match field {
            "caller" => intent.caller.revision += 1,
            "consumer" => intent.consumer = id(42),
            "reference" => intent.reference.operation = Uuid::new_v4(),
            _ => unreachable!(),
        }
        assert!(
            f.client.mutate_from_peer(prepared, intent).await.is_err(),
            "{field}"
        );
        scope.finish().await.unwrap();
        f.assert_no_effect(&reference).await;
    }
    f.close().await;
}

#[tokio::test]
async fn peer_confirmation_cannot_override_final_revocation() {
    for peer in [false, true] {
        let f = Fixture::new(false).await;
        let (prepared, scope) = f.prepare(Uuid::new_v4()).await;
        let reference = prepared.reference().clone();
        let intent = f.confirmation(&prepared);
        if peer {
            f.policy.confirmation.store(false, Ordering::SeqCst);
        } else {
            f.policy.allow.store(false, Ordering::SeqCst);
        }
        assert!(f.client.mutate_from_peer(prepared, intent).await.is_err());
        scope.finish().await.unwrap();
        f.assert_no_effect(&reference).await;
        f.close().await;
    }
}
