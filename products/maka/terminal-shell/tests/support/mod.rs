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

use futures_util::stream;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response,
    body::{Bytes, Frame, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_app_client::{Client, Journal};
use maka_capabilities::call::Attachments;
use maka_event_log::{
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        Handler, NativeActivation, NativeRegistry,
        host::{Client as HostClient, Configuration, Host, discovery::Registration},
        transport::{Grant, HostEndpoint, NativeGrant, wire},
    },
    ipc::{self, LocalListener},
};
use maka_packages::Package;
use maka_plugin_core::{
    composition::InstanceId,
    operation::{OperationOutcome, Receipt, receipt_reader_contract},
    runtime::Published,
};
use nsh_platform_tui::{AppOptions, AppView};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::{Notify, mpsc},
    task::{JoinHandle, JoinSet},
};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};
use uuid::Uuid;

pub const EDITOR: &str = "composer";
pub const PROVIDER_KEY: &str = "nsh-real-provider-key";

fn frame_time() -> f64 {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    STARTED.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn load_application(view: &mut AppView) {
    view.load(maka_terminal_shell::entry::application_bundle().into())
        .unwrap();
    // load resets Surface; seed its clock before poll can apply an animation.
    view.surface_mut().tick(frame_time());
}

pub fn tick(view: &mut AppView) {
    view.tick(frame_time()).unwrap();
}

#[cfg(unix)]
pub mod pty;

/// A real Agent, settings store and public Host gateway, without the old UI.
pub struct Fixture {
    pub address: PathBuf,
    pub store: Arc<RootStore>,
    pub base_url: String,
    pub session: String,
    pub selection: Value,
    pub requests: mpsc::Receiver<ModelRequest>,
    pub request_count: Arc<AtomicUsize>,
    pub discovery_count: Arc<AtomicUsize>,
    registration: Option<Registration>,
    host: Arc<Host>,
    server: JoinHandle<Result<(), String>>,
    provider: AbortOnDropHandle<()>,
    // Registration must be removed while its original Root still exists on failure.
    pub directory: tempfile::TempDir,
}

#[derive(Clone, Copy)]
enum InitialCatalog {
    Configured { reasoning: bool },
    Empty,
}

impl Fixture {
    pub async fn oauth(authentication: Arc<dyn Handler>) -> Self {
        Self::open_with_services(
            false,
            false,
            InitialCatalog::Configured { reasoning: false },
            false,
            Some(authentication),
            None,
            false,
        )
        .await
    }
    pub async fn open() -> Self {
        Self::open_with_options(
            false,
            false,
            InitialCatalog::Configured { reasoning: false },
        )
        .await
    }
    pub async fn reasoning_models() -> Self {
        Self::open_with_options(false, false, InitialCatalog::Configured { reasoning: true }).await
    }
    #[cfg(not(unix))]
    pub async fn empty_settings() -> Self {
        Self::open_with_options(false, false, InitialCatalog::Empty).await
    }
    pub async fn images() -> Self {
        Self::open_with_options(false, true, InitialCatalog::Configured { reasoning: false }).await
    }
    #[cfg(unix)]
    pub async fn registered() -> Self {
        Self::open_with_options(true, false, InitialCatalog::Configured { reasoning: false }).await
    }
    #[cfg(unix)]
    pub async fn registered_empty_settings() -> Self {
        Self::open_with_options(true, false, InitialCatalog::Empty).await
    }
    #[cfg(unix)]
    pub async fn registered_images() -> Self {
        Self::open_with_options(true, true, InitialCatalog::Configured { reasoning: false }).await
    }
    pub async fn plugin_settings() -> Self {
        Self::open_with_services(
            false,
            false,
            InitialCatalog::Configured { reasoning: false },
            true,
            None,
            None,
            false,
        )
        .await
    }
    pub async fn files(method: &str) -> Self {
        Self::open_with_services(
            false,
            false,
            InitialCatalog::Configured { reasoning: false },
            false,
            None,
            Some(json!({
                "name":"WorkspaceDocument", "description":"Use the actual workspace Files service.",
                "import":"files", "method":method, "result":"json", "confirmation":"preapproved",
                "presentation":format!("maka.workspace.Files@1/{method}")
            })),
            false,
        )
        .await
    }
    #[cfg(unix)]
    pub async fn terminals() -> Self {
        Self::open_with_services(
            false,
            false,
            InitialCatalog::Configured { reasoning: false },
            false,
            None,
            None,
            true,
        )
        .await
    }
    async fn open_with_options(registered: bool, images: bool, catalog: InitialCatalog) -> Self {
        Self::open_with_services(registered, images, catalog, false, None, None, false).await
    }
    async fn open_with_services(
        registered: bool,
        images: bool,
        catalog: InitialCatalog,
        plugins: bool,
        login_handler: Option<Arc<dyn Handler>>,
        file_tool: Option<Value>,
        terminals: bool,
    ) -> Self {
        let has_files = images || file_tool.is_some();
        let directory = tempfile::tempdir().unwrap();
        private_directory(directory.path()).unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let namespaces = if registered {
            RootNamespaces::for_current_account().unwrap()
        } else {
            RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            }
        };
        let owner =
            Arc::new(RootOwner::create(&directory.path().join("host"), &namespaces).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let selection = match catalog {
            InitialCatalog::Configured { reasoning } => {
                configure(owner.clone(), &base, images, reasoning).await
            }
            InitialCatalog::Empty => Value::Null,
        };
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let package = |id: &str,
                       implementation: &str,
                       configuration: Value,
                       imports: Value,
                       exports: Value| {
            Package::new(BTreeMap::from([(
                "maka.extension.json".into(),
                serde_json::to_vec(&json!({
                    "schemaVersion":1,"id":id,"application":{"entries":{"host":{
                        "implementation":{"kind":"native","implementation":implementation},
                        "configuration":configuration,"imports":imports,"exports":exports
                    }}}
                }))
                .unwrap(),
            )]))
            .unwrap()
        };
        let agent_contract = maka_agent_api::contract();
        let settings_contract = maka_settings_native::contract::contract();
        let authentication_contract = maka_settings_native::contract::authentication_contract();
        let setup_contract = maka_settings_native::contract::setup_contract();
        let receipts_contract = receipt_reader_contract();
        let files_contract = maka_workspace_api::files::contract();
        let processes_contract = maka_workspace_api::processes::contract();
        let terminal_contract = maka_workspace_api::terminal::contract();
        let management_contract =
            maka_plugin_core::deployment::management::deployment_manager_contract();
        let empty = json!({"type":"object","additionalProperties":false});
        let agent = package(
            "test.nsh.agent",
            maka_agent_api::IMPLEMENTATION,
            maka_agent_api::configuration_schema(),
            if has_files {
                json!({"files":{"contract":files_contract,"cardinality":{"kind":"one"}}})
            } else {
                json!({})
            },
            json!({"agent":{"contract":agent_contract,"availability":"required"}}),
        );
        let files = package(
            "test.nsh.files",
            maka_workspace_api::files::IMPLEMENTATION,
            empty.clone(),
            json!({}),
            json!({"files":{"contract":files_contract,"availability":"required"}}),
        );
        let processes = package(
            "test.nsh.processes",
            maka_workspace_api::processes::IMPLEMENTATION,
            maka_workspace_api::processes::configuration_schema(),
            json!({}),
            json!({
                "processes":{"contract":processes_contract,"availability":"required"},
                "terminal":{"contract":terminal_contract,"availability":"required"}
            }),
        );
        let settings = package(
            "test.nsh.settings",
            maka_settings_native::IMPLEMENTATION,
            serde_json::to_value(maka_settings_native::native().configuration).unwrap(),
            json!({}),
            json!({"Settings":{"contract":settings_contract,"availability":"required"}}),
        );
        let authentication = package(
            "test.nsh.authentication",
            if login_handler.is_some() {
                "test.nsh.oauth"
            } else {
                "maka.settings.authentication"
            },
            empty.clone(),
            json!({}),
            json!({"Authentication":{"contract":authentication_contract,"availability":"required"}}),
        );
        let setup = package(
            "test.nsh.setup",
            "maka.settings.setup",
            empty.clone(),
            json!({}),
            json!({"Setup":{"contract":setup_contract,"availability":"required"}}),
        );
        let receipts = package(
            "test.nsh.receipts",
            "maka.operations.receipts",
            empty.clone(),
            json!({}),
            json!({"Receipts":{"contract":receipts_contract,"availability":"required"}}),
        );
        let manager = package(
            "test.nsh.management",
            maka_host_runtime::application::management::DEPLOYMENT_MANAGER,
            empty.clone(),
            json!({}),
            json!({"Management":{"contract":management_contract,"availability":"required"}}),
        );
        let mut gateway_imports = json!({
            "agent":{"contract":agent_contract,"cardinality":{"kind":"one"}},
            "settings":{"contract":settings_contract,"cardinality":{"kind":"one"}},
            "authentication":{"contract":authentication_contract,"cardinality":{"kind":"one"}},
            "setup":{"contract":setup_contract,"cardinality":{"kind":"one"}},
            "receipts":{"contract":receipts_contract,"cardinality":{"kind":"one"}}
        });
        if plugins {
            gateway_imports["management"] =
                json!({"contract":management_contract,"cardinality":{"kind":"one"}});
        }
        if terminals {
            gateway_imports["terminal"] =
                json!({"contract":terminal_contract,"cardinality":{"kind":"one"}});
        }
        let gateway = package(
            "test.nsh.gateway",
            "maka.application.gateway",
            empty,
            gateway_imports,
            json!({}),
        );
        let node = |package: &Package, key: u128, configuration: Value, bindings: Value| {
            json!({
                "key":Uuid::from_u128(key),"package":{"source":"pinned","package":package.application_ref()},
                "usePackage":"entry","configuration":{"values":configuration},"bindings":bindings
            })
        };
        let deployment = Uuid::new_v4();
        let tools = if let Some(tool) = &file_tool {
            json!([tool])
        } else if images {
            json!([{"name":"Read","description":"Read an image in the selected workspace.","import":"files","method":"readImage","result":"image","confirmation":"preapproved"}])
        } else {
            json!([])
        };
        let permissions = if file_tool.is_some() {
            // File-tool workflows use the product's real fresh-installation
            // policy, so an allowed write exercises its default authority.
            let bundle = PathBuf::from(env!("OUT_DIR")).join("product");
            let source = std::fs::read_to_string(bundle.join("authoring/composition.mjs")).unwrap();
            let vm = maka_js_runtime::plugin::Vm::pure(Default::default()).unwrap();
            let module = vm.load("real-host-installation".into(), source).unwrap();
            let installation = module
                .call(
                    vec!["installation".into()],
                    vec![json!({"workspace":workspace,"helper":env!("CARGO_BIN_EXE_maka")})],
                )
                .await
                .unwrap();
            module.close().await.unwrap();
            vm.shutdown().await;
            installation["agent"]["permissions"].clone()
        } else {
            json!({"access":"read_only","requestPermissions":true})
        };
        let mut plan = json!({"environment":{"location":"host"},"instances":{
            "agent":node(&agent, 1, json!({"locale":"en","workspaceRoots":[{"label":"Workspace","path":workspace}],"tools":tools,"todo":true,"permissions":permissions}), if has_files { json!({"files":[{"kind":"instance","path":["files"],"export":"files"}]}) } else { json!({}) }),
            "settings":node(&settings, 2, json!({"workspaceLocations":{"agent":"agent","skills":null,"processes":if terminals { Some("processes") } else { None }}}), json!({})),
            "authentication":node(&authentication, 6, json!({}), json!({})),
            "setup":node(&setup, 7, json!({}), json!({})),
            "receipts":node(&receipts, 3, json!({}), json!({})),
            "gateway":node(&gateway, 4, json!({}), json!({
                "agent":[{"kind":"instance","path":["agent"],"export":"agent"}],
                "settings":[{"kind":"instance","path":["settings"],"export":"Settings"}],
                "authentication":[{"kind":"instance","path":["authentication"],"export":"Authentication"}],
                "setup":[{"kind":"instance","path":["setup"],"export":"Setup"}],
                "receipts":[{"kind":"instance","path":["receipts"],"export":"Receipts"}]
            }))
        }});
        if matches!(catalog, InitialCatalog::Empty) {
            let home = directory.path().join("assistant-home");
            std::fs::create_dir(&home).unwrap();
            plan["instances"]["agent"]["configuration"]["values"]["assistant"] =
                json!({"home":home});
        }
        if plugins {
            plan["instances"]["management"] = node(&manager, 8, json!({}), json!({}));
            plan["instances"]["gateway"]["bindings"]["management"] =
                json!([{"kind":"instance","path":["management"],"export":"Management"}]);
            let optional_roots: Vec<_> = (0..40)
                .map(|index| {
                    let path = directory
                        .path()
                        .join(format!("optional-workspace-{index:02}"));
                    std::fs::create_dir(&path).unwrap();
                    json!({"label":format!("Optional workspace {index:02}"),"path":path})
                })
                .collect();
            for index in 0..3 {
                let mut optional = node(
                    &agent,
                    9 + index,
                    json!({"locale":"en","workspaceRoots":if index == 2 { json!(optional_roots) } else { json!([{"label":"Workspace","path":workspace}]) },"tools":[],"todo":true,"permissions":{"access":"read_only","requestPermissions":true}}),
                    json!({}),
                );
                optional["disabled"] = json!(true);
                plan["instances"][format!("optional-agent-{index}")] = optional;
            }
        }
        let mut packages = vec![agent, settings, authentication, setup, receipts, gateway];
        if plugins {
            packages.push(manager);
        }
        if has_files {
            plan["instances"]["files"] = node(&files, 5, json!({}), json!({}));
            packages.push(files);
        }
        if terminals {
            plan["instances"]["processes"] = node(
                &processes,
                12,
                json!({
                    "filesystem":{"default":"write","rules":[],"denyGlobs":[]},
                    "network":"allowed",
                    "helper":env!("CARGO_BIN_EXE_maka"),
                    "sessionOwner":[Uuid::from_u128(1)]
                }),
                json!({}),
            );
            plan["instances"]["gateway"]["bindings"]["terminal"] =
                json!([{"kind":"instance","path":["processes"],"export":"terminal"}]);
            packages.push(processes);
        }
        let input = serde_json::from_value(plan).unwrap();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let mut native = NativeRegistry::default();
        let public_catalog = Arc::new(maka_product_native::catalog::Catalog::new(
            maka_product_native::catalog::Snapshot::bundled().unwrap(),
        ));
        if terminals {
            // Use the product's original factories; composition still admits
            // only the services explicitly installed in this fixture.
            maka_product_native::provide(&mut native, public_catalog).unwrap();
        } else {
            maka_agent_native::provide(&mut native, public_catalog.clone()).unwrap();
            maka_settings_native::provide(&mut native, public_catalog).unwrap();
        }
        if let Some(handler) = login_handler.clone() {
            let contract = authentication_contract.clone();
            native
                .insert(
                    "test.nsh.oauth".into(),
                    Arc::new(move |_, _| {
                        let contract = contract.clone();
                        let handler = handler.clone();
                        Box::pin(async move {
                            NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "Authentication".into(),
                                    Published {
                                        contract,
                                        value: handler,
                                    },
                                )])),
                                owner: Arc::new(()),
                            }
                        })
                    }),
                )
                .unwrap();
        }
        if has_files && !terminals {
            maka_files_native::provide(&mut native).unwrap();
        }
        let endpoint = |import: &str, methods: &[&str], recovery| HostEndpoint {
            consumer: InstanceId(vec![Uuid::from_u128(4)]),
            import: import.into(),
            grant: Grant {
                methods: methods.iter().map(|name| (*name).into()).collect(),
                recovery,
            },
        };
        let host = Host::open(
            store.clone(),
            deployment,
            native,
            None,
            Configuration::PublicHost {
                endpoints: BTreeMap::from([
                    (
                        "agent".into(),
                        endpoint(
                            "agent",
                            &[
                                "list",
                                "catalog",
                                "projects",
                                "directories",
                                "create",
                                "selectBackend",
                                "projectMcp",
                                "trustProjectMcp",
                                "globalInstructions",
                                "updateGlobalInstructions",
                                "metadata",
                                "markRead",
                                "changeSession",
                                "fork",
                                "send",
                                "stop",
                                "execution",
                                "queue",
                                "queueMessage",
                                "editQueue",
                                "work",
                                "pendingInteractions",
                                "interaction",
                                "respond",
                                "source",
                                "toolImage",
                                "attachmentImage",
                                "uploadAttachment",
                                "listFiles",
                                "watchFiles",
                                "readFile",
                                "gitStatus",
                                "gitDiff",
                                "checklist",
                                "watchChecklist",
                                "observe",
                                "history",
                                "historyLandmarks",
                                "watch",
                            ],
                            false,
                        ),
                    ),
                    (
                        "settings".into(),
                        endpoint(
                            "settings",
                            &[
                                "usage",
                                "models",
                                "resolveModel",
                                "updateModelSettings",
                                "connections",
                                "connection",
                                "providers",
                                "create",
                                "update",
                                "remove",
                                "credentialStatus",
                                "saveCredential",
                                "deleteCredential",
                                "setDefault",
                                "assistantPreferences",
                                "updateAssistantPreferences",
                                "network",
                                "updateNetwork",
                                "workspaceLocations",
                                "updateWorkspaceLocations",
                            ],
                            false,
                        ),
                    ),
                    (
                        "authentication".into(),
                        endpoint(
                            "authentication",
                            if login_handler.is_some() {
                                &["provider", "loginCredential"]
                            } else {
                                &["provider"]
                            },
                            false,
                        ),
                    ),
                    (
                        "setup".into(),
                        endpoint("setup", &["discoverModels"], false),
                    ),
                    ("receipts".into(), endpoint("receipts", &["read"], true)),
                ])
                .into_iter()
                .chain(plugins.then(|| {
                    (
                        "management".into(),
                        endpoint(
                            "management",
                            &["instances", "readSettings", "setEnabled", "configure"],
                            false,
                        ),
                    )
                }))
                .chain(terminals.then(|| {
                    (
                        "terminal".into(),
                        endpoint(
                            "terminal",
                            &[
                                "list",
                                "watchList",
                                "read",
                                "watch",
                                "readDisplay",
                                "readOutput",
                                "watchOutput",
                                "start",
                                "stop",
                                "acquire",
                                "control",
                                "release",
                            ],
                            false,
                        ),
                    )
                }))
                .collect(),
                native: if has_files {
                    vec![NativeGrant {
                        origin: InstanceId(vec![Uuid::from_u128(1)]),
                        consumer: InstanceId(vec![Uuid::from_u128(1)]),
                        provider: InstanceId(vec![Uuid::from_u128(5)]),
                        export: maka_workspace_api::files::EXPORT.into(),
                        methods: [file_tool
                            .as_ref()
                            .map_or("readImage", |tool| tool["method"].as_str().unwrap())
                            .into()]
                        .into_iter()
                        .collect(),
                        recovery: false,
                    }]
                } else {
                    vec![]
                },
                product_methods: Default::default(),
            },
        )
        .await
        .unwrap();
        let address = socket(directory.path(), "host");
        let local = LocalListener::bind(&address).unwrap();
        let registration = registered.then(|| host.publish_registration(&address, None).unwrap());
        let server = tokio::spawn({
            let host = host.clone();
            async move { host.serve_local(local, CancellationToken::new()).await }
        });
        let (send, requests) = mpsc::channel(8);
        let request_count = Arc::new(AtomicUsize::new(0));
        let discovery_count = Arc::new(AtomicUsize::new(0));
        let provider = AbortOnDropHandle::new(tokio::spawn({
            let count = request_count.clone();
            let discovery = discovery_count.clone();
            async move {
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let (stream, _) = accepted.unwrap(); let send = send.clone(); let count = count.clone(); let discovery = discovery.clone();
                            connections.spawn(async move {
                                ModelRequest::serve(stream, send, count, discovery).await;
                            });
                        }
                        Some(result) = connections.join_next(), if !connections.is_empty() => { result.unwrap(); }
                    }
                }
            }
        }));
        let mut fixture = Self {
            directory,
            address,
            store,
            base_url: base,
            session: String::new(),
            selection,
            requests,
            request_count,
            discovery_count,
            registration,
            host,
            server,
            provider,
        };
        if let InitialCatalog::Configured { .. } = catalog {
            let client = fixture.client().await;
            let roots = client
                .query("agent", "directories", json!({"kind":"roots"}))
                .await
                .unwrap();
            let created = mutate(&client, "create", json!({"title":"NSH real Agent", "labels":[], "workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
            fixture.session = created["session"]["id"].as_str().unwrap().to_owned();
            client.close().await.unwrap();
        }
        fixture
    }
    pub async fn client(&self) -> Client {
        self.client_at(&self.address).await
    }
    #[cfg(unix)]
    pub fn register_at(&mut self, address: &Path) {
        if let Some(registration) = self.registration.take() {
            registration.remove().unwrap();
        }
        self.registration = Some(self.host.publish_registration(address, None).unwrap());
    }
    pub async fn client_at(&self, address: &Path) -> Client {
        let host = HostClient::connect(address, Some(self.host.epoch()))
            .await
            .unwrap();
        assert!(
            host.catalogue()
                .describe("agent")
                .unwrap()
                .registration_epoch
                .is_some(),
            "{:?}",
            host.catalogue().startup_error()
        );
        Client::new(
            host,
            Journal::open(&self.directory.path().join("client.db"))
                .await
                .unwrap(),
            "receipts".into(),
        )
        .unwrap()
    }
    pub async fn next_request(&mut self) -> ModelRequest {
        tokio::time::timeout(Duration::from_secs(20), self.requests.recv())
            .await
            .unwrap()
            .unwrap()
    }
    pub async fn idle(&self, client: &Client, session: &str) {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let observed = client
                    .query("agent", "observe", json!({"sessionId":session}))
                    .await
                    .unwrap();
                if observed["session"]["activity"] == "idle" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("real Agent did not finish");
    }
    pub async fn seed_history(&mut self, turns: usize) {
        let client = self.client().await;
        for turn in 0..turns {
            let reply = mutate(&client, "send", json!({"sessionId":self.session,"message":format!("History question {turn:02}"),"model":self.selection})).await;
            assert_eq!(reply["kind"], "started", "{reply}");
            let mut request = self.next_request().await;
            let text: String = (0..30).map(|row| format!("History {turn:02} paragraph {row:02}: original provider text with **bold** and `code`.\n\n")).collect();
            request.delta(&text).await;
            request.finish().await;
            self.idle(&client, &self.session).await;
        }
        client.close().await.unwrap();
    }
    pub fn view(
        &self,
        client: Client,
        initial_session: Option<String>,
    ) -> (AppView, maka_terminal_shell::bindings::Bindings) {
        let bindings =
            maka_terminal_shell::bindings::Bindings::new(client, tokio::runtime::Handle::current());
        let registry = bindings.registry(initial_session);
        if let Some(directory) = std::env::var_os("MAKA_NSH_EVIDENCE") {
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join("host.d.ts"),
                nsh_core::ui::declarations(&registry, &[]),
            )
            .unwrap();
        }
        let mut view = AppView::new(AppOptions {
            size: evidence_size(),
            data_dir: Some(self.directory.path().join("nsh")),
            ui_sets: Some(vec![nsh_base::registry(), registry]),
            ..Default::default()
        });
        load_application(&mut view);
        view.surface_mut().set_assets(Some(bindings.assets()));
        (view, bindings)
    }
    pub async fn finish(self) {
        self.host.shutdown().await.unwrap();
        self.server.await.unwrap().unwrap();
        if let Some(registration) = self.registration {
            registration.remove().unwrap();
        }
        self.provider.abort();
        assert!(self.provider.await.unwrap_err().is_cancelled());
    }
}

async fn configure(owner: Arc<RootOwner>, base: &str, vision: bool, reasoning: bool) -> Value {
    use maka_agent_facts::configuration::CatalogMutationResult;
    let config = Arc::new(
        maka_config::ConfigurationStore::for_root(owner)
            .await
            .unwrap(),
    );
    let provider = json!({"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"});
    let mut overrides = json!({"fixture-model":{"contextWindow":200000,"vision":vision},"fixture-model-alt":{"contextWindow":200000,"vision":vision}});
    if reasoning {
        overrides["fixture-model"]["thinkingLevels"] = json!(["off", "low", "high"]);
        overrides["fixture-model"]["defaultThinkingLevel"] = json!("low");
        overrides["fixture-model-alt"]["thinkingLevels"] = json!(["off", "high"]);
        overrides["fixture-model-alt"]["defaultThinkingLevel"] = json!("high");
        overrides["fixture-model-unknown"] =
            json!({"contextWindow":200000,"vision":vision,"thinkingLevels":["off","high"]});
    }
    let enabled_models = if reasoning {
        json!([
            "fixture-model",
            "fixture-model-alt",
            "fixture-model-unknown"
        ])
    } else {
        json!(["fixture-model", "fixture-model-alt"])
    };
    let CatalogMutationResult::Committed {connection:Some(connection),..} = config.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":0,"connection":{"slug":"nsh-fixture","name":"NSH fixture","provider":provider,"configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":enabled_models,"modelOverrides":overrides}
    })).unwrap()).await.unwrap() else { panic!("create fixture connection") };
    let maka_config::oauth::enrollment::LoginPreparation::Ready(login) = config.prepare_oauth_login(serde_json::from_value(json!({
        "expectedCredential":null,"attemptId":Uuid::new_v4(),"target":{"kind":"existing","expected":{"connectionId":connection.connection_id,"revision":connection.revision,"provider":provider,"slug":"nsh-fixture","configuration":{"baseUrl":base}},"configuration":{"baseUrl":base}},
        "authentication":{"method":"api-key","input":{"apiKey":PROVIDER_KEY}}
    })).unwrap()).await.unwrap() else { panic!("fixture credential") };
    assert!(login.claim().await.unwrap());
    assert!(matches!(
        login
            .complete(
                maka_agent_facts::provider::Credential {
                    secret: PROVIDER_KEY.into(),
                    refresh_at: None
                },
                1
            )
            .await
            .unwrap(),
        maka_config::oauth::enrollment::LoginCompletion::Committed(_)
    ));
    assert!(matches!(config.set_default_target(serde_json::from_value(json!({"expectedCatalogRevision":config.catalog().await.unwrap().revision,"target":{"connectionId":connection.connection_id,"modelId":"fixture-model"}})).unwrap()).await.unwrap(), CatalogMutationResult::Committed {..}));
    let connection = config.catalog().await.unwrap().connections.remove(0);
    let selection = json!({"connectionId":connection.connection_id,"revision":connection.revision,"modelId":"fixture-model"});
    config.shutdown().await.unwrap();
    selection
}

pub async fn mutate(client: &Client, method: &str, input: Value) -> Value {
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            "agent",
            method,
            input,
            Attachments::new(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    mutation.prepare().await.unwrap();
    let reply = mutation.confirm().await.unwrap();
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        } => value,
        other => panic!("unexpected actual Host receipt: {other:?}"),
    }
}

pub struct ModelRequest {
    pub body: Value,
    response: mpsc::Sender<Bytes>,
    completed: Arc<Notify>,
}
type ModelBody = UnsyncBoxBody<Bytes, Infallible>;

impl ModelRequest {
    async fn serve(
        socket: TcpStream,
        requests: mpsc::Sender<Self>,
        count: Arc<AtomicUsize>,
        discovery: Arc<AtomicUsize>,
    ) {
        let completed = Arc::new(Notify::new());
        let notification = completed.clone();
        let service = service_fn(move |request: Request<Incoming>| {
            let requests = requests.clone();
            let count = count.clone();
            let discovery = discovery.clone();
            let completed = completed.clone();
            async move {
                assert_eq!(
                    request.headers()[hyper::header::AUTHORIZATION],
                    format!("Bearer {PROVIDER_KEY}")
                );
                if request.method() == Method::GET && request.uri().path() == "/v1/models" {
                    discovery.fetch_add(1, Ordering::SeqCst);
                    let body = Bytes::from_static(br#"{"data":[{"id":"fixture-discovered-model","reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","high","low","none"],"default_effort":"high"}}]}"#);
                    return Ok::<Response<ModelBody>, hyper::Error>(
                        Response::builder()
                            .header(hyper::header::CONTENT_TYPE, "application/json")
                            .body(Full::new(body).boxed_unsync())
                            .unwrap(),
                    );
                }
                assert_eq!(request.method(), Method::POST);
                assert_eq!(request.uri().path(), "/v1/chat/completions");
                let bytes = request.into_body().collect().await?.to_bytes();
                let body = serde_json::from_slice(&bytes).unwrap();
                let (response, receiver) = mpsc::channel(1);
                let events = stream::unfold(receiver, |mut receiver| async move {
                    receiver
                        .recv()
                        .await
                        .map(|bytes| (Ok::<_, Infallible>(Frame::data(bytes)), receiver))
                });
                count.fetch_add(1, Ordering::SeqCst);
                requests
                    .send(Self {
                        body,
                        response,
                        completed,
                    })
                    .await
                    .unwrap();
                Ok(Response::builder()
                    .header(hyper::header::CONTENT_TYPE, "text/event-stream")
                    .body(StreamBody::new(events).boxed_unsync())
                    .unwrap())
            }
        });
        // The provider's JoinSet owns the entire HTTP connection, including its
        // streamed response. Cancellation may close the client before [DONE].
        let result = http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(socket), service)
            .await;
        notification.notify_one();
        if let Err(error) = result {
            assert!(!error.is_parse(), "invalid fixture HTTP request: {error}");
        }
    }
    async fn packet(&mut self, value: Value) {
        let data = format!("data: {value}\n\n");
        // The Agent may cancel an in-flight response and close its HTTP body.
        let _ = self.response.send(Bytes::from(data)).await;
    }
    pub async fn delta(&mut self, text: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})).await;
    }
    pub async fn thinking(&mut self, text: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"reasoning_content":text},"finish_reason":null}]})).await;
    }

    pub async fn tool_prefix(&mut self, name: &str, input: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"nsh-native-todo-call","type":"function","function":{"name":name,"arguments":input}}]},"finish_reason":null}]})).await;
    }

    pub async fn tool_suffix(mut self, input: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":input}}]},"finish_reason":null}]})).await;
        self.finish_with_reason("tool_calls").await;
    }

    pub async fn tool(mut self, name: &str, input: Value) {
        self.tool_prefix(name, &input.to_string()).await;
        self.finish_with_reason("tool_calls").await;
    }

    pub async fn finish(self) {
        self.finish_with_reason("stop").await;
    }

    async fn finish_with_reason(mut self, reason: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}})).await;
        let _ = self
            .response
            .send(Bytes::from_static(b"data: [DONE]\n\n"))
            .await;
        drop(self.response);
        self.completed.notified().await;
    }
}

// A public accessibility frame chooses coordinates; real native mouse events act.
pub async fn wait_enabled_button(
    view: &mut AppView,
    label: &str,
) -> nsh_platform_tui::AccessibleNode {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            view.poll().unwrap();
            tick(view);
            assert!(view.last_error().is_none(), "{:?}", view.last_error());
            let mut buttons = view.accessibility_snapshot().into_iter().filter(|node| {
                node.role == nsh_core::AccessibilityRole::Button
                    && node.label == label
                    && node.frame.origin.y.0 >= 0.0
                    && node.frame.origin.y.0 < view.surface().viewport().height.0
            });
            let button = buttons.next();
            assert!(
                buttons.next().is_none(),
                "ambiguous native button {label:?}"
            );
            if let Some(button) = button
                && !button.state.disabled
            {
                return button;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("native button {label:?} did not become enabled"))
}

pub async fn click_button(view: &mut AppView, label: &str) {
    let node = wait_enabled_button(view, label).await;
    // Readiness refers to this native target, never to its identically labeled
    // static child. Send exactly one physical Down/Up after it is ready.
    click_node(view, node);
}

pub fn click_text(view: &mut AppView, prefix: &str) {
    let node = view
        .accessibility_snapshot()
        .into_iter()
        .filter(|node| node.label.starts_with(prefix) && node.frame.origin.y.0 >= 0.0)
        .max_by(|a, b| a.frame.origin.y.0.total_cmp(&b.frame.origin.y.0))
        .unwrap_or_else(|| panic!("no rendered native text starts with {prefix:?}"));
    click_node(view, node);
}

pub fn click_label(view: &mut AppView, label: &str) {
    let mut matching = view
        .accessibility_snapshot()
        .into_iter()
        .filter(|node| node.label == label && node.frame.origin.y.0 >= 0.0);
    let node = matching
        .next()
        .unwrap_or_else(|| panic!("no rendered native node has label {label:?}"));
    assert!(
        matching.next().is_none(),
        "ambiguous native label {label:?}"
    );
    click_node(view, node);
}

pub fn click_node(view: &mut AppView, node: nsh_platform_tui::AccessibleNode) {
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    // Native input uses cell centers; a half-cell origin must not select its exclusive far edge.
    let column = (node.frame.origin.x.0 / 8.0 - 0.5).ceil().max(0.0) as u16;
    let row = (node.frame.origin.y.0 / 16.0 - 0.5).ceil().max(0.0) as u16;
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        view.handle_event(Event::Mouse(MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
    }
}

// Hit rendered body text so nested scrolling is selected by the native pointer path.
pub fn scroll_text(view: &mut AppView, text: &str, kind: crossterm::event::MouseEventKind) {
    let snapshot = view.snapshot();
    scroll_snapshot_text(view, &snapshot, text, kind);
}

// The caller has just painted this scene and has not polled or ticked it since.
pub fn scroll_snapshot_text(
    view: &mut AppView,
    snapshot: &str,
    text: &str,
    kind: crossterm::event::MouseEventKind,
) {
    use crossterm::event::{Event, KeyModifiers, MouseEvent};
    let (row, line) = snapshot
        .lines()
        .enumerate()
        .find(|(_, line)| line.contains(text))
        .unwrap_or_else(|| panic!("no rendered native text contains {text:?}:\n{snapshot}"));
    let prefix = &line[..line.find(text).unwrap()];
    // Count rendered cells, including wide sidebar text sharing this row.
    let column = ratatui::text::Line::from(prefix).width() as u16;
    view.handle_event(Event::Mouse(MouseEvent {
        kind,
        column,
        row: row as u16,
        modifiers: KeyModifiers::NONE,
    }));
}

// Complete native focus navigation before Home and recording source coordinates.
pub async fn focus_activity(view: &mut AppView) {
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    view.handle_event(Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT)));
    tokio::time::timeout(Duration::from_secs(20), async {
        // An old activity List may already be focused. Observe this key's
        // engine commit before checking the native focus and animation state.
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control()
            .expect("the native app engine must be running")
            .advance_clock(Duration::ZERO, move || {
                let _ = done.send(());
            });
        committed
            .await
            .expect("the focus navigation engine stopped");
        loop {
            tick(view);
            if view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Turn activity" && node.focused)
                && !view.surface().animating()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "Alt+Down did not focus Turn activity: {error}; app error: {:?}; focus: {:?}\n{}",
            view.last_error(),
            view.surface().focused(),
            view.snapshot()
        )
    });
}

#[track_caller]
pub fn wait_view(
    view: &mut AppView,
    predicate: impl Fn(&str) -> bool,
) -> impl std::future::Future<Output = String> {
    wait_view_state(view, move |_, snapshot| predicate(snapshot))
}

#[track_caller]
pub fn wait_view_state(
    view: &mut AppView,
    predicate: impl Fn(&AppView, &str) -> bool,
) -> impl std::future::Future<Output = String> {
    let caller = std::panic::Location::caller();
    async move {
        let started = Instant::now();
        loop {
            view.poll().unwrap();
            tick(view);
            assert!(
                view.last_error().is_none(),
                "NSH app error at {caller}: {:?}",
                view.last_error()
            );
            let snapshot = view.snapshot();
            if predicate(view, &snapshot) {
                return snapshot;
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "expected real UI state did not appear at {caller}:\n{snapshot}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

// Read painted graphemes within the native Text frame, using the renderer's
// cell-center projection rather than flooring fractional layout coordinates.
pub fn painted_text(view: &AppView, prefix: &str, row: usize) -> String {
    use ratatui::{buffer::CellWidth, layout::Rect};
    let metrics = view.surface().metrics();
    let viewport = view.surface().viewport();
    let columns = (viewport.width.0 / metrics.width().0).round() as u16;
    let rows = (viewport.height.0 / metrics.height().0).round() as u16;
    let matches: Vec<_> = view
        .accessibility_snapshot()
        .into_iter()
        .filter(|node| {
            node.label.starts_with(prefix)
                && (node.frame.origin.y.0 / metrics.height().0 - 0.5).ceil() == row as f32
        })
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "expected one native Text {prefix:?} at row {row}"
    );
    let frame = matches[0].frame;
    let mut x = (frame.origin.x.0 / metrics.width().0 - 0.5)
        .ceil()
        .clamp(0.0, f32::from(columns)) as u16;
    let right = ((frame.origin.x.0 + frame.size.width.0) / metrics.width().0 - 0.5)
        .ceil()
        .clamp(0.0, f32::from(columns)) as u16;
    assert!(
        row < usize::from(rows) && x < right,
        "native Text must be visible"
    );
    let area = Rect::new(0, 0, columns, rows);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buffer);
    let mut text = String::new();
    while x < right {
        let cell = &buffer[(x, row as u16)];
        text.push_str(cell.symbol());
        x += cell.cell_width().max(1);
    }
    text.trim_end().to_owned()
}

#[track_caller]
pub fn wait_draft<'a>(
    client: &'a Client,
    session: &'a str,
    text: &'a str,
) -> impl std::future::Future<Output = ()> + 'a {
    let caller = std::panic::Location::caller();
    async move {
        let mut last = None;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                last = client.load_draft("agent", session, EDITOR).await.unwrap();
                if last.as_ref().is_some_and(|draft| draft.text == text) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "the editor did not persist its exact draft at {caller}: session={session:?}, expected={text:?}, actual={last:?}: {error}"
            )
        });
    }
}

fn evidence_size() -> (u16, u16) {
    if std::env::var_os("MAKA_NSH_EVIDENCE").is_none() {
        return (120, 36);
    }
    match std::env::var("MAKA_NSH_EVIDENCE_SIZE").as_deref() {
        Ok("80x24") => (80, 24),
        Ok("120x36") | Err(_) => (120, 36),
        Ok("120x40") => (120, 40),
        Ok(size) => panic!("unsupported evidence size: {size}"),
    }
}

pub fn evidence_cells(name: &str, view: &AppView) {
    use ratatui::{buffer::CellWidth, layout::Rect, style::Color};
    let Some(directory) = std::env::var_os("MAKA_NSH_EVIDENCE") else {
        return;
    };
    let viewport = view.surface().viewport();
    let metrics = view.surface().metrics();
    let columns = (viewport.width.0 / metrics.width().0).round() as u16;
    let rows = (viewport.height.0 / metrics.height().0).round() as u16;
    let area = Rect::new(0, 0, columns, rows);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buffer);
    let color = |value| match value {
        Color::Rgb(r, g, b) => json!({"rgb":[r,g,b]}),
        Color::Indexed(index) => json!({"indexed":index}),
        value => json!({"named":format!("{value:?}")}),
    };
    let cells: Vec<Vec<_>> = (0..rows).map(|y| (0..columns).map(|x| {
        let cell = &buffer[(x, y)];
        json!({"symbol":cell.symbol(),"width":cell.cell_width(),"fg":color(cell.fg),"bg":color(cell.bg),"modifier":cell.modifier.bits()})
    }).collect()).collect();
    let directory = PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}-{columns}x{rows}.cells.json")), serde_json::to_vec(&json!({
        "source":"NSH AppView::render / Ratatui Buffer","columns":columns,"rows":rows,"cellWidth":metrics.width().0,"cellHeight":metrics.height().0,"cells":cells
    })).unwrap()).unwrap();
}

pub fn evidence(name: &str, snapshot: &str) {
    if let Some(directory) = std::env::var_os("MAKA_NSH_EVIDENCE") {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("{name}.txt")), snapshot).unwrap();
    }
}

/// Withhold one real IPC result without manufacturing a Host fact or Agent effect.
pub struct ReplyGate {
    pub address: PathBuf,
    armed: Arc<AtomicUsize>,
    pub held: Arc<Notify>,
    release: Arc<Notify>,
    worker: JoinHandle<()>,
}
impl ReplyGate {
    pub fn start(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "send", "mutation", false, None)
    }
    pub fn global_instructions(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(
            directory,
            target,
            "updateGlobalInstructions",
            "mutation",
            false,
            None,
        )
    }
    pub fn directories(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "directories", "finished", false, None)
    }
    pub fn respond(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "respond", "mutation", false, None)
    }
    #[cfg(unix)]
    pub fn history(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "history", "finished", false, None)
    }
    #[cfg(unix)]
    pub fn disconnect_history(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "history", "finished", true, None)
    }
    #[cfg(unix)]
    pub fn disconnect_watch(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "watch", "item", true, None)
    }
    pub fn before_history(directory: &Path, target: PathBuf, cursor: Value) -> Self {
        Self::for_method(
            directory,
            target,
            "history",
            "finished",
            false,
            Some(cursor),
        )
    }
    fn for_method(
        directory: &Path,
        target: PathBuf,
        method: &'static str,
        reply: &'static str,
        disconnect: bool,
        before: Option<Value>,
    ) -> Self {
        // Keep the basename independent of RPC spelling: macOS expands /var
        // to /private/var before binding its bounded Unix socket path.
        static NEXT_GATE: AtomicUsize = AtomicUsize::new(0);
        let address = socket(
            directory,
            &format!("gate-{}", NEXT_GATE.fetch_add(1, Ordering::Relaxed)),
        );
        let mut listener = LocalListener::bind(&address).unwrap();
        let armed = Arc::new(AtomicUsize::new(0));
        let held = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let worker = tokio::spawn({
            let armed = armed.clone();
            let held = held.clone();
            let release = release.clone();
            async move {
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted=listener.accept()=> {
                            let downstream=accepted.unwrap(); let upstream=ipc::connect(&target).await.unwrap();
                            let armed=armed.clone(); let held=held.clone(); let release=release.clone(); let before=before.clone();
                            connections.spawn(async move {
                                let (down_read,mut down_write)=tokio::io::split(downstream);
                                let (up_read,mut up_write)=tokio::io::split(upstream);
                                let selected=Arc::new(AtomicBool::new(false)); let mark=selected.clone();
                                let up=async move {let mut reader=wire::Reader::new(down_read); while let Ok(value)=reader.read::<Value>().await {
                                    if value["endpoint"]=="agent" && value["method"]==method && before.as_ref().is_none_or(|cursor| value["input"]["position"]["kind"]=="before" && value["input"]["position"]["cursor"]==*cursor) {mark.store(true,Ordering::SeqCst);}
                                    if wire::write(&mut up_write,&value).await.is_err(){break;}
                                }
                                let _ = up_write.shutdown().await;
                                };
                                let down=async move {let mut reader=wire::Reader::new(up_read); while let Ok(value)=reader.read::<Value>().await {
                                    if selected.load(Ordering::SeqCst) && value["kind"]==reply && armed.try_update(Ordering::SeqCst, Ordering::SeqCst, |count| count.checked_sub(1)).is_ok() {
                                        held.notify_one();
                                        if disconnect { break; }
                                        release.notified().await;
                                    }
                                    if wire::write(&mut down_write,&value).await.is_err(){break;}
                                }
                                let _ = down_write.shutdown().await;
                                };
                                if disconnect {
                                    // Drop both physical relay halves. The real Host observes
                                    // a lost caller; no synthetic business result is inserted.
                                    tokio::select! { () = up => {}, () = down => {} }
                                } else {
                                    tokio::join!(up,down);
                                }
                            });
                        }
                        Some(result)=connections.join_next(),if !connections.is_empty()=>{result.unwrap();}
                    }
                }
            }
        });
        Self {
            address,
            armed,
            held,
            release,
            worker,
        }
    }
    pub fn arm(&self) {
        self.armed.store(1, Ordering::SeqCst);
    }
    #[cfg(unix)]
    pub fn arm_times(&self, count: usize) {
        self.armed.store(count, Ordering::SeqCst);
    }
    #[cfg(unix)]
    pub fn remaining(&self) -> usize {
        self.armed.load(Ordering::SeqCst)
    }
    pub fn release(&self) {
        self.release.notify_one();
    }
}
impl Drop for ReplyGate {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

fn socket(directory: &Path, name: &str) -> PathBuf {
    #[cfg(unix)]
    {
        directory.join(format!("{name}.sock"))
    }
    #[cfg(windows)]
    {
        let _ = directory;
        PathBuf::from(format!(r"\\.\pipe\maka-nsh-{name}-{}", Uuid::new_v4()))
    }
}
