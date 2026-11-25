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

use super::{ApplicationClient, ApplicationHost, execute};
use maka_host_runtime::application::host::{
    PeerPairingOptions,
    protocol::{Request, Response},
    remote_access::RemoteAccessUpdate,
};
use nsh_core::{JsonValue, prelude::Instance};
use serde_json::{json, to_value};

pub(super) enum Action {
    Status,
    Pair,
    List,
    Revoke(String),
    Update(RemoteAccessUpdate),
}

pub(super) async fn update(
    this: Instance<ApplicationHost>,
    mut config: JsonValue,
    tokens: Vec<Option<String>>,
) -> Result<JsonValue, String> {
    let relays = config["relays"]
        .as_array_mut()
        .ok_or("missing relay configuration")?;
    if relays.len() != tokens.len() {
        return Err("relay credential inputs do not match relays".into());
    }
    for (relay, token) in relays.iter_mut().zip(tokens) {
        let auth = relay
            .get_mut("auth")
            .and_then(JsonValue::as_object_mut)
            .ok_or("missing relay credential action")?;
        if auth.contains_key("token") {
            return Err("relay credentials must use the private input".into());
        }
        match (auth.get("kind").and_then(JsonValue::as_str), token) {
            (Some("replace"), Some(token)) => {
                auth.insert("token".into(), token.into());
            }
            (Some("keep" | "clear"), None) => {}
            _ => return Err("invalid relay credential action".into()),
        }
    }
    let update = serde_json::from_value(config).map_err(|_| "invalid remote access settings")?;
    control(this, Action::Update(update)).await
}

pub(super) async fn control(
    this: Instance<ApplicationHost>,
    action: Action,
) -> Result<JsonValue, String> {
    let owner = this
        .with(|host| matches!(host.client, ApplicationClient::Root).then(|| host.owner.clone()))
        .ok_or("Remote Access requires the desktop's local Host")?;
    drop(this);
    let client = owner.client.clone();
    execute(owner, async move {
        let request = match action {
            Action::Status => Request::RemoteAccessStatus,
            Action::Pair => Request::PreparePeerPairing(PeerPairingOptions {
                host_name: "Maka Desktop".into(),
                label: None,
                ttl_secs: None,
            }),
            Action::List => Request::ListPeerAccess,
            Action::Revoke(peer_id) => Request::RevokePeerAccess { peer_id },
            Action::Update(update) => Request::UpdateRemoteAccess(update),
        };
        let response = client.local_owner_control(request).await?;
        match response {
            Response::RemoteAccessStatus(value) => to_value(value?),
            Response::RemoteAccessUpdated(value) => to_value(value?),
            Response::PeerPairingInvite(value) => to_value(value?),
            Response::PeerAccess(value) => to_value(
                value?
                    .into_iter()
                    .map(|peer| {
                        json!({
                            "peerId": peer.peer_id,
                            "label": peer.label,
                            "createdAt": peer.created_at,
                            "lastActiveAt": peer.last_active_at,
                        })
                    })
                    .collect::<Vec<_>>(),
            ),
            Response::Revoked(value) => to_value(value?),
            _ => return Err("unexpected Host remote access response".into()),
        }
        .map_err(|error| error.to_string())
    })
    .await
}
