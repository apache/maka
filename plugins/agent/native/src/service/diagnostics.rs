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

const PAGE_BYTES: usize = 48 * 1024;

pub(super) async fn query(
    owner: &Owner,
    input: Diagnostics,
    context: &Context,
) -> Result<Value, String> {
    owner
        .scoped_session(context.scope(), &input.session_id)
        .await?;
    let (through, before) = match input.position {
        DiagnosticPosition::Latest => (None, None),
        DiagnosticPosition::Before { through, sequence } => (Some(through), Some(sequence)),
    };
    let page = owner
        .scoped_store(context.scope(), &input.session_id)
        .await?
        .diagnostics_page(&input.session_id, through, before, 32, PAGE_BYTES)
        .await
        .map_err(|_| "agent_diagnostics_unavailable")?;
    let mut page = DiagnosticPage {
        through: page.through,
        next_before: page.next_before,
        entries: page
            .entries
            .into_iter()
            .map(|entry| Diagnostic {
                sequence: entry.sequence,
                event_id: entry.event_id,
                recorded_at: entry
                    .recorded_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    * 1000.0,
                detail: entry.detail,
            })
            .collect(),
    };
    let value = loop {
        let value = encode(&page)?;
        if maka_plugin_core::json::check_delivery(&value, PAGE_BYTES).is_ok() {
            break value;
        }
        if page.entries.len() <= 1 {
            break value;
        }
        page.entries.pop();
        page.next_before = page.entries.last().map(|entry| entry.sequence);
    };
    owner
        .scoped_session(context.scope(), &input.session_id)
        .await?;
    if context.scope().cancellation.is_cancelled() {
        return Err("agent_observation_cancelled".into());
    }
    Ok(value)
}

pub(super) async fn watch(
    owner: &Owner,
    input: SessionRead,
    context: &Context,
) -> Result<Value, String> {
    owner
        .scoped_session(context.scope(), &input.session_id)
        .await?;
    let mut commits = owner
        .scoped_store(context.scope(), &input.session_id)
        .await?
        .subscribe_commits()
        .map_err(|error| error.to_string())?;
    let mut previous = None;
    loop {
        if context.scope().cancellation.is_cancelled() {
            return Err("agent_observation_cancelled".into());
        }
        owner
            .scoped_session(context.scope(), &input.session_id)
            .await?;
        commits.borrow_and_update();
        let through = owner
            .scoped_store(context.scope(), &input.session_id)
            .await?
            .committed_sequence()
            .await
            .map_err(|error| error.to_string())?;
        let revision = owner
            .scoped_store(context.scope(), &input.session_id)
            .await?
            .latest_diagnostic_sequence(&input.session_id, through)
            .await
            .map_err(|_| "agent_diagnostics_unavailable")?
            .unwrap_or(0);
        owner
            .scoped_session(context.scope(), &input.session_id)
            .await?;
        if context.scope().cancellation.is_cancelled() {
            return Err("agent_observation_cancelled".into());
        }
        if previous != Some(revision) {
            let value = encode(DiagnosticChange { revision })?;
            maka_plugin_core::json::check_delivery(&value, PAGE_BYTES)
                .map_err(|_| "agent_diagnostics_unavailable")?;
            context.emit(value).await?;
            previous = Some(revision);
        }
        tokio::select! {
            biased;
            _ = context.scope().cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
            result = commits.changed() => result.map_err(|_| "agent_observation_closed")?,
        }
    }
}
