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

use super::support::{client_probe::ClientFixture, peer::Peer};
use maka_event_log::sessions::SessionCopyResult;
use maka_protocol::session::{
    RevisionState, SandboxMode, WorkspaceProjection, WorkspaceTarget, copy, sources,
};
use maka_runtime::{
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    input::DeliveredMessage,
    message::{MessageDisposition, Placement, RootSourceMessage},
    session::{CopyPurpose, CopyRequest},
};
use maka_runtime_host::session::{
    PreparedSession, SessionConfiguration, SessionModel, catalog_projection,
};
use serde_json::json;

#[tokio::test]
async fn catalog_revisions_preserve_branch_origin_without_inheriting_execution_status() {
    let fixture = ClientFixture::new("maka-revision-catalog-");
    let cwd =
        maka_fs_tools::workspace::project::host_path(&fixture.workspace.canonicalize().unwrap())
            .unwrap()
            .to_owned();
    let configuration = PreparedSession::new(serde_json::from_value(json!({
        "sessionId":"source", "workspace":{"kind":"host_path","path":cwd},
        "modelTarget":{"kind":"explicit","connectionId":"fixture","connectionSlug":"fixture","model":"fixture"}
    })).unwrap()).unwrap().bind(
        WorkspaceProjection { target: WorkspaceTarget::HostPath { path: cwd.clone() }, host_cwd: cwd },
        SessionModel { connection_id: "fixture".into(), connection_slug: "fixture".into(), model: "fixture".into() },
        SandboxMode::DangerFullAccess,
    );
    let log = fixture.log().await;
    log.create_session("source", "source", &configuration, 1)
        .await
        .unwrap();
    let content: maka_runtime::input::MessageInput = "original".into();
    let invocation = Invocation {
        session_id: "source".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![RootSourceMessage {
                    unprepared_content: "unprepared source".into(),
                    message: DeliveredMessage {
                        message_id: "message".into(),
                        submitted_content_digest: content.content_digest().unwrap(),
                        content: content.clone(),
                    },
                    submitted_placement: Placement::CurrentTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: None,
                }],
                content,
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                class: "source_failure".into(),
                message: Some("source failure".into()),
            },
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    for (source, target, purpose) in [
        (
            "source",
            "branch",
            CopyPurpose::Branch {
                turn_id: Some("turn".into()),
                side_conversation: false,
            },
        ),
        (
            "branch",
            "revision",
            CopyPurpose::Revision {
                turn_id: "turn".into(),
            },
        ),
    ] {
        let source = log
            .get_session::<SessionConfiguration>(source)
            .await
            .unwrap()
            .unwrap();
        let result = log
            .copy_session(
                CopyRequest {
                    source_session_id: source.id,
                    target_session_id: target.into(),
                    expected_source_revision: source.revision,
                    purpose,
                },
                &configuration,
                2,
            )
            .await
            .unwrap();
        let SessionCopyResult::Committed(record) = result else {
            panic!("unexpected conflict")
        };
        let projected = catalog_projection(*record);
        maka_protocol::session::decode_session_catalog_projection(
            &serde_json::to_value(&projected).unwrap(),
        )
        .unwrap();
        assert_eq!(projected.parent_session_id.as_deref(), Some("source"));
        assert_eq!(projected.branch_of_turn_id.as_deref(), Some("turn"));
        assert_eq!(
            projected.status,
            maka_protocol::session::SessionStatus::Active
        );
        assert!(projected.live_run_state.is_none());
        if target == "revision" {
            assert_eq!(
                projected.revision_root_session_id.as_deref(),
                Some("branch")
            );
            assert_eq!(
                projected.revision_parent_session_id.as_deref(),
                Some("branch")
            );
            assert_eq!(projected.revision_of_turn_id.as_deref(), Some("turn"));
            assert_eq!(projected.revision_index, Some(2));
            assert_eq!(projected.revision_state, Some(RevisionState::Preparing));
        } else {
            assert!(projected.revision_state.is_none());
        }
    }
    log.close().await.unwrap();
    let host = maka_runtime_host::server::Host::open(fixture.owner())
        .await
        .unwrap();
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("revision.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-revision-{}", uuid::Uuid::new_v4()));
    let stop = tokio_util::sync::CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        maka_runtime_host::server::local::LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop.clone()),
    );
    // A catalog-only observer must hear retention even without a canonical
    // invocation or a Session/PTY subscription driving its connection loop.
    let mut observer = Peer::new(host.clone(), "revision-catalog").await;
    let (mut operator, hello) = Peer::handshake(host.clone(), "revision-shell").await;
    let (client, _notices) = maka_client::Client::connect(
        maka_client::local::open_stream(&endpoint).await.unwrap(),
        hello["rootId"].as_str().unwrap(),
        hello["hostEpoch"].as_str().unwrap(),
        maka_runtime_host::server::HostOperations,
    )
    .await
    .unwrap();
    let started = operator
        .rpc(
            "runtime.resource.start",
            json!({
                "sessionId":"revision", "launchId":"draft-shell", "command":"exit 0"
            }),
        )
        .await;
    assert_eq!(started["ok"], true, "{started}");
    loop {
        let notice = observer.frame().await;
        if notice["kind"] == "session.catalog.changed" && notice["sessionId"] == "revision" {
            break;
        }
    }
    let catalog = observer
        .rpc(
            "session.catalog.query",
            json!({"kind":"get", "sessionId":"revision"}),
        )
        .await;
    assert_eq!(
        catalog["result"]["session"]["revisionState"], "committed",
        "{catalog}"
    );
    let source = operator
        .rpc(
            "session.catalog.query",
            json!({"kind":"get", "sessionId":"source"}),
        )
        .await;
    let request = json!({
        "sourceSessionId":"source", "targetSessionId":"native-revision",
        "sourceTurnId":"turn", "expectedSourceRevision":source["result"]["session"]["revision"]
    });
    let input =
        copy::decode_input(maka_protocol::Operation::SessionRevisionCreate, &request).unwrap();
    assert!(
        client
            .query_session_copy(input.clone())
            .await
            .unwrap()
            .receipt
            .is_none()
    );
    let copied = client.copy_session(input.clone()).await.unwrap();
    assert!(
        matches!(&copied, copy::Output::Committed { session } if session.revision_state == Some(RevisionState::Preparing))
    );
    for session in ["source", "branch", "native-revision"] {
        let sources = client
            .session_turn_sources(sources::Input {
                session_id: session.into(),
                turn_id: "turn".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(sources).unwrap(),
            json!({
                "sessionId":session, "turnId":"turn", "messages":[{
                    "messageId":"message", "content":{"text":"unprepared source"}
                }]
            })
        );
    }
    let renamed = operator
        .rpc(
            "session.metadata.update",
            json!({
                "sessionId":"source", "expectedRevision":request["expectedSourceRevision"],
                "patch":{"name":"Changed after copy"}
            }),
        )
        .await;
    assert_eq!(renamed["result"]["kind"], "committed", "{renamed}");
    let receipt = client
        .query_session_copy(input.clone())
        .await
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(
        receipt.request, input,
        "receipt preserves its original source revision after a concurrent edit"
    );
    assert_eq!(receipt.state, maka_runtime::session::CopyState::Preparing);
    let replayed = client.copy_session(input.clone()).await.unwrap();
    assert_eq!(
        replayed, copied,
        "a lost reply must not recapture changed source settings"
    );
    let mut changed = request.clone();
    changed["sourceTurnId"] = json!("different-turn");
    let conflict = operator.rpc("session.revision.create", changed).await;
    assert_eq!(conflict["error"]["code"], "operation_conflict");
    let mut stale = request.clone();
    stale["targetSessionId"] = json!("stale-native-revision");
    let conflict = operator.rpc("session.revision.create", stale).await;
    assert_eq!(conflict["result"]["kind"], "source_revision_conflict");
    for _ in 0..2 {
        let abandoned = client
            .abandon_session_revision(copy::AbandonInput {
                target_session_id: "native-revision".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            abandoned,
            copy::AbandonOutput::Abandoned {
                session_id: "native-revision".into()
            }
        );
    }
    let abandoned_retry = operator.rpc("session.revision.create", request).await;
    assert_eq!(abandoned_retry["error"]["code"], "not_found");
    let tombstone = client
        .query_session_copy(input)
        .await
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(tombstone.request, receipt.request);
    assert_eq!(tombstone.state, maka_runtime::session::CopyState::Abandoned);
    let retained = client
        .abandon_session_revision(copy::AbandonInput {
            target_session_id: "revision".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        retained,
        copy::AbandonOutput::Retained {
            session_id: "revision".into()
        }
    );
    let side = client
        .copy_session(copy::Input {
            source_session_id: "source".into(),
            target_session_id: "empty-side".into(),
            expected_source_revision: renamed["result"]["session"]["revision"].as_u64().unwrap(),
            purpose: copy::Purpose::EmptySideConversation,
        })
        .await
        .unwrap();
    assert!(matches!(side, copy::Output::Committed { .. }));
    client.disconnect();
    observer.close().await;
    operator.close().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    drop(host);
    let log = fixture.log().await;
    let projection = catalog_projection(
        log.get_session::<SessionConfiguration>("revision")
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(projection.revision_state, Some(RevisionState::Committed));
    assert_eq!(projection.revision_index, Some(2));
    assert!(
        projection.live_run_state.is_none(),
        "retention is not a fabricated execution"
    );
    log.close().await.unwrap();
}
