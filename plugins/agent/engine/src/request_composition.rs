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

use maka_agent_facts::language::Language;

use crate::{RunError, RunInput, RunSettings};
use maka_agent_facts::composition::FrozenComposition;
use maka_agent_facts::composition::RequestComposition;
use maka_tools::RequestTools;
use std::sync::Arc;

pub(super) fn session_context<W>(input: &RunInput<W>) -> Vec<String> {
    vec![format!(
        "{}\n{}",
        match input.configuration.language {
            Language::En => "Session context (data):",
            Language::ZhCn => "会话上下文（数据）：",
            Language::ZhTw => "工作階段上下文（資料）：",
        },
        serde_json::json!({
            "cwd": input.configuration.cwd,
            "sessionId": input.invocation.session_id,
        })
    )]
}

pub(super) fn render_system(system: Option<&str>, context: &[String]) -> Option<String> {
    let mut rendered = system.map(str::to_owned);
    for section in context {
        let text = rendered.get_or_insert_with(String::new);
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(section);
    }
    rendered
}

pub(super) struct Surface {
    pub adapter: maka_agent_ports::model::Binding,
    pub max_output_tokens: Option<u64>,
    system: Option<Arc<String>>,
    pub evidence: Arc<FrozenComposition>,
}

impl Surface {
    pub fn system(&self) -> Option<Arc<String>> {
        self.system.clone()
    }

    pub fn capture(
        tools: &RequestTools<'_>,
        models: &maka_model::ModelExecutor,
        input: &RunSettings,
        source: &maka_event_log::context::ContextView,
        prior_unknown_notice: Option<&str>,
    ) -> Result<Self, RunError> {
        let mut system = input
            .configuration
            .system_prompt
            .as_ref()
            .map(|prompt| prompt.text.clone());
        let mut sources = input
            .configuration
            .system_prompt
            .as_ref()
            .map(|prompt| prompt.sources.clone())
            .unwrap_or_default();
        if let Some(notice) = prior_unknown_notice {
            let system = system.get_or_insert_with(String::new);
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(notice);
        }
        let adapter = models.binding(&input.provider)?;
        sources.push(adapter.source().clone());
        if let Some(source) = &input.model_revision {
            sources.push(source.clone());
        }
        let max_output_tokens = crate::auto_context::output_limit(input, source)?;
        let dynamic_context = session_context(input);
        let rendered = render_system(system.as_deref(), &dynamic_context);
        let evidence = RequestComposition {
            system_prompt: system,
            dynamic_context,
            tool_catalog_digest: tools.catalog_digest().into(),
            tools: tools.definitions(),
            provider_options: Some(input.provider_options.clone()),
            max_output_tokens,
            sources: sources.clone(),
        }
        .freeze()
        .map_err(|error| RunError::Internal(error.into()))?;
        Ok(Self {
            adapter,
            max_output_tokens,
            system: rendered.map(Arc::new),
            evidence: Arc::new(evidence),
        })
    }

    pub fn summary(
        adapter: maka_agent_ports::model::Binding,
        mut composition: RequestComposition,
        output_budget: u64,
    ) -> Result<Self, RunError> {
        composition.max_output_tokens = Some(output_budget);
        Ok(Self {
            adapter,
            max_output_tokens: Some(output_budget),
            system: render_system(
                composition.system_prompt.as_deref(),
                &composition.dynamic_context,
            )
            .map(Arc::new),
            evidence: Arc::new(
                composition
                    .freeze()
                    .map_err(|error| RunError::Internal(error.into()))?,
            ),
        })
    }
}
