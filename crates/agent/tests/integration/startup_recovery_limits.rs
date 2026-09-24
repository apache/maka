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

use maka_agent::recovery::recover;
use maka_event_log::{EventLog, StoreError};
use maka_runtime::event::{Fact, InvocationOutcome};
use maka_runtime::model::ModelEvent;

use crate::support::recovery;
use recovery::{append, invocation, opening, request};

#[tokio::test]
async fn recovery_excludes_large_stream_history_but_bounds_execution_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    {
        let log = EventLog::open(&path).await.unwrap();
        opening(&log).await;
        request(&log).await;
        append(
            &log,
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "x".repeat(8 * 1024 * 1024),
                    provider_options: None,
                },
            },
        )
        .await;
        log.close().await.unwrap();
    }
    let log = EventLog::open(&path).await.unwrap();
    let mut foreign = invocation();
    foreign.session_id = "unrelated".into();
    assert!(
        matches!(
            log.invocation_recovery(&foreign, 100, 65536).await,
            Err(StoreError::InvalidTransition(_))
        ),
        "an invocation ID cannot substitute another Session"
    );
    assert!(matches!(
        log.unfinished_invocations(0).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.invocation_recovery(&invocation(), 0, 128 * 1024).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.invocation_recovery(&invocation(), 100, 0).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert_eq!(
        log.unfinished_invocations(1).await.unwrap(),
        vec![invocation()]
    );
    assert_eq!(recover(&log).await.unwrap(), 1);
    assert!(log.unfinished_invocations(0).await.unwrap().is_empty());
    assert!(
        matches!(log.turn_boundary("session", "turn").await.unwrap().unwrap().state,
        maka_event_log::turns::InvocationState::Ended { outcome: InvocationOutcome::Failed { class, .. }, .. }
        if class == "host_interrupted")
    );
    let prefix = log.prefix(10, 9 * 1024 * 1024).await.unwrap();
    assert_eq!(prefix.events.len(), 5);
    assert!(
        prefix
            .project_invocation("invocation")
            .unfinished_model_steps
            .is_empty()
    );
}
