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
use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::plugin::{Apply, PackageInstall, PackageTarget};

#[derive(Clone, Debug, Serialize)]
pub(super) enum Mutation {
    Install(PackageInstall),
    Restart(PackageTarget),
    Uninstall(PackageTarget),
    Apply(Apply),
}
#[derive(Clone, Debug)]
enum Body {
    Read,
    Preview(String),
    Write {
        mutation: Mutation,
        change: Change,
        place: Place,
        base: u64,
    },
}
#[derive(Clone, Debug)]
pub struct Request {
    pub(super) binding: Binding,
    pub(super) token: Uuid,
    body: Body,
}
impl Request {
    pub fn needs_checkpoint(&self) -> bool {
        matches!(self.body, Body::Write { .. })
    }
    pub(super) fn background_read(&self) -> bool {
        matches!(self.body, Body::Read)
    }
    pub(super) fn write(
        binding: Binding,
        mutation: Mutation,
        change: Change,
        place: Place,
        base: u64,
    ) -> Self {
        Self {
            binding,
            token: Uuid::new_v4(),
            body: Body::Write {
                mutation,
                change,
                place,
                base,
            },
        }
    }
    pub(super) fn intent(&self) -> Option<(Change, &Place, u64)> {
        match &self.body {
            Body::Write {
                change,
                place,
                base,
                ..
            } => Some((*change, place, *base)),
            _ => None,
        }
    }
    pub(super) fn mutation(&self) -> Option<&Mutation> {
        match &self.body {
            Body::Write { mutation, .. } => Some(mutation),
            _ => None,
        }
    }
    fn same(&self, other: &Self) -> bool {
        self.token == other.token
            && self.binding == other.binding
            && match (&self.body, &other.body) {
                (Body::Read, Body::Read) => true,
                (Body::Preview(a), Body::Preview(b)) => a == b,
                (
                    Body::Write {
                        mutation: a,
                        change: ac,
                        place: ap,
                        base: ab,
                    },
                    Body::Write {
                        mutation: b,
                        change: bc,
                        place: bp,
                        base: bb,
                    },
                ) => {
                    ac == bc
                        && ap == bp
                        && ab == bb
                        && serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
                }
                _ => false,
            }
    }
}
#[derive(Debug)]
pub enum Output {
    Snapshot(Snapshot),
    Preview(PackagePreview),
    Receipt(Receipt),
}
pub async fn execute(client: &Client, request: &Request) -> Result<Output, RequestFailure> {
    Ok(match &request.body {
        Body::Read => Output::Snapshot(super::query::snapshot(client).await?),
        Body::Preview(path) => Output::Preview(client.plugin_package_preview(path.clone()).await?),
        Body::Write { mutation, .. } => Output::Receipt(match mutation {
            Mutation::Install(input) => client.plugin_package_install(input.clone()).await?.receipt,
            Mutation::Restart(input) => client.plugin_package_restart(input.clone()).await?,
            Mutation::Uninstall(input) => client.plugin_package_uninstall(input.clone()).await?,
            Mutation::Apply(input) => client.plugin_composition_apply(input.clone()).await?,
        }),
    })
}
impl App {
    pub fn plugins_request(&mut self) -> Option<Request> {
        let binding = self.plugins_binding()?;
        if self.plugins.binding.as_ref() != Some(&binding) {
            self.plugins.disconnect();
            self.plugins.binding = Some(binding.clone());
        }
        let state = &mut self.plugins;
        if state.pending.is_some() {
            return None;
        }
        let request = if let Some(request) = state.queued.take() {
            request
        } else if !matches!(self.navigation.current(), Route::Plugins(_)) || state.confirm_visible()
        {
            return None;
        } else if state.preview_requested {
            state.preview_requested = false;
            Request {
                binding,
                token: Uuid::new_v4(),
                body: Body::Preview(state.path.text().to_owned()),
            }
        } else if state.refresh {
            state.refresh = false;
            Request {
                binding,
                token: Uuid::new_v4(),
                body: Body::Read,
            }
        } else {
            return None;
        };
        state.dispatched = !request.needs_checkpoint();
        state.pending = Some(request.clone());
        Some(request)
    }
    pub fn plugins_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        if self.plugins_binding().as_ref() != Some(&request.binding)
            || !self
                .plugins
                .pending
                .as_ref()
                .is_some_and(|pending| pending.same(request))
            || !request.needs_checkpoint()
            || self.plugins.dispatched
        {
            return false;
        }
        if result.is_err() {
            self.plugins.pending = None;
            self.plugins.error = Some("plugins-checkpoint-failed".into());
            return false;
        }
        self.plugins.dispatched = true;
        true
    }
    pub fn plugins_completed(&mut self, request: Request, result: Result<Output, RequestFailure>) {
        if self.plugins_binding().as_ref() != Some(&request.binding)
            || !self
                .plugins
                .pending
                .as_ref()
                .is_some_and(|pending| pending.same(&request))
        {
            return;
        }
        if !self.plugins.dispatched {
            return;
        }
        let background_read = request.background_read();
        let state = &mut self.plugins;
        state.pending = None;
        state.dispatched = false;
        match result {
            Ok(Output::Snapshot(snapshot)) => {
                state.sync_drafts(&snapshot);
                state.snapshot = Some(snapshot);
                state.ensure_draft();
                state.error = None;
            }
            Ok(Output::Preview(preview)) => {
                state.preview = Some(preview);
                state.error = None;
            }
            Ok(Output::Receipt(receipt)) => {
                state.receipt = Some(receipt);
                state.error = None;
                state.refresh = true;
                if let Some((change, place, _)) = request.intent()
                    && matches!(
                        change,
                        Change::Configure | Change::Services | Change::Create
                    )
                {
                    let key = place
                        .entry()
                        .map_or_else(|| place.clone(), |key| Place::Entry(key.clone()));
                    if let Some((_, draft)) =
                        state.drafts.iter_mut().find(|(place, _)| *place == key)
                    {
                        match change {
                            Change::Configure => draft.dirty[1] = false,
                            Change::Services => draft.dirty[2] = false,
                            _ => {}
                        }
                    }
                    state.drafts.retain(|(place, draft)| {
                        !(*place == key && !draft.dirty.iter().any(|dirty| *dirty))
                            && !(change == Change::Create
                                && draft.original.is_none()
                                && key.entry().is_some_and(|key| {
                                    draft.fields[0].text() == key.id && draft.scope == key.scope
                                }))
                    });
                }
            }
            Err(error) => {
                if request.needs_checkpoint() && unknown(&error) {
                    state.remember_unknown(&request);
                }
                state.error = Some(error.to_string());
            }
        }
        // A fact refresh is not a new route or action owner. The next normal
        // frame reconciles changed rows without moving/retiring unchanged hits.
        if !background_read {
            state.token = Uuid::new_v4();
            state.invalidate_geometry();
        }
    }
}

fn unknown(error: &RequestFailure) -> bool {
    matches!(error, RequestFailure::Unknown(_))
        || matches!(error, RequestFailure::Rejected(ClientError::Rejected(error)) if matches!(error.code, maka_protocol::OperationErrorCode::CommitOutcomeUnknown | maka_protocol::OperationErrorCode::OutcomeUnknown))
}
