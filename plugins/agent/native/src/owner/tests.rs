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

mod http_fixture;

mod plan_tests;

mod goal_tests;

mod recap_tests;

mod title_tests;

mod todo_tests;

mod bot_tests;

mod computer_controls;

mod service_tools;
mod skill_preparation;
mod skills;

mod attachments;

mod fork;

mod files;

mod file_browsing;

mod health;
mod processes;

mod protocol_processes;

mod terminal;

mod interactions;

mod catalog;

mod session_availability;

mod compaction;

mod metrics;

mod execution;
mod executor;

mod prompt_language;
mod session_context;
mod workhub;

mod queue;

mod mcp;
mod selection;

mod git;
mod jev_tests;
mod web_tests;

mod worktrees;

mod settings;

mod images;

mod imports;
mod projects;
mod recall_tests;
mod scheduler_tests;

mod workspaces;

use super::*;
use crate::{EXPORT, ModelSelection, contract, service::Agent};
use maka_agent_facts::configuration::*;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::Scope;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::{
    Application, Binding, Invocation as HostInvocation, NativeActivation, NativeRegistry, Policy,
};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{
        Configuration as NodeConfiguration, Input, InstanceId, Node, PackageUse, Target,
    },
    contract::{Availability, Cardinality, Export, Import},
    operation::{OperationOutcome, Receipt},
    package::{Declaration, EntryDeclaration, Implementation, Realm},
};
use serde_json::json;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

struct CallerGrant(maka_host_runtime::application::Caller);
struct Grant(Issuer, Option<Arc<maka_transport::transport::PeerPolicy>>);
impl Policy for Grant {
    fn caller(&self, scope: &Scope) -> Option<maka_host_runtime::application::Caller> {
        self.0.evidence::<CallerGrant>(scope).map(|e| e.0.clone())
    }
    fn recover(
        &self,
        invocation: maka_host_runtime::application::RecoveryInvocation<'_>,
    ) -> Result<(), String> {
        if invocation.native_origin.is_some() {
            return self
                .1
                .as_ref()
                .ok_or("native recovery denied")?
                .recover(invocation);
        }
        if self.0.evidence::<bool>(invocation.scope) == Some(&true)
            || self.0.evidence::<CallerGrant>(invocation.scope).is_some()
        {
            Ok(())
        } else {
            Err("denied".into())
        }
    }
    fn admit(&self, invocation: HostInvocation<'_>) -> Result<(), String> {
        if invocation.native_origin.is_some() {
            return self
                .1
                .as_ref()
                .ok_or("native tools denied")?
                .admit(invocation);
        }
        if self.0.evidence::<bool>(invocation.scope) == Some(&true)
            || self.0.evidence::<CallerGrant>(invocation.scope).is_some()
        {
            Ok(())
        } else {
            Err("denied".into())
        }
    }
}
fn scope(issuer: &Issuer, grant: bool) -> Scope {
    issuer
        .issue_with(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            grant,
            CancellationToken::new(),
        )
        .unwrap()
}
fn id(value: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(value)])
}
fn entry(provider: bool) -> EntryDeclaration {
    EntryDeclaration {
        implementation: if provider {
            Implementation::Native {
                implementation: IMPLEMENTATION.into(),
            }
        } else {
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            }
        },
        configuration: if provider {
            configuration_schema().into()
        } else {
            json!({"type":"object","additionalProperties":false}).into()
        },
        imports: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([
                (
                    EXPORT.into(),
                    Import {
                        contract: contract(),
                        cardinality: Cardinality::One,
                    },
                ),
                (
                    "receipts".into(),
                    Import {
                        contract: maka_plugin_core::operation::receipt_reader_contract(),
                        cardinality: Cardinality::One,
                    },
                ),
                (
                    "settings".into(),
                    Import {
                        contract: maka_settings_native::contract::contract(),
                        cardinality: Cardinality::One,
                    },
                ),
            ])
        },
        exports: if provider {
            BTreeMap::from([(
                EXPORT.into(),
                Export {
                    contract: contract(),
                    availability: Availability::Required,
                },
            )])
        } else {
            BTreeMap::new()
        },
    }
}

fn package(provider: bool) -> Package {
    application_package(if provider { "agent" } else { "consumer" }, entry(provider))
}

fn application_package(name: &str, entry: EntryDeclaration) -> Package {
    let javascript = matches!(entry.implementation, Implementation::JavaScript { .. });
    let declaration = Declaration {
        host: Some(entry),
        ui: None,
        composition: None,
    };
    let mut files = BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":name,"application":declaration}))
            .unwrap(),
    )]);
    if javascript {
        files.insert(
            "host.mjs".into(),
            b"export function activate() { return {}; }".to_vec(),
        );
    }
    Package::new(files).unwrap()
}
fn input(settings: &Configuration) -> (Input, Vec<Package>) {
    application_input(settings, package(true), package(false))
}
fn application_input(
    settings: &Configuration,
    provider: Package,
    consumer: Package,
) -> (Input, Vec<Package>) {
    let receipts = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":"receipts","application":{"host":{
            "implementation":{"kind":"native","implementation":"maka.operations.receipts"},
            "configuration":{"type":"object","additionalProperties":false},"imports":{},
            "exports":{"Receipts":{"contract":maka_plugin_core::operation::receipt_reader_contract(),"availability":"required"}}
        }}})).unwrap(),
    )])).unwrap();
    let settings_package = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":"settings","application":{"host":{
            "implementation":{"kind":"native","implementation":maka_settings_native::IMPLEMENTATION},
            "configuration":{"type":"object","properties":{},"additionalProperties":false},"imports":{},
            "exports":{(maka_settings_native::EXPORT):{"contract":maka_settings_native::contract::contract(),"availability":"required"}}
        }}})).unwrap(),
    )])).unwrap();
    let node = |key, package: &Package| Node {
        key: Uuid::from_u128(key),
        package: package.application_ref().into(),
        use_package: PackageUse::Host,
        configuration: Default::default(),
        parameters: Default::default(),
        disabled: false,
        overrides: vec![],
        bindings: Default::default(),
    };
    let caller = |key| Node {
        bindings: [
            (EXPORT, "provider", EXPORT),
            ("receipts", "receipts", "Receipts"),
            ("settings", "settings", maka_settings_native::EXPORT),
        ]
        .into_iter()
        .map(|(import, path, export)| {
            (
                import.into(),
                vec![Target::Instance {
                    path: vec![path.into()],
                    export: export.into(),
                }],
            )
        })
        .collect(),
        ..node(key, &consumer)
    };
    let input = Input {
        ui: None,
        instances: BTreeMap::from([
            (
                "provider".into(),
                Node {
                    configuration: NodeConfiguration {
                        values: serde_json::from_value(serde_json::to_value(settings).unwrap())
                            .unwrap(),
                        parameters: Default::default(),
                    },
                    ..node(1, &provider)
                },
            ),
            ("a".into(), caller(2)),
            ("b".into(), caller(3)),
            ("receipts".into(), node(4, &receipts)),
            ("settings".into(), node(5, &settings_package)),
        ]),
    };
    (input, vec![provider, consumer, receipts, settings_package])
}
// The default dispatcher is thread-local: hold the guard through current-thread
// fixture shutdown so actual producer tasks remain inside the capture.
fn log_capture() -> (std::fs::File, tracing::subscriber::DefaultGuard) {
    let file = tempfile::tempfile().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(file.try_clone().unwrap())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .without_time()
        .finish();
    (file, tracing::subscriber::set_default(subscriber))
}

fn log_text(file: &mut std::fs::File) -> String {
    use std::io::{Read, Seek};
    file.rewind().unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    text
}

fn bundled_catalog() -> Arc<maka_providers::catalog::Catalog> {
    Arc::new(maka_providers::catalog::Catalog::new(
        maka_providers::catalog::Snapshot::bundled().unwrap(),
    ))
}

type FixtureCapture =
    Arc<StdMutex<Option<(Arc<Owner>, maka_host_runtime::application::NativeServices)>>>;

enum FixtureApplication {
    Agent,
    Workhub(workhub::Setup),
}

struct Fixture {
    services: maka_host_runtime::application::NativeServices,
    _dir: tempfile::TempDir,
    namespaces: RootNamespaces,
    root: std::path::PathBuf,
    workspace: std::path::PathBuf,
    store: Arc<RootStore>,
    config: Arc<ConfigurationStore>,
    app: Application,
    issuer: Issuer,
    owner: Arc<Owner>,
}
impl Fixture {
    async fn session(&self, id: &str) -> maka_event_log::root_store::SessionStore {
        self.store
            .session(id)
            .await
            .expect("fixture Session exists")
    }

    fn runtime_databases(&self) -> Vec<std::path::PathBuf> {
        (0..8)
            .map(|partition| {
                self.root
                    .join("runtime-partitions")
                    .join(format!("{partition:02}.sqlite"))
            })
            .collect()
    }

    fn runtime_database_containing(&self, query: &str, id: &str) -> std::path::PathBuf {
        let matching: Vec<_> = self
            .runtime_databases()
            .into_iter()
            .filter(|path| {
                let db = rusqlite::Connection::open_with_flags(
                    path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .unwrap();
                db.query_row(query, [id], |row| row.get::<_, i64>(0))
                    .unwrap()
                    > 0
            })
            .collect();
        assert_eq!(
            matching.len(),
            1,
            "fixture fact must have exactly one physical owner"
        );
        matching.into_iter().next().unwrap()
    }

    async fn facts_after_failed_shutdown(
        &self,
        session: &str,
    ) -> Vec<maka_agent_facts::event::Fact> {
        // Root admission is closed after uncertain physical cleanup. Inspect
        // only the original durable evidence, without admitting another job.
        assert!(self.store.shutdown().await.is_err());
        let database = rusqlite::Connection::open_with_flags(
            self.session_database(session),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let (count, bytes): (i64, i64) = database.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(CAST(event_json AS BLOB))),0) FROM runtime_events WHERE event_session=?",
            [session], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert!(
            count <= 256 && bytes <= 4 * 1024 * 1024,
            "fixture evidence exceeds original prefix bounds"
        );
        let mut statement = database
            .prepare(
                "SELECT event_json FROM runtime_events WHERE event_session=? ORDER BY sequence",
            )
            .unwrap();
        statement
            .query_map([session], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| {
                serde_json::from_str::<maka_agent_facts::event::RuntimeEvent>(&row.unwrap())
                    .unwrap()
                    .fact
            })
            .collect()
    }

    fn session_database(&self, id: &str) -> std::path::PathBuf {
        let control = rusqlite::Connection::open_with_flags(
            self.root.join(maka_event_log::root::ROOT_DATABASE),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let partition: u32 = control
            .query_row(
                "SELECT partition FROM session_routes WHERE session_id=?",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        self.root
            .join("runtime-partitions")
            .join(format!("{partition:02}.sqlite"))
    }

    async fn prefix(
        &self,
        id: &str,
        max_events: usize,
        max_bytes: usize,
    ) -> maka_agent_facts::event::LogPrefix {
        self.session(id)
            .await
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session { id: id.to_owned() },
                max_events,
                max_bytes,
            )
            .await
            .unwrap()
    }

    async fn through(&self, id: &str) -> u64 {
        self.session(id)
            .await
            .session_projection::<Value>(id)
            .await
            .unwrap()
            .unwrap()
            .through_sequence
    }

    async fn new(base: &str, model: Option<ModelExecutor>) -> Self {
        Self::configured_provider(base, model, None, None, |_| {}, "openai-compatible").await
    }
    async fn with_services(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
    ) -> Self {
        Self::configured_provider(base, model, peer, tooling, |_| {}, "openai-compatible").await
    }
    async fn configured(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
    ) -> Self {
        Self::configured_provider(base, model, peer, tooling, configure, "openai-compatible").await
    }
    async fn configured_provider(
        base: &str,
        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
        provider_name: &str,
    ) -> Self {
        Self::configured_application(
            base,
            model,
            peer,
            tooling,
            configure,
            provider_name,
            FixtureApplication::Agent,
        )
        .await
    }
    async fn workhub(base: &str, setup: workhub::Setup) -> Self {
        Self::workhub_configured(base, setup, |_| {}).await
    }
    async fn workhub_configured(
        base: &str,
        setup: workhub::Setup,
        configure: impl FnOnce(&mut Configuration),
    ) -> Self {
        Self::configured_application(
            base,
            None,
            None,
            None,
            configure,
            "openai-compatible",
            FixtureApplication::Workhub(setup),
        )
        .await
    }
    async fn configured_application(
        base: &str,
        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
        provider_name: &str,
        application: FixtureApplication,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let workspace = dir.path().join("workspace");
        let other_workspace = dir.path().join("other-workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&other_workspace).unwrap();
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let root_owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let store = Arc::new(RootStore::open(root_owner.clone()).await.unwrap());
        let config = Arc::new(ConfigurationStore::for_root(root_owner).await.unwrap());
        let provider = json!({"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,"scope":"profile","name":provider_name});
        let create = serde_json::from_value(json!({"expectedCatalogRevision":0,"connection":{"slug":"fixture","name":"Fixture","provider":provider,"configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["fixture-model"]}})).unwrap();
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = config.create_connection(create).await.unwrap()
        else {
            panic!("connection commit");
        };
        let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = config
            .prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
                expected_credential: None,
                attempt_id: Uuid::new_v4().to_string(),
                target: maka_agent_facts::oauth::Target::Existing {
                    expected: ConnectionCredentialTarget {
                        connection_id: basis.connection_id.clone(),
                        revision: basis.revision,
                        provider: serde_json::from_value(provider).unwrap(),
                        slug: "fixture".into(),
                        configuration: json!({"baseUrl":base}),
                    },
                    configuration: json!({"baseUrl":base}),
                },
                authentication: maka_agent_facts::provider::AuthenticationInput {
                    method: "api-key".into(),
                    input: json!({"apiKey":"private-fixture-key"}),
                },
            })
            .await
            .unwrap()
        else {
            panic!("actual login preparation");
        };
        assert!(ticket.claim().await.unwrap());
        assert!(matches!(
            ticket
                .complete(
                    maka_agent_facts::provider::Credential {
                        secret: "private-fixture-key".into(),
                        refresh_at: None
                    },
                    1
                )
                .await
                .unwrap(),
            maka_config::oauth::enrollment::LoginCompletion::Committed(_)
        ));
        let mut settings = Configuration {
            mcp_servers: vec![],
            locale: String::new(),
            tool_discovery: false,
            isolated_workspaces: false,
            assistant: None,
            scheduled_tasks: false,
            goals: false,
            plans: false,
            todo: false,
            bot: false,
            automatic_titles: false,
            recaps: false,
            recall: false,
            import_roots: vec![maka_host_runtime::DirectoryRootSpec {
                label: "Import sources".into(),
                path: workspace.clone(),
            }],
            executors: vec![],
            skill_library: tooling
                .as_ref()
                .and_then(service_tools::Setup::skill_import),
            permissions: WorkspacePermissions {
                access: WorkspaceAccess::WorkspaceWrite,
                request_permissions: true,
            },
            workspace_roots: vec![
                maka_host_runtime::DirectoryRootSpec {
                    label: "Workspace".into(),
                    path: workspace.clone(),
                },
                maka_host_runtime::DirectoryRootSpec {
                    label: "Other workspace".into(),
                    path: other_workspace,
                },
            ],
            tools: vec![],
        };
        configure(&mut settings);
        if let Some(tooling) = &tooling {
            settings.tools = tooling.selections();
        }
        let (mut input, mut packages) = match &application {
            FixtureApplication::Agent => input(&settings),
            FixtureApplication::Workhub(setup) => setup.composition(&settings),
        };
        if let Some(tooling) = &tooling {
            tooling.install(&mut input, &mut packages);
        }
        let deployment = Uuid::new_v4();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let captured: FixtureCapture = Arc::new(StdMutex::new(None));
        let mut native = NativeRegistry::default();
        let catalog = bundled_catalog();
        maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
        if let Some(tooling) = &tooling {
            tooling.provide(&mut native);
        }
        match &application {
            FixtureApplication::Workhub(setup) => setup.provide(&mut native, captured.clone()),
            FixtureApplication::Agent => {
                let capture = captured.clone();
                let replacement = Arc::new(StdMutex::new(model));
                // Actual Host NativeContext and original NativeOwner; only the model
                // implementation is controlled in failure tests, never Root/admission.
                native
                    .insert(
                        IMPLEMENTATION.into(),
                        Arc::new(move |context, configuration| {
                            let capture = capture.clone();
                            let catalog = catalog.clone();
                            let replacement = replacement.lock().unwrap().take();
                            Box::pin(async move {
                                let services = context.services();
                                let mut owner =
                                    Owner::open(context, configuration, catalog).await.unwrap();
                                if let Some(model) = replacement {
                                    Arc::get_mut(&mut owner).unwrap().engine = Engine::new(
                                        model,
                                        maka_tools::CodeExecutor::new(Default::default()).unwrap(),
                                    )
                                    .unwrap();
                                }
                                *capture.lock().unwrap() = Some((owner.clone(), services));
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
            }
        }
        let (issuer, policy): (Issuer, Arc<dyn Policy>) = match &application {
            FixtureApplication::Workhub(setup) => {
                let issuer = Issuer::default();
                (
                    issuer.clone(),
                    Arc::new(Grant(issuer, Some(setup.policy()))),
                )
            }
            FixtureApplication::Agent => match peer {
                Some(peer) => (peer.issuer(), peer),
                None => {
                    let native = tooling.as_ref().map(service_tools::Setup::policy);
                    let issuer = native
                        .as_ref()
                        .map(|policy| policy.issuer())
                        .unwrap_or_default();
                    (issuer.clone(), Arc::new(Grant(issuer, native)))
                }
            },
        };
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            native,
            issuer.clone(),
            policy,
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let (owner, services) = captured.lock().unwrap().take().unwrap();
        Self {
            _dir: dir,
            services,
            namespaces,
            root,
            workspace: workspace.canonicalize().unwrap(),
            store,
            config,
            app,
            issuer,
            owner,
        }
    }
    async fn binding(&self, consumer: u128) -> Binding {
        let client = self.app.client();
        client
            .bind(client.activation(&id(consumer)).unwrap(), EXPORT.into())
            .await
            .unwrap()
            .remove(0)
    }
    async fn mutation(
        &self,
        consumer: u128,
        method: &str,
        input: Value,
        operation: Uuid,
    ) -> Result<Value, String> {
        self.mutation_with(consumer, method, input, operation, Attachments::new())
            .await
    }
    async fn mutation_with(
        &self,
        consumer: u128,
        method: &str,
        input: Value,
        operation: Uuid,
        attachments: Attachments,
    ) -> Result<Value, String> {
        let client = self.app.client();
        let prepared = client
            .prepare_mutation(
                self.binding(consumer).await,
                method.into(),
                input,
                scope(&self.issuer, true),
                operation,
                attachments.into(),
            )
            .await?;
        // Exercise the actual trusted Host gateway, including its durable caller
        // intent and original activation evidence, rather than reloading the
        // complete deployment in the test driver for every mutation.
        let reply = client.mutate_owned(prepared).await?.result().await;
        match reply.receipt {
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { value },
                ..
            } => Ok(value),
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { diagnostic },
                ..
            } => Err(diagnostic),
            Receipt::Unavailable { diagnostic } => Err(diagnostic),
            other => panic!("unexpected receipt {other:?}"),
        }
    }
    async fn create(&self, title: &str) -> String {
        self.mutation(2, "create", self.create_input(title).await, Uuid::new_v4())
            .await
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn create_input(&self, title: &str) -> Value {
        let roots = self
            .query("directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        json!({"title":title, "labels":[], "workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})
    }
    async fn selection(&self) -> ModelSelection {
        let row = self.config.catalog().await.unwrap().connections.remove(0);
        ModelSelection {
            connection_id: row.connection_id,
            revision: row.revision,
            model_id: "fixture-model".into(),
        }
    }
    async fn send(&self, session: &str) -> Result<Value, String> {
        self.mutation(
            2,
            "send",
            json!({"sessionId":session,"message":"Hello","model":self.selection().await}),
            Uuid::new_v4(),
        )
        .await
    }
    async fn query(&self, method: &str, input: Value) -> Result<Value, String> {
        self.app
            .client()
            .start(
                self.binding(2).await,
                method.into(),
                input,
                scope(&self.issuer, true),
                Attachments::new().into(),
            )
            .await?
            .result()
            .await
    }
    async fn recall(&self, input: Value) -> Result<Value, String> {
        let mut subscription = self
            .app
            .client()
            .subscribe(
                self.binding(2).await,
                "recall".into(),
                input,
                scope(&self.issuer, true),
                Attachments::new().into(),
            )
            .await?;
        while subscription.recv().await.is_some() {}
        let completion = subscription.completion().await;
        completion.cleanup?;
        completion.result
    }
    async fn drained(&self) {
        let closed = self.owner.workers.close();
        self.owner.workers.wait().await;
        if closed && !self.owner.stop.is_cancelled() {
            self.owner.workers.reopen();
        }
    }
}
async fn request(socket: &mut TcpStream) -> Value {
    request_with_key(socket, "private-fixture-key").await
}
async fn request_with_key(socket: &mut TcpStream, key: &str) -> Value {
    let (headers, body) = http_fixture::read_request(socket).await;
    assert!(
        headers
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {key}"))
    );
    body
}

async fn response(socket: &mut TcpStream) {
    response_with_text(socket, "Elegant response").await;
}
async fn response_with_text(socket: &mut TcpStream, text: &str) {
    response_with_thinking(socket, text, None).await;
}
async fn response_with_thinking(socket: &mut TcpStream, text: &str, thinking: Option<&str>) {
    let reasoning = thinking.map(|text| format!("data: {}\n\n", json!({"id":"fixture","choices":[{"index":0,"delta":{"reasoning_content":text},"finish_reason":null}]}))).unwrap_or_default();
    let delta = json!({"id":"fixture","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let end = json!({"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}});
    let body = format!("{reasoning}data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn actual_http_runs_overlap_and_observer_loss_does_not_cancel_execution() {
    tokio::time::timeout(Duration::from_secs(30),async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1",listener.local_addr().unwrap());
        let entered = Arc::new(Semaphore::new(0)); let release = Arc::new(Semaphore::new(0));
        let worker_entered = entered.clone(); let worker_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            for _ in 0..3 {
                let (mut socket,_) = listener.accept().await.unwrap();
                let entered = worker_entered.clone();
                let release = worker_release.clone();
                requests.spawn(async move {
                    let body = request(&mut socket).await;
                    assert_eq!(body["model"],"fixture-model");
                    entered.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    response(&mut socket).await;
                });
            }
            while let Some(result) = requests.join_next().await { result.unwrap(); }
        });
        let fixture = Fixture::new(&base,None).await;
        let first = fixture.create("First").await; let second = fixture.create("Second").await; let third = fixture.create("Third").await;
        let started = fixture.send(&first).await.unwrap(); entered.acquire().await.unwrap().forget();
        assert!(!fixture.app.shutdown_if_idle().await.unwrap(), "completed send RPC still owns a live model run");
        let active = fixture.query("observe", json!({"sessionId":first})).await.unwrap();
        assert_eq!(active["session"]["id"], first);
        assert_eq!(active["session"]["activity"], "working");
        fixture.session(&(catalog_interaction(&first, "working-request")).session_id).await.establish_interaction(&catalog_interaction(&first, "working-request")).await.unwrap();
        let waiting = fixture.query("observe", json!({"sessionId":first})).await.unwrap();
        assert_eq!(waiting["session"]["activity"], "waiting");
        fixture.session(&first).await.commit_interaction_outcome("working-request", maka_agent_facts::interaction::InteractionOutcome::Closure { reason: maka_agent_facts::interaction::ClosureReason::ProducerCancelled, committed_at: 20 }).await.unwrap();
        let resumed = fixture.query("observe", json!({"sessionId":first})).await.unwrap();
        assert_eq!(resumed["session"]["activity"], "working");
        assert_eq!(active["run"]["invocationId"], started["invocationId"]);
        assert_eq!(active["run"]["state"], "running");
        assert!(!active.to_string().contains("private-fixture-key"));
        let mut watch = fixture.app.client().subscribe(fixture.binding(2).await,"watch".into(),json!({"sessionId":first,"after":0}),scope(&fixture.issuer,true),Attachments::new().into()).await.unwrap();
        let page = watch.recv().await.unwrap(); assert!(!page.to_string().contains("private-fixture-key"));
        drop(watch);
        fixture.send(&second).await.unwrap();
        fixture.send(&third).await.unwrap();
        entered.acquire_many(2).await.unwrap().forget();
        assert_eq!(fixture.owner.runs.lock().await.controls.len(),3);
        release.add_permits(3); server.await.unwrap(); fixture.drained().await;
        assert!(fixture.owner.runs.lock().await.controls.is_empty());
        let completed = fixture.query("observe", json!({"sessionId":first})).await.unwrap();
        let metrics = &completed["metrics"];
        assert_eq!(metrics["modelId"], "fixture-model");
        assert_eq!(metrics["contextTokens"], 3);
        assert_eq!(metrics["contextLastKnown"], false);
        let (basis, _) = fixture.session(&first).await.context_usage(&first).await.unwrap();
        let maka_event_log::context::LatestMainContext::Selected(basis) = basis else { panic!("missing accepted main request") };
        let seconds = basis.finished_at.unwrap().duration_since(basis.requested_at.unwrap()).unwrap().as_secs_f64();
        assert_eq!(metrics["outputTokensPerSecond"].as_f64().unwrap(), 2.0 / seconds);
        assert!(completed["run"].is_null());
        assert_eq!(completed["session"]["activity"], "idle");
        assert_eq!(completed["parts"], json!([]));
        assert!(completed["through"].as_u64().unwrap() >= active["through"].as_u64().unwrap());
        let observation = fixture.session(&first).await.session_projection::<Value>(&first).await.unwrap().unwrap();
        let events = fixture.session(&first).await.session_stream_events(&first,0,observation.through_sequence,32,64*1024).await.unwrap();
        assert!(events.events.iter().any(|event| matches!(&event.fact,maka_event_log::observation::StreamFact::StepEnded { completed: true, .. })));
        let history = fixture.query("history", json!({"sessionId":first,"through":observation.through_sequence,"position":{"kind":"start"}})).await.unwrap();
        let response: String = history["chunks"].as_array().unwrap().iter()
            .filter(|chunk| chunk["role"] == "assistant")
            .map(|chunk| chunk["text"].as_str().unwrap()).collect();
        assert_eq!(response, "Elegant response");
        let prefix = fixture.prefix(&first, 128, 1024*1024).await;
        let model_request = prefix.events.iter().find(|row| row.event.invocation.session_id == first && matches!(row.event.fact, maka_agent_facts::event::Fact::ModelRequested { .. })).unwrap();
        let composition = fixture.session(&first).await.request_composition(&first, &model_request.event.id).await.unwrap().unwrap();
        let adapter = composition.sources.iter().find(|source| source.kind == SourceKind::ModelAdapter).unwrap();
        let mut expected = fixture.owner.revision.clone();
        expected.kind = SourceKind::ModelAdapter;
        expected.name = "chat-completions".into();
        assert_eq!(adapter, &expected, "model evidence retains the actual Agent activation");
        assert!(fixture.app.shutdown_if_idle().await.unwrap()); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn original_operation_conflicts_and_private_namespace_never_cross_sessions() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let operation = Uuid::new_v4();
        let first = fixture
            .mutation(2, "create", fixture.create_input("A").await, operation)
            .await
            .unwrap();
        let conflict = fixture
            .mutation(3, "create", fixture.create_input("B").await, operation)
            .await
            .unwrap_err();
        assert!(conflict.contains("event identity conflicts"));
        let second = fixture
            .mutation(3, "create", fixture.create_input("B").await, Uuid::new_v4())
            .await
            .unwrap();
        assert_ne!(first["session"]["id"], second["session"]["id"]);
        fixture
            .store
            .create_session("foreign_session", "foreign", &json!({"foreign":true}), 1)
            .await
            .unwrap();
        let listed = fixture
            .app
            .client()
            .start(
                fixture.binding(2).await,
                "list".into(),
                json!({"filter":"all","position":{"kind":"start"}}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 2);
        assert!(!listed.to_string().contains("foreign_session"));
        assert!(
            fixture
                .send("foreign_session")
                .await
                .unwrap_err()
                .contains("agent_session_unavailable")
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn exact_stop_cannot_cancel_a_successor_and_close_waits_for_original_workers() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let worker_entered = entered.clone();
        let worker_release = release.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                worker_entered.add_permits(1);
                worker_release.acquire().await.unwrap().forget();
                response(&mut socket).await;
            }
        });
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Conversation").await;
        let first = fixture.send(&session).await.unwrap();
        entered.acquire().await.unwrap().forget();
        release.add_permits(1);
        fixture.drained().await;
        let second = fixture.send(&session).await.unwrap();
        entered.acquire().await.unwrap().forget();
        let stale = fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":first["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["requested"], false);
        let runs = fixture.owner.runs.lock().await;
        let control = runs.controls.get(&session).unwrap();
        assert_eq!(
            control.invocation.invocation_id,
            second["invocationId"].as_str().unwrap()
        );
        assert!(!control.cancellation.is_cancelled());
        drop(runs);
        release.add_permits(1);
        server.await.unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[derive(Clone)]
struct Fault {
    panic: bool,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    database: Arc<StdMutex<Option<std::path::PathBuf>>>,
}
impl maka_agent_ports::model::ProviderAdapter for Fault {
    fn open(
        &self,
        _: maka_agent_ports::model::Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn maka_agent_ports::model::Session>, maka_model::ModelError>>
    {
        let session = self.clone();
        Box::pin(async { Ok(Arc::new(session) as Arc<dyn maka_agent_ports::model::Session>) })
    }
}
impl maka_agent_ports::model::Session for Fault {
    fn stream(
        &self,
        _: maka_agent_ports::model::Request,
        _: maka_agent_ports::model::Context,
    ) -> BoxFuture<'static, Result<(), maka_model::ModelError>> {
        let fault = self.clone();
        Box::pin(async move {
            fault.entered.add_permits(1);
            fault.release.acquire().await.unwrap().forget();
            // Fail persistence after durable start without closing Root authority
            // while this original worker still owns physical execution custody.
            let path = fault.database.lock().unwrap().as_ref().unwrap().clone();
            let database = rusqlite::Connection::open(path).unwrap();
            database.execute_batch("CREATE TRIGGER reject_worker_events BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'fixture worker SQL failure'); END;").unwrap();
            if !fault.panic {
                // Keep the table in main so SQLite cannot fall back to the
                // attached control schema; fail the next queue read itself.
                database
                    .execute_batch(
                        "ALTER TABLE message_admissions RENAME COLUMN record_json TO unavailable_record_json;",
                    )
                    .unwrap();
            }
            drop(database);
            assert!(!fault.panic, "controlled original model worker panic");
            Err(maka_model::ModelError::Adapter(
                "ordinary model failure".into(),
            ))
        })
    }
}
fn controlled_model(panic: bool) -> (ModelExecutor, Fault) {
    let fault = Fault {
        panic,
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
        database: Arc::new(StdMutex::new(None)),
    };
    let binding = maka_agent_ports::model::Binding::new(
        Arc::new(fault.clone()),
        maka_agent_facts::composition::SourceRevision {
            kind: maka_agent_facts::composition::SourceKind::ModelAdapter,
            name: "chat-completions".into(),
            package_id: "fixture.adapter".into(),
            entry_id: "fixture.adapter".into(),
            activation: "fixture.activation".into(),
            revision: "1".into(),
        },
    );
    (
        ModelExecutor::new(Duration::from_secs(30))
            .unwrap()
            .with_adapters(BTreeMap::from([("chat-completions".into(), binding)])),
        fault,
    )
}

async fn cleanup_case(panic: bool) {
    let (mut capture, _log_guard) = log_capture();
    let (model, fault) = controlled_model(panic);
    let fixture = Fixture::new("http://127.0.0.1:1/v1", Some(model)).await;

    let session = fixture.create("Physical lifetime").await;
    let physical_session = fixture.session(&session).await;

    *fault.database.lock().unwrap() = Some(fixture.session_database(&session));
    fixture.send(&session).await.unwrap();

    let invocation = fixture
        .owner
        .runs
        .lock()
        .await
        .controls
        .get(&session)
        .unwrap()
        .invocation
        .clone();
    let activation = fixture.owner.revision.activation.clone();
    fault.entered.acquire().await.unwrap().forget();

    let selection = fixture.selection().await;
    let reference = if panic {
        assert_eq!(fixture.send(&session).await.unwrap()["kind"], "queued");
        let prepared = fixture
            .app
            .client()
            .prepare_mutation(
                fixture.binding(2).await,
                "send".into(),
                json!({"sessionId":session,"message":"after failed cleanup","model":selection}),
                scope(&fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        Some(prepared.reference().clone())
    } else {
        None
    };

    fault.release.add_permits(1);
    fixture.drained().await;

    if let Some(reference) = reference {
        // Test the original admission gate after terminal persistence failed.
        assert!(
            fixture
                .owner
                .send(
                    Send {
                        session_id: session.clone(),
                        message: "after failed cleanup".into(),
                        model: selection,
                        thinking_level: None,
                        attachments: vec![]
                    },
                    &reference,
                    &scope(&fixture.issuer, true)
                )
                .await
                .err()
                .unwrap()
                .contains("agent_cleanup_unconfirmed")
        );
        let raw = rusqlite::Connection::open_with_flags(
            fixture.session_database(&session),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let pending: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM message_admissions WHERE session_id = ?1",
                [&session],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
    }
    assert_eq!(
        fixture.owner.runs.lock().await.quarantined.len(),
        usize::from(panic)
    );
    assert_eq!(
        fixture.owner.runs.lock().await.closing,
        !panic,
        "completion uncertainty quarantines only the session; advancing after SQL failure closes the owner"
    );
    assert_eq!(fixture.owner.stop.is_cancelled(), !panic);

    if panic {
        assert!(matches!(
            physical_session.execution_scope(None).await,
            Err(maka_event_log::StoreError::ConnectionClosed)
        ));
    }
    drop(physical_session);
    let close = fixture.app.shutdown().await;

    assert_eq!(close.is_err(), panic);
    fixture.config.shutdown().await.unwrap();
    if !panic {
        // Confirmed physical cleanup permits Root shutdown to acknowledge all
        // partition owners before testing that the original lock is reusable.
        fixture.store.shutdown().await.unwrap();
    }
    fault.database.lock().unwrap().take();
    let Fixture {
        services,
        _dir,
        namespaces,
        root,
        workspace: _,
        store,
        config,
        app,
        issuer,
        owner,
    } = fixture;
    drop(services);
    drop(owner);
    drop(issuer);
    drop(app);
    drop(config);
    drop(store);
    drop(fault);
    if panic {
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
    } else {
        drop(RootOwner::open(&root, &namespaces).unwrap());
    }
    let log = log_text(&mut capture);
    let (stage, cause, consequence) = if panic {
        (
            "queue_cleanup_unconfirmed",
            "cleanup_unconfirmed",
            "session_quarantined",
        )
    } else {
        ("queue_advance_failed", "store_sqlx", "owner_closing")
    };
    let event = log
        .lines()
        .find(|line| line.contains(&format!("stage=\"{stage}\"")))
        .expect("actual fatal queue custody outcome must be logged");
    assert!(event.contains("ERROR"));
    assert!(event.contains(&format!("cause=\"{cause}\"")));
    assert!(event.contains(&format!("consequence=\"{consequence}\"")));
    for identity in [
        &invocation.session_id,
        &invocation.turn_id,
        &invocation.run_id,
        &invocation.invocation_id,
        &activation,
    ] {
        assert!(
            event.contains(identity),
            "fatal event must retain original invocation/activation: {event}"
        );
    }
    for secret in [
        "controlled original model worker panic",
        "ordinary model failure",
        "private-fixture-key",
        "after failed cleanup",
        "Hello",
    ] {
        assert!(
            !log.contains(secret),
            "fatal evidence must exclude panic/error payloads, credentials and submitted text"
        );
    }
}
#[tokio::test]
async fn model_panic_and_terminal_sql_failure_quarantine_execution_and_keep_root() {
    tokio::time::timeout(Duration::from_secs(20), cleanup_case(true))
        .await
        .unwrap();
}
#[tokio::test]
async fn ordinary_model_and_terminal_sql_failures_preserve_confirmed_physical_cleanup() {
    tokio::time::timeout(Duration::from_secs(20), cleanup_case(false))
        .await
        .unwrap();
}

fn catalog_interaction(
    session_id: &str,
    request_id: &str,
) -> maka_agent_facts::interaction::InteractionRecord {
    use maka_agent_facts::interaction::GrantCapability;
    use maka_agent_facts::interaction::GrantScope;
    use maka_agent_facts::interaction::GrantTarget;
    use maka_agent_facts::interaction::InteractionRecord;
    use maka_agent_facts::interaction::InteractionRequest;
    InteractionRecord {
        session_id: session_id.into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        request_id: request_id.into(),
        created_at: 10,
        outcome: None,
        request: InteractionRequest::ClientCapability {
            basis: None,
            tool_use_id: "tool".into(),
            target: GrantTarget {
                provider_id: "provider".into(),
                contract_id: "contract".into(),
                server_id: "browser".into(),
                tool_name: "navigate".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                },
            },
        },
    }
}

fn provide_all(registry: &mut NativeRegistry) -> Result<(), String> {
    provide_without_workhub(registry)?;
    crate::workhub::provide(registry, bundled_catalog())?;
    Ok(())
}
fn provide_without_workhub(registry: &mut NativeRegistry) -> Result<(), String> {
    crate::provide(registry, bundled_catalog())?;
    maka_acp_native::provide(registry)?;
    maka_files_native::provide(registry)?;
    maka_processes_native::provide(registry)?;
    maka_skills_native::provide(registry)?;
    maka_interactions_native::questions::provide(registry)?;
    maka_interactions_native::forms::provide(registry)?;
    maka_web::provide(registry)?;
    maka_jev_native::provide(registry)?;
    Ok(())
}
