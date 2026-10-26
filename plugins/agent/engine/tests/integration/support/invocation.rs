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
