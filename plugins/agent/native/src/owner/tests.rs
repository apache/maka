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

#[path = "tests/http.rs"]
mod http_fixture;

#[path = "tests/plan.rs"]
mod plan_tests;

#[path = "tests/goal.rs"]
mod goal_tests;

#[path = "tests/recap.rs"]
mod recap_tests;

#[path = "tests/title.rs"]
mod title_tests;

#[path = "tests/todo.rs"]
mod todo_tests;

#[path = "tests/computer.rs"]
mod computer;
#[path = "tests/computer_controls.rs"]
mod computer_controls;

#[path = "tests/request_capture.rs"]
mod request_capture;
#[path = "tests/service_tools.rs"]
mod service_tools;
#[path = "tests/skill_preparation.rs"]
mod skill_preparation;
#[path = "tests/skills.rs"]
mod skills;

#[path = "tests/attachments.rs"]
mod attachments;

#[path = "tests/fork.rs"]
mod fork;

#[path = "tests/files.rs"]
mod files;

#[path = "tests/file_browsing.rs"]
mod file_browsing;
#[path = "tests/file_reconciliation.rs"]
mod file_reconciliation;

#[path = "tests/health.rs"]
mod health;
#[path = "tests/processes.rs"]
mod processes;

#[path = "tests/protocol_processes.rs"]
mod protocol_processes;

#[path = "tests/terminal.rs"]
mod terminal;

#[path = "tests/interactions.rs"]
mod interactions;

#[path = "tests/catalog.rs"]
mod catalog;

#[path = "tests/session_availability.rs"]
mod session_availability;

#[path = "tests/history_search.rs"]
mod history_search;

#[path = "tests/compaction.rs"]
mod compaction;

#[path = "tests/metrics.rs"]
mod metrics;

#[path = "tests/execution.rs"]
mod execution;
#[path = "tests/executor.rs"]
mod executor;

#[path = "tests/prompt_language.rs"]
mod prompt_language;
#[path = "tests/session_context.rs"]
mod session_context;
#[path = "tests/tool_schemas.rs"]
mod tool_schemas;
#[path = "tests/workhub.rs"]
mod workhub;

#[path = "tests/scale.rs"]
#[cfg(unix)]
mod scale;

#[path = "tests/queue.rs"]
mod queue;

#[path = "tests/large_messages.rs"]
mod large_messages;

#[path = "tests/mcp.rs"]
mod mcp;
#[path = "tests/selection.rs"]
mod selection;

#[path = "tests/git.rs"]
mod git;
#[path = "tests/jev.rs"]
mod jev_tests;
#[path = "tests/web.rs"]
mod web_tests;

#[path = "tests/worktrees.rs"]
mod worktrees;

#[path = "tests/settings.rs"]
mod settings;

#[path = "tests/images.rs"]
mod images;

#[path = "tests/imports.rs"]
mod imports;
#[path = "tests/projects.rs"]
mod projects;
#[path = "tests/recall.rs"]
mod recall_tests;
#[path = "tests/scheduler.rs"]
mod scheduler_tests;

#[path = "tests/workspaces.rs"]
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
fn package(provider: bool) -> Package {
    let entry = EntryDeclaration {
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
            BTreeMap::from([(
                EXPORT.into(),
                Import {
                    contract: contract(),
                    cardinality: Cardinality::One,
                },
            )])
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
    };
    let declaration = Declaration {
        host: Some(entry),
        ui: None,
        composition: None,
    };
    let mut files = BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({"schemaVersion":1,"id":if provider {"agent"} else {"consumer"},"application":declaration})).unwrap())]);
    if !provider {
        files.insert(
            "host.mjs".into(),
            b"export function activate() { return {}; }".to_vec(),
        );
    }
    Package::new(files).unwrap()
}
fn input(settings: &Configuration) -> (Input, Vec<Package>) {
    let provider = package(true);
    let consumer = package(false);
    let node = |key: u128, provider_node: bool| Node {
        key: Uuid::from_u128(key),
        package: if provider_node {
            provider.application_ref()
        } else {
            consumer.application_ref()
        }
        .into(),
        use_package: PackageUse::Host,
        configuration: if provider_node {
            NodeConfiguration {
                values: serde_json::to_value(settings)
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
                parameters: BTreeMap::new(),
            }
        } else {
            NodeConfiguration::default()
        },
        parameters: NodeConfiguration::default(),
        disabled: false,
        overrides: vec![],
        bindings: if provider_node {
            BTreeMap::new()
        } else {
            BTreeMap::from([(
                EXPORT.into(),
                vec![Target::Instance {
                    path: vec!["provider".into()],
                    export: EXPORT.into(),
                }],
            )])
        },
    };
    let receipt_contract = maka_plugin_core::operation::receipt_reader_contract();
    let receipts = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"receipts","application":{"host":{
                "implementation":{"kind":"native","implementation":"maka.operations.receipts"},
                "configuration":{"type":"object","additionalProperties":false},"imports":{},
                "exports":{"Receipts":{"contract":receipt_contract,"availability":"required"}}
            }}
        }))
        .unwrap(),
    )]))
    .unwrap();
    let receipt_node = Node {
        key: Uuid::from_u128(4),
        package: receipts.application_ref().into(),
        use_package: PackageUse::Host,
        configuration: Default::default(),
        parameters: Default::default(),
        bindings: BTreeMap::new(),
        disabled: false,
        overrides: vec![],
    };
    let mut input = Input {
        ui: None,
        instances: BTreeMap::from([
            ("provider".into(), node(1, true)),
            ("a".into(), node(2, false)),
            ("b".into(), node(3, false)),
        ]),
    };
    input.instances.insert("receipts".into(), receipt_node);
    for name in ["a", "b"] {
        input.instances.get_mut(name).unwrap().bindings.insert(
            "receipts".into(),
            vec![Target::Instance {
                path: vec!["receipts".into()],
                export: "Receipts".into(),
            }],
        );
    }
    // Both consumers declare recovery independently of their execution import.
    let mut files = consumer.files().clone();
    let mut manifest = consumer.manifest().clone();
    let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
    manifest_application.host.as_mut().unwrap().imports.insert(
        "receipts".into(),
        Import {
            contract: receipt_contract,
            cardinality: Cardinality::One,
        },
    );
    files.insert(MANIFEST_FILE.into(), {
        manifest.application =
            Some(maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap());
        serde_json::to_vec(&manifest).unwrap()
    });
    let consumer = Package::new(files).unwrap();
    for name in ["a", "b"] {
        input.instances.get_mut(name).unwrap().package = consumer.application_ref().into();
    }
    let settings = {
        let mut manifest = provider.manifest().clone();
        let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
        manifest.id = "settings".into();
        let entry = manifest_application.host.as_mut().unwrap();
        entry.implementation = Implementation::Native {
            implementation: maka_settings_native::IMPLEMENTATION.into(),
        };
        entry.configuration =
            json!({"type":"object","properties":{},"additionalProperties":false}).into();
        entry.exports = BTreeMap::from([(
            maka_settings_native::EXPORT.into(),
            Export {
                contract: maka_settings_native::contract::contract(),
                availability: Availability::Required,
            },
        )]);
        Package::new(BTreeMap::from([(MANIFEST_FILE.into(), {
            manifest.application = Some(
                maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap(),
            );
            serde_json::to_vec(&manifest).unwrap()
        })]))
        .unwrap()
    };
    let mut files = consumer.files().clone();
    let mut manifest = consumer.manifest().clone();
    let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
    manifest_application.host.as_mut().unwrap().imports.insert(
        "settings".into(),
        Import {
            contract: maka_settings_native::contract::contract(),
            cardinality: Cardinality::One,
        },
    );
    files.insert(MANIFEST_FILE.into(), {
        manifest.application =
            Some(maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap());
        serde_json::to_vec(&manifest).unwrap()
    });
    let consumer = Package::new(files).unwrap();
    input.instances.insert(
        "settings".into(),
        Node {
            key: Uuid::from_u128(5),
            package: settings.application_ref().into(),
            use_package: PackageUse::Host,
            configuration: NodeConfiguration::default(),
            parameters: NodeConfiguration::default(),
            disabled: false,
            overrides: vec![],
            bindings: BTreeMap::new(),
        },
    );
    for name in ["a", "b"] {
        let node = input.instances.get_mut(name).unwrap();
        node.package = consumer.application_ref().into();
        node.bindings.insert(
            "settings".into(),
            vec![Target::Instance {
                path: vec!["settings".into()],
                export: maka_settings_native::EXPORT.into(),
            }],
        );
    }
    (input, vec![provider, consumer, receipts, settings])
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
        Self::with_peer(base, model, None).await
    }
    async fn with_peer(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
    ) -> Self {
        Self::with_services(base, model, peer, None).await
    }
    async fn with_services(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
    ) -> Self {
        Self::configured(base, model, peer, tooling, |_| {}).await
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
        let (mut input, mut packages) = input(&settings);
        if let Some(tooling) = &tooling {
            tooling.install(&mut input, &mut packages);
        }
        let deployment = Uuid::new_v4();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let captured = Arc::new(StdMutex::new(None));
        let capture = captured.clone();
        let replacement = Arc::new(StdMutex::new(model));
        let mut native = NativeRegistry::default();
        let catalog = bundled_catalog();
        maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
        if let Some(tooling) = &tooling {
            tooling.provide(&mut native);
        }
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
                        let mut owner = Owner::open(context, configuration, catalog).await.unwrap();
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
        let (issuer, policy): (Issuer, Arc<dyn Policy>) = match peer {
            Some(peer) => (peer.issuer(), peer),
            None => {
                let native = tooling.as_ref().map(service_tools::Setup::policy);
                let issuer = native
                    .as_ref()
                    .map(|policy| policy.issuer())
                    .unwrap_or_default();
                (issuer.clone(), Arc::new(Grant(issuer, native)))
            }
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
        while !self.owner.workers.is_empty() {
            tokio::task::yield_now().await;
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
async fn canonical_history_is_bounded_utf8_and_keeps_its_original_fence() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let reply = "中文👩🏽‍💻\u{1}".repeat(700);
        let response_text = reply.clone();
        let server = tokio::spawn(async move {
            for turn in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                let text = if turn == 0 { &response_text } else { "Later response" };
                let delta = json!({"id":"history","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
                let body = format!("data: {delta}\n\ndata: {{\"id\":\"history\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("History").await;
        let message = format!("{}中文", "\u{0}".repeat(9000));
        fixture.mutation(2, "send", json!({"sessionId":session,"message":message,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        let mut input = json!({"sessionId":session,"position":{"kind":"start"}});
        let mut user = String::new();
        let mut assistant = String::new();
        let mut fence = None;
        let mut later = false;
        let mut finished = false;
        for _ in 0..128 {
            let page = fixture.query("history", input.clone()).await.unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
            assert!(!page.to_string().contains("private-fixture-key"));
            let through = page["through"].as_u64().unwrap();
            assert_eq!(*fence.get_or_insert(through), through);
            input["through"] = json!(through);
            assert_eq!(page["kind"], "ready");
            let chunks = page["chunks"].as_array().unwrap();
            assert!(chunks.len() <= 2);
            assert!(chunks.iter().map(|chunk| chunk["text"].as_str().unwrap().len()).sum::<usize>() <= 32 * 1024);
            for chunk in chunks {
                let text = chunk["text"].as_str().unwrap();
                assert!(text.len() <= 32 * 1024);
                match chunk["role"].as_str().unwrap() {
                    "user" => user.push_str(text),
                    "assistant" => assistant.push_str(text),
                    role => panic!("unexpected conversation role {role}"),
                }
                assert!(chunk.get("attachments").is_none());
            }
            if !later {
                fixture.send(&session).await.unwrap();
                fixture.drained().await;
                later = true;
            }
            if page["after"].is_null() { finished = true; break; }
            input["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        assert!(finished);
        assert_eq!(user, message);
        assert_eq!(assistant, reply);
        let event_fence = fence.unwrap();
        let mut input = json!({"sessionId":session,"position":{"kind":"event","sequence":event_fence + 1}});
        let mut newer_fence = None;
        let mut newer_user = String::new();
        let mut newer_assistant = String::new();
        let mut finished = false;
        for _ in 0..128 {
            let page = fixture.query("history", input.clone()).await.unwrap();
            let through = page["through"].as_u64().unwrap();
            assert_eq!(*newer_fence.get_or_insert(through), through);
            input["through"] = json!(through);
            assert_eq!(page["kind"], "ready");
            for chunk in page["chunks"].as_array().unwrap() {
                assert!(chunk["position"]["sourceSequence"].as_u64().unwrap() > event_fence);
                match chunk["role"].as_str().unwrap() {
                    "user" => newer_user.push_str(chunk["text"].as_str().unwrap()),
                    "assistant" => newer_assistant.push_str(chunk["text"].as_str().unwrap()),
                    role => panic!("unexpected conversation role {role}"),
                }
            }
            if page["after"].is_null() { finished = true; break; }
            input["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        assert!(finished);
        assert_eq!(newer_user, "Hello");
        assert_eq!(newer_assistant, "Later response");
        let search = |through| json!({"sessionId":session,"through":through,"after":null,"query":"Later response","caseSensitive":true,"wholeWord":false,"includeInternal":false});
        let original_search = fixture.query("search", search(event_fence)).await.unwrap();
        assert_eq!(original_search["matches"], json!([]));
        let current_search = fixture.query("search", search(newer_fence.unwrap())).await.unwrap();
        assert_eq!(current_search["matches"].as_array().unwrap().len(), 1);
        let match_position = current_search["matches"][0]["position"].clone();
        let located = fixture.query("history", json!({"sessionId":session,"through":newer_fence.unwrap(),"position":{"kind":"row","position":match_position,"field":"body"}})).await.unwrap();
        assert_eq!(located["chunks"][0]["text"], "Later response");
        let tail = fixture.query("history", json!({"sessionId":session,"through":event_fence,"position":{"kind":"tail"}})).await.unwrap();
        let cursor = tail["before"].clone();
        assert!(cursor.is_object());
        for kind in ["before", "after"] {
            assert!(fixture.query("history", json!({"sessionId":session,"position":{"kind":kind,"cursor":cursor}})).await.is_err(), "cursor navigation must carry its captured fence");
        }
        let mut reverse_input = json!({"sessionId":session,"through":event_fence,"position":{"kind":"tail"}});
        let (mut reverse_user, mut reverse_assistant) = (String::new(), String::new());
        let mut reverse_done = false;
        for _ in 0..128 {
            let page = fixture.query("history", reverse_input.clone()).await.unwrap();
            assert_eq!(page["through"], event_fence);
            assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
            assert_eq!(page["kind"], "ready");
            for chunk in page["chunks"].as_array().unwrap().iter().rev() {
                let text = chunk["text"].as_str().unwrap();
                match chunk["role"].as_str().unwrap() {
                    "user" => reverse_user.insert_str(0, text),
                    "assistant" => reverse_assistant.insert_str(0, text),
                    role => panic!("unexpected role {role}"),
                }
            }
            if page["before"].is_null() { reverse_done = true; break; }
            reverse_input["position"] = json!({"kind":"before","cursor":page["before"]});
        }
        assert!(reverse_done);
        assert_eq!(reverse_user, message);
        assert_eq!(reverse_assistant, reply);
        // Sampled navigation uses the same canonical rows and immutable fence.
        let empty = fixture.query("historyLandmarks", json!({"sessionId":session,"through":0})).await.unwrap();
        assert_eq!(empty, json!({"through":0,"landmarks":[]}));
        let landmarks = fixture.query("historyLandmarks", json!({"sessionId":session,"through":event_fence})).await.unwrap();
        assert_eq!(landmarks["through"], event_fence);
        assert!(serde_json::to_vec(&landmarks).unwrap().len() <= 64 * 1024);
        let original_landmarks = landmarks["landmarks"].as_array().unwrap();
        assert_eq!(original_landmarks.len(), 1);
        let start = fixture.query("history", json!({"sessionId":session,"through":event_fence,"position":{"kind":"start"}})).await.unwrap();
        assert_eq!(original_landmarks[0]["turnId"], start["chunks"][0]["turnId"]);
        assert_eq!(original_landmarks[0]["position"], start["chunks"][0]["position"]);
        assert_eq!(original_landmarks[0]["label"], "\0".repeat(96));
        let current = fixture.query("historyLandmarks", json!({"sessionId":session,"through":newer_fence.unwrap()})).await.unwrap();
        assert_eq!(current["through"], newer_fence.unwrap());
        assert!(serde_json::to_vec(&current).unwrap().len() <= 64 * 1024);
        let current_landmarks = current["landmarks"].as_array().unwrap();
        assert_eq!(current_landmarks.len(), 2);
        assert_eq!(current_landmarks[0], original_landmarks[0]);
        let raw = fixture.session(&session).await.session_events(&session, 0, newer_fence.unwrap(), 512, 1024 * 1024).await.unwrap();
        assert!(raw.next_after.is_none());
        let endings = raw.events.iter().filter(|stored| matches!(&stored.event.fact, maka_agent_facts::event::Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Completed})).collect::<Vec<_>>();
        assert_eq!(endings.len(), 2);
        // Successful settlement adds a raw turn_state row that conversation
        // pages omit; the returned bound must retain that canonical endpoint.
        for (landmark, ending) in current_landmarks.iter().zip(endings) {
            assert_eq!(landmark["turnId"], ending.event.invocation.turn_id);
            assert_eq!(landmark["lastPosition"], json!({"sourceSequence":ending.sequence,"itemIndex":0}));
        }
        assert_eq!(current_landmarks[1]["label"], "Hello");
        assert_eq!(current_landmarks[1]["turnId"], located["chunks"][0]["turnId"]);
        assert!(current_landmarks[1]["position"]["sourceSequence"].as_u64().unwrap() > event_fence);
        let anchored = fixture.query("history", json!({"sessionId":session,"through":newer_fence.unwrap(),"position":{"kind":"row","position":current_landmarks[1]["position"],"field":"body"}})).await.unwrap();
        assert_eq!(anchored["chunks"][0]["text"], "Hello");
        assert_eq!(anchored["chunks"][0]["turnId"], current_landmarks[1]["turnId"]);
        let future = fixture.through(&session).await + 1;
        assert!(fixture.query("historyLandmarks", json!({"sessionId":session,"through":future})).await.is_err());
        assert!(fixture.query("historyLandmarks", json!({"sessionId":"foreign_session","through":event_fence})).await.is_err());
        assert!(fixture.query("history", json!({"sessionId":session,"position":{"kind":"after","cursor":{"position":{"sourceSequence":0,"itemIndex":0},"offset":0}}})).await.is_err());
        assert!(fixture.query("history", json!({"sessionId":"foreign_session","position":{"kind":"start"}})).await.is_err());
        server.await.unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
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
        assert!(events.events.iter().any(|event| matches!(&event.fact,maka_event_log::observation::StreamFact::PartDelta{text,..} if text=="Elegant response")));
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
        assert!(
            fixture
                .app
                .client()
                .prepare_mutation(
                    fixture.binding(2).await,
                    "send".into(),
                    json!({"sessionId":first["id"],"message":"Unauthorized","model":fixture.selection().await}),
                    scope(&fixture.issuer, false),
                    Uuid::new_v4(),
                    Attachments::new().into(),
                )
                .await
                .is_err()
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

#[tokio::test]
async fn public_availability_resumes_stable_sessions_and_separates_deployments() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = fixture.create("Stable conversation").await;
        let deployment = fixture.app.source().unwrap().deployment;
        fixture.app.shutdown().await.unwrap();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        crate::owner::tests::provide_all(&mut native).unwrap();
        let resumed = Application::start_from_store(
            fixture.store.clone(),
            deployment,
            native,
            fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        resumed.ready().await.unwrap();
        let client = resumed.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), EXPORT.into())
            .await
            .unwrap()
            .remove(0);
        let listed = client
            .start(
                binding.clone(),
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
        assert_eq!(listed["sessions"][0]["id"], session);
        let other_deployment = Uuid::new_v4();
        let (input, packages) = input(&fixture.owner.settings);
        fixture
            .store
            .commit_application(other_deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        crate::owner::tests::provide_all(&mut native).unwrap();
        let other = Application::start_from_store(
            fixture.store.clone(),
            other_deployment,
            native,
            fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        other.ready().await.unwrap();
        let client = other.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), EXPORT.into())
            .await
            .unwrap()
            .remove(0);
        let listed = client
            .start(
                binding.clone(),
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
        assert!(listed["sessions"].as_array().unwrap().is_empty());
        let mut foreign = client
            .subscribe(
                binding,
                "watch".into(),
                json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert!(foreign.recv().await.is_none());
        assert!(
            foreign
                .completion()
                .await
                .result
                .unwrap_err()
                .contains("agent_session_unavailable")
        );
        other.shutdown().await.unwrap();
        resumed.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn disabled_connection() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = fixture.create("Bound model").await;
    let catalog = fixture.config.catalog().await.unwrap();
    let row = &catalog.connections[0];
    let expected: ConnectionVersionBasis =
        serde_json::from_value(json!({"connectionId":row.connection_id,"revision":row.revision}))
            .unwrap();
    let updated = fixture
        .config
        .update_connection(UpdateCatalogConnectionInput {
            expected,
            changes: ConnectionCatalogEntryUpdate {
                name: Some(row.name.clone()),
                configuration: Some(row.configuration.clone()),
                enabled: Some(false),
                enabled_model_ids: Some(row.enabled_model_ids.clone()),
                model_overrides: Patch::Keep,
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(updated, CatalogMutationResult::Committed { .. }));
    let revision = fixture.config.catalog().await.unwrap().revision;
    let alternative = serde_json::from_value(json!({"expectedCatalogRevision":revision,"connection":{"slug":"available","name":"Available","provider":row.provider,"configuration":row.configuration,"enabled":true,"enabledModelIds":["fixture-model"]}})).unwrap();
    assert!(matches!(
        fixture.config.create_connection(alternative).await.unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
    let alternative_row = fixture
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.slug == "available")
        .unwrap();
    let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = fixture
        .config
        .prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
            expected_credential: None,
            attempt_id: Uuid::new_v4().to_string(),
            target: maka_agent_facts::oauth::Target::Existing {
                expected: ConnectionCredentialTarget {
                    connection_id: alternative_row.connection_id.clone(),
                    revision: alternative_row.revision,
                    slug: alternative_row.slug,
                    provider: alternative_row.provider,
                    configuration: alternative_row.configuration.clone(),
                },
                configuration: alternative_row.configuration,
            },
            authentication: maka_agent_facts::provider::AuthenticationInput {
                method: "api-key".into(),
                input: json!({"apiKey":"private-alternative-key"}),
            },
        })
        .await
        .unwrap()
    else {
        panic!("alternative login preparation");
    };
    assert!(ticket.claim().await.unwrap());
    assert!(matches!(
        ticket
            .complete(
                maka_agent_facts::provider::Credential {
                    secret: "private-alternative-key".into(),
                    refresh_at: None
                },
                2
            )
            .await
            .unwrap(),
        maka_config::oauth::enrollment::LoginCompletion::Committed(_)
    ));
    let result = fixture
        .config
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: fixture.config.catalog().await.unwrap().revision,
            target: Some(ConnectionTarget {
                connection_id: alternative_row.connection_id,
                model_id: "fixture-model".into(),
            }),
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    let error = fixture.send(&session).await.unwrap_err();
    assert!(error.contains("agent_execution_unavailable"));
    assert!(!error.contains("private-fixture-key") && !error.contains("private-alternative-key"));
    let observation = fixture
        .session(&session)
        .await
        .session_projection::<Value>(&session)
        .await
        .unwrap()
        .unwrap();
    assert!(observation.root_turn.is_none());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}
#[tokio::test]
async fn disabled_selected_connection_does_not_use_an_authenticated_default_or_open_a_run() {
    tokio::time::timeout(Duration::from_secs(20), disabled_connection())
        .await
        .unwrap();
}

#[tokio::test]
async fn tool_source_uses_original_agent_grant_and_frozen_canonical_fields() {
    use maka_agent_facts::import::Content;
    use maka_agent_facts::import::Record;
    use maka_agent_facts::import::Source;
    use maka_capabilities::storage::Namespace;
    use maka_event_log::sessions::PluginSession;
    use maka_plugin_core::scope::Scope as StorageScope;
    let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
    let seed = fixture.create("Tool source").await;
    let configuration = fixture
        .session(&seed)
        .await
        .get::<StoredSessionConfiguration>()
        .await
        .unwrap()
        .unwrap()
        .configuration;
    let session = format!("{}{}", fixture.owner.prefix, Uuid::new_v4().simple());
    let plugin = PluginSession {
        session_id: session.clone(),
        creator: Namespace::new("tool.source.fixture", StorageScope::Profile).unwrap(),
        fingerprint: "tool-source-import".into(),
        managed: false,
        authority_session_id: None,
    };

    let input = json!({"count":42,"flag":false,"text":"中😀\0".repeat(2000)});
    let records = [
        Content::User {
            text: "Inspect tools".into(),
        },
        Content::ToolCall {
            call_id: "call".into(),
            name: "Count".into(),
            input: Some(input.clone()),
        },
        Content::ToolResult {
            call_id: "call".into(),
            output: json!(null),
            is_error: false,
        },
    ]
    .into_iter()
    .enumerate()
    .map(|(i, content)| Record {
        source_message_id: format!("m{i}"),
        source_turn_id: "turn".into(),
        timestamp: Some(1),
        content,
    })
    .collect();
    fixture
        .store
        .import_session(
            &plugin,
            &Source {
                adapter: "fixture".into(),
                session_id: "foreign".into(),
            },
            &configuration,
            records,
            1,
        )
        .await
        .unwrap();

    let fence = fixture.through(&session).await;
    let history = loop {
        let value = fixture
            .query(
                "history",
                json!({"sessionId":session,"through":fence,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        if value["kind"] == "ready" {
            break value;
        }
    };
    let sequence = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|chunk| chunk["role"] == "tool_call")
        .unwrap()["position"]
        .clone();
    let mut position = json!({"kind":"start"});
    let mut complete = String::new();
    loop {
        let page = fixture.query("source", json!({"sessionId":session,"through":fence,"source":{"kind":"row","position":sequence},"field":"arguments","position":position})).await.unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 64 * 1024);
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["through"], fence);
        let source = &page["source"];
        assert_eq!(source["format"], "json");
        assert_eq!(source["tool"]["call"]["name"], "Count");
        let text = source["text"].as_str().unwrap();
        assert!(text.len() <= 8192);
        complete.push_str(text);
        let end = source["offset"].as_u64().unwrap() + text.len() as u64;
        if end == source["totalBytes"].as_u64().unwrap() {
            break;
        }
        position = json!({"kind":"after","offset":end});
    }
    assert_eq!(serde_json::from_str::<Value>(&complete).unwrap(), input);
    let mut literal = String::new();
    let mut offset = 0;
    loop {
        let page = fixture
            .query(
                "source",
                json!({"sessionId":session,"through":fence,
            "source":{"kind":"row","position":sequence},"field":"arguments","path":["text"],
            "position":{"kind":"after","offset":offset}}),
            )
            .await
            .unwrap();
        let source = &page["source"];
        assert_eq!(source["path"], json!(["text"]));
        assert_eq!(source["format"], "text");
        assert_eq!(source["offset"], offset);
        literal.push_str(source["text"].as_str().unwrap());
        offset = literal.len();
        if offset as u64 == source["totalBytes"].as_u64().unwrap() {
            break;
        }
    }
    assert_eq!(literal, input["text"].as_str().unwrap());
    let request = json!({"sessionId":session,"through":fence,"source":{"kind":"row","position":sequence},"field":"arguments","path":["text"],"position":{"kind":"start"}});
    for (key, value) in [
        ("sessionId", json!("foreign_session")),
        ("through", json!(fence + 1)),
        ("through", json!(0)),
        ("field", json!("result")),
    ] {
        let mut invalid = request.clone();
        invalid[key] = value;
        assert!(fixture.query("source", invalid).await.is_err());
    }
    let denied = fixture
        .app
        .client()
        .start(
            fixture.binding(2).await,
            "source".into(),
            request,
            scope(&fixture.issuer, false),
            Attachments::new().into(),
        )
        .await;
    assert!(denied.is_err());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
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
