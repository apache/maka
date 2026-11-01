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

use futures_util::{StreamExt, stream};
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
        NativeRegistry,
        host::{Client as HostClient, Configuration, Host},
    },
    ipc::{self, LocalListener},
};
use maka_packages::Package;
use maka_plugin_core::operation::{OperationOutcome, Receipt};
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
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
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

async fn product_packages() -> BTreeMap<String, Package> {
    tokio::task::spawn_blocking(|| {
        static PACKAGES: OnceLock<BTreeMap<String, Package>> = OnceLock::new();
        PACKAGES
            .get_or_init(|| {
                std::fs::read_dir(PathBuf::from(env!("OUT_DIR")).join("product/packages"))
                    .unwrap()
                    .map(|entry| {
                        let entry = entry.unwrap();
                        (
                            entry.file_name().into_string().unwrap(),
                            Package::read_from(&entry.path()).unwrap(),
                        )
                    })
                    .collect()
            })
            .clone()
    })
    .await
    .unwrap()
}

pub(super) async fn product_package(name: &'static str) -> Package {
    product_packages().await.remove(name).unwrap()
}

async fn product_installation(workspace: &Path, home: &Path) -> Value {
    let source = std::fs::read_to_string(
        PathBuf::from(env!("OUT_DIR")).join("product/authoring/composition.mjs"),
    )
    .unwrap();
    let vm = maka_js_runtime::plugin::Vm::pure(Default::default()).unwrap();
    let module = vm.load("real-host-installation".into(), source).unwrap();
    let installation = module
        .call(
            vec!["installation".into()],
            vec![json!({"workspace":workspace,"home":home,"helper":env!("CARGO_BIN_EXE_maka")})],
        )
        .await
        .unwrap();
    module.close().await.unwrap();
    vm.shutdown().await;
    installation
}

pub fn load_application(
    view: &mut AppView,
    bindings: &maka_workbench::bindings::Bindings,
    initial_session: Option<String>,
) {
    let registry = bindings.registry(initial_session);
    let mut config = maka_workbench::configuration(registry, tokio::runtime::Handle::current());
    config.assets = Some(bindings.assets());
    config.chunk_loader = Some(bindings.chunk_loader());
    config.context = config.context.with(bindings.reload());
    view.load_with_config(config).unwrap();
    // load resets Surface; seed its clock before poll can apply an animation.
    view.surface_mut().tick(frame_time());
}

pub fn tick(view: &mut AppView) {
    view.tick(frame_time()).unwrap();
}

pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub address: PathBuf,
    pub session: String,
    pub selection: Value,
    pub request_count: Arc<AtomicUsize>,
    requests: mpsc::Receiver<ModelRequest>,
    host: Arc<Host>,
    #[cfg(feature = "desktop-tests")]
    pub store: Arc<RootStore>,
    server: JoinHandle<Result<(), String>>,
    provider: AbortOnDropHandle<()>,
}

#[derive(Default)]
pub struct Options {
    pub images: bool,
}

impl Fixture {
    pub async fn open() -> Self {
        Self::configured(Options::default()).await
    }

    pub async fn configured(options: Options) -> Self {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(directory.path()).unwrap();
        private_directory(directory.path()).unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let owner = Arc::new(
            RootOwner::create(
                &directory.path().join("host"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let selection = configure(
            owner.clone(),
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            options.images,
        )
        .await;
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let bundled = product_packages().await;
        let home = directory.path().join("assistant-home");
        std::fs::create_dir(&home).unwrap();
        let mut configuration = product_installation(&workspace, &home).await;
        configuration["packages"] = serde_json::to_value(
            bundled
                .iter()
                .map(|(name, package)| (name, package.application_ref()))
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap();
        configuration["hostDeployment"] = json!(Uuid::new_v4());
        configuration["locale"] = json!("en");
        configuration["agent"]["tools"] = json!([]);
        configuration["agent"]["automaticTitles"] = json!(false);
        configuration["agent"]["recaps"] = json!(false);
        configuration["agent"]["permissions"] =
            json!({"access":"read_only","requestPermissions":true});

        let source = std::fs::read_to_string(
            PathBuf::from(env!("OUT_DIR")).join("product/authoring/composition.mjs"),
        )
        .unwrap();
        let vm = maka_js_runtime::plugin::Vm::pure(Default::default()).unwrap();
        let module = vm.load("test-product-composition".into(), source).unwrap();
        let names: Vec<String> = serde_json::from_value(
            module
                .call(
                    vec!["installationNames".into()],
                    vec![configuration.clone()],
                )
                .await
                .unwrap(),
        )
        .unwrap();
        configuration["keys"] = serde_json::to_value(
            names
                .into_iter()
                .map(|name| (name, Uuid::new_v4()))
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap();
        let authored = module
            .call(vec!["composition".into()], vec![configuration])
            .await
            .unwrap();
        module.close().await.unwrap();
        vm.shutdown().await;
        let deployment = serde_json::from_value(authored["deployment"].clone()).unwrap();
        store
            .commit_application(
                deployment,
                0,
                serde_json::from_value(authored["host"].clone()).unwrap(),
                vec![],
                bundled.into_values().collect(),
            )
            .await
            .unwrap();
        let mut native = NativeRegistry::default();
        maka_product_native::provide(
            &mut native,
            Arc::new(maka_product_native::catalog::Catalog::new(
                maka_product_native::catalog::Snapshot::bundled().unwrap(),
            )),
        )
        .unwrap();
        let host = Host::open(
            store.clone(),
            deployment,
            native,
            None,
            Configuration::PublicHost {
                endpoints: serde_json::from_value(authored["endpoints"].clone()).unwrap(),
                native: serde_json::from_value(authored["native"].clone()).unwrap(),
                product_methods: Default::default(),
            },
        )
        .await
        .unwrap();
        let address = socket(directory.path(), "host");
        let local = LocalListener::bind(&address).unwrap();
        let server = tokio::spawn({
            let host = host.clone();
            async move { host.serve_local(local, CancellationToken::new()).await }
        });
        let (send, requests) = mpsc::channel(8);
        let request_count = Arc::new(AtomicUsize::new(0));
        let provider = AbortOnDropHandle::new(tokio::spawn({
            let count = request_count.clone();
            async move {
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted=listener.accept()=> {let (stream,_)=accepted.unwrap(); let send=send.clone(); let count=count.clone(); connections.spawn(async move {ModelRequest::serve(stream,send,count).await;});},
                        Some(result)=connections.join_next(),if !connections.is_empty()=>{result.unwrap();}
                    }
                }
            }
        }));
        let mut fixture = Self {
            directory,
            address,
            session: String::new(),
            selection,
            request_count,
            requests,
            host,
            #[cfg(feature = "desktop-tests")]
            store,
            server,
            provider,
        };
        let client = fixture.client().await;
        let roots = client
            .query("agent", "directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        let created = mutate(&client,"create",json!({"title":"NSH real Agent","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        fixture.session = created["session"]["id"].as_str().unwrap().to_owned();
        client.close().await.unwrap();
        fixture
    }
    pub async fn client(&self) -> Client {
        self.client_at(&self.address).await
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
    pub fn view(
        &self,
        client: Client,
        session: Option<String>,
    ) -> (AppView, maka_workbench::bindings::Bindings) {
        let bindings =
            maka_workbench::bindings::Bindings::new(client, tokio::runtime::Handle::current());
        let mut view = AppView::new(AppOptions {
            size: (120, 36),
            data_dir: Some(self.directory.path().join("nsh")),
            ..Default::default()
        });
        load_application(&mut view, &bindings, session);
        (view, bindings)
    }
    pub async fn finish(self) {
        self.host.shutdown().await.unwrap();
        self.server.await.unwrap().unwrap();
        self.provider.abort();
        assert!(self.provider.await.unwrap_err().is_cancelled());
    }
}
pub(crate) async fn configure(owner: Arc<RootOwner>, base: &str, vision: bool) -> Value {
    use maka_agent_facts::configuration::CatalogMutationResult;
    let config = Arc::new(
        maka_config::ConfigurationStore::for_root(owner)
            .await
            .unwrap(),
    );
    let provider = json!({"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"});
    let overrides = json!({"fixture-model":{"contextWindow":200000,"vision":vision},"fixture-model-alt":{"contextWindow":200000,"vision":vision}});
    let enabled_models = json!(["fixture-model", "fixture-model-alt"]);
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
    response: mpsc::Sender<ModelReply>,
    completed: Arc<Notify>,
}
type ModelBody = UnsyncBoxBody<Bytes, Infallible>;

enum ModelReply {
    Event(Bytes),
    Rejected(Value),
}

fn model_http_error(body: Value) -> Response<ModelBody> {
    Response::builder()
        .status(hyper::StatusCode::BAD_REQUEST)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())).boxed_unsync())
        .unwrap()
}

impl ModelRequest {
    pub(crate) async fn serve(
        socket: TcpStream,
        requests: mpsc::Sender<Self>,
        count: Arc<AtomicUsize>,
    ) {
        let completed = Arc::new(Notify::new());
        let notification = completed.clone();
        let service = service_fn(move |request: Request<Incoming>| {
            let requests = requests.clone();
            let count = count.clone();
            let completed = completed.clone();
            async move {
                assert_eq!(
                    request.headers()[hyper::header::AUTHORIZATION],
                    format!("Bearer {PROVIDER_KEY}")
                );
                if request.method() == Method::GET && request.uri().path() == "/v1/models" {
                    let body = Bytes::from_static(br#"{"data":[{"id":"fixture-discovered-model","name":"Discovered UI Model","context_length":131072,"top_provider":{"max_completion_tokens":4096},"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","high","low","none"],"default_effort":"high"}}]}"#);
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
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                let (response, mut receiver) = mpsc::channel(1);
                count.fetch_add(1, Ordering::SeqCst);
                requests
                    .send(Self {
                        body,
                        response,
                        completed,
                    })
                    .await
                    .unwrap();
                let first = match receiver.recv().await {
                    Some(ModelReply::Event(bytes)) => Some(bytes),
                    Some(ModelReply::Rejected(body)) => return Ok(model_http_error(body)),
                    None => None,
                };
                let events = stream::iter(first)
                    .chain(stream::unfold(receiver, |mut receiver| async move {
                        receiver.recv().await.map(|reply| {
                            let ModelReply::Event(bytes) = reply else {
                                panic!("HTTP status cannot change after streaming starts");
                            };
                            (bytes, receiver)
                        })
                    }))
                    .map(|bytes| Ok::<_, Infallible>(Frame::data(bytes)));
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
        let _ = self
            .response
            .send(ModelReply::Event(Bytes::from(data)))
            .await;
    }
    pub async fn delta(&mut self, text: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})).await;
    }
    pub async fn thinking(&mut self, text: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"reasoning_content":text},"finish_reason":null}]})).await;
    }
    pub async fn finish(self) {
        self.finish_with_reason("stop").await;
    }
    /// Ends the reply with one call to `name`.
    #[cfg(feature = "desktop-tests")]
    pub async fn tool_call(mut self, name: &str, arguments: Value) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"nsh-real-call","type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":null}]})).await;
        self.finish_with_reason("tool_calls").await;
    }

    pub async fn http_error(self, body: Value) {
        self.response
            .send(ModelReply::Rejected(body))
            .await
            .unwrap();
        drop(self.response);
        self.completed.notified().await;
    }

    async fn finish_with_reason(mut self, reason: &str) {
        self.packet(json!({"id":"nsh-real-model","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}})).await;
        let _ = self
            .response
            .send(ModelReply::Event(Bytes::from_static(b"data: [DONE]\n\n")))
            .await;
        drop(self.response);
        self.completed.notified().await;
    }
}

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
                matches!(
                    node.role,
                    nsh_core::AccessibilityRole::Button | nsh_core::AccessibilityRole::Menuitem
                ) && node.label == label
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
    .unwrap_or_else(|_| {
        let buttons: Vec<_> = view
            .accessibility_snapshot()
            .into_iter()
            .filter(|node| {
                matches!(
                    node.role,
                    nsh_core::AccessibilityRole::Button | nsh_core::AccessibilityRole::Menuitem
                )
            })
            .map(|node| {
                (
                    node.id,
                    node.label.chars().take(160).collect::<String>(),
                    node.state.disabled,
                    node.frame,
                )
            })
            .collect();
        panic!(
            "native button {label:?} did not become enabled:\n{}\nbuttons={buttons:#?}",
            view.snapshot()
        )
    })
}

pub async fn click_button(view: &mut AppView, label: &str) {
    let node = wait_enabled_button(view, label).await;
    // Readiness refers to this native target, never to its identically labeled
    // static child. Send exactly one physical Down/Up after it is ready.
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

async fn gate_read<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let length = reader.read_u32().await? as usize;
    if length == 0 {
        return Err(std::io::Error::other("invalid gate frame length"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(body)
}

async fn gate_write<W: AsyncWrite + Unpin>(writer: &mut W, frame: &[u8]) -> std::io::Result<()> {
    writer.write_u32(frame.len() as u32).await?;
    writer.write_all(frame).await?;
    writer.flush().await
}

pub struct ReplyGate {
    pub address: PathBuf,
    armed: Arc<AtomicBool>,
    pub held: Arc<Notify>,
    release: Arc<Notify>,
    worker: JoinHandle<()>,
}
impl ReplyGate {
    pub fn resume(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "agent", "resume", "mutation")
    }
    pub fn resolve_model(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "settings", "resolveModel", "finished")
    }
    #[cfg(feature = "desktop-tests")]
    pub fn create(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "agent", "create", "mutation")
    }
    #[cfg(feature = "desktop-tests")]
    pub fn upload(directory: &Path, target: PathBuf) -> Self {
        Self::for_method(directory, target, "agent", "uploadAttachment", "mutation")
    }
    fn for_method(
        directory: &Path,
        target: PathBuf,
        endpoint: &'static str,
        method: &'static str,
        reply: &'static str,
    ) -> Self {
        let address = socket(directory, &format!("{endpoint}-{method}"));
        let mut listener = LocalListener::bind(&address).unwrap();
        let armed = Arc::new(AtomicBool::new(false));
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
                            let armed=armed.clone(); let held=held.clone(); let release=release.clone();
                            connections.spawn(async move {
                                let (down_read,mut down_write)=tokio::io::split(downstream);
                                let (up_read,mut up_write)=tokio::io::split(upstream);
                                let selected=Arc::new(AtomicBool::new(false)); let mark=selected.clone();
                                let up=async move {
                                    let mut reader=down_read;
                                    let mut opening=true;
                                    while let Ok(frame)=gate_read(&mut reader).await {
                                        if opening && let Ok(value)=serde_json::from_slice::<Value>(&frame)
                                            && value.get("endpoint").is_some() && value.get("method").is_some() {
                                            opening=false;
                                            if value["endpoint"]==endpoint && value["method"]==method {mark.store(true,Ordering::SeqCst);}
                                        }
                                        if gate_write(&mut up_write,&frame).await.is_err(){break;}
                                    }
                                    let _=up_write.shutdown().await;
                                };
                                let down=async move {
                                    let mut reader=up_read;
                                    while let Ok(frame)=gate_read(&mut reader).await {
                                        if selected.load(Ordering::SeqCst)
                                            && serde_json::from_slice::<Value>(&frame).is_ok_and(|value|value["kind"]==reply)
                                            && armed.swap(false,Ordering::SeqCst) {
                                            held.notify_one();
                                            release.notified().await;
                                        }
                                        if gate_write(&mut down_write,&frame).await.is_err(){break;}
                                    }
                                    let _=down_write.shutdown().await;
                                };
                                tokio::join!(up,down);
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
        self.armed.store(true, Ordering::SeqCst);
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
pub(super) fn socket(directory: &Path, name: &str) -> PathBuf {
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
