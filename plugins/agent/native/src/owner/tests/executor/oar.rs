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

use super::oar_support::{configured, input, packet, record, release, setup};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

async fn check_output(f: &Fixture, session: &str) {
    let prefix = f.prefix(session, 128, 1024 * 1024).await;
    assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
        maka_agent_facts::event::Fact::ExecutorObserved { output: maka_agent_facts::executor::Output::OutputDelta { text } } if text == "committed output")));
}

#[tokio::test]
async fn native_oar_commits_identity_and_output_before_ack_and_resumes_without_replay() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("OAR durable ACK").await;
        for index in 0..2 {
            let operation = Uuid::new_v4();
            let input = input(&session, "complete");
            let accepted = f
                .mutation(2, "send", input.clone(), operation)
                .await
                .unwrap();
            assert_eq!(accepted["kind"], "started", "{accepted}");
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let journal = record(&f, &session).await;
            assert_eq!(journal["nativeSession"], "native-fixture-session");
            assert_eq!(journal["running"], accepted["invocationId"]);
            assert_eq!(opened["request"]["effort"], "vendor-deep");
            if index == 0 {
                assert!(opened["request"].get("resume").is_none());
            } else {
                assert_eq!(opened["request"]["resume"], "native-fixture-session");
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            check_output(&f, &session).await;
            let active = work(&f, &session, &accepted).await;
            assert!(
                matches!(
                    active["execution"]["state"].as_str(),
                    Some("admitted" | "running")
                ),
                "{active}"
            );
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            assert_eq!(
                record(&f, &session).await["running"],
                accepted["invocationId"]
            );
            release(&mut control).await;
            f.drained().await;
            let final_work = work(&f, &session, &accepted).await;
            assert_eq!(
                final_work["execution"]["state"], "completed",
                "{final_work}"
            );
            assert_eq!(final_work["answer"]["text"], "committed output");
            assert!(record(&f, &session).await["running"].is_null());
            assert_eq!(
                f.mutation(2, "send", input, operation).await.unwrap(),
                accepted
            );
            assert!(listener.accept().now_or_never().is_none());
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_stop_waits_for_disposal_and_worker_exit() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("OAR stop").await;
        let accepted = f
            .mutation(2, "send", input(&session, "wait"), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "started", "{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let observed = f.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(observed["run"]["backend"], "executor");
        let saved = f.mutation(2,"selectBackend",json!({"sessionId":session,"backend":model_backend(&f.selection().await)}),Uuid::new_v4()).await.unwrap();
        assert_eq!(saved["kind"],"committed","{saved}");
        let observed = f.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["kind"], "model");
        assert_eq!(observed["run"]["backend"], "executor", "an active Run keeps its admitted backend after a picker preference changes");
        release(&mut control).await;
        packet(&mut control, "output").await;
        let queued = f.mutation(2,"send", input(&session,"follow-up"),Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"],"queued","{queued}");
        let queue = f.query("queue",json!({"sessionId":session})).await.unwrap();
        let removed = f.mutation(2,"editQueue",json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"retract","messageId":queued["messageId"]}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(removed["kind"],"committed","{removed}");
        let stopped = f
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        packet(&mut control, "terminal").await;
        assert_eq!(record(&f, &session).await["running"], accepted["invocationId"]);
        release(&mut control).await;
        f.drained().await;
        assert!(record(&f, &session).await["running"].is_null());
        let observed = work(&f, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "cancelled", "{observed}");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_model_list_keeps_source_identity_vendor_effort_and_snapshot_revision() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let mut create = f.create_input("Invalid OAR preference").await;
        create["backend"] = json!({"kind":"executor","selection":{"executor":"oar","settings":{}}});
        let rejected = f
            .mutation(2, "create", create, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(rejected["kind"], "rejected", "{rejected}");
        assert_eq!(rejected["reason"], "tools_unavailable");
        let page = f
            .query("models", json!({"kind":"start","query":"OAR codex"}))
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready", "{page}");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        let catalog = packet(&mut trace, "catalog").await;
        assert!(catalog["request"].get("runtime").is_none());
        assert_eq!(page["choices"].as_array().unwrap().len(), 16);
        assert_eq!(page["choices"][0]["selection"]["kind"], "executor");
        assert_eq!(
            page["choices"][0]["selection"]["selection"]["settings"]["runtime"],
            "codex"
        );
        assert_eq!(page["choices"][0]["thinkingLevels"], json!(["vendor-deep"]));
        assert_eq!(page["choices"][0]["defaultThinkingLevel"], "vendor-deep");
        let next = f
            .query(
                "models",
                json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]}),
            )
            .await
            .unwrap();
        assert_eq!(next["choices"].as_array().unwrap().len(), 4);
        assert_eq!(next["complete"], true);
        let stale = f
            .query(
                "models",
                json!({"kind":"continue","revision":"old","cursor":page["next"]}),
            )
            .await
            .unwrap();
        assert_eq!(stale["kind"], "changed");
        assert!(
            listener.accept().now_or_never().is_none(),
            "pagination must reuse discovery"
        );
        let mut selected = page["choices"][0]["selection"].clone();
        selected["selection"]["settings"]["thinkingLevel"] = json!("vendor-deep");
        let detail = f.query("model", json!({"backend":selected})).await.unwrap();
        assert_eq!(detail["kind"], "ready", "{detail}");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        assert_eq!(
            packet(&mut trace, "catalog").await["request"]["runtime"],
            "codex"
        );
        let native = f
            .query("models", json!({"kind":"start","query":"fixture-model"}))
            .await
            .unwrap();
        assert!(
            native["choices"]
                .as_array()
                .unwrap()
                .iter()
                .any(|choice| choice["selection"]["kind"] == "model")
        );
        assert!(
            listener.accept().now_or_never().is_none(),
            "search changes must reuse discovery"
        );
        let installed = f
            .mutation(
                2,
                "oarSetup",
                json!({
                    "runtime":"codex", "action":{"kind":"install"}
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(installed["result"]["kind"], "installed");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        assert_eq!(
            packet(&mut trace, "setup").await["request"]["action"],
            "install"
        );
        let refreshed = f
            .query("models", json!({"kind":"start","query":"OAR codex"}))
            .await
            .unwrap();
        assert_eq!(refreshed["choices"], page["choices"]);
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        assert!(
            packet(&mut trace, "catalog").await["request"]
                .get("runtime")
                .is_none()
        );
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_worker_exit_without_disposal_retains_identity_and_never_replays_original_prompt()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("OAR unknown disposal").await;
        let operation = Uuid::new_v4();
        let input = input(&session,"crash");
        let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
        assert_eq!(accepted["kind"],"started","{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"opened").await;
        release(&mut control).await;
        packet(&mut control,"output").await;
        release(&mut control).await;
        f.drained().await;
        assert_eq!(record(&f, &session).await["running"],accepted["invocationId"]);
        let observed = work(&f,&session,&accepted).await;
        assert_eq!(observed["execution"]["state"],"failed","{observed}");
        let prefix = f.prefix(&session,128,1024*1024).await;
        assert!(prefix.events.iter().any(|row|matches!(&row.event.fact,maka_agent_facts::event::Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Failed {class,..},..} if class=="outcome_unknown")));
        assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
        assert!(listener.accept().now_or_never().is_none());
        assert!(f.app.shutdown_if_idle().await.unwrap_err().contains("cleanup_unconfirmed"), "Unconfirmed physical ownership must not retire successfully");
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_oar_setup_preserves_native_unsupported_and_original_installation_receipt() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let operation = Uuid::new_v4();
        let input = json!({"runtime":"antigravity","action":{"kind":"plan","line":"stable"}});
        let result = f
            .mutation(2, "oarSetup", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(result["runtime"], "antigravity");
        assert_eq!(result["result"]["kind"], "unsupported", "{result}");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        let sent = packet(&mut trace, "setup").await;
        assert_eq!(sent["request"]["action"], "plan");
        assert_eq!(sent["request"]["options"], json!({"line":"stable"}));
        assert_eq!(
            f.mutation(2, "oarSetup", input, operation).await.unwrap(),
            result
        );
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "Requires an explicitly selected OAR worker and authenticated local Codex"]
async fn native_oar_live_codex_executes_high_and_resumes_the_native_conversation() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let worker = std::env::var("MAKA_OAR_TEST_WORKER").expect("Set MAKA_OAR_TEST_WORKER to the actual worker under test");
        let f = Fixture::configured("http://127.0.0.1:9/v1",None,None,None,|settings| {
            settings.oar = Some(maka_agent_api::executor::OarConfiguration { enabled: true,runtimes:BTreeMap::from([("codex".into(),true)]),executable:Some(worker),args:vec![]});
        }).await;
        let mut create = f.create_input("Live OAR execution").await;
        create["backend"] = json!({"kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"gpt-6-astra","thinkingLevel":"high"}}});
        let created = f.mutation(2,"create",create,Uuid::new_v4()).await.unwrap();
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let marker = format!("HOST-OAR-{}",Uuid::new_v4());
        let mut native_session = None;
        for message in [format!("Remember this verification marker for our next turn: {marker}. Reply with exactly that marker, no other text. Do not use tools."),"What verification marker did I give in our previous turn? Reply with exactly that marker, no other text. Do not use tools.".into()] {
            let operation = Uuid::new_v4();
            let input = json!({"sessionId":session,"message":message});
            let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
            assert_eq!(accepted["kind"],"started","{accepted}");
            f.drained().await;
            let observed = work(&f,&session,&accepted).await;
            assert_eq!(observed["execution"]["state"],"completed","{observed}");
            assert_eq!(observed["answer"]["text"].as_str().unwrap().trim(),marker,"{observed}");
            let journal = record(&f, &session).await;
            let current = journal["nativeSession"].as_str().unwrap();
            match &native_session { Some(previous)=>assert_eq!(previous,current),None=>native_session=Some(current.to_owned()) }
            assert!(journal["running"].is_null());
            assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_model_detail_never_starts_oar_and_empty_roots_keep_native_discovery() {
    tokio::time::timeout(Duration::from_secs(40), async {
        for empty in [false, true] {
            let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
                if empty { settings.workspace_roots.clear(); }
            }).await;
            let detail = f.query("model", json!({"backend":model_backend(&f.selection().await)})).await.unwrap();
            assert_eq!(detail["kind"], "ready", "{detail}");
            assert_eq!(detail["choice"]["selection"]["kind"], "model");
            if empty {
                let page = f.query("models", json!({"kind":"start","query":""})).await.unwrap();
                assert_eq!(page["kind"], "ready");
                assert_eq!(page["choices"].as_array().unwrap().len(), 1);
                assert_eq!(page["choices"][0]["selection"]["kind"], "model");
                let external = f.query("model", json!({"backend":{
                    "kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"external-0"}}
                }})).await.unwrap();
                assert_eq!(external["kind"], "unavailable");
                let error = f.mutation(2, "oarSetup", json!({
                    "runtime":"codex","action":{"kind":"probe"}
                }), Uuid::new_v4()).await.unwrap_err();
                assert!(error.contains("agent_workspace_unavailable"), "{error}");
            }
            assert!(listener.accept().now_or_never().is_none(), "native discovery or missing roots must not start an OAR worker");
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn cancelling_one_model_search_keeps_shared_discovery_and_reuses_its_result() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings
                .oar
                .as_mut()
                .unwrap()
                .args
                .push("--hold-catalog".into());
        })
        .await;
        let cancelled = CancellationToken::new();
        let first = f.owner.models(
            ModelsRead::Start {
                query: "OAR".into(),
            },
            &cancelled,
        );
        tokio::pin!(first);
        let socket = tokio::select! {
            result = &mut first => panic!("catalog unexpectedly completed: {}", result.is_ok()),
            socket = listener.accept() => socket.unwrap().0,
        };
        let mut trace = BufReader::new(socket);
        assert!(
            packet(&mut trace, "catalog").await["request"]
                .get("runtime")
                .is_none()
        );
        let continuing = CancellationToken::new();
        let second = f.owner.models(
            ModelsRead::Start {
                query: "OAR codex".into(),
            },
            &continuing,
        );
        tokio::pin!(second);
        assert!(second.as_mut().now_or_never().is_none());
        cancelled.cancel();
        assert!(
            first.await.is_err(),
            "the cancelled caller must stop waiting"
        );
        assert!(second.as_mut().now_or_never().is_none());
        release(&mut trace).await;
        let result = serde_json::to_value(second.await.unwrap()).unwrap();
        assert_eq!(result["kind"], "ready");
        assert_eq!(result["choices"].as_array().unwrap().len(), 16);
        let again = f
            .query("models", json!({"kind":"start","query":"OAR codex"}))
            .await
            .unwrap();
        assert_eq!(again, result);
        assert!(
            listener.accept().now_or_never().is_none(),
            "both search callers and the later read share one worker"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelled_single_runtime_query_drains_terminal_and_allows_clean_retirement() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.oar.as_mut().unwrap().args.push("--hold-catalog".into());
        }).await;
        let cancellation = CancellationToken::new();
        let selected = serde_json::from_value(json!({"backend":{
            "kind":"executor","selection":{"executor":"oar","settings":{"runtime":"codex","model":"external-0"}}
        }})).unwrap();
        let query = f.owner.model(selected, &cancellation);
        tokio::pin!(query);
        let socket = tokio::select! {
            result = &mut query => panic!("uncached query unexpectedly completed: {}", result.is_ok()),
            socket = listener.accept() => socket.unwrap().0,
        };
        let mut trace = BufReader::new(socket);
        assert_eq!(packet(&mut trace, "catalog").await["request"]["runtime"], "codex");
        cancellation.cancel();
        packet(&mut trace, "catalog_cancelled").await;
        // A terminal result already produced during cancellation remains authoritative.
        let result = serde_json::to_value(query.await.unwrap()).unwrap();
        assert_eq!(result["kind"], "ready");
        assert_eq!(result["choice"]["selection"]["selection"]["settings"]["model"], "external-0");
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn external_agents_disabled_and_inspect_never_start_workers_or_admit_disabled_send() {
    tokio::time::timeout(Duration::from_secs(40), async {
        for configuration in ["absent", "disabled", "legacy", "unselected"] {
            let configured_oar = configuration != "absent";
            let (f, listener) =
                configured("http://127.0.0.1:9/v1", |settings| match configuration {
                    "absent" => settings.oar = None,
                    "disabled" => settings.oar.as_mut().unwrap().enabled = false,
                    "legacy" => {
                        let mut legacy =
                            serde_json::to_value(settings.oar.as_ref().unwrap()).unwrap();
                        legacy.as_object_mut().unwrap().remove("runtimes");
                        settings.oar = Some(serde_json::from_value(legacy).unwrap());
                    }
                    "unselected" => {
                        settings.oar.as_mut().unwrap().runtimes =
                            BTreeMap::from([("codex".into(), false)])
                    }
                    _ => unreachable!(),
                })
                .await;
            for inspect in [false, true] {
                let result = f
                    .query("externalAgents", json!({"inspect":inspect}))
                    .await
                    .unwrap();
                assert_eq!(
                    result["target"],
                    json!({"source":f.owner.data_source, "path":["oar"]})
                );
                assert_eq!(result["configured"], configured_oar);
                assert_eq!(result["state"], json!({"kind":"disabled"}));
                let runtimes = result["runtimes"].as_array().unwrap();
                assert_eq!(
                    runtimes
                        .iter()
                        .find(|runtime| runtime["id"] == "codex")
                        .unwrap(),
                    &json!({"id":"codex", "name":"Codex", "enabled":false})
                );
                assert!(runtimes.iter().all(|runtime| runtime["enabled"] == false));
            }
            let session = f.create("Disabled external agent").await;
            let error = f
                .mutation(2, "send", input(&session, "must not run"), Uuid::new_v4())
                .await
                .unwrap_err();
            assert!(error.contains("agent_executor_unavailable"), "{error}");
            assert!(listener.accept().now_or_never().is_none());
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let inspected = f
            .query("externalAgents", json!({"inspect":true}))
            .await
            .unwrap();
        assert_eq!(inspected["state"], json!({"kind":"enabled"}));
        assert_eq!(inspected["configured"], true);
        assert_eq!(
            inspected["runtimes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|runtime| runtime["id"] == "codex")
                .unwrap(),
            &json!({"id":"codex", "name":"Codex", "enabled":true})
        );
        assert!(listener.accept().now_or_never().is_none());
        let status = f.query("externalAgents", json!({})).await.unwrap();
        assert_eq!(status["state"]["kind"], "ready");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut trace, "status").await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn external_agents_preserves_all_runtimes_and_refreshes_without_catalog_cache() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for _ in 0..2 {
            let result = f.query("externalAgents", json!({})).await.unwrap();
            assert_eq!(result["state"]["kind"], "ready");
            let runtimes = result["state"]["runtimes"].as_array().unwrap();
            assert_eq!(runtimes.len(), 4);
            assert_eq!(
                runtimes[0]["authentication"],
                json!({"kind":"authenticated", "source":"codex login status"})
            );
            assert_eq!(runtimes[1]["authentication"]["kind"], "unauthenticated");
            assert_eq!(runtimes[2]["installation"]["kind"], "not_found");
            assert_eq!(
                runtimes[2]["installLines"],
                json!([{"line":"stable","description":"Stable"}])
            );
            assert_eq!(
                runtimes[3]["installation"],
                json!({"kind":"error","detail":"Probe failed"})
            );
            let mut trace = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut trace, "status").await;
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn external_agents_reports_workspace_unavailable_and_workhub_configuration_target() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.workspace_roots.clear()
        })
        .await;
        assert_eq!(
            f.query("externalAgents", json!({})).await.unwrap()["state"],
            json!({"kind":"workspace_required"})
        );
        assert_eq!(
            f.query("externalAgents", json!({"inspect":true}))
                .await
                .unwrap()["state"],
            json!({"kind":"enabled"})
        );
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        let (f, _) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.oar.as_mut().unwrap().executable = Some("/nonexistent/maka-oar-worker".into());
        })
        .await;
        let result = f.query("externalAgents", json!({})).await.unwrap();
        assert_eq!(result["state"]["kind"], "unavailable");
        assert!(!result["state"]["message"].as_str().unwrap().is_empty());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        let f = Fixture::workhub("http://127.0.0.1:9/v1", workhub::Setup::Coordinator).await;
        let result = f
            .query("externalAgents", json!({"inspect":true}))
            .await
            .unwrap();
        assert_eq!(
            result["target"],
            json!({"source":f.owner.data_source,"path":["agent","oar"]})
        );
        assert_eq!(result["state"], json!({"kind":"disabled"}));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn external_agents_cancelled_status_settles_without_poisoning_next_query() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.oar.as_mut().unwrap().args.push("--hold-status".into());
        }).await;
        let observed = scope(&f.issuer, true);
        let query = f.owner.external_agents(false, &observed);
        tokio::pin!(query);
        let socket = tokio::select! {
            result = &mut query => panic!("status unexpectedly completed: {}", result.is_ok()),
            socket = listener.accept() => socket.unwrap().0,
        };
        let mut trace = BufReader::new(socket);
        packet(&mut trace, "status").await;
        observed.cancellation.cancel();
        packet(&mut trace, "status_cancelled").await;
        assert_eq!(serde_json::to_value(query.await.unwrap()).unwrap()["state"]["kind"], "ready");
        observed.resources.finish().await.unwrap();
        let query = f.query("externalAgents", json!({}));
        tokio::pin!(query);
        let socket = tokio::select! {
            result = &mut query => panic!("fresh status unexpectedly completed: {}", result.is_ok()),
            socket = listener.accept() => socket.unwrap().0,
        };
        let mut trace = BufReader::new(socket);
        packet(&mut trace, "status").await;
        release(&mut trace).await;
        assert_eq!(query.await.unwrap()["state"]["kind"], "ready");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_oar_runtime_opt_in_gates_queries_and_admission_before_starting_workers() {
    use maka_agent_ports::executor::{Backend as _, Error, Request};
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.oar.as_mut().unwrap().runtimes = BTreeMap::from([
                ("codex".into(), true),
                ("antigravity".into(), false),
            ]);
        }).await;
        let cwd = f.owner.oar_cwd().await.unwrap().unwrap();
        for runtime in ["antigravity", "claude"] {
            for kind in ["catalog", "setup"] {
                let error = f.owner.executors.oar_query(
                    cwd.clone(),
                    json!({"kind":kind,"runtime":runtime,"action":"probe","cwd":cwd}),
                    CancellationToken::new(),
                ).await.unwrap_err();
                assert!(matches!(error, Error::Invalid(ref message) if message == &format!("OAR runtime is not enabled: {runtime}")), "{error}");
            }
        }
        for runtime in ["antigravity", "claude", "codex"] {
            let selection = executor::Selection {
                executor: "oar".into(),
                settings: maka_agent_facts::executor::Settings {
                    runtime: Some(runtime.into()),
                    ..Default::default()
                },
            };
            let backend = f.owner.executors.select(selection.clone()).unwrap();
            let result = backend.admit_execution(Request {
                language: maka_agent_facts::language::Language::En,
                invocation: maka_agent_facts::event::Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                conversation_key: "conversation".into(),
                content: serde_json::from_value(json!({"text":"must not start"})).unwrap(),
                cwd: cwd.clone(),
                instructions: None,
                settings: selection.settings,
            });
            if runtime == "codex" {
                assert_eq!(result.unwrap().identity.entry_id, "oar");
            } else {
                let error = result.err().expect("unselected runtime admission must fail");
                assert!(matches!(error, Error::Invalid(ref message) if message == &format!("OAR runtime is not enabled: {runtime}")), "{error}");
            }
        }
        assert!(listener.accept().now_or_never().is_none());
        let inspected = f.query("externalAgents", json!({"inspect":true})).await.unwrap();
        let enabled = inspected["runtimes"].as_array().unwrap().iter()
            .filter(|runtime| runtime["enabled"] == true)
            .map(|runtime| runtime["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(enabled, vec!["codex"]);
        assert!(listener.accept().now_or_never().is_none());
        let catalog = f.owner.executors.oar_query(
            cwd.clone(),
            json!({"kind":"catalog","runtimes":["antigravity"],"cwd":cwd}),
            CancellationToken::new(),
        ).await.unwrap().unwrap();
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        assert_eq!(packet(&mut trace, "catalog").await["request"]["runtimes"], json!(["codex"]));
        assert_eq!(catalog.as_array().unwrap().len(), 1);
        assert_eq!(catalog[0]["runtime"], "codex");
        let status = f.query("externalAgents", json!({})).await.unwrap();
        assert_eq!(status["state"]["kind"], "ready");
        assert_eq!(status["state"]["runtimes"].as_array().unwrap().len(), 1);
        assert_eq!(status["state"]["runtimes"][0]["id"], "codex");
        let mut trace = BufReader::new(listener.accept().await.unwrap().0);
        assert_eq!(packet(&mut trace, "status").await["request"]["runtimes"], json!(["codex"]));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
