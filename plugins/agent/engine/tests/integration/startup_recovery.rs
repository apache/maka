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

use crate::support::invocation;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use maka_agent_engine::{Engine, RunError, RunInput};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::TerminalStatus;

use maka_code_runtime::CellLimits;
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_tools::CodeExecutor;
use maka_tools::ToolMode;
use serde_json::json;

use tokio_util::sync::CancellationToken;

use crate::support::recovery_session::invocation;

#[tokio::test]
async fn unknown_dispatch_stays_unknown_and_blocks_next_admission_after_reopen() {
    use crate::support::recovery_session::{append, opening, tool_call};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    {
        let log = crate::support::store::SessionFixture::open(&path)
            .await
            .unwrap();
        opening(&log).await;
        tool_call(&log).await;
        append(
            &log,
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "step:call".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                    "step".into(),
                    "call".into(),
                ),
                name: "write_file".into(),
                input: json!({"path":"effect.txt"}),
            },
        )
        .await;
        log.close().await.unwrap();
    }
    let log = Arc::new(
        crate::support::store::SessionFixture::open(&path)
            .await
            .unwrap(),
    );
    assert_eq!(log.root().recover_invocations().await.unwrap(), 1);
    let prefix = log.prefix(100, 128 * 1024).await.unwrap();
    assert_eq!(prefix.events.len(), 5);
    assert!(
        !prefix
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
    );
    assert!(
        matches!(&prefix.events[4].event.fact, Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed { class, .. }
    } if class == "outcome_unknown")
    );
    let state = prefix.project_invocation("invocation");
    assert_eq!(state.terminal, Some(TerminalStatus::Failed));
    assert_eq!(state.uncertain_operations, vec!["step:call"]);
    let engine = Engine::new(
        ModelExecutor::new(Duration::from_secs(1)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap();
    let result = engine
        .run(
            log.store(),
            RunInput {
                native_activation_basis: None,
                model_source: None,
                model_revision: None,
                provider_id: "fixture".into(),
                main_output_limit: None,
                context: None,
                invocation: Invocation {
                    turn_id: "next-turn".into(),
                    run_id: "next-run".into(),
                    invocation_id: "next-invocation".into(),
                    ..invocation()
                },
                request_fingerprint: None,
                provider: ProviderConfig {
                    image_input: None,
                    adapter: None,
                    capabilities: Default::default(),
                    kind: ProviderKind::OpenaiChatCompletions,
                    model: "unused".into(),
                    base_url: "http://127.0.0.1:1".into(),
                    auth: maka_model::ProviderAuth::ApiKey("unused".into()),
                    headers: BTreeMap::new(),
                    network: Default::default(),
                    body_overlay: None,
                },
                provider_options: json!({}),
                supports_vision: false,
                configuration: invocation::configuration(ToolMode::Direct),
                work: maka_agent_engine::RunWork::Message {
                    allow_prior_unknown: false,
                    source_messages: Vec::new(),
                    message: "continue".into(),
                    tools: Default::default(),
                },
            },
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(result, Err(RunError::ReconciliationRequired(_))));
    assert_eq!(
        log.prefix(100, 128 * 1024).await.unwrap().high_water,
        prefix.high_water
    );
}
