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
use maka_agent_facts::interaction::InteractionRequest;
use nsh_engine::EngineConfig;
use std::path::{Path, PathBuf};

/// One pending request, bound to the same Host service scope as its conversation.
pub struct SystemPermissionWindow {
    key: String,
    config: EngineConfig,
    application: Option<PathBuf>,
}

impl SystemPermissionWindow {
    /// Stable source and request identity; reopening focuses its existing window.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// A separate NSH surface with the original Host bindings, not another workbench.
    pub fn configuration(&self) -> EngineConfig {
        self.config.clone()
    }

    /// Only the responsible application on this Mac may be offered for drag-out.
    pub fn application(&self) -> Option<&Path> {
        self.application.as_deref()
    }
}

pub(super) async fn open(
    owner: Arc<Owner>,
    source: ApplicationClient,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    let sender = owner
        .permission_windows
        .lock()
        .unwrap()
        .clone()
        .ok_or("This interface does not support a system-permission window")?;
    let client = source.resolve(&owner).await?;
    let record = system_permission::read(&client, &session_id, &request_id).await?;
    let InteractionRequest::SystemPermission {
        application_location,
        ..
    } = &record.request
    else {
        return Err("This request is not a system-permission setup".into());
    };
    if record.outcome.is_some() {
        return Err("This system-permission request has already finished".into());
    }
    let application = if system_permission::actions(&record, &owner.client.source().state_domain)
        .iter()
        .any(|action| action == "reveal_application")
    {
        application_location
            .as_ref()
            .map(|location| {
                location
                    .bundle_url()
                    .map_err(str::to_owned)?
                    .to_file_path()
                    .map_err(|_| "Invalid local permission application path".to_owned())
            })
            .transpose()?
    } else {
        None
    };
    let description = client.describe(AGENT).await?;
    let key = serde_json::to_string(&(
        client.source(),
        description.provider,
        description.export,
        description.registration_epoch,
        &session_id,
        &request_id,
    ))
    .map_err(|error| error.to_string())?;
    let source = ApplicationClient::Permission(client);
    let preferences = owner
        .client
        .query("settings", "assistantPreferences", serde_json::json!({}))
        .await?;
    let language = preferences
        .get("language")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| serde_json::json!("auto"));
    let language: maka_agent_facts::language::LanguagePreference =
        serde_json::from_value(language).map_err(|error| error.to_string())?;
    let revision = preferences["revision"]
        .as_u64()
        .ok_or("The Host returned an invalid language preference revision")?;
    let captured_owner = owner.clone();
    let registry = registry(move || {
        Instance::new(ApplicationHost {
            owner: captured_owner.clone(),
            client: source.clone(),
            initial_session: None,
        })
    });
    let mut config = crate::configuration(registry, owner.runtime.clone());
    config.app = crate::system_permission_bundle().into();
    config.assets = Some(Arc::new(assets::HostAssets(owner.clone())));
    config.host.set_params(serde_json::Map::from_iter([
        (
            "systemPermission".into(),
            serde_json::json!({"sessionId": session_id, "requestId": request_id}),
        ),
        (
            "languagePreference".into(),
            serde_json::json!({"preference": language, "revision": revision}),
        ),
    ]));
    sender
        .send(SystemPermissionWindow {
            key,
            config,
            application,
        })
        .map_err(|_| "The system-permission window is unavailable".to_owned())
}
