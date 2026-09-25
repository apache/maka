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
use maka_protocol::plugin::RemoteKind;

/// Composition commit is not activation completion. Check the Host's settled
/// entry and public presenter binding before attributing a missing page to TUI.
pub(super) async fn settle(client: &maka_client::Client, disabled: bool, receipt: &Value) {
    let mut status = Value::Null;
    let mut entries = Value::Null;
    let mut board = Value::Null;
    let mut binding = String::from("not yet active");
    let settled = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            status = query(client, json!({"view":"status"})).await;
            entries = query(client, json!({"view":"entries", "rootId":"profile", "limit":64})).await;
            board = find_board(&entries["items"]).cloned().unwrap_or(Value::Null);
            if board["status"] == "failed" || status["phase"] == "fenced" {
                return false;
            }
            if status["convergence"] == "converged" && board["disabled"] == disabled {
                if disabled && board["status"] == "disabled" {
                    return true;
                }
                if !disabled && board["status"] == "active" {
                    let result = client.plugin_remote(RemoteRequest::Bind {
                        binding: RemoteBinding::Package {
                            package_id: "example.board".into(),
                            method: "board".into(),
                            session_id: None,
                        },
                    }).await;
                    binding = format!("{result:?}");
                    if matches!(result, Ok(RemoteResult::Bound { target, handler: RemoteKind::Method })
                        if target.entry_id == "board")
                    {
                        return true;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await;
    if matches!(settled, Ok(true)) {
        // On a later UI failure, this proves whether the Host had already
        // converged and published the replacement presenter successfully.
        eprintln!(
            "Board lifecycle disabled={disabled}: receipt={receipt}; status={status}; entry={board}; binding={binding}"
        );
        return;
    }
    let failures = query(client, json!({"view":"failures", "limit":64})).await;
    let views = query(client, json!({"view":"terminal_views", "limit":64})).await;
    panic!(
        "Board lifecycle failed to settle: disabled={disabled}; receipt={receipt}; status={status}; entry={board}; binding={binding}; entries={entries}; failures={failures}; terminalViews={views}"
    );
}

fn find_board(items: &Value) -> Option<&Value> {
    items.as_array()?.iter().find_map(|item| {
        if item["id"] == "board" {
            Some(item)
        } else {
            find_board(&item["children"])
        }
    })
}

async fn query(client: &maka_client::Client, input: Value) -> Value {
    client
        .request(Operation::PluginPlatformQuery, input.clone())
        .await
        .unwrap_or_else(|error| panic!("Board lifecycle query {input}: {error:?}"))
}
