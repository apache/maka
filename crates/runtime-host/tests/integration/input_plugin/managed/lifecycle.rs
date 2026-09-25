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

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn managed_native_input_tracks_paused_preparation_and_fences_reconfiguration_and_retirement()
{
    tokio::time::timeout(Duration::from_secs(40), lifecycle())
        .await
        .unwrap();
}
async fn lifecycle() {
    let fixture = ClientFixture::new("maka-managed-lifecycle-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    fixture::seed(&fixture, &model).await;
    let (pauses, mut paused) = tokio::sync::mpsc::unbounded_channel();
    let manager = Manager::new(pauses);
    let host = Host::open_with_options(
        fixture.owner(),
        None,
        HostOptions {
            plugins: fixture::setup(&manager),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    #[cfg(unix)]
    let endpoint = fixture
        .workspace
        .parent()
        .unwrap()
        .join("managed-lifecycle.sock");
    #[cfg(windows)]
    let endpoint = std::path::PathBuf::from(format!(
        r"\\.\pipe\maka-managed-lifecycle-{}",
        uuid::Uuid::new_v4()
    ));
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop),
    );
    let (mut peer, hello) = Peer::handshake(host.clone(), "paused-input").await;
    let mut control = Peer::new(host.clone(), "control-input").await;
    peer.wait_for_plugins().await;
    let mut observer = Peer::new(host.clone(), "input-availability").await;
    assert_eq!(
        availability(&mut observer, "paused").await,
        "managed_native"
    );
    let fiber = maka_plugins::fiber::Fiber::new(
        "example",
        "control",
        maka_plugins::composition::Scope::Profile,
    )
    .unwrap();
    fiber.begin_loading().unwrap();
    fiber.ready().unwrap();
    fiber.publish().unwrap();
    let commands = host
        .authorize_plugin_execution(fiber.context(), &["managed".into(), "paused".into()])
        .await
        .unwrap();
    let original_target = commands.session("paused".into()).await.unwrap().target;
    let mut notice_revision = None;
    let mut replacement = None;
    for id in ["changed", "replaced", "retired"] {
        peer.send_rpc(
            "paused-submit",
            "turn.message.submit",
            submit(&hello["hostEpoch"], "paused", id, "pause", "current_turn"),
        );
        let release = paused.recv().await.unwrap();
        let query = control
            .rpc(
                "turn.message.execution.query",
                json!({"sessionId":"paused","messageIds":[id,"absent"]}),
            )
            .await;
        assert_eq!(
            resolutions(&query),
            vec![ExecutionResolution::NotAdmitted {
                message_id: "absent".into()
            }],
            "{query}"
        );
        if id == "retired" {
            let response = control.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"example","patch":{"disabled":true}}]})).await;
            assert_eq!(response["ok"], true, "{response}");
        } else if id == "replaced" {
            replacement = Some(manager.replace_behavior());
        } else {
            configure_target(
                commands.as_ref(),
                "paused",
                maka_plugins::execution::Target::Model {
                    model: model.clone(),
                    thinking_level: Some(maka_runtime::execution::ThinkingLevel::Off),
                },
            )
            .await;
        }
        let _ = release.send(());
        loop {
            let response = peer.frame().await;
            if response["requestId"] == "paused-submit" {
                assert_eq!(response["ok"], false, "{response}");
                if id == "changed" {
                    assert_eq!(
                        response["error"]["code"], "operation_unavailable",
                        "{response}"
                    );
                }
                break;
            }
        }
        let query = control
            .rpc(
                "turn.message.execution.query",
                json!({"sessionId":"paused","messageIds":[id]}),
            )
            .await;
        assert_eq!(
            resolutions(&query),
            vec![ExecutionResolution::NotAdmitted {
                message_id: id.into()
            }],
            "{query}"
        );
        if id == "replaced" || id == "retired" {
            let revision = catalog_changed(&mut observer).await;
            assert!(notice_revision.is_none_or(|previous| revision > previous));
            notice_revision = Some(revision);
            assert_eq!(
                availability(&mut observer, "paused").await,
                if id == "retired" {
                    "managed_unavailable"
                } else {
                    "managed_native"
                }
            );
        }
        if id == "retired" {
            control.wait_for_plugins().await;
            let response = control.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"example","patch":{"disabled":false}}]})).await;
            assert_eq!(response["ok"], true, "{response}");
            control.wait_for_plugins().await;
        } else if id == "changed" {
            configure_target(commands.as_ref(), "paused", original_target.clone()).await;
        }
    }
    drop(replacement);
    assert_eq!(provider.requests.lock().unwrap().len(), 0);
    // The manager can launch another behavior; native steering does not gain
    // permission to inject into that differently configured live execution.
    let receipt = commands
        .submit(maka_plugins::execution::Submit {
            operation_id: "manager-override".into(),
            session_id: "managed".into(),
            content: "foreign behavior".into(),
            orchestration_mode: Some(maka_runtime::execution::BehaviorId::default()),
        })
        .await
        .unwrap();
    let active = requests.recv().await.unwrap();
    let rejected = control
        .rpc(
            "turn.message.submit",
            submit(
                &hello["hostEpoch"],
                "managed",
                "foreign-steer",
                "cannot steer",
                "current_turn",
            ),
        )
        .await;
    assert_eq!(
        rejected["error"]["code"], "operation_unavailable",
        "{rejected}"
    );
    active
        .reply
        .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
        .unwrap();
    complete(&mut control, "managed", &json!(receipt.invocation.turn_id)).await;
    drop(commands);
    fiber
        .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    let started = control
        .rpc(
            "turn.message.submit",
            submit(
                &hello["hostEpoch"],
                "managed",
                "native-active",
                "active",
                "current_turn",
            ),
        )
        .await;
    let SubmitResult::TurnStarted { turn_id, .. } = submitted(&started) else {
        panic!("expected a native active run: {started}");
    };
    let active = requests.recv().await.unwrap();
    peer.send_rpc(
        "paused-steer",
        "turn.message.submit",
        submit(
            &hello["hostEpoch"],
            "managed",
            "stale-steer",
            "pause",
            "current_turn",
        ),
    );
    let release = paused.recv().await.unwrap();
    let replacement = manager.replace_behavior();
    release.send(()).unwrap();
    loop {
        let response = peer.frame().await;
        if response["requestId"] == "paused-steer" {
            assert_eq!(
                response["error"]["code"], "operation_unavailable",
                "{response}"
            );
            break;
        }
    }
    let query = control
        .rpc(
            "turn.message.execution.query",
            json!({"sessionId":"managed","messageIds":["stale-steer"]}),
        )
        .await;
    assert_eq!(
        resolutions(&query),
        vec![ExecutionResolution::NotAdmitted {
            message_id: "stale-steer".into()
        }],
        "{query}"
    );
    active
        .reply
        .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
        .unwrap();
    complete(&mut control, "managed", &json!(turn_id)).await;
    drop(replacement);
    peer.close().await;
    control.close().await;
    observer.close().await;
    drop(cleanup);
    server.await.unwrap().unwrap();
    drop(host);
}
