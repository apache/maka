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

fn origin(parent: HostSdkParent) -> ToolOrigin {
    ToolOrigin::HostSdk {
        package_id: "fixture.package".into(),
        entry_id: "fixture.entry".into(),
        activation: "fixture.activation".into(),
        parent: Some(parent),
    }
}

#[tokio::test]
async fn only_observer_parent_settles_early_and_pending_effect_survives_reopen() {
    for observer in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host-sdk.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        let parent = event(
            "one",
            dispatch("parent", "parent-call", ToolOrigin::Standalone),
        );
        let relation = if observer {
            HostSdkParent::EvaluationObserver {
                operation_id: "parent".into(),
                epoch: "eb6a8d42-32e5-46d4-a1f7-bd11767a8c3f".into(),
            }
        } else {
            HostSdkParent::NestedEffect {
                operation_id: "parent".into(),
            }
        };
        let child = event("one", dispatch("child", "child-call", origin(relation)));
        log.append_batch(&[
            EventWrite::plain(opening("one")).unwrap(),
            EventWrite::plain(opening("two")).unwrap(),
            EventWrite::plain(parent.clone()).unwrap(),
        ])
        .await
        .unwrap();
        let foreign = event(
            "two",
            dispatch(
                "foreign",
                "foreign-call",
                origin(HostSdkParent::NestedEffect {
                    operation_id: "parent".into(),
                }),
            ),
        );
        assert!(
            log.append(&EventWrite::plain(foreign).unwrap())
                .await
                .is_err()
        );
        log.append(&EventWrite::plain(child.clone()).unwrap())
            .await
            .unwrap();
        let parent_done = event(
            "one",
            settle(
                "parent",
                ToolOutcome::Failed {
                    message: "TIMEOUT".into(),
                },
            ),
        );
        let parent_result = log
            .append(&EventWrite::plain(parent_done.clone()).unwrap())
            .await;
        assert_eq!(parent_result.is_ok(), observer);
        let pending = log.prefix(100, 100_000).await.unwrap();
        assert_eq!(
            pending.project_invocation("one").uncertain_operations,
            if observer {
                vec!["child"]
            } else {
                vec!["child", "parent"]
            }
        );
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert_eq!(
            log.prefix(100, 100_000).await.unwrap().digest,
            pending.digest
        );
        if observer {
            let descendant = event(
                "one",
                dispatch(
                    "descendant",
                    "descendant-call",
                    origin(HostSdkParent::NestedEffect {
                        operation_id: "child".into(),
                    }),
                ),
            );
            log.append(&EventWrite::plain(descendant).unwrap())
                .await
                .unwrap();
            assert!(
                log.append(&success("one", "child", json!("native done")))
                    .await
                    .is_err()
            );
            log.append(&success("one", "descendant", json!(null)))
                .await
                .unwrap();
        }
        log.append(&success("one", "child", json!("native done")))
            .await
            .unwrap();
        if !observer {
            log.append(&EventWrite::plain(parent_done.clone()).unwrap())
                .await
                .unwrap();
        }
        for relation in [
            HostSdkParent::NestedEffect {
                operation_id: "parent".into(),
            },
            HostSdkParent::EvaluationObserver {
                operation_id: "parent".into(),
                epoch: "later".into(),
            },
        ] {
            let late = event("one", dispatch("late", "late-call", origin(relation)));
            assert!(log.append(&EventWrite::plain(late).unwrap()).await.is_err());
        }
        let before_replay = log.prefix(100, 100_000).await.unwrap();
        log.append_batch(&[
            EventWrite::plain(parent).unwrap(),
            EventWrite::plain(child).unwrap(),
            EventWrite::plain(parent_done).unwrap(),
        ])
        .await
        .unwrap();
        let after_replay = log.prefix(100, 100_000).await.unwrap();
        assert_eq!(after_replay.digest, before_replay.digest);
        assert!(
            after_replay
                .project_invocation("one")
                .uncertain_operations
                .is_empty()
        );
    }
}
