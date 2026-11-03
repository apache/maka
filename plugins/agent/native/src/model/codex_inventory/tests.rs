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
use base64::Engine;
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::*;
use maka_agent_ports::{
    model::Credentials as Authorized,
    provider::{Error, Model, Policy, Provider, Resolve},
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;

struct DiscoveryProvider {
    calls: AtomicUsize,
    started: Semaphore,
    release: Semaphore,
    fail: AtomicBool,
    hash: Mutex<String>,
}
impl Provider for DiscoveryProvider {
    fn resolve(&self, request: Resolve) -> BoxFuture<'_, Result<Model, Error>> {
        Box::pin(async move { Ok(resolved_model(request.model)) })
    }
    fn authorize(
        &self,
        _: maka_agent_ports::provider::Connection,
        _: Option<maka_agent_facts::provider::Credential>,
        _: String,
    ) -> BoxFuture<'_, Result<Authorized, Error>> {
        Box::pin(async { Ok(Authorized::RequestHeaders(BTreeMap::new())) })
    }
    fn discover(
        &self,
        _: Discovery,
        context: Context,
    ) -> BoxFuture<'_, Result<Vec<ModelInfo>, Error>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.add_permits(1);
            tokio::select! {
                _ = context.cancellation.cancelled() => return Err(Error::Cancelled),
                permit = self.release.acquire() => permit.unwrap().forget(),
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(Error::Http(503));
            }
            let mut model = ModelInfo::new("model-a");
            model.codex_compaction_hash = Some(self.hash.lock().unwrap().clone());
            model.context_window = Some(200_000);
            model.max_output_tokens = Some(128_000);
            Ok(vec![model])
        })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    store: Arc<ConfigurationStore>,
    credentials: Credentials,
    definition: Arc<Definition>,
    binding: ModelBinding,
    provider: Arc<DiscoveryProvider>,
    workers: TaskTracker,
    shutdown: CancellationToken,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            RootOwner::create(
                &temp.path().join("root"),
                &RootNamespaces {
                    ownership: temp.path().join("owners"),
                    control: temp.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
        let input = serde_json::from_value(json!({"expectedCatalogRevision":0,"connection":{
            "slug":"chatgpt","name":"ChatGPT","provider":{"packageId":"maka.codex","entryId":"maka.codex","scope":"profile","name":"chatgpt"},
            "configuration":{"baseUrl":"https://chatgpt.com/backend-api/codex"},"enabled":true,"enabledModelIds":["model-a","model-b"]}})).unwrap();
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = store.create_connection(input).await.unwrap()
        else {
            panic!("create")
        };
        let binding = ModelBinding {
            connection_id: basis.connection_id,
            connection_slug: "chatgpt".into(),
            model: "model-a".into(),
        };
        login(&store, &binding, "account-a").await;
        let workers = TaskTracker::new();
        let shutdown = CancellationToken::new();
        let credentials = Credentials {
            executor: maka_model::ModelExecutor::new(Duration::from_secs(30)).unwrap(),
            refresh: Arc::new(super::super::oauth::Authority::new(
                workers.clone(),
                shutdown.clone(),
            )),
            inventory: Arc::new(Authority::new(workers.clone(), shutdown.clone())),
        };
        let provider = Arc::new(DiscoveryProvider {
            calls: AtomicUsize::new(0),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
            fail: AtomicBool::new(false),
            hash: Mutex::new("3000".into()),
        });
        let real = maka_providers::codex::Codex::new(Arc::new(
            maka_providers::catalog::Snapshot::bundled().unwrap(),
        ))
        .definition()
        .unwrap();
        let definition = Arc::new(Definition::new(
            Arc::new(Policy::new(real.descriptor().clone()).unwrap()),
            provider.clone(),
        ));
        Self {
            _temp: temp,
            store,
            credentials,
            definition,
            binding,
            provider,
            workers,
            shutdown,
        }
    }
    async fn refresh(&self) {
        let material = self
            .store
            .observe_model(self.binding.clone())
            .await
            .unwrap()
            .unwrap();
        self.credentials
            .inventory
            .ensure(
                self.store.clone(),
                self.credentials.clone(),
                self.definition.clone(),
                self.binding.clone(),
                &material,
            )
            .await;
    }
    async fn proof(&self) -> CodexRequestProvenance {
        self.credentials.inventory.provenance(
            &self
                .store
                .observe_model(self.binding.clone())
                .await
                .unwrap()
                .unwrap(),
            "model-a",
        )
    }
    async fn close(&self) {
        self.shutdown.cancel();
        self.workers.close();
        self.workers.wait().await;
        self.store.shutdown().await.unwrap();
    }
}
async fn login(store: &Arc<ConfigurationStore>, binding: &ModelBinding, account: &str) {
    let row = store.catalog().await.unwrap().connections.remove(0);
    let status = store
        .credential_status(CredentialLocator::Connection {
            connection_id: binding.connection_id.clone(),
            kind: ConnectionCredentialKind::Provider,
        })
        .await
        .unwrap();
    let CredentialVaultQueryResult::Status { status } = status else {
        panic!("credential status")
    };
    let input = maka_agent_facts::oauth::LoginStart {
        expected_credential: status.basis(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
        target: maka_agent_facts::oauth::Target::Existing {
            expected: ConnectionCredentialTarget {
                connection_id: row.connection_id,
                revision: row.revision,
                provider: row.provider,
                slug: row.slug,
                configuration: row.configuration.clone(),
            },
            configuration: row.configuration,
        },
        authentication: maka_agent_facts::provider::AuthenticationInput {
            method: "chatgpt".into(),
            input: json!({}),
        },
    };
    let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) =
        store.prepare_oauth_login(input).await.unwrap()
    else {
        panic!("login")
    };
    assert!(ticket.claim().await.unwrap());
    let access = format!(
        "header.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({"chatgpt_account_id":account})).unwrap())
    );
    let secret = json!({"access_token":access,"refresh_token":"fixture-refresh","expires_at":9000000000000_u64,"id_token":null}).to_string();
    assert!(matches!(
        ticket
            .complete(
                maka_agent_facts::provider::Credential {
                    secret,
                    refresh_at: None
                },
                now().unwrap()
            )
            .await
            .unwrap(),
        maka_config::oauth::enrollment::LoginCompletion::Committed(_)
    ));
}

#[tokio::test]
async fn concurrent_requests_share_discovery_and_cancelled_waiter_does_not_cancel_worker() {
    let f = Arc::new(Fixture::new().await);
    let first = tokio::spawn({
        let f = f.clone();
        async move { f.refresh().await }
    });
    f.provider.started.acquire().await.unwrap().forget();
    let second = tokio::spawn({
        let f = f.clone();
        async move { f.refresh().await }
    });
    first.abort();
    f.provider.release.add_permits(1);
    second.await.unwrap();
    f.refresh().await;
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 1);
    let captured = f.proof().await;
    assert_eq!(captured.compatibility.as_ref().unwrap().comp_hash, "3000");
    assert_eq!(captured.account_id.as_deref(), Some("account-a"));
    assert_eq!(
        f.store.catalog().await.unwrap().connections[0].enabled_model_ids,
        ["model-a", "model-b"]
    );
    login(&f.store, &f.binding, "account-b").await;
    assert!(f.proof().await.compatibility.is_none());
    f.provider.release.add_permits(1);
    f.refresh().await;
    assert_eq!(f.proof().await.account_id.as_deref(), Some("account-b"));
    assert_eq!(captured.account_id.as_deref(), Some("account-a"));
    f.close().await;
}

#[tokio::test]
async fn replaced_login_waits_for_old_flight_then_refreshes_its_own_inventory() {
    let f = Arc::new(Fixture::new().await);
    let first = tokio::spawn({
        let f = f.clone();
        async move { f.refresh().await }
    });
    f.provider.started.acquire().await.unwrap().forget();
    login(&f.store, &f.binding, "account-b").await;
    let material = f
        .store
        .observe_model(f.binding.clone())
        .await
        .unwrap()
        .unwrap();
    let second = f.credentials.inventory.ensure(
        f.store.clone(),
        f.credentials.clone(),
        f.definition.clone(),
        f.binding.clone(),
        &material,
    );
    tokio::pin!(second);
    assert!(futures_util::poll!(&mut second).is_pending());
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 1);
    f.provider.release.add_permits(2);
    second.await;
    first.await.unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    let proof = f.proof().await;
    assert_eq!(proof.account_id.as_deref(), Some("account-b"));
    assert_eq!(proof.compatibility.unwrap().comp_hash, "3000");
    // A queued waiter can still hold the observation from before B's commit.
    // It must reuse the newer completed revision rather than issue a third fetch.
    f.provider.release.add_permits(1);
    f.credentials
        .inventory
        .ensure(
            f.store.clone(),
            f.credentials.clone(),
            f.definition.clone(),
            f.binding.clone(),
            &material,
        )
        .await;
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    f.close().await;
}

#[tokio::test]
async fn failed_refresh_backs_off_but_replaced_login_retries() {
    let f = Fixture::new().await;
    f.provider.fail.store(true, Ordering::SeqCst);
    f.provider.release.add_permits(1);
    f.refresh().await;
    f.refresh().await;
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 1);
    assert!(f.proof().await.compatibility.is_none());
    login(&f.store, &f.binding, "account-b").await;
    f.provider.fail.store(false, Ordering::SeqCst);
    f.provider.release.add_permits(1);
    f.refresh().await;
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    assert!(f.proof().await.compatibility.is_some());
    f.close().await;
}

#[tokio::test]
async fn selection_changed_during_discovery_supersedes_the_old_ticket() {
    let f = Arc::new(Fixture::new().await);
    let task = tokio::spawn({
        let f = f.clone();
        async move { f.refresh().await }
    });
    f.provider.started.acquire().await.unwrap().forget();
    let row = f.store.catalog().await.unwrap().connections.remove(0);
    let update = serde_json::from_value(json!({"expected":{"connectionId":row.connection_id,"revision":row.revision},"changes":{"enabledModelIds":["model-a"]}})).unwrap();
    f.store.update_connection(update).await.unwrap();
    f.provider.release.add_permits(1);
    task.await.unwrap();
    let row = f.store.catalog().await.unwrap().connections.remove(0);
    assert!(row.models.is_empty());
    assert_eq!(row.enabled_model_ids, ["model-a"]);
    assert!(f.proof().await.compatibility.is_none());
    f.close().await;
}

#[tokio::test]
async fn restart_refreshes_persisted_inventory_and_expired_proof_cannot_stamp_requests() {
    let f = Fixture::new().await;
    f.provider.release.add_permits(1);
    f.refresh().await;
    let mut outcome = f.credentials.inventory.entries.lock().unwrap()[&f.binding.connection_id]
        .result
        .borrow()
        .clone()
        .unwrap();
    if let Outcome::Ready { fetched_at, .. } = &mut outcome {
        *fetched_at = now().unwrap() - MAX_AGE;
    }
    let (_, result) = watch::channel(Some(outcome));
    f.credentials
        .inventory
        .entries
        .lock()
        .unwrap()
        .get_mut(&f.binding.connection_id)
        .unwrap()
        .result = result;
    assert!(f.proof().await.compatibility.is_none());
    f.provider.release.add_permits(1);
    f.refresh().await;
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    let restarted = Arc::new(Authority::new(f.workers.clone(), f.shutdown.clone()));
    let material = f
        .store
        .observe_model(f.binding.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        restarted
            .provenance(&material, "model-a")
            .compatibility
            .is_none()
    );
    f.provider.release.add_permits(1);
    restarted
        .ensure(
            f.store.clone(),
            f.credentials.clone(),
            f.definition.clone(),
            f.binding.clone(),
            &material,
        )
        .await;
    let material = f
        .store
        .observe_model(f.binding.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        restarted
            .provenance(&material, "model-a")
            .compatibility
            .is_some()
    );
    f.close().await;
}

fn resolved_model(info: ModelInfo) -> Model {
    let main_output_limit = info.max_output_tokens;
    Model {
        adapter: maka_providers::codex::ADAPTER.into(),
        protocol: maka_agent_ports::model::ProviderKind::OpenaiResponses,
        base_url: "https://chatgpt.com/backend-api/codex".into(),
        info,
        thinking_levels: vec![],
        provider_options: json!({"openai":{"store":false}}),
        main_output_limit,
    }
}

#[tokio::test]
async fn logical_step_captures_provenance_and_failure_keeps_same_model_usable() {
    use maka_agent_engine::ModelSource;
    let f = Fixture::new().await;
    f.provider.release.add_permits(1);
    f.refresh().await;
    let source = source_fixture(&f).await;
    let prepared = source.capture().await.unwrap();
    let frozen = serde_json::to_vec(&prepared.context).unwrap();
    let captured = prepared.context.unwrap().codex.unwrap();
    assert_eq!(captured.compatibility.unwrap().comp_hash, "3000");
    // Expire this owner's cache, then fail the next catalog read. Model preparation still succeeds.
    f.credentials.inventory.entries.lock().unwrap().clear();
    f.provider.fail.store(true, Ordering::SeqCst);
    f.provider.release.add_permits(1);
    let next = source.capture().await.unwrap();
    assert_eq!(next.provider.model, "model-a");
    assert!(next.context.unwrap().codex.unwrap().compatibility.is_none());
    let original: Option<maka_agent_facts::context::ModelRequestContext> =
        serde_json::from_slice(&frozen).unwrap();
    assert_eq!(
        original
            .unwrap()
            .codex
            .unwrap()
            .compatibility
            .unwrap()
            .comp_hash,
        "3000"
    );
    f.close().await;
}

#[tokio::test]
async fn host_shutdown_settles_shared_discovery_without_publishing_a_proof() {
    let f = Arc::new(Fixture::new().await);
    let task = tokio::spawn({
        let f = f.clone();
        async move { f.refresh().await }
    });
    f.provider.started.acquire().await.unwrap().forget();
    f.shutdown.cancel();
    f.workers.close();
    f.workers.wait().await;
    task.await.unwrap();
    assert!(f.proof().await.compatibility.is_none());
    assert!(
        f.store.catalog().await.unwrap().connections[0]
            .models
            .is_empty()
    );
    f.store.shutdown().await.unwrap();
}

async fn source_fixture(f: &Fixture) -> super::super::Source {
    use super::super::{AcceptedModel, Source};
    use maka_agent_facts::{
        composition::{SourceKind, SourceRevision},
        execution::{CodeLanguage, ToolMode},
    };
    let material = f
        .store
        .observe_model(f.binding.clone())
        .await
        .unwrap()
        .unwrap();
    let model = resolved_model(
        material
            .connection
            .models
            .first()
            .cloned()
            .unwrap_or_else(|| ModelInfo::new("model-a")),
    );
    Source {
        configuration: f.store.clone(),
        credentials: f.credentials.clone(),
        definition: f.definition.clone(),
        session: "session".into(),
        revision: SourceRevision {
            kind: SourceKind::ModelProvider,
            name: "chatgpt".into(),
            package_id: "maka.codex".into(),
            entry_id: "maka.codex".into(),
            activation: "fixture".into(),
            revision: "1".into(),
        },
        accepted: AcceptedModel {
            binding: f.binding.clone(),
            thinking_level: None,
            tool_mode: ToolMode::for_model("model-a", &model.base_url, None),
            code_language: CodeLanguage::default(),
            editing_tools: None,
            public_model: None,
            provider: material.connection.provider.clone(),
            provider_configuration: material.connection.configuration.clone(),
            model_override: None,
            body_overlay: None,
        },
    }
}

#[tokio::test]
async fn discovery_recovery_and_restoration_use_one_current_request_snapshot() {
    use maka_agent_engine::ModelSource;
    let f = Fixture::new().await;
    let source = source_fixture(&f).await;
    f.provider.fail.store(true, Ordering::SeqCst);
    f.provider.release.add_permits(1);
    let first = source.capture().await.unwrap();
    assert_eq!(first.main_output_limit, None);
    assert_eq!(first.context.as_ref().unwrap().context_window, None);
    let accepted = serde_json::to_vec(&source.accepted).unwrap();

    // Advance only the failed discovery backoff, without sleeping or changing user configuration.
    let (_, receiver) = watch::channel(Some(Outcome::Failed {
        retry_at: Instant::now(),
    }));
    f.credentials
        .inventory
        .entries
        .lock()
        .unwrap()
        .get_mut(&f.binding.connection_id)
        .unwrap()
        .result = receiver;
    f.provider.fail.store(false, Ordering::SeqCst);
    f.provider.release.add_permits(1);
    let next = source.capture().await.unwrap();
    assert_eq!(next.main_output_limit, Some(128_000));
    assert_eq!(next.context.as_ref().unwrap().context_window, Some(200_000));
    assert_eq!(
        next.context.as_ref().unwrap().declared_window,
        Some(170_000)
    );
    assert!(
        next.context
            .as_ref()
            .unwrap()
            .codex
            .as_ref()
            .unwrap()
            .compatibility
            .is_some()
    );
    assert_eq!(
        first.main_output_limit, None,
        "prepared requests remain frozen"
    );
    assert_eq!(first.context.as_ref().unwrap().context_window, None);

    let restored = super::super::Source::restore(
        f.store.clone(),
        f.credentials.clone(),
        serde_json::from_slice(&accepted).unwrap(),
        "session".into(),
        source.revision.clone(),
    )
    .unwrap();
    let after_restart = restored.capture().await.unwrap();
    assert_eq!(after_restart.main_output_limit, next.main_output_limit);
    assert_eq!(after_restart.context, next.context);

    let row = f.store.catalog().await.unwrap().connections.remove(0);
    f.store
        .update_connection(
            serde_json::from_value(json!({
                "expected":{"connectionId":row.connection_id,"revision":row.revision},
                "changes":{"requestBodyOverlay":{"temperature":0.5}}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        source.capture().await.is_err(),
        "real user control changes invalidate accepted work"
    );
    f.close().await;
}

#[tokio::test]
async fn inventory_accepts_opaque_hashes_longer_than_a_local_guess() {
    use maka_agent_engine::ModelSource;
    let f = Fixture::new().await;
    let hash = "opaque-hash".repeat(64);
    *f.provider.hash.lock().unwrap() = hash.clone();
    f.provider.release.add_permits(1);
    let request = source_fixture(&f).await.capture().await.unwrap();
    let context = request.context.unwrap();
    context.validate().unwrap();
    assert_eq!(
        context.codex.unwrap().compatibility.unwrap().comp_hash,
        hash
    );
    f.close().await;
}
