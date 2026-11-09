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
use maka_agent_facts::durable::{Fact, RunId, Terminal};

#[tokio::test]
async fn manual_compaction_has_receipt_busy_stop_and_one_shot_prompt() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = f.create("Compact history").await;
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_compaction_prompt(policy.revision, Some("GLOBAL COMPACTION".into())).await.unwrap();
        let prompts = f.query("compactionPrompt", json!({"sessionId":session})).await.unwrap();
        assert_eq!(prompts["prompt"], Value::Null);
        assert_eq!(prompts["compactionPrompt"], "GLOBAL COMPACTION");
        assert_eq!(prompts["defaultCompactionPrompt"], "GLOBAL COMPACTION");
        let other = f.create("Independent compaction prompt").await;
        let sending = f.mutation(2,"send",json!({"sessionId":session,"message":"original-needle-429","backend":model_backend(&f.selection().await)}),Uuid::new_v4()).await.unwrap();
        let sending_run = f.delivered_run(&sending).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let before = f.query("compactionPrompt", json!({"sessionId":session})).await.unwrap();
        let saved = f.mutation(2,"setCompactionPrompt",json!({"sessionId":session,"expectedRevision":before["revision"],"prompt":"  SESSION COMPACTION  "}),Uuid::new_v4()).await.unwrap();
        assert_eq!(saved["kind"], "committed", "{saved}");
        let prompts = f.query("compactionPrompt", json!({"sessionId":session})).await.unwrap();
        assert_eq!(prompts, json!({"revision":saved["session"]["revision"],"prompt":"  SESSION COMPACTION  ","compactionPrompt":"  SESSION COMPACTION  ","defaultCompactionPrompt":"GLOBAL COMPACTION"}));
        let conflict = f.mutation(2,"setCompactionPrompt",json!({"sessionId":session,"expectedRevision":before["revision"],"prompt":"STALE COMPACTION"}),Uuid::new_v4()).await.unwrap();
        assert_eq!(conflict, json!({"kind":"revision_conflict","expected":before["revision"],"actual":prompts["revision"]}));
        assert_eq!(f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap(), prompts);
        assert_eq!(f.query("observe",json!({"sessionId":session})).await.unwrap()["run"]["runId"], serde_json::to_value(sending_run).unwrap());
        let independent = f.query("compactionPrompt",json!({"sessionId":other})).await.unwrap();
        assert_eq!(independent["prompt"], Value::Null);
        assert_eq!(independent["compactionPrompt"], "GLOBAL COMPACTION");
        response_with_text(&mut socket, "Original answer retained verbatim").await;
        f.drained().await;
        let prompts = f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap();
        let forked = f.mutation(2,"fork",json!({"sessionId":session,"expectedRevision":prompts["revision"],"position":{"kind":"end"},"title":"Inherited compaction prompt","labels":[]}),Uuid::new_v4()).await.unwrap();
        assert_eq!(forked["kind"], "forked", "{forked}");
        let child = forked["session"]["id"].as_str().unwrap();
        let inherited = f.query("compactionPrompt",json!({"sessionId":child})).await.unwrap();
        assert_eq!(inherited["prompt"], "  SESSION COMPACTION  ");
        assert_eq!(inherited["compactionPrompt"], "  SESSION COMPACTION  ");
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"model":f.selection().await,"prompt":"ONE SHOT COMPACTION"});
        let started = f.mutation(2,"compact",input.clone(),operation).await.unwrap();
        assert_eq!(started["kind"], "started", "{started}");
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("ONE SHOT COMPACTION"), "{sent}");
        assert!(!sent.to_string().contains("SESSION COMPACTION"));
        assert!(!sent.to_string().contains("GLOBAL COMPACTION"));
        let observing = f.query("observe",json!({"sessionId":session})).await.unwrap();
        let compacting = observing["compacting"].clone();
        let history = f.history(&session);
        let cut = history.capture_at(observing["through"].as_u64().unwrap()).await.unwrap();
        let boundary = history.latest(&cut).await.unwrap().unwrap();
        let opening: contract::Execution = serde_json::from_value(started["execution"].clone()).unwrap();
        assert_eq!(opening.run_id, boundary.run);
        assert_eq!(opening.session_id, boundary.spec.session_id);
        assert_eq!(opening.turn_id, boundary.spec.turn_id);
        assert_eq!(compacting["id"], boundary.admission.id.to_string());
        assert_eq!(compacting["startedAt"], boundary.admission.at.0);
        assert_eq!(f.query("observe",json!({"sessionId":session})).await.unwrap()["compacting"], compacting);
        let busy = f.mutation(2,"compact",input.clone(),Uuid::new_v4()).await.unwrap();
        assert_eq!(busy, json!({"kind":"rejected","reason":"busy"}));
        response_with_text(&mut socket, "A deliberately short summary without the original unique token.").await;
        f.drained().await;
        assert!(f.query("observe",json!({"sessionId":session})).await.unwrap()["compacting"].is_null());
        let facts = f.recorded_facts(&session).await;
        assert!(facts.iter().any(|record| record.run == boundary.run
            && matches!(&record.fact, Fact::ContextCompacted { .. })), "{facts:?}");
        assert_eq!(f.mutation(2,"compact",input.clone(),operation).await.unwrap(), started);
        let prompts = f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap();
        assert_eq!(prompts["prompt"], "  SESSION COMPACTION  ");
        assert_eq!(prompts["compactionPrompt"], "  SESSION COMPACTION  ");
        let found = f.recall(json!({"terms":["original-needle-429"],"session_id":session})).await.unwrap();
        assert!(!found["passages"].as_array().unwrap().is_empty(), "{found}");
        let hit = &found["passages"][0];
        let through = f.query("observe",json!({"sessionId":session})).await.unwrap()["through"].clone();
        let history = f.query("history",json!({"sessionId":session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert!(history.to_string().contains("original-needle-429"), "{history}");
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap(); request(&mut socket).await; response(&mut socket).await;
        f.drained().await;
        let persistent_input = json!({"sessionId":session,"model":f.selection().await});
        let stopped = f.mutation(2,"compact",persistent_input.clone(),Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("  SESSION COMPACTION  "), "{sent}");
        assert!(!sent.to_string().contains("ONE SHOT COMPACTION"));
        assert!(!sent.to_string().contains("GLOBAL COMPACTION"));
        assert_eq!(f.mutation(2,"stop",json!({"sessionId":session,"runId":stopped["execution"]["runId"]}),Uuid::new_v4()).await.unwrap()["requested"],true);
        f.drained().await;
        let execution = f.query("execution",json!({"sessionId":session,"runId":stopped["execution"]["runId"]})).await.unwrap();
        assert_eq!(execution["execution"]["state"]["kind"],"cancelled");
        assert!(f.query("observe",json!({"sessionId":session})).await.unwrap()["compacting"].is_null());
        let prompts = f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap();
        let empty = f.mutation(2,"setCompactionPrompt",json!({"sessionId":session,"expectedRevision":prompts["revision"],"prompt":""}),Uuid::new_v4()).await.unwrap();
        assert_eq!(empty["kind"], "committed", "{empty}");
        let prompts = f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap();
        assert_eq!(prompts, json!({"revision":empty["session"]["revision"],"prompt":"","compactionPrompt":"","defaultCompactionPrompt":"GLOBAL COMPACTION"}));
        let reset = f.mutation(2,"setCompactionPrompt",json!({"sessionId":session,"expectedRevision":prompts["revision"],"prompt":null}),Uuid::new_v4()).await.unwrap();
        assert_eq!(reset["kind"], "committed", "{reset}");
        assert_eq!(f.query("compactionPrompt",json!({"sessionId":session})).await.unwrap(), json!({"revision":reset["session"]["revision"],"prompt":null,"compactionPrompt":"GLOBAL COMPACTION","defaultCompactionPrompt":"GLOBAL COMPACTION"}));
        assert_eq!(f.query("compactionPrompt",json!({"sessionId":child})).await.unwrap(), inherited);
        let failed = f.mutation(2,"compact",persistent_input,Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("GLOBAL COMPACTION"), "{sent}");
        assert!(!sent.to_string().contains("SESSION COMPACTION"));
        let delta = json!({"id":"truncated-summary","choices":[{"index":0,"delta":{"content":"cut off"},"finish_reason":null}]});
        let end = json!({"id":"truncated-summary","choices":[{"index":0,"delta":{},"finish_reason":"length"}]});
        let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        f.drained().await;
        let execution = f.query("execution",json!({"sessionId":session,"runId":failed["execution"]["runId"]})).await.unwrap();
        assert_eq!(execution["execution"]["state"]["kind"],"failed");
        let failed_run: RunId = serde_json::from_value(failed["execution"]["runId"].clone()).unwrap();
        assert!(f.recorded_facts(&session).await.iter().any(|record| record.run == failed_run
            && matches!(&record.fact, Fact::RunTerminated {terminal: Terminal::Failed, ..})));
        let latest = f.latest_run(&session).await;
        assert_eq!(latest.run, failed_run);
        assert_eq!(f.owner.durable.frontier(latest.run).await.unwrap().terminal, Some(Terminal::Failed));
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}
