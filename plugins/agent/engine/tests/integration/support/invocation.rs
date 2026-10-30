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

use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;

pub fn configuration(tool_mode: ToolMode) -> InvocationConfiguration {
    InvocationConfiguration {
        language: maka_agent_facts::language::Language::En,
        compaction_prompt: None,
        workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
        approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
        workspace_binding: None,
        boundary_revision: 0,
        workspace_identity: None,
        system_prompt: None,
        editing_tools: None,
        tool_discovery: false,
        tool_composition: None,
        cwd: std::env::current_dir()
            .expect("test working directory")
            .into_os_string()
            .into_string()
            .expect("UTF-8 test working directory"),
        sandbox_mode: SandboxMode::DangerFullAccess,
        collaboration_mode: CollaborationMode::Agent,
        orchestration_mode: BehaviorId::default(),
        tool_mode,
        code_language: Default::default(),
        model: None,
        thinking_level: None,
    }
}

pub fn input(
    base: &str,
    suffix: &str,
    work: maka_agent_engine::RunWork,
) -> maka_agent_engine::RunInput {
    maka_agent_engine::RunInput {
        model_source: None,
        native_activation_basis: None,
        model_revision: None,
        provider_id: "fixture".into(),
        main_output_limit: None,
        context: None,
        invocation: maka_agent_facts::event::Invocation {
            session_id: "session".into(),
            turn_id: format!("turn-{suffix}"),
            run_id: format!("run-{suffix}"),
            invocation_id: format!("invocation-{suffix}"),
        },
        request_fingerprint: None,
        provider: maka_model::ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind: maka_model::ProviderKind::OpenaiChatCompletions,
            model: "test".into(),
            base_url: base.into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
            headers: Default::default(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: serde_json::json!({}),
        supports_vision: false,
        configuration: configuration(ToolMode::Direct),
        work,
    }
}
