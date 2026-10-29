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

use crate::support::preflight as support;

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ToolInput;
use maka_agent_facts::tool_call::{ToolCallIdentity, ToolRejection};
use maka_agent_facts::tools::ToolError;
use maka_code_runtime::CellLimits;
use maka_event_log::EventLog;
use maka_tools::CodeExecutor;
use maka_tools::{RunTools, ToolMode};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use support::*;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn preparation_reserves_admission_order_and_publication_defers_effects() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let invocation = invocation("prepared-order");
    let finish = call("finish", "direct", json!({"n": 1}));
    let after = call("after", "echo", json!({"n": 2}));
    accepted(&log, &invocation, &[finish.clone(), after.clone()]).await;
    let effect = Arc::new(Effect::default());
    let run = RunTools::new(
        maka_agent_facts::language::Language::En,
        log.clone(),
        invocation.clone(),
        catalog(effect.clone()),
        ToolMode::Direct,
        CodeExecutor::new(CellLimits::default()).unwrap(),
        maka_tools::availability::LoadedTools::temporary().unwrap(),
    );
    let mut step = run
        .capture(".", CancellationToken::new())
        .await
        .unwrap()
        .into_step(&invocation.invocation_id);
    let before = log.prefix(32, 64 * 1024).await.unwrap();
    let first = step.prepare(finish, CancellationToken::new());
    let second = step.prepare(after, CancellationToken::new());
    let second = second.await.unwrap();
    let first = first.await.unwrap();
    assert_eq!(
        log.prefix(32, 64 * 1024).await.unwrap().digest,
        before.digest
    );
    assert_eq!(effect.0.load(Ordering::SeqCst), 0);
    let rejected = second.publish(&[]).await.unwrap();
    assert!(matches!(
        rejected.completion.await,
        Err(ToolError::Failed(_))
    ));
    let accepted = first.publish(&[]).await.unwrap();
    assert_eq!(effect.0.load(Ordering::SeqCst), 0);
    assert!(!step.finished());
    assert_eq!(accepted.completion.await.unwrap(), json!({"n": 1}));
    assert_eq!(effect.0.load(Ordering::SeqCst), 1);
    assert!(step.finished());
    let prefix = log.prefix(32, 64 * 1024).await.unwrap();
    assert!(prefix.events.iter().any(|stored| matches!(
        &stored.event.fact,
        Fact::ToolRejected { call, reason: ToolRejection::ExclusiveConflict, .. }
            if call == &ToolCallIdentity::provider(invocation.invocation_id.clone(), "after".into())
    )));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_preflight_rejects_before_t1_and_exclusivity_follows_call_order() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let effect = Arc::new(Effect::default());
    let cells = CodeExecutor::new(CellLimits::default()).unwrap();
    let invalid_code_type = serde_json::from_value::<String>(json!(1))
        .expect_err("numeric code must not deserialize as a string")
        .to_string();
    let cases = [
        (
            "finish",
            ToolMode::CodeMode,
            vec![
                (call("finish", "direct", json!({"n": 1})), None),
                (
                    call("after", "exec", json!({"code": "text(4)"})),
                    Some(ToolRejection::ExclusiveConflict),
                ),
            ],
        ),
        (
            "direct",
            ToolMode::Direct,
            vec![
                (
                    call("exec", "exec", json!({"code":"text(1)"})),
                    Some(ToolRejection::Unavailable),
                ),
                (call("ok", "echo", json!({"n":1})), None),
            ],
        ),
        (
            "parallel-first",
            ToolMode::Direct,
            vec![
                (
                    call("hidden", "withheld", json!({"n":1})),
                    Some(ToolRejection::Unavailable),
                ),
                (
                    call("bad", "echo", json!({"n":"1"})),
                    Some(ToolRejection::InvalidInput {
                        message: "arguments do not match the declared schema".into(),
                    }),
                ),
                (call("ok", "echo", json!({"n":2})), None),
                (
                    call("exclusive", "direct", json!({"n":1})),
                    Some(ToolRejection::ExclusiveConflict),
                ),
            ],
        ),
        (
            "exclusive-first",
            ToolMode::CodeMode,
            vec![
                (call("exec", "exec", json!({"code":"text(3)"})), None),
                (
                    call("echo", "echo", json!({"n":1})),
                    Some(ToolRejection::Unavailable),
                ),
                (
                    call("again", "exec", json!({"code":"text(4)"})),
                    Some(ToolRejection::ExclusiveConflict),
                ),
            ],
        ),
        (
            "malformed-direct",
            ToolMode::Direct,
            vec![
                (
                    call("malformed", "echo", ToolInput::from_json("{\"n\":".into())),
                    Some(ToolRejection::InvalidInput {
                        message: "arguments are not valid JSON".into(),
                    }),
                ),
                (call("corrected", "echo", json!({"n":7})), None),
            ],
        ),
        (
            "malformed-exclusive",
            ToolMode::CodeMode,
            vec![
                (
                    call("exec", "exec", ToolInput::from_json("{\"code\":".into())),
                    Some(ToolRejection::InvalidInput {
                        message: "arguments are not valid JSON".into(),
                    }),
                ),
                (
                    call("again", "exec", json!({"code":"text(4)"})),
                    Some(ToolRejection::ExclusiveConflict),
                ),
            ],
        ),
        (
            "invalid-exclusive",
            ToolMode::CodeMode,
            vec![
                (
                    call("exec", "exec", json!({"code":1})),
                    Some(ToolRejection::InvalidInput {
                        message: invalid_code_type,
                    }),
                ),
                (
                    call("again", "exec", json!({"code":"text(4)"})),
                    Some(ToolRejection::ExclusiveConflict),
                ),
            ],
        ),
        (
            "cancelled",
            ToolMode::CodeMode,
            vec![
                (
                    call(
                        "malformed",
                        "exec",
                        ToolInput::from_json("{\"code\":".into()),
                    ),
                    Some(ToolRejection::Cancelled),
                ),
                (
                    call("echo", "echo", json!({"n":1})),
                    Some(ToolRejection::Cancelled),
                ),
                (
                    call("exec", "exec", json!({"code":"text(4)"})),
                    Some(ToolRejection::Cancelled),
                ),
            ],
        ),
    ];
    for (id, mode, expectations) in cases {
        let invocation = invocation(id);
        accepted(
            &log,
            &invocation,
            &expectations
                .iter()
                .map(|(c, _)| c.clone())
                .collect::<Vec<_>>(),
        )
        .await;
        let run = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog(effect.clone()),
            mode,
            cells.clone(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        let request = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        let names: Vec<_> = request.definitions().into_iter().map(|d| d.name).collect();
        assert_eq!(
            names,
            if mode == ToolMode::Direct {
                vec!["direct", "echo"]
            } else {
                vec!["exec", "wait", "direct"]
            }
        );
        let token = CancellationToken::new();
        if id == "cancelled" {
            token.cancel();
        }
        let step_id = &invocation.invocation_id;
        let mut step = request.into_step(step_id);
        for (call, reason) in expectations {
            let result = async {
                step.prepare(call.clone(), token.clone())
                    .await?
                    .publish(&[])
                    .await?
                    .completion
                    .await
            }
            .await;
            let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
            let facts: Vec<_> = prefix
                .events
                .iter()
                .filter(|event| event.event.invocation == invocation)
                .map(|event| &event.event.fact)
                .collect();
            if let Some(reason) = reason {
                assert!(
                    matches!(result, Err(ToolError::Failed(_))),
                    "{id}: {result:?}"
                );
                let Fact::ToolRejected {
                    operation_id,
                    call: identity,
                    name,
                    input,
                    reason: actual,
                } = facts.last().unwrap()
                else {
                    panic!(
                        "{id}:{}: expected rejection, got {:?}",
                        call.id,
                        facts.last()
                    );
                };
                assert_eq!(input, &call.input, "{id}:{}: rejected input", call.id);
                assert_eq!(
                    operation_id,
                    &format!("{step_id}:{}", call.id),
                    "{id}:{}: rejected operation",
                    call.id
                );
                assert_eq!(
                    identity,
                    &ToolCallIdentity::provider(step_id.clone(), call.id.clone()),
                    "{id}:{}: rejected call identity",
                    call.id
                );
                assert_eq!(name, &call.name, "{id}:{}: rejected tool", call.id);
                assert_eq!(actual, &reason, "{id}:{}: rejection reason", call.id);
                assert!(!facts.iter().any(|fact| matches!(fact,
                    Fact::ToolDispatched { operation_id, .. } | Fact::ToolSettled { operation_id, .. }
                    if operation_id == &format!("{step_id}:{}", call.id))));
            } else {
                let value = result.unwrap();
                let expected = if call.name == "exec" {
                    json!({"ok":true,"value":null,"toolCalls":[]})
                } else {
                    call.input.as_json().unwrap().clone()
                };
                if call.name == "exec" {
                    assert_eq!(value["state"], "completed");
                    assert_eq!(value["result"], expected);
                } else {
                    assert_eq!(value, expected);
                }
                assert!(matches!(
                    facts.last().unwrap(),
                    Fact::ToolSettled {
                        outcome: ToolOutcome::Succeeded { .. },
                        ..
                    }
                ));
                let event = &prefix.events.last().unwrap().event;
                assert_eq!(
                    log.resolve_tool_result(&invocation.session_id, &event.id)
                        .await
                        .unwrap()
                        .into_json(),
                    value
                );
            }
        }
        assert_eq!(step.finished(), id == "finish");
        assert!(
            log.invocation_recovery(&invocation)
                .await
                .unwrap()
                .uncertain_operations
                .is_empty()
        );
    }
    assert_eq!(effect.0.load(Ordering::SeqCst), 4);
    let before = log.prefix(200, 1024 * 1024).await.unwrap();
    close(log).await;
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        serde_json::to_value(reopened.prefix(200, 1024 * 1024).await.unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    reopened.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_preflight_is_effect_free_and_diagnostics_are_successful_parent_values() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let effect = Arc::new(Effect::default());
    let cells = CodeExecutor::new(CellLimits::default()).unwrap();
    for (id, code, kind, calls) in [
        (
            "direct-only",
            "await tools.direct({n:1})",
            "execution_error",
            json!([]),
        ),
        (
            "invalid-input",
            "await tools.echo({n:'1'})",
            "tool_failure",
            json!([{"index":1,"name":"echo"}]),
        ),
        ("parse", "return )", "parse_error", json!([])),
    ] {
        let invocation = invocation(id);
        let call = call("exec", "exec", json!({"code":code}));
        accepted(&log, &invocation, std::slice::from_ref(&call)).await;
        let run = RunTools::new(
            maka_agent_facts::language::Language::En,
            log.clone(),
            invocation.clone(),
            catalog(effect.clone()),
            ToolMode::CodeMode,
            cells.clone(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        let value = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step(&invocation.invocation_id)
            .prepare(call.clone(), CancellationToken::new())
            .await
            .unwrap()
            .publish(&[])
            .await
            .unwrap()
            .completion
            .await
            .unwrap();
        assert_eq!(value["state"], "completed");
        assert_eq!(value["result"]["ok"], false);
        assert_eq!(value["result"]["error"]["kind"], kind);
        assert_eq!(value["result"]["toolCalls"], calls);
        assert!(value["result"].get("value").is_none());
        let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
        let effects: Vec<_> = prefix
            .events
            .iter()
            .filter(|event| event.event.invocation == invocation)
            .filter_map(|event| match &event.event.fact {
                Fact::ToolDispatched { operation_id, .. } => Some(operation_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            effects,
            [
                format!("{}:exec", invocation.invocation_id),
                value["cell_id"].as_str().unwrap().to_string()
            ],
            "invalid child arguments must not claim T1"
        );
        assert!(matches!(
            &prefix.events.last().unwrap().event.fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        ));
        assert_eq!(
            log.resolve_tool_result(
                &invocation.session_id,
                &prefix.events.last().unwrap().event.id
            )
            .await
            .unwrap()
            .into_json(),
            value
        );
    }
    assert_eq!(effect.0.load(Ordering::SeqCst), 0);
    close(log).await;
}
