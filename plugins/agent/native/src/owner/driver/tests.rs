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

use super::super::driver_cells::RunCells;
use super::*;
use maka_agent_facts::{
    accounting::ModelEvidence,
    composition::RequestComposition,
    configuration::{CatalogMutationResult, ModelSelection},
    context::ModelPurpose,
    execution::CollaborationMode,
    input::RunInput,
    language::Language,
    model::{ModelPart, ModelToolCall, ToolInput},
    tool_call::ToolSettlement,
    tools::{
        PreparationFuture, ToolDefinition, ToolHandler, ToolNesting, ToolPreparer, ToolRegistration,
    },
};
use maka_agent_state::{Admission, DriverDomain, Store};
use maka_capabilities::call::Attachments;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionWorkLease, WorkEffects},
};
use maka_host_runtime::{
    application::{
        Handler, NativeActivation, NativeRegistry,
        host::{Client as HostClient, Configuration as HostConfiguration, Host, LocalCall},
        transport::{Grant, HostEndpoint, NativeGrant, gateway_native, wire::Reply},
    },
    ipc::LocalListener,
};
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{Configuration, Input, InstanceId, Node, PackageUse, Target},
    contract::{Availability, Cardinality, Export, Import},
    operation::{OperationCleanup, OperationOutcome, OperationResult},
    package::{Declaration, EntryDeclaration, Implementation, NativeDefinition, PackageRef},
    runtime::Published,
};
use serde_json::{Value, json};
use std::{
    error::Error,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;
use uuid::Uuid;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn at() -> UnixMillis {
    UnixMillis(
        maka_agent_authority::now()
            .try_into()
            .expect("Unix milliseconds"),
    )
}

fn package(
    id: &str,
    definition: NativeDefinition,
    imports: BTreeMap<String, Import>,
) -> TestResult<Package> {
    let declaration = Declaration {
        host: Some(EntryDeclaration {
            implementation: Implementation::Native {
                implementation: definition.implementation,
            },
            configuration: definition.configuration,
            imports,
            exports: definition
                .exports
                .into_iter()
                .map(|(name, contract)| {
                    (
                        name,
                        Export {
                            contract,
                            availability: Availability::Required,
                        },
                    )
                })
                .collect(),
        }),
        ui: None,
        composition: None,
    };
    Ok(Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion":1, "id":id, "application":declaration
        }))?,
    )]))?)
}

fn node(
    key: Uuid,
    package: PackageRef,
    values: Value,
    bindings: BTreeMap<String, Vec<Target>>,
) -> Node {
    Node {
        key,
        package: package.into(),
        use_package: PackageUse::Host,
        configuration: Configuration {
            values: serde_json::from_value(values).unwrap(),
            parameters: BTreeMap::new(),
        },
        parameters: Configuration::default(),
        bindings,
        disabled: false,
        overrides: vec![],
    }
}

// A lifetime assertion only; this marker never supplies physical cleanup evidence.
struct AdmissionGuard(Arc<AtomicBool>);
impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct PendingCallback {
    owner: effects::OriginalEffects,
    original: Arc<Mutex<effects::OriginalEffect>>,
    task: JoinHandle<Result<ToolSuccess, ToolError>>,
}

struct OrdinaryTool(StdMutex<Option<oneshot::Receiver<()>>>);
impl ToolPreparer for OrdinaryTool {
    fn names(&self) -> Vec<String> {
        vec!["ordinary_local".into()]
    }
    fn prepare(
        &self,
        _name: String,
        _input: Value,
        _context: ToolCallContext,
        _cancellation: CancellationToken,
    ) -> PreparationFuture {
        let receiver = self
            .0
            .lock()
            .unwrap()
            .take()
            .expect("one original Ordinary preparation");
        Box::pin(async move {
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    tokio::select! {
                        result = receiver => result.map_err(|error| ToolError::Failed(error.to_string()))?,
                        _ = cancellation.cancelled() => return Err(ToolError::Failed("ordinary cancelled".into())),
                    }
                    Ok(ToolSuccess::from(ToolOutput::Text("ordinary done".into())))
                })
            }))
        })
    }
}

enum TestDirectory {
    Owned(tempfile::TempDir),
    Borrowed(std::path::PathBuf),
}
impl TestDirectory {
    fn path(&self) -> &std::path::Path {
        match self {
            Self::Owned(directory) => directory.path(),
            Self::Borrowed(path) => path,
        }
    }
}

struct Rig {
    directory: TestDirectory,
    socket_directory: TestDirectory,
    model_listener: std::net::TcpListener,
    model_overrides: Value,
    native_grants: Vec<NativeGrant>,
    store: Option<Arc<RootStore>>,
    host: Option<Arc<Host>>,
    serving: Option<JoinHandle<Result<(), String>>>,
    stop_serving: CancellationToken,
    client: Option<HostClient>,
    call: Option<LocalCall>,
    captured: Arc<StdMutex<Option<Arc<Owner>>>>,
    completion_gate: Arc<preset_test_gate::Gate>,
    lease: Option<SessionWorkLease>,
    work_effects: Option<WorkEffects>,
    driver: Option<Arc<NativeDriver>>,
    cells: Option<Arc<RunCells>>,
    ordinary: Option<effects::OriginalEffects>,
    gate: Option<oneshot::Sender<()>>,
    callbacks: Vec<PendingCallback>,
}

impl Rig {
    fn new() -> TestResult<Self> {
        let socket_directory = tempfile::tempdir()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                socket_directory.path(),
                std::fs::Permissions::from_mode(0o700),
            )?;
        }
        let model_listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        model_listener.set_nonblocking(true)?;
        Ok(Self {
            directory: TestDirectory::Owned(tempfile::tempdir()?),
            socket_directory: TestDirectory::Owned(socket_directory),
            model_listener,
            model_overrides: json!({}),
            native_grants: vec![],
            store: None,
            host: None,
            serving: None,
            stop_serving: CancellationToken::new(),
            client: None,
            call: None,
            captured: Arc::default(),
            completion_gate: Arc::default(),
            lease: None,
            work_effects: None,
            driver: None,
            cells: None,
            ordinary: None,
            gate: None,
            callbacks: vec![],
        })
    }

    async fn start(&mut self) -> TestResult<String> {
        self.start_configured(None, |_| {}).await
    }

    async fn start_configured(
        &mut self,
        observation: Option<crate::model::Observation>,
        configure: impl FnOnce(&mut Value),
    ) -> TestResult<String> {
        let root_path = self.directory.path().join("root");
        let workspace = self.directory.path().join("workspace");
        let namespaces = RootNamespaces {
            ownership: self.directory.path().join("owners"),
            control: self.directory.path().join("control"),
        };
        let root = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&workspace)?;
            RootOwner::create(&root_path, &namespaces)
        })
        .await??;
        let mut migrations = maka_event_log::ROOT_MIGRATIONS.to_vec();
        migrations.extend_from_slice(maka_agent_state::MIGRATIONS);
        migrations.sort_by_key(|migration| migration.version);
        let store = Arc::new(RootStore::open(Arc::new(root), &migrations).await?);
        self.store = Some(store.clone());
        let agent = package(
            "maka.tests.wait-agent",
            maka_agent_api::native(),
            BTreeMap::new(),
        )?;
        let gateway = package(
            "maka.tests.wait-client",
            gateway_native(),
            BTreeMap::from([(
                "agent".into(),
                Import {
                    contract: maka_agent_api::contract(),
                    cardinality: Cardinality::One,
                },
            )]),
        )?;
        let agent_key = Uuid::new_v4();
        let gateway_key = Uuid::new_v4();
        let mut configuration = json!({
            "permissions":{"access":"read_only","requestPermissions":false},
            "workspaceRoots":[{"label":"test","path":self.directory.path().join("workspace")}],
            "tools":[]
        });
        configure(&mut configuration);
        let input = Input {
            base: None,
            ui: None,
            instances: BTreeMap::from([
                (
                    "agent".into(),
                    node(
                        agent_key,
                        agent.application_ref(),
                        configuration,
                        BTreeMap::new(),
                    ),
                ),
                (
                    "client".into(),
                    node(
                        gateway_key,
                        gateway.application_ref(),
                        json!({}),
                        BTreeMap::from([(
                            "agent".into(),
                            vec![Target::Instance {
                                path: vec!["agent".into()],
                                export: "agent".into(),
                            }],
                        )]),
                    ),
                ),
            ]),
        };
        let deployment = Uuid::new_v4();
        store
            .commit_application(deployment, 0, input, vec![], vec![agent, gateway])
            .await?;
        self.attach_host(store, deployment, gateway_key, false, observation)
            .await?;
        self.call = Some(self.client.as_ref().unwrap().call("agent", "create".into(), json!({
            "title":"native wait original read failure", "labels":[],
            "workspace":{"kind":"directory","path":self.directory.path().join("workspace")}
        }), Attachments::new()).await?);
        let call = self.call.as_mut().unwrap();
        call.start().await?;
        assert!(matches!(call.receive().await?, Reply::Prepared { .. }));
        let terminal = call
            .confirm(json!({"test":"native-wait-original-read"}))
            .await?;
        let Reply::Mutation { reply, cleanup } = terminal else {
            return Err("create did not return its original mutation".into());
        };
        cleanup?;
        let Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } = &reply.receipt
        else {
            return Err("create receipt or physical cleanup not confirmed".into());
        };
        assert_eq!(value["kind"], "created");
        let session = value["session"]["id"]
            .as_str()
            .ok_or("created session missing")?
            .to_owned();
        call.close().await?;
        self.call = None;
        Ok(session)
    }

    async fn attach_host(
        &mut self,
        store: Arc<RootStore>,
        deployment: Uuid,
        gateway_key: Uuid,
        model_test: bool,
        observation: Option<crate::model::Observation>,
    ) -> TestResult<()> {
        self.store = Some(store.clone());
        let data = store.data_writer()?;
        let state = Store::new(data.clone(), DriverDomain::new(data)?)?;
        let catalog = Arc::new(maka_providers::catalog::Catalog::new(
            maka_providers::catalog::Snapshot::bundled()?,
        ));
        let mut registry = NativeRegistry::default();
        if model_test {
            maka_settings_native::provide(&mut registry, catalog.clone())?;
            maka_files_native::provide(&mut registry)?;
            maka_web::provide(&mut registry)?;
        }
        let capture = self.captured.clone();
        let completion_gate = self.completion_gate.clone();
        let helper = std::env::current_exe()?;
        registry.insert(
            maka_agent_api::IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let (capture, catalog, state, helper) = (
                    capture.clone(),
                    catalog.clone(),
                    state.clone(),
                    helper.clone(),
                );
                let completion_gate = completion_gate.clone();
                Box::pin(async move {
                    match Owner::open(context, configuration, catalog, state, helper, None).await {
                        Ok(owner) => {
                            let owner = match observation {
                                Some(observe) => owner.with_model_observation(observe),
                                None => owner,
                            };
                            *capture.lock().unwrap() = Some(owner.clone());
                            let service = Arc::new(crate::service::Agent(owner));
                            NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "agent".into(),
                                    Published {
                                        contract: maka_agent_api::contract(),
                                        value: Arc::new(preset_test_gate::HandlerGate {
                                            inner: service.clone(),
                                            gate: completion_gate,
                                        })
                                            as Arc<dyn Handler>,
                                    },
                                )])),
                                owner: service,
                            }
                        }
                        Err(error) => error.activation(),
                    }
                })
            }),
        )?;
        let methods: &[&str] = if model_test {
            &[
                "presets",
                "preset",
                "createPreset",
                "updatePreset",
                "deletePreset",
                "fork",
                "list",
                "metadata",
                "pendingInteractions",
                "interaction",
                "respond",
                "create",
                "continueRun",
                "history",
                "models",
                "observe",
                "tools",
                "predictNextMessage",
                "compact",
                "selectBackend",
                "execution",
                "send",
                "uploadAttachment",
                "work",
                "workReadiness",
                "queue",
                "openBot",
                "botOutbox",
                "schedule",
                "schedules",
                "metadata",
                "project",
                "projects",
                "selectBackend",
                "stop",
            ]
        } else {
            &[
                "create",
                "history",
                "observe",
                "send",
                "work",
                "source",
                "search",
                "fork",
                "list",
                "execution",
                "stop",
                "goal",
                "changeGoal",
                "metadata",
            ]
        };
        let mut endpoints = BTreeMap::from([(
            "agent".into(),
            HostEndpoint {
                consumer: InstanceId(vec![gateway_key]),
                import: "agent".into(),
                grant: Grant {
                    methods: methods.iter().map(|method| (*method).into()).collect(),
                    recovery: false,
                },
            },
        )]);
        if model_test {
            endpoints.insert(
                "web".into(),
                HostEndpoint {
                    consumer: InstanceId(vec![gateway_key]),
                    import: "web".into(),
                    grant: Grant {
                        methods: ["snapshot".into(), "save".into()].into(),
                        recovery: false,
                    },
                },
            );
            endpoints.insert(
                "settings".into(),
                HostEndpoint {
                    consumer: InstanceId(vec![gateway_key]),
                    import: "settings".into(),
                    grant: Grant {
                        methods: [
                            "assistantPreferences".into(),
                            "connections".into(),
                            "create".into(),
                            "updateAssistantPreferences".into(),
                        ]
                        .into(),
                        recovery: false,
                    },
                },
            );
        }
        let native = if !self.native_grants.is_empty() {
            self.native_grants.clone()
        } else if model_test {
            let loaded = store
                .load_application(deployment)
                .await?
                .ok_or("deployment missing")?;
            let instances = &loaded.source().input.instances;
            vec![maka_host_runtime::application::transport::NativeGrant {
                origin: InstanceId(vec![instances["agent"].key]),
                consumer: InstanceId(vec![instances["agent"].key]),
                provider: InstanceId(vec![instances["web"].key]),
                export: "web".into(),
                methods: ["capture".into()].into(),
                recovery: true,
            }]
        } else {
            vec![]
        };
        let host = Host::open(
            store,
            deployment,
            registry,
            None,
            HostConfiguration::PublicHost {
                endpoints,
                native,
                product_methods: Default::default(),
            },
        )
        .await?;
        self.host = Some(host.clone());
        let socket = self.socket_directory.path().join("wait.sock");
        let listener = LocalListener::bind(&socket)?;
        let cancel = self.stop_serving.clone();
        self.serving = Some(tokio::spawn(async move {
            host.serve_local(listener, cancel).await
        }));
        self.client = Some(HostClient::connect(&socket, None).await?);
        Ok(())
    }

    async fn assemble(&mut self, session: &str) -> TestResult<()> {
        self.assemble_budget(session, None).await
    }

    async fn assemble_budget(&mut self, session: &str, tokens: Option<u64>) -> TestResult<()> {
        self.assemble_model(
            session,
            Budget {
                tokens,
                retries: 0,
                deadline: None,
            },
            true,
        )
        .await
    }

    async fn assemble_model(
        &mut self,
        session: &str,
        budget: Budget,
        with_ordinary_tool: bool,
    ) -> TestResult<()> {
        let owner = self
            .captured
            .lock()
            .unwrap()
            .clone()
            .ok_or("factory did not return its actual owner")?;
        let catalog = owner.configuration.catalog().await?;
        let connection = owner.configuration.create_connection(serde_json::from_value(json!({
            "expectedCatalogRevision":catalog.revision,
            "connection":{
                "slug":"wait-local", "name":"wait-local",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":format!("http://{}/v1", self.model_listener.local_addr()?)},
                "enabled":true, "enabledModelIds":["llama3.2"],
                "modelOverrides":self.model_overrides
            }
        }))?).await?;
        let CatalogMutationResult::Committed {
            connection: Some(connection),
            ..
        } = connection
        else {
            return Err("local model configuration was not committed".into());
        };
        let (source, _) = crate::model::Source::select(
            owner.configuration.clone(),
            owner.catalog.clone(),
            owner.credentials.clone(),
            ModelSelection {
                connection_id: connection.connection_id,
                model_id: "llama3.2".into(),
            },
            None,
            session.into(),
            owner.revision.clone(),
        )
        .await?;
        let current = owner.mutable_session(session).await?;
        let scope = owner
            .current_work_scope(session, &current.configuration)
            .await?;
        let (lease, work_effects) = scope.accept(CancellationToken::new());
        self.lease = Some(lease);
        self.work_effects = Some(work_effects);
        let lease = self.lease.as_ref().unwrap();
        let custody = lease.store().work_custody()?;
        let state = owner.durable.with_data_writer(
            owner
                .store
                .data_writer_for_work(custody.as_ref(), session)?,
        )?;
        let backend = ContentBlob::json(&source.accepted)?;
        let empty = ContentBlob::json(&RunInput::Message {
            content: "native wait original read failure".to_string().into(),
            request_fingerprint: None,
            source_messages: vec![],
        })?;
        let system = ContentBlob::json(&Option::<maka_agent_facts::execution::SystemPrompt>::None)?;
        let ordinary_tool = with_ordinary_tool.then(|| {
            let (sender, receiver) = oneshot::channel();
            self.gate = Some(sender);
            ToolRegistration {
                definition: ToolDefinition {
                    name: "ordinary_local".into(),
                    description: "Finite private regression callback".into(),
                    input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
                    provider: None,
                    freeform: None,
                    output_schema: None,
                },
                nesting: ToolNesting::DirectOnly,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Prepared(Arc::new(OrdinaryTool(StdMutex::new(Some(receiver))))),
            }
        });
        let catalog = maka_tools::ToolCatalog::new(ordinary_tool)?;
        let tools = ContentBlob::json(&crate::tools::SelectionSnapshot {
            definitions: catalog.definitions().cloned().collect(),
            direct_only: catalog.names().into_iter().collect(),
            services: vec![],
            internal_bindings: Default::default(),
        })?;
        let workspace = current.configuration.workspace.clone();
        let access_mode = current.configuration.permissions.access;
        let root_path = owner.store.owned_root()?.canonical_path().to_path_buf();
        let sandbox = tokio::task::spawn_blocking(move || {
            maka_workspace_support::sandbox(&workspace, access_mode, &root_path)
        })
        .await??
        .0;
        let spec = RunSpec {
            schema_version: SCHEMA_VERSION,
            session_id: session.into(),
            owner: owner.run_owner(),
            turn_id: Uuid::new_v4().to_string(),
            origin: RunOrigin::Local,
            trigger: Trigger::Message {
                message_id: Uuid::new_v4().to_string(),
            },
            workspace: current.configuration.workspace.path.clone(),
            permission_basis: current.configuration.permission_basis(),
            permission_ceiling: maka_sandbox::Permissions {
                sandbox,
                approval: maka_sandbox::Approval::Never,
            },
            backend: BackendSpec::Model {
                binding: source.accepted.binding.clone(),
                descriptor: backend.reference().clone(),
            },
            collaboration: CollaborationMode::Agent,
            language: Language::En,
            tool_discovery: false,
            allowed_tools: None,
            mcp_revision: None,
            compaction_prompt: None,
            system_prompt: system.reference().clone(),
            tool_selection: tools.reference().clone(),
            input: empty.reference().clone(),
            budget,
            budget_basis: None,
        };
        let admission = Admission::new(spec, at(), vec![backend, empty, system, tools]);
        let run = admission.run();
        // The activated scheduler must not reserve this fixture's Run before its claim.
        let runs = owner.runs.state().await;
        state.admit(admission).await?;
        let view = state.frontier(run).await?;
        let claim = state.claim(run).await?;
        drop(runs);
        let access = owner.run_access(Arc::new(view.spec.clone()), claim, lease)?;
        let workers = TaskTracker::new();
        let cleanup = Evidence::default();
        let cells = RunCells::new(
            owner.clone(),
            access.clone(),
            owner.code_executor.clone(),
            workers.clone(),
            cleanup.clone(),
        )?;
        self.cells = Some(cells.clone());
        let model = DriverModel {
            state: state.clone(),
            log: Arc::new(lease.store()),
            source: Arc::new(source),
            executor: owner.credentials.executor.clone(),
            resources: owner.services.model_preparation_resources(),
            execution: access.execution().clone(),
            cancellation: CancellationToken::new(),
            cleanup: cleanup.clone(),
            workers: workers.clone(),
            original_cleanup: Default::default(),
            conversation: Default::default(),
            preview: tokio::sync::watch::channel(None).0,
        };
        self.ordinary = Some(effects::OriginalEffects::new(
            state.clone(),
            owner.services.clone(),
            access.clone(),
        ));
        self.driver = Some(Arc::new(NativeDriver::new(
            owner.clone(),
            state,
            access,
            catalog,
            owner.mcp_projects.base.clone(),
            NativeBackend::Model {
                model,
                cells: Some(cells),
            },
            CancellationToken::new(),
            cleanup,
            workers,
        )));
        Ok(())
    }

    async fn append(
        &self,
        facts: Vec<Fact>,
        contents: Vec<ContentBlob>,
    ) -> TestResult<maka_agent_state::Commit> {
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        Ok(driver
            .state
            .append(
                driver.access.claim(),
                (&view).into(),
                facts
                    .into_iter()
                    .map(|fact| Change::new(fact, at()))
                    .collect(),
                contents,
            )
            .await?)
    }

    async fn record_model_reply(
        &self,
        mode: maka_agent_engine::ports::Preparation,
        summary: Option<&str>,
    ) -> TestResult<(RequestSpec, ModelAttemptId)> {
        let (request, attempt, _) = self.record_model_request(mode).await?;
        self.finish_model_request(attempt, summary).await?;
        Ok((request, attempt))
    }

    async fn record_model_request(
        &self,
        mode: maka_agent_engine::ports::Preparation,
    ) -> TestResult<(RequestSpec, ModelAttemptId, UnixMillis)> {
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let mut prepared = driver.model()?.prepare_step(&view, mode, driver).await?;
        let request = &prepared.request;
        let body = ContentBlob::json(request)?;
        prepared.contents.push(body.clone());
        let attempt = ModelAttemptId::new();
        let started = at();
        driver
            .state
            .append(
                driver.access.claim(),
                (&view).into(),
                vec![
                    Change::new(
                        Fact::StepPrepared {
                            step: request.step,
                            request: body.reference().clone(),
                            adjudications: vec![],
                        },
                        started,
                    ),
                    Change::new(
                        Fact::ModelAttemptPrepared {
                            attempt,
                            step: request.step,
                        },
                        started,
                    ),
                    Change::new(
                        Fact::ModelAttemptAdmitted {
                            attempt,
                            upstream: json!({"test":"compaction"}),
                        },
                        started,
                    ),
                ],
                prepared.contents,
            )
            .await?;
        Ok((prepared.request, attempt, started))
    }

    async fn finish_model_request(
        &self,
        attempt: ModelAttemptId,
        summary: Option<&str>,
    ) -> TestResult<()> {
        self.append(
            vec![
                Fact::ModelClosed {
                    attempt,
                    outcome: maka_agent_facts::accounting::Outcome::Success,
                    diagnostic: None,
                    usage: Default::default(),
                    protocol: json!({
                        "finishReason":"stop",
                        "summary": summary.map(|text| json!({"kind":"text","summary":{"text":text}})),
                    }),
                },
                Fact::ModelCleanupObserved { attempt, cleanup: OperationCleanup::Confirmed },
            ],
            vec![],
        ).await?;
        Ok(())
    }

    async fn attempt(&self) -> TestResult<ModelAttemptId> {
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let BackendSpec::Model {
            binding,
            descriptor,
        } = &view.spec.backend
        else {
            unreachable!()
        };
        let source = ContentBlob::json(&json!({"test":"native-wait-provider-input"}))?;
        let step = StepId::new();
        let request = ContentBlob::json(&RequestSpec {
            schema_version: SCHEMA_VERSION,
            step,
            composition: RequestComposition {
                system_prompt: None,
                dynamic_context: vec![],
                tool_catalog_digest: source.reference().digest.clone(),
                tools: vec![],
                provider_options: None,
                max_output_tokens: None,
                sources: vec![],
            },
            summary_repair_of: None,
            compaction_recovery: None,
            source_capture: descriptor.clone(),
            source_digest: descriptor.digest.clone(),
            effective_source_digest: descriptor.digest.clone(),
            provenance: source.reference().clone(),
            projection: None,
            adjudications: vec![],
            steering: vec![],
            request: source.reference().clone(),
            protocol: "maka.tests.native-wait".into(),
            protocol_version: 1,
            recovery_contract: source.reference().clone(),
            request_contents: vec![],
            accounting: ModelEvidence {
                binding: binding.clone(),
                model_id: binding.model.clone(),
                purpose: ModelPurpose::Main,
                quote: None,
            },
        })?;
        let attempt = ModelAttemptId::new();
        self.append(
            vec![
                Fact::StepPrepared {
                    step,
                    request: request.reference().clone(),
                    adjudications: vec![],
                },
                Fact::ModelAttemptPrepared { attempt, step },
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"test":"native-wait-provider-input"}),
                },
            ],
            vec![source, request],
        )
        .await?;
        Ok(attempt)
    }

    async fn tool(
        &self,
        attempt: ModelAttemptId,
        name: &str,
        call: &str,
        input: Value,
    ) -> TestResult<(ToolKey, u64)> {
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let key = ToolKey {
            attempt,
            call: call.into(),
        };
        let input_blob = ContentBlob::json(&input)?;
        let commit = self
            .append(
                vec![
                    Fact::ModelObserved {
                        attempt,
                        index: view.attempts[&attempt].observed,
                        part: ModelPart::ToolCall {
                            call: ModelToolCall {
                                id: call.into(),
                                name: name.into(),
                                input: ToolInput::Json(input),
                                provider_options: None,
                                provider_executed: false,
                            },
                        },
                        continuation: None,
                    },
                    Fact::ToolDecided {
                        tool: key.clone(),
                        decision: ToolDecision::Approved {
                            semantics: ToolSemantics::Parallel,
                            input: input_blob.reference().clone(),
                            resources: vec![],
                            approval: None,
                            display: ToolDisplay::default(),
                        },
                    },
                    Fact::ToolAdmitted { tool: key.clone() },
                ],
                vec![input_blob],
            )
            .await?;
        Ok((key, commit.facts.last().unwrap().revision))
    }

    fn begin(
        &mut self,
        effect: PreparedEffect,
        sequence: u64,
        key: ToolKey,
        source: DispatchSource,
        owner: effects::OriginalEffects,
        released: Arc<AtomicBool>,
    ) -> TestResult<()> {
        let running = effect
            .guarded(move || Ok(AdmissionGuard(released)))
            .begin(sequence, CancellationToken::new())?;
        let (custody, callback) = running.execute();
        let original = owner.own(custody, key, None, source);
        self.callbacks.push(PendingCallback {
            owner,
            original,
            task: tokio::spawn(callback),
        });
        Ok(())
    }

    async fn complete(&mut self) -> TestResult<DispatchOutcome> {
        let joined = (&mut self.callbacks.last_mut().unwrap().task).await;
        let callback = self.callbacks.pop().unwrap();
        Ok(callback
            .owner
            .complete(callback.original, joined?, None)
            .await?)
    }

    async fn check(&mut self) -> TestResult<()> {
        let session = self.start().await?;
        self.assemble(&session).await?;
        let attempt = self.attempt().await?;
        let exec_input = json!({"code":"text('native-wait-finite-vm')","yield_time_ms":30000});
        let (exec_key, exec_t1) = self
            .tool(attempt, "exec", "original-exec", exec_input.clone())
            .await?;
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let context = driver.context(&view, &exec_key)?;
        let (exec, source) = self
            .cells
            .as_ref()
            .unwrap()
            .prepare(
                context,
                "exec",
                &exec_input,
                driver.catalog.clone(),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await?;
        let exec_released = Arc::new(AtomicBool::new(false));
        self.begin(
            exec,
            exec_t1,
            exec_key.clone(),
            source,
            driver.original_effects.clone(),
            exec_released.clone(),
        )?;
        self.complete().await?;
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let cell = view
            .cells
            .values()
            .find(|cell| {
                matches!(&cell.owner,
            maka_agent_facts::cells::CellOwner::Agent { call, .. } if call == &exec_key.call)
            })
            .ok_or("actual exec Cell missing")?
            .id;
        let (ordinary_key, ordinary_t1) = self
            .tool(attempt, "ordinary_local", "original-ordinary", json!({}))
            .await?;
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let ordinary = driver
            .prepare_tool(
                &view,
                &view.tools[&tool_key(&ordinary_key)],
                driver.catalog.clone(),
            )
            .await?;
        assert!(matches!(&ordinary.source, DispatchSource::Ordinary));
        let ordinary_released = Arc::new(AtomicBool::new(false));
        self.begin(
            ordinary.tool.effect,
            ordinary_t1,
            ordinary_key,
            ordinary.source,
            self.ordinary.as_ref().unwrap().clone(),
            ordinary_released.clone(),
        )?;
        let wait_input = json!({"cell_id":cell.to_string(),"yield_time_ms":0});
        let (wait_key, wait_t1) = self
            .tool(attempt, "wait", "original-wait", wait_input.clone())
            .await?;
        assert_ne!(wait_key, exec_key);
        let driver = self.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let context = driver.context(&view, &wait_key)?;
        let (wait, source) = self
            .cells
            .as_ref()
            .unwrap()
            .prepare_wait_read_failure(
                context,
                &wait_input,
                driver.catalog.clone(),
                CancellationToken::new(),
            )
            .await?;
        let wait_released = Arc::new(AtomicBool::new(false));
        self.begin(
            wait,
            wait_t1,
            wait_key.clone(),
            source,
            driver.original_effects.clone(),
            wait_released.clone(),
        )?;
        let Err(error) = self.complete().await else {
            return Err("the original wait read must fail once".into());
        };
        assert!(
            matches!(error.downcast_ref::<RunError>(),
            Some(RunError::Tool(ToolError::OutcomeUnknown(message))) if message.contains("native-wait-original-read-once")),
            "{error}"
        );
        let driver = self.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let before = driver.state.frontier(run).await?;
        assert!(
            before.tools[&tool_key(&wait_key)].local_returned.is_none(),
            "no T2 before source ACK"
        );
        assert!(!wait_released.load(Ordering::SeqCst));
        let blocker = BlockerId::new();
        self.append(
            vec![Fact::Blocked {
                blocker,
                reason: BlockerKind::OriginalAdmissionUnknown {
                    tool: wait_key.clone(),
                },
            }],
            vec![],
        )
        .await?;
        self.cells.as_ref().unwrap().coordinator.shutdown().await?;
        let driver = self.driver.as_ref().unwrap();
        driver.workers.close();
        driver.workers.wait().await;
        let proof = self
            .cells
            .as_ref()
            .unwrap()
            .original_cleanup_confirmed()
            .await?;
        assert!(
            proof,
            "original VM/publications/readers must actually close"
        );
        assert!(!self.ordinary.as_ref().unwrap().settle_all(proof).await?);
        assert!(
            !ordinary_released.load(Ordering::SeqCst),
            "Cell proof cannot release an unfinished Ordinary callback"
        );
        self.gate
            .take()
            .unwrap()
            .send(())
            .map_err(|_| "ordinary callback receiver ended")?;
        self.complete().await?;
        assert!(ordinary_released.load(Ordering::SeqCst));
        let owner = self.captured.lock().unwrap().clone().unwrap();
        owner.close().await?;
        assert!(owner.stop.is_cancelled());
        let driver = self.driver.as_ref().unwrap();
        assert!(
            driver.original_effects.settle_all(proof).await?,
            "different waitKey must not remain permanently retained"
        );
        assert!(driver.original_effects.is_empty());
        assert!(wait_released.load(Ordering::SeqCst));
        let final_view = driver.state.frontier(run).await?;
        let wait = &final_view.tools[&tool_key(&wait_key)];
        assert_eq!(
            wait.local_returned.as_ref().unwrap().settlement,
            ToolSettlement::Failed
        );
        assert!(wait.original.is_none());
        assert_eq!(wait.key, wait_key);
        assert!(final_view.blockers[&blocker].resolved_by.is_some());
        final_view.check_effect_admission()?;
        let facts = driver.state.history(run, 0, 1024).await?;
        let returned: Vec<_> = facts
            .iter()
            .filter(|fact| {
                matches!(&fact.fact,
            Fact::LocalToolReturned { tool, .. } if tool == &wait_key)
            })
            .collect();
        assert_eq!(returned.len(), 1);
        assert!(driver.original_effects.settle_all(proof).await?);
        assert_eq!(
            serde_json::to_value(driver.state.history(run, 0, 1024).await?)?,
            serde_json::to_value(facts)?,
            "re-observing ACK preserves the committed original fact IDs and payloads"
        );
        Ok(())
    }

    async fn finish(&mut self) -> Vec<String> {
        let mut errors = Vec::new();
        let mut cells_confirmed = self.cells.is_none();
        if let Some(sender) = self.gate.take() {
            let _ended_receiver = sender.send(());
        }
        while !self.callbacks.is_empty() {
            if let Err(error) = self.complete().await {
                errors.push(format!("original callback: {error}"));
            }
        }
        if let Some(cells) = &self.cells {
            if let Err(error) = cells.coordinator.shutdown().await {
                errors.push(format!("original coordinator: {error}"));
            }
            if let Some(driver) = &self.driver {
                driver.workers.close();
                driver.workers.wait().await;
            }
            match cells.original_cleanup_confirmed().await {
                Ok(proof) => {
                    cells_confirmed = proof;
                    if !proof {
                        errors.push("original Cell cleanup has no ACK".into());
                    }
                    if let Some(driver) = &self.driver {
                        match driver.original_effects.settle_all(proof).await {
                            Ok(true) => {}
                            Ok(false) => errors.push("original wait still retained".into()),
                            Err(error) => errors.push(format!("original wait settlement: {error}")),
                        }
                    }
                    if let Some(ordinary) = &self.ordinary {
                        match ordinary.settle_all(proof).await {
                            Ok(true) => {}
                            Ok(false) => {
                                errors.push("original Ordinary callback still retained".into())
                            }
                            Err(error) => {
                                errors.push(format!("original Ordinary settlement: {error}"))
                            }
                        }
                    }
                }
                Err(error) => errors.push(format!("original Cell proof: {error}")),
            }
        }
        if let Some(call) = &mut self.call
            && let Err(error) = call.close().await
        {
            errors.push(format!("original create call: {error}"));
        }
        if let Some(client) = &mut self.client
            && let Err(error) = client.close().await
        {
            errors.push(format!("Host client: {error}"));
        }
        let originals_closed = self
            .driver
            .as_ref()
            .is_none_or(|driver| driver.original_effects.is_empty())
            && self
                .ordinary
                .as_ref()
                .is_none_or(effects::OriginalEffects::is_empty);
        if cells_confirmed
            && originals_closed
            && let Some(work) = &self.work_effects
        {
            match work.settle().await {
                Ok(()) => {
                    if let Some(lease) = self.lease.take() {
                        lease.finish();
                    }
                }
                Err(error) => errors.push(format!("original work scope: {error}")),
            }
        }
        if let Some(host) = &self.host
            && let Err(error) = host.shutdown().await
        {
            errors.push(format!("Host: {error}"));
        }
        self.stop_serving.cancel();
        if let Some(serving) = self.serving.take() {
            match serving.await {
                Ok(Ok(())) => {}
                result => errors.push(format!("Host listener: {result:?}")),
            }
        }
        if self.lease.is_some() {
            errors.push(
                "Root work pins retained without original settlement ACK; no forced Root shutdown"
                    .into(),
            );
        } else if let Some(store) = &self.store
            && let Err(error) = store.shutdown().await
        {
            errors.push(format!("Root store: {error}"));
        }
        match self.model_listener.accept() {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Ok(_) => errors.push("unexpected connection to the owned model endpoint".into()),
            Err(error) => errors.push(format!("owned model endpoint: {error}")),
        }
        errors
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_wait_read_failure_settles_after_owner_close_without_clearing_ordinary() {
    let mut rig = Rig::new().expect("owned directories");
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.check()))
        .catch_unwind()
        .await;
    let cleanup = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.finish()))
        .catch_unwind()
        .await;
    let primary = match outcome {
        Ok(Ok(Ok(()))) => None,
        Ok(Ok(Err(error))) => Some(error.to_string()),
        Ok(Err(error)) => Some(format!("original observation deadline: {error}")),
        Err(payload) => Some(panic_message(payload.as_ref())),
    };
    let cleanup = match cleanup {
        Ok(Ok(errors)) => errors,
        Ok(Err(error)) => vec![format!(
            "cleanup observation deadline, owners remain in Rig: {error}"
        )],
        Err(payload) => vec![format!(
            "cleanup panic: {}",
            panic_message(payload.as_ref())
        )],
    };
    assert!(
        primary.is_none() && cleanup.is_empty(),
        "original native wait regression: {primary:?}; cleanup companions: {cleanup:?}"
    );
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).into()
    } else {
        "non-string panic payload".into()
    }
}

mod bounded_risk {
    use super::*;
    use maka_agent_facts::{
        artifact::ToolReturn,
        cells::{CellEvent, CellId, CellOwner, CellReply, CellReplyState, CellStatus},
        tool_output::{AcceptedToolResult, DurableToolProjection, ReturnedToolResult, ToolOutput},
    };

    // Typed State fixture only. No interpreter, process identity or physical cleanup ACK.
    async fn start_original_cell(
        rig: &Rig,
        attempt: ModelAttemptId,
    ) -> TestResult<(CellId, ToolKey)> {
        let (parent, _) = rig
            .tool(
                attempt,
                "exec",
                "bounded-cell-parent",
                json!({"code":"logical fixture"}),
            )
            .await?;
        let driver = rig.driver.as_ref().ok_or("fixture driver missing")?;
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let link = AgentStepLink {
            run: view.run,
            step: view.attempts[&attempt].step,
            attempt,
        };
        let cell = CellId::for_agent(link, &parent.call);
        let source = ContentBlob::new(b"logical bounded Cell source".to_vec());
        driver
            .state
            .append(
                driver.access.claim(),
                (&view).into(),
                vec![Change {
                    id: cell.started_fact_id(),
                    at: at(),
                    fact: Fact::Cell {
                        event: CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent {
                                link,
                                call: parent.call.clone(),
                            },
                            source: source.reference().clone(),
                        },
                    },
                }],
                vec![source],
            )
            .await?;
        Ok((cell, parent))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compaction_reuses_background_summary_after_late_cell_return() {
        use maka_agent_engine::{DriverExit, Engine, ports::Preparation};
        use maka_agent_facts::{
            cells::{CellObservation, CellVmBinding, SessionPublication},
            context::{CompactedContext, RequestContextEvidence},
            tool_output::CellFinalEvidence,
        };
        use std::sync::atomic::AtomicUsize;

        let mut rig = Rig::new().unwrap();
        rig.model_overrides = json!({"llama3.2":{"contextWindow":5_000}});
        let stop = CancellationToken::new();
        let posts = Arc::new(AtomicUsize::new(0));
        let listener =
            tokio::net::TcpListener::from_std(rig.model_listener.try_clone().unwrap()).unwrap();
        let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(model_recovery::serve(
            listener,
            posts.clone(),
            stop.clone(),
            Some(requests),
        ));
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
            let session = rig.start().await?;
            rig.assemble_model(
                &session,
                Budget {
                    tokens: None,
                    retries: 0,
                    deadline: None,
                },
                false,
            )
            .await?;
            let driver = rig.driver.as_ref().unwrap();
            let run = driver.access.execution().run_id;
            let (_, main, _) = rig.record_model_request(Preparation::Initial).await?;
            let (cell, parent) = start_original_cell(&rig, main).await?;
            rig.finish_model_request(main, None).await?;
            let completed = ContentBlob::json(&CellObservation::Completed {
                cell_id: cell,
                content: vec![],
                result: json!("completed before the cut"),
            })?;
            let accepted = ContentBlob::json(&AcceptedToolResult::RecoveredCell {
                cell,
                evidence: CellFinalEvidence::Completed {
                    result: completed.reference().clone(),
                },
            })?;
            rig.append(
                vec![
                    Fact::Cell {
                        event: CellEvent::VmBound {
                            cell,
                            binding: CellVmBinding {
                                runtime: "fixture".into(),
                                version: 1,
                                descriptor: completed.reference().clone(),
                            },
                        },
                    },
                    Fact::Cell {
                        event: CellEvent::Completed {
                            cell,
                            result: completed.reference().clone(),
                            publication: SessionPublication {
                                values: Default::default(),
                                loaded_tools: None,
                            },
                        },
                    },
                    Fact::Cell {
                        event: CellEvent::ResultAccepted { cell },
                    },
                    Fact::ToolResultAccepted {
                        tool: parent.clone(),
                        result: accepted.reference().clone(),
                        outcome: AcceptedResult::CellRecovered { cell },
                    },
                ],
                vec![completed, accepted],
            )
            .await?;

            // Snapshot the original tool acceptance before its callback returns.
            let mut summary_cut = driver.state.frontier(run).await?;
            summary_cut.current_step = None;
            let mut summary = driver
                .model()?
                .prepare_step(&summary_cut, Preparation::Summary, driver)
                .await?;
            let summary_body = ContentBlob::json(&summary.request)?;
            summary.contents.push(summary_body.clone());

            let late_text = format!(
                "Late result belongs after the checkpoint. {}",
                "x".repeat(50_000)
            );
            let late = ContentBlob::json(&ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts: vec![],
                body: ReturnedToolResult {
                    output: ToolOutput::Text(late_text.clone()),
                    projection: DurableToolProjection::Text { text: late_text },
                    is_error: false,
                    loaded_tools: Default::default(),
                },
            })?;
            rig.append(
                vec![Fact::LocalToolReturned {
                    tool: parent,
                    settlement: ToolSettlement::Returned,
                    result: late.reference().clone(),
                    is_error: false,
                    cell_observation: None,
                }],
                vec![late],
            )
            .await?;

            let view = driver.state.frontier(run).await?;
            let mut pending = driver
                .model()?
                .prepare_step(
                    &view,
                    Preparation::ToolContinuation { attempt: main },
                    driver,
                )
                .await?;
            let pending_body = ContentBlob::json(&pending.request)?;
            pending.contents.push(pending_body.clone());
            pending.contents.extend(summary.contents);
            let background = ModelAttemptId::new();
            rig.append(
                vec![
                    Fact::StepPrepared {
                        step: pending.request.step,
                        request: pending_body.reference().clone(),
                        adjudications: vec![],
                    },
                    Fact::ProactiveSummaryPrepared {
                        step: summary.request.step,
                        request: summary_body.reference().clone(),
                        attempt: background,
                    },
                    Fact::ModelAttemptAdmitted {
                        attempt: background,
                        upstream: json!({"fixture":"precomputed"}),
                    },
                ],
                pending.contents,
            )
            .await?;
            let provenance: RequestContextEvidence = serde_json::from_slice(
                &driver
                    .state
                    .content(run, pending.request.provenance)
                    .await?,
            )?;
            assert_eq!(
                provenance.model_context.as_ref().unwrap().declared_window,
                Some(4_250)
            );
            assert!(provenance.estimated_input_tokens >= 4_250, "{provenance:?}");
            let summary_text = "Already prepared in the background.";
            rig.finish_model_request(background, Some(summary_text))
                .await?;

            let engine = Engine::new(driver.state.clone());
            let mut changes = driver.state.subscribe()?;
            loop {
                changes.borrow_and_update();
                match engine
                    .drive(
                        driver.access.claim().clone(),
                        driver.clone(),
                        CancellationToken::new(),
                    )
                    .await?
                {
                    DriverExit::Waiting { .. } => changes.changed().await?,
                    DriverExit::Terminal {
                        terminal: Terminal::Completed,
                        ..
                    } => break,
                    other => {
                        let history = driver.state.history(run, 0, 128).await?;
                        let failure = history.iter().rev().find_map(|fact| match &fact.fact {
                            Fact::RunTerminated { diagnostic, .. }
                            | Fact::ModelClosed { diagnostic, .. } => diagnostic.as_deref(),
                            Fact::ModelInterrupted { diagnostic, .. } => Some(diagnostic.as_str()),
                            _ => None,
                        });
                        return Err(format!(
                            "compacted Run did not complete: {other:?}; {failure:?}"
                        )
                        .into());
                    }
                }
            }
            assert_eq!(posts.load(Ordering::SeqCst), 1);
            let wire: Value = serde_json::from_slice(&received.try_recv()?)?;
            let messages = wire["messages"]
                .as_array()
                .ok_or("missing provider messages")?;
            let summary_position = messages
                .iter()
                .position(|message| message.to_string().contains(summary_text))
                .ok_or("background summary missing")?;
            let late_position = messages
                .iter()
                .position(|message| {
                    message
                        .to_string()
                        .contains("Late result belongs after the checkpoint")
                })
                .ok_or("late tool result missing")?;
            assert!(summary_position < late_position);

            let history = driver.state.history(run, 0, 128).await?;
            let [index]: [usize; 1] = history
                .iter()
                .enumerate()
                .filter_map(|(index, fact)| {
                    matches!(fact.fact, Fact::ContextCompacted { .. }).then_some(index)
                })
                .collect::<Vec<_>>()
                .try_into()
                .map_err(|indices: Vec<usize>| {
                    format!("unexpected checkpoint count: {indices:?}")
                })?;
            let Fact::ContextCompacted { baseline } = &history[index].fact else {
                unreachable!()
            };
            let checkpoint: CompactedContext =
                serde_json::from_slice(&driver.state.content(run, baseline.clone()).await?)?;
            assert_eq!(checkpoint.checkpoint.summary_step_id, summary.request.step);
            let Fact::StepPrepared { step, .. } = history[index + 1].fact else {
                return Err("compaction was not followed by prepared Main".into());
            };
            let main = driver.state.request(run, step).await?;
            let provenance: RequestContextEvidence =
                serde_json::from_slice(&driver.state.content(run, main.provenance).await?)?;
            assert_eq!(
                provenance.previous_checkpoint_id,
                Some(history[index].id.to_string())
            );
            driver.state.rebuild(run).await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        stop.cancel();
        server.await.unwrap().unwrap();
        let cleanup = rig.finish().await;
        assert!(cleanup.is_empty(), "{cleanup:?}");
        match result {
            Ok(result) => result.expect("compaction replay timed out").unwrap(),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn running_cell_with_returned_parent(
        rig: &Rig,
        attempt: ModelAttemptId,
    ) -> TestResult<CellId> {
        let (cell, parent) = start_original_cell(rig, attempt).await?;
        let returned = ContentBlob::json(&ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: ReturnedToolResult {
                output: ToolOutput::Cell(Box::new(CellReply {
                    cell,
                    state: CellReplyState::Running,
                    observation: json!({"kind":"running"}),
                })),
                projection: DurableToolProjection::Json {
                    value: json!({"kind":"running"}),
                },
                is_error: false,
                loaded_tools: Default::default(),
            },
        })?;
        let accepted = ContentBlob::json(&AcceptedToolResult::Local {
            result: returned.reference().clone(),
        })?;
        rig.append(
            vec![
                Fact::LocalToolReturned {
                    tool: parent.clone(),
                    settlement: ToolSettlement::Returned,
                    result: returned.reference().clone(),
                    is_error: false,
                    cell_observation: None,
                },
                Fact::ToolResultAccepted {
                    tool: parent,
                    result: accepted.reference().clone(),
                    outcome: AcceptedResult::Succeeded,
                },
            ],
            vec![returned, accepted],
        )
        .await?;
        Ok(cell)
    }

    async fn cancel_unobservable_cell(
        rig: &Rig,
        cell: CellId,
    ) -> TestResult<(BlockerId, RiskDecision)> {
        let blocker = BlockerId::new();
        let decision = RiskDecision::CancelBlockedRun {
            diagnostic: "explicit bounded Cell cancellation".into(),
        };
        rig.append(
            vec![
                Fact::Cell {
                    event: CellEvent::VmCleanupUnconfirmed {
                        cell,
                        binding: None,
                        diagnostic: "logical original VM remains unconfirmed".into(),
                    },
                },
                Fact::Blocked {
                    blocker,
                    reason: BlockerKind::CodeCellRecoveryUnavailable {
                        cell: cell.to_string(),
                    },
                },
                Fact::RiskAdjudicated {
                    blocker,
                    decision: decision.clone(),
                    scope: RiskActionScope::RunCancellation,
                },
            ],
            vec![],
        )
        .await?;
        Ok((blocker, decision))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn original_cell_can_recover_after_authority_and_vm_loss() {
        use maka_agent_facts::cells::CellInterruption;

        let mut rig = Rig::new().expect("owned Cell recovery fixture");
        let result = AssertUnwindSafe(async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            let attempt = rig.attempt().await?;
            let (cell, parent) = start_original_cell(&rig, attempt).await?;
            let blocker = BlockerId::new();
            rig.append(
                vec![
                    Fact::Blocked {
                        blocker,
                        reason: BlockerKind::CodeCellRecoveryUnavailable { cell: cell.to_string() },
                    },
                    Fact::Blocked {
                        blocker: BlockerId::new(),
                        reason: BlockerKind::OriginalAdmissionUnknown { tool: parent.clone() },
                    },
                ],
                vec![],
            )
            .await?;
            let driver = rig.driver.as_ref().ok_or("original driver missing")?;
            let run = driver.access.execution().run_id;
            let engine = maka_agent_engine::Engine::new(driver.state.clone());
            let claim = driver.access.claim();
            let first = engine
                .current_authority_unavailable(
                    claim.clone(),
                    AuthorityStage::WorkspaceScope,
                    "access temporarily unavailable".into(),
                    at(),
                )
                .await?;
            assert!(matches!(
                first,
                maka_agent_engine::DriverExit::Blocked { .. }
            ));
            let report = ContentBlob::json(&CellInterruption {
                cell,
                diagnostic: "the original VM ended".into(),
                children: Default::default(),
                prior_output: None,
            })?;
            rig.append(
                vec![
                    Fact::Cell {
                        event: CellEvent::Interrupted { cell, report: report.reference().clone() },
                    },
                    Fact::ModelCleanupObserved { attempt, cleanup: OperationCleanup::Confirmed },
                ],
                vec![report],
            )
            .await?;
            let observed = driver.state.frontier(run).await?;
            let original = &observed.tools[&tool_key(&parent)];
            assert!(original.local_returned.is_none() && original.accepted.is_none());
            assert!(!observed.has_unsettled_recovery(), "the missing parent return hid its original settled Cell");

            engine
                .current_authority_unavailable(
                    claim.clone(),
                    AuthorityStage::WorkspaceScope,
                    "access still unavailable".into(),
                    at(),
                )
                .await?;
            let recovered = driver.state.frontier(run).await?;
            assert!(recovered.terminal.is_none() && recovered.recovery_failure().is_none());
            assert!(recovered.waiting_for_authority());
            let history = driver.state.history(run, 0, 64).await?;
            assert!(history.iter().any(|fact| matches!(&fact.fact,
                Fact::ToolResultAccepted { tool, outcome: AcceptedResult::CellRecovered { cell: original }, .. }
                    if tool == &parent && *original == cell
            )));
            assert!(matches!(
                recovered.cells[&cell].status,
                CellStatus::Interrupted { .. }
            ));
            assert!(!recovered.cells[&cell].blocks_session_retirement(Some(&Terminal::Failed)));
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })
        .catch_unwind()
        .await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "Cell recovery failed: {result:?}"
        );
        assert!(cleanup.is_empty(), "original Cell cleanup: {cleanup:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retired_cell_cancellation_decision_does_not_reblock_or_confirm_physical_cleanup() {
        let mut rig = Rig::new().expect("owned bounded Cell fixture");
        let mut stage = "setup";
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            let attempt = rig.attempt().await?;
            stage = "cell";
            let cell = running_cell_with_returned_parent(&rig, attempt).await?;
            let (risk, _) = cancel_unobservable_cell(&rig, cell).await?;
            let driver = rig.driver.as_ref().ok_or("bounded Cell driver missing")?;
            let run = driver.access.execution().run_id;
            stage = "bounded_cut";
            let bounded = driver.state.frontier(run).await?;
            assert!(
                bounded.cancelled_by_risk && !bounded.blockers.contains_key(&risk),
                "Cell-only cancellation must survive retirement of its decision row"
            );
            assert!(
                bounded.tools.is_empty(),
                "settled parent leaked into the bounded frontier"
            );
            let original = bounded.cells[&cell].clone();
            assert!(
                matches!(original.status, CellStatus::Running)
                    && original.vm_uncertainty.is_some()
                    && !original.physical_cleanup_confirmed()
            );
            stage = "canonical_drain";
            let exit = maka_agent_engine::Engine::new(driver.state.clone())
                .current_authority_unavailable(
                    driver.access.claim().clone(),
                    AuthorityStage::WorkspaceScope,
                    "bounded cancellation has no current VM ports".into(),
                    at(),
                )
                .await?;
            assert!(
                matches!(
                    exit,
                    maka_agent_engine::DriverExit::Terminal {
                        terminal: Terminal::Cancelled,
                        ..
                    }
                ),
                "retired cancellation decision re-entered Cell observation or blocking"
            );
            let final_view = driver.state.frontier(run).await?;
            assert!(
                final_view.cells[&cell] == original
                    && !final_view.cells[&cell].physical_cleanup_confirmed(),
                "logical cancellation changed original physical Cell evidence"
            );
            assert!(!final_view.blockers.contains_key(&risk));
            assert!(
                final_view.attempts[&attempt].cleanup != OperationCleanup::Confirmed,
                "logical control fabricated the model cleanup ACK"
            );
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "bounded Cell cancellation failed at static stage {stage}: {result:?}"
        );
        assert!(
            cleanup.is_empty(),
            "owned bounded Cell fixture did not settle"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_cancellation_keeps_unrelated_pending_tool_unsettled() {
        let mut rig = Rig::new().expect("owned bounded risk-tool fixture");
        let mut stage = "setup";
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            let attempt = rig.attempt().await?;
            stage = "cell_and_unrelated_tool";
            let cell = running_cell_with_returned_parent(&rig, attempt).await?;
            let (unrelated, _) = rig.tool(attempt, "ordinary_local", "unrelated-pending-tool", json!({})).await?;
            let (risk, decision) = cancel_unobservable_cell(&rig, cell).await?;
            let driver = rig.driver.as_ref().ok_or("bounded risk-tool driver missing")?;
            let run = driver.access.execution().run_id;
            stage = "bounded_cut";
            let bounded = driver.state.frontier(run).await?;
            let kept = bounded.blockers.get(&risk).ok_or("whole-run decision was retired with an unrelated pending tool")?;
            assert!(matches!(&kept.reason, BlockerKind::CodeCellRecoveryUnavailable { cell: id } if id == &cell.to_string()));
            let scoped = kept.decision.as_ref().ok_or("original risk decision missing")?;
            assert!(scoped.decision == decision && matches!(scoped.scope, RiskActionScope::RunCancellation));
            let original_tool = bounded.tools[&tool_key(&unrelated)].clone();
            assert!(original_tool.admitted && original_tool.accepted.is_none()
                && original_tool.original.is_none() && original_tool.local_returned.is_none());
            let original_cell = bounded.cells[&cell].clone();
            stage = "actual_acceptance_and_drain";
            let exit = maka_agent_engine::Engine::new(driver.state.clone()).current_authority_unavailable(
                driver.access.claim().clone(), AuthorityStage::WorkspaceScope,
                "bounded risk-tool cancellation has no current execution ports".into(), at(),
            ).await?;
            assert!(matches!(exit, maka_agent_engine::DriverExit::Terminal { terminal: Terminal::Cancelled, .. }));
            let final_view = driver.state.frontier(run).await?;
            let tool = &final_view.tools[&tool_key(&unrelated)];
            assert!(tool.accepted.is_none() && tool.original.is_none()
                && tool.local_returned.is_none() && tool.prohibited_before_host.is_none(),
                "settling the legacy cancellation fabricated a receipt or a tool result");
            assert!(final_view.cells[&cell] == original_cell && !final_view.cells[&cell].physical_cleanup_confirmed());
            assert!(final_view.attempts[&attempt].cleanup != OperationCleanup::Confirmed);
            assert!(final_view.blockers[&risk] == *kept, "pending original obligation lost its whole-run decision");
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })).catch_unwind().await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "bounded risk-tool cancellation failed at static stage {stage}: {result:?}"
        );
        assert!(
            cleanup.is_empty(),
            "owned bounded risk-tool fixture did not settle"
        );
    }
}

mod source_recovery {
    use super::{model_recovery::call, *};
    use crate::owner::PreparingRun;
    use maka_agent_state::ReadyCause;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_host_retires_with_unconfirmed_cleanup_reported() {
        let mut rig = Rig::new().expect("owned retirement fixture");
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let session = rig.start().await?;
            let owner = rig
                .captured
                .lock()
                .unwrap()
                .clone()
                .ok_or("Native owner missing")?;
            let current = owner.mutable_session(&session).await?;
            let scope = owner
                .current_work_scope(&session, &current.configuration)
                .await?;
            let (lease, effects) = scope.accept(CancellationToken::new());
            effects.settle().await?;
            owner
                .retain_original_preparation(session, lease, None)
                .await;
            rig.client.as_mut().unwrap().close().await?;
            let host = rig.host.as_ref().unwrap();
            let error = host
                .wait_until_idle(Duration::ZERO, Duration::ZERO)
                .await
                .unwrap_err();
            assert!(error.contains("agent_cleanup_unconfirmed"), "{error}");
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })
        .await;
        let cleanup = tokio::time::timeout(Duration::from_secs(10), rig.finish())
            .await
            .unwrap();
        assert!(
            matches!(result, Ok(Ok(()))),
            "idle Host failed to report cleanup: {result:?}"
        );
        assert!(
            cleanup
                .iter()
                .any(|error| error.contains("agent_cleanup_unconfirmed")),
            "{cleanup:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn source_consumed_while_authority_probe_is_busy_is_retried_after_retirement() {
        let mut rig = Rig::new().expect("owned source recovery fixture");
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            let owner = rig
                .captured
                .lock()
                .unwrap()
                .clone()
                .ok_or("actual Native owner missing")?;
            let driver = rig.driver.as_ref().ok_or("original driver missing")?;
            let run = driver.access.execution().run_id;
            let claim = driver.access.claim().clone();
            rig.work_effects
                .as_ref()
                .ok_or("original work effects missing")?
                .settle()
                .await?;
            rig.lease
                .take()
                .ok_or("original work lease missing")?
                .finish();
            let current = owner.mutable_session(&session).await?;
            let directory = crate::workspace::open_workspace(
                &owner.workspace_roots,
                &current.configuration.workspace,
                &owner.managed_worktrees,
            )
            .await?;
            let workspace = owner.store.workspace(directory).await?;
            let exclusive = owner.store.fence_workspace(&workspace).await?;
            let root = owner.store.owned_root()?;
            let mut probe = root.capability_changes();
            let mut scheduler = root.capability_changes();
            probe.borrow_and_update();
            scheduler.borrow_and_update();
            let (sent, received) = oneshot::channel();
            owner.runs.state().await.preparing.insert(
                session.clone(),
                PreparingRun {
                    run,
                    cancellation: CancellationToken::new(),
                    completion: async move { received.await.expect("actual probe cleanup") }
                        .boxed()
                        .shared(),
                },
            );
            // A real exclusive workspace owner blocks the current Native work-scope probe.
            let (failure, cleanup) = owner
                .run_with_capabilities(
                    owner.durable.frontier(run).await?,
                    claim,
                    CancellationToken::new(),
                )
                .await;
            assert!(
                matches!(
                    &failure,
                    Err(RunError::Blocked(reason)) if matches!(reason.as_ref(), BlockerKind::CurrentAuthorityUnavailable { .. })
                ) || matches!(&failure, Ok(maka_agent_engine::DriverExit::Blocked { .. })),
                "actual scope exclusion did not block the capability probe"
            );
            sent.send(cleanup)
                .map_err(|_| "probe completion receiver missing")?;
            assert!(owner.runs.state().await.busy(&session));
            assert!(!probe.has_changed()?, "a failed scope probe self-nudged");
            drop(exclusive);
            scheduler.changed().await?;
            let revision = owner.durable.frontier(run).await?.revision;
            let waits = owner
                .schedule_ready_at(at(), ReadyCause::CapabilitySourceChanged)
                .await?;
            assert!(waits.is_empty(), "busy recovery should not wait for admission");
            assert!(
                owner.runs.state().await.busy(&session),
                "fixture lost the busy overlap"
            );
            assert!(
                owner.durable.frontier(run).await?.revision == revision,
                "busy recovery admitted work"
            );
            assert!(
                owner.finish_local_probe(run, &session, true, None, &probe).await,
                "scheduler-consumed source change was lost when the old probe retired"
            );
            assert!(!owner.runs.state().await.busy(&session));
            probe.borrow_and_update();
            assert!(
                !owner.finish_local_probe(run, &session, true, None, &probe).await,
                "unchanged authority failure must not reintroduce an unconditional retry"
            );
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "busy/source overlap regression failed: {result:?}"
        );
        assert!(
            cleanup.is_empty(),
            "owned source recovery fixture did not settle"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn assessed_stop_can_wake_for_authority_and_unrecoverable_runs_fail() {
        let mut rig = Rig::new().expect("owned Stop recovery fixture");
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            // Canonical control facts only; no model launch, physical ACK or new execution scope.
            let authority = BlockerId::new();
            let blocked_wait = WaitId::new();
            rig.append(
                vec![
                    Fact::Blocked {
                        blocker: authority,
                        reason: BlockerKind::CurrentAuthorityUnavailable {
                            stage: AuthorityStage::WorkspaceScope,
                            diagnostic: "source recovery fixture".into(),
                        },
                    },
                    Fact::WaitRegistered {
                        wait: blocked_wait,
                        reason: WaitReason::Blocker { blocker: authority },
                        due_at: None,
                    },
                    Fact::WaitRegistered {
                        wait: WaitId::new(),
                        reason: WaitReason::Child { run: RunId::new() },
                        due_at: None,
                    },
                ],
                vec![],
            )
            .await?;
            let driver = rig
                .driver
                .as_ref()
                .ok_or("original control driver missing")?;
            let run = driver.access.execution().run_id;
            let client = rig.client.as_ref().ok_or("catalog client missing")?;
            let list = call(
                client,
                "agent",
                "list",
                json!({
                    "filter": "needs_you", "position": {"kind": "start"}
                }),
            )
            .await?;
            assert_eq!(list["sessions"], json!([]));
            assert_eq!(list["needsYouCount"], 0);
            let execution = call(
                client,
                "agent",
                "execution",
                json!({
                    "sessionId": session, "runId": run
                }),
            )
            .await?;
            assert_eq!(execution["execution"]["state"]["kind"], "waiting");
            assert_eq!(
                execution["execution"]["state"]["authorityUnavailable"],
                true
            );
            let owner = driver.state.frontier(run).await?.spec.owner;
            let ordinary = driver
                .state
                .ready_runs(owner.clone(), at(), None, 64)
                .await?;
            assert!(!ordinary.iter().any(|entry| entry.run == run));
            let source = driver
                .state
                .ready_runs_with_cause(
                    owner.clone(),
                    at(),
                    None,
                    64,
                    ReadyCause::CapabilitySourceChanged,
                )
                .await?;
            assert!(
                source.iter().any(|entry| entry.run == run),
                "old Blocker/Child waits hid authority recovery"
            );
            let requested = rig
                .append(
                    vec![Fact::StopRequested {
                        diagnostic: "fixture explicit Stop".into(),
                    }],
                    vec![],
                )
                .await?;
            let request = requested.facts.last().ok_or("Stop request missing")?.id;
            rig.append(vec![Fact::StopAssessed { request }], vec![])
                .await?;
            assert!(
                !driver
                    .state
                    .ready_runs(owner.clone(), at(), None, 64)
                    .await?
                    .iter()
                    .any(|entry| entry.run == run)
            );
            assert!(
                driver
                    .state
                    .ready_runs_with_cause(
                        owner.clone(),
                        at(),
                        None,
                        64,
                        ReadyCause::CapabilitySourceChanged
                    )
                    .await?
                    .iter()
                    .any(|entry| entry.run == run),
                "StopAssessed permanently hid the authority-only Run"
            );
            let reason = BlockerKind::UnsupportedProtocol {
                protocol: "logical-control-fixture".into(),
                version: 1,
            };
            rig.append(
                vec![Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: reason.clone(),
                }],
                vec![],
            )
            .await?;
            assert!(
                driver
                    .state
                    .ready_runs_with_cause(
                        owner,
                        at(),
                        None,
                        64,
                        ReadyCause::CapabilitySourceChanged
                    )
                    .await?
                    .iter()
                    .any(|entry| entry.run == run),
                "source change did not wake the parked Run"
            );
            let exit = maka_agent_engine::Engine::new(driver.state.clone())
                .current_authority_unavailable(
                    driver.access.claim().clone(),
                    AuthorityStage::WorkspaceScope,
                    "control drain has no current execution ports".into(),
                    at(),
                )
                .await?;
            assert!(
                matches!(
                    exit,
                    maka_agent_engine::DriverExit::Terminal {
                        terminal: Terminal::Failed,
                        ..
                    }
                ),
                "unrecoverable run did not settle through the actual Engine"
            );
            assert!(
                driver.state.frontier(run).await?.attempts.is_empty(),
                "control recovery admitted business work"
            );
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "assessed Stop recovery regression failed: {result:?}"
        );
        assert!(
            cleanup.is_empty(),
            "owned Stop recovery fixture did not settle"
        );
    }
}

mod model_recovery {
    mod bot_tools;
    mod discovery;
    mod predictions;
    mod preset_acceptance;
    mod presets;

    use super::*;
    use maka_process::lifetime::{ProcessIdentity, ProcessObservation};
    use std::path::{Path, PathBuf};

    const CHILD_ENV: &str = "MAKA_NATIVE_MODEL_RECOVERY_CHILD";
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Boot {
        deployment: Uuid,
        agent: Uuid,
        settings: Uuid,
        gateway: Uuid,
        #[serde(default)]
        web: Option<Uuid>,
        source: Value,
        base_url: String,
        #[serde(default)]
        replay: bool,
    }
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Frozen {
        session: String,
        run: RunId,
        attempt: ModelAttemptId,
        spec: Value,
        request: Value,
        request_bytes: Vec<u8>,
        provenance_bytes: Vec<u8>,
        upstream: Value,
        facts: Vec<Value>,
    }

    async fn root(base: &Path, create: bool) -> TestResult<Arc<RootStore>> {
        let base = base.to_path_buf();
        let owner = tokio::task::spawn_blocking(move || {
            let namespaces = RootNamespaces {
                ownership: base.join("owners"),
                control: base.join("control"),
            };
            if create {
                std::fs::create_dir_all(base.join("workspace"))?;
                RootOwner::create(&base.join("root"), &namespaces)
            } else {
                RootOwner::open(&base.join("root"), &namespaces)
            }
        })
        .await??;
        let mut migrations = maka_event_log::ROOT_MIGRATIONS.to_vec();
        migrations.extend_from_slice(maka_agent_state::MIGRATIONS);
        migrations.sort_by_key(|migration| migration.version);
        Ok(Arc::new(
            RootStore::open(Arc::new(owner), &migrations).await?,
        ))
    }
    async fn bootstrap(base: &Path, base_url: String, todo: bool) -> TestResult<Boot> {
        bootstrap_with(base, base_url, |config| config["todo"] = json!(todo)).await
    }
    async fn bootstrap_with(
        base: &Path,
        base_url: String,
        configure: impl FnOnce(&mut Value),
    ) -> TestResult<Boot> {
        bootstrap_deployment(base, base_url, false, configure).await
    }
    async fn bootstrap_deployment(
        base: &Path,
        base_url: String,
        with_web: bool,
        configure: impl FnOnce(&mut Value),
    ) -> TestResult<Boot> {
        let mut configuration = json!({
            "permissions": {"access": "read_only", "requestPermissions": false},
            "workspaceRoots": [{"label": "model test", "path": base.join("workspace")}],
            "tools": [],
        });
        if with_web {
            configuration["tools"] = json!([{
                "input":"web","result":"json","confirmation":"preapproved",
                "name":"WebFetch","description":"Fetch a web page.",
                "target":{"kind":"import","name":"web"},"method":"fetch"
            }]);
        }
        configure(&mut configuration);
        let mut boot = Boot {
            deployment: Uuid::new_v4(),
            agent: Uuid::new_v4(),
            settings: Uuid::new_v4(),
            gateway: Uuid::new_v4(),
            web: with_web.then(Uuid::new_v4),
            source: Value::Null,
            base_url,
            replay: false,
        };
        let agent = package(
            "maka.tests.model-agent",
            maka_agent_api::native(),
            BTreeMap::from([
                (
                    "files".into(),
                    Import {
                        contract: maka_workspace_api::files::contract(),
                        cardinality: Cardinality::One,
                    },
                ),
                (
                    "web".into(),
                    Import {
                        contract: maka_web_api::contract(),
                        cardinality: Cardinality::One,
                    },
                ),
            ]),
        )?;
        let files = package(
            "maka.tests.files",
            maka_workspace_api::files::native(),
            BTreeMap::new(),
        )?;
        let web = package("maka.tests.web", maka_web_api::native(), BTreeMap::new())?;
        let settings = package(
            "maka.tests.model-settings",
            maka_settings_native::native(),
            BTreeMap::new(),
        )?;
        let client = package(
            "maka.tests.model-client",
            gateway_native(),
            BTreeMap::from([
                (
                    "web".into(),
                    Import {
                        contract: maka_web_api::contract(),
                        cardinality: Cardinality::One,
                    },
                ),
                (
                    "agent".into(),
                    Import {
                        contract: maka_agent_api::contract(),
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
            ]),
        )?;
        let input = Input {
            base: None,
            ui: None,
            instances: BTreeMap::from([
                (
                    "files".into(),
                    node(
                        Uuid::new_v4(),
                        files.application_ref(),
                        json!({}),
                        BTreeMap::new(),
                    ),
                ),
                (
                    "web".into(),
                    node(
                        boot.web.unwrap_or_else(Uuid::new_v4),
                        web.application_ref(),
                        json!({"network": if with_web { "denied" } else { "allowed" }}),
                        BTreeMap::new(),
                    ),
                ),
                (
                    "agent".into(),
                    node(
                        boot.agent,
                        agent.application_ref(),
                        configuration,
                        ["files", "web"]
                            .into_iter()
                            .map(|name| {
                                (
                                    name.into(),
                                    vec![Target::Instance {
                                        path: vec![name.into()],
                                        export: name.into(),
                                    }],
                                )
                            })
                            .collect(),
                    ),
                ),
                (
                    "settings".into(),
                    node(
                        boot.settings,
                        settings.application_ref(),
                        json!({}),
                        BTreeMap::new(),
                    ),
                ),
                (
                    "client".into(),
                    node(
                        boot.gateway,
                        client.application_ref(),
                        json!({}),
                        BTreeMap::from([
                            (
                                "web".into(),
                                vec![Target::Instance {
                                    path: vec!["web".into()],
                                    export: "web".into(),
                                }],
                            ),
                            (
                                "agent".into(),
                                vec![Target::Instance {
                                    path: vec!["agent".into()],
                                    export: "agent".into(),
                                }],
                            ),
                            (
                                "settings".into(),
                                vec![Target::Instance {
                                    path: vec!["settings".into()],
                                    export: "Settings".into(),
                                }],
                            ),
                        ]),
                    ),
                ),
            ]),
        };
        let store = root(base, true).await?;
        store
            .commit_application(
                boot.deployment,
                0,
                input,
                vec![],
                vec![agent, settings, client, files, web],
            )
            .await?;
        let loaded = store
            .load_application(boot.deployment)
            .await?
            .ok_or("test deployment missing")?;
        boot.source = serde_json::to_value(loaded.source())?;
        store.shutdown().await?;
        Ok(boot)
    }
    async fn attach(rig: &mut Rig, boot: &Boot) -> TestResult<()> {
        let store = root(rig.directory.path(), false).await?;
        let loaded = store
            .load_application(boot.deployment)
            .await?
            .ok_or("original test deployment missing")?;
        assert!(
            serde_json::to_value(loaded.source())? == boot.source,
            "reopen changed original deployment or instance keys"
        );
        if let Some(web) = boot.web {
            rig.native_grants.push(NativeGrant {
                origin: InstanceId(vec![boot.agent]),
                consumer: InstanceId(vec![boot.agent]),
                provider: InstanceId(vec![web]),
                export: maka_web_api::EXPORT.into(),
                methods: ["capture".into()].into(),
                recovery: false,
            });
        }
        rig.attach_host(
            store,
            boot.deployment,
            boot.gateway,
            true,
            boot.replay
                .then_some(replay_observation as crate::model::Observation),
        )
        .await
    }
    pub(super) async fn call(
        client: &HostClient,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> TestResult<Value> {
        call_with_attachments(client, endpoint, method, input, Attachments::new()).await
    }
    async fn call_with_attachments(
        client: &HostClient,
        endpoint: &str,
        method: &str,
        input: Value,
        attachments: Attachments,
    ) -> TestResult<Value> {
        let mut call = client
            .call(endpoint, method.into(), input, attachments)
            .await?;
        call.start().await?;
        let value = match call.receive().await? {
            Reply::Prepared { .. } => {
                let Reply::Mutation { reply, cleanup } = call
                    .confirm(json!({"test":"native-model-recovery"}))
                    .await?
                else {
                    return Err("test mutation did not return its original receipt".into());
                };
                cleanup?;
                let Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    cleanup: OperationCleanup::Confirmed,
                } = &reply.receipt
                else {
                    return Err(format!("{endpoint}.{method}: {:?}", reply.receipt).into());
                };
                value.clone()
            }
            Reply::Finished { result, cleanup } => {
                cleanup?;
                result?
            }
            _ => return Err("unexpected test service reply variant".into()),
        };
        call.close().await?;
        Ok(value)
    }
    async fn facts(state: &Store, run: RunId) -> TestResult<Vec<Value>> {
        let (mut after, mut result) = (0, vec![]);
        loop {
            let page = state.history(run, after, 64).await?;
            if page.is_empty() {
                return Ok(result);
            }
            for fact in page {
                after = fact.revision;
                result.push(serde_json::to_value(fact)?);
            }
        }
    }
    pub(super) async fn serve(
        listener: tokio::net::TcpListener,
        posts: Arc<std::sync::atomic::AtomicUsize>,
        stop: CancellationToken,
        requests: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    ) -> TestResult<()> {
        let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |request: axum::extract::Request| {
        let posts = posts.clone();
            let requests = requests.clone();
        async move {
            posts.fetch_add(1, Ordering::SeqCst);
                let Ok(request) = axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024).await else {
                return (axum::http::StatusCode::BAD_REQUEST, [("content-type","text/event-stream")], String::new());
                };
                if let Some(requests) = requests {
                    requests.send(request.to_vec()).expect("fixture request reader");
            }
            let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"id":"native-cleanup","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Native cleanup retained."},"finish_reason":null}]}),
                json!({"id":"native-cleanup","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}})
            );
            (axum::http::StatusCode::OK, [("content-type","text/event-stream")], body)
        }
    }));
        axum::serve(listener, app)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await?;
        Ok(())
    }

    // This fixture supplies provider observations, not ChatGPT authentication/inventory.
    fn replay_observation(
        binding: &maka_agent_facts::execution::ModelBinding,
        model: &mut maka_agent_ports::provider::Model,
    ) -> maka_agent_facts::context::ModelRequestContext {
        use maka_agent_facts::context::{
            CodexCompatibility, CodexRequestProvenance, ModelOperation, ModelRequestContext,
        };
        model.adapter = "codex-responses".into();
        model.protocol = maka_agent_ports::model::ProviderKind::OpenaiResponses;
        model.provider_options =
            json!({"openai":{"instructions":"Follow the conversation.","store":false}});
        model
            .info
            .capabilities
            .get_or_insert_default()
            .native_compaction = Some(false);
        let source = binding.model == "llama3.2";
        ModelRequestContext {
            operation: ModelOperation::Inference,
            provider_id: "chatgpt".into(),
            codex: Some(CodexRequestProvenance {
                connection_id: binding.connection_id.clone(),
                account_id: Some(if source { "account-a" } else { "account-b" }.into()),
                compatibility: Some(CodexCompatibility {
                    comp_hash: if binding.connection_slug == "replay-different" {
                        "4000"
                    } else {
                        "3000"
                    }
                    .into(),
                    fetched_at: 1,
                }),
            }),
            context_window: Some(128_000),
            model_context_window: Some(128_000),
            declared_window: Some(108_800),
        }
    }

    fn replay_reasoning() -> Value {
        json!({"type":"reasoning","id":"reason-original","encrypted_content":"opaque-original",
            "summary":[{"type":"summary_text","text":"visible summary"}]})
    }

    /// Main Responses conversations use the WebSocket transport: each
    /// `response.create` text frame is one physical request.
    async fn serve_replay(
        listener: tokio::net::TcpListener,
        posts: Arc<std::sync::atomic::AtomicUsize>,
        requests: tokio::sync::mpsc::Sender<Vec<u8>>,
        stop: CancellationToken,
        hold_first: bool,
    ) -> TestResult<()> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{
            Error as WebSocketError, Message, error::ProtocolError,
        };
        let mut connections = tokio::task::JoinSet::<TestResult<()>>::new();
        loop {
            let (socket, _) = tokio::select! {
                _ = stop.cancelled() => break,
                accepted = listener.accept() => accepted?,
            };
            let (posts, requests, stop) = (posts.clone(), requests.clone(), stop.clone());
            connections.spawn(async move {
                let mut socket = tokio::select! {
                    _ = stop.cancelled() => return Ok(()),
                    socket = tokio_tungstenite::accept_async(socket) => socket?,
                };
                loop {
                    let frame = tokio::select! {
                        _ = stop.cancelled() => return Ok(()),
                        frame = socket.next() => frame,
                    };
                    let bytes = match frame {
                        Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        Some(Ok(Message::Close(_))) | None => return Ok(()),
                        Some(Ok(other)) => return Err(format!("unexpected Responses frame: {other:?}").into()),
                        // The source process is deliberately killed after its response.
                        Some(Err(WebSocketError::Protocol(
                            ProtocolError::ResetWithoutClosingHandshake,
                        ))) => return Ok(()),
                        Some(Err(WebSocketError::Io(error)))
                            if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => return Ok(()),
                        Some(Err(error)) => return Err(error.into()),
                    };
                    let index = posts.fetch_add(1, Ordering::SeqCst);
                    requests.send(bytes).await?;
                    if hold_first && index == 0 {
                        continue;
                    }
                    let events = if !hold_first && index == 1 {
                        vec![json!({"type":"error","status":429,"error":{
                            "type":"rate_limit_error","code":"rate_limit_exceeded","message":"retry fixture"}})]
                    } else {
                        let item = if index == 0 {
                            replay_reasoning()
                        } else {
                            json!({"type":"message","id":"answer-target","role":"assistant",
                                "content":[{"type":"output_text","text":"target-answer"}]})
                        };
                        vec![
                            json!({"type":"response.output_item.done","item":item}),
                            json!({"type":"response.completed","response":{
                                "id":format!("response-{index}"),
                                "model":if index == 0 { "llama3.2" } else { "llama3.1" },
                                "output":[item],"usage":{"input_tokens":100,"output_tokens":10}
                            }}),
                        ]
                    };
                    for event in events {
                        socket.send(Message::text(event.to_string())).await?;
                    }
                }
            });
        }
        while let Some(joined) = connections.join_next().await {
            joined??;
        }
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn continue_run_with_web_tools_reaches_the_model() -> TestResult<()> {
        let mut rig = Rig::new()?;
        let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
        let boot = bootstrap_deployment(
            rig.directory.path(),
            format!("http://{}/v1", listener.local_addr()?),
            true,
            |_| {},
        )
        .await?;
        attach(&mut rig, &boot).await?;
        let (requests, mut received) = tokio::sync::mpsc::channel(4);
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post({
                let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
                move |request: axum::extract::Request| {
                    let requests = requests.clone();
                    let index = count.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                            .await
                            .unwrap();
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        requests.send(request).await.unwrap();
                        let (delta, finish) = if index == 0 {
                            (json!({"role":"assistant"}), "length")
                        } else {
                            (json!({"role":"assistant","content":"Continued"}), "stop")
                        };
                        let chunk = json!({
                            "id":format!("continuation-{index}"),"object":"chat.completion.chunk",
                            "created":1,"model":"llama3.2","choices":[{"index":0,"delta":delta,
                            "finish_reason":finish}],
                            "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}
                        });
                        (
                            [("content-type", "text/event-stream")],
                            format!("data: {chunk}\n\ndata: [DONE]\n\n"),
                        )
                    }
                }
            }),
        );
        let stop = CancellationToken::new();
        let shutdown = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
        });
        let result = tokio::time::timeout(Duration::from_secs(25), async {
            let client = rig.client.as_ref().unwrap();
            let tools = call(client, "agent", "tools", json!({})).await?;
            assert!(tools["names"].as_array().unwrap().contains(&json!("WebFetch")));
            let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
            let connection = call(client, "settings", "create", json!({
                "expectedCatalogRevision":catalog["revision"],
                "connection":{"slug":"continuation","name":"Continuation",
                    "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                    "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                    "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
            })).await?;
            assert_eq!(connection["kind"], "committed");
            let connection_id = &connection["connection"]["connectionId"];
            let created = call(client, "agent", "create", json!({
                "title":"Continue a stopped request","automaticTitle":false,"labels":[],
                "workspace":{"kind":"directory","path":rig.directory.path().join("workspace")}
            })).await?;
            let session = created["session"]["id"].as_str().ok_or("session missing")?;
            let sent = call(client, "agent", "send", json!({
                "sessionId":session,"message":"Remember the original prompt.",
                "backend":{"kind":"model","connectionId":connection_id,"modelId":"llama3.2"}
            })).await?;
            assert_eq!(sent["kind"], "queued");
            let _ = received.recv().await.ok_or("original request missing")?;
            let target = json!({"kind":"message","messageId":sent["messageId"]});
            loop {
                let readiness = call(client, "agent", "workReadiness",
                    json!({"sessionId":session,"target":target})).await?;
                match readiness["kind"].as_str() {
                    Some("ready") => break,
                    Some("pending") => tokio::task::yield_now().await,
                    _ => return Err(format!("source Run unavailable: {readiness}").into()),
                }
            }
            let original = call(client, "agent", "work", json!({"sessionId":session,"target":target})).await?;
            let original = &original["execution"];
            assert_eq!(original["state"]["kind"], "failed", "{original}");
            let continued = call(client, "agent", "continueRun", json!({
                "sessionId":session,"sourceRunId":original["runId"],"sourceHighWater":original["highWater"],
                "model":{"connectionId":connection_id,"modelId":"llama3.2"}
            })).await?;
            assert_eq!(continued["kind"], "started", "{continued}");
            assert_ne!(continued["execution"]["runId"], original["runId"]);
            let request = received.recv().await.ok_or("continued model request missing")?;
            assert!(request["messages"].as_array().unwrap().iter().any(|message|
                message["role"] == "user" && message["content"].to_string().contains("Remember the original prompt.")
            ), "{request}");
            let continued_target = json!({"kind":"run","runId":continued["execution"]["runId"]});
            loop {
                let work = call(client, "agent", "work", json!({"sessionId":session,"target":continued_target})).await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("completed") => break,
                    Some("failed" | "cancelled") => return Err(format!("continuation failed: {work}").into()),
                    _ => tokio::task::yield_now().await,
                }
            }
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }).await;
        stop.cancel();
        server.await??;
        let cleanup = rig.finish().await;
        assert!(cleanup.is_empty(), "{cleanup:?}");
        result?
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_run_keeps_native_tools_after_host_replacement() -> TestResult<()> {
        let mut old = Rig::new()?;
        let mut boot = bootstrap_deployment(
            old.directory.path(),
            format!("http://{}/v1", old.model_listener.local_addr()?),
            true,
            |config| {
                config["tools"] = json!([
                    {"name":"ModelList","description":"List models.","result":"json",
                     "confirmation":"preapproved","target":{"kind":"export","name":"agent"},
                     "method":"models"},
                    {"name":"WebStatus","description":"Read web availability.","result":"json",
                     "confirmation":"preapproved","target":{"kind":"import","name":"web"},
                     "method":"capture"}
                ]);
            },
        )
        .await?;
        attach(&mut old, &boot).await?;
        let client = old.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"restart-tools","name":"Restart Tools",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");
        let created = call(
            client,
            "agent",
            "create",
            json!({
                "title":"Restart tool bindings","automaticTitle":false,"labels":[],
                "workspace":{"kind":"directory","path":old.directory.path().join("workspace")}
            }),
        )
        .await?;
        let session = created["session"]["id"].as_str().ok_or("session missing")?;
        let owner = old.captured.lock().unwrap().clone().unwrap();
        // Hold admission on the old Host so the queued request first runs after the reopen.
        owner.runs.state().await.preparing.insert(
            session.into(),
            super::super::super::PreparingRun {
                run: RunId::new(),
                cancellation: CancellationToken::new(),
                completion: futures_util::future::ready(OperationCleanup::Confirmed)
                    .boxed()
                    .shared(),
            },
        );
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Reply with hello.",
            "backend":{"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"}
        })).await;
        owner.stop.cancel();
        owner.producers.close();
        owner.producers.wait().await;
        owner.runs.state().await.preparing.remove(session);
        let sent = sent?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        assert!(owner.durable.latest_run(session.into()).await?.is_none());
        let cleanup = old.finish().await;
        assert!(cleanup.is_empty(), "{cleanup:?}");

        let listener = tokio::net::TcpListener::from_std(old.model_listener.try_clone()?)?;
        let directory =
            std::mem::replace(&mut old.directory, TestDirectory::Borrowed(PathBuf::new()));
        drop(owner);
        drop(old);
        let base = directory.path();
        let store = root(base, false)
            .await
            .map_err(|error| format!("reopen Root for deployment edit: {error}"))?;
        let deployment = store
            .load_application(boot.deployment)
            .await?
            .ok_or("deployment missing")?;
        let mut input = deployment.source().input.clone();
        input
            .instances
            .get_mut("web")
            .unwrap()
            .configuration
            .values
            .insert("network".into(), json!("allowed"));
        store
            .commit_application(
                boot.deployment,
                deployment.source().reference.revision,
                input,
                vec![],
                deployment.packages().to_vec(),
            )
            .await?;
        boot.source = serde_json::to_value(
            store
                .load_application(boot.deployment)
                .await?
                .ok_or("updated deployment missing")?
                .source(),
        )?;
        store.shutdown().await?;
        drop(store);

        let (requests, mut received) = tokio::sync::mpsc::channel(2);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |bytes: axum::body::Bytes| {
                use axum::http::StatusCode;
                let requests = requests.clone();
                let index = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    let request: Value =
                        serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
                    requests
                        .try_send(request)
                        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
                    let (delta, finish) = if index == 0 {
                        (
                            json!({"role":"assistant","tool_calls":[{"index":0,"id":"web-status",
                            "type":"function","function":{"name":"WebStatus","arguments":"{}"}}]}),
                            "tool_calls",
                        )
                    } else {
                        (json!({"role":"assistant","content":"Hello"}), "stop")
                    };
                    let chunk = |delta: Value, finish: Value| {
                        json!({
                            "id":format!("after-restart-{index}"),"object":"chat.completion.chunk",
                            "created":1,"model":"llama3.2",
                            "choices":[{"index":0,"delta":delta,"finish_reason":finish}]
                        })
                    };
                    Ok::<_, StatusCode>((
                        [("content-type", "text/event-stream")],
                        format!(
                            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            chunk(delta, Value::Null),
                            chunk(json!({}), json!(finish))
                        ),
                    ))
                }
            }),
        );
        let mut new = Rig::new()?;
        new.directory = TestDirectory::Borrowed(base.into());
        let stop = CancellationToken::new();
        let shutdown = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
        });
        let result = tokio::time::timeout(Duration::from_secs(25), async {
            attach(&mut new, &boot)
                .await
                .map_err(|error| format!("attach replacement Host: {error}"))?;
            let request = received
                .recv()
                .await
                .ok_or("restored model request missing")?;
            for name in ["ModelList", "WebStatus"] {
                if !request["tools"]
                    .as_array()
                    .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name))
                {
                    return Err(
                        format!("{name} missing from the restored request: {request}").into(),
                    );
                }
            }
            let response = received.recv().await.ok_or("tool result request missing")?;
            let result = response["messages"]
                .as_array()
                .ok_or("model request has no messages")?
                .iter()
                .find(|message| {
                    message["role"] == "tool" && message["tool_call_id"] == "web-status"
                })
                .ok_or("WebStatus result missing")?;
            let capture: Value = serde_json::from_str(
                result["content"]
                    .as_str()
                    .ok_or("WebStatus result is not text")?,
            )?;
            if capture
                != json!({
                    "basis": {"revision": null, "credentialRevision": null},
                    "available": false,
                    "source": "model",
                    "credentialConfigured": false
                })
            {
                return Err(format!("unexpected WebStatus result: {capture}").into());
            }
            completed_message(new.client.as_ref().unwrap(), session, &sent["messageId"]).await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })
        .await;
        stop.cancel();
        server.await??;
        let cleanup = new.finish().await;
        assert!(cleanup.is_empty(), "{cleanup:?}");
        result?
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupted_empty_model_stream_retries_the_same_run() -> TestResult<()> {
        let mut rig = Rig::new()?;
        let session = rig
            .start_configured(Some(replay_observation), |_| {})
            .await?;
        rig.assemble_model(
            &session,
            Budget {
                tokens: None,
                retries: 1,
                deadline: None,
            },
            false,
        )
        .await?;
        let (requests, mut received) = tokio::sync::mpsc::channel(4);
        let stop = CancellationToken::new();
        let wire = tokio::spawn(serve_replay(
            tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?,
            Arc::default(),
            requests,
            stop.clone(),
            true,
        ));
        let driver = rig.driver.as_ref().ok_or("test driver missing")?.clone();
        let run = driver.access.execution().run_id;
        let cancel = CancellationToken::new();
        let outcome = tokio::time::timeout(Duration::from_secs(30), async {
            let drive = async {
                let engine = maka_agent_engine::Engine::new(driver.state.clone());
                loop {
                    let exit = engine
                        .drive(
                            driver.access.claim().clone(),
                            driver.clone(),
                            cancel.clone(),
                        )
                        .await?;
                    if !matches!(exit, maka_agent_engine::DriverExit::Waiting { .. }) {
                        return Ok::<_, RunError>(exit);
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            let interrupt = async {
                received.recv().await.ok_or("original request missing")?;
                let first = driver
                    .state
                    .frontier(run)
                    .await?
                    .current_attempt
                    .ok_or("original attempt missing")?;
                driver.model()?.cancel_model(run, first).await?;
                Ok::<_, Box<dyn Error + Send + Sync>>(first)
            };
            let (exit, first) = tokio::join!(drive, interrupt);
            let view = driver.state.frontier(run).await?;
            let first = first?;
            let last = view.current_attempt.ok_or("retry attempt missing")?;
            let exit = exit?;
            assert!(
                matches!(
                    exit,
                    maka_agent_engine::DriverExit::Terminal {
                        terminal: Terminal::Completed,
                        ..
                    }
                ),
                "interrupted empty model stream returned {exit:?}"
            );
            assert_ne!(first, last);
            assert_eq!(view.attempts[&first].step, view.attempts[&last].step);
            assert_eq!(view.attempts.len(), 2);
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })
        .await;
        cancel.cancel();
        stop.cancel();
        wire.await??;
        assert!(rig.finish().await.is_empty());
        outcome?
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recorded_encrypted_replay_survives_root_reopen_and_physical_retry() {
        for (slug, expected) in [("replay-same", true), ("replay-different", false)] {
            let mut rig = Rig::new().expect("owned replay directories");
            let mut child: Option<tokio::process::Child> = None;
            let stop = CancellationToken::new();
            let posts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (requests_tx, mut requests_rx) = tokio::sync::mpsc::channel(4);
            let mut wire: Option<JoinHandle<TestResult<()>>> = None;
            let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
                let base = rig.directory.path().to_path_buf();
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
                let mut boot = bootstrap(&base, format!("http://{}/v1", listener.local_addr()?), false).await?;
                boot.replay = true;
                wire = Some(tokio::spawn(serve_replay(
                    listener, posts.clone(), requests_tx, stop.clone(), false,
                )));
                let path = base.join("boot.json");
                tokio::fs::write(&path, serde_json::to_vec(&boot)?).await?;
                let child_test = format!("{}::model_reader_child",
                    module_path!().split_once("::").ok_or("test module missing")?.1);
                child = Some(tokio::process::Command::new(std::env::current_exe()?)
                    .args(["--exact", &child_test, "--nocapture"]).env(CHILD_ENV, &path)
                    .env("MAKA_TEST_MODEL_CLEANUP_BARRIER", base.join("closed"))
                    .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                    .kill_on_drop(true).spawn()?);
                let pid = child.as_ref().and_then(|child| child.id()).ok_or("owned child PID missing")?;
                let identity = tokio::task::spawn_blocking(move || ProcessIdentity::capture(pid)).await??;
                while !tokio::fs::try_exists(base.join("frozen.json")).await? {
                    if child.as_mut().ok_or("owned child missing")?.try_wait()?.is_some() {
                        return Err("replay child ended before its durable model closure".into());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let frozen: Frozen = serde_json::from_slice(&tokio::fs::read(base.join("frozen.json")).await?)?;
                let original_identity: ProcessIdentity =
                    serde_json::from_value(frozen.upstream["nativeReader"]["process"].clone())?;
                assert!(identity == original_identity, "source model did not belong to the owned child");
                let source_wire: Value = serde_json::from_slice(
                    &requests_rx.recv().await.ok_or("source WebSocket request missing")?,
                )?;
                assert_eq!(source_wire["type"], "response.create");
                assert_eq!(source_wire["model"], "llama3.2");
                assert!(source_wire.to_string().contains("question-source"));
                let owned = child.as_mut().ok_or("owned child missing")?;
                owned.start_kill()?;
                assert!(!owned.wait().await?.success(), "owned child was not killed");
                child = None;
                let gone = tokio::task::spawn_blocking(move || maka_process::lifetime::observe(&identity)).await??;
                assert!(matches!(gone, ProcessObservation::Gone(ref proof) if proof.identity() == &original_identity));

                attach(&mut rig, &boot).await?;
                let client = rig.client.as_ref().ok_or("reopened client missing")?;
                loop {
                    let work = call(client, "agent", "work", json!({
                        "sessionId":frozen.session,"target":{"kind":"run","runId":frozen.run}
                    })).await?;
                    if work["execution"]["state"]["kind"] == "completed" { break; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let owner = rig.captured.lock().unwrap().clone().ok_or("reopened Native owner missing")?;
                let view = owner.durable.frontier(frozen.run).await?;
                let original = &view.attempts[&frozen.attempt];
                assert!(view.terminal == Some(Terminal::Completed)
                    && original.cleanup == OperationCleanup::Confirmed);
                assert!(serde_json::to_value(&view.spec)? == frozen.spec
                    && view.current_attempt == Some(frozen.attempt));
                let request = owner.durable.request(frozen.run, original.step).await?;
                assert_eq!(serde_json::to_value(&request)?, frozen.request);
                assert_eq!(owner.durable.content(frozen.run, request.request.clone()).await?, frozen.request_bytes);
                assert_eq!(owner.durable.content(frozen.run, request.provenance.clone()).await?, frozen.provenance_bytes);
                let provenance: maka_agent_facts::context::RequestContextEvidence =
                    serde_json::from_slice(&frozen.provenance_bytes)?;
                let producer = provenance.model_context.and_then(|context| context.codex)
                    .ok_or("normal source preparation did not record provider observation")?;
                assert_eq!(request.accounting.model_id, "llama3.2");
                assert_eq!(producer.account_id.as_deref(), Some("account-a"));
                assert_eq!(producer.compatibility.as_ref().map(|value| value.comp_hash.as_str()), Some("3000"));
                assert_eq!(posts.load(Ordering::SeqCst), 1, "source recovery must not resend its request");
                assert!(facts(&owner.durable, frozen.run).await?.starts_with(&frozen.facts));

                let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
                let connection = call(client, "settings", "create", json!({
                    "expectedCatalogRevision":catalog["revision"],
                    "connection":{"slug":slug,"name":slug,
                        "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                        "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.1"],
                        "modelOverrides":{"llama3.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
                })).await?;
                assert_eq!(connection["kind"], "committed");
                let models = call(client, "agent", "models", json!({"kind":"start"})).await?;
                let selection = models["choices"].as_array().ok_or("target model choices missing")?
                    .iter().find(|choice| choice["selection"]["connectionId"] == connection["connection"]["connectionId"]
                        && choice["selection"]["modelId"] == "llama3.1")
                    .ok_or("target model not selectable")?["selection"].clone();
                let sent = call(client, "agent", "send", json!({
                    "sessionId":frozen.session,"message":"question-target","backend":selection,"delivery":"queue"
                })).await?;
                assert_eq!(sent["kind"], "queued");
                let target_run: RunId = loop {
                    let work = call(client, "agent", "work", json!({
                        "sessionId":frozen.session,"target":{"kind":"message","messageId":sent["messageId"]}
                    })).await?;
                    if work["execution"]["state"]["kind"] == "completed" {
                        break serde_json::from_value(work["execution"]["runId"].clone())?;
                    }
                    if work["execution"]["state"]["kind"] == "failed" {
                        return Err(format!("target inference failed: {work}").into());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                };
                assert!(target_run != frozen.run, "normal new send reused the completed source Run");
                let first = requests_rx.recv().await.ok_or("target WebSocket request missing")?;
                let retry = requests_rx.recv().await.ok_or("429 physical retry missing")?;
                assert_eq!(first, retry, "physical retry changed frozen opaque replay bytes");
                let sent: Value = serde_json::from_slice(&first)?;
                assert_eq!(sent["model"], "llama3.1");
                let items = sent["input"].as_array().ok_or("Responses input missing")?;
                assert_eq!(items.contains(&replay_reasoning()), expected, "{slug}: {sent}");
                let body = sent.to_string();
                assert!(body.contains("question-source") && body.contains("question-target"),
                    "history replay lost a user boundary: {sent}");
                if !expected {
                    assert!(!body.contains("opaque-original"), "incompatible encrypted state leaked: {sent}");
                }
                let target = owner.durable.frontier(target_run).await?;
                let current = &target.attempts[&target.current_attempt.ok_or("target attempt missing")?];
                let target_request = owner.durable.request(target_run, current.step).await?;
                let target_context: maka_agent_facts::context::RequestContextEvidence =
                    serde_json::from_slice(&owner.durable.content(target_run, target_request.provenance.clone()).await?)?;
                let target_codex = target_context.model_context.and_then(|context| context.codex)
                    .ok_or("target provider observation not recorded")?;
                assert_eq!(target_codex.account_id.as_deref(), Some("account-b"));
                assert_ne!(target_codex.connection_id, producer.connection_id);
                assert_eq!(target_codex.compatibility.as_ref().map(|value| value.comp_hash.as_str()),
                    Some(if expected { "3000" } else { "4000" }));
                assert_eq!(owner.durable.content(frozen.run, request.provenance.clone()).await?, frozen.provenance_bytes);
                assert_eq!(posts.load(Ordering::SeqCst), 3, "unexpected provider dispatch outside source + target + retry");
                Ok::<_, Box<dyn Error + Send + Sync>>(())
            })).catch_unwind().await;
            if let Some(mut owned) = child {
                let _ = owned.kill().await;
                let _ = owned.wait().await;
            }
            drop(requests_rx);
            stop.cancel();
            let wire_result = match wire {
                Some(task) => Some(task.await),
                None => None,
            };
            let cleanup =
                AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.finish()))
                    .catch_unwind()
                    .await;
            assert!(
                matches!(result, Ok(Ok(Ok(())))),
                "encrypted replay failed for {slug}: {result:?}"
            );
            assert!(
                matches!(wire_result, None | Some(Ok(Ok(())))),
                "replay WebSocket fixture did not settle: {wire_result:?}"
            );
            assert!(
                matches!(cleanup, Ok(Ok(ref errors)) if errors.is_empty()),
                "replay fixture did not physically settle"
            );
        }
    }

    // Only this fixture uses the counter; capture changes at the actual HTTP boundary.
    static GROUPING_REQUESTS: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    fn grouping_observation(
        binding: &maka_agent_facts::execution::ModelBinding,
        model: &mut maka_agent_ports::provider::Model,
    ) -> maka_agent_facts::context::ModelRequestContext {
        let mut context = replay_observation(binding, model);
        model.adapter = "chat-completions".into();
        model.protocol = maka_agent_ports::model::ProviderKind::OpenaiCompatible {
            name: "deepseek".into(),
        };
        model.provider_options = json!({"maka":{"openAiChatReasoningField":"reasoning_content"}});
        model.info.capabilities.get_or_insert_default().reasoning = Some(true);
        if binding.connection_slug == "batch-source"
            && GROUPING_REQUESTS.load(Ordering::SeqCst) == 0
        {
            context
                .codex
                .as_mut()
                .expect("fixture Codex observation")
                .compatibility = None;
        }
        context
    }

    async fn serve_grouped_reasoning(
        listener: tokio::net::TcpListener,
        requests: tokio::sync::mpsc::Sender<Value>,
        stop: CancellationToken,
    ) -> TestResult<()> {
        use axum::response::IntoResponse;
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |request: axum::extract::Request| {
                let requests = requests.clone();
                async move {
                    let bytes = match axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024).await {
                        Ok(bytes) => bytes,
                        Err(_) => return axum::http::StatusCode::BAD_REQUEST.into_response(),
                    };
                    let value: Value = match serde_json::from_slice(&bytes) {
                        Ok(value) => value,
                        Err(_) => return axum::http::StatusCode::BAD_REQUEST.into_response(),
                    };
                    let index = GROUPING_REQUESTS.fetch_add(1, Ordering::SeqCst);
                    if requests.send(value).await.is_err() {
                        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
                    }
                    let (delta, finish) = if index < 2 {
                        let n = index + 1;
                        (json!({"role":"assistant","reasoning_content":format!("thinking-{n}"),
                            "content":format!("visible-{n}"),"tool_calls":[{
                                "index":0,"id":format!("todo-call-{n}"),"type":"function",
                                "function":{"name":"todo_read","arguments":"{}"}
                            }]}), "tool_calls")
                    } else {
                        (json!({"role":"assistant","content":
                            if index == 2 { "source-finished" } else { "target-finished" }}), "stop")
                    };
                    let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"id":format!("batch-{index}"),"object":"chat.completion.chunk",
                            "created":1,"model":if index < 3 { "llama3.2" } else { "llama3.1" },
                            "choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                        json!({"id":format!("batch-{index}"),"object":"chat.completion.chunk",
                            "created":1,"model":if index < 3 { "llama3.2" } else { "llama3.1" },
                            "choices":[{"index":0,"delta":{},"finish_reason":finish}],
                            "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}})
                    );
                    (axum::http::StatusCode::OK, [("content-type", "text/event-stream")], body)
                        .into_response()
                }
            }),
        );
        axum::serve(listener, app)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delegated_task_attention_is_delivered_once_and_completion_still_follows() {
        delegated_notifications("stop").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delegated_notifications_survive_caller_failure_before_consumption() {
        delegated_notifications("length").await;
    }

    async fn delegated_notifications(caller_finish: &'static str) {
        use maka_agent_facts::interaction::{InteractionOutcome, InteractionRecord};
        use maka_plugin_core::contract::ServiceTarget;
        let mut rig = Rig::new().unwrap();
        let stop = CancellationToken::new();
        let (requests, mut observed) = tokio::sync::mpsc::channel(4);
        let mut wire = None;
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
            let base = rig.directory.path().to_path_buf();
            let boot = bootstrap(&base, format!("http://{}/v1", listener.local_addr()?), false).await?;
            let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(
                move |request: axum::extract::Request| {
                    let requests = requests.clone();
                    async move {
                        let body = axum::body::to_bytes(request.into_body(), usize::MAX).await.unwrap();
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        let (reply, response) = oneshot::channel::<(&'static str, &'static str)>();
                        requests.send((request, reply)).await.unwrap();
                        let (text, finish) = response.await.unwrap();
                        let body = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            json!({"id":"delegation","object":"chat.completion.chunk","created":1,"model":"llama3.2",
                                "choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]}),
                            json!({"id":"delegation","object":"chat.completion.chunk","created":1,"model":"llama3.2",
                                "choices":[{"index":0,"delta":{},"finish_reason":finish}],
                                "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}));
                        ([("content-type", "text/event-stream")], body)
                    }
                }));
            let shutdown = stop.clone();
            wire = Some(tokio::spawn(async move {
                axum::serve(listener, app).with_graceful_shutdown(shutdown.cancelled_owned()).await
            }));
            rig.attach_host(root(&base, false).await?, boot.deployment, boot.gateway, true, None).await?;
            let client = rig.client.as_ref().unwrap();
            let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
            let connection = call(client, "settings", "create", json!({
                "expectedCatalogRevision":catalog["revision"],
                "connection":{"slug":"delegation", "name":"delegation",
                    "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                    "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                    "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
            })).await?;
            assert_eq!(connection["kind"], "committed");
            let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
            let mut sessions = Vec::new();
            for title in ["Caller", "Worker"] {
                let created = call(client, "agent", "create", json!({
                    "title":title,"automaticTitle":false,"labels":[],"tools":[],
                    "workspace":{"kind":"directory","path":base.join("workspace")}
                })).await?;
                assert_eq!(created["kind"], "created");
                sessions.push(created["session"]["id"].as_str().ok_or("session missing")?.to_owned());
            }
            let caller = &sessions[0];
            let worker = &sessions[1];
            let sent = call(client, "agent", "send", json!({
                "sessionId":caller,"message":"Delegate the work, then rest.","backend":backend
            })).await?;
            assert_eq!(sent["kind"], "queued");
            let (_, caller_reply) = observed.recv().await.ok_or("caller HTTP request missing")?;
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let access = owner.runs.state().await.controls.get(caller)
                .and_then(|control| control.access.upgrade()).ok_or("caller access missing")?;
            let services = owner.services.select_method(&ServiceTarget::Export {name:"agent".into()}, "send")?;
            let request = services.request_with_work(
                maka_capabilities::call::Identity::Agent {execution:access.execution().clone(),operation_id:None},
                CancellationToken::new(), access.custody().clone())?;
            let completed = request.begin_mutation_target(&ServiceTarget::Export {name:"agent".into()},
                "send".into(), json!({"sessionId":worker,"message":"Do the delegated task.","backend":backend,
                    "onComplete":"notify_caller"}), Uuid::new_v4(), json!({"test":"delegated-completion"}),
                Attachments::new())?.await?.completion().await;
            completed.cleanup?;
            request.finish().await?;
            let receipt = completed.reply;
            let Receipt::Recorded {outcome:OperationOutcome::Returned {
                result:OperationResult::Success {value:delegated}}, cleanup:OperationCleanup::Confirmed} = receipt.receipt else {
                return Err(format!("delegation did not commit: {:?}", receipt.receipt).into());
            };
            assert_eq!(delegated["kind"], "queued");
            assert_eq!(delegated["completion"], "registered");
            let (_, worker_reply) = observed.recv().await.ok_or("worker HTTP request missing")?;
            let caller_run = access.execution().run_id;
            drop(request);
            drop(access);

            let caller_reply = if caller_finish == "length" {
                // Settle failure before the worker asks for attention. A notice
                // delivered earlier may now legitimately interrupt the model
                // and continue the same Run before its length limit is observed.
                let mut changes = owner.durable.subscribe()?;
                caller_reply.send(("The task is delegated.", caller_finish)).unwrap();
                loop {
                    changes.borrow_and_update();
                    if let Some(terminal) = owner.durable.frontier(caller_run).await?.terminal {
                        assert_eq!(terminal, Terminal::Failed);
                        break;
                    }
                    changes.changed().await?;
                }
                None
            } else {
                Some(caller_reply)
            };

            let worker_access = owner.runs.state().await.controls.get(worker)
                .and_then(|control| control.access.upgrade()).ok_or("worker access missing")?;
            let worker_run = worker_access.execution().run_id;
            let view = owner.durable.frontier(worker_run).await?;
            let question = InteractionRecord {
                execution:worker_access.execution().clone(),request_id:"delegated-question".into(),created_at:now(),
                request:serde_json::from_value(json!({"kind":"question","toolUseId":"delegated-question-tool",
                    "questions":[{"question":"Which result do you need?","options":[{"label":"Brief"},{"label":"Detailed"}]}]}))?,
                outcome:None,
            };
            owner.durable.interactions().establish(worker_access.claim(), (&view).into(), question, None, vec![]).await?;
            owner.deliver_completions().await?;
            if let Some(caller_reply) = caller_reply {
                caller_reply.send(("The task is delegated.", caller_finish)).unwrap();
            }
            let (attention, attention_reply) = observed.recv().await.ok_or("attention HTTP request missing")?;
            let messages = serde_json::to_string(attention["messages"].as_array()
                .and_then(|messages| messages.iter().rev().find(|message| message["role"] == "user"))
                .ok_or("attention user message missing")?)?;
            assert!(messages.contains("needs attention") && messages.contains("delegated-question"), "{messages}");
            let attention_run = owner.durable.latest_run(caller.clone()).await?.ok_or("attention Run missing")?;
            assert_eq!(attention_run == caller_run, caller_finish == "stop");
            if caller_finish == "length" {
                assert_eq!(owner.durable.frontier(caller_run).await?.terminal, Some(Terminal::Failed));
            }
            for _ in 0..2 { owner.deliver_completions().await?; }
            let queue = call(client, "agent", "queue", json!({"sessionId":caller})).await?;
            assert_eq!(queue["entries"], json!([]), "the same pending question was queued again");
            assert_eq!(owner.durable.latest_run(caller.clone()).await?, Some(attention_run));
            owner.durable.interactions().commit_outcome(worker, "delegated-question",
                InteractionOutcome::QuestionAnswer {answers:vec![Some("Brief".into())],committed_at:now()}).await?;
            worker_reply.send(("Delegated task completed.", "stop")).unwrap();
            completed_message(client, worker, &delegated["messageId"]).await?;
            owner.deliver_completions().await?;
            attention_reply.send(("I have seen the pending question.", "stop")).unwrap();
            let (completion, completion_reply) = observed.recv().await.ok_or("completion HTTP request missing")?;
            let messages = serde_json::to_string(completion["messages"].as_array()
                .and_then(|messages| messages.iter().rev().find(|message| message["role"] == "user"))
                .ok_or("completion user message missing")?)?;
            assert!(messages.contains("ended with status completed") && messages.contains(delegated["messageId"].as_str().unwrap()), "{messages}");
            let final_run = owner.durable.latest_run(caller.clone()).await?.ok_or("completion Run missing")?;
            assert_eq!(final_run == caller_run, caller_finish == "stop");
            let final_view = owner.durable.frontier(final_run).await?;
            let Trigger::Message {message_id} = final_view.spec.trigger else {return Err("completion trigger missing".into())};
            completion_reply.send(("The delegated result is ready.", "stop")).unwrap();
            quiescent_message(client, caller, &json!(message_id)).await?;
            owner.deliver_completions().await?;
            let queue = call(client, "agent", "queue", json!({"sessionId":caller})).await?;
            assert_eq!(queue["entries"], json!([]));
            assert_eq!(owner.durable.latest_run(caller.clone()).await?, Some(final_run));
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }).await;
        stop.cancel();
        let cleanup = rig.finish().await;
        if let Some(wire) = wire {
            wire.await.unwrap().unwrap();
        }
        assert!(cleanup.is_empty(), "{cleanup:?}");
        result
            .expect("delegated notification fixture timed out")
            .unwrap();
    }

    async fn quiescent_message(
        client: &HostClient,
        session: &str,
        message: &Value,
    ) -> TestResult<RunId> {
        loop {
            let readiness = call(
                client,
                "agent",
                "workReadiness",
                json!({
                    "sessionId":session,"target":{"kind":"message","messageId":message}
                }),
            )
            .await?;
            match readiness["kind"].as_str() {
                Some("ready") => return completed_message(client, session, message).await,
                Some("pending") => tokio::task::yield_now().await,
                _ => return Err(format!("fixture work unavailable: {readiness}").into()),
            }
        }
    }

    pub(super) async fn completed_message(
        client: &HostClient,
        session: &str,
        message: &Value,
    ) -> TestResult<RunId> {
        loop {
            let work = call(
                client,
                "agent",
                "work",
                json!({
                    "sessionId":session,"target":{"kind":"message","messageId":message}
                }),
            )
            .await?;
            match work["execution"]["state"]["kind"].as_str() {
                Some("completed") => {
                    return Ok(serde_json::from_value(work["execution"]["runId"].clone())?);
                }
                Some("failed" | "cancelled") => {
                    return Err(format!("fixture Run failed: {work}").into());
                }
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }

    #[test]
    fn tail_replay_keeps_reasoning_with_tool_calls_and_resets_the_step_producer() {
        const CHILD: &str = "MAKA_TEST_DEFAULT_STACK_REPLAY";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "tail_replay_keeps_reasoning_with_tool_calls_and_resets_the_step_producer",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env_remove("RUST_MIN_STACK")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_stack_size(2 * 1024 * 1024)
            .enable_all()
            .build()
            .unwrap()
            .block_on(tail_replay());
    }

    async fn tail_replay() {
        use maka_agent_engine::preparation;
        use maka_agent_facts::{
            context::RequestContextEvidence,
            model::prompt_source::source::{
                AssistantRecipe, MessageRecipe, ReplayOrigin, json as source_json,
            },
        };
        GROUPING_REQUESTS.store(0, Ordering::SeqCst);
        let mut rig = Rig::new().expect("owned grouping fixture");
        let stop = CancellationToken::new();
        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::channel(4);
        let mut wire: Option<JoinHandle<TestResult<()>>> = None;
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
            let base = rig.directory.path().to_path_buf();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
            let boot = bootstrap(&base, format!("http://{}/v1", listener.local_addr()?), true).await?;
            wire = Some(tokio::spawn(serve_grouped_reasoning(listener, requests_tx, stop.clone())));
            rig.attach_host(root(&base, false).await?, boot.deployment, boot.gateway, true,
                Some(grouping_observation)).await?;
            let client = rig.client.as_ref().ok_or("Host client missing")?;
            let mut selections = Vec::new();
            for (slug, model) in [("batch-source", "llama3.2"), ("batch-target", "llama3.1")] {
                let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
                let connection = call(client, "settings", "create", json!({
                    "expectedCatalogRevision":catalog["revision"],
                    "connection":{"slug":slug,"name":slug,
                        "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                        "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":[model],
                        "modelOverrides":{(model):{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
                })).await?;
                assert_eq!(connection["kind"], "committed");
                let models = call(client, "agent", "models", json!({"kind":"start"})).await?;
                let selection = models["choices"].as_array().ok_or("model choices missing")?
                    .iter().find(|choice| choice["selection"]["connectionId"]
                        == connection["connection"]["connectionId"])
                    .ok_or("fixture model not selectable")?["selection"].clone();
                selections.push(selection);
            }
            let created = call(client, "agent", "create", json!({
                "title":"Reasoning and tool-call grouping","automaticTitle":false,
                "labels":[],"tools":["todo_read"],
                "workspace":{"kind":"directory","path":base.join("workspace")}
            })).await?;
            assert_eq!(created["kind"], "created", "{created}");
            let session = created["session"]["id"].as_str().ok_or("session missing")?.to_owned();
            let source = call(client, "agent", "send", json!({
                "sessionId":session,"message":"Use the checklist twice.",
                "backend":selections[0],"delivery":"queue"
            })).await?;
            assert_eq!(source["kind"], "queued");
            let source_run = completed_message(client, &session, &source["messageId"]).await?;
            let target = call(client, "agent", "send", json!({
                "sessionId":session,"message":"Continue from the recorded tool outcomes.",
                "backend":selections[1],"delivery":"queue"
            })).await?;
            assert_eq!(target["kind"], "queued");
            let target_run = completed_message(client, &session, &target["messageId"]).await?;
            assert_ne!(source_run, target_run);

            let mut sent = Vec::new();
            for _ in 0..4 {
                sent.push(requests_rx.recv().await.ok_or("HTTP request missing")?);
            }
            assert_eq!(GROUPING_REQUESTS.load(Ordering::SeqCst), 4);
            assert_eq!(sent[3]["model"], "llama3.1");
            let messages = sent[3]["messages"].as_array().ok_or("ChatCompletions messages missing")?;
            let mut previous_result = None;
            for n in 1..=2 {
                let id = format!("todo-call-{n}");
                let calls: Vec<_> = messages.iter().enumerate().filter(|(_, message)| {
                    message["role"] == "assistant" && message["tool_calls"].as_array()
                        .is_some_and(|calls| calls.iter().any(|call| call["id"] == id))
                }).collect();
                assert_eq!(calls.len(), 1, "one assistant batch must own {id}: {}", sent[3]);
                let (index, assistant) = calls[0];
                assert_eq!(assistant["reasoning_content"], format!("thinking-{n}"));
                assert_eq!(assistant["content"], format!("visible-{n}"));
                assert_eq!(assistant["tool_calls"][0]["function"]["name"], "todo_read");
                assert_eq!(messages[index + 1]["role"], "tool");
                assert_eq!(messages[index + 1]["tool_call_id"], id);
                if let Some(previous) = previous_result { assert!(index > previous); }
                previous_result = Some(index + 1);
            }
            let finished = messages.iter().find(|message| message["role"] == "assistant"
                && message["content"] == "source-finished").ok_or("source final output missing")?;
            assert!(finished.get("reasoning_content").is_none(), "finish inherited earlier reasoning");
            assert_eq!(messages.iter().filter(|message| message.get("reasoning_content").is_some()).count(), 2);

            let owner = rig.captured.lock().unwrap().clone().ok_or("Native owner missing")?;
            let original = facts(&owner.durable, source_run).await?;
            assert_eq!(original.iter().filter(|fact| fact["fact"]["kind"] == "tool_result_accepted").count(), 2);
            assert_eq!(original.iter().filter(|fact| fact["fact"]["kind"] == "local_tool_returned").count(), 2,
                "the fixture must dispatch the real checklist reader, not replay rejected tool calls");
            let mut contexts = Vec::new();
            for fact in original.iter().filter(|fact| fact["fact"]["kind"] == "step_prepared") {
                let step: StepId = serde_json::from_value(fact["fact"]["step"].clone())?;
                let request = owner.durable.request(source_run, step).await?;
                if request.accounting.purpose == ModelPurpose::Main {
                    let evidence: RequestContextEvidence = serde_json::from_slice(
                        &owner.durable.content(source_run, request.provenance.clone()).await?)?;
                    contexts.push(evidence.model_context.and_then(|context| context.codex)
                        .ok_or("source observation absent")?);
                }
            }
            assert_eq!(contexts.len(), 3, "fixture must cross two real tool-result/StepPrepared boundaries");
            assert!(contexts[0].compatibility.is_none());
            assert_eq!(contexts[1].compatibility.as_ref().map(|value| value.comp_hash.as_str()), Some("3000"));

            let view = owner.durable.frontier(target_run).await?;
            let attempt = &view.attempts[&view.current_attempt.ok_or("target attempt missing")?];
            let request = owner.durable.request(target_run, attempt.step).await?;
            let frozen: Value = serde_json::from_slice(
                &owner.durable.content(target_run, request.request.clone()).await?)?;
            let current = owner.mutable_session(&session).await?;
            let scope = owner.current_work_scope(&session, &current.configuration).await?;
            let (lease, effects) = scope.accept(CancellationToken::new());
            rig.lease = Some(lease);
            rig.work_effects = Some(effects);
            let history = owner.durable.session_history(owner.run_owner(), session.clone());
            let cut = history.capture().await?;
            let resources = owner.services.model_preparation_resources();
            let prompt = preparation::restore_prompt(
                preparation::PreparationIo::new(&rig.lease.as_ref().unwrap().store())?,
                resources.clone(), &history, &cut, target_run,
                &serde_json::from_value(frozen["prompt"].clone())?,
                &serde_json::from_value::<Vec<_>>(frozen["promptChunks"].clone())?,
                &serde_json::from_value(frozen["layout"].clone())?,
                &CancellationToken::new(),
            ).await?;
            let checked = async {
                let mut cursor = prompt.recipes().ok_or("frozen recipes missing")?.open(0);
                let mut found = Vec::new();
                while let Some(message) = cursor.next().await? {
                    if let MessageRecipe::Assistant { content, .. } = message {
                        let mut parts = content.open(0);
                        while let Some(part) = parts.next().await? {
                            if let AssistantRecipe::Reasoning { provider_options, .. } = part {
                                found.push(provider_options);
                            }
                        }
                    }
                }
                assert_eq!(found.len(), 2);
                assert!(found[0].is_none(), "incompatible first-step provider options were not stripped");
                let second = found[1].as_ref().ok_or("compatible second-step provider options disappeared")?;
                assert_eq!(second.replay_origin(), ReplayOrigin::observed("llama3.2", Some(&contexts[1])),
                    "the first attempt's unhashed producer leaked into the second batch");
                let work = resources.acquire_work().await?;
                let field = source_json::field(second, &["maka", "openAiChatReasoningField"], work.budget())
                    .await?.ok_or("recorded reasoning field missing")?;
                assert!(source_json::text_eq(&field.text()?, "reasoning_content", work.budget()).await?);
                Ok::<_, Box<dyn Error + Send + Sync>>(())
            }.await;
            prompt.close().await?;
            checked?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })).catch_unwind().await;
        drop(requests_rx);
        stop.cancel();
        let wire_ok = match wire {
            Some(task) => matches!(task.await, Ok(Ok(()))),
            None => true,
        };
        let cleanup =
            AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.finish()))
                .catch_unwind()
                .await;
        assert!(
            matches!(result, Ok(Ok(Ok(())))),
            "grouped TailReplay regression failed: {result:?}"
        );
        assert!(wire_ok, "grouping HTTP fixture did not settle");
        assert!(
            matches!(cleanup, Ok(Ok(ref errors)) if errors.is_empty()),
            "grouping Root did not settle"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn model_reader_child() -> TestResult<()> {
        let Some(path) = std::env::var_os(CHILD_ENV) else {
            return Ok(());
        };
        let path = PathBuf::from(path);
        let base = path
            .parent()
            .ok_or("test child base missing")?
            .to_path_buf();
        let boot: Boot = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
        let mut rig = Rig::new()?;
        rig.directory = TestDirectory::Borrowed(base.clone());
        let socket_directory = base.join("child-socket");
        tokio::fs::create_dir_all(&socket_directory).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&socket_directory, std::fs::Permissions::from_mode(0o700))
                .await?;
        }
        rig.socket_directory = TestDirectory::Borrowed(socket_directory);
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("test client missing")?;
        let root_owner = rig
            .store
            .as_ref()
            .ok_or("test Root missing")?
            .owned_root()?;
        let mut configuration_changes = root_owner.capability_changes();
        configuration_changes.borrow_and_update();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
        "expectedCatalogRevision":catalog["revision"],
        "connection":{"slug":"native-cleanup","name":"Native cleanup",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
    })).await?;
        assert!(
            connection["kind"] == "committed",
            "normal settings connection was not committed"
        );
        assert!(
            configuration_changes.has_changed()?,
            "independent Settings store did not invalidate Agent's shared Root source"
        );
        let models = call(client, "agent", "models", json!({"kind":"start"})).await?;
        let selection = models["choices"]
            .as_array()
            .ok_or("model choices missing")?
            .iter()
            .find(|choice| {
                choice["selection"]["connectionId"] == connection["connection"]["connectionId"]
            })
            .ok_or("created native model not selectable")?["selection"]
            .clone();
        let created = call(client, "agent", "create", json!({
        "title":"Native model cleanup recovery","automaticTitle":false,"labels":[],"tools":[],
        "workspace":{"kind":"directory","path":base.join("workspace")}
    })).await?;
        let session = created["session"]["id"]
            .as_str()
            .ok_or("test session missing")?
            .to_owned();
        let sent = call(client, "agent", "send", json!({
        "sessionId":session,
        "message":if boot.replay { "question-source" } else { "Return the fixed fixture response." },
        "backend":selection,"delivery":"queue"
    })).await?;
        assert!(sent["kind"] == "queued", "normal send did not queue");
        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let work = call(client, "agent", "work", json!({
                "sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}
            })).await?;
                if tokio::fs::try_exists(base.join("closed")).await?
                    && work["execution"]["state"]["kind"] == "waiting"
                {
                    let run: RunId = serde_json::from_value(work["execution"]["runId"].clone())?;
                    let owner = rig
                        .captured
                        .lock()
                        .unwrap()
                        .clone()
                        .ok_or("native factory owner missing")?;
                    let view = owner.durable.frontier(run).await?;
                    let attempt = view.current_attempt.ok_or("original attempt missing")?;
                    let original = &view.attempts[&attempt];
                    assert!(
                        view.spec.owner == owner.run_owner()
                            && view.spec.owner.deployment == boot.deployment
                            && view.spec.owner.namespace == InstanceId(vec![boot.agent])
                            && view.spec.session_id == session,
                        "normal send did not retain the actual Native owner and session"
                    );
                    assert!(
                        view.terminal.is_none() && original.cleanup != OperationCleanup::Confirmed,
                        "barrier did not retain original cleanup"
                    );
                    let closed = original
                        .closed
                        .as_ref()
                        .ok_or("model closure not durable")?;
                    let protocol: maka_agent_facts::context::ModelClosureProtocol =
                        serde_json::from_value(closed.protocol.clone())?;
                    assert!(
                        closed.outcome == maka_agent_facts::accounting::Outcome::Success
                            && closed.diagnostic.is_none()
                            && protocol.finish_reason
                                == maka_agent_facts::model::ModelFinishReason::Stop,
                        "native model did not close successfully at Stop"
                    );
                    let request = owner.durable.request(run, original.step).await?;
                    assert!(
                        request.accounting.purpose == ModelPurpose::Main
                            && request.protocol != "maka.tests.native-wait",
                        "test did not exercise normal Native preparation"
                    );
                    let upstream = original
                        .admission
                        .as_ref()
                        .ok_or("original admission missing")?
                        .upstream
                        .clone();
                    assert!(
                        upstream["request"] == serde_json::to_value(&request.request)?,
                        "descriptor changed original full request reference"
                    );
                    assert!(
                        upstream["nativeReader"]["version"] == 1,
                        "normal Native descriptor missing"
                    );
                    assert!(
                        upstream["nativeReader"]["owner"]
                            == serde_json::to_value(&view.spec.owner)?
                            && upstream["nativeReader"]["execution"]
                                == serde_json::to_value(ExecutionIdentity {
                                    session_id: session.clone(),
                                    turn_id: view.spec.turn_id.clone(),
                                    run_id: run,
                                })?
                            && upstream["nativeReader"]["step"]
                                == serde_json::to_value(original.step)?
                            && upstream["nativeReader"]["attempt"]
                                == serde_json::to_value(attempt)?
                            && upstream["nativeReader"]["source"]
                                == serde_json::to_value(&owner.revision)?,
                        "descriptor did not bind the full actual execution and Native source"
                    );
                    let frozen = Frozen {
                        session: session.clone(),
                        run,
                        attempt,
                        spec: serde_json::to_value(&view.spec)?,
                        request_bytes: owner.durable.content(run, request.request.clone()).await?,
                        provenance_bytes: owner
                            .durable
                            .content(run, request.provenance.clone())
                            .await?,
                        request: serde_json::to_value(request)?,
                        upstream,
                        facts: facts(&owner.durable, run).await?,
                    };
                    tokio::fs::write(base.join("frozen.json"), serde_json::to_vec(&frozen)?)
                        .await?;
                    return Ok::<_, Box<dyn Error + Send + Sync>>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await??;
        std::future::pending::<()>().await;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn gone_native_reader_is_acked_and_completed_without_replaying_the_original_model() {
        let mut rig = Rig::new().expect("owned test directories");
        let mut child: Option<tokio::process::Child> = None;
        let stop = CancellationToken::new();
        let posts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut wire: Option<JoinHandle<TestResult<()>>> = None;
        let mut stage = "bootstrap";
        let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
        let base = rig.directory.path().to_path_buf();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let boot = bootstrap(&base, format!("http://{}/v1", listener.local_addr()?), false).await?;
        wire = Some(tokio::spawn(serve(listener, posts.clone(), stop.clone(), None)));
        let path = base.join("boot.json");
        tokio::fs::write(&path, serde_json::to_vec(&boot)?).await?;
        let child_test = format!("{}::model_reader_child", module_path!().split_once("::").ok_or("test module missing")?.1);
        child = Some(tokio::process::Command::new(std::env::current_exe()?)
            .args(["--exact", &child_test, "--nocapture"]).env(CHILD_ENV, &path)
            .env("MAKA_TEST_MODEL_CLEANUP_BARRIER", base.join("closed"))
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn()?);
        let pid = child.as_ref().and_then(|child| child.id()).ok_or("owned child PID missing")?;
        let identity = tokio::task::spawn_blocking(move || ProcessIdentity::capture(pid)).await??;
        stage = "native_send_and_closed_barrier";
        while !tokio::fs::try_exists(base.join("frozen.json")).await? {
            if child.as_mut().ok_or("owned child missing")?.try_wait()?.is_some() {
                return Err("native model child ended before its durable barrier".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let frozen: Frozen = serde_json::from_slice(&tokio::fs::read(base.join("frozen.json")).await?)?;
        let original_identity: ProcessIdentity = serde_json::from_value(frozen.upstream["nativeReader"]["process"].clone())?;
        assert!(identity == original_identity, "admission did not stamp the actual child process");
        assert!(matches!(tokio::task::spawn_blocking({
            let identity = identity.clone(); move || maka_process::lifetime::observe(&identity)
        }).await??, ProcessObservation::Alive), "original source was not alive at the barrier");
        stage = "owned_kill_and_reap";
        let owned = child.as_mut().ok_or("owned child missing")?;
        owned.start_kill()?;
        assert!(!owned.wait().await?.success(), "owned child was not killed");
        child = None;
        let proof = tokio::task::spawn_blocking({
            let identity = identity.clone(); move || maka_process::lifetime::observe(&identity)
        }).await??;
        assert!(matches!(proof, ProcessObservation::Gone(ref proof) if proof.identity() == &original_identity), "fresh official observation did not prove the original process gone");
        stage = "same_root_new_native_factory";
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("reopened client missing")?;
        loop {
            let work = call(client, "agent", "work", json!({"sessionId":frozen.session,"target":{"kind":"run","runId":frozen.run}})).await?;
            if work["execution"]["state"]["kind"] == "completed" { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        stage = "full_original_evidence";
        let owner = rig.captured.lock().unwrap().clone().ok_or("new actual native factory missing")?;
        let view = owner.durable.frontier(frozen.run).await?;
        let original = &view.attempts[&frozen.attempt];
        assert!(view.terminal == Some(Terminal::Completed) && original.cleanup == OperationCleanup::Confirmed, "original model did not canonically complete after its physical ACK");
        assert!(serde_json::to_value(&view.spec)? == frozen.spec && view.current_attempt == Some(frozen.attempt), "original execution identity changed");
        let request = owner.durable.request(frozen.run, original.step).await?;
        assert!(serde_json::to_value(&request)? == frozen.request, "original request changed");
        assert!(owner.durable.content(frozen.run, request.request.clone()).await? == frozen.request_bytes, "original request bytes changed");
        assert!(original.admission.as_ref().ok_or("original admission lost")?.upstream == frozen.upstream, "original upstream descriptor changed");
        let all = facts(&owner.durable, frozen.run).await?;
        assert!(all.starts_with(&frozen.facts), "original canonical fact prefix changed");
        assert!(all.iter().filter(|fact| fact["fact"]["kind"] == "model_attempt_admitted").count() == 1, "original model was admitted again");
        assert!(all.iter().filter(|fact| fact["fact"]["kind"] == "model_attempt_prepared").count() == 1, "another model attempt was prepared");
        assert!(posts.load(Ordering::SeqCst) == 1, "original provider request was replayed");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
        if let Some(mut owned) = child {
            let _ = owned.kill().await;
            let _ = owned.wait().await;
        }
        stop.cancel();
        let wire_ok = match wire {
            Some(task) => matches!(task.await, Ok(Ok(()))),
            None => true,
        };
        let cleanup =
            AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.finish()))
                .catch_unwind()
                .await;
        assert!(
            matches!(outcome, Ok(Ok(Ok(())))),
            "native cleanup recovery failed at static stage {stage}"
        );
        assert!(wire_ok, "owned model fixture did not settle");
        assert!(
            matches!(cleanup, Ok(Ok(ref errors)) if errors.is_empty()),
            "owned recovery Root cleanup did not settle"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn budget_child_failure_remains_failed_after_bounded_frontier_drops_cancelled_wait() {
        let mut rig = Rig::new().expect("owned test directories");
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let session = rig.start().await?;
        rig.assemble_budget(&session, Some(110)).await?;
        // Logical State/Engine fixture only: no Native model launch or physical ACK is asserted.
        let attempt = rig.attempt().await?;
        let wait = WaitId::new();
        rig.append(vec![
            Fact::ModelClosed {
                attempt, outcome: maka_agent_facts::accounting::Outcome::Success, diagnostic: None,
                usage: maka_agent_facts::model::ModelUsage { input_tokens: Some(100), output_tokens: Some(10), ..Default::default() },
                protocol: serde_json::to_value(maka_agent_facts::context::ModelClosureProtocol {
                    finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    provider_options: None, cache_read_reported: None, response_id: None, model: None, timestamp: None, compaction: None, summary: None,
                })?,
            },
            Fact::BudgetCharged { tokens: 110 },
            Fact::WaitRegistered { wait, reason: WaitReason::Child { run: RunId::new() }, due_at: None },
        ], vec![]).await?;
        let driver = rig.driver.as_ref().ok_or("logical test driver missing")?;
        let run = driver.access.execution().run_id;
        let engine = maka_agent_engine::Engine::new(driver.state.clone());
        let initial = driver.state.frontier(run).await?;
        assert!(initial.waits.contains_key(&wait), "actual initial frontier lost the Child obligation");
        let first = engine.current_authority_unavailable(driver.access.claim().clone(), AuthorityStage::BackendScope, "logical bounded frontier test has no execution ports".into(), at()).await?;
        assert!(matches!(first, maka_agent_engine::DriverExit::Terminal { terminal: Terminal::Failed, .. }), "Child budget fence did not choose Failed");
        let bounded = driver.state.frontier(run).await?;
        assert!(bounded.revision == initial.revision + 2, "Child cancellation and failure did not form the selected two-fact settlement");
        assert!(bounded.terminal == Some(Terminal::Failed) && !bounded.waits.contains_key(&wait), "State did not return the terminal bounded frontier");
        assert!(bounded.attempts[&attempt].cleanup != OperationCleanup::Confirmed, "logical fixture fabricated a model cleanup ACK");
        let second = engine.current_authority_unavailable(driver.access.claim().clone(), AuthorityStage::BackendScope, "next bounded level".into(), at()).await?;
        assert!(matches!(second, maka_agent_engine::DriverExit::Terminal { terminal: Terminal::Failed, .. }), "next level flipped the Child failure to success");
        assert!(driver.state.frontier(run).await?.revision == bounded.revision, "next level appended another outcome");
        let history = driver.state.history(run, 0, 64).await?;
        assert!(history.windows(2).any(|pair| matches!(&pair[0].fact, Fact::WaitCancelled { wait: id, .. } if *id == wait)
            && matches!(&pair[1].fact, Fact::RunTerminated { terminal: Terminal::Failed, .. })), "Child cancellation was not committed with the selected failure");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
        let cleanup =
            AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), rig.finish()))
                .catch_unwind()
                .await;
        assert!(
            matches!(result, Ok(Ok(Ok(())))),
            "Child bounded-frontier regression failed"
        );
        assert!(
            matches!(cleanup, Ok(Ok(ref errors)) if errors.is_empty()),
            "Child fixture cleanup did not settle"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_only_tool_in_a_real_cell_reports_calling_mode_without_dispatch() {
    let mut rig = Rig::new().expect("owned directories");
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let input = json!({"code":"await tools.ordinary_local({})","yield_time_ms":30000});
        let (key, sequence) = rig
            .tool(attempt, "exec", "direct-only-diagnostic", input.clone())
            .await?;
        let driver = rig.driver.as_ref().ok_or("driver missing")?;
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let (effect, source) = rig
            .cells
            .as_ref()
            .ok_or("cells missing")?
            .prepare(
                driver.context(&view, &key)?,
                "exec",
                &input,
                driver.catalog.clone(),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await?;
        let owner = driver.original_effects.clone();
        rig.begin(
            effect,
            sequence,
            key.clone(),
            source,
            owner,
            Arc::new(AtomicBool::new(false)),
        )?;
        rig.complete().await?;
        let driver = rig.driver.as_ref().ok_or("driver missing")?;
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let cell = view
            .cells
            .values()
            .find(|cell| {
                matches!(&cell.owner,
                    maka_agent_facts::cells::CellOwner::Agent { call, .. } if call == &key.call
                )
            })
            .ok_or("actual Cell missing")?;
        let maka_agent_facts::cells::CellStatus::Interrupted { report } = &cell.status else {
            return Err("direct-only call did not interrupt the Cell".into());
        };
        let report: maka_agent_facts::cells::CellInterruption =
            serde_json::from_slice(&driver.state.content(view.run, report.clone()).await?)?;
        assert!(
            report.diagnostic.contains(
                "ordinary_local is a direct tool: call it outside exec, not through tools"
            ),
            "{}",
            report.diagnostic
        );
        assert!(
            cell.children.is_empty(),
            "direct-only member must not admit a nested effect"
        );
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "original cleanup: {cleanup:?}");
    match outcome {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => panic!("{error}"),
        Ok(Err(error)) => panic!("diagnostic observation deadline: {error}"),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

mod replay_origin_regressions {
    use super::*;
    use crate::owner::driver_model::{ReplayTarget, append_observed, current_context};
    use maka_agent_engine::{ModelSource, PreparedModel, preparation};
    use maka_agent_facts::{
        context::{
            CodexCompatibility, CodexRequestProvenance, ModelOperation, ModelRequestContext,
        },
        model::prompt_source::source::{
            AssistantRecipe, MessageRecipe, ReplayOrigin, json as source_json,
        },
    };
    use maka_model::prompt::{AssistantPart, Message, Prompt};

    async fn model(rig: &Rig, name: &str, hash: Option<&str>) -> TestResult<PreparedModel> {
        let NativeBackend::Model { model, .. } = &rig.driver.as_ref().unwrap().backend else {
            return Err("expected Native model fixture".into());
        };
        let mut prepared = model.source.capture().await?;
        prepared.provider.model = name.into();
        prepared.provider.kind = maka_model::ProviderKind::OpenaiResponses;
        prepared.provider.adapter = Some("codex-responses".into());
        prepared.options = json!({"openai":{"store":false}});
        prepared.context = Some(ModelRequestContext {
            operation: ModelOperation::Inference,
            provider_id: "chatgpt".into(),
            codex: Some(CodexRequestProvenance {
                connection_id: format!("connection-{name}"),
                account_id: Some(format!("account-{name}")),
                compatibility: hash.map(|hash| CodexCompatibility {
                    comp_hash: hash.into(),
                    fetched_at: 1,
                }),
            }),
            context_window: Some(128_000),
            model_context_window: Some(128_000),
            declared_window: Some(108_800),
        });
        Ok(prepared)
    }

    async fn builder(rig: &Rig) -> TestResult<preparation::PromptBuilder> {
        let driver = rig.driver.as_ref().unwrap();
        Ok(preparation::PromptBuilder::new(
            preparation::PreparationIo::new(&rig.lease.as_ref().unwrap().store())?,
            driver.owner.services.model_preparation_resources(),
            &driver.cancellation,
        )
        .await?)
    }

    async fn finish(
        rig: &Rig,
        builder: preparation::PromptBuilder,
        model: &PreparedModel,
        operation: ModelOperation,
    ) -> TestResult<maka_agent_engine::prepared_prompt::PreparedPrompt> {
        let settings = preparation::PromptSettings {
            operation,
            codex: model
                .context
                .as_ref()
                .and_then(|value| value.codex.as_ref()),
            language: Language::En,
            provider: &model.provider,
            options: &model.options,
            context_window: Some(128_000),
            tool_choice: maka_model::ToolChoiceMode::Auto,
        };
        Ok(preparation::prepare_prompt(
            builder,
            &settings,
            &rig.driver.as_ref().unwrap().cancellation,
            None,
            ModelPurpose::Main,
            None,
        )
        .await?)
    }

    // Uses the same canonical append/decode path as snapshot_prompt, with a shifted outer directory.
    async fn recapture(
        rig: &Rig,
        model: &PreparedModel,
        source: &Prompt,
        operation: ModelOperation,
    ) -> TestResult<maka_agent_engine::prepared_prompt::PreparedPrompt> {
        let mut builder = builder(rig).await?;
        let result = async {
            builder.append(Message::user("replan boundary")).await?;
            let mut cursor = source
                .recipes()
                .ok_or_else(|| RunError::Internal("source recipes missing".into()))?
                .open(0);
            while let Some(recipe) = cursor.next().await? {
                if let Some(recipe) = ReplayTarget::new(model, operation).recipe(recipe).await? {
                    builder.append_recipe(&recipe).await?;
                }
            }
            Ok::<(), RunError>(())
        }
        .await;
        if let Err(error) = result {
            builder.close().await?;
            return Err(error.into());
        }
        finish(rig, builder, model, operation).await
    }

    async fn parts(prompt: &Prompt) -> TestResult<Vec<AssistantRecipe>> {
        let mut parts = Vec::new();
        let mut messages = prompt.recipes().ok_or("recipes missing")?.open(0);
        while let Some(message) = messages.next().await? {
            if let MessageRecipe::Assistant { content, .. } = message {
                let mut cursor = content.open(0);
                while let Some(part) = cursor.next().await? {
                    parts.push(part);
                }
            }
        }
        Ok(parts)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn frozen_replan_does_not_fill_a_producers_missing_hash() {
        let mut rig = Rig::new().expect("owned fixture");
        let result =
            AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                let session = rig.start().await?;
                rig.assemble(&session).await?;
                let original = model(&rig, "model-a", None).await?;
                let middle = model(&rig, "model-a", Some("3000")).await?;
                let target = model(&rig, "model-b", Some("3000")).await?;
                let mut source = builder(&rig).await?;
                for (text, producer) in [("unhashed", &original), ("compatible", &target)] {
                    append_observed(&mut source, Message::Assistant {
                    content: vec![AssistantPart::Reasoning {
                        text: text.into(),
                        provider_options: Some(json!({"openai":{
                            "itemId":text,"reasoningEncryptedContent":format!("opaque-{text}")
                        }})),
                    }],
                    provider_options: None,
                }, ReplayOrigin::observed(&producer.provider.model,
                    producer.context.as_ref().and_then(|value| value.codex.as_ref()))).await?;
                }
                let source = finish(&rig, source, &original, ModelOperation::Inference).await?;
                let middle_prompt =
                    recapture(&rig, &middle, &source.model(), ModelOperation::Inference).await?;
                let final_prompt = recapture(
                    &rig,
                    &target,
                    &middle_prompt.model(),
                    ModelOperation::Inference,
                )
                .await?;
                {
                    let output = parts(&final_prompt.model()).await?;
                    assert_eq!(
                        output.len(),
                        1,
                        "replan's enclosing certificate admitted an older unhashed item"
                    );
                    let AssistantRecipe::Reasoning {
                        provider_options: Some(options),
                        ..
                    } = &output[0]
                    else {
                        return Err("compatible reasoning disappeared".into());
                    };
                    let resources = rig
                        .driver
                        .as_ref()
                        .unwrap()
                        .owner
                        .services
                        .model_preparation_resources();
                    let work = resources.acquire_work().await?;
                    let value = source_json::field(
                        options,
                        &["openai", "reasoningEncryptedContent"],
                        work.budget(),
                    )
                    .await?
                    .ok_or("opaque reasoning missing")?;
                    assert!(
                        source_json::text_eq(&value.text()?, "opaque-compatible", work.budget())
                            .await?
                    );
                }
                final_prompt.close().await?;
                middle_prompt.close().await?;
                source.close().await?;
                Ok::<_, Box<dyn Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "origin replan regression failed: {result:?}"
        );
        assert!(cleanup.is_empty(), "origin fixture did not settle");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopted_main_records_current_context_and_rechecks_each_tail_origin() {
        let mut rig = Rig::new().expect("owned fixture");
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
            let session = rig.start().await?;
            rig.assemble(&session).await?;
            let old = model(&rig, "model-a", Some("3000")).await?;
            let mut current = model(&rig, "model-a", Some("4000")).await?;
            let mut provenance = json!({"modelContext":old.context});
            current.context = current_context(&mut provenance, &current, ModelOperation::Inference)?;
            let recorded: Option<ModelRequestContext> =
                serde_json::from_value(provenance["modelContext"].clone())?;
            let recorded = recorded.ok_or("current context absent")?;
            assert_eq!(recorded.codex.as_ref().and_then(|value| value.compatibility.as_ref())
                .map(|value| value.comp_hash.as_str()), Some("4000"));
            assert_eq!(recorded.operation, ModelOperation::Inference);
            let mut source = builder(&rig).await?;
            append_observed(&mut source, Message::Assistant {
                content: vec![AssistantPart::CodexCompaction {
                    item: json!({"type":"compaction","id":"converted","encrypted_content":"opaque-4000"}),
                }], provider_options: None,
            }, ReplayOrigin::observed("model-a", current.context.as_ref()
                .and_then(|value| value.codex.as_ref()))).await?;
            append_observed(&mut source, Message::Assistant {
                content: vec![AssistantPart::Reasoning {
                    text: "old tail".into(),
                    provider_options: Some(json!({"openai":{
                        "itemId":"old-tail","reasoningEncryptedContent":"opaque-3000"
                    }})),
                }], provider_options: None,
            }, ReplayOrigin::observed("model-a", old.context.as_ref()
                .and_then(|value| value.codex.as_ref()))).await?;
            let source = finish(&rig, source, &old, ModelOperation::Inference).await?;
            let adopted = recapture(&rig, &current, &source.model(), ModelOperation::Inference).await?;
            {
                let output = parts(&adopted.model()).await?;
                assert_eq!(output.len(), 1, "adopted Main retained a tail certified only by its old hash");
                assert!(matches!(output[0], AssistantRecipe::CodexCompaction { .. }));
            }
            let compatible = model(&rig, "model-b", Some("4000")).await?;
            let via_b = recapture(&rig, &compatible, &adopted.model(), ModelOperation::Inference).await?;
            let changed = model(&rig, "model-b", Some("5000")).await?;
            assert!(recapture(&rig, &changed, &via_b.model(), ModelOperation::CodexCompaction)
                .await.is_err(), "replay through B relabelled A's native checkpoint as same-model B");
            via_b.close().await?;
            adopted.close().await?;
            source.close().await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })).catch_unwind().await;
        let cleanup = rig.finish().await;
        assert!(
            matches!(&result, Ok(Ok(Ok(())))),
            "compaction origin regression failed: {result:?}"
        );
        assert!(cleanup.is_empty(), "compaction fixture did not settle");
    }
}

mod tool_history;

mod goals;
mod permission_boundary;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_cancels_an_unconsumed_completion_notice() {
    let mut rig = Rig::new().unwrap();
    let result: TestResult<()> = async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let source = rig.driver.as_ref().unwrap().access.execution().clone();
        let route = owner.return_route(&source).await?;
        let model = route.binding_model();
        let request = json!({
            "source": source,
            "model": {"connectionId": model.connection_id, "modelId": model.model},
            "thinking_level": route.thinking_level(),
            "workspace": route.workspace,
            "binding": route.binding,
        });
        let worker = format!("{}missing-worker", owner.prefix);
        owner
            .store
            .register_message_completion(&owner.prefix, &worker, "task", &session, request)
            .await?;
        owner.deliver_completions().await?;
        let queue = owner.durable.queue();
        let pending = queue.steering(session.clone(), source.run_id).await?;
        let [notice] = pending.entries.as_slice() else {
            return Err("original caller did not get the pending notification".into());
        };
        rig.append(
            vec![Fact::StopRequested {
                diagnostic: "user_requested_stop".into(),
            }],
            vec![],
        )
        .await?;
        let message = notice.request.message_id.clone();
        assert_eq!(
            queue
                .resolve_message(session.clone(), message.clone())
                .await?,
            maka_agent_state::queue::MessageResolution::Cancelled
        );
        queue.rebuild(session.clone()).await?;
        assert_eq!(
            queue.resolve_message(session, message).await?,
            maka_agent_state::queue::MessageResolution::Cancelled
        );
        Ok(())
    }
    .await;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    result.unwrap();
}

#[tokio::test]
async fn pending_completion_subscription_allows_idle_host_exit() {
    let mut rig = Rig::new().unwrap();
    let result: TestResult<()> = async {
        let session = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        // An unavailable completion can remain durable across Host lifetimes.
        owner
            .store
            .register_message_completion(
                &owner.prefix,
                &session,
                "task",
                &session,
                json!({"unavailable": true}),
            )
            .await?;
        rig.client.take().unwrap().close().await?;
        tokio::time::timeout(
            Duration::from_secs(5),
            rig.host
                .as_ref()
                .unwrap()
                .wait_until_idle(Duration::ZERO, Duration::ZERO),
        )
        .await??;
        assert!(
            owner
                .store
                .has_message_completions(&owner.prefix, &session, &session)
                .await?
        );
        Ok(())
    }
    .await;
    let cleanup = rig.finish().await;
    assert!(result.is_ok(), "{result:?}; {cleanup:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_notification_survives_pending_message_edit() {
    use maka_agent_facts::message::{MessageOrigin, RootSourceMessage};
    use maka_agent_state::queue::{QueueCommand, QueueEdit};

    let mut rig = Rig::new().unwrap();
    let result: TestResult<()> = async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let _producer = owner.producer_gate.lock().await;
        let source = rig.driver.as_ref().unwrap().access.execution().clone();
        let route = owner.return_route(&source).await?;
        let model = route.binding_model();
        let request = json!({
            "source": source,
            "model": {"connectionId": model.connection_id, "modelId": model.model},
            "thinking_level": route.thinking_level(),
            "workspace": route.workspace,
            "binding": route.binding,
        });
        let worker = format!("{}missing-worker", owner.prefix);
        owner
            .store
            .register_message_completion(&owner.prefix, &worker, "task", &session, request)
            .await?;
        let notification = owner
            .prepare_notification(
                &source,
                &route,
                "completion-edit",
                |_| "Task finished.".into(),
                MessageOrigin::SessionCompletion {
                    session_id: worker,
                    message_id: "task".into(),
                },
            )
            .await?
            .ok_or("notification not prepared")?;
        let entry = owner
            .store
            .message_completions(&owner.prefix, None)
            .await?
            .remove(0);
        owner
            .store
            .settle_message_completion(
                &owner.prefix,
                &entry.key,
                Some(serde_json::to_value(&notification)?),
            )
            .await?;

        // Resume settlement from the frozen subscription after a legal queue edit.
        let queue = owner.durable.queue();
        let mut edited_source: RootSourceMessage = serde_json::from_slice(
            &queue
                .content(
                    session.clone(),
                    notification.id.clone(),
                    notification.source.clone(),
                )
                .await?,
        )?;
        edited_source.unprepared_content.text = "Read the result and summarize it.".into();
        edited_source.message.content = edited_source.unprepared_content.clone();
        let mut input: RunInput = serde_json::from_slice(
            &queue
                .content(
                    session.clone(),
                    notification.id.clone(),
                    notification.spec.input.clone(),
                )
                .await?,
        )?;
        let RunInput::Message {
            content,
            source_messages,
            ..
        } = &mut input
        else {
            return Err("notification is not a message".into());
        };
        *content = edited_source.message.content.clone();
        *source_messages = vec![edited_source.clone()];
        let source_blob = ContentBlob::json(&edited_source)?;
        let input_blob = ContentBlob::json(&input)?;
        let mut edited = notification.clone();
        edited.source = source_blob.reference().clone();
        edited.spec.input = input_blob.reference().clone();
        queue
            .execute(
                session.clone(),
                QueueCommand {
                    id: FactId::try_from(Uuid::new_v4()).unwrap(),
                    at: at(),
                    expected_revision: queue.read(session.clone()).await?.revision,
                    edit: QueueEdit::Update {
                        request: Box::new(edited.clone()),
                    },
                },
                vec![source_blob, input_blob],
            )
            .await?;

        let mut wrong_identity = notification.clone();
        wrong_identity.message_id = "another-message".into();
        assert_eq!(
            owner.admit_notification(&wrong_identity).await.unwrap_err(),
            "agent_message_identity_changed"
        );
        assert!(owner.admit_notification(&notification).await?);
        owner.deliver_completions().await?;
        assert!(
            owner
                .store
                .message_completions(&owner.prefix, None)
                .await?
                .is_empty()
        );
        let pending = queue.read(session).await?;
        assert_eq!(
            pending.entries.len(),
            1,
            "settlement must not enqueue another notification"
        );
        assert_eq!(pending.entries[0].request, edited);
        Ok(())
    }
    .await;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    result.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compacted_history_checks_the_producing_requests_original_cut() {
    use maka_agent_engine::ports::Preparation;
    use maka_agent_facts::{
        context::{CheckpointContent, CheckpointMode, CompactedContext, ContextCheckpoint},
        history_snapshot::RequestSource,
    };
    let mut rig = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let NativeBackend::Model { model, .. } = &driver.backend else {
            unreachable!()
        };
        let summary_text = "Continue the original task.";
        rig.record_model_reply(Preparation::Initial, None).await?;
        let view = driver.state.frontier(run).await?;
        let mut main = model
            .prepare_step(&view, Preparation::Initial, driver)
            .await?;
        let encoded = ContentBlob::json(&main.request)?;
        main.contents.push(encoded.clone());
        rig.append(
            vec![Fact::StepPrepared {
                step: main.request.step,
                request: encoded.reference().clone(),
                adjudications: vec![],
            }],
            main.contents,
        )
        .await?;
        let (summary, summary_attempt, started) =
            rig.record_model_request(Preparation::Summary).await?;
        let observe = || {
            model_recovery::call(
                rig.client.as_ref().unwrap(),
                "agent",
                "observe",
                json!({"sessionId": session}),
            )
        };
        let observed = observe().await?;
        assert_eq!(
            observed["compacting"],
            json!({"id": summary.step, "startedAt": started.0}),
        );
        rig.finish_model_request(summary_attempt, Some(summary_text))
            .await?;
        assert_eq!(observe().await?["compacting"], Value::Null);
        let capture: RequestSource = serde_json::from_slice(
            &driver
                .state
                .content(run, summary.source_capture.clone())
                .await?,
        )?;
        assert_ne!(
            capture.cut.digest, capture.current.digest,
            "the original request cut must differ from its later live frontier"
        );
        for (digest, accepted) in [
            (summary.source_digest.clone(), true),
            (capture.current.digest.clone(), false),
        ] {
            let baseline = ContentBlob::json(&CompactedContext {
                summary_origin: None,
                source_capture: summary.source_capture.clone(),
                checkpoint: ContextCheckpoint {
                    mode: CheckpointMode::Standalone,
                    covered_through: capture.current.through_sequence,
                    source_digest: digest,
                    previous_checkpoint_id: None,
                    summary: CheckpointContent::Text(summary_text.into()),
                    summary_step_id: summary.step,
                },
                native: None,
            })?;
            let published = rig
                .append(
                    vec![Fact::ContextCompacted {
                        baseline: baseline.reference().clone(),
                    }],
                    vec![baseline],
                )
                .await;
            if accepted {
                published?;
                let view = driver.state.frontier(run).await?;
                model
                    .prepare_step(&view, Preparation::Initial, driver)
                    .await?;
            } else {
                let error = published
                    .err()
                    .ok_or("checkpoint with the later frontier digest was accepted")?;
                assert!(
                    error.to_string().contains("original frozen summary source"),
                    "{error}"
                );
            }
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&outcome, Ok(Ok(Ok(())))),
        "compaction source regression: {outcome:?}"
    );
    assert!(
        cleanup.is_empty(),
        "compaction fixture cleanup: {cleanup:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_admission_wakes_when_goal_or_session_lock_releases() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let result = async {
        let session = rig.start().await?;
        let owner = rig
            .captured
            .lock()
            .unwrap()
            .clone()
            .ok_or("owner missing")?;
        for is_goal in [true, false] {
            let goal = if is_goal {
                Some(owner.goals.gate.clone().lock_owned().await)
            } else {
                None
            };
            let ordered = if is_goal {
                None
            } else {
                Some(owner.runs.ordered(&session).await)
            };
            let mut wake = match owner.queue_admission(&session, true) {
                Ok(_) => return Err("contended admission unexpectedly acquired its locks".into()),
                Err(wake) => wake,
            };
            assert!(futures_util::poll!(&mut wake).is_pending());
            // An unrelated Session must still be admitted while this one waits.
            let other = owner
                .queue_admission("unrelated-session", false)
                .map_err(|_| "a contended admission blocked an unrelated Session")?;
            drop(other);
            drop(ordered);
            drop(goal);
            tokio::time::timeout(Duration::from_secs(5), wake).await?;
            // No durable write or extra wake notification occurs after releasing the lock.
            let admitted = owner
                .queue_admission(&session, true)
                .map_err(|_| "released admission remained blocked")?;
            drop(admitted);
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }
    .await;
    let cleanup = rig.finish().await;
    result?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_cancels_background_request_when_main_finishes() {
    use axum::{
        body::{Body, Bytes},
        response::IntoResponse,
    };
    use futures_util::StreamExt;
    use maka_agent_engine::{DriverExit, Engine, ports::Preparation};

    let mut rig = Rig::new().unwrap();
    rig.model_overrides = json!({"llama3.2":{"compactionThreshold":1_800}});
    let stop = CancellationToken::new();
    let main_ready = Arc::new(tokio::sync::Notify::new());
    let listener =
        tokio::net::TcpListener::from_std(rig.model_listener.try_clone().unwrap()).unwrap();
    let release = main_ready.clone();
    let shutdown = stop.clone();
    let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(
        move |request: axum::extract::Request| {
            let release = release.clone();
            let stop = shutdown.clone();
            async move {
                let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let chunk = |delta: Value, finish: Value| format!("data: {}\n\n", json!({
                    "id":"compaction-cancel","object":"chat.completion.chunk","created":1,"model":"llama3.2",
                    "choices":[{"index":0,"delta":delta,"finish_reason":finish}]
                }));
                let body = if request["tools"].as_array().is_some_and(|tools| !tools.is_empty()) {
                    release.notified().await;
                    Body::from(chunk(json!({"role":"assistant","content":"Main completed."}), Value::Null)
                        + &chunk(json!({}), json!("stop")) + "data: [DONE]\n\n")
                } else {
                    let first = chunk(json!({"role":"assistant","content":"Background summary still running."}), Value::Null);
                    Body::from_stream(futures_util::stream::once(async { Ok::<_, std::io::Error>(Bytes::from(first)) })
                        .chain(futures_util::stream::once(async move { stop.cancelled().await; Ok(Bytes::new()) })))
                };
                ([("content-type", "text/event-stream")], body).into_response()
            }
        }
    ));
    let shutdown = stop.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
    });
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig.start().await?;
        rig.assemble_model(&session, Budget { tokens:None, retries:0, deadline:None }, false).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        rig.record_model_reply(Preparation::Initial, None).await?;
        let view = driver.state.frontier(run).await?;
        let mut main = driver.model()?.prepare_step(&view, Preparation::Initial, driver).await?;
        let body = ContentBlob::json(&main.request)?;
        main.contents.push(body.clone());
        rig.append(vec![Fact::StepPrepared {
            step: main.request.step, request: body.reference().clone(), adjudications: vec![],
        }], main.contents).await?;
        let context: maka_agent_facts::context::RequestContextEvidence =
            serde_json::from_slice(&driver.state.content(run, main.request.provenance).await?)?;
        assert!((1_530..1_800).contains(&context.estimated_input_tokens), "{context:?}");

        let engine = Engine::new(driver.state.clone());
        let mut changes = driver.state.subscribe()?;
        let release_main = async {
            loop {
                changes.borrow_and_update();
                if let Some(background) = driver.state.frontier(run).await?.proactive_summary
                    && driver.state.history(run, 0, 128).await?.iter().any(|fact|
                        matches!(fact.fact, Fact::ModelFirstTokenObserved { attempt } if attempt == background)
                    )
                {
                    main_ready.notify_one();
                    return Ok::<_, Box<dyn Error + Send + Sync>>(background);
                }
                changes.changed().await?;
            }
        };
        let drive = async {
            let mut changes = driver.state.subscribe()?;
            loop {
                changes.borrow_and_update();
                let exit = engine.drive(driver.access.claim().clone(), driver.clone(), CancellationToken::new()).await?;
                if !matches!(exit, DriverExit::Waiting { .. }) {
                    return Ok::<_, Box<dyn Error + Send + Sync>>(exit);
                }
                changes.changed().await?;
            }
        };
        let (background, exit) = tokio::try_join!(release_main, Box::pin(drive))?;
        assert!(matches!(exit, DriverExit::Terminal { terminal: Terminal::Completed, .. }), "{exit:?}");
        let history = driver.state.history(run, 0, 128).await?;
        let interruption = history.iter().find_map(|fact| match &fact.fact {
            Fact::ModelInterrupted { attempt, diagnostic } if *attempt == background => Some(diagnostic),
            _ => None,
        }).ok_or("background source was not interrupted")?;
        assert!(interruption.contains("cancel"), "{interruption}");
        assert!(history.iter().any(|fact| matches!(fact.fact,
            Fact::ModelCleanupObserved { attempt, cleanup: OperationCleanup::Confirmed } if attempt == background
        )));
        assert!(!history.iter().any(|fact| matches!(fact.fact,
            Fact::AttemptRecoveryRecorded { attempt, .. } if attempt == background
        )));
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    stop.cancel();
    main_ready.notify_one();
    server.await.unwrap().unwrap();
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match result {
        Ok(result) => result.expect("background cancellation timed out").unwrap(),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_checkpoint_survives_stop_and_is_used_by_the_next_message() {
    use maka_agent_engine::{DriverExit, Engine, ports::Preparation};
    use std::sync::atomic::AtomicUsize;

    let mut rig = Rig::new().unwrap();
    let stop = CancellationToken::new();
    let posts = Arc::new(AtomicUsize::new(0));
    let listener =
        tokio::net::TcpListener::from_std(rig.model_listener.try_clone().unwrap()).unwrap();
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(model_recovery::serve(
        listener,
        posts.clone(),
        stop.clone(),
        Some(requests),
    ));
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        rig.record_model_reply(Preparation::Initial, None).await?;
        let view = driver.state.frontier(run).await?;
        let mut main = driver.model()?.prepare_step(&view, Preparation::Initial, driver).await?;
        let encoded = ContentBlob::json(&main.request)?;
        main.contents.push(encoded.clone());
        rig.append(vec![Fact::StepPrepared {
            step: main.request.step,
            request: encoded.reference().clone(),
            adjudications: vec![],
        }], main.contents).await?;

        let summary_text = "Remember the reusable cobalt summary.";
        let (_, summary) = rig.record_model_reply(Preparation::Summary, Some(summary_text)).await?;
        rig.record_model_reply(
            Preparation::CompactionDeferred { main: main.request.step, summary },
            None,
        ).await?;
        assert!(driver.state.frontier(run).await?.baseline.is_none());
        rig.append(vec![Fact::StopRequested { diagnostic: "user_requested_stop".into() }], vec![]).await?;
        let exit = Engine::new(driver.state.clone())
            .drive(driver.access.claim().clone(), driver.clone(), CancellationToken::new())
            .await?;
        assert!(matches!(exit, DriverExit::Terminal { terminal: Terminal::Cancelled, .. }), "{exit:?}");

        let owner = driver.owner.clone();
        owner.durable.rebuild(run).await?;
        let history = owner.durable.history(run, 0, 64).await?;
        assert!(matches!(history.last_chunk::<2>(), Some([checkpoint, ended])
            if matches!(checkpoint.fact, Fact::ContextCompacted { .. })
                && matches!(ended.fact, Fact::RunTerminated { terminal: Terminal::Cancelled, .. })));

        let cells = rig.cells.as_ref().unwrap();
        cells.coordinator.shutdown().await?;
        driver.workers.close();
        driver.workers.wait().await;
        assert!(cells.original_cleanup_confirmed().await?);
        rig.work_effects.as_ref().unwrap().settle().await?;
        rig.lease.take().unwrap().finish();
        rig.cells.take();
        rig.work_effects.take();

        let binding = &main.request.accounting.binding;
        let client = rig.client.as_ref().unwrap();
        let sent = model_recovery::call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "The new message after Stop.",
            "delivery": "queue",
            "backend": {"kind":"model","connectionId":binding.connection_id,"modelId":binding.model},
        })).await?;
        assert!(matches!(sent["kind"].as_str(), Some("started" | "queued")), "{sent}");
        model_recovery::completed_message(client, &session, &sent["messageId"]).await?;
        let body = String::from_utf8(received.try_recv()?)?;
        assert!(body.contains(summary_text) && body.contains("The new message after Stop."), "{body}");
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    })).catch_unwind().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match result {
        Ok(result) => result.expect("compaction handoff timed out").unwrap(),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_resumes_with_steering_indexed_at_its_original_delivery() {
    use crate::contract::ForkResult;
    use maka_agent_engine::{DriverExit, Engine, ports::Preparation};
    use maka_agent_facts::{
        context::{CheckpointContent, CheckpointMode, CompactedContext, ContextCheckpoint},
        history::{HistoryRowAddress, RowPosition},
        history_snapshot::RequestSource,
        message::MessageOrigin,
        session::ForkPosition,
    };
    use maka_agent_state::recall::SearchQuery;
    use std::sync::atomic::AtomicUsize;

    let mut rig = Rig::new().unwrap();
    let stop = CancellationToken::new();
    let posts = Arc::new(AtomicUsize::new(0));
    let listener =
        tokio::net::TcpListener::from_std(rig.model_listener.try_clone().unwrap()).unwrap();
    let server = tokio::spawn(model_recovery::serve(
        listener,
        posts.clone(),
        stop.clone(),
        None,
    ));
    let test = async {
        let session = rig.start().await?;
        rig.assemble_model(
            &session,
            Budget {
                tokens: None,
                retries: 0,
                deadline: None,
            },
            false,
        )
        .await?;
        let driver = rig.driver.as_ref().unwrap();
        let execution = driver.access.execution();
        let run = execution.run_id;
        let (_, first_attempt) = rig.record_model_reply(Preparation::Initial, None).await?;
        let steering_text = "Keep the cobalt marker in view.";
        let owner = &driver.owner;
        let notification = owner
            .prepare_notification(
                execution,
                &owner.return_route(execution).await?,
                "compaction-steering-message",
                |_| steering_text.into(),
                MessageOrigin::SessionCompletion {
                    session_id: session.clone(),
                    message_id: "finished-task".into(),
                },
            )
            .await?
            .ok_or("steering notification was not queued")?;
        let view = driver.state.frontier(run).await?;
        let mut pending = driver
            .model()?
            .prepare_step(
                &view,
                Preparation::Steering {
                    attempt: first_attempt,
                },
                driver,
            )
            .await?;
        let body = ContentBlob::json(&pending.request)?;
        pending.contents.push(body.clone());
        let delivery = Change::new(
            Fact::StepPrepared {
                step: pending.request.step,
                request: body.reference().clone(),
                adjudications: vec![],
            },
            at(),
        );
        let anchor = delivery.id;
        driver
            .state
            .append_steering(
                driver.access.claim(),
                (&view).into(),
                vec![delivery],
                pending.contents,
                pending
                    .steering
                    .ok_or("steering was not prepared for delivery")?,
            )
            .await?;

        let recall = owner
            .durable
            .recall(view.spec.owner.clone(), owner.prefix.clone())?;
        let original_position = RowPosition {
            source_sequence: recall
                .capture(session.clone(), None)
                .await?
                .through_sequence,
            item_index: 0,
        };
        let summary_text = "The earlier turn is ready to continue.";
        let (summary, _) = rig
            .record_model_reply(Preparation::Summary, Some(summary_text))
            .await?;
        let capture: RequestSource = serde_json::from_slice(
            &driver
                .state
                .content(run, summary.source_capture.clone())
                .await?,
        )?;
        let baseline = ContentBlob::json(&CompactedContext {
            summary_origin: None,
            source_capture: summary.source_capture,
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::MidTurn {
                    anchor_event_id: anchor.to_string(),
                },
                covered_through: capture.current.through_sequence,
                source_digest: summary.source_digest,
                previous_checkpoint_id: None,
                summary: CheckpointContent::Text(summary_text.into()),
                summary_step_id: summary.step,
            },
            native: None,
        })?;
        rig.append(
            vec![Fact::ContextCompacted {
                baseline: baseline.reference().clone(),
            }],
            vec![baseline],
        )
        .await?;

        let engine = Engine::new(driver.state.clone());
        let mut changes = driver.state.subscribe()?;
        let exit = loop {
            changes.borrow_and_update();
            let exit = engine
                .drive(
                    driver.access.claim().clone(),
                    driver.clone(),
                    CancellationToken::new(),
                )
                .await?;
            if !matches!(exit, DriverExit::Waiting { .. }) {
                break exit;
            }
            changes.changed().await?;
        };
        if !matches!(
            exit,
            DriverExit::Terminal {
                terminal: Terminal::Completed,
                ..
            }
        ) {
            let view = driver.state.frontier(run).await?;
            return Err(format!(
                "compacted run returned {exit:?}; model interruption: {:?}",
                view.current_attempt
                    .and_then(|id| view.attempts.get(&id))
                    .and_then(|attempt| attempt.interrupted.as_deref()),
            )
            .into());
        }
        assert_eq!(
            posts.load(Ordering::SeqCst),
            1,
            "the compacted request must reach the provider"
        );

        let check_recall = async || -> TestResult<()> {
            let batch = recall
                .search(
                    SearchQuery {
                        terms: vec![steering_text.into()],
                        session_id: Some(session.clone()),
                        since: None,
                        until: None,
                        exclude: None,
                        limit: None,
                    },
                    0,
                    0,
                    CancellationToken::new(),
                )
                .await?;
            let indexed: Vec<_> = batch
                .hits
                .into_iter()
                .map(|hit| (hit.anchor.message_id, hit.anchor.position))
                .collect();
            assert_eq!(
                indexed,
                vec![(notification.message_id.clone(), original_position)]
            );
            Ok(())
        };
        check_recall().await?;
        recall.rebuild(session.clone()).await?;
        check_recall().await?;

        let client = rig.client.as_ref().unwrap();
        let fork = model_recovery::call(
            client,
            "agent",
            "fork",
            json!({
                "sessionId": session,
                "expectedRevision": owner.session(&session).await?.revision,
                "position": ForkPosition::ThroughSourceTurn {
                    position: HistoryRowAddress::Live {
                        sequence: original_position.source_sequence,
                        fact: anchor,
                        item_index: original_position.item_index,
                    },
                },
                "title": "Fork through delivered steering",
                "labels": [],
            }),
        )
        .await?;
        let ForkResult::Forked { session: fork } = serde_json::from_value(fork.clone())? else {
            return Err(format!("steering fork was rejected: {fork}").into());
        };
        let through = recall
            .capture(fork.id.clone(), None)
            .await?
            .through_sequence;
        let found = model_recovery::call(
            client,
            "agent",
            "search",
            json!({
                "sessionId": fork.id,
                "through": through,
                "query": steering_text,
                "caseSensitive": true,
                "wholeWord": false,
                "includeInternal": false,
            }),
        )
        .await?;
        let matches = found["matches"]
            .as_array()
            .ok_or("fork search returned no match list")?;
        assert_eq!(matches.len(), 1, "{found}");
        assert_eq!(matches[0]["preview"], steering_text);
        let position: HistoryRowAddress = serde_json::from_value(matches[0]["position"].clone())?;
        assert!(
            matches!(
                position,
                HistoryRowAddress::Snapshot { sequence, fact, item_index, .. }
                    if sequence == original_position.source_sequence
                        && fact == anchor
                        && item_index == original_position.item_index
            ),
            "fork search did not return the original steering position: {position:?}"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    };
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), test))
        .catch_unwind()
        .await;
    stop.cancel();
    let served = server.await;
    let cleanup = rig.finish().await;
    assert!(matches!(&outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(matches!(served, Ok(Ok(()))), "{served:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

mod preset_test_gate {
    use super::*;
    use maka_host_runtime::application::{Context, HandlerResult};
    type Pause = (String, oneshot::Sender<oneshot::Sender<()>>);
    // Pause after domain preparation, before Host commits the statement and receipt.
    #[derive(Default)]
    pub(super) struct Gate(StdMutex<Option<Pause>>);
    impl Gate {
        pub(super) fn arm(&self, method: &str) -> oneshot::Receiver<oneshot::Sender<()>> {
            let (send, receive) = oneshot::channel();
            assert!(
                self.0
                    .lock()
                    .unwrap()
                    .replace((method.into(), send))
                    .is_none()
            );
            receive
        }
    }
    pub(super) struct HandlerGate {
        pub inner: Arc<dyn Handler>,
        pub gate: Arc<Gate>,
    }
    impl Handler for HandlerGate {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> futures_util::future::BoxFuture<'static, HandlerResult> {
            let inner = self.inner.clone();
            let gate = self.gate.clone();
            Box::pin(async move {
                let result = inner.call(method.clone(), input, context).await;
                let paused = {
                    let mut pending = gate.0.lock().unwrap();
                    if pending
                        .as_ref()
                        .is_some_and(|(target, _)| target == &method)
                    {
                        pending.take()
                    } else {
                        None
                    }
                };
                if let Some((_, ready)) = paused {
                    let (release, wait) = oneshot::channel();
                    if ready.send(release).is_ok() {
                        let _ = wait.await;
                    }
                }
                result
            })
        }
    }
}
