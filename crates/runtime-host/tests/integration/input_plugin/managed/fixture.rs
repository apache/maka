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
use maka_plugins::{composition::Scope, storage::Namespace};
pub(super) use maka_protocol::message::{ExecutionResolution, SubmitResult};
use maka_runtime_host::session::{PreparedSession, SessionModel, SessionTarget};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
pub(super) struct Manager {
    pub pauses: mpsc::UnboundedSender<oneshot::Sender<()>>,
    publisher: Arc<std::sync::Mutex<Option<maka_plugins::contributions::Publisher>>>,
}
impl Manager {
    pub(super) fn new(pauses: mpsc::UnboundedSender<oneshot::Sender<()>>) -> Self {
        Self {
            pauses,
            publisher: Default::default(),
        }
    }
    pub(super) fn replace_behavior(&self) -> maka_plugins::contributions::Registration {
        let publisher = self.publisher.lock().unwrap().clone().unwrap();
        publisher
            .withdraw::<session::SessionBehavior>("example.review")
            .unwrap();
        let mut staged = Staged::default();
        staged
            .insert(
                "example.review",
                session::SessionBehavior::new(Arc::new(self.clone()))
                    .with_native_input(session::NativeInputPolicy::NativeUserMessages),
            )
            .unwrap();
        publisher.publish(staged).unwrap()
    }
}
impl Plugin for Manager {
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        *self.publisher.lock().unwrap() = Some(context.contributions);
        let owner = Arc::new(self.clone());
        Box::pin(async move {
            let mut staged = Staged::default();
            staged
                .insert(
                    "example.review",
                    session::SessionBehavior::new(owner.clone())
                        .with_native_input(session::NativeInputPolicy::NativeUserMessages),
                )
                .unwrap();
            for name in ["example.denied", "example.review:plan"] {
                staged
                    .insert(name, session::SessionBehavior::new(owner.clone()))
                    .unwrap();
            }
            staged
                .insert("example.prepare", input::InputPreparation(owner))
                .unwrap();
            Ok(staged)
        })
    }
}
impl session::Behavior for Manager {
    fn prepare(&self, _: session::Request) -> BoxFuture<'_, Result<session::Preparation, String>> {
        Box::pin(async { Ok(session::Preparation::default()) })
    }
}
impl input::Provider for Manager {
    fn prepare(
        &self,
        request: input::Request,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> BoxFuture<'static, Result<input::Outcome, maka_plugins::Error>> {
        let pauses = self.pauses.clone();
        Box::pin(async move {
            if request.content.text == "pause" {
                let (release, paused) = oneshot::channel();
                pauses.send(release).unwrap();
                let _ = paused.await;
            }
            Ok(input::Outcome::Ready {
                content: request.content,
                receipt: json!({"selections":request.selections}),
                required_tools: Default::default(),
                basis: None,
            })
        })
    }
}
pub(super) fn setup(manager: &Manager) -> Setup {
    let mut plugins = super::super::setup(&Business::default());
    plugins.builtins.insert(
        "example".into(),
        Arc::new(Definition {
            id: "example".into(),
            revision: "binary".into(),
            dependencies: vec![],
            inject: vec![],
            plugin: Arc::new(manager.clone()),
        }),
    );
    plugins
}
pub(super) async fn seed(fixture: &ClientFixture, model: &SessionModel) {
    let log = fixture.log().await;
    for (id, manager, scope, behavior) in [
        ("managed", "example", Scope::Profile, "example.review"),
        ("paused", "example", Scope::Profile, "example.review"),
        ("ordinary", "", Scope::Profile, "example.review"),
        ("denied", "example", Scope::Profile, "example.denied"),
        ("plan", "example", Scope::Profile, "example.review"),
        ("wrong-owner", "foreign", Scope::Profile, "example.review"),
        (
            "wrong-scope",
            "example",
            Scope::Session("elsewhere".into()),
            "example.review",
        ),
        ("executor", "example", Scope::Profile, "example.review"),
        (
            "javascript",
            "example.javascript",
            Scope::Profile,
            "example.javascript",
        ),
    ] {
        let mut config = PreparedSession::new(
            serde_json::from_value(json!({
                "sessionId":id, "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"default"}, "orchestrationMode":behavior,
                "collaborationMode":if id == "plan" { "plan" } else { "agent" },
                "sandboxMode":"danger-full-access", "approvalPolicy":{"kind":"never"}
            }))
            .unwrap(),
        )
        .unwrap()
        .bind(
            maka_protocol::session::WorkspaceProjection {
                target: maka_protocol::session::WorkspaceTarget::HostPath {
                    path: fixture.workspace.to_string_lossy().into_owned(),
                },
                host_cwd: fixture.workspace.to_string_lossy().into_owned(),
            },
            model.clone(),
            maka_runtime::execution::SandboxMode::DangerFullAccess,
        );
        if id == "executor" {
            config.target = SessionTarget::Executor {
                executor_id: "example.executor".to_owned().try_into().unwrap(),
                settings: Default::default(),
            };
        }
        if manager.is_empty() {
            log.create_session(id, id, &config, 1).await.unwrap();
        } else {
            log.create_plugin_session(
                &maka_event_log::sessions::PluginSession {
                    session_id: id.into(),
                    creator: Namespace::new(manager, scope).unwrap(),
                    fingerprint: id.into(),
                    managed: true,
                    authority_session_id: None,
                },
                &config,
                1,
            )
            .await
            .unwrap();
        }
    }
    log.close().await.unwrap();
}
pub(super) fn submit(epoch: &Value, session: &str, id: &str, text: &str, placement: &str) -> Value {
    json!({"originHostEpoch":epoch,"sessionId":session,"messageId":id,"content":{"text":text},"placement":placement})
}
pub(super) async fn availability(peer: &mut Peer, session: &str) -> Value {
    peer.rpc(
        "session.catalog.query",
        json!({"kind":"get","sessionId":session}),
    )
    .await["result"]["session"]["nativeInput"]
        .clone()
}
pub(super) async fn complete(peer: &mut Peer, session: &str, turn: &Value) {
    loop {
        let response = peer
            .rpc("turn.query", json!({"sessionId":session,"turnId":turn}))
            .await;
        match response["result"]["status"].as_str() {
            Some("completed") => break,
            Some("failed" | "cancelled") => panic!("{response}"),
            _ => tokio::task::yield_now().await,
        }
    }
}

pub(super) fn submitted(response: &Value) -> SubmitResult {
    assert_eq!(response["ok"], true, "{response}");
    let maka_protocol::message::Output::Submit(result) = maka_protocol::message::decode_output(
        maka_protocol::Operation::TurnMessageSubmit,
        &response["result"],
    )
    .unwrap() else {
        unreachable!("submit output")
    };
    result
}
pub(super) fn resolutions(response: &Value) -> Vec<ExecutionResolution> {
    assert_eq!(response["ok"], true, "{response}");
    let maka_protocol::message::Output::Executions(result) = maka_protocol::message::decode_output(
        maka_protocol::Operation::TurnMessageExecutionQuery,
        &response["result"],
    )
    .unwrap() else {
        unreachable!("execution query output")
    };
    result.resolutions
}
pub(super) async fn catalog_changed(peer: &mut Peer) -> u64 {
    loop {
        let notice = peer.frame().await;
        if notice["kind"] == "session.catalog.changed" && notice["sessionId"].is_null() {
            return notice["revision"]
                .as_u64()
                .expect("catalog notice revision");
        }
    }
}

pub(super) async fn configure_target(
    commands: &dyn maka_plugins::execution::Commands,
    session: &str,
    target: maka_plugins::execution::Target,
) {
    let current = commands.session(session.into()).await.unwrap();
    assert_ne!(
        current.target, target,
        "fixture must change the captured configuration"
    );
    let result = commands
        .configure(maka_plugins::execution::Configure {
            session_id: session.into(),
            expected_revision: current.revision,
            target: target.clone(),
        })
        .await
        .unwrap();
    let maka_plugins::execution::Configured::Committed { session } = result else {
        panic!("configuration conflict: {result:?}");
    };
    assert!(session.revision > current.revision);
    assert_eq!(session.target, target);
}
