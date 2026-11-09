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
mod memory_release;

mod goal_tests;

mod recap_tests;

mod title_tests;

mod todo_tests;

mod bot_tests;

mod computer_controls;
mod computer_native_fence;

mod service_tools;
mod session_approval_settlement;
mod session_parent_authority;
mod session_tools;
mod skill_preparation;
mod skills;

mod attachments;

#[cfg(unix)]
mod checkpoints;

mod fork;

mod files;

mod file_browsing;

mod health;
mod processes;
#[cfg(windows)]
mod windows_shell;

mod protocol_processes;

mod terminal;

mod interactions;
mod system_permission;

mod catalog;

mod session_availability;

mod compaction;

mod metrics;

mod codex_compaction;
mod execution;
mod executor;
pub(in crate::owner) mod model_interruption;

mod prompt_language;
mod session_context;

mod queue;

mod mcp;
mod selection;

mod decisions_api_tests;
mod git;
mod web_tests;

mod worktrees;

mod settings;

mod images;

mod history;
mod imports;
mod projects;
mod recall_tests;
mod scheduler_tests;

mod workspaces;

use super::*;
use crate::{EXPORT, ModelSelection, contract, service::Agent};
use maka_agent_facts::configuration::*;
use maka_agent_facts::durable::{
    ExecutionIdentity, Fact, FactId, RecordedFact, RequestSpec, RunId, Terminal,
};
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::Scope;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::{
    Application, Binding, Invocation as HostInvocation, NativeActivation, NativeRegistry, Policy,
};
use maka_model::ModelExecutor;
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::{
    composition::{
        Configuration as NodeConfiguration, Input, InstanceId, Node, PackageUse, Target,
    },
    contract::{Availability, Cardinality, Export, Import},
    operation::{OperationCleanup, OperationOutcome, Receipt},
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
    fn lookup_intent(
        &self,
        invocation: maka_host_runtime::application::IntentLookupInvocation<'_>,
    ) -> Result<(), String> {
        if let Some(native) = &self.1 {
            return native.lookup_intent(invocation);
        }
        if invocation
            .native_origin
            .is_some_and(|origin| origin == invocation.consumer && origin.instance() == &id(1))
        {
            Ok(())
        } else {
            Err("caller intent lookup denied for this Agent actor".into())
        }
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
    let needs_settings = settings.tools.iter().any(|tool| {
        matches!(&tool.target, maka_host_runtime::application::ServiceTarget::Import { name } if name == "settings")
    });
    let mut provider = entry(true);
    if needs_settings {
        provider.imports.insert(
            "settings".into(),
            Import {
                contract: maka_settings_native::contract::contract(),
                cardinality: Cardinality::One,
            },
        );
    }
    let (mut input, packages) = application_input(
        settings,
        application_package("agent", provider),
        package(false),
    );
    if needs_settings {
        input
            .instances
            .get_mut("provider")
            .unwrap()
            .bindings
            .insert(
                "settings".into(),
                vec![Target::Instance {
                    path: vec!["settings".into()],
                    export: maka_settings_native::EXPORT.into(),
                }],
            );
    }
    (input, packages)
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
        base: None,
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

pub(crate) struct Fixture {
    pub(crate) services: maka_host_runtime::application::NativeServices,
    _dir: tempfile::TempDir,
    namespaces: RootNamespaces,
    root: std::path::PathBuf,
    workspace: std::path::PathBuf,
    pub(crate) store: Arc<RootStore>,
    pub(crate) config: Arc<ConfigurationStore>,
    pub(crate) app: Application,
    pub(crate) issuer: Issuer,
    pub(crate) owner: Arc<Owner>,
}
fn model_backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}

impl Fixture {
    pub(crate) async fn session(&self, id: &str) -> maka_event_log::root_store::SessionStore {
        self.store
            .session(id)
            .await
            .expect("fixture Session exists")
    }

    fn runtime_databases(&self) -> Vec<std::path::PathBuf> {
        vec![self.root.join(maka_event_log::root::ROOT_DATABASE)]
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

    fn session_database(&self, _id: &str) -> std::path::PathBuf {
        self.root.join(maka_event_log::root::ROOT_DATABASE)
    }

    pub(crate) fn artifact_count(&self, session: &str) -> u64 {
        let connection = rusqlite::Connection::open_with_flags(
            self.root.join(maka_event_log::root::ROOT_DATABASE),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection.query_row("SELECT count(*) FROM agent_session_artifact_registrations WHERE owner=? AND session=?", rusqlite::params![serde_json::to_string(&self.owner.run_owner()).unwrap(), session], |row| row.get::<_, i64>(0)).unwrap().try_into().unwrap()
    }

    pub(crate) fn history(&self, id: &str) -> maka_agent_state::session_history::SessionHistory {
        self.owner
            .durable
            .session_history(self.owner.run_owner(), id.to_owned())
    }

    pub(crate) async fn history_items(
        &self,
        id: &str,
    ) -> Vec<maka_agent_state::session_history::HistoryItem> {
        let history = self.history(id);
        let cut = history.capture().await.unwrap();
        let mut after = 0;
        let mut items = Vec::new();
        loop {
            let page = history.page(&cut, after, 256).await.unwrap();
            items.extend(page.items);
            match page.next {
                Some(next) => after = next,
                None => return items,
            }
        }
    }

    pub(crate) async fn recorded_facts(&self, id: &str) -> Vec<RecordedFact> {
        self.history_items(id)
            .await
            .into_iter()
            .map(|item| item.recorded)
            .collect()
    }

    pub(crate) async fn through(&self, id: &str) -> u64 {
        self.history(id).capture().await.unwrap().through_sequence
    }

    pub(crate) async fn latest_run(
        &self,
        id: &str,
    ) -> maka_agent_state::session_history::RunSource {
        let history = self.history(id);
        let cut = history.capture().await.unwrap();
        history
            .latest(&cut)
            .await
            .unwrap()
            .expect("actual admitted Run")
    }

    pub(crate) async fn seed_due_model_retry(
        &self,
        session: &str,
        source: RunId,
    ) -> (RunId, FactId) {
        use maka_agent_facts::durable::{
            AttemptRecovery, Fact, ModelAttemptId, StepId, Trigger, UnixMillis,
        };
        use maka_agent_state::{Admission, Change, ContentBlob};
        let state = &self.owner.durable;
        let original = state.frontier(source).await.unwrap();
        assert_eq!(original.spec.session_id, session);
        assert_eq!(original.spec.owner, self.owner.run_owner());
        assert!(original.terminal.is_some());
        let mut request = state
            .request(source, original.current_step.unwrap())
            .await
            .unwrap();
        let upstream = self
            .recorded_facts(session)
            .await
            .into_iter()
            .find_map(|recorded| {
                if recorded.run != source {
                    return None;
                }
                match recorded.fact {
                    Fact::ModelAttemptAdmitted { upstream, .. } => Some(upstream),
                    _ => None,
                }
            })
            .expect("actual warm model admission metadata");
        let step = StepId::new();
        request.step = step;
        let mut spec = original.spec.clone();
        spec.trigger = Trigger::Continuation { source };
        assert!(
            spec.budget.retries > 0,
            "original current fixture policy permits the retry"
        );
        let at = UnixMillis(now().try_into().unwrap());
        let admission = Admission::new(spec, at, vec![]);
        let run = admission.run();
        state.admit(admission).await.unwrap();
        let request = ContentBlob::json(&request).unwrap();
        let attempt = ModelAttemptId::new();
        let prepared = Change::new(Fact::ModelAttemptPrepared { attempt, step }, at);
        let request_fact_id = prepared.id;
        // No transport is launched by this storage seed. The frozen bytes and
        // provenance are from the real completed request above; recovery must
        // still obtain fresh Root custody and a DriverClaim before sending.
        let changes = vec![
            Change::new(
                Fact::StepPrepared {
                    step,
                    request: request.reference().clone(),
                    adjudications: vec![],
                },
                at,
            ),
            prepared,
            Change::new(Fact::ModelAttemptAdmitted { attempt, upstream }, at),
            Change::new(
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic: "fixture interrupted before transport admission".into(),
                },
                at,
            ),
            Change::new(
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::FrozenRetrySafe {
                        not_before: Some(at),
                    },
                },
                at,
            ),
            Change::new(
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: OperationCleanup::Confirmed,
                },
                at,
            ),
        ];
        let claim = state.claim(run).await.unwrap();
        let view = state.frontier(run).await.unwrap();
        state
            .append(&claim, (&view).into(), changes, vec![request])
            .await
            .unwrap();
        (run, request_fact_id)
    }

    pub(crate) async fn delivered_run(&self, queued: &Value) -> RunId {
        let session = queued["sessionId"].as_str().expect("actual queued session");
        let message = queued["messageId"].as_str().expect("actual queued message");
        let mut changed = self.owner.durable.subscribe().unwrap();
        loop {
            changed.borrow_and_update();
            match self
                .owner
                .durable
                .queue()
                .resolve_message(session.to_owned(), message.to_owned())
                .await
                .unwrap()
            {
                maka_agent_state::queue::MessageResolution::Delivered { run, .. } => return run,
                maka_agent_state::queue::MessageResolution::Pending => {
                    changed.changed().await.unwrap()
                }
                observed => panic!("queued request did not deliver: {observed:?}"),
            }
        }
    }

    pub(crate) async fn execution(&self, started: &Value) -> ExecutionIdentity {
        let run: RunId = serde_json::from_value(started["execution"]["runId"].clone())
            .expect("actual Started execution.runId");
        let view = self.owner.durable.frontier(run).await.unwrap();
        assert_eq!(view.spec.owner, self.owner.run_owner());
        assert_eq!(
            Some(view.spec.session_id.as_str()),
            started["execution"]["sessionId"].as_str()
        );
        ExecutionIdentity {
            session_id: view.spec.session_id,
            turn_id: view.spec.turn_id,
            run_id: view.run,
        }
    }

    pub(crate) async fn live_access(&self, id: &str) -> Arc<access::RunAccess> {
        self.owner
            .runs
            .state()
            .await
            .controls
            .get(id)
            .and_then(|control| control.access.upgrade())
            .expect("actual live driver access")
    }

    pub(crate) async fn new(base: &str, model: Option<ModelExecutor>) -> Self {
        Self::configured_provider(base, model, None, None, |_| {}, "openai-compatible").await
    }
    pub(crate) async fn with_services(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
    ) -> Self {
        Self::configured_provider(base, model, peer, tooling, |_| {}, "openai-compatible").await
    }
    pub(crate) async fn configured(
        base: &str,

        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
    ) -> Self {
        Self::configured_provider(base, model, peer, tooling, configure, "openai-compatible").await
    }
    async fn configured_with_temp_home(
        base: &str,
        configure: impl FnOnce(&mut Configuration),
    ) -> Self {
        Self::configured_application(base, None, None, None, configure, "openai-compatible", true)
            .await
    }
    async fn configured_provider(
        base: &str,
        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
        provider_name: &str,
    ) -> Self {
        Box::pin(Self::configured_application(
            base,
            model,
            peer,
            tooling,
            configure,
            provider_name,
            false,
        ))
        .await
    }
    async fn configured_application(
        base: &str,
        model: Option<ModelExecutor>,
        peer: Option<Arc<maka_transport::transport::PeerPolicy>>,
        tooling: Option<service_tools::Setup>,
        configure: impl FnOnce(&mut Configuration),
        provider_name: &str,
        use_temp_home: bool,
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
            external: None,
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
        let captured: FixtureCapture = Arc::new(StdMutex::new(None));
        let mut native = NativeRegistry::default();
        let catalog = bundled_catalog();
        maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
        if let Some(tooling) = &tooling {
            tooling.provide(&mut native);
        }
        let capture = captured.clone();
        let state = state.clone();
        let helper = native_helper();
        let replacement = Arc::new(StdMutex::new(model));
        let temp_home = use_temp_home.then(|| dir.path().to_path_buf());
        // Actual Host NativeContext and original NativeOwner; only the model
        // implementation is controlled in failure tests, never Root/admission.
        native
            .insert(
                IMPLEMENTATION.into(),
                Arc::new(move |context, configuration| {
                    let capture = capture.clone();
                    let catalog = catalog.clone();
                    let state = state.clone();
                    let helper = helper.clone();
                    let replacement = replacement.lock().unwrap().take();
                    let temp_home = temp_home.clone();
                    Box::pin(async move {
                        let services = context.services();
                        let mut owner =
                            Owner::open(context, configuration, catalog, state, helper, None)
                                .await
                                .unwrap();
                        if let Some(home) = temp_home {
                            Arc::get_mut(&mut owner).unwrap().home = Some(home);
                        }
                        if let Some(model) = replacement {
                            Arc::get_mut(&mut owner).unwrap().credentials.executor = model;
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
                let native = tooling
                    .as_ref()
                    .map(service_tools::Setup::policy)
                    .or_else(|| {
                        (!settings.tools.is_empty())
                            .then(|| Arc::new(maka_transport::transport::PeerPolicy::default()))
                    });
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
    pub(crate) async fn mutation(
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
        let recovery = json!({"reference": prepared.reference()});
        // Exercise the actual trusted Host gateway, including its durable caller
        // intent and original activation evidence, rather than reloading the
        // complete deployment in the test driver for every mutation.
        let reply = client
            .mutate_owned(prepared, recovery)
            .await?
            .result()
            .await;
        match reply.receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                ..
            } => Ok(value),
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Failure { diagnostic },
                    },
                ..
            } => Err(diagnostic),
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { diagnostic },
                ..
            } => Err(diagnostic),
            Receipt::Unavailable { diagnostic } => Err(diagnostic),
            other => panic!("unexpected receipt {other:?}"),
        }
    }
    pub(crate) async fn create(&self, title: &str) -> String {
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
        json!({"title":title, "labels":[], "workspace":{"kind":"directory","path":roots["roots"][0]["path"]}})
    }
    pub(crate) async fn selection(&self) -> ModelSelection {
        let row = self.config.catalog().await.unwrap().connections.remove(0);
        ModelSelection {
            connection_id: row.connection_id,
            model_id: "fixture-model".into(),
        }
    }
    pub(crate) async fn send(&self, session: &str) -> Result<Value, String> {
        self.mutation(
            2,
            "send",
            json!({"sessionId":session,"message":"Hello","delivery":"queue","backend":model_backend(&self.selection().await)}),
            Uuid::new_v4(),
        )
        .await
    }
    pub(crate) async fn query(&self, method: &str, input: Value) -> Result<Value, String> {
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
    pub(crate) async fn drained(&self) {
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
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let worker_entered = entered.clone();
        let worker_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let entered = worker_entered.clone();
                let release = worker_release.clone();
                requests.spawn(async move {
                    let body = request(&mut socket).await;
                    assert_eq!(body["model"], "fixture-model");
                    entered.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    response(&mut socket).await;
                });
            }
            while let Some(result) = requests.join_next().await {
                result.unwrap();
            }
        });
        let fixture = Fixture::new(&base, None).await;
        let first = fixture.create("First").await;
        let second = fixture.create("Second").await;
        let third = fixture.create("Third").await;
        let queued = fixture.send(&first).await.unwrap();
        entered.acquire().await.unwrap().forget();
        let run = fixture.delivered_run(&queued).await;
        assert!(
            !fixture.app.shutdown_if_idle().await.unwrap(),
            "completed send RPC still owns a live model run"
        );
        let active = fixture
            .query("observe", json!({"sessionId":first}))
            .await
            .unwrap();
        assert_eq!(active["session"]["id"], first);
        assert_eq!(active["session"]["activity"], "working");
        assert_eq!(active["run"]["runId"], json!(run));
        assert_eq!(active["run"]["state"], "running");
        assert!(!active.to_string().contains("private-fixture-key"));
        let mut watch = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":first,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let page = watch.recv().await.unwrap();
        assert!(!page.to_string().contains("private-fixture-key"));
        drop(watch);
        fixture.send(&second).await.unwrap();
        fixture.send(&third).await.unwrap();
        entered.acquire_many(2).await.unwrap().forget();
        assert_eq!(fixture.owner.runs.lock().await.controls.len(), 3);
        release.add_permits(3);
        server.await.unwrap();
        fixture.drained().await;
        assert!(fixture.owner.runs.lock().await.controls.is_empty());
        let completed = fixture
            .query("observe", json!({"sessionId":first}))
            .await
            .unwrap();
        let metrics = &completed["metrics"];
        assert_eq!(metrics["modelId"], "fixture-model");
        assert_eq!(metrics["contextTokens"], 3);
        assert_eq!(metrics["contextLastKnown"], false);
        let facts = fixture.recorded_facts(&first).await;
        let admitted = facts
            .iter()
            .find(|row| matches!(&row.fact, Fact::ModelAttemptAdmitted { .. }))
            .unwrap();
        let closed = facts
            .iter()
            .find(|row| {
                matches!(
                    &row.fact,
                    Fact::ModelClosed {
                        outcome: maka_agent_facts::accounting::Outcome::Success,
                        ..
                    }
                )
            })
            .unwrap();
        let seconds = (closed.at.0 - admitted.at.0) as f64 / 1000.0;
        assert!(seconds > 0.0);
        assert_eq!(
            metrics["outputTokensPerSecond"].as_f64().unwrap(),
            2.0 / seconds
        );
        assert!(completed["run"].is_null());
        assert_eq!(completed["session"]["activity"], "idle");
        assert_eq!(completed["parts"], json!([]));
        assert!(completed["through"].as_u64().unwrap() >= active["through"].as_u64().unwrap());
        assert_eq!(
            fixture.owner.durable.frontier(run).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        let through = fixture.through(&first).await;
        let history = fixture
            .query(
                "history",
                json!({"sessionId":first,"through":through,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        let response: String = history["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|chunk| chunk["role"] == "assistant")
            .map(|chunk| chunk["text"].as_str().unwrap())
            .collect();
        assert_eq!(response, "Elegant response");
        let request = facts
            .iter()
            .find_map(|row| match &row.fact {
                Fact::StepPrepared { request, .. } => Some(request),
                _ => None,
            })
            .unwrap();
        let reader = fixture.history(&first);
        let request: RequestSpec =
            serde_json::from_slice(&reader.content(run, request).await.unwrap()).unwrap();
        let adapter = request
            .composition
            .sources
            .iter()
            .find(|source| source.kind == SourceKind::ModelAdapter)
            .unwrap();
        let mut expected = fixture.owner.revision.clone();
        expected.kind = SourceKind::ModelAdapter;
        expected.name = "chat-completions".into();
        assert_eq!(
            adapter, &expected,
            "model evidence retains the actual Agent activation"
        );
        assert!(fixture.app.shutdown_if_idle().await.unwrap());
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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
        let first_run = fixture.delivered_run(&first).await;
        release.add_permits(1);
        fixture.drained().await;
        let second = fixture.send(&session).await.unwrap();
        entered.acquire().await.unwrap().forget();
        let second_run = fixture.delivered_run(&second).await;
        let stale = fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":first_run}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["requested"], false);
        let runs = fixture.owner.runs.lock().await;
        let control = runs.controls.get(&session).unwrap();
        assert_eq!(control.execution.run_id, second_run);
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
    database: Arc<StdMutex<Option<(std::path::PathBuf, ExecutionIdentity)>>>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
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
            fault
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            fault.entered.add_permits(1);
            fault.release.acquire().await.unwrap().forget();
            let (path, execution) = fault.database.lock().unwrap().as_ref().unwrap().clone();
            let panic = fault.panic;
            tokio::task::spawn_blocking(move||{
            let database = rusqlite::Connection::open(path).unwrap();
            let confirmed = serde_json::to_string(&maka_plugin_core::operation::OperationCleanup::Confirmed).unwrap();
            let kind = if panic { "model_cleanup_observed" } else { "run_terminated" };
            let cleanup = if panic {
                format!("AND json_extract(c.payload,'$.fact.cleanup')=json_extract('{confirmed}','$')")
            } else { String::new() };
            database.execute_batch(&format!("CREATE TRIGGER reject_worker_events BEFORE INSERT ON agent_facts
                WHEN NEW.run='{}' AND EXISTS(SELECT 1 FROM contents c WHERE c.id=NEW.body_content_id AND json_extract(c.payload,'$.fact.kind')='{kind}' {cleanup})
                BEGIN SELECT RAISE(ABORT, 'fixture worker SQL failure'); END;", execution.run_id)).unwrap();
            if panic {
                let session=execution.session_id.replace('\'',"''");
                database.execute_batch(&format!("CREATE TRIGGER reject_worker_queue BEFORE INSERT ON agent_queue_events
                    WHEN NEW.session='{session}' AND EXISTS(SELECT 1 FROM contents c WHERE c.id=NEW.body_content_id AND json_extract(c.payload,'$.kind')='command' AND json_extract(c.payload,'$.edit.kind')='enqueue')
                    BEGIN SELECT RAISE(ABORT, 'fixture queue SQL failure'); END;")).unwrap();
            }
            drop(database);
            }).await.unwrap();
            assert!(!fault.panic, "controlled original model worker panic");
            Err(maka_model::ModelError::Http {
                status: 401,
                message: Some("ordinary model failure".into()),
            })
        })
    }
}
fn controlled_model(panic: bool) -> (ModelExecutor, Fault) {
    let fault = Fault {
        panic,
        entered: Arc::new(Semaphore::new(0)),
        release: Arc::new(Semaphore::new(0)),
        database: Arc::new(StdMutex::new(None)),
        calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
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

    let queued = fixture.send(&session).await.unwrap();
    let run = fixture.delivered_run(&queued).await;
    let view = fixture.owner.durable.frontier(run).await.unwrap();
    let execution = ExecutionIdentity {
        session_id: view.spec.session_id.clone(),
        turn_id: view.spec.turn_id.clone(),
        run_id: view.run,
    };
    *fault.database.lock().unwrap() = Some((fixture.session_database(&session), execution.clone()));
    let activation = fixture.owner.revision.activation.clone();
    fault.entered.acquire().await.unwrap().forget();

    let selection = fixture.selection().await;
    let pending_message = fixture.send(&session).await.unwrap();
    assert_eq!(pending_message["kind"], "queued");
    let reference = if panic {
        let input = json!({"sessionId":session,"message":"after failed cleanup","backend":model_backend(&selection)});
        let prepared = fixture
            .app
            .client()
            .prepare_mutation(
                fixture.binding(2).await,
                "send".into(),
                input.clone(),
                scope(&fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        Some((prepared, input))
    } else {
        None
    };

    fault.release.add_permits(1);
    fixture.drained().await;
    assert_eq!(
        fault.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "failed model execution must not be replayed"
    );
    let recorded = fixture.recorded_facts(&session).await;
    assert_eq!(
        recorded
            .iter()
            .filter(|fact| matches!(&fact.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        1
    );
    assert_eq!(
        recorded
            .iter()
            .filter(|fact| matches!(
                &fact.fact,
                Fact::ModelCleanupObserved {
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
                    ..
                }
            ))
            .count(),
        usize::from(!panic),
        "Root settlement requires the original cleanup publication ACK"
    );
    assert!(
        !recorded
            .iter()
            .any(|fact| matches!(&fact.fact, Fact::RunTerminated { .. })),
        "failed terminal publication cannot become a terminal fact"
    );
    if !panic {
        assert!(
            recorded.iter().any(|fact| matches!(
                &fact.fact,
                Fact::ModelClosed {
                    outcome: maka_agent_facts::accounting::Outcome::Error,
                    ..
                }
            )),
            "ordinary provider rejection is a real error closure, not synthetic Finished"
        );
    }

    if let Some((prepared, input)) = reference {
        // Queue writes fail independently of the original cleanup ACK.
        let original = prepared.reference().clone();
        let reply = fixture
            .app
            .client()
            .mutate_owned(prepared, input)
            .await
            .unwrap()
            .result()
            .await;
        assert_eq!(reply.reference, original);
        let error = match &reply.receipt {
            Receipt::Recorded {
                outcome: maka_plugin_core::operation::OperationOutcome::Unknown { diagnostic },
                ..
            } => diagnostic,
            _ => panic!(
                "SQL write failure must preserve the actual original uncertainty, not successful admission: {reply:?}"
            ),
        };
        assert!(!error.contains("agent_cleanup_unconfirmed"), "{error}");
        let raw = rusqlite::Connection::open_with_flags(
            fixture.session_database(&session),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let pending: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM agent_queue_items WHERE session = ?1 AND state='pending'",
                [&session],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
    }
    assert_eq!(
        fixture.owner.runs.state().await.retained_cleanup.len(),
        usize::from(panic)
    );
    assert!(
        !fixture.owner.runs.state().await.closing,
        "one failed Run must not close the Agent owner"
    );
    assert!(!fixture.owner.stop.is_cancelled());

    if !panic {
        let queue = fixture.owner.durable.queue();
        let baseline = queue.read(session.clone()).await.unwrap();
        assert_eq!(baseline.entries.len(), 1);
        let original = &baseline.entries[0].request;
        assert_eq!(
            original.message_id,
            pending_message["messageId"].as_str().unwrap()
        );
        let input = queue
            .content(
                session.clone(),
                original.id.clone(),
                original.source.clone(),
            )
            .await
            .unwrap();
        struct DamagePendingProjection {
            session: String,
            request: String,
        }
        impl maka_event_log::writeback::Statement for DamagePendingProjection {
            type Value = usize;
            type Output = usize;
            fn execute(
                self,
                c: &rusqlite::Connection,
            ) -> Result<maka_event_log::writeback::Prepared<usize>, maka_event_log::StoreError>
            {
                let changed=c.execute("UPDATE agent_queue_items SET entry_json='{}' WHERE session=? AND request=? AND state='pending'",rusqlite::params![self.session,self.request])?;
                Ok(maka_event_log::writeback::Prepared {
                    value: changed,
                    changed: changed != 0,
                    notification: maka_event_log::writeback::Notification::NONE,
                })
            }
            fn committed(value: usize) -> usize {
                value
            }
            fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
                false
            }
        }
        assert_eq!(
            fixture
                .store
                .data_writer()
                .unwrap()
                .write(DamagePendingProjection {
                    session: session.clone(),
                    request: original.id.0.clone()
                })
                .await
                .unwrap(),
            1
        );
        assert!(
            queue.read(session.clone()).await.is_err(),
            "a corrupt pending projection is a real Root query error, not an empty queue"
        );
        assert!(
            queue
                .ready(fixture.owner.run_owner(), None, 256)
                .await
                .is_err(),
            "ready must preserve the original queue read failure"
        );
        assert_eq!(
            queue
                .resolve_message(session.clone(), original.message_id.clone())
                .await
                .unwrap(),
            maka_agent_state::queue::MessageResolution::Pending
        );
        assert_eq!(fault.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(fixture.recorded_facts(&session).await, recorded);
        queue.rebuild(session.clone()).await.unwrap();
        assert_eq!(
            queue.read(session.clone()).await.unwrap(),
            baseline,
            "canonical rebuild preserves the original pending request, message and revision"
        );
        assert_eq!(
            queue
                .content(
                    session.clone(),
                    original.id.clone(),
                    original.source.clone()
                )
                .await
                .unwrap(),
            input,
            "the original immutable input is not replaced by projection repair"
        );
        fixture.drained().await;
        assert_eq!(
            fault.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "projection rebuild must not reexecute user intent"
        );
        assert_eq!(fixture.recorded_facts(&session).await, recorded);
        assert!(fixture.owner.runs.state().await.retained_cleanup.is_empty());
    }

    let close = loop {
        match fixture.app.shutdown_if_idle().await {
            Ok(false) => tokio::task::yield_now().await,
            result => break result,
        }
    };

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
            "resources_retained",
        )
    } else {
        ("queue_advance_failed", "store_sqlite", "operation_failed")
    };
    let event = log
        .lines()
        .find(|line| line.contains(&format!("stage=\"{stage}\"")))
        .expect("actual fatal queue custody outcome must be logged");
    assert!(event.contains("ERROR"));
    assert!(event.contains(&format!("cause=\"{cause}\"")));
    assert!(event.contains(&format!("consequence=\"{consequence}\"")));
    for identity in [
        &execution.session_id,
        &execution.turn_id,
        &execution.run_id.to_string(),
        &activation,
    ] {
        assert!(
            event.contains(identity),
            "fatal event must retain original execution/activation: {event}"
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
async fn model_panic_and_terminal_sql_failure_keep_the_owner_open_and_retain_original_custody() {
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

pub(crate) fn native_helper() -> std::path::PathBuf {
    let helper = std::path::PathBuf::from(
        std::env::var_os("CARGO_BIN_EXE_maka")
            .expect("the CI runner supplies the actual relocated Maka helper"),
    );
    assert!(
        helper.is_file(),
        "Native fixtures require the real Maka CLI helper built by the workspace CLI integration target: {}",
        helper.display()
    );
    helper
}

fn provide_all(
    registry: &mut NativeRegistry,
    state: maka_agent_state::Store,
) -> Result<(), String> {
    crate::provide(registry, bundled_catalog(), state, native_helper())?;
    maka_acp_native::provide(registry)?;
    maka_files_native::provide(registry)?;
    maka_processes_native::provide(registry)?;
    maka_skills_native::provide(registry)?;
    maka_interactions_native::questions::provide(registry)?;
    maka_interactions_native::forms::provide(registry)?;
    maka_web::provide(registry)?;
    maka_decisions_api_native::provide(registry)?;
    Ok(())
}
