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

use super::{ClientFixture, SessionConfiguration};
use maka_client::Client;
use maka_event_log::{
    EventLog,
    sessions::{PluginSession, SessionCopy},
};
use maka_plugins::{composition::Scope, storage::Namespace};
use maka_protocol::{Operation, session::*};
use maka_runtime::{event::*, session::CopyPurpose};
use maka_runtime_host::session::{PreparedSession, SessionModel};
use serde_json::json;

pub(super) async fn seed(log: &EventLog, fixture: &ClientFixture) {
    let path =
        maka_fs_tools::workspace::project::host_path(&fixture.workspace.canonicalize().unwrap())
            .unwrap()
            .to_owned();
    let prepared = PreparedSession::new(
        serde_json::from_value(json!({
            "sessionId":"source","name":"Transferred title",
            "workspace":{"kind":"host_path","path":path},"modelTarget":{"kind":"default"},
            "sandboxMode":"danger-full-access","approvalPolicy":{"kind":"never"}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut config = prepared.bind(
        WorkspaceProjection {
            target: WorkspaceTarget::HostPath { path: path.clone() },
            host_cwd: path,
        },
        SessionModel {
            connection_id: "source-only".into(),
            connection_slug: "source-only".into(),
            model: "source-model".into(),
        },
        SandboxMode::DangerFullAccess,
    );
    config.instructions = Some("Source instructions are not destination authority".into());
    config.bound_tools = Some(["source-only-tool".into()].into());
    log.create_session("source", "source", &config, 1)
        .await
        .unwrap();
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
                content: "Retained conversation".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let revision = log
        .get_session::<SessionConfiguration>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.create_plugin_session(
        &PluginSession {
            session_id: "managed".into(),
            creator: Namespace::new("example.bundle", Scope::Profile).unwrap(),
            fingerprint: "managed".into(),
            managed: true,
            authority_session_id: Some("source".into()),
        },
        &config,
        2,
    )
    .await
    .unwrap();
    log.copy_session(
        SessionCopy {
            source_session_id: "source".into(),
            target_session_id: "child".into(),
            expected_source_revision: revision,
            purpose: CopyPurpose::Branch {
                turn_id: None,
                side_conversation: false,
            },
        },
        &config,
        2,
    )
    .await
    .unwrap();
}

pub(super) async fn configure(client: &Client) {
    let created = super::super::support::model_connection::create(
        client,
        "openai-compatible",
        "bundle",
        "http://127.0.0.1:1/v1",
        "unused-fixture",
        json!({"fixture-model":{}}),
    )
    .await;
    let id = &created["connection"]["connectionId"];
    client
        .request(
            Operation::ConnectionCatalogSetDefaultTarget,
            json!({
                "expectedCatalogRevision":created["catalogRevision"],
                "target":{"connectionId":id,"modelId":"fixture-model"}
            }),
        )
        .await
        .unwrap();
}

pub(super) async fn interrupt(log: &EventLog) {
    let invocation = Invocation {
        session_id: "managed".into(),
        turn_id: "interrupted".into(),
        run_id: "interrupted".into(),
        invocation_id: "interrupted".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "Interrupted work".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        Fact::ToolDispatched {
            operation_id: "uncertain".into(),
            call: maka_runtime::tool_call::ToolCallIdentity::standalone("uncertain".into()),
            name: "Shell".into(),
            input: json!({"command":"must not run again"}),
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
}

pub(super) async fn assert_interrupted(log: &EventLog) {
    let events = log
        .scoped_prefix(
            LogScope::Session {
                id: "managed".into(),
            },
            100,
            65536,
        )
        .await
        .unwrap();
    assert_eq!(
        events
            .events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
            .count(),
        1
    );
    assert!(
        !events
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
    );
    assert!(events.events.iter().any(|event| matches!(&event.event.fact,
        Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class, .. } } if class == "outcome_unknown")));
}
