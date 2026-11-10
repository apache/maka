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

use super::{
    call,
    host::{self, Sandbox},
};
use maka_capabilities::call::ReadResource;
use maka_host_runtime::application::host::Client;
use maka_plugin_core::contract::ResourceType;
use serde_json::{Value, json};
use std::{ops::Range, sync::Arc, time::Duration};

struct Attachment;
const ATTACHMENT: &[u8] = "portable checkpoint attachment — 附件\n".as_bytes();
impl ReadResource for Attachment {
    fn resource_type(&self) -> ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        ATTACHMENT.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        ATTACHMENT
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid attachment range".into())
    }
}

pub(super) async fn upload(client: &Client, session: &str) -> String {
    let payload: Arc<dyn ReadResource> = Arc::new(Attachment);
    let upload = call(
        client,
        "agent",
        "uploadAttachment",
        json!({
            "sessionId":session, "name":"sample.txt", "bytes":ATTACHMENT.len(),
            "digest":maka_agent_facts::artifact::content_digest(ATTACHMENT),
        }),
        [("file".into(), payload)].into(),
    )
    .await;
    assert_eq!(upload["kind"], "uploaded", "{upload}");
    upload["attachment"]["id"].as_str().unwrap().to_owned()
}

async fn try_export(
    sandbox: &Sandbox,
    session: &str,
    head: &Value,
    archive: &std::path::Path,
) -> std::process::Output {
    host::command(sandbox)
        .unwrap()
        .args(["checkpoint", "export", "--root"])
        .arg(&sandbox.root)
        .args([
            "--session",
            session,
            "--revision",
            head["revision"].as_str().unwrap(),
            "--output",
        ])
        .arg(archive)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap()
}
// The first compressed write happens after the source head has been read.
pub(super) async fn advance_during_export(
    client: &Client,
    sandbox: &Sandbox,
    session: &str,
    head: &Value,
) -> Value {
    use std::io::{self, Write};
    use tokio::sync::oneshot;
    struct PausedSink {
        started: Option<oneshot::Sender<()>>,
        resume: std::sync::mpsc::Receiver<()>,
    }
    impl Write for PausedSink {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
                self.resume
                    .recv_timeout(Duration::from_secs(30))
                    .map_err(io::Error::other)?;
            }
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let (started, waiting) = oneshot::channel();
    let (resume, paused) = std::sync::mpsc::channel();
    let root = sandbox.root.clone();
    let source = session.to_owned();
    let revision = serde_json::from_value(head["revision"].clone()).unwrap();
    let export = tokio::task::spawn_blocking(move || {
        maka_event_log::root_store::portable::export(
            &root,
            &source,
            revision,
            PausedSink {
                started: Some(started),
                resume: paused,
            },
        )
    });
    tokio::time::timeout(Duration::from_secs(15), waiting)
        .await
        .unwrap()
        .unwrap();
    let next = super::publish_workspace_checkpoint(client, session, head["revision"].clone()).await;
    resume.send(()).unwrap();
    let error = export
        .await
        .unwrap()
        .expect_err("source advanced during export");
    assert!(
        error
            .to_string()
            .contains("checkpoint revision unavailable"),
        "{error}"
    );
    next
}

pub(super) async fn check_stale(sandbox: &Sandbox, session: &str, old_head: &Value) {
    let output = sandbox.home.join("stale.tar.gz");
    assert!(
        !try_export(sandbox, session, old_head, &output)
            .await
            .status
            .success()
    );
    assert!(!output.exists());
}

pub(super) async fn export(
    sandbox: &Sandbox,
    session: &str,
    head: &Value,
    archive: &std::path::Path,
) {
    let result = try_export(sandbox, session, head, archive).await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

pub(super) async fn check(
    recipient: &Sandbox,
    archive: &std::path::Path,
    session: &str,
    head: &Value,
    nonce: &str,
) {
    use tokio::io::AsyncWriteExt;
    let inspected = recipient.home.join("inspection");
    let run = |file: &std::path::Path| {
        let mut cmd = host::command(recipient).unwrap();
        cmd.args(["checkpoint", "open"])
            .arg(file)
            .arg("--output")
            .arg(&inspected)
            .kill_on_drop(true);
        cmd
    };
    // The gzip trailer is withheld while the reader owns staging. Kill and
    // reap that actual process, then retry using the same destination.
    let bytes = tokio::fs::read(archive).await.unwrap();
    let mut child = run(std::path::Path::new("/dev/stdin"))
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&bytes[..bytes.len() - 8]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let mut paths = tokio::fs::read_dir(&recipient.home).await.unwrap();
            while let Some(item) = paths.next_entry().await.unwrap() {
                if item
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".maka-inspection-")
                    && item.path().join("history.snapshot").is_file()
                {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("import reached private staging");
    child.kill().await.unwrap();
    drop(stdin);
    assert!(!inspected.exists());
    let broken = recipient.home.join("truncated.tar.gz");
    tokio::fs::write(&broken, &bytes[..bytes.len() - 8])
        .await
        .unwrap();
    assert!(!run(&broken).output().await.unwrap().status.success());
    assert!(!inspected.exists());
    let mut first = run(archive);
    let mut second = run(archive);
    let (first, second) = tokio::join!(first.output(), second.output());
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_ne!(
        first.status.success(),
        second.status.success(),
        "exactly one process must publish: {:?}, {:?}",
        first,
        second
    );
    assert!(!run(archive).output().await.unwrap().status.success());
    let mut total = 0;
    let mut dirs = vec![inspected.clone()];
    while let Some(dir) = dirs.pop() {
        let mut entries = tokio::fs::read_dir(dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let info = entry.metadata().await.unwrap();
            if info.is_dir() {
                dirs.push(entry.path());
            } else {
                total += info.len();
            }
        }
    }
    let bounded = recipient.home.join("budgeted-inspection");
    for limit in [total - 1, total] {
        let output = host::command(recipient)
            .unwrap()
            .args(["checkpoint", "open"])
            .arg(archive)
            .arg("--output")
            .arg(&bounded)
            .arg("--max-bytes")
            .arg(limit.to_string())
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.success(),
            limit == total,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(bounded.exists(), limit == total);
    }
    let metadata: Value = serde_json::from_slice(
        &tokio::fs::read(inspected.join("checkpoint.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["manifest"]["session_id"], session);
    assert_eq!(metadata["head"]["revision"], head["revision"]);
    assert_eq!(
        tokio::fs::read_to_string(inspected.join("workspace/effects.log"))
            .await
            .unwrap(),
        format!("{nonce}\n")
    );
    check_attachment(&inspected, session).await;
    let transcript = tokio::fs::read_to_string(inspected.join("history.jsonl"))
        .await
        .unwrap();
    let rows: Vec<Value> = transcript
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        rows.iter()
            .any(|c| c["role"] == "user" && c["text"].as_str().is_some_and(|s| s.contains(nonce))),
        "user history: {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|c| c["role"] == "tool_result"
                && c["text"].as_str().is_some_and(|s| s.contains(nonce))),
        "tool history: {rows:?}"
    );
    assert!(
        !recipient.root.exists(),
        "inspection created an executable Host Root"
    );
}

async fn check_attachment(inspected: &std::path::Path, session: &str) {
    let digest = maka_agent_facts::artifact::content_digest(ATTACHMENT);
    assert_eq!(
        tokio::fs::read(
            inspected
                .join("artifacts")
                .join(digest.strip_prefix("sha256:").unwrap())
        )
        .await
        .unwrap(),
        ATTACHMENT
    );
    let index = tokio::fs::read_to_string(inspected.join("artifacts.jsonl"))
        .await
        .unwrap();
    assert!(
        index
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .any(|row| row["record"]["payload"]["digest"] == digest && row["session"] == session)
    );
}

pub(super) async fn export_fork(
    client: &Client,
    sandbox: &Sandbox,
    session: &str,
    archive: &std::path::Path,
) {
    let observed = call(
        client,
        "agent",
        "observe",
        json!({"sessionId":session}),
        Default::default(),
    )
    .await;
    let forked = call(
        client,
        "agent",
        "fork",
        json!({
            "sessionId":session, "expectedRevision":observed["session"]["revision"],
            "position":{"kind":"end"}, "title":"Portable inherited history", "labels":[]
        }),
        Default::default(),
    )
    .await;
    assert_eq!(forked["kind"], "forked", "{forked}");
    let child = forked["session"]["id"].as_str().unwrap();
    let checkpoint = super::publish_workspace_checkpoint(client, child, Value::Null).await;
    export(sandbox, child, &checkpoint, archive).await;
}

pub(super) async fn check_fork(
    sandbox: &Sandbox,
    archive: &std::path::Path,
    original_session: &str,
) {
    let inspected = sandbox.home.join("fork-inspection");
    let result = host::command(sandbox)
        .unwrap()
        .args(["checkpoint", "open"])
        .arg(archive)
        .arg("--output")
        .arg(&inspected)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    check_attachment(&inspected, original_session).await;
}
