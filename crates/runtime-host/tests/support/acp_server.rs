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

use super::{
    client_probe::ClientFixture,
    message_recovery::{ModelRequest, Provider, configure},
    peer::Peer,
};
use agent_client_protocol::schema::v2 as acp;
use maka_protocol::{
    subscription::{SubscriptionOpenInput, TranscriptPolicy},
    transcript::{SessionTranscriptPageDirection, SessionTranscriptPageInput},
};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct Fixture {
    pub _root: ClientFixture,
    pub workspace: PathBuf,
    pub database: PathBuf,
    pub provider: Provider,
    pub model_requests: mpsc::Receiver<ModelRequest>,
    pub client: maka_client::Client,
    pub notifications: mpsc::Receiver<maka_client::Notification>,
    pub stop: CancellationToken,
    pub _cleanup: tokio_util::sync::DropGuard,
    pub server: tokio::task::JoinHandle<Result<(), maka_runtime_host::server::HostError>>,
}

impl Fixture {
    pub async fn open() -> Self {
        let root = ClientFixture::new("maka-sdk-acp-");
        let (provider, model_requests) = Provider::controlled().await;
        let model = configure(&root, &provider.base_url).await;
        let owner = root.owner();
        let database = owner
            .canonical_path()
            .join(maka_event_log::root::ROOT_DATABASE);
        let host = Host::open(owner).await.unwrap();
        let (mut peer, hello) = Peer::handshake(host.clone(), "sdk-bootstrap").await;
        peer.wait_for_plugins().await;
        let created = peer.rpc("session.create", json!({
            "sessionId":"sdk-session","sandboxMode":"read-only","approvalPolicy":{"kind":"on-request"},
            "workspace":{"kind":"host_path","path":root.workspace},
            "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
        })).await;
        assert_eq!(created["ok"], true, "{created}");
        peer.close().await;
        #[cfg(unix)]
        let endpoint = root.workspace.parent().unwrap().join("sdk.sock");
        #[cfg(windows)]
        let endpoint = PathBuf::from(format!(r"\\.\pipe\maka-sdk-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host, stop.clone()),
        );
        let (client, notifications) = maka_client::Client::connect(
            maka_client::local::open_stream(&endpoint).await.unwrap(),
            hello["rootId"].as_str().unwrap(),
            hello["hostEpoch"].as_str().unwrap(),
            maka_client::Operations,
        )
        .await
        .unwrap();
        Self {
            workspace: root.workspace.clone(),
            database,
            _root: root,
            provider,
            model_requests,
            client,
            notifications,
            _cleanup: stop.clone().drop_guard(),
            stop,
            server,
        }
    }
}

pub async fn until_idle(
    receive: &mut mpsc::Receiver<acp::SessionUpdate>,
    updates: &mut Vec<acp::SessionUpdate>,
) -> Option<acp::StopReason> {
    loop {
        let update = receive
            .recv()
            .await
            .expect("SDK update stream closed before idle");
        let idle = match &update {
            acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(idle)) => {
                Some(idle.stop_reason.clone())
            }
            _ => None,
        };
        updates.push(update);
        if let Some(reason) = idle {
            return reason;
        }
    }
}

pub async fn canonical(client: &maka_client::Client) -> Vec<Value> {
    let opened = client
        .open_subscription(SubscriptionOpenInput {
            session_id: "sdk-session".into(),
            transcript: TranscriptPolicy::Tail { max_bytes: 16384 },
        })
        .await
        .unwrap();
    let through = opened.transcript.unwrap().durable.through_sequence;
    let page = client
        .transcript_page(SessionTranscriptPageInput {
            subscription_id: opened.subscription_id.clone(),
            direction: SessionTranscriptPageDirection::Older,
            through_sequence: through,
            anchor_sequence: None,
            cursor: None,
            max_bytes: maka_protocol::transcript::SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
        })
        .await
        .unwrap();
    let batch = client
        .complete_transcript_page(&opened.subscription_id, page)
        .await
        .unwrap();
    assert!(
        batch.next_cursor.is_none(),
        "acceptance history must fit the fixture's single page"
    );
    client
        .close_subscription(&opened.subscription_id)
        .await
        .unwrap();
    batch.rows.into_iter().map(|row| row.value).collect()
}

/// Apply the SDK's append/replacement contract, so replay is compared by actual
/// displayed message content and identity rather than notification counts.
pub fn messages(updates: &[acp::SessionUpdate]) -> BTreeMap<(String, String), String> {
    let mut messages = BTreeMap::<(String, String), String>::new();
    for update in updates {
        let value = serde_json::to_value(update).unwrap();
        let Some(id) = value["messageId"].as_str() else {
            continue;
        };
        let kind = value["sessionUpdate"].as_str().unwrap();
        let entry = messages
            .entry((kind.trim_end_matches("_chunk").into(), id.into()))
            .or_default();
        if kind.ends_with("_chunk") {
            entry.push_str(value["content"]["text"].as_str().expect("text fixture"));
        } else {
            *entry = value["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|block| block["text"].as_str().expect("text fixture"))
                .collect();
        }
    }
    messages
}
