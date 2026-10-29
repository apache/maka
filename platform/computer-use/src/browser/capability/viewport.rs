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

//! Viewport data is part of the existing browser/lease ledger.
use super::*;

#[derive(Clone, Debug)]
pub(in crate::browser) struct Pending {
    pub(in crate::browser) turn: String,
    pub(in crate::browser) value: Option<Viewport>,
}

impl Host {
    pub(in crate::browser) fn set_viewport(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        turn: &str,
        value: Option<Viewport>,
    ) -> Result<Option<TabIdentity>, ToolError> {
        self.known(browser)?;
        let state = self
            .extension
            .get(&(owner, browser.clone()))
            .ok_or_else(|| failed("Browser session is unavailable"))?;
        if state.current_turn.as_deref() != Some(turn) {
            return Err(failed("Viewport operation lost its browser turn"));
        }
        let selected = self.logical_active(owner, browser);
        if let Some(tab) = selected {
            let identity = browser.tab(&tab);
            let lease = self
                .tabs
                .get_mut(&identity)
                .filter(|lease| {
                    lease.creator.owner == owner
                        && matches!(lease.disposition, ownership::Disposition::Live)
                })
                .ok_or_else(|| {
                    failed(format!("Tab {tab} is not part of browser session {owner}"))
                })?;
            lease.viewport = Some(value);
            self.extension
                .get_mut(&(owner, browser.clone()))
                .expect("active state")
                .pending_viewport = None;
            Ok(Some(identity))
        } else {
            self.extension
                .get_mut(&(owner, browser.clone()))
                .ok_or_else(|| failed("Browser session is unavailable"))?
                .pending_viewport = Some(Pending {
                turn: turn.to_owned(),
                value,
            });
            Ok(None)
        }
    }

    /// Consume only after the caller has proved the actual active lease. An
    /// absent override differs from explicit reset (Some(None)).
    pub(in crate::browser) fn take_viewport_for_attach(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        turn: &str,
    ) -> Result<Option<Option<Viewport>>, ToolError> {
        let lease = self
            .tabs
            .get_mut(identity)
            .filter(|lease| {
                lease.creator.owner == owner
                    && matches!(lease.disposition, ownership::Disposition::Live)
            })
            .ok_or_else(|| failed("Viewport attach lost its session lease"))?;
        if lease.viewport.is_some() {
            return Ok(lease.viewport);
        }
        let Some(state) = self.extension.get_mut(&(owner, identity.browser.clone())) else {
            return Ok(None);
        };
        if state
            .pending_viewport
            .as_ref()
            .is_none_or(|pending| pending.turn != turn)
        {
            return Ok(None);
        }
        let pending = state
            .pending_viewport
            .take()
            .expect("same-turn pending viewport");
        lease.viewport = Some(pending.value);
        Ok(lease.viewport)
    }

    pub(in crate::browser) fn clear_pending_viewport(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        turn: &str,
    ) {
        if let Some(state) = self.extension.get_mut(&(owner, browser.clone()))
            && state
                .pending_viewport
                .as_ref()
                .is_some_and(|pending| pending.turn == turn)
        {
            state.pending_viewport = None;
        }
    }
}

pub(in crate::browser) async fn apply(tab: &Tab, value: Option<Viewport>) -> Result<(), ToolError> {
    match value {
        Some(size) => tab
            .frame_request(
                None,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width":size.width,"height":size.height,"deviceScaleFactor":1,"mobile":false
                }),
            )
            .await
            .map(|_| ()),
        None => tab
            .frame_request(None, "Emulation.clearDeviceMetricsOverride", json!({}))
            .await
            .map(|_| ()),
    }
}

impl Tab {
    pub(in crate::browser) async fn apply_pending_viewport(
        &mut self,
        call: BrowserCall<'_>,
    ) -> Result<(), ToolError> {
        if self.provider.extension().is_none() {
            return Ok(());
        }
        let identity = self.identity()?;
        let value = self.cursor_host.lock().await.take_viewport_for_attach(
            self.cursor_owner,
            &identity,
            call.invocation.turn(),
        )?;
        if let Some(value) = value {
            apply(self, value).await?
        }
        Ok(())
    }
}
