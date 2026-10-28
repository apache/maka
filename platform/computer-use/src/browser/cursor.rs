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
use crate::cursor::Spec;

#[derive(Clone)]
pub(super) struct CursorEndpoint {
    transport: CursorTransport,
    provider: Provider,
    epoch: crate::desktop::NativeEpochId,
    cursor: Spec,
}

#[derive(Clone)]
enum CursorTransport {
    Cdp {
        socket: Cdp,
        frame: String,
        context: u64,
    },
    Fixed {
        cleanup_control: cua_driver_core::browser::ExtensionBrowserProvider,
        receipt: cua_driver_core::browser::ExtensionFixedSessionReceipt,
    },
}

#[derive(Clone, Copy)]
enum CursorOperation {
    Configure,
    Finalize,
}

impl CursorEndpoint {
    pub(super) fn fixed(
        cleanup_control: cua_driver_core::browser::ExtensionBrowserProvider,
        receipt: cua_driver_core::browser::ExtensionFixedSessionReceipt,
        provider: Provider,
        epoch: crate::desktop::NativeEpochId,
        cursor: &Spec,
    ) -> Result<Self, ToolError> {
        if receipt.generation()
            != provider
                .extension()
                .ok_or_else(|| failed("fixed UI requires a extension provider"))?
                .identity()
                .generation
            || receipt.ui_identity().cursor_id() != cursor.id
        {
            return Err(failed("fixed UI endpoint differs from its issued resource"));
        }
        Ok(Self {
            transport: CursorTransport::Fixed {
                cleanup_control,
                receipt,
            },
            provider,
            epoch,
            cursor: cursor.clone(),
        })
    }

    pub(super) fn epoch(&self) -> crate::desktop::NativeEpochId {
        self.epoch
    }

    pub(super) fn fixed_scope_id(&self) -> Option<&str> {
        match &self.transport {
            CursorTransport::Fixed { receipt, .. } => Some(receipt.scope_id()),
            CursorTransport::Cdp { .. } => None,
        }
    }

    pub(super) async fn extension_control(
        &mut self,
        cursor: &Spec,
        session: &str,
        turn: &str,
        running: bool,
        observed: bool,
    ) -> Result<(), ToolError> {
        let CursorTransport::Cdp {
            socket,
            frame: expected,
            context,
        } = &self.transport
        else {
            return Err(failed(
                "fixed extension UI requires a current admitted session operation",
            ));
        };
        let tree = socket.request("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        let current = format!(
            "{}:{}",
            frame["id"]
                .as_str()
                .ok_or_else(|| failed("extension overlay frame unavailable"))?,
            frame["loaderId"].as_str().unwrap_or_default()
        );
        if current != *expected {
            return if running {
                Err(failed("extension overlay document changed"))
            } else {
                Ok(())
            };
        }
        let operation = if running { "control" } else { "controlStop" };
        let input = json!({"cursor":cursor,"ownerEpoch":self.epoch.to_string(),"point":null,"action":"idle","operation":operation,"nativeControl":{"running":running,"observed":observed,"sessionId":session,"turnId":turn}});
        let value=socket.request("Runtime.evaluate",json!({"expression":format!("({})({input})",cua_driver_core::browser::FIXED_BROWSER_UI_SCRIPT),"contextId":context,"returnByValue":true,"awaitPromise":true})).await?;
        if value.get("exceptionDetails").is_some() {
            return Err(ToolError::CleanupUnconfirmed(
                "extension control overlay did not acknowledge its state".into(),
            ));
        }
        Ok(())
    }
    async fn execute(
        &mut self,
        identity: &TabIdentity,
        cursor: &Spec,
        operation: CursorOperation,
    ) -> Result<Option<crate::cursor::RenderState>, ToolError> {
        let CursorTransport::Cdp {
            socket,
            frame: expected,
            context,
        } = &self.transport
        else {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed extension cleanup requires its retained resource boundary".into(),
            ));
        };
        let observed = async {
            let tree = socket.request("Page.getFrameTree", json!({})).await?;
            let frame = &tree["frameTree"]["frame"];
            let current = format!(
                "{}:{}",
                frame["id"]
                    .as_str()
                    .ok_or_else(|| failed("cursor cleanup frame unavailable"))?,
                frame["loaderId"].as_str().unwrap_or_default()
            );
            if current != *expected {
                return Ok(None);
            }
            let method = match operation {
                CursorOperation::Configure => "update",
                CursorOperation::Finalize => "finalize",
            };
            let input = json!({"cursor":cursor,"ownerEpoch":self.epoch.to_string(),"point":null,"action":"idle","operation":method});
            let value = socket
                .request(
                    "Runtime.evaluate",
                    json!({
                        "expression":format!("({})({input})",cua_driver_core::browser::FIXED_BROWSER_UI_SCRIPT),
                        "contextId":context,"returnByValue":true,"awaitPromise":true,
                    }),
                )
                .await?;
            if value.get("exceptionDetails").is_some() {
                return Err(failed("browser cursor finalization failed"));
            }
            let state: crate::cursor::RenderState =
                serde_json::from_value(value["result"]["value"].clone()).map_err(failed)?;
            if (matches!(operation, CursorOperation::Finalize) && state.visible) || state.error.is_some() {
                return Err(failed("browser cursor finalization was not confirmed"));
            }
            Ok(Some(state))
        }
        .await;
        let error = match observed {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        if self.provider.extension().is_some() {
            return Err(ToolError::CleanupUnconfirmed(error.to_string()));
        }
        match self.provider.inventory().await {
            Ok((generation, tabs))
                if BrowserIdentity::of(&self.provider, &generation)? != identity.browser
                    || !tabs.iter().any(|tab| tab.id == identity.target) =>
            {
                Ok(None)
            }
            Ok(_) => Err(ToolError::CleanupUnconfirmed(error.to_string())),
            Err(inventory) => Err(ToolError::CleanupUnconfirmed(format!(
                "{error}; cursor cleanup inventory: {inventory}"
            ))),
        }
    }
}

impl Host {
    pub(super) fn record_cursor(
        &mut self,
        owner: uuid::Uuid,
        identity: TabIdentity,
        endpoint: CursorEndpoint,
    ) {
        let key = (owner, identity);
        if self
            .cursor_scopes
            .get(&key)
            .is_some_and(|current| current.epoch > endpoint.epoch)
        {
            return;
        }
        self.cursor_scopes.insert(key, endpoint);
    }

    pub(super) async fn finalize_cursors(
        &mut self,
        owner: uuid::Uuid,
        cursor: &Spec,
    ) -> Result<(), ToolError> {
        self.finalize_cursors_through(owner, None, cursor).await
    }

    async fn finalize_cursors_through(
        &mut self,
        owner: uuid::Uuid,
        epoch: Option<crate::desktop::NativeEpochId>,
        cursor: &Spec,
    ) -> Result<(), ToolError> {
        let keys: Vec<_> = self
            .cursor_scopes
            .iter()
            .filter(|((current, _), endpoint)| {
                *current == owner && epoch.is_none_or(|epoch| endpoint.epoch <= epoch)
            })
            .map(|(key, _)| key.clone())
            .collect();
        let mut failures = Vec::new();
        for key in keys {
            let mut endpoint = self.cursor_scopes[&key].clone();
            let purpose = match epoch {
                Some(through) => extension::FixedCleanupPurpose::Epoch { through },
                None => extension::FixedCleanupPurpose::Owner,
            };
            if matches!(&endpoint.transport, CursorTransport::Fixed { .. }) {
                match self.fixed_cleanup_protected(owner, &key.1, &purpose) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => {
                        failures.push(error.to_string());
                        continue;
                    }
                }
            }
            let result = match &endpoint.transport {
                CursorTransport::Fixed {
                    cleanup_control,
                    receipt,
                } => self
                    .finalize_fixed_session_ui(owner, &key.1, receipt, cleanup_control, purpose)
                    .await
                    .map(|()| None),
                CursorTransport::Cdp { .. } => {
                    endpoint
                        .execute(&key.1, cursor, CursorOperation::Finalize)
                        .await
                }
            };
            match result {
                Ok(_) => {
                    self.cursor_scopes.remove(&key);
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }

    fn stage_cursor_configuration(
        &mut self,
        owner: uuid::Uuid,
        epoch: crate::desktop::NativeEpochId,
    ) -> Vec<(TabIdentity, CursorEndpoint)> {
        let keys: Vec<_> = self
            .cursor_scopes
            .keys()
            .filter(|(current, _)| *current == owner)
            .cloned()
            .collect();
        let mut staged = Vec::new();
        for key in keys {
            let mut endpoint = self.cursor_scopes[&key].clone();
            if endpoint.epoch > epoch {
                continue;
            }
            // Extension fixed configuration still needs actual Global admission.
            // Its same-record pending/ACK custody, rather than this intent,
            // determines whether an old epoch may retire the resource.
            if matches!(&endpoint.transport, CursorTransport::Cdp { .. }) {
                endpoint.epoch = epoch;
                self.cursor_scopes.insert(key.clone(), endpoint.clone());
            }
            staged.push((key.1, endpoint));
        }
        staged
    }
}

impl Browsers {
    pub(crate) async fn configure_cursor(
        &mut self,
        cursor: &Spec,
        invocation: &crate::InvocationContext<'_>,
    ) -> Vec<Value> {
        let host = self.host().await;
        let staged = host
            .lock()
            .await
            .stage_cursor_configuration(self.owner, self.epoch);
        let mut states = Vec::new();
        for (identity, mut endpoint) in staged {
            let result = match &endpoint.transport {
                CursorTransport::Fixed { receipt, .. } => {
                    super::extension::configure_fixed_session_ui(
                        &host, self.owner, &identity, receipt, self.epoch, cursor, invocation,
                    )
                    .await
                }
                CursorTransport::Cdp { .. } => {
                    endpoint
                        .execute(&identity, cursor, CursorOperation::Configure)
                        .await
                }
            };
            match result {
                Ok(Some(state)) => states.push(json!({"tab":identity.target,"state":state})),
                Ok(None) => {
                    let mut ledger = host.lock().await;
                    let key = (self.owner, identity.clone());
                    if ledger.cursor_scopes.get(&key).is_some_and(|current| {
                        current.epoch == endpoint.epoch
                            && current.fixed_scope_id() == endpoint.fixed_scope_id()
                    }) {
                        ledger.cursor_scopes.remove(&key);
                    }
                }
                Err(error) => states.push(json!({"tab":identity.target,"error":error.to_string()})),
            }
        }
        states
    }
    pub(crate) async fn cursor_state(
        &mut self,
        cursor: &Spec,
        call: super::BrowserCall<'_>,
    ) -> Result<Vec<Value>, ToolError> {
        let mut states = Vec::new();
        for tab in self.targets.values_mut() {
            let result = match tab.verify(call).await {
                Ok(()) => {
                    tab.draw_cursor(cursor, None, "idle", "state", call.language)
                        .await
                }
                Err(error) => Err(error),
            };
            match result {
                Ok(state) => states.push(json!({"tab":tab.info.id,"state":state})),
                Err(error @ (ToolError::Persistence(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }
                    | ToolError::OperationUnknown { .. }
                    | ToolError::OutcomeUnknown(_))) => return Err(error),
                Err(error) => states.push(json!({"tab":tab.info.id,"error":with_unknown_guidance(error, call.language).to_string()})),
            }
        }
        Ok(states)
    }
    pub(crate) async fn remove_cursors(&mut self, cursor: &Spec) -> Result<(), ToolError> {
        // Teardown uses only issued cleanup endpoints. It must not reconnect or
        // activate a metadata session, and an old epoch cannot retire a newer one.
        self.host()
            .await
            .lock()
            .await
            .finalize_cursors_through(self.owner, Some(self.epoch), cursor)
            .await
    }
}
impl Tab {
    pub(super) async fn draw_cursor(
        &mut self,
        cursor: &Spec,
        point: Option<[f64; 2]>,
        action: &str,
        operation: &str,
        language: Language,
    ) -> Result<Value, ToolError> {
        if let Some(state) = self
            .extension_fixed_ui_presentation(cursor, point, action, operation)
            .await?
        {
            return Ok(state);
        }
        if let Some(state) = self.extension_cursor_presentation(point, operation).await? {
            return Ok(state);
        }
        let tree = self.request("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        let id = frame["id"]
            .as_str()
            .ok_or_else(|| failed("cursor frame unavailable"))?;
        let identity = format!("{}:{}", id, frame["loaderId"].as_str().unwrap_or_default());
        if matches!(operation, "update" | "control") && self.frame.as_ref() != Some(&identity) {
            return Err(failed(match language {
                Language::En => "stale_document: observe before showing its cursor",
                Language::ZhCn => "stale_document: 请先观察，再显示光标",
                Language::ZhTw => "stale_document: 請先觀察，再顯示游標",
            }));
        }
        let context = match &self.cursor_world {
            Some((previous, context)) if *previous == identity => *context,
            _ => {
                let world=self.request("Page.createIsolatedWorld",json!({"frameId":id,"worldName":"maka-cua-cursor","grantUniveralAccess":false})).await?;
                let context = world["executionContextId"]
                    .as_u64()
                    .ok_or_else(|| failed("cursor isolated world unavailable"))?;
                if self.frame().await? != identity {
                    return Err(failed(
                        "stale_document: cursor world changed during creation",
                    ));
                }
                self.cursor_world = Some((identity.clone(), context));
                context
            }
        };
        if matches!(operation, "update" | "control") {
            // Retain cleanup before delivery can become uncertain or caches retire.
            let endpoint = CursorEndpoint {
                transport: CursorTransport::Cdp {
                    socket: self
                        .socket
                        .as_ref()
                        .ok_or_else(|| failed("cursor connection unavailable"))?
                        .clone(),
                    frame: identity,
                    context,
                },
                provider: self.provider.clone(),
                epoch: self.cursor_epoch,
                cursor: cursor.clone(),
            };
            self.cursor_host.lock().await.record_cursor(
                self.cursor_owner,
                self.identity()?,
                endpoint,
            );
        }
        let current_cursor = self
            .cursor_spec
            .as_ref()
            .map(|cursor| cursor.lock().unwrap().clone());
        let cursor = current_cursor.as_ref().unwrap_or(cursor);
        let extension_control = if operation == "control" {
            self.info.extension.as_ref().map(|tab|json!({"running":true,"observed":tab.active.unwrap_or(false),"sessionId":self.cursor_owner.to_string(),"turnId":self.last_turn}))
        } else {
            None
        };
        let input = json!({"cursor":cursor,"ownerEpoch":self.cursor_epoch.to_string(),"point":point,"action":action,"operation":operation,"nativeControl":extension_control});
        let value = self
            .request(
                "Runtime.evaluate",
                json!({
                    "expression":format!("({})({input})",cua_driver_core::browser::FIXED_BROWSER_UI_SCRIPT),
                    "contextId":context,"returnByValue":true,"awaitPromise":true
                }),
            )
            .await?;
        if value.get("exceptionDetails").is_some() {
            self.cursor_world = None;
            return Err(failed("browser cursor could not be rendered"));
        }
        let state: crate::cursor::RenderState =
            serde_json::from_value(value["result"]["value"].clone()).map_err(failed)?;
        let mut value = json!(state);
        if operation == "state"
            && let Some(diagnostic) = self.extension_control_diagnostic().await
        {
            value["nativeControlDiagnostic"] = json!(diagnostic);
        }
        Ok(value)
    }
    pub(super) async fn cursor_point(
        &mut self,
        target: &Position,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<[f64; 2], ToolError> {
        match target {
            Position::Point(point) => self.point(*point, language).await,
            Position::Element(index) => {
                self.element_point(*index, false, cancellation, language)
                    .await
            }
        }
    }
}

impl Host {
    pub(super) async fn finalize_extension_cursor(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        purpose: extension::FixedCleanupPurpose,
    ) -> Result<(), ToolError> {
        let key = (owner, identity.clone());
        let Some(mut endpoint) = self.cursor_scopes.get(&key).cloned() else {
            return Ok(());
        };
        if matches!(&endpoint.transport, CursorTransport::Fixed { .. })
            && self.fixed_cleanup_protected(owner, identity, &purpose)?
        {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed UI cleanup is protected by a newer actual context".into(),
            ));
        }
        let cursor = endpoint.cursor.clone();
        match &endpoint.transport {
            CursorTransport::Fixed {
                cleanup_control,
                receipt,
            } => {
                self.finalize_fixed_session_ui(owner, identity, receipt, cleanup_control, purpose)
                    .await?
            }
            CursorTransport::Cdp { .. } => {
                endpoint
                    .execute(identity, &cursor, CursorOperation::Finalize)
                    .await?;
            }
        }
        self.cursor_scopes.remove(&key);
        Ok(())
    }
}
