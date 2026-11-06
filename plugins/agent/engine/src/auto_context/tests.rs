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
use crate::{ActivationExit, Engine, RunningCompletion};
use maka_agent_facts::event::Invocation;
use maka_model::{ModelError, ModelExecutor};
use std::time::Duration;

async fn filtered_summary(
    error: ModelError,
) -> (RunningCompletion, Result<(), maka_event_log::StoreError>) {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let execution = store.execution_scope(None).await.unwrap();
    let engine = Engine::new(
        ModelExecutor::new(Duration::from_secs(10)).unwrap(),
        maka_tools::CodeExecutor::new(Default::default()).unwrap(),
    )
    .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let context = RunContext::new(engine.0.clone(), execution.store(), &invocation).unwrap();
    let worker_context = context.clone();
    let running = context
        .clone()
        .start_owned(
            execution,
            invocation.clone(),
            Arc::default(),
            None,
            CancellationToken::new(),
            move |_, admitted, _| async move {
                admitted.send(()).unwrap();
                let summary = tokio::spawn(async move { Err(error.into()) });
                assert!(
                    join_worker(&worker_context.cleanup, summary)
                        .await?
                        .is_none()
                );
                Ok(ActivationExit::Terminal(invocation))
            },
        )
        .await
        .unwrap();
    let completion = running.completion().await;
    engine.drain().await;
    drop(context);
    drop(engine);
    (completion, root.shutdown().await)
}

#[tokio::test]
async fn background_error_filter_preserves_cleanup_evidence() {
    for (error, clean) in [
        (ModelError::CleanupUnconfirmed, false),
        (
            ModelError::Http {
                status: 503,
                message: Some("provider unavailable".into()),
            },
            true,
        ),
    ] {
        let (completion, closed) = filtered_summary(error).await;
        assert!(matches!(completion.result, Ok(ActivationExit::Terminal(_))));
        assert_eq!(completion.cleanup.is_ok(), clean);
        assert_eq!(closed.is_ok(), clean);
    }
}
