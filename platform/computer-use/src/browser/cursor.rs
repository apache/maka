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
    socket: Cdp,
    provider: BrowserConnection,
    frame: String,
    context: u64,
    epoch: crate::desktop::NativeEpochId,
}

#[derive(Clone, Copy)]
enum CursorOperation {
    Configure,
    Finalize,
}

impl CursorEndpoint {
    async fn execute(
        &mut self,
        identity: &TabIdentity,
        cursor: &Spec,
        operation: CursorOperation,
    ) -> Result<Option<crate::cursor::RenderState>, ToolError> {
        let observed = async {
            let tree = self.socket.request("Page.getFrameTree", json!({})).await?;
            let frame = &tree["frameTree"]["frame"];
            let current = format!(
                "{}:{}",
                frame["id"]
                    .as_str()
                    .ok_or_else(|| failed("cursor cleanup frame unavailable"))?,
                frame["loaderId"].as_str().unwrap_or_default()
            );
            if current != self.frame {
                return Ok(None);
            }
            let method = match operation {
                CursorOperation::Configure => "update",
                CursorOperation::Finalize => "finalize",
            };
            let input = json!({"cursor":cursor,"ownerEpoch":self.epoch.to_string(),"point":null,"action":"idle","operation":method,"svg":crate::cursor::theme::svg(cursor.color)});
            let value = self
                .socket
                .request(
                    "Runtime.evaluate",
                    json!({
                        "expression":format!("({})({input})",include_str!("cursor.js")),
                        "contextId":self.context,"returnByValue":true,"awaitPromise":true,
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
        match inventory(&self.provider).await {
            Ok((generation, tabs))
                if BrowserIdentity::new(&self.provider, &generation)? != identity.browser
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
    fn record_cursor(
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
        let keys: Vec<_> = self
            .cursor_scopes
            .keys()
            .filter(|(current, _)| *current == owner)
            .cloned()
            .collect();
        let mut failures = Vec::new();
        for key in keys {
            let mut endpoint = self.cursor_scopes[&key].clone();
            match endpoint
                .execute(&key.1, cursor, CursorOperation::Finalize)
                .await
            {
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

    async fn configure_cursors(
        &mut self,
        owner: uuid::Uuid,
        epoch: crate::desktop::NativeEpochId,
        cursor: &Spec,
    ) -> Vec<Value> {
        let keys: Vec<_> = self
            .cursor_scopes
            .keys()
            .filter(|(current, _)| *current == owner)
            .cloned()
            .collect();
        let mut states = Vec::new();
        for key in keys {
            let mut endpoint = self.cursor_scopes[&key].clone();
            if endpoint.epoch > epoch {
                continue;
            }
            endpoint.epoch = epoch;
            self.cursor_scopes.insert(key.clone(), endpoint.clone());
            match endpoint
                .execute(&key.1, cursor, CursorOperation::Configure)
                .await
            {
                Ok(Some(state)) => states.push(json!({"tab":key.1.target,"state":state})),
                Ok(None) => {
                    self.cursor_scopes.remove(&key);
                }
                Err(error) => states.push(json!({"tab":key.1.target,"error":error.to_string()})),
            }
        }
        states
    }
}

impl Browsers {
    pub(crate) async fn configure_cursor(&mut self, cursor: &Spec) -> Vec<Value> {
        self.host()
            .await
            .lock()
            .await
            .configure_cursors(self.owner, self.epoch, cursor)
            .await
    }
    pub(crate) async fn cursor_state(&mut self, cursor: &Spec, language: Language) -> Vec<Value> {
        let mut states = Vec::new();
        for tab in self.targets.values_mut() {
            if tab.verify(language).await.is_ok() {
                match tab
                    .draw_cursor(cursor, None, "idle", "state", language)
                    .await
                {
                    Ok(state) => states.push(json!({"tab":tab.info.id,"state":state})),
                    Err(error) => states.push(json!({"tab":tab.info.id,"error":with_unknown_guidance(error, language).to_string()})),
                }
            }
        }
        states
    }
    pub(crate) async fn remove_cursors(&mut self, cursor: &Spec) {
        // Best-effort teardown discards these diagnostics; it does not render
        // model-facing copy or select a language for accepted work.
        for tab in self.targets.values_mut() {
            if tab.verify(Language::En).await.is_ok() {
                let _ = tab
                    .draw_cursor(cursor, None, "idle", "remove", Language::En)
                    .await;
            }
        }
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
        let tree = self.request("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        let id = frame["id"]
            .as_str()
            .ok_or_else(|| failed("cursor frame unavailable"))?;
        let identity = format!("{}:{}", id, frame["loaderId"].as_str().unwrap_or_default());
        if operation == "update" && self.frame.as_ref() != Some(&identity) {
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
        if operation == "update" {
            // Retain cleanup before delivery can become uncertain or caches retire.
            let endpoint = CursorEndpoint {
                socket: self
                    .socket
                    .as_ref()
                    .ok_or_else(|| failed("cursor connection unavailable"))?
                    .clone(),
                provider: self.provider.clone(),
                frame: identity,
                context,
                epoch: self.cursor_epoch,
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
        let input = json!({"cursor":cursor,"ownerEpoch":self.cursor_epoch.to_string(),"point":point,"action":action,"operation":operation,"svg":crate::cursor::theme::svg(cursor.color)});
        let value = self
            .request(
                "Runtime.evaluate",
                json!({
                    "expression":format!("({})({input})",include_str!("cursor.js")),
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
        Ok(json!(state))
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
