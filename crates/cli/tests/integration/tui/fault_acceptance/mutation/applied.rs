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
use maka_protocol::plugin::{RemoteBinding, RemoteRequest, RemoteResult};
use std::collections::BTreeSet;

#[test]
fn applied_same_route_after_ui_failure_reads_a_new_document_without_replaying_submit() {
    for (action, label) in [
        ("ui-same-route-throw", "Save then UI throw"),
        ("ui-same-route-runaway", "Save then UI loop"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut host = CandidateFixture::new(directory.path().join("root"));
        fixture::serve(&mut host);
        let runtime = Runtime::new().unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        let (client, notices) = runtime.block_on(fixture::connect(&host.root));
        runtime.block_on(install(&client, directory.path(), &operation));
        let original_target = runtime.block_on(target(&client));
        let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
        tui.wait_for("Mutation fault");
        tui.click_text("Mutation fault");
        tui.wait_for("Original note");
        tui.click_text("Original note");
        tui.send(b"\x1b[200~Known receipt payload\x1b[201~");
        tui.click_text(label);
        // This requires a real new Page Read at the original null route: the
        // failed UI VM cannot render the durable backend receipt by itself.
        tui.wait_for("Saved same route: Known receipt payload");
        let screen = tui.screen.snapshot().unwrap().screen;
        assert!(!screen.contains("result is unconfirmed"), "{screen}");
        assert!(!screen.contains("Check original submission"), "{screen}");
        let settled = runtime.block_on(stats(&client));
        assert_eq!(settled["business"]["count"], 1);
        assert_eq!(
            settled["original"]["submissions"], 1,
            "Submit must never replay"
        );
        assert_eq!(settled["original"]["submission"]["action"], action);
        assert_eq!(
            settled["original"]["submission"]["fields"]["note"],
            "Known receipt payload"
        );
        assert_eq!(
            settled["original"]["receipt"],
            json!({"kind":"applied", "route":null})
        );
        assert_eq!(
            settled["recoveries"],
            json!([]),
            "known receipt needs no recovery"
        );
        let reads = settled["reads"].as_array().unwrap();
        assert!(reads.iter().all(|read| read["route"].is_null()));
        let documents: BTreeSet<_> = reads
            .iter()
            .map(|read| read["document"].as_str().unwrap())
            .collect();
        assert_eq!(
            documents.len(),
            2,
            "initial form and fresh result Read use distinct documents: {settled}"
        );
        assert_eq!(
            runtime.block_on(target(&client)),
            original_target,
            "UI failure must not retire or reactivate the business registration"
        );
        tui.close_terminal();
        tui.finish();
        assert!(
            checkpoint(directory.path(), &host.root_id)["apps"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["pending"]["input"]["revision"] != operation)
        );
        client.disconnect();
        runtime.block_on(async {
            client.closed().await;
            notices.await.unwrap();
        });
        host.retire_registered();
        assert!(host.wait_for_exit().success());
    }
}

async fn target(client: &maka_client::Client) -> maka_plugins::remote::Target {
    let result = client
        .plugin_remote(RemoteRequest::Bind {
            binding: RemoteBinding::Package {
                package_id: PACKAGE.into(),
                method: "terminal".into(),
                session_id: None,
            },
        })
        .await
        .unwrap();
    let RemoteResult::Bound { target, .. } = result else {
        panic!("terminal was not bound: {result:?}");
    };
    target
}
