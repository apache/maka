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
use base64::Engine as _;
use futures_util::future::BoxFuture;
use maka_agent_facts::{
    context::{CheckpointContent, CompactedContext, ModelPurpose, RequestContextEvidence},
    durable::{ContentRef, ModelAttemptId},
};
use maka_agent_ports::provider::Provider as _;
use maka_agent_ports::{model as protocol, provider};
use maka_capabilities::http;
use serde::de::DeserializeOwned;

const ENDPOINT: &str = "https://chatgpt.com/backend-api/codex";
const MODEL: &str = "gpt-4.1";
const PRIVATE_PROMPT: &str = "CUSTOM_TEXT_SUMMARY_MUST_NOT_BE_SENT";

// Substitute scoped I/O only, retaining real provider authorization, inventory,
// subscription decoding, canonical publication and cleanup.
struct ScopedHttp {
    local: String,
    network: Arc<dyn protocol::Transport>,
}
impl protocol::Transport for ScopedHttp {
    fn send_text(
        &self,
        socket: Arc<dyn protocol::Socket>,
        chunks: protocol::TextStream,
    ) -> BoxFuture<'_, Result<(), protocol::Error>> {
        self.network.send_text(socket, chunks)
    }
    fn identity(&self) -> u64 {
        self.network.identity()
    }
    fn request(
        &self,
        mut request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, protocol::Error>> {
        let suffix = request
            .url
            .strip_prefix(ENDPOINT)
            .expect("real subscription endpoint");
        request.url = format!("{}{suffix}", self.local);
        self.network.request(request, cancellation)
    }
    fn connect(
        &self,
        _: protocol::Connect,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Socket>, protocol::Error>> {
        panic!("Native request-lifetime Codex execution uses HTTP")
    }
}
fn transport(base: &str, network: Arc<dyn protocol::Transport>) -> Arc<dyn protocol::Transport> {
    Arc::new(ScopedHttp {
        local: base.into(),
        network,
    })
}
struct ScopedCodex {
    inner: maka_providers::codex::Codex,
    local: String,
}
impl provider::Provider for ScopedCodex {
    fn resolve(
        &self,
        request: provider::Resolve,
    ) -> BoxFuture<'_, Result<provider::Model, provider::Error>> {
        self.inner.resolve(request)
    }
    fn authorize(
        &self,
        connection: provider::Connection,
        credential: Option<provider::authentication::Credential>,
        session: String,
    ) -> BoxFuture<'_, Result<protocol::Credentials, provider::Error>> {
        self.inner.authorize(connection, credential, session)
    }
    fn discover(
        &self,
        request: provider::Discovery,
        mut context: provider::Context,
    ) -> BoxFuture<'_, Result<Vec<ModelInfo>, provider::Error>> {
        context.transport = transport(&self.local, context.transport);
        self.inner.discover(request, context)
    }
    fn authenticate(
        &self,
        request: provider::authentication::Authenticate,
        mut context: provider::Context,
    ) -> BoxFuture<'_, Result<provider::authentication::Credential, provider::Error>> {
        context.transport = transport(&self.local, context.transport);
        self.inner.authenticate(request, context)
    }
    fn refresh(
        &self,
        connection: provider::Connection,
        credential: provider::authentication::Credential,
        mut context: provider::Context,
    ) -> BoxFuture<'_, Result<provider::authentication::Credential, provider::Error>> {
        context.transport = transport(&self.local, context.transport);
        self.inner.refresh(connection, credential, context)
    }
    fn verify(
        &self,
        request: provider::Verification,
        mut context: provider::Context,
    ) -> BoxFuture<'_, Result<(), provider::Error>> {
        context.transport = transport(&self.local, context.transport);
        self.inner.verify(request, context)
    }
}
struct ScopedAdapter {
    inner: protocol::Binding,
    local: String,
}
impl protocol::ProviderAdapter for ScopedAdapter {
    fn recovery_contract(
        &self,
        kind: &protocol::ProviderKind,
        tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Option<protocol::RecoveryContract> {
        self.inner.recovery_contract(kind, tools)
    }
    fn continuation_cursor(
        &self,
        contract: &protocol::RecoveryContract,
        part: &maka_agent_facts::model::ModelPart,
    ) -> Option<Value> {
        self.inner.continuation_cursor(contract, part)
    }
    fn supports_item_acceptance(&self) -> bool {
        self.inner.supports_item_acceptance()
    }
    fn enforces_idle_timeout(&self) -> bool {
        self.inner.enforces_idle_timeout()
    }
    fn open(
        &self,
        lifetime: protocol::Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Session>, protocol::Error>> {
        Box::pin(async move {
            Ok(Arc::new(ScopedSession {
                inner: self.inner.open(lifetime, cancellation).await?,
                local: self.local.clone(),
            }) as Arc<dyn protocol::Session>)
        })
    }
}
struct ScopedSession {
    inner: Arc<dyn protocol::Session>,
    local: String,
}
impl protocol::Session for ScopedSession {
    fn stream(
        &self,
        request: protocol::Request,
        mut context: protocol::Context,
    ) -> BoxFuture<'static, Result<(), protocol::Error>> {
        assert_eq!(request.provider.base_url, ENDPOINT);
        context.transport = transport(&self.local, context.transport);
        self.inner.stream(request, context)
    }
    fn retry_transport_phase(&self) -> protocol::RetryTransportPhase {
        self.inner.retry_transport_phase()
    }
    fn restore_retry_transport_phase(
        &self,
        phase: protocol::RetryTransportPhase,
    ) -> Result<(), protocol::Error> {
        self.inner.restore_retry_transport_phase(phase)
    }
    fn try_switch_fallback_transport(&self) -> bool {
        self.inner.try_switch_fallback_transport()
    }
    fn fallback_availability(
        &self,
    ) -> maka_agent_facts::model::retry_transport::FallbackAvailability {
        self.inner.fallback_availability()
    }
    fn needs_confirmation(&self) -> bool {
        self.inner.needs_confirmation()
    }
    fn confirm<'a>(
        &'a self,
        prompt: &'a maka_agent_facts::model::prompt_source::Prompt,
        ids: &'a [&'a str],
        response: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        self.inner.confirm(prompt, ids, response)
    }
}
async fn executor(base: &str) -> ModelExecutor {
    let codex = maka_providers::codex::Codex::new(Arc::new(
        maka_providers::catalog::Snapshot::bundled().unwrap(),
    ));
    let resolved = codex
        .resolve(provider::Resolve {
            connection: provider::Connection {
                id: "fixture-binding".into(),
                revision: 1,
                configuration: json!({"baseUrl":ENDPOINT,"serverSideCompaction":true}),
            },
            model: ModelInfo::new(MODEL),
            overrides: None,
            thinking_level: None,
        })
        .await
        .unwrap();
    let executor = ModelExecutor::new(Duration::from_secs(30)).unwrap();
    let provider = maka_model::ProviderConfig {
        adapter: Some(resolved.adapter.clone()),
        capabilities: resolved.info.capabilities.unwrap_or_default(),
        image_input: resolved.info.image_input,
        network: Default::default(),
        kind: resolved.protocol,
        model: MODEL.into(),
        base_url: resolved.base_url,
        auth: maka_model::ProviderAuth::RequestHeaders(BTreeMap::new()),
        headers: BTreeMap::new(),
        body_overlay: None,
    };
    let inner = executor.binding(&provider).unwrap();
    let source = inner.source().clone();
    executor.with_adapters(BTreeMap::from([(
        resolved.adapter,
        protocol::Binding::new(
            Arc::new(ScopedAdapter {
                inner,
                local: base.into(),
            }),
            source,
        ),
    )]))
}
struct CodexFixture {
    f: Fixture,
    model: ModelSelection,
    base: String,
}
impl CodexFixture {
    async fn new(base: &str) -> Self {
        Self::open(base, None).await
    }
    async fn open(base: &str, tooling: Option<service_tools::Setup>) -> Self {
        let policy = tooling.as_ref().map(service_tools::Setup::policy);
        let f = Fixture::with_services(
            "http://127.0.0.1:1/v1",
            Some(executor(base).await),
            policy,
            tooling,
        )
        .await;
        let catalog = f.config.catalog().await.unwrap();
        let identity = json!({"packageId":maka_providers::codex::ID,"entryId":maka_providers::codex::ID,
            "scope":"profile","name":"chatgpt"});
        let configuration = json!({"baseUrl":ENDPOINT,"serverSideCompaction":true});
        let CatalogMutationResult::Committed {connection:Some(basis),..}=f.config.create_connection(
            serde_json::from_value(json!({"expectedCatalogRevision":catalog.revision,"connection":{
                "slug":"chatgpt","name":"Subscription","provider":identity,"configuration":configuration,
                "enabled":true,"enabledModelIds":[MODEL,"other-model"],
                "modelOverrides":{(MODEL):{"codeMode":false,"contextWindow":128000,"inputLimit":128000,"compactionThreshold":108800}}
            }})).unwrap()).await.unwrap() else {panic!("actual subscription catalog commit")};
        let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = f
            .config
            .prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
                expected_credential: None,
                attempt_id: Uuid::new_v4().to_string(),
                target: maka_agent_facts::oauth::Target::Existing {
                    expected: ConnectionCredentialTarget {
                        connection_id: basis.connection_id.clone(),
                        revision: basis.revision,
                        slug: "chatgpt".into(),
                        provider: serde_json::from_value(identity).unwrap(),
                        configuration: configuration.clone(),
                    },
                    configuration,
                },
                authentication: maka_agent_facts::provider::AuthenticationInput {
                    method: "chatgpt".into(),
                    input: json!({}),
                },
            })
            .await
            .unwrap()
        else {
            panic!("actual subscription credential enrollment")
        };
        assert!(ticket.claim().await.unwrap());
        let token = format!(
            "header.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&json!({"chatgpt_account_id":"account-a"})).unwrap())
        );
        assert!(matches!(ticket.complete(maka_agent_facts::provider::Credential {
            secret:json!({"access_token":token,"refresh_token":"fixture-refresh","expires_at":9000000000000_u64,"id_token":null}).to_string(),
            refresh_at:None,
        },now()).await.unwrap(),maka_config::oauth::enrollment::LoginCompletion::Committed(_)));
        let result = Self {
            f,
            model: ModelSelection {
                connection_id: basis.connection_id,
                model_id: MODEL.into(),
            },
            base: base.into(),
        };
        result.refresh("3000").await;
        result
    }
    async fn refresh(&self, hash: &str) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let body =
            json!({"models":[{"slug":MODEL,"context_window":128000,"comp_hash":hash}]}).to_string();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8(bytes).unwrap();
            assert!(head.starts_with("GET /models?"));
            assert!(
                head.to_ascii_lowercase()
                    .contains("chatgpt-account-id: account-a")
            );
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let codex = maka_providers::codex::Codex::new(Arc::new(
            maka_providers::catalog::Snapshot::bundled().unwrap(),
        ));
        let policy = Arc::new(
            provider::Policy::new(codex.definition().unwrap().descriptor().clone()).unwrap(),
        );
        let definition = Arc::new(provider::Definition::new(
            policy,
            Arc::new(ScopedCodex {
                inner: codex,
                local: base,
            }),
        ));
        let binding = maka_agent_facts::execution::ModelBinding {
            connection_id: self.model.connection_id.clone(),
            connection_slug: "chatgpt".into(),
            model: MODEL.into(),
        };
        let material = self
            .f
            .config
            .observe_model(binding.clone())
            .await
            .unwrap()
            .unwrap();
        self.f
            .owner
            .credentials
            .inventory
            .ensure(
                self.f.config.clone(),
                self.f.owner.credentials.clone(),
                definition,
                binding,
                &material,
            )
            .await;
        server.await.unwrap();
        let material = self
            .f
            .config
            .observe_selected_model(self.model.clone())
            .await
            .unwrap()
            .unwrap();
        let proof = self
            .f
            .owner
            .credentials
            .inventory
            .provenance(&material, MODEL);
        assert_eq!(proof.connection_id, self.model.connection_id);
        assert_eq!(proof.account_id.as_deref(), Some("account-a"));
        assert_eq!(proof.compatibility.unwrap().comp_hash, hash);
    }
    async fn edit(&self, enabled: bool, narrow: bool) {
        let row = self
            .f
            .config
            .catalog()
            .await
            .unwrap()
            .connections
            .into_iter()
            .find(|row| row.connection_id == self.model.connection_id)
            .unwrap();
        assert!(matches!(
            self.f
                .config
                .update_connection(UpdateCatalogConnectionInput {
                    expected: ConnectionVersionBasis {
                        connection_id: row.connection_id,
                        revision: row.revision
                    },
                    changes: ConnectionCatalogEntryUpdate {
                        configuration: Some(
                            json!({"baseUrl":ENDPOINT,"serverSideCompaction":enabled})
                        ),
                        enabled_model_ids: if narrow {
                            Some(vec![MODEL.into()])
                        } else {
                            None
                        },
                        ..Default::default()
                    },
                })
                .await
                .unwrap(),
            CatalogMutationResult::Committed { .. }
        ));
    }
    async fn send(&self, session: &str, text: &str) -> RunId {
        let queued = self
            .f
            .mutation(
                2,
                "send",
                json!({"sessionId":session,"message":text,"delivery":"queue",
            "backend":model_backend(&self.model)}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        self.f.delivered_run(&queued).await
    }
    async fn compact(&self, session: &str, prompt: &str) -> RunId {
        let started = self
            .f
            .mutation(
                2,
                "compact",
                json!({"sessionId":session,"model":self.model,"prompt":prompt}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(started["kind"], "started", "{started}");
        serde_json::from_value(started["execution"]["runId"].clone()).unwrap()
    }
    async fn done(&self, session: &str, run: RunId, terminal: Terminal) {
        self.f.drained().await;
        let view = self.f.owner.durable.frontier(run).await.unwrap();
        assert_eq!(view.spec.session_id, session);
        assert_eq!(view.terminal, Some(terminal), "{view:?}");
        let ready: maka_agent_api::contract::WorkReadiness = serde_json::from_value(
            self.f
                .query(
                    "workReadiness",
                    json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            ready,
            maka_agent_api::contract::WorkReadiness::Ready
        ));
    }
    async fn baseline(&self, session: &str) -> Option<CompactedContext> {
        let records = self.f.recorded_facts(session).await;
        for record in records.iter().rev() {
            if let Fact::ContextCompacted { baseline } = &record.fact {
                let value: CompactedContext = decode(&self.f, record.run, baseline).await;
                value.validate().unwrap();
                return Some(value);
            }
        }
        None
    }
    async fn close(self) {
        self.f.app.shutdown().await.unwrap();
        self.f.config.shutdown().await.unwrap();
        let Fixture {
            store,
            owner,
            app,
            services,
            _dir,
            ..
        } = self.f;
        drop((owner, app, services));
        Arc::try_unwrap(store)
            .ok()
            .expect("actual Root owners released")
            .close()
            .await
            .unwrap();
    }
}
async fn decode<T: DeserializeOwned>(f: &Fixture, run: RunId, reference: &ContentRef) -> T {
    serde_json::from_slice(
        &f.owner
            .durable
            .content(run, reference.clone())
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn read(socket: &mut TcpStream) -> Value {
    let (headers, body) = super::http_fixture::read_request(socket).await;
    let headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with("post /v1/responses "));
    assert!(headers.contains("authorization: bearer header."));
    assert!(headers.contains("chatgpt-account-id: account-a"));
    assert!(headers.contains("originator: codex_cli_rs"));
    assert_eq!(body["store"], false);
    body
}
async fn respond(socket: &mut TcpStream, item: Value, response_id: &str) {
    let events = [
        json!({"type":"response.output_item.done","item":item}),
        json!({"type":"response.completed","response":{"id":response_id,"model":"test","output":[item],"usage":{"input_tokens":100,"output_tokens":30}}}),
    ];
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
fn message(text: &str) -> Value {
    json!({"id":format!("msg-{text}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]})
}
fn native(id: &str) -> Value {
    json!({"id":id,"type":"compaction","encrypted_content":format!("opaque-{id}"),"opaque_extension":{"keep":true}})
}
fn trigger(request: &Value) {
    assert_eq!(
        request["input"].as_array().unwrap().last().unwrap(),
        &json!({"type":"compaction_trigger"})
    );
    assert!(!request.to_string().contains(PRIVATE_PROMPT));
}

impl CodexFixture {
    async fn reopen(self) -> Self {
        let Self { f, model, base } = self;
        let deployment = f.app.source().unwrap().deployment;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        let Fixture {
            _dir,
            namespaces,
            root,
            workspace,
            store,
            config,
            issuer,
            owner,
            app,
            services,
        } = f;
        drop((owner, app, services, config));
        Arc::try_unwrap(store)
            .ok()
            .expect("old Root ownership released before reopening")
            .close()
            .await
            .unwrap();
        let root_owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
        let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(maka_agent_state::MIGRATIONS)
            .copied()
            .collect();
        let store = Arc::new(
            RootStore::open(root_owner.clone(), &migrations)
                .await
                .unwrap(),
        );
        let config = Arc::new(ConfigurationStore::for_root(root_owner).await.unwrap());
        let data = store.data_writer().unwrap();
        let state = maka_agent_state::Store::new(
            data.clone(),
            maka_agent_state::DriverDomain::new(data).unwrap(),
        )
        .unwrap();
        let catalog = bundled_catalog();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
        let capture: FixtureCapture = Arc::new(StdMutex::new(None));
        let captured = capture.clone();
        let replacement = Arc::new(StdMutex::new(Some(executor(&base).await)));
        let helper = native_helper();
        native
            .insert(
                IMPLEMENTATION.into(),
                Arc::new(move |context, configuration| {
                    let captured = captured.clone();
                    let catalog = catalog.clone();
                    let state = state.clone();
                    let helper = helper.clone();
                    let executor = replacement
                        .lock()
                        .unwrap()
                        .take()
                        .expect("one actual Native activation");
                    Box::pin(async move {
                        let services = context.services();
                        let mut owner =
                            Owner::open(context, configuration, catalog, state, helper, None)
                                .await
                                .unwrap();
                        Arc::get_mut(&mut owner).unwrap().credentials.executor = executor;
                        *captured.lock().unwrap() = Some((owner.clone(), services));
                        let service = Arc::new(Agent(owner));
                        NativeActivation {
                            owner: service.clone(),
                            exports: Ok(BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: service
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                        }
                    })
                }),
            )
            .unwrap();
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let (owner, services) = capture.lock().unwrap().take().unwrap();
        let result = Self {
            f: Fixture {
                _dir,
                namespaces,
                root,
                workspace,
                store,
                config,
                issuer,
                owner,
                app,
                services,
            },
            model,
            base,
        };
        result.refresh("3000").await;
        result
    }
}

async fn physical(f: &CodexFixture, session: &str) -> Vec<(RunId, ModelAttemptId, RequestSpec)> {
    let mut requests = Vec::new();
    for record in f.f.recorded_facts(session).await {
        if let Fact::ModelAttemptPrepared { attempt, step } = record.fact {
            let request = f.f.owner.durable.request(record.run, step).await.unwrap();
            let evidence: RequestContextEvidence =
                decode(&f.f, record.run, &request.provenance).await;
            let context = evidence
                .model_context
                .expect("actual captured subscription context");
            assert_eq!(context.provider_id, "chatgpt");
            let producer = context.codex.expect("actual account inventory provenance");
            assert_eq!(producer.connection_id, f.model.connection_id);
            assert_eq!(producer.account_id.as_deref(), Some("account-a"));
            requests.push((record.run, attempt, request));
        }
    }
    requests
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_compact_replay_roll_forward_and_restart_preserve_opaque_items() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (index, item) in [
                message("old-answer"),
                native("cmp-1"),
                message("tail-answer"),
                native("cmp-2"),
                message("reopened"),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read(&mut socket).await);
                respond(&mut socket, item, &format!("response-{index}")).await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            requests
        });
        let f = CodexFixture::new(&base).await;
        let session = f.f.create("Native replay").await;
        for (id, compact) in [
            ("old", false),
            ("compact-1", true),
            ("tail", false),
            ("compact-2", true),
        ] {
            let run = if compact {
                f.compact(&session, PRIVATE_PROMPT).await
            } else {
                f.send(&session, &format!("question-{id}")).await
            };
            f.done(&session, run, Terminal::Completed).await;
        }
        let before = f.baseline(&session).await.unwrap();
        assert!(matches!(
            before.checkpoint.summary,
            CheckpointContent::CodexNative {
                estimated_tokens: 30,
                ..
            }
        ));
        assert_eq!(
            before.native.as_ref().unwrap().item.item(),
            &native("cmp-2")
        );
        assert!(
            !serde_json::to_string(&before.checkpoint)
                .unwrap()
                .contains("opaque-cmp-2")
        );
        assert!(before.checkpoint.previous_checkpoint_id.is_some());
        let records = f.f.recorded_facts(&session).await;
        let second_summary = physical(&f, &session)
            .await
            .into_iter()
            .find(|(_, _, request)| request.step == before.checkpoint.summary_step_id)
            .unwrap();
        let closure = records
            .iter()
            .find_map(|record| match &record.fact {
                Fact::ModelClosed {
                    attempt, protocol, ..
                } if *attempt == second_summary.1 => Some(protocol),
                _ => None,
            })
            .unwrap();
        let closure: maka_agent_facts::context::ModelClosureProtocol =
            serde_json::from_value(closure.clone()).unwrap();
        assert_eq!(closure.model.as_deref(), Some("test"));
        assert_eq!(
            closure.compaction.as_ref().unwrap().item(),
            &native("cmp-2")
        );
        let f = f.reopen().await;
        assert_eq!(
            f.f.recorded_facts(&session).await,
            records,
            "Root reopen never reexecutes old requests"
        );
        assert_eq!(f.baseline(&session).await, Some(before));
        let run = f.send(&session, "question-reopened").await;
        f.done(&session, run, Terminal::Completed).await;
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 5);
        let attempts = physical(&f, &session).await;
        assert_eq!(attempts.len(), 5);
        assert_eq!(
            attempts
                .iter()
                .filter(|(_, _, request)| request.accounting.purpose == ModelPurpose::Summary)
                .count(),
            2
        );
        for index in [1, 3] {
            trigger(&requests[index]);
        }
        assert!(
            requests[2]["input"]
                .as_array()
                .unwrap()
                .contains(&native("cmp-1"))
        );
        assert!(!requests[2].to_string().contains("old-answer"));
        assert!(
            requests[3]["input"]
                .as_array()
                .unwrap()
                .contains(&native("cmp-1"))
        );
        assert!(
            requests[4]["input"]
                .as_array()
                .unwrap()
                .contains(&native("cmp-2"))
        );
        assert!(!requests[4].to_string().contains("opaque-cmp-1"));
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabling_native_compaction_replays_existing_checkpoint_then_installs_text_summary() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (index, item) in [
                message("old-answer"),
                native("cmp-enabled"),
                message("continued-with-option-off"),
                message("text-summary"),
                message("continued-after-text-compaction"),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read(&mut socket).await);
                respond(&mut socket, item, &format!("response-{index}")).await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            requests
        });
        let f = CodexFixture::new(&base).await;
        let session = f.f.create("Opt out").await;
        let run = f.send(&session, "question-seed").await;
        f.done(&session, run, Terminal::Completed).await;
        let run = f.compact(&session, PRIVATE_PROMPT).await;
        f.done(&session, run, Terminal::Completed).await;
        f.edit(false, false).await;
        f.refresh("3000").await;
        let run = f.send(&session, "question-off").await;
        f.done(&session, run, Terminal::Completed).await;
        let run = f.compact(&session, "Summarize this conversation.").await;
        f.done(&session, run, Terminal::Completed).await;
        let baseline = f.baseline(&session).await.unwrap();
        assert_eq!(
            baseline.checkpoint.summary,
            CheckpointContent::Text("text-summary".into())
        );
        assert!(baseline.native.is_none());
        let run = f.send(&session, "question-after-text").await;
        f.done(&session, run, Terminal::Completed).await;
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 5);
        let attempts = physical(&f, &session).await;
        assert_eq!(attempts.len(), 5);
        assert_eq!(
            attempts
                .iter()
                .filter(|(_, _, request)| request.accounting.purpose == ModelPurpose::Summary)
                .count(),
            2
        );
        trigger(&requests[1]);
        for request in &requests[2..] {
            assert!(
                !request["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["type"] == "compaction_trigger")
            );
        }
        for request in &requests[2..4] {
            assert!(
                request["input"]
                    .as_array()
                    .unwrap()
                    .contains(&native("cmp-enabled"))
            );
        }
        assert!(
            requests[3]
                .to_string()
                .contains("Summarize this conversation.")
        );
        assert!(!requests[4].to_string().contains("opaque-cmp-enabled"));
        assert!(requests[4].to_string().contains("text-summary"));
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_native_compaction_keeps_original_history_and_never_falls_back_to_text() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read(&mut socket).await);
                respond(
                    &mut socket,
                    message(if index == 0 {
                        "original-answer"
                    } else {
                        "ordinary-text"
                    }),
                    &format!("response-{index}"),
                )
                .await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            requests
        });
        let f = CodexFixture::new(&base).await;
        let session = f.f.create("Known failed native Summary").await;
        let run = f.send(&session, "question-old").await;
        f.done(&session, run, Terminal::Completed).await;
        let failed = f.compact(&session, PRIVATE_PROMPT).await;
        f.done(&session, failed, Terminal::Failed).await;
        assert!(f.baseline(&session).await.is_none());
        let records = f.f.recorded_facts(&session).await;
        assert!(
            !records
                .iter()
                .any(|record| matches!(&record.fact, Fact::ContextCompacted { .. }))
        );
        let run = f.send(&session, "question-next").await;
        f.done(&session, run, Terminal::Completed).await;
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        let attempts = physical(&f, &session).await;
        assert_eq!(attempts.len(), 3);
        assert_eq!(
            attempts
                .iter()
                .filter(|(_, _, request)| request.accounting.purpose == ModelPurpose::Summary)
                .count(),
            1
        );
        trigger(&requests[1]);
        assert!(requests[2].to_string().contains("original-answer"));
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_native_stream_cannot_install_an_unfinished_checkpoint() {
    tokio::time::timeout(Duration::from_secs(45),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let (entered,ready)=tokio::sync::oneshot::channel();
        let stop=CancellationToken::new();let stopped=stop.clone();
        let server=tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();let first=read(&mut socket).await;
            respond(&mut socket,message("original"),"old-response").await;
            let (mut socket,_)=listener.accept().await.unwrap();let second=read(&mut socket).await;trigger(&second);
            let event=json!({"type":"response.output_item.done","item":native("unfinished")});
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {event}\n\n").as_bytes()).await.unwrap();
            entered.send(()).unwrap();stopped.cancelled().await;
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());[first,second]
        });
        let f=CodexFixture::new(&base).await;let session=f.f.create("Cancel unfinished compaction").await;
        let run=f.send(&session,"question-old").await;f.done(&session,run,Terminal::Completed).await;
        let cancelled=f.compact(&session,PRIVATE_PROMPT).await;ready.await.unwrap();
        assert!(f.f.owner.durable.frontier(cancelled).await.unwrap().terminal.is_none());
        assert_eq!(f.f.mutation(2,"stop",json!({"sessionId":session,"runId":cancelled}),Uuid::new_v4()).await.unwrap()["requested"],true);
        f.done(&session,cancelled,Terminal::Cancelled).await;stop.cancel();
        assert!(f.baseline(&session).await.is_none());
        let records=f.f.recorded_facts(&session).await;
        assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ContextCompacted {..})));
        assert!(!records.iter().any(|record|record.run==cancelled&&matches!(&record.fact,Fact::ModelClosed {outcome:maka_agent_facts::accounting::Outcome::Success,..})));
        assert_eq!(server.await.unwrap().len(),2);let attempts=physical(&f,&session).await;assert_eq!(attempts.len(),2);
        assert_eq!(attempts.iter().filter(|(_,_,request)|request.accounting.purpose==ModelPurpose::Summary).count(),1);
        f.close().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_uses_native_prefix_without_mistaking_it_for_a_new_assistant_turn() {
    tokio::time::timeout(Duration::from_secs(45),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {
            let mut requests=Vec::new();
            for index in 0..4 {
                let (mut socket,_)=listener.accept().await.unwrap();requests.push(read(&mut socket).await);
                if index==2 {
                    let body=r#"{"error":{"message":"invalid fixture request","type":"invalid_request_error"}}"#;
                    socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                }else{respond(&mut socket,if index==1 {native("baseline")}else{message("answer")},&format!("response-{index}")).await;}
            }
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());requests
        });
        let f=CodexFixture::new(&base).await;let session=f.f.create("Native continuation").await;
        let run=f.send(&session,"question-old").await;f.done(&session,run,Terminal::Completed).await;
        let run=f.compact(&session,PRIVATE_PROMPT).await;f.done(&session,run,Terminal::Completed).await;
        let source=f.send(&session,"question-paused").await;f.done(&session,source,Terminal::Failed).await;
        let original=f.f.recorded_facts(&session).await.into_iter().filter(|record|record.run==source).collect::<Vec<_>>();
        let execution=f.f.query("execution",json!({"sessionId":session,"runId":source})).await.unwrap()["execution"].clone();
        let child=f.f.mutation(2,"continueRun",json!({"sessionId":session,"sourceRunId":source,
            "sourceHighWater":execution["highWater"],"model":f.model}),Uuid::new_v4()).await.unwrap();
        assert_eq!(child["kind"],"started","{child}");
        let child_run=serde_json::from_value(child["execution"]["runId"].clone()).unwrap();assert_ne!(child_run,source);
        f.done(&session,child_run,Terminal::Completed).await;
        assert_eq!(f.f.recorded_facts(&session).await.into_iter().filter(|record|record.run==source).collect::<Vec<_>>(),original);
        let requests=server.await.unwrap();assert_eq!(requests.len(),4);let attempts=physical(&f,&session).await;assert_eq!(attempts.len(),4);
        assert_eq!(attempts.iter().filter(|(_,_,request)|request.accounting.purpose==ModelPurpose::Summary).count(),1);
        assert!(requests[3]["input"].as_array().unwrap().contains(&native("baseline")));
        assert!(requests[3].to_string().contains("question-paused"));assert!(!requests[3].to_string().contains("question-child"));
        assert!(!requests[3]["input"].as_array().unwrap().iter().any(|item|item["type"]=="compaction_trigger"));
        f.close().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_hash_change_can_recompact_an_existing_checkpoint_without_new_messages() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (index, item) in [
                message("old"),
                native("before"),
                native("after"),
                message("continued"),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read(&mut socket).await);
                respond(&mut socket, item, &format!("response-{index}")).await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            requests
        });
        let f = CodexFixture::new(&base).await;
        let session = f.f.create("Changed native compatibility").await;
        let run = f.send(&session, "question-old").await;
        f.done(&session, run, Terminal::Completed).await;
        let run = f.compact(&session, PRIVATE_PROMPT).await;
        f.done(&session, run, Terminal::Completed).await;
        let before = f.baseline(&session).await.unwrap();
        assert_eq!(
            before
                .native
                .as_ref()
                .unwrap()
                .producer
                .compatibility
                .as_ref()
                .unwrap()
                .comp_hash,
            "3000"
        );
        // Narrowing the actual enabled roster changes the account inventory scope;
        // its fresh HTTP observation, not a stamped request flag, supplies 4000.
        f.edit(true, true).await;
        f.refresh("4000").await;
        let after = f.compact(&session, PRIVATE_PROMPT).await;
        f.done(&session, after, Terminal::Completed).await;
        let baseline = f.baseline(&session).await.unwrap();
        assert_eq!(
            baseline
                .native
                .as_ref()
                .unwrap()
                .producer
                .compatibility
                .as_ref()
                .unwrap()
                .comp_hash,
            "4000"
        );
        assert_eq!(
            baseline.native.as_ref().unwrap().item.item(),
            &native("after")
        );
        let mut user_messages = 0;
        let mut standalone_compactions = 0;
        for record in f.f.recorded_facts(&session).await {
            if let Fact::RunAdmitted { spec } = &record.fact {
                let spec: maka_agent_facts::durable::RunSpec = decode(&f.f, record.run, spec).await;
                let input: maka_agent_facts::input::RunInput =
                    decode(&f.f, record.run, &spec.input).await;
                match input {
                    maka_agent_facts::input::RunInput::Message { .. } => user_messages += 1,
                    maka_agent_facts::input::RunInput::ContextCompact { .. } => {
                        standalone_compactions += 1
                    }
                    other => panic!("unexpected admission between the two checkpoints: {other:?}"),
                }
            }
        }
        assert_eq!(
            user_messages, 1,
            "the hash change does not enqueue a new message"
        );
        assert_eq!(standalone_compactions, 2);
        let run = f.send(&session, "question-next").await;
        f.done(&session, run, Terminal::Completed).await;
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 4);
        let attempts = physical(&f, &session).await;
        assert_eq!(attempts.len(), 4);
        assert_eq!(
            attempts
                .iter()
                .filter(|(_, _, request)| request.accounting.purpose == ModelPurpose::Summary)
                .count(),
            2
        );
        assert!(
            requests[2]["input"]
                .as_array()
                .unwrap()
                .contains(&native("before"))
        );
        trigger(&requests[2]);
        assert!(
            requests[3]["input"]
                .as_array()
                .unwrap()
                .contains(&native("after"))
        );
        f.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_capability_without_subscription_facts_is_rejected_before_dispatch() {
    use maka_agent_facts::context::{ModelOperation, ModelRequestContext};
    // These malformed producer inputs are not SDK-reachable: actual Native Source
    // always stamps its own context. Exercise its real preparation guard directly.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let missing_producer = ModelRequestContext {
        operation: ModelOperation::Inference,
        provider_id: "openai".into(),
        codex: None,
        context_window: Some(128_000),
        model_context_window: Some(128_000),
        declared_window: Some(108_800),
    };
    for context in [None, Some(&missing_producer)] {
        let error = crate::owner::driver_model::validate_native_compaction_producer(true, context)
            .unwrap_err();
        assert!(
            matches!(error,maka_agent_engine::RunError::InvalidInput(ref reason)
            if reason=="native compaction requires ChatGPT producer provenance"),
            "{error:?}"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err(),
            "invalid producer facts cannot reach model dispatch"
        );
    }
}

#[derive(Default)]
struct TailEffects {
    state: std::sync::OnceLock<maka_agent_state::Store>,
    inputs: Arc<StdMutex<Vec<Value>>>,
}
impl maka_host_runtime::application::Handler for TailEffects {
    fn call(
        &self,
        method: String,
        input: Value,
        context: maka_host_runtime::application::Context,
    ) -> BoxFuture<'static, maka_host_runtime::application::HandlerResult> {
        assert_eq!(method, "echo");
        let operation = context.operation().cloned().expect("actual Host mutation");
        let identity = context
            .scope()
            .identity
            .agent()
            .expect("actual Agent caller")
            .clone();
        assert!(context.work_custody().is_some());
        let state = self
            .state
            .get()
            .expect("attach the actual Native Store")
            .clone();
        let inputs = self.inputs.clone();
        Box::pin(async move {
            let view = state.frontier(identity.run_id).await.unwrap();
            assert!(
                view.tools
                    .values()
                    .any(|tool| tool.admitted && tool.original.as_ref() == Some(&operation)),
                "canonical original T1 precedes the actual Handler effect"
            );
            inputs.lock().unwrap().push(input.clone());
            Ok(maka_host_runtime::application::HandlerValue::Json(input))
        })
    }
}
impl maka_host_runtime::application::NativeOwner for TailEffects {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
async fn tail_response(socket: &mut TcpStream, item: Option<Value>, id: &str, input_tokens: u64) {
    let output_tokens = if item.is_some() { 30 } else { 0 };
    let mut events = Vec::new();
    if let Some(item) = &item {
        events.push(json!({"type":"response.output_item.done","item":item}));
    }
    events.push(json!({"type":"response.completed","response":{"id":id,"status":"completed","model":"test",
        "output":item.into_iter().collect::<Vec<_>>(),"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens}}}));
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
fn tail_call(id: &str, value: u64) -> Value {
    json!({"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":"echo","arguments":json!({"value":value}).to_string()})
}
fn tail_anchor(input: &[Value]) -> usize {
    input
        .iter()
        .position(|item| {
            item["role"] == "user" && item["content"].to_string().contains("question next")
        })
        .unwrap()
}
fn tail_result_count(input: &[Value], id: &str) -> usize {
    input
        .iter()
        .filter(|item| item["type"] == "function_call_output" && item["call_id"] == id)
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_prepared_summary_preserves_steering_tool_tail_and_frozen_retry_until_adoption() {
    tokio::time::timeout(Duration::from_secs(60),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let effects=Arc::new(TailEffects::default());
        let setup=service_tools::Setup::echo(effects.clone(),effects.clone());
        let f=CodexFixture::open(&base,Some(setup)).await;
        effects.state.set(f.f.owner.durable.clone()).unwrap_or_else(|_|panic!("attach actual State once"));
        let row=f.f.config.catalog().await.unwrap().connections.into_iter().find(|row|row.connection_id==f.model.connection_id).unwrap();
        assert!(matches!(f.f.config.update_connection(UpdateCatalogConnectionInput {
            expected:ConnectionVersionBasis {connection_id:row.connection_id,revision:row.revision},
            changes:ConnectionCatalogEntryUpdate {model_overrides:Patch::Set(BTreeMap::from([(MODEL.into(),ModelOverride {
                code_mode:Some(false),context_window:Some(200_000),input_limit:Some(170_000),
                compaction_threshold:Some(110_000),..Default::default()
            })])),..Default::default()},
        }).await.unwrap(),CatalogMutationResult::Committed {..}));
        let session=f.f.create("Native prepared Summary tail").await;
        let old=f.send(&session,"question old").await;
        let (mut socket,_)=listener.accept().await.unwrap();let first=read(&mut socket).await;
        assert!(first.to_string().contains("question old"));
        tail_response(&mut socket,Some(message("old-answer")),"old",100_000).await;
        f.done(&session,old,Terminal::Completed).await;

        let run=f.send(&session,"question next").await;
        let (mut socket,_)=listener.accept().await.unwrap();let summary_wire=read(&mut socket).await;
        trigger(&summary_wire);
        for private in ["question next","A queued correction","during-summary-call"] {
            assert!(!summary_wire["input"].to_string().contains(private));
        }
        // Prepare85 closes the actual candidate before the original Main starts.
        tail_response(&mut socket,Some(native("summary-marker")),"summary",100).await;
        let (mut socket,_)=listener.accept().await.unwrap();let deferred=read(&mut socket).await;
        assert!(deferred["input"].to_string().contains("old-answer"));
        assert!(!deferred["input"].to_string().contains("summary-marker"));
        assert!(f.f.owner.durable.frontier(run).await.unwrap().baseline.is_none());
        tail_response(&mut socket,Some(tail_call("during-summary-call",41)),"during",100_000).await;

        let (mut socket,_)=listener.accept().await.unwrap();let tool_tail=read(&mut socket).await;
        assert_eq!(tail_result_count(tool_tail["input"].as_array().unwrap(),"during-summary-call"),1);
        let steering=f.f.mutation(2,"send",json!({"sessionId":session,"message":"A queued correction",
            "delivery":"steer","expectedRunId":run}),Uuid::new_v4()).await.unwrap();
        assert_eq!(steering["kind"],"queued","{steering}");
        // A real empty Finished boundary lets the single driver consume steering;
        // no invented assistant prose is added to the canonical conversation.
        tail_response(&mut socket,None,"steering-boundary",100_000).await;

        let (mut socket,_)=listener.accept().await.unwrap();let frozen=read(&mut socket).await;
        assert!(frozen["input"].to_string().contains("A queued correction"));
        assert!(!frozen["input"].to_string().contains("summary-marker"));
        let input=frozen["input"].as_array().unwrap();let anchor=tail_anchor(input);
        let frozen_tail=input[anchor..].to_vec();
        let result=frozen_tail.iter().filter(|item|item["type"]=="function_call_output").collect::<Vec<_>>();
        assert_eq!(result.len(),1);assert!(result[0]["output"].to_string().contains("41"));
        let body=r#"{"error":{"message":"retry","type":"rate_limit_error"}}"#;
        socket.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 0.01\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();

        let (mut socket,_)=listener.accept().await.unwrap();let retry=read(&mut socket).await;
        assert_eq!(retry,frozen,"physical retry sends the complete original frozen JSON");
        tail_response(&mut socket,Some(tail_call("while-summary-ready",43)),"while-ready",100_000).await;
        let (mut socket,_)=listener.accept().await.unwrap();let ready=read(&mut socket).await;
        assert!(ready["input"].to_string().contains("old-answer"));
        assert!(!ready["input"].to_string().contains("summary-marker"));
        assert!(f.f.owner.durable.frontier(run).await.unwrap().baseline.is_none(),"ready below Adopt100 stays deferred");
        tail_response(&mut socket,Some(tail_call("after-summary-call",42)),"after",110_000).await;

        let (mut socket,_)=listener.accept().await.unwrap();let adopted=read(&mut socket).await;
        let input=adopted["input"].as_array().unwrap();let anchor=tail_anchor(input);
        assert!(input[..anchor].iter().any(|item|item.to_string().contains("summary-marker")));
        assert!(!adopted["input"].to_string().contains("old-answer"));
        assert_eq!(adopted["input"].to_string().matches("A queued correction").count(),1);
        assert_eq!(&input[anchor..anchor+frozen_tail.len()],frozen_tail.as_slice(),"every original pending-tail item keeps its order and bytes");
        let later=&input[anchor+frozen_tail.len()..];assert_eq!(later.len(),4);
        assert_eq!(later[0]["type"],"function_call");assert_eq!(later[0]["call_id"],"while-summary-ready");
        assert_eq!(later[1]["type"],"function_call_output");assert_eq!(later[1]["call_id"],"while-summary-ready");
        assert_eq!(later[2]["type"],"function_call");assert_eq!(later[2]["call_id"],"after-summary-call");
        assert_eq!(later[3]["type"],"function_call_output");assert_eq!(later[3]["call_id"],"after-summary-call");
        assert!(later[3]["output"].to_string().contains("42"));
        assert_eq!(tail_result_count(input,"during-summary-call"),1);
        assert_eq!(tail_result_count(input,"after-summary-call"),1);
        tail_response(&mut socket,Some(message("done")),"done",100).await;
        f.done(&session,run,Terminal::Completed).await;
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"exactly eight model POSTs");
        assert_eq!(*effects.inputs.lock().unwrap(),vec![json!({"value":41}),json!({"value":43}),json!({"value":42})]);

        let all=physical(&f,&session).await;assert_eq!(all.len(),8);
        let attempts=all.iter().filter(|(owner,_,_)|*owner==run).collect::<Vec<_>>();assert_eq!(attempts.len(),7);
        let summaries=attempts.iter().copied().filter(|(_,_,request)|request.accounting.purpose==ModelPurpose::Summary).collect::<Vec<_>>();
        assert_eq!(summaries.len(),1);let (_,summary_attempt,summary)=summaries[0];
        assert!(attempts.iter().filter(|(_,_,request)|request.accounting.purpose==ModelPurpose::Main)
            .all(|(_,_,request)|request.compaction_recovery==Some(*summary_attempt)),"the one candidate owns the consumed budget through every semantic Main");
        let deferred_context:RequestContextEvidence=decode(&f.f,run,&attempts[1].2.provenance).await;
        assert!((93_500..110_000).contains(&deferred_context.estimated_input_tokens));
        assert_ne!(attempts[3].1,attempts[4].1);
        assert_eq!(attempts[3].2.step,attempts[4].2.step);
        assert_eq!(attempts[3].2.request,attempts[4].2.request);
        assert_eq!(attempts[3].2.source_capture,attempts[4].2.source_capture);
        assert_eq!(attempts[3].2.source_digest,attempts[4].2.source_digest);
        let baseline=f.baseline(&session).await.unwrap();
        assert_eq!(baseline.checkpoint.summary_step_id,summary.step);
        assert_eq!(baseline.source_capture,summary.source_capture);
        assert_eq!(baseline.native.as_ref().unwrap().item.item(),&native("summary-marker"));
        let source:maka_agent_facts::history_snapshot::RequestSource=decode(&f.f,run,&summary.source_capture).await;
        assert_eq!(baseline.checkpoint.covered_through,source.current.through_sequence);
        let records=f.f.recorded_facts(&session).await.into_iter().filter(|record|record.run==run).collect::<Vec<_>>();
        let mut original_main=None;
        for record in &records {
            if let Fact::StepPrepared {step,..}=&record.fact {
                let request=f.f.owner.durable.request(run,*step).await.unwrap();
                if request.accounting.purpose==ModelPurpose::Main&&request.compaction_recovery.is_none()
                    &&!attempts.iter().any(|(_,_,actual)|actual.step==*step) {
                    original_main=Some(request);break;
                }
            }
        }
        let original_main=original_main.expect("the real original unattempted Main was frozen before Summary");
        assert_eq!(attempts[1].2.request,original_main.request);
        assert_eq!(attempts[1].2.source_capture,original_main.source_capture);
        assert_eq!(attempts[1].2.source_digest,original_main.source_digest);
        let t1=records.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {..})).collect::<Vec<_>>();
        let t2=records.iter().filter(|record|matches!(&record.fact,Fact::ToolResultAccepted {..})).collect::<Vec<_>>();
        assert_eq!(t1.len(),3);assert_eq!(t2.len(),3);
        assert!(t1.iter().chain(t2.iter()).all(|record|record.revision>source.current_revision),"candidate coverage never consumes later tool effects");
        assert_eq!(records.iter().filter(|record|matches!(&record.fact,Fact::ContextCompacted {..})).count(),1);
        assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {attempt,..} if attempt==summary_attempt)));
        let closure=records.iter().find_map(|record|match &record.fact {
            Fact::ModelClosed {attempt,protocol,..} if attempt==summary_attempt=>Some(protocol),_=>None,
        }).unwrap();
        let closure:maka_agent_facts::context::ModelClosureProtocol=serde_json::from_value(closure.clone()).unwrap();
        assert_eq!(closure.finish_reason,maka_agent_facts::model::ModelFinishReason::Stop);
        assert_eq!(closure.compaction.as_ref().unwrap().item(),&native("summary-marker"));
        f.close().await;
    }).await.unwrap();
}
