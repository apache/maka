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
    pub guide: Option<PermissionGuide>,
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
    let config = configuration(
        &owner,
        source,
        "systemPermission",
        serde_json::json!({"sessionId":session_id,"requestId":request_id,"request":record.request}),
    )
    .await?;
    sender
        .send(SystemPermissionWindow {
            key,
            config,
            application,
            guide: None,
        })
        .map_err(|_| "The system-permission window is unavailable".to_owned())
}

async fn configuration(
    owner: &Arc<Owner>,
    source: ApplicationClient,
    parameter: &str,
    value: JsonValue,
) -> Result<EngineConfig, String> {
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
    let resolved_language = preferences
        .get("resolvedLanguage")
        .and_then(serde_json::Value::as_str);
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
    let mut params = serde_json::Map::new();
    params.insert("languagePreference".into(), serde_json::json!({"preference": language, "revision":revision,"resolvedLanguage":resolved_language}));
    params.insert(parameter.into(), value);
    config.host.set_params(params);
    Ok(config)
}

/// A settings guide is scoped to one observation on the admitted connection.
#[derive(Clone)]
pub struct PermissionGuide {
    pub id: Uuid,
    subject: String,
    grant: String,
    live: tokio::sync::watch::Sender<bool>,
    valid: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl PermissionGuide {
    pub fn active(&self) -> bool {
        if !(self.valid)() {
            self.close();
        }
        *self.live.borrow()
    }
    pub fn close(&self) {
        self.live.send_replace(false);
    }
    pub async fn closed(&self) {
        let _ = self.live.subscribe().wait_for(|live| !*live).await;
    }
    pub(super) fn matches(&self, subject: &str, grant: &str) -> bool {
        self.subject == subject && self.grant == grant
    }
    pub(super) fn begin(
        slot: &StdMutex<Option<Self>>,
        subject: &str,
        grant: &str,
        valid: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        let guide = Self {
            valid,
            id: Uuid::new_v4(),
            subject: subject.into(),
            grant: grant.into(),
            live: tokio::sync::watch::channel(true).0,
        };
        if let Some(old) = slot.lock().unwrap().replace(guide.clone()) {
            old.close();
        }
        guide
    }
}

pub(super) async fn show_guide(
    owner: &Arc<Owner>,
    source: ApplicationClient,
    guide: PermissionGuide,
    name: String,
    application: Option<PathBuf>,
) -> Result<(), String> {
    let sender = owner.permission_windows.lock().unwrap().clone();
    let sender = sender.ok_or("Desktop permission guide window is unavailable")?;
    let application = application
        .filter(|p| p.is_absolute() && p.extension().is_some_and(|ext| ext == "app") && p.is_dir());
    let config = configuration(
        owner,
        source,
        "settingsGuide",
        serde_json::json!({"application":name,"grant":guide.grant}),
    )
    .await?;
    if let Some(path) = application.clone() {
        let alive = guide.clone();
        config.host.handle("permissionGuide.reveal", move |call| {
            if !alive.active() {
                call.reject("Permission guide expired");
                return;
            }
            match std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&path)
                .status()
            {
                Ok(status) if status.success() => call.resolve(JsonValue::Null),
                _ => call.reject("Finder could not reveal the application"),
            }
        });
    }
    if guide.active() {
        sender
            .send(SystemPermissionWindow {
                key: guide.id.to_string(),
                config,
                application,
                guide: Some(guide),
            })
            .map_err(|_| "Permission guide unavailable")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn replacement_and_disconnect_invalidate_previous_drag_source() {
        let slot = StdMutex::default();
        let first = PermissionGuide::begin(&slot, "host", "screen_recording", Arc::new(|| true));
        let second = PermissionGuide::begin(&slot, "desktop", "accessibility", Arc::new(|| true));
        first.closed().await;
        assert!(!first.active());
        assert!(second.active());
        assert!(!second.matches("host", "accessibility"));
        slot.lock().unwrap().take().unwrap().close();
        second.closed().await;
        assert!(!second.active());
    }
}
