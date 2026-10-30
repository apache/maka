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
use base64::{Engine, engine::general_purpose::STANDARD};

fn path(name: &str) -> Value {
    json!({"bytesBase64":STANDARD.encode(name.as_bytes())})
}

// Keep the actual query's Scope until both Host cleanup and native work settle.
async fn read_file(f: &Fixture, input: Value) -> Result<Vec<Value>, String> {
    let observed = scope(&f.issuer, true);
    let accepted = f
        .app
        .client()
        .subscribe(
            f.binding(2).await,
            "readFile".into(),
            input,
            observed.clone(),
            Attachments::new().into(),
        )
        .await;
    let result = match accepted {
        Ok(mut stream) => {
            let mut parts = Vec::new();
            while let Some(part) = stream.recv().await {
                parts.push(part);
            }
            let completed = stream.completion().await;
            completed.cleanup.and(completed.result).map(|value| {
                assert_eq!(
                    value,
                    Value::Null,
                    "End is an explicit item, never a discarded final value"
                );
                parts
            })
        }
        Err(error) => Err(error),
    };
    observed.resources.finish().await.unwrap();
    assert!(observed.resources.is_idle());
    result
}

fn preview_bytes(parts: &[Value]) -> Vec<u8> {
    let begin = parts.first().unwrap();
    assert_eq!(begin["kind"], "begin");
    let mut bytes = Vec::new();
    for part in &parts[1..parts.len() - 1] {
        assert_eq!(part["kind"], "chunk");
        assert_eq!(part["offset"], bytes.len() as u64);
        let chunk = STANDARD.decode(part["data"].as_str().unwrap()).unwrap();
        assert!(chunk.len() <= 32 * 1024);
        if begin["content"]["kind"] == "text" {
            std::str::from_utf8(&chunk).unwrap();
        }
        bytes.extend(chunk);
    }
    assert_eq!(begin["bytes"], bytes.len() as u64);
    assert_eq!(
        begin["digest"],
        maka_agent_facts::artifact::content_digest(&bytes)
    );
    assert_eq!(
        parts.last().unwrap(),
        &json!({
            "kind":"end", "version":begin["version"], "digest":begin["digest"], "bytes":bytes.len(),
        })
    );
    bytes
}

#[tokio::test]
async fn read_file_keeps_one_capture_across_chunks_and_rejects_replaced_rereads() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Preview capture ownership").await;
        let old = "你".repeat(400_000);
        let new = "好".repeat(400_000);
        let file = f.workspace.join("current.txt");
        std::fs::write(&file, &old).unwrap();
        let observed = scope(&f.issuer, true);
        let mut stream = f.app.client().subscribe(f.binding(2).await, "readFile".into(), json!({"sessionId":session,"path":path("current.txt")}), observed.clone(), Attachments::new().into()).await.unwrap();
        let begin = item(&mut stream).await;
        assert_eq!(begin["kind"], "begin");
        let replace = |content: &str| {
            let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
            let replacement = f.workspace.join("replacement");
            std::fs::write(&replacement, content).unwrap();
            std::fs::File::open(&replacement).unwrap().set_times(std::fs::FileTimes::new().set_modified(modified)).unwrap();
            #[cfg(windows)] std::fs::remove_file(&file).unwrap();
            std::fs::rename(replacement, &file).unwrap();
        };
        replace(&new);
        let mut parts = vec![begin.clone()];
        while let Some(part) = stream.recv().await { parts.push(part); }
        let completed = stream.completion().await;
        assert_eq!(completed.result.unwrap(), Value::Null);
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        assert_eq!(preview_bytes(&parts), old.as_bytes(), "replacement after Begin cannot alter the captured chunks");
        assert_eq!(read_file(&f, json!({"sessionId":session,"path":path("current.txt"),"expectedVersion":begin["version"]})).await.unwrap(), vec![json!({"kind":"changed"})]);
        let fresh = read_file(&f, json!({"sessionId":session,"path":path("current.txt")})).await.unwrap();
        assert_eq!(preview_bytes(&fresh), new.as_bytes());
        replace(&new);
        assert_eq!(read_file(&f, json!({"sessionId":session,"path":path("current.txt"),"expectedVersion":fresh[0]["version"]})).await.unwrap(), vec![json!({"kind":"changed"})], "same bytes and mtime in a replacement file still invalidate the physical-file precondition");
        let observed = scope(&f.issuer, true);
        let mut stream = f.app.client().subscribe(f.binding(2).await, "readFile".into(), json!({"sessionId":session,"path":path("current.txt")}), observed.clone(), Attachments::new().into()).await.unwrap();
        assert_eq!(item(&mut stream).await["kind"], "begin");
        stream.cancel();
        while let Some(part) = stream.recv().await { assert_ne!(part["kind"], "end"); }
        let completed = stream.completion().await;
        assert!(completed.result.is_err());
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        assert_eq!(std::fs::read(&file).unwrap(), new.as_bytes());
        // More than the real subscription queue's 16 byte-quantum batches:
        // stopping after the first item must release the filesystem producer.
        let directory = f.workspace.join("candidate-scan");
        std::fs::create_dir(&directory).unwrap();
        let suffix = "x".repeat(160);
        let first_name = format!("candidate-0000-{suffix}.txt");
        let first_path = format!("candidate-scan/{first_name}");
        let entry_bytes = serde_json::to_vec(&json!({"path":path(&first_path),"kind":"file"})).unwrap().len();
        for index in 0..=old.len() / entry_bytes {
            std::fs::write(directory.join(format!("candidate-{index:04}-{suffix}.txt")), "").unwrap();
        }
        let observed = scope(&f.issuer, true);
        let mut stream = f.app.client().subscribe(f.binding(2).await, "fileCandidates".into(), json!({"sessionId":session,"directory":path("candidate-scan"),"query":""}), observed.clone(), Attachments::new().into()).await.unwrap();
        let first = item(&mut stream).await;
        assert_eq!(first["entries"][0], json!({"path":path(&first_path),"kind":"file"}));
        stream.cancel();
        while stream.recv().await.is_some() {}
        let completed = stream.completion().await;
        assert!(completed.result.is_err());
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        let observed = scope(&f.issuer, true);
        let mut stream = f.app.client().subscribe(f.binding(2).await, "fileCandidates".into(), json!({"sessionId":session,"directory":path("candidate-scan"),"query":"candidate-0000-"}), observed.clone(), Attachments::new().into()).await.unwrap();
        assert_eq!(item(&mut stream).await, json!({"entries":[{"path":path(&first_path),"kind":"file"}]}));
        assert!(stream.recv().await.is_none());
        let completed = stream.completion().await;
        assert_eq!(completed.result.unwrap(), Value::Null);
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn list_files_reads_selected_directories_without_crossing_session_or_symlink_boundaries() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Workspace browsing").await;
        std::fs::write(f.workspace.join("alpha.txt"), "alpha").unwrap();
        std::fs::write(f.workspace.join(".visible"), "ordinary hidden file").unwrap();
        std::fs::create_dir(f.workspace.join("folder")).unwrap();
        std::fs::write(f.workspace.join("folder/inside.txt"), "inside").unwrap();
        std::fs::create_dir(f.workspace.join(".git")).unwrap();
        assert!(
            f.workspace
                .join(maka_fs_tools::workspace::MARKER_FILE)
                .is_file()
        );
        #[cfg(unix)]
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            std::fs::write(
                outside.path().join("outside-secret.txt"),
                "not in this workspace",
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.path(), f.workspace.join("link")).unwrap();
        }
        let request = json!({"sessionId":session,"path":null,"after":null});
        let observed = f.query("listFiles", request.clone()).await;
        // A missing-method RED must settle the actual runtime before failing.
        if observed.is_err() {
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
        let listed = observed.expect("Agent listFiles must browse the selected Session workspace");
        let expected = vec![
            json!({"path":{"bytesBase64":"LnZpc2libGU="},"kind":"file"}),
            json!({"path":{"bytesBase64":"YWxwaGEudHh0"},"kind":"file"}),
            json!({"path":{"bytesBase64":"Zm9sZGVy"},"kind":"directory"}),
        ];
        #[cfg(unix)]
        let expected = {
            let mut entries = expected;
            entries.push(json!({"path":{"bytesBase64":"bGluaw=="},"kind":"symlink"}));
            entries
        };
        assert_eq!(
            listed["entries"],
            json!(expected),
            "hidden user files remain visible; only .git and the workspace marker are excluded"
        );
        assert!(
            listed["directoryIdentity"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert_eq!(listed["next"], Value::Null);
        let folder = f
            .query(
                "listFiles",
                json!({"sessionId":session,"path":path("folder"),"after":null}),
            )
            .await
            .unwrap();
        assert_eq!(
            folder["entries"],
            json!([{"path":{"bytesBase64":"Zm9sZGVyL2luc2lkZS50eHQ="},"kind":"file"}])
        );
        assert_ne!(folder["directoryIdentity"], listed["directoryIdentity"]);
        assert_eq!(folder["next"], Value::Null);
        assert_eq!(
            f.query(
                "listFiles",
                json!({"sessionId":"foreign-session","path":null,"after":null})
            )
            .await
            .unwrap_err(),
            "agent_session_unavailable"
        );
        let denied = f
            .app
            .client()
            .start(
                f.binding(2).await,
                "listFiles".into(),
                request.clone(),
                scope(&f.issuer, false),
                Attachments::new().into(),
            )
            .await;
        assert_eq!(denied.err().unwrap(), "denied");
        assert!(
            f.query(
                "listFiles",
                json!({"sessionId":session,"path":path("../"),"after":null})
            )
            .await
            .is_err(),
            "directory input must not escape the selected workspace"
        );
        #[cfg(unix)]
        assert!(
            f.query(
                "listFiles",
                json!({"sessionId":session,"path":path("link"),"after":null})
            )
            .await
            .is_err(),
            "a visible symlink must not become a directory traversal capability"
        );
        assert_eq!(
            f.query("listFiles", request).await.unwrap(),
            listed,
            "denied observations must leave the selected directory intact"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn watch(
    f: &Fixture,
    session: &str,
    directory: &str,
    scope: Scope,
) -> maka_host_runtime::application::Subscription {
    f.app
        .client()
        .subscribe(
            f.binding(2).await,
            "watchFiles".into(),
            json!({"sessionId":session,"path":path(directory)}),
            scope,
            Attachments::new().into(),
        )
        .await
        .unwrap()
}

#[track_caller]
fn item(
    stream: &mut maka_host_runtime::application::Subscription,
) -> impl std::future::Future<Output = Value> + '_ {
    let caller = std::panic::Location::caller();
    async move {
        tokio::time::timeout(Duration::from_secs(10), stream.recv())
            .await
            .unwrap_or_else(|error| {
                panic!("filesystem observation must make progress at {caller}: {error}")
            })
            .unwrap_or_else(|| panic!("watch must remain available at {caller}"))
    }
}

#[tokio::test]
async fn watch_files_rechecks_session_authority_on_commits_without_filesystem_changes() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let permissions_session = f.create("Permission boundary observation").await;
        let removed_session = f.create("Removed Session observation").await;
        let directory = f.workspace.join("idle");
        std::fs::create_dir(&directory).unwrap();
        let original = b"unchanged by observation revocation";
        std::fs::write(directory.join("preserved.txt"), original).unwrap();

        let observed = scope(&f.issuer, true);
        let mut stream = watch(&f, &permissions_session, "idle", observed.clone()).await;
        assert_eq!(item(&mut stream).await["kind"], "ready");
        let changed = files::change(&f, &permissions_session, "read_only", false, true).await;
        assert_eq!(changed["kind"], "committed");
        while let Some(event) = stream.recv().await {
            assert_eq!(event, json!({"kind":"changed"}));
        }
        let completed = stream.completion().await;
        assert_eq!(completed.result.unwrap_err(), "agent_files_changed");
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        assert_eq!(
            std::fs::read(directory.join("preserved.txt")).unwrap(),
            original
        );

        let observed = scope(&f.issuer, true);
        let mut stream = watch(&f, &removed_session, "idle", observed.clone()).await;
        assert_eq!(item(&mut stream).await["kind"], "ready");
        let current = f
            .query("observe", json!({"sessionId":removed_session}))
            .await
            .unwrap();
        let removed = f
            .mutation(
                2,
                "changeSession",
                json!({
                    "sessionId":removed_session,
                    "expectedRevision":current["session"]["revision"],
                    "action":"remove"
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(removed["kind"], "removed");
        while let Some(event) = stream.recv().await {
            assert_eq!(event, json!({"kind":"changed"}));
        }
        let completed = stream.completion().await;
        assert_eq!(completed.result.unwrap_err(), "agent_session_unavailable");
        completed.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        assert_eq!(
            std::fs::read(directory.join("preserved.txt")).unwrap(),
            original
        );
        let listed = f
            .query(
                "listFiles",
                json!({"sessionId":permissions_session,"path":path("idle"),"after":null}),
            )
            .await
            .unwrap();
        assert_eq!(
            listed["entries"],
            json!([{"path":path("idle/preserved.txt"),"kind":"file"}])
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
