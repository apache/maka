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

async fn change(fixture: &Fixture, input: Value) -> Value {
    workhub_mutation(fixture, "changeGraph", input).await
}
async fn workhub_mutation(fixture: &Fixture, method: &str, input: Value) -> Value {
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            binding(fixture).await,
            method.into(),
            input,
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::default().into(),
        )
        .await
        .unwrap();
    let original = prepared.reference().clone();
    let intent = fixture
        .store
        .record_application_intent(
            original.source.clone(),
            prepared.consumer().instance().clone(),
            original,
            Value::Null,
        )
        .await
        .unwrap();
    let reply = client
        .mutate(prepared, intent)
        .await
        .unwrap()
        .result()
        .await;
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        } => value,
        other => panic!("{method} receipt: {other:?}"),
    }
}
async fn graph(fixture: &Fixture, session: &str) -> Value {
    query_import(fixture, hub::EXPORT, "graph", json!({"sessionId": session})).await
}
async fn graph_tool(socket: &mut TcpStream, name: &str, input: Value) {
    let input = if matches!(
        name,
        "workhub_tasks"
            | "agent_list"
            | "view_agent_graph"
            | "update_agent_graph"
            | "ScheduledTask"
    ) {
        json!({"request": input})
    } else {
        input
    };
    graph_tool_arguments(socket, name, input).await;
}
async fn graph_tool_arguments(socket: &mut TcpStream, name: &str, input: Value) {
    let delta = json!({"id":"graph-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":Uuid::new_v4().to_string(),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"graph-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn graph_modes_are_per_conversation_and_keep_pinned_epochs_across_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        activate_workers(&mut fixture, true, true, true).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let first = ready["session"]["id"].as_str().unwrap();
        let second = fixture.create("Second coordinator").await;
        let first_epoch = change(&fixture, json!({"sessionId":first,"action":{"kind":"start","mode":"swarm"}})).await;
        assert_eq!(first_epoch["kind"], "committed", "{first_epoch}");
        let second_epoch = change(&fixture, json!({"sessionId":second,"action":{"kind":"start","mode":"graph"}})).await;
        assert_eq!(second_epoch["kind"], "committed", "{second_epoch}");
        assert_ne!(first_epoch["epoch"]["graphId"], second_epoch["epoch"]["graphId"]);
        assert_eq!(graph(&fixture, first).await["selectedMode"], "swarm");
        assert_eq!(graph(&fixture, &second).await["selectedMode"], "graph");
        let conflict = change(&fixture, json!({"sessionId":first,"expectedGraphId":second_epoch["epoch"]["graphId"],"action":{"kind":"stop"}})).await;
        assert_eq!(conflict["kind"], "conflict");
        let stopped = change(&fixture, json!({"sessionId":first,"expectedGraphId":first_epoch["epoch"]["graphId"],"action":{"kind":"stop"}})).await;
        assert_eq!(stopped["kind"], "committed");
        let next = change(&fixture, json!({"sessionId":first,"expectedGraphId":first_epoch["epoch"]["graphId"],"action":{"kind":"start","mode":"graph"}})).await;
        assert_eq!(next["kind"], "committed", "{next}");
        assert_eq!(next["epoch"]["epoch"].as_u64(), Some(first_epoch["epoch"]["epoch"].as_u64().unwrap() + 1));
        let pinned = query_import(&fixture, hub::EXPORT, "graph", json!({"sessionId":first,"graphId":first_epoch["epoch"]["graphId"]})).await;
        assert_eq!(pinned["status"], "stopped");
        assert_eq!(pinned["epoch"]["mode"], "swarm");
        activate_workers(&mut fixture, false, true, true).await;
        assert_eq!(graph(&fixture, first).await["epoch"], next["epoch"]);
        assert_eq!(graph(&fixture, &second).await["epoch"], second_epoch["epoch"]);
        let history = query_import(&fixture, hub::EXPORT, "graphHistory", json!({"sessionId":first})).await;
        assert_eq!(history["epochs"].as_array().unwrap().len(), 2);
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn graph_real_model_dispatches_original_work_wakes_and_selects_actual_result() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        activate_workers(&mut fixture, true, true, true).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        let epoch = change(&fixture, json!({"sessionId":session,"action":{"kind":"start","mode":"swarm"}})).await;
        assert_eq!(epoch["kind"], "committed", "{epoch}");
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"})).await["roots"][0]["selection"].clone();
        let selection = fixture.selection().await;
        let preset = json!({"id":"graph-reasoner","name":"Graph reasoner","description":"Frozen graph route", "worker":"worker","tools":[],"model":{"connectionId":selection.connection_id,"modelId":selection.model_id},"thinkingLevel":null,"enabled":true,"isolatedWorkspace":false});
        let saved = workhub_mutation(&fixture, "savePresets", json!({"revision":null,"entries":[preset.clone()]})).await;
        assert_eq!(saved["kind"],"saved","{saved}");
        selection::edit(&fixture, |changes| changes.name = Some("Renamed after graph preset save".into())).await;
        let frozen_model = serde_json::to_value(fixture.selection().await).unwrap();
        fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let input = request(&mut socket).await;
        let tools = input["tools"].to_string();
        assert!(tools.contains("update_agent_graph"), "{input}");
        assert!(tools.contains("workhub_tasks"), "Original result and patch inspection remain available");
        graph_tool(&mut socket, "agent_list", json!({"operation":"workers"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let catalog = tool_value(&request(&mut socket).await);
        assert_eq!(catalog["workers"][0]["name"], "worker");
        assert_eq!(catalog["supervisorModel"]["model"], serde_json::to_value(fixture.selection().await).unwrap());
        // Visibility of the original inspection tool must not permit a second
        // untracked route outside the graph decision and its atomic outbox.
        graph_tool(&mut socket, "workhub_tasks", json!({"operation":"route","worker":"worker","target":{"kind":"new","title":"Untracked","workspace":directory,"tools":[]},"note":"Must be refused","model":catalog["supervisorModel"]["model"]})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let denied = request(&mut socket).await;
        assert!(denied["messages"].to_string().contains("graph_decision_required"), "{denied}");
        assert!(query_import(&fixture, hub::EXPORT, "tasks", json!({})).await["entries"].as_array().unwrap().is_empty());
        response(&mut socket).await;
        idle(&fixture, EXPORT, session).await;
        fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let acceptance_lower_bound = maka_agent_authority::now();
        graph_tool(&mut socket, "update_agent_graph", json!({"operation":"add_work","work":[{"target":{"kind":"preset","preset":"graph-reasoner","title":"Graph child","workspace":directory},"instruction":"Produce the original graph result."}]})).await;
        let mut worker_calls = 0;
        let mut finished = false;
        while !finished {
            let (mut socket, _) = listener.accept().await.unwrap();
            let input = request(&mut socket).await;
            if !is_coordinator(&input) {
                worker_calls += 1;
                assert!(input["messages"].to_string().contains("Produce the original graph result."));
                assert_eq!(input["model"], "fixture-model", "graph preset must resolve its current explicit model");
                assert!(input["tools"].is_null() || input["tools"].as_array().is_some_and(Vec::is_empty), "{input}");
                // This request is already admitted. Editing the reusable preset
                // must not change the accepted graph task or its original receipt.
                let mut disabled = preset.clone();
                disabled["enabled"] = json!(false);
                disabled["tools"] = json!(["Read"]);
                disabled["model"]["modelId"] = json!("future-preset-model");
                let edited = workhub_mutation(&fixture, "savePresets", json!({"revision":saved["snapshot"]["revision"],"entries":[disabled]})).await;
                assert_eq!(edited["kind"], "saved", "{edited}");
                response(&mut socket).await;
            } else if input["messages"].to_string().contains("has new durable worker observations") {
                let view = graph(&fixture, session).await;
                let work = &view["work"][0];
                assert_eq!(work["status"], "completed", "{view}");
                let result = query_import(&fixture, hub::EXPORT, "graphResult", json!({"sessionId":session,"graphId":epoch["epoch"]["graphId"],"workId":work["workId"],"resultId":work["resultId"],"offset":0})).await;
                assert_eq!(result["text"], "Elegant response");
                graph_tool(&mut socket, "update_agent_graph", json!({"operation":"finish","resultIds":[work["resultId"]],"reason":"Verified original result"})).await;
                let (mut final_socket, _) = listener.accept().await.unwrap();
                let final_input = request(&mut final_socket).await;
                assert!(is_coordinator(&final_input));
                response(&mut final_socket).await;
                finished = true;
            } else {
                assert_eq!(tool_value(&input)["revision"], 1, "{input}");
                graph_tool(&mut socket, "yield_agent_graph", json!({})).await;
            }
        }
        idle(&fixture, EXPORT, session).await;
        assert_eq!(worker_calls, 1);
        let view = graph(&fixture, session).await;
        assert_eq!(view["status"], "completed", "{view}");
        assert_eq!(view["finish"]["resultIds"][0], view["work"][0]["resultId"]);
        let task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":view["work"][0]["taskId"]})).await;
        let acceptance_upper_bound = maka_agent_authority::now();
        let listed = query_import(&fixture,hub::EXPORT,"tasks",json!({})).await;
        let result_id = view["work"][0]["resultId"].clone();
        activate_workers(&mut fixture, false, true, true).await;
        let restored = graph(&fixture, session).await;
        assert_eq!(restored["work"][0]["resultId"], result_id);
        let restored_task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":view["work"][0]["taskId"]})).await;
        let restored_list = query_import(&fixture,hub::EXPORT,"tasks",json!({})).await;
        assert_eq!(restored_task["operation"], task["operation"]);
        let original_result = query_import(&fixture, hub::EXPORT, "graphResult", json!({"sessionId":session,"graphId":epoch["epoch"]["graphId"],"workId":restored["work"][0]["workId"],"resultId":result_id,"offset":0})).await;
        assert_eq!(original_result["text"], "Elegant response");
        assert_eq!(query_import(&fixture, hub::EXPORT, "presets", json!({})).await["entries"][0]["enabled"], false);
        assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
        let namespace = maka_capabilities::storage::Namespace::new(hub::IMPLEMENTATION,maka_plugin_core::scope::Scope::Profile).unwrap();
        let records = fixture.store.plugin_data_scan(&namespace,maka_capabilities::storage::Scan {prefix:String::new(),after:None}).await.unwrap();
        let notice = records.entries.into_iter().find(|entry| entry.key.ends_with(&format!("tasks/{}",view["work"][0]["taskId"].as_str().unwrap()))).unwrap();
        let maka_capabilities::storage::Data::Present(notice) = notice.record.data else {panic!("task data");};
        assert_eq!(notice["input"]["model"], frozen_model, "accepted graph selection must not be resolved from the edited preset");
        assert_eq!(notice["target"]["tools"], json!([]));
        let admission = &notice["notification"]["admission"];
        let notice_id = admission["source"]["message_id"].as_str().unwrap();
        let facts = fixture.session(&(session)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session {id:session.into()},512,8*1024*1024).await.unwrap();
        let sources: Vec<_> = facts.events.iter().filter_map(|row| match &row.event.fact {
            Fact::InvocationOpened {input:maka_agent_facts::input::InvocationInput::Message {source_messages,..},..} => Some(source_messages.as_slice()),
            _ => None,
        }).flatten().filter(|source| source.message.message_id == notice_id)
            .map(|source|serde_json::to_value(&source.message).unwrap()).collect();
        let mut history_request = json!({"sessionId":session,"position":{"kind":"start"}});
        let mut notice_chunks = Vec::new();
        let mut history_finished = false;
        for _ in 0..128 {
            let page = fixture.query("history",history_request.clone()).await.unwrap();
            history_request["through"] = page["through"].clone();
            assert_eq!(page["kind"], "ready");
            notice_chunks.extend(page["chunks"].as_array().unwrap().iter()
                .filter(|chunk| chunk["role"] == "user" && chunk["messageId"] == notice_id).cloned());
            if page["after"].is_null() {history_finished = true;break;}
            history_request["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
        assert_eq!(task["title"],"Graph child","detail must retain the actual typed graph target title");
        let accepted_at = task["acceptedAt"].as_u64().expect("graph task must expose its Host acceptance time");
        assert!((acceptance_lower_bound..=acceptance_upper_bound).contains(&accepted_at));
        for entry in [&listed["entries"][0],&restored_list["entries"][0],&restored_task] {
            assert_eq!(entry["taskId"],view["work"][0]["taskId"],"metadata must belong to this accepted graph work");
            assert_eq!(entry["title"],"Graph child");
            assert_eq!(entry["acceptedAt"],accepted_at,"graph batch acceptance metadata must survive result completion and restart");
        }
        let expected = json!({"kind":"workhub_graph","graphId":epoch["epoch"]["graphId"]});
        assert_ne!(epoch["epoch"]["graphId"],view["work"][0]["taskId"]);
        assert_eq!(admission["source"]["origin"],expected,"aggregate graph wake belongs to the graph, not its outbox task");
        assert_eq!(sources.len(),1);
        assert_eq!(sources[0]["origin"],expected);
        assert!(history_finished);
        assert!(!notice_chunks.is_empty());
        for chunk in notice_chunks {assert_eq!(chunk["origin"],expected);}
    }).await.unwrap();
}

#[tokio::test]
async fn graph_stop_cancels_original_worker_and_other_coordinator_cannot_read_its_task() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        activate_workers(&mut fixture, true, true, true).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        let epoch = change(&fixture, json!({"sessionId":session,"action":{"kind":"start","mode":"graph"}})).await;
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"})).await["roots"][0]["selection"].clone();
        fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap(); request(&mut socket).await;
        graph_tool(&mut socket, "update_agent_graph", json!({"operation":"add_work","work":[{"target":{"kind":"worker","worker":"worker","title":"Original child","workspace":directory,"tools":[],"model":fixture.selection().await},"instruction":"Keep running until the original stop arrives."}]})).await;
        let mut worker_socket = None;
        let mut yielded = false;
        while worker_socket.is_none() || !yielded {
            let (mut socket, _) = listener.accept().await.unwrap();
            let input = request(&mut socket).await;
            if is_coordinator(&input) {
                assert!(!yielded);
                graph_tool(&mut socket, "yield_agent_graph", json!({})).await;
                yielded = true;
            } else { assert!(worker_socket.is_none()); worker_socket = Some(socket); }
        }
        idle(&fixture, EXPORT, session).await;
        let original = graph(&fixture, session).await;
        let task_id = original["work"][0]["taskId"].clone();
        assert!(!original["quiescent"].as_bool().unwrap());
        let premature = change(&fixture, json!({"sessionId":session,"expectedGraphId":epoch["epoch"]["graphId"],"action":{"kind":"start","mode":"swarm"}})).await;
        assert_eq!(premature["kind"], "rejected");
        let stopped = change(&fixture, json!({"sessionId":session,"expectedGraphId":epoch["epoch"]["graphId"],"action":{"kind":"stop"}})).await;
        assert_eq!(stopped["kind"], "committed");
        loop {
            let view = graph(&fixture, session).await;
            if view["quiescent"] == true { assert_eq!(view["status"], "stopped"); break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let original_task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":task_id})).await;
        assert_eq!(original_task["status"]["progress"]["execution"]["state"], "cancelled", "{original_task}");
        let next = change(&fixture, json!({"sessionId":session,"expectedGraphId":epoch["epoch"]["graphId"],"action":{"kind":"start","mode":"swarm"}})).await;
        assert_eq!(next["kind"], "committed", "{next}");
        assert!(graph(&fixture, session).await["work"].as_array().unwrap().is_empty());
        let second = fixture.create("Other coordinator").await;
        fixture.send(&second).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap(); request(&mut socket).await;
        graph_tool(&mut socket, "workhub_tasks", json!({"operation":"assignments"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let listed = tool_value(&request(&mut socket).await);
        assert!(listed["entries"].as_array().unwrap().is_empty(), "{listed}");
        graph_tool(&mut socket, "workhub_tasks", json!({"operation":"inspect","taskId":task_id})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let denied = request(&mut socket).await;
        assert!(denied["messages"].to_string().contains("workhub_task_source_invalid"), "{denied}");
        assert!(!denied["messages"].to_string().contains("Keep running until"));
        response(&mut socket).await;
        idle(&fixture, EXPORT, &second).await;
        activate_workers(&mut fixture, false, true, true).await;
        assert_eq!(query_import(&fixture, hub::EXPORT, "task", json!({"taskId":task_id})).await["operation"], original_task["operation"]);
        assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
        drop(worker_socket);
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

async fn graph_answer(socket: &mut TcpStream, answer: &str) {
    let delta = json!({"id":"graph-worker","choices":[{"index":0,"delta":{"content":answer},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"graph-worker\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
fn last_user(input: &Value) -> String {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .unwrap()["content"]
        .to_string()
}
async fn graph_work_round(
    fixture: &Fixture,
    listener: &TcpListener,
    session: &str,
    work: Value,
    answer: Option<&str>,
) -> (Value, Option<String>) {
    fixture.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    graph_tool(
        &mut socket,
        "update_agent_graph",
        json!({"operation":"add_work","work":[work]}),
    )
    .await;
    let mut child_input = None;
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        let input = request(&mut socket).await;
        if !is_coordinator(&input) {
            assert!(
                child_input.is_none(),
                "An original graph work must dispatch exactly once"
            );
            child_input = Some(last_user(&input));
            graph_answer(
                &mut socket,
                answer.expect("Invalid historical input must not reach a worker"),
            )
            .await;
        } else if last_user(&input).contains("has new durable worker observations") {
            response(&mut socket).await;
            break;
        } else {
            assert!(tool_value(&input)["revision"].as_u64().is_some(), "{input}");
            graph_tool(&mut socket, "yield_agent_graph", json!({})).await;
        }
    }
    idle(fixture, EXPORT, session).await;
    assert_eq!(child_input.is_some(), answer.is_some());
    let page = graph(fixture, session).await;
    let item = page["work"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["instructionExcerpt"] == work["instruction"])
        .unwrap()
        .clone();
    (item, child_input)
}
async fn finish_graph(fixture: &Fixture, listener: &TcpListener, session: &str, result: &Value) {
    fixture.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    graph_tool(
        &mut socket,
        "update_agent_graph",
        json!({"operation":"finish","resultIds":[result],"reason":"Selected the verified result"}),
    )
    .await;
    let (mut socket, _) = listener.accept().await.unwrap();
    assert_eq!(
        tool_value(&request(&mut socket).await)["update"]["finish"]["resultIds"][0],
        *result
    );
    response(&mut socket).await;
    idle(fixture, EXPORT, session).await;
}

#[tokio::test]
async fn graph_operator_and_selected_history_preserve_large_original_results_without_redispatch() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        activate_workers(&mut fixture, true, true, true).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        let first_epoch = change(&fixture, json!({"sessionId":session,"action":{"kind":"start","mode":"swarm"}})).await;
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"})).await["roots"][0]["selection"].clone();
        let target = json!({"kind":"worker","worker":"worker","title":"Result source","workspace":directory,"tools":[],"model":fixture.selection().await});
        let long_answer = format!("{}ORIGINAL_TAIL", "A".repeat(80_000));
        let (first, _) = graph_work_round(&fixture, &listener, session,
            json!({"target":target,"instruction":"Produce a large original result."}), Some(&long_answer)).await;
        let (second, input) = graph_work_round(&fixture, &listener, session,
            json!({"target":{"kind":"operator","workId":first["workId"]},"instruction":"Continue the original operator with its bounded result.","inputIds":[first["resultId"]]}), Some("Selected operator result")).await;
        let input = input.unwrap();
        assert!(input.contains("Result preview truncated"), "{input}");
        assert!(!input.contains("ORIGINAL_TAIL"));
        assert!(input.len() < 20_000);
        let first_task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":first["taskId"]})).await;
        let second_task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":second["taskId"]})).await;
        assert_eq!(first_task["status"]["sessionId"], second_task["status"]["sessionId"], "Operator continuation must use the original worker session");
        assert_ne!(first_task["operation"], second_task["operation"]);
        let tail = query_import(&fixture, hub::EXPORT, "graphResult", json!({"sessionId":session,"graphId":first_epoch["epoch"]["graphId"],"workId":first["workId"],"resultId":first["resultId"],"offset":80_000})).await;
        assert_eq!(tail["text"], "ORIGINAL_TAIL");
        finish_graph(&fixture, &listener, session, &second["resultId"]).await;
        let next = change(&fixture, json!({"sessionId":session,"expectedGraphId":first_epoch["epoch"]["graphId"],"action":{"kind":"start","mode":"swarm"}})).await;
        assert_eq!(next["kind"], "committed");
        let (invalid, _) = graph_work_round(&fixture, &listener, session,
            json!({"target":target,"instruction":"Reject an unselected historical result.","selectedResultInputs":[{"sourceGraphId":first_epoch["epoch"]["graphId"],"resultId":first["resultId"]}]}), None).await;
        assert_eq!(invalid["status"], "failed");
        assert_eq!(invalid["failure"], "graph_historical_result_not_selected");
        let (third, input) = graph_work_round(&fixture, &listener, session,
            json!({"target":target,"instruction":"Use the selected historical result.","replaces":invalid["workId"],"selectedResultInputs":[{"sourceGraphId":first_epoch["epoch"]["graphId"],"resultId":second["resultId"]}]}), Some("Historical result verified")).await;
        assert!(input.unwrap().contains("Selected operator result"));
        finish_graph(&fixture, &listener, session, &third["resultId"]).await;
        activate_workers(&mut fixture, false, true, true).await;
        let pinned = query_import(&fixture, hub::EXPORT, "graph", json!({"sessionId":session,"graphId":first_epoch["epoch"]["graphId"]})).await;
        assert_eq!(pinned["finish"]["resultIds"][0], second["resultId"]);
        assert_eq!(graph(&fixture, session).await["finish"]["resultIds"][0], third["resultId"]);
        assert_eq!(query_import(&fixture, hub::EXPORT, "task", json!({"taskId":first["taskId"]})).await["operation"], first_task["operation"]);
        assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn model_tool_envelopes_reject_invalid_branches_before_dispatch_and_allow_correction() {
    use maka_agent_facts::tool_call::ToolRejection;

    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.scheduled_tasks = true,
        )
        .await;
        activate_workers(&mut fixture, true, true, true).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        assert_eq!(
            change(
                &fixture,
                json!({"sessionId":session,
            "action":{"kind":"start","mode":"graph"}})
            )
            .await["kind"],
            "committed"
        );
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"}))
            .await["roots"][0]["selection"]
            .clone();
        let invalid = [
            (
                "workhub_tasks",
                json!({"request":{"operation":"workers"},"unexpected":true}),
            ),
            ("workhub_tasks", json!({"operation":"workers"})),
            // The catalog also enforces constraints serde cannot express.
            (
                "workhub_tasks",
                json!({"request":{"operation":"route_preset",
                "dependencies":["same","same"],"preset":"unused","title":"Never routed",
                "workspace":directory,"note":"Must fail before any preparation or effect"}}),
            ),
            ("agent_list", json!({"request":{"operation":"tools"}})),
            (
                "agent_list",
                json!({"request":{"operation":"workers","worker":"worker"}}),
            ),
            (
                "view_agent_graph",
                json!({"request":{"operation":"work","workId":"missing"}}),
            ),
            (
                "update_agent_graph",
                json!({"request":{"operation":"add_work","work":[]}}),
            ),
            ("ScheduledTask", json!({"mode":"list"})),
        ];
        fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        for (index, (name, input)) in invalid.iter().enumerate() {
            graph_tool_arguments(&mut socket, name, input.clone()).await;
            let (mut next, _) = listener.accept().await.unwrap();
            let sent = request(&mut next).await;
            assert!(
                sent["messages"]
                    .to_string()
                    .contains("arguments do not match the declared schema"),
                "{name} must reach the next model step as a normal schema rejection: {sent}"
            );
            let prefix = fixture.prefix(&session, 1000, 2 * 1024 * 1024).await;
            let rejected: Vec<_> = prefix
                .events
                .iter()
                .filter_map(|stored| {
                    if let Fact::ToolRejected {
                        name,
                        input,
                        reason,
                        ..
                    } = &stored.event.fact
                    {
                        Some((name, input, reason))
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(rejected.len(), index + 1);
            let actual = rejected.last().unwrap();
            assert_eq!(actual.0.as_str(), *name);
            assert_eq!(actual.1.as_json(), Some(input));
            assert!(matches!(actual.2, ToolRejection::InvalidInput { message }
                if message == "arguments do not match the declared schema"));
            assert!(
                !prefix
                    .events
                    .iter()
                    .any(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. })),
                "invalid {name} must never dispatch"
            );
            socket = next;
        }
        graph_tool(&mut socket, "agent_list", json!({"operation":"workers"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_eq!(
            tool_value(&request(&mut socket).await)["workers"][0]["name"],
            "worker"
        );
        graph_tool(&mut socket, "ScheduledTask", json!({"mode":"list"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_eq!(
            tool_value(&request(&mut socket).await),
            json!({"tasks":[],"nextCursor":null})
        );
        response(&mut socket).await;
        idle(&fixture, EXPORT, session).await;
        assert_eq!(
            query_import(&fixture, hub::EXPORT, "tasks", json!({})).await["entries"],
            json!([])
        );
        let prefix = fixture.prefix(&session, 1000, 2 * 1024 * 1024).await;
        let dispatched: Vec<_> = prefix
            .events
            .iter()
            .filter_map(|stored| {
                if let Fact::ToolDispatched { name, .. } = &stored.event.fact {
                    Some(name.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(dispatched, ["agent_list", "ScheduledTask"]);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .expect("invalid model requests must remain recoverable without effects");
}
