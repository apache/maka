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
use serde_json::{Value, json};
use std::path::Path;

mod conversations;
mod external;
mod settings;
mod todo;

struct Fixture {
    host: super::super::candidate::CandidateFixture,
    runtime: tokio::runtime::Runtime,
    client: maka_client::Client,
    listener: Option<tokio::net::TcpListener>,
    // The Host fixture must retire while its synthetic Root still exists.
    directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut host =
            super::super::candidate::CandidateFixture::new(directory.path().join("root"));
        host.child = Some(
            Command::new(env!("CARGO_BIN_EXE_maka"))
                .args(["host", "serve", "--root"])
                .arg(&host.root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        host.wait_for_registration();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (client, listener) = runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = support::model_client(
                &host.root,
                &format!("http://{}/v1", listener.local_addr().unwrap()),
            )
            .await;
            (client, listener)
        });
        Self {
            directory,
            host,
            runtime,
            client,
            listener: Some(listener),
        }
    }

    fn tui(&self) -> Pty {
        Pty::spawn_at(
            &["--root", self.host.root.to_str().unwrap()],
            Some(self.directory.path()),
        )
    }

    fn read(&self, package: &str, method: &str, input: Value) -> Value {
        self.runtime
            .block_on(remote(&self.client, package, method, input))
    }

    fn finish(mut self, mut tui: Pty) {
        tui.close_terminal();
        tui.finish();
        self.client.disconnect();
        self.host.retire_registered();
        assert!(self.host.wait_for_exit().success());
    }
}

/// This independent client only observes domain state. UI actions own mutations.
async fn remote(client: &maka_client::Client, package: &str, method: &str, input: Value) -> Value {
    let binding = RemoteBinding::Package {
        package_id: package.into(),
        method: method.into(),
        session_id: None,
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound {package}/{method}")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await
        .unwrap();
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result else {
        panic!("domain value")
    };
    value
}

fn category(tui: &mut Pty, name: &str, ready: &str) {
    tui.wait_for("Settings");
    tui.click_text("Settings");
    tui.wait_for(name);
    tui.click_text(name);
    tui.wait_for(ready);
}

/// Input editors share the width of the form's longest label plus two spaces.
/// A caption click submits the field; target the editor's actual first column.
fn edit(tui: &mut Pty, label: &str, value: &str, longest_label: &str) {
    tui.wait_for(label);
    let column_width = longest_label.width() + 2;
    assert!(label.width() < column_width);
    let padding = " ".repeat(column_width - label.width());
    let screen = tui.screen.snapshot().unwrap().screen;
    let (row, column) = screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| {
            let start = line.rfind('│').map_or(0, |byte| byte + '│'.len_utf8());
            let body = &line[start..];
            let caption = body.trim_start_matches(' ');
            let suffix = caption.strip_prefix(label)?;
            // Screen snapshots trim trailing spaces, including an empty editor.
            // Populated rows must retain the shared caption column's padding.
            if !suffix.trim().is_empty() && !suffix.starts_with(&padding) {
                return None;
            }
            let byte = start + body.len() - caption.len();
            Some((row, line[..byte].width() + column_width))
        })
        .unwrap_or_else(|| panic!("Missing input {label:?}:\n{screen}"));
    tui.click_at(row, column);
    tui.send(format!("\x01\x1b[200~{value}\x1b[201~").as_bytes());
}

fn reveal(tui: &mut Pty, label: &str) {
    // One price page has at most 128 two-line entries; each wheel tick moves
    // three rows. This input budget covers the page without batching events.
    for _ in 0..128 {
        let previous = tui.screen.snapshot().unwrap().screen;
        if previous.contains(label) {
            return;
        }
        let (row, column) = previous
            .lines()
            .enumerate()
            .filter_map(|(row, line)| line.rfind('┃').map(|byte| (row, line[..byte].width())))
            .max_by_key(|(_, column)| *column)
            .unwrap_or_else(|| {
                panic!("No visible scrollbar while looking for {label:?}:\n{previous}")
            });
        // Observe this tick before sending another, so no queued wheel can
        // move the discovered link between reveal returning and its click.
        let wheel = format!("\x1b[<65;{};{}M", column + 1, row + 1);
        tui.send(wheel.as_bytes());
        tui.wait_until(|screen| screen != previous || screen.contains(label));
    }
    tui.wait_for(label);
}

async fn stored(root: &Path, package: &str, key: &str) -> Value {
    use sqlx::{
        Connection,
        sqlite::{SqliteConnectOptions, SqliteConnection},
    };
    let mut reader = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(root.join(maka_event_log::root::ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT value_json FROM plugin_data WHERE package_id = ? AND key = ? AND value_json IS NOT NULL"
    ).bind(package).bind(key).fetch_all(&mut reader).await.unwrap();
    reader.close().await.unwrap();
    assert_eq!(rows.len(), 1, "one durable {package}/{key} record");
    serde_json::from_str(&rows[0]).unwrap()
}
