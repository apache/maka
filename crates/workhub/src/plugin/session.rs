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

use super::{Manager, error};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    prompt::{self, Format, Section, SectionMode, Text},
    session::{Behavior, Preparation, SessionBehavior},
};
use maka_runtime::execution::NativeToolSet;
use std::{collections::BTreeSet, sync::Arc};

const CLIENT_TOOLS: [&str; 1] = ["mcp__desktop_workhub__control"];
const BROWSER_TOOLS: [&str; 6] = [
    "mcp__desktop_browser__browser_navigate",
    "mcp__desktop_browser__browser_snapshot",
    "mcp__desktop_browser__browser_click",
    "mcp__desktop_browser__browser_type",
    "mcp__desktop_browser__browser_wait",
    "mcp__desktop_browser__browser_extract",
];
pub(super) fn tool_ceiling() -> BTreeSet<String> {
    ["Read", "AskUserQuestion", "workhub_tasks"]
        .into_iter()
        .chain(CLIENT_TOOLS)
        .chain(BROWSER_TOOLS)
        .map(str::to_owned)
        .collect()
}
pub(super) fn publish(staged: &mut Staged, manager: Arc<Manager>) -> Result<(), String> {
    staged
        .insert(
            manager.coordinator.behavior.as_str(),
            SessionBehavior::new(manager.clone())
                .with_native_input(maka_plugins::session::NativeInputPolicy::NativeUserMessages),
        )
        .map_err(error)?;
    staged
        .insert(
            "workhub",
            Section {
                format: Format::Plain,
                order: 0,
                mode: SectionMode::Complete,
                text: Text::Dynamic(Arc::new(Prompt(manager.coordinator.clone()))),
            },
        )
        .map_err(error)?;
    Ok(())
}
impl Behavior for Manager {
    fn prepare(
        &self,
        request: maka_plugins::session::Request,
    ) -> BoxFuture<'_, Result<Preparation, String>> {
        Box::pin(async move {
            if self
                .coordinator
                .session_id()
                .await
                .map_err(error)?
                .as_deref()
                != Some(&request.session.session_id)
            {
                return Err("WorkHub behavior requires its owned coordinator".into());
            }
            Ok(Preparation {
                native_tools: NativeToolSet::Attachments,
                // UI capabilities are optional. A disconnected Desktop must
                // not prevent background result delivery or task assessment.
                required_clients: None,
                tool_ceiling: Some(tool_ceiling()),
                ..Default::default()
            })
        })
    }
}
struct Prompt(Arc<crate::Coordinator>);
impl prompt::Provider for Prompt {
    fn evaluate(
        &self,
        request: prompt::Request,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> prompt::TextFuture {
        let coordinator = self.0.clone();
        Box::pin(async move {
            let selected = coordinator
                .session_id()
                .await
                .map_err(|e| maka_plugins::Error::Invalid(e.to_string()))?
                .as_deref()
                == Some(request.target.session_id());
            Ok(selected.then(|| PROMPT.into()))
        })
    }
}
const PROMPT: &str = "You are Maka, the WorkHub assistant. Coordinate the user's work across approved Sessions. Use workhub_tasks to discover candidates and route, inspect, stop, resume or correct an exact assignment. Candidate visibility is not execution consent; ask the user to authorize a target if needed. Preserve original user input and attachments. Never claim execution was accepted or stopped before observing its receipt. Delivery into shared work does not give you ownership of that execution.";
