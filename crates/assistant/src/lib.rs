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
mod instructions;
pub mod plan;
mod prompt;
pub mod recall;
pub mod todo;

use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    contributions::Staged,
    fiber::Context,
    kernel::{Plugin, PluginContext},
    preferences::Preferences,
    prompt::{Provider, Request, Section, SectionMode, Text, TextFuture},
    session::{Behavior, Preparation, SessionBehavior},
};
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "maka.assistant";

pub fn input_files() -> std::collections::BTreeSet<String> {
    ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]
        .map(str::to_owned)
        .into()
}

pub struct Builtin;
impl Plugin for Builtin {
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|value| value.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "assistant has no instance configuration".into(),
            ))
        }
    }
    fn supports_scope(&self, scope: &Scope) -> bool {
        *scope == Scope::Profile
    }
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        let Some(host) = context.host else {
            return Box::pin(async { Err("Assistant requires Host preferences".into()) });
        };
        let assistant = Arc::new(Assistant {
            preferences: host.preferences,
            inputs: host.inputs,
            owner: context.lifecycle,
        });
        Box::pin(async move {
            let mut staged = Staged::default();
            staged
                .insert("default", SessionBehavior::new(assistant.clone()))
                .map_err(|e| e.to_string())?;
            staged
                .insert(
                    ID,
                    Section {
                        format: maka_plugins::prompt::Format::Plain,
                        order: i32::MIN,
                        mode: SectionMode::Append,
                        text: Text::Dynamic(assistant),
                    },
                )
                .map_err(|e| e.to_string())?;
            Ok(staged)
        })
    }
}
struct Assistant {
    preferences: Arc<dyn Preferences>,
    inputs: maka_plugins::filesystem::ReadInputs,
    owner: Context,
}
impl Behavior for Assistant {
    fn prepare(
        &self,
        _: maka_plugins::session::Request,
    ) -> BoxFuture<'_, Result<Preparation, String>> {
        Box::pin(async { Ok(Preparation::default()) })
    }
}
impl Provider for Assistant {
    fn evaluate(
        &self,
        _request: Request,
        workspace: maka_plugins::filesystem::ReadDirectory,
    ) -> TextFuture {
        let preferences = self.preferences.clone();
        let inputs = self.inputs.clone();
        let owner = self.owner.clone();
        Box::pin(async move {
            let _guard = owner.admit()?;
            let snapshot = preferences.read().await?;
            let prompt =
                prompt::resolve(snapshot, workspace, inputs.open("user-instructions")?).await;
            prompt
                .validate()
                .map_err(|e| maka_plugins::Error::Invalid(e.into()))?;
            Ok(Some(prompt.text))
        })
    }
}
