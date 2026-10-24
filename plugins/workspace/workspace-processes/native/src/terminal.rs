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

//! Explicit user terminal operations on the original Processes resource owner.
mod controller;
mod display;
mod launch;
mod output;
use super::{Processes, ResolvedConfiguration, cancelled, failed, persistence, worker_error};
pub(super) use controller::Lease;
use futures_util::future::BoxFuture;
use maka_agent_facts::shell_run::ShellObservation;
use maka_agent_facts::tools::ToolError;
use maka_event_log::sessions::SessionRecord;
use maka_host_runtime::shell::request::parse_ref;
use maka_host_runtime::{
    application::{Context, Handler},
    shell::ShellError,
};
use maka_workspace_api::terminal::*;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

// Terminal delivery work batches continue until all output has been delivered.
// This is not a Host item contract or a limit on the total retained output.
const DELIVERY_CHUNK_BYTES: usize = 64 * 1024;

pub(super) struct Service(pub(super) Arc<Processes>);
impl Handler for Service {
    fn call(
        &self,
        name: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            if matches!(name.as_str(), "start" | "stop" | "control" | "release")
                && context.operation().is_none()
            {
                return Err("terminal_mutation_required".into());
            }
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|e| e.to_string())?;
            ticket.start();
            let result = owner.terminal_call(&name, input, &context).await;
            let cleanup = match &result {
                Err(ToolError::CleanupUnconfirmed(message)) => {
                    owner.drain.cancel();
                    Err(message.clone())
                }
                _ => Ok(()),
            };
            ticket.complete(cleanup);
            match result {
                Ok(value) => Ok(value),
                Err(ToolError::Failed(message) | ToolError::Io { message, .. }) => {
                    serde_json::to_value(Outcome::<Value>::Failed { message })
                        .map_err(|e| e.to_string())
                }
                Err(error) => Err(error.to_string()),
            }
        })
    }
}
impl Processes {
    async fn terminal_call(
        &self,
        name: &str,
        value: Value,
        context: &Context,
    ) -> Result<Value, ToolError> {
        cancelled(&context.scope().cancellation)?;
        match name {
            "list" | "watchList" => {
                self.terminal_list(decode(value)?, name == "watchList", context)
                    .await
            }
            "read" | "watch" => {
                self.terminal_read(decode(value)?, name == "watch", context)
                    .await
            }
            "readDisplay" => self.terminal_display(decode(value)?, context).await,
            "readOutput" | "watchOutput" => {
                self.terminal_output(decode(value)?, name == "watchOutput", context)
                    .await
            }
            "start" => self
                .terminal_start(decode(value)?, context)
                .await
                .and_then(completed),
            "stop" => self
                .terminal_stop(decode(value)?, context)
                .await
                .and_then(completed),
            "acquire" => self.terminal_acquire(decode(value)?, context).await,
            "control" => self
                .terminal_control(decode(value)?, context)
                .await
                .and_then(completed),
            "release" => self
                .terminal_release(decode(value)?, context)
                .await
                .and_then(completed),
            _ => Err(failed("Terminal method unavailable")),
        }
    }
    async fn terminal_store(
        &self,
        id: &str,
        context: &Context,
    ) -> Result<maka_event_log::SessionStore, ToolError> {
        if let Some(invocation) = context
            .scope()
            .identity
            .agent()
            .filter(|invocation| invocation.session_id == id)
            && let Some(custody) = context.scope().execution()
        {
            return maka_agent_authority::permissions::execution(
                &self.store,
                invocation,
                Some(custody.as_ref()),
            );
        }
        self.store.session(id).await.map_err(|error| match error {
            maka_event_log::StoreError::SessionNotFound => failed("Terminal Session not found"),
            error => persistence(error),
        })
    }
    async fn terminal_session(
        &self,
        id: &str,
        active: bool,
        context: &Context,
    ) -> Result<SessionRecord<ResolvedConfiguration>, ToolError> {
        let prefix = self
            .session_prefix
            .as_deref()
            .ok_or_else(|| failed("Terminal Session owner is not configured"))?;
        if !id.strip_prefix(prefix).is_some_and(|tail| {
            tail.len() == 32
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(failed("Terminal Session not found in configured owner"));
        }
        let record = self
            .terminal_store(id, context)
            .await?
            .get_session::<maka_agent_api::session::StoredSessionConfiguration>(id)
            .await
            .map_err(persistence)?
            .ok_or_else(|| failed("Terminal Session not found"))?;
        let record =
            maka_agent_authority::permissions::resolve_session(record).map_err(persistence)?;
        if active && record.archived {
            return Err(failed("Session is archived"));
        }
        Ok(record)
    }
    async fn terminal_record(
        &self,
        target: &Target,
        context: &Context,
    ) -> Result<ShellObservation, ToolError> {
        self.terminal_session(&target.session_id, false, context)
            .await?;
        let id = self.terminal_id(target)?;
        if let Some(Ok(live)) = self
            .resources
            .get(&target.session_id, id)
            .and_then(|handle| handle.latest())
            && live.state.active()
        {
            // The worker owns active mutations and already carries its committed
            // row. Avoid decoding a full durable display for each live preview.
            return Ok((*live).clone());
        }
        let record = self
            .terminal_store(&target.session_id, context)
            .await?
            .read_shell_run(&target.session_id, id)
            .await
            .map_err(persistence)?
            .ok_or_else(|| failed("Terminal resource not found in this Session and provider"))?;
        if let Some(update) = self
            .resources
            .get(&target.session_id, id)
            .and_then(|handle| handle.latest())
        {
            return super::control::prefer_live(record, update);
        }
        Ok(record.into())
    }
    fn terminal_id<'a>(&self, target: &'a Target) -> Result<&'a str, ToolError> {
        parse_ref(&target.reference)
            .filter(|id| id.starts_with(&self.prefix))
            .ok_or_else(|| failed("Terminal resource not found in this provider"))
    }
    async fn terminal_list(
        &self,
        input: List,
        watch: bool,
        context: &Context,
    ) -> Result<Value, ToolError> {
        if input.offset > MAX_SEQUENCE {
            return Err(failed("Invalid terminal page offset"));
        }
        let store = self.terminal_store(&input.session_id, context).await?;
        let mut changes = store.subscribe_commits().map_err(persistence)?;
        let mut previous = None;
        loop {
            self.terminal_session(&input.session_id, false, context)
                .await?;
            let page = store
                .query_shell_catalog(&input.session_id, &self.prefix, input.offset)
                .await
                .map_err(persistence)?;
            let revision = page.revision.clone();
            let value = completed(Page {
                resources: page.resources,
                revision: page.revision,
                total: page.total,
                next_offset: page.next_offset,
            })?;
            if !watch {
                return Ok(value);
            }
            if previous.as_ref() != Some(&revision) {
                context.emit(value.clone()).await.map_err(failed)?;
                previous = Some(revision);
            }
            loop {
                tokio::select! { biased;
                    _ = context.scope().cancellation.cancelled() => return Ok(value),
                    _ = self.drain.cancelled() => return Ok(value),
                    change = changes.changed() => {
                        change.map_err(|_| failed("Terminal resource observation closed"))?;
                        break;
                    }
                }
            }
        }
    }
    async fn terminal_read(
        &self,
        target: Target,
        watch: bool,
        context: &Context,
    ) -> Result<Value, ToolError> {
        let store = self.terminal_store(&target.session_id, context).await?;
        let mut changes = store.subscribe_commits().map_err(persistence)?;
        let id = self.terminal_id(&target)?.to_owned();
        // Subscribe before reading either durable state or the original live cut.
        let mut handle = self.resources.get(&target.session_id, &id);
        let mut previous = None;
        loop {
            let record = self.terminal_record(&target, context).await?;
            if watch && handle.is_none() && record.state.active() {
                handle = self.resources.get(&target.session_id, &id);
                if handle.is_some() {
                    continue;
                }
            }
            let value = completed(snapshot(record)?)?;
            if !watch {
                return Ok(value);
            }
            if previous.as_ref() != Some(&value) {
                context.emit(value.clone()).await.map_err(failed)?;
                previous = Some(value.clone());
            }
            loop {
                tokio::select! { biased;
                    _ = context.scope().cancellation.cancelled() => return Ok(value),
                    _ = self.drain.cancelled() => return Ok(value),
                    update = async { handle.as_mut().expect("live handle").changed().await }, if handle.is_some() => {
                        if let Err(error) = update {
                            // A committed final cut followed by normal sender closure is
                            // not a worker failure. Stop polling that closed receiver.
                            let settled = handle.as_ref().and_then(|handle| handle.latest())
                                .is_some_and(|update| update.is_ok_and(|record| !record.state.active()));
                            if !settled { return Err(worker_error(error)); }
                            handle = None;
                        }
                        break;
                    }
                    change = changes.changed() => {
                        change.map_err(|_| failed("Terminal resource observation closed"))?;
                        break;
                    }
                }
            }
        }
    }
    async fn terminal_stop(&self, target: Target, context: &Context) -> Result<Stopped, ToolError> {
        let mut record = self.terminal_record(&target, context).await?;
        cancelled(&context.scope().cancellation)?;
        let applied = if let Some(mut handle) = self.resources.get(&target.session_id, &record.id) {
            let receipt = handle.stop_and_wait().await.map_err(worker_error)?;
            record = (*handle.drained().await.map_err(worker_error)?).clone();
            receipt.applied
        } else {
            if record.state.active() {
                record = self.terminal_record(&target, context).await?;
                if record.state.active() {
                    return Err(ToolError::CleanupUnconfirmed(
                        "Active terminal has no native owner".into(),
                    ));
                }
            }
            false
        };
        Ok(Stopped {
            applied,
            resource: snapshot(record)?,
        })
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ToolError> {
    serde_json::from_value(value).map_err(failed)
}
fn snapshot(record: ShellObservation) -> Result<ResourceUpdate, ToolError> {
    maka_presentation::shell::local_observation(record).map_err(persistence)
}

pub(super) fn completed(
    value: impl serde::Serialize,
) -> Result<Value, maka_agent_facts::tools::ToolError> {
    serde_json::to_value(Outcome::Completed { value }).map_err(persistence)
}
