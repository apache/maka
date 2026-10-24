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
async fn settled_list_files(f: &Fixture, input: Value) -> Result<Value, String> {
    let observed = scope(&f.issuer, true);
    let accepted = f
        .app
        .client()
        .start(
            f.binding(2).await,
            "listFiles".into(),
            input,
            observed.clone(),
            Attachments::new().into(),
        )
        .await;
    let result = match accepted {
        Ok(accepted) => {
            let completed = accepted.completion().await;
            completed.cleanup.and(completed.result)
        }
        Err(error) => Err(error),
    };
    let finished = observed.resources.finish().await;
    finished.map_err(|error| format!("listFiles resources: {error:?}"))?;
    if !observed.resources.is_idle() {
        return Err("listFiles resource custody did not settle".into());
    }
    result
}

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
async fn read_file_serves_bounded_current_text_and_images_under_original_session_authority() {
    use image::{ExtendedColorType, ImageEncoder, codecs::png};
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Current workspace previews").await;
        std::fs::write(f.workspace.join("text"), "hello\n你好").unwrap();
        let text = read_file(&f, json!({"sessionId":session,"path":path("text")}))
            .await
            .unwrap();
        assert_eq!(text[0]["content"], json!({"kind":"text"}));
        assert_eq!(preview_bytes(&text), "hello\n你好".as_bytes());
        let mut png = Vec::new();
        png::PngEncoder::new(&mut png)
            .write_image(
                &[255, 0, 0, 255, 0, 255, 0, 255],
                2,
                1,
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        std::fs::write(f.workspace.join("image.data"), &png).unwrap();
        let image = read_file(&f, json!({"sessionId":session,"path":path("image.data")}))
            .await
            .unwrap();
        assert_eq!(
            image[0]["content"],
            json!({"kind":"image","mimeType":"image/png"})
        );
        assert_eq!(
            preview_bytes(&image),
            png,
            "actual bytes, not the filename extension, select images"
        );
        std::fs::write(f.workspace.join("empty"), "").unwrap();
        let empty = read_file(&f, json!({"sessionId":session,"path":path("empty")}))
            .await
            .unwrap();
        assert_eq!(empty.len(), 2);
        assert_eq!(preview_bytes(&empty), b"");
        std::fs::write(f.workspace.join("binary"), b"a\0b").unwrap();
        assert_eq!(
            read_file(&f, json!({"sessionId":session,"path":path("binary")}))
                .await
                .unwrap(),
            vec![json!({"kind":"binary","bytes":3})]
        );
        assert_eq!(
            read_file(&f, json!({"sessionId":session,"path":path("absent/child")}))
                .await
                .unwrap(),
            vec![json!({"kind":"absent"})]
        );
        std::fs::create_dir(f.workspace.join("folder")).unwrap();
        assert_eq!(
            read_file(&f, json!({"sessionId":session,"path":path("folder")}))
                .await
                .unwrap(),
            vec![json!({"kind":"unsupported","fileKind":"directory"})]
        );
        std::fs::write(
            f.workspace.join("long-text"),
            vec![b'a'; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        let long = read_file(&f, json!({"sessionId":session,"path":path("long-text")}))
            .await
            .unwrap();
        assert_eq!(preview_bytes(&long), vec![b'a'; 2 * 1024 * 1024 + 1]);
        std::fs::File::create(f.workspace.join("oversize"))
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            read_file(&f, json!({"sessionId":session,"path":path("oversize")}))
                .await
                .unwrap(),
            vec![json!({"kind":"binary","bytes":16777217})]
        );
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), "outside").unwrap();
            std::os::unix::fs::symlink(outside.path().join("secret"), f.workspace.join("link"))
                .unwrap();
            assert_eq!(
                read_file(&f, json!({"sessionId":session,"path":path("link")}))
                    .await
                    .unwrap(),
                vec![json!({"kind":"unsupported","fileKind":"symlink"})]
            );
            #[cfg(not(target_os = "macos"))]
            let raw = b"raw-\xff".as_slice();
            #[cfg(target_os = "macos")]
            let raw = b"raw-\\name".as_slice();
            std::fs::write(
                f.workspace.join(std::ffi::OsString::from_vec(raw.to_vec())),
                "exact bytes",
            )
            .unwrap();
            let raw = read_file(
                &f,
                json!({"sessionId":session,"path":{"bytesBase64":STANDARD.encode(raw)}}),
            )
            .await
            .unwrap();
            assert_eq!(preview_bytes(&raw), b"exact bytes");
        }
        assert!(
            read_file(&f, json!({"sessionId":session,"path":path("../text")}))
                .await
                .is_err()
        );
        assert_eq!(
            read_file(
                &f,
                json!({"sessionId":session,"path":path(maka_fs_tools::workspace::MARKER_FILE)})
            )
            .await
            .unwrap_err(),
            "agent_files_private"
        );
        f.store
            .create_session("foreign_session", "foreign", &json!({"foreign":true}), 1)
            .await
            .unwrap();
        assert_eq!(
            read_file(
                &f,
                json!({"sessionId":"foreign_session","path":path("text")})
            )
            .await
            .unwrap_err(),
            "agent_session_unavailable"
        );
        let denied = f
            .app
            .client()
            .subscribe(
                f.binding(2).await,
                "readFile".into(),
                json!({"sessionId":session,"path":path("text")}),
                scope(&f.issuer, false),
                Attachments::new().into(),
            )
            .await;
        assert_eq!(denied.err().unwrap(), "denied");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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

#[tokio::test]
async fn list_files_pages_live_byte_paths_and_rejects_replaced_directory_cursor() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Paged files").await;
        let directory = f.workspace.join("many");
        std::fs::create_dir(&directory).unwrap();
        for index in 0..130 {
            std::fs::write(directory.join(format!("file-{index:03}")), "entry").unwrap();
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStringExt;
            std::fs::write(
                directory.join(std::ffi::OsString::from_vec(b"z\xff.txt".to_vec())),
                "bytes",
            )
            .unwrap();
        }
        let first = f
            .query(
                "listFiles",
                json!({"sessionId":session,"path":path("many"),"after":null}),
            )
            .await
            .unwrap();
        let expected: Vec<_> = (0..128)
            .map(|index| json!({"path":path(&format!("many/file-{index:03}")),"kind":"file"}))
            .collect();
        assert_eq!(first["entries"], json!(expected));
        assert_eq!(
            first["next"],
            json!({"directoryIdentity":first["directoryIdentity"],"after":path("many/file-127")})
        );
        // Continuation observes current names after the key, not a frozen snapshot.
        std::fs::remove_file(directory.join("file-128")).unwrap();
        std::fs::write(directory.join("file-130"), "new entry").unwrap();
        let second = f
            .query(
                "listFiles",
                json!({"sessionId":session,"path":path("many"),"after":first["next"]}),
            )
            .await
            .unwrap();
        let expected = vec![
            json!({"path":path("many/file-129"),"kind":"file"}),
            json!({"path":path("many/file-130"),"kind":"file"}),
        ];
        #[cfg(target_os = "linux")]
        let expected = {
            let mut expected = expected;
            expected.push(json!({"path":{"bytesBase64":"bWFueS96/y50eHQ="},"kind":"file"}));
            expected
        };
        assert_eq!(second["entries"], json!(expected));
        assert_eq!(second["next"], Value::Null);
        assert_eq!(second["directoryIdentity"], first["directoryIdentity"]);
        std::fs::rename(&directory, f.workspace.join("old-many")).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("replacement"), "replacement").unwrap();
        assert!(
            f.query(
                "listFiles",
                json!({"sessionId":session,"path":path("many"),"after":first["next"]})
            )
            .await
            .is_err()
        );
        let fresh = f
            .query(
                "listFiles",
                json!({"sessionId":session,"path":path("many"),"after":null}),
            )
            .await
            .unwrap();
        assert_ne!(fresh["directoryIdentity"], first["directoryIdentity"]);
        assert_eq!(
            fresh["entries"],
            json!([{"path":path("many/replacement"),"kind":"file"}])
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
async fn watch_files_invalidates_reconnects_and_settles_without_retaining_observers() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Watched files").await;
        let selected = "parent/d01/d02/d03/d04/d05/d06/d07/d08/d09/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20/d21/d22/d23/d24/d25/d26/d27/d28/d29/d30/d31/d32/d33/d34/d35/d36/d37/d38/d39/d40/d41/d42/d43/d44/d45/d46/d47/d48/d49/d50/d51/d52/d53/d54/d55/d56/d57/d58/d59/d60/d61/d62/d63/target";
        let directory = f.workspace.join(selected);
        std::fs::create_dir_all(&directory).unwrap();
        // Probe both public methods and settle their resources before asserting
        // failures, so a refused observation cannot strand its owners.
        let parent = selected.rsplit_once('/').unwrap().0;
        let parent_page = settled_list_files(&f, json!({"sessionId":session,"path":path(parent),"after":null})).await;
        let listed = settled_list_files(&f, json!({"sessionId":session,"path":path(selected),"after":null})).await;
        let observed = scope(&f.issuer, true);
        let subscription = f.app.client().subscribe(
            f.binding(2).await,
            "watchFiles".into(),
            json!({"sessionId":session,"path":path(selected)}),
            observed.clone(),
            Attachments::new().into(),
        ).await;
        let watch_probe: Result<Value, String> = match subscription {
            Ok(mut stream) => {
                let first = tokio::time::timeout(Duration::from_secs(10), stream.recv()).await;
                stream.cancel();
                let completed = stream.completion().await;
                match completed.cleanup {
                    Err(error) => Err(format!("watch cleanup failed: {error:?}")),
                    Ok(()) => match first {
                        Err(error) => Err(format!("watch first item timed out: {error}")),
                        Ok(None) => Err(format!("watch ended before Ready: {:?}", completed.result)),
                        Ok(Some(value)) => Ok(value),
                    },
                }
            }
            Err(error) => Err(error),
        };
        let finished = observed.resources.finish().await;
        let idle = observed.resources.is_idle();
        f.drained().await;
        if parent_page.is_err() || listed.is_err() || !watch_probe.as_ref().is_ok_and(|event| event["kind"] == "ready") || finished.is_err() || !idle {
            let app_shutdown = f.app.shutdown().await;
            let config_shutdown = f.config.shutdown().await;
            assert!(app_shutdown.is_ok(), "app shutdown: {app_shutdown:?}");
            assert!(config_shutdown.is_ok(), "config shutdown: {config_shutdown:?}");
            assert!(finished.is_ok(), "watch resource finish: {finished:?}");
            assert!(idle, "watch resource custody must settle");
            assert!(listed.is_ok() && watch_probe.is_ok(), "65-component public observations must succeed: listFiles={listed:?}; watchFiles={watch_probe:?}; parent={parent_page:?}");
            panic!("65-component preflight failed: parent={parent_page:?}; watchFiles={watch_probe:?}");
        }
        let parent_page = parent_page.unwrap();
        assert_eq!(parent_page["entries"], json!([{"path":path(selected),"kind":"directory"}]));
        assert_eq!(parent_page["next"], Value::Null);
        let listed = listed.unwrap();
        assert_eq!(listed["entries"], json!([]));
        assert_eq!(listed["next"], Value::Null);
        assert_eq!(watch_probe.unwrap(), json!({"kind":"ready","directoryIdentity":listed["directoryIdentity"]}));
        let request = json!({"sessionId":session,"path":path(selected)});
        let denied = f
            .app
            .client()
            .subscribe(
                f.binding(2).await,
                "watchFiles".into(),
                request,
                scope(&f.issuer, false),
                Attachments::new().into(),
            )
            .await;
        assert_eq!(denied.err().unwrap(), "denied");
        let mut foreign = watch(
            &f,
            "foreign-session",
            selected,
            scope(&f.issuer, true),
        )
        .await;
        assert_eq!(foreign.recv().await, None);
        let completed = foreign.completion().await;
        assert_eq!(completed.result.unwrap_err(), "agent_session_unavailable");
        completed.cleanup.unwrap();

        // A fresh Ready before each mutation separates observations without assuming
        // one native callback per mutation or draining by a quiet-time heuristic.
        for operation in 0..4 {
            let observed = scope(&f.issuer, true);
            let mut stream = watch(&f, &session, selected, observed.clone()).await;
            let ready = item(&mut stream).await;
            assert_eq!(ready["kind"], "ready");
            let before = f
                .query(
                    "listFiles",
                    json!({"sessionId":session,"path":path(selected),"after":null}),
                )
                .await
                .unwrap();
            assert_eq!(before["directoryIdentity"], ready["directoryIdentity"]);
            match operation {
                0 => std::fs::write(directory.join("created"), "first").unwrap(),
                1 => std::fs::write(directory.join("created"), "updated").unwrap(),
                2 => std::fs::rename(directory.join("created"), directory.join("renamed")).unwrap(),
                3 => std::fs::remove_file(directory.join("renamed")).unwrap(),
                _ => unreachable!(),
            }
            assert_eq!(item(&mut stream).await, json!({"kind":"changed"}));
            let current = f
                .query(
                    "listFiles",
                    json!({"sessionId":session,"path":path(selected),"after":null}),
                )
                .await
                .unwrap();
            let expected = match operation {
                0 | 1 => json!([{"path":path("parent/d01/d02/d03/d04/d05/d06/d07/d08/d09/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20/d21/d22/d23/d24/d25/d26/d27/d28/d29/d30/d31/d32/d33/d34/d35/d36/d37/d38/d39/d40/d41/d42/d43/d44/d45/d46/d47/d48/d49/d50/d51/d52/d53/d54/d55/d56/d57/d58/d59/d60/d61/d62/d63/target/created"),"kind":"file"}]),
                2 => json!([{"path":path("parent/d01/d02/d03/d04/d05/d06/d07/d08/d09/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20/d21/d22/d23/d24/d25/d26/d27/d28/d29/d30/d31/d32/d33/d34/d35/d36/d37/d38/d39/d40/d41/d42/d43/d44/d45/d46/d47/d48/d49/d50/d51/d52/d53/d54/d55/d56/d57/d58/d59/d60/d61/d62/d63/target/renamed"),"kind":"file"}]),
                3 => json!([]),
                _ => unreachable!(),
            };
            assert_eq!(current["entries"], expected);
            stream.cancel();
            stream.completion().await.cleanup.unwrap();
            observed.resources.finish().await.unwrap();
            assert!(observed.resources.is_idle());
        }
        // Moving a selected ancestor must terminate, rather than follow a new
        // directory installed at the same workspace-relative path.
        let observed = scope(&f.issuer, true);
        let mut stream = watch(&f, &session, selected, observed.clone()).await;
        let ready = item(&mut stream).await;
        std::fs::rename(f.workspace.join("parent"), f.workspace.join("moved-parent")).unwrap();
        loop {
            let event = item(&mut stream).await;
            if event["kind"] == "changed" {
                continue;
            }
            assert_eq!(
                event,
                json!({"kind":"unavailable","reason":"directory_changed"})
            );
            break;
        }
        assert_eq!(stream.recv().await, None);
        stream.completion().await.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("fresh"), "new identity").unwrap();
        let observed = scope(&f.issuer, true);
        let mut stream = watch(&f, &session, selected, observed.clone()).await;
        let fresh = item(&mut stream).await;
        assert_eq!(fresh["kind"], "ready");
        assert_ne!(fresh["directoryIdentity"], ready["directoryIdentity"]);
        let current = f
            .query(
                "listFiles",
                json!({"sessionId":session,"path":path(selected),"after":null}),
            )
            .await
            .unwrap();
        assert_eq!(current["directoryIdentity"], fresh["directoryIdentity"]);
        assert_eq!(
            current["entries"],
            json!([{"path":path("parent/d01/d02/d03/d04/d05/d06/d07/d08/d09/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20/d21/d22/d23/d24/d25/d26/d27/d28/d29/d30/d31/d32/d33/d34/d35/d36/d37/d38/d39/d40/d41/d42/d43/d44/d45/d46/d47/d48/d49/d50/d51/d52/d53/d54/d55/d56/d57/d58/d59/d60/d61/d62/d63/target/fresh"),"kind":"file"}])
        );
        // Closing an observer leaves the Session and Owner available.
        stream.cancel();
        stream.completion().await.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        assert_eq!(
            f.query(
                "listFiles",
                json!({"sessionId":session,"path":path(selected),"after":null})
            )
            .await
            .unwrap(),
            current
        );
        let observed = scope(&f.issuer, true);
        let mut stream = watch(&f, &session, selected, observed.clone()).await;
        assert_eq!(item(&mut stream).await["kind"], "ready");
        f.app.shutdown().await.unwrap();
        stream.completion().await.cleanup.unwrap();
        observed.resources.finish().await.unwrap();
        assert!(observed.resources.is_idle());
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn list_and_watch_files_keep_owned_root_and_control_private_under_published_ancestor() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::configured("http://127.0.0.1:1/v1",None,None,None,|configuration| {
            let ancestor = configuration.workspace_roots[0].path.parent().unwrap().to_path_buf();
            configuration.workspace_roots.push(maka_host_runtime::DirectoryRootSpec {label:"Published ancestor".into(),path:ancestor});
            configuration.permissions.access = WorkspaceAccess::DangerFullAccess;
        }).await;
        let roots = f.query("directories",json!({"kind":"roots"})).await.unwrap();
        let ancestor = roots["roots"].as_array().unwrap().iter().find(|root| root["name"] == "Published ancestor").unwrap();
        let session = f.mutation(2,"create",json!({"title":"Ancestor workspace","labels":[],"workspace":{"kind":"directory","selection":ancestor["selection"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
        let owner = f.store.owned_root().unwrap();
        let ancestor_path = std::fs::canonicalize(f.workspace.parent().unwrap()).unwrap();
        let business = owner.canonical_path().strip_prefix(&ancestor_path).unwrap().to_str().unwrap();
        let control_path = std::fs::canonicalize(owner.control_directory()).unwrap();
        let control = control_path.strip_prefix(&ancestor_path).unwrap().to_str().unwrap();
        std::fs::write(f.workspace.join("public.txt"),"public").unwrap();
        let listed = f.query("listFiles",json!({"sessionId":session,"path":null,"after":null})).await.unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert!(!entries.iter().any(|entry| entry["path"] == path(business)));
        assert!(entries.iter().any(|entry| entry["path"] == path("workspace") && entry["kind"] == "directory"));
        let public = f.query("listFiles",json!({"sessionId":session,"path":path("workspace"),"after":null})).await.unwrap();
        assert_eq!(public["entries"],json!([{"path":path("workspace/public.txt"),"kind":"file"}]));
        let control_parent = std::path::Path::new(control).parent().unwrap().to_str().unwrap();
        let listed_control = f.query("listFiles",json!({"sessionId":session,"path":path(control_parent),"after":null})).await.unwrap();
        assert!(!listed_control["entries"].as_array().unwrap().iter().any(|entry| entry["path"] == path(control)));
        for protected in [business,control] {
            assert_eq!(read_file(&f,json!({"sessionId":session,"path":path(&format!("{protected}/content"))})).await.unwrap_err(), "agent_files_private");
            assert!(f.query("listFiles",json!({"sessionId":session,"path":path(protected),"after":null})).await.is_err());
            let observed = scope(&f.issuer,true);
            let mut stream = watch(&f,&session,protected,observed.clone()).await;
            assert_eq!(stream.recv().await,None,"a private directory must never emit Ready");
            let completed = stream.completion().await;
            assert!(completed.result.is_err());
            completed.cleanup.unwrap();
            observed.resources.finish().await.unwrap();
        }
        drop(owner);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
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

#[tokio::test]
async fn list_files_keeps_returned_cursor_live_after_directory_grows_past_100000_entries() {
    let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Large live file cursor").await;
    let directory = f.workspace.join("many");
    // Keep the two remaining files' original bytes, independent of listing.
    let original_99999 = b"original suffix 099999\0\xff";
    let original_100000 = b"original suffix 100000\0\xfe";
    let observed: Result<_, String> = async {
        std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
        for index in 99_871..=100_000 {
            let bytes: &[u8] = match index {
                99_999 => original_99999,
                100_000 => original_100000,
                _ => b"",
            };
            std::fs::write(directory.join(format!("file-{index:06}")), bytes)
                .map_err(|error| error.to_string())?;
        }
        let first = settled_list_files(
            &f,
            json!({"sessionId":session,"path":path("many"),"after":null}),
        )
        .await?;
        // Every new key sorts before the unmodified, genuinely returned cursor.
        // No native watcher is open during these 99,871 metadata creations.
        for index in 0..=99_870 {
            std::fs::File::create_new(directory.join(format!("file-{index:06}")))
                .map_err(|error| error.to_string())?;
        }
        let second = settled_list_files(
            &f,
            json!({"sessionId":session,"path":path("many"),"after":first["next"]}),
        )
        .await;
        let count = std::fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .try_fold(0_usize, |count, entry| entry.map(|_| count + 1))
            .map_err(|error| error.to_string())?;
        let preserved_99999 =
            std::fs::read(directory.join("file-099999")).map_err(|error| error.to_string())?;
        let preserved_100000 =
            std::fs::read(directory.join("file-100000")).map_err(|error| error.to_string())?;
        Ok((first, second, count, preserved_99999, preserved_100000))
    }
    .await;
    // Settle the original Host before asserting either query result.
    f.drained().await;
    let app_shutdown = f.app.shutdown().await;
    let config_shutdown = f.config.shutdown().await;
    assert!(app_shutdown.is_ok(), "app shutdown: {app_shutdown:?}");
    assert!(
        config_shutdown.is_ok(),
        "config shutdown: {config_shutdown:?}"
    );
    let (first, second, count, preserved_99999, preserved_100000) = observed.unwrap();
    let expected: Vec<_> = (99_871..=99_998)
        .map(|index| json!({"path":path(&format!("many/file-{index:06}")),"kind":"file"}))
        .collect();
    assert_eq!(first["entries"], json!(expected));
    assert_eq!(
        first["next"],
        json!({"directoryIdentity":first["directoryIdentity"],"after":path("many/file-099998")})
    );
    assert_eq!(count, 100_001);
    assert_eq!(preserved_99999, original_99999);
    assert_eq!(preserved_100000, original_100000);
    let second = second.expect(
        "listFiles must apply its returned live cursor in a directory with 100001 real entries",
    );
    assert_eq!(
        second["entries"],
        json!([
            {"path":path("many/file-099999"),"kind":"file"},
            {"path":path("many/file-100000"),"kind":"file"}
        ])
    );
    assert_eq!(second["directoryIdentity"], first["directoryIdentity"]);
    assert_eq!(second["next"], Value::Null);
}
