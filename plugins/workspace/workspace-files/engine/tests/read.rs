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

use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_fs_tools::{ReadExecutor, ReadScope};
use serde_json::{Value, json};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use tokio_util::sync::CancellationToken;

fn scoped(root: &std::path::Path) -> ReadExecutor {
    ReadExecutor::new(
        root,
        ReadScope::Restricted {
            roots: vec![root.to_owned()],
        },
    )
    .unwrap()
}

async fn read(executor: &ReadExecutor, input: Value) -> Result<Value, ToolError> {
    executor
        .invoke("Read".into(), input, CancellationToken::new())
        .await
}

#[tokio::test]
async fn file_pages_bind_the_full_source_and_preserve_limits_and_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(root.join("text"), "零\r\n一\n二\n").unwrap();
    fs::write(root.join("binary"), [0xff, 0xfe]).unwrap();
    fs::write(root.join("nul"), b"a\0b").unwrap();
    let executor = scoped(&root);
    for (input, content, offset, returned) in [
        (json!({"path":"text"}), "零\r\n一\n二\n", 0, 4),
        (json!({"path":"text","offset":1,"limit":2}), "一\n二", 1, 2),
        (json!({"path":"text","offset":99}), "", 99, 0),
        (json!({"path":"text","offset":0,"limit":1}), "零\r", 0, 1),
    ] {
        assert_eq!(
            read(&executor, input).await.unwrap(),
            json!({"content":content,"offset":offset,"returnedLines":returned,"totalLines":4,"next":null})
        );
    }
    for input in [
        json!({"path":"runtime-resource://text"}),
        json!({"path":"binary"}),
        json!({"path":"nul"}),
    ] {
        assert!(read(&executor, input).await.is_err());
    }
    let token = CancellationToken::new();
    token.cancel();
    assert!(
        executor
            .invoke("Read".into(), json!({"path":"text"}), token)
            .await
            .is_err()
    );
    assert!(
        executor
            .invoke(
                "Write".into(),
                json!({"path":"text"}),
                CancellationToken::new()
            )
            .await
            .is_err()
    );

    let executor = scoped(&root);
    let line = "中文😀\\\"".repeat(3_000);
    let source = format!("before\n{line}\nafter");
    fs::write(root.join("pages"), &source).unwrap();
    let first = read(&executor, json!({"path":"pages","offset":1,"limit":1}))
        .await
        .unwrap();
    let continuation = first["next"].clone();
    let mut page = first;
    let mut reconstructed = String::new();
    let mut pages = 0;
    loop {
        assert!(page.to_string().encode_utf16().count() <= maka_agent_facts::read::MAX_PAGE_CHARS);
        assert_eq!(page["offset"], 1);
        assert_eq!(page["totalLines"], 3);
        assert_eq!(page["partialLine"], true);
        reconstructed.push_str(page["content"].as_str().unwrap());
        pages += 1;
        assert!(pages < 100);
        if page["next"].is_null() {
            break;
        }
        assert_eq!(page["returnedLines"], 0);
        page = read(&executor, page["next"].clone()).await.unwrap();
    }
    assert_eq!(page["returnedLines"], 1);
    assert!(pages > 1);
    assert_eq!(reconstructed, line);
    // A change outside the selected range must still invalidate its cursor.
    fs::write(root.join("pages"), source.replace("after", "changed")).unwrap();
    assert!(
        read(&executor, continuation)
            .await
            .unwrap_err()
            .to_string()
            .contains("content changed")
    );
}

#[tokio::test]
async fn text_reads_validate_the_tail_and_carry_utf8_across_actual_io_cuts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = scoped(&root);
    for fill in [8180, 8181, 8182] {
        let text = format!("\u{feff}first\n{}😀\nlast", "x".repeat(fill));
        fs::write(root.join("carry"), &text).unwrap();
        assert_eq!(
            read(&executor, json!({"path":"carry","offset":0,"limit":1}))
                .await
                .unwrap(),
            json!({"content":"\u{feff}first","offset":0,"returnedLines":1,"totalLines":3,"next":null})
        );
        assert_eq!(
            read(&executor, json!({"path":"carry","offset":2,"limit":1}))
                .await
                .unwrap(),
            json!({"content":"last","offset":2,"returnedLines":1,"totalLines":3,"next":null})
        );
    }
    for tail in [&[0xff][..], &[0xe2, 0x82][..], &[0][..]] {
        let mut bytes = b"first\n".to_vec();
        bytes.resize(1_048_600, b'x');
        bytes.extend_from_slice(tail);
        fs::write(root.join("bad-tail"), bytes).unwrap();
        let error = read(&executor, json!({"path":"bad-tail","offset":0,"limit":1}))
            .await
            .unwrap_err();
        assert!(
            matches!(error, ToolError::Failed(message) if message == if tail == [0] {
            "Read does not support binary files"
        } else { "Read requires UTF-8 text" })
        );
    }
}

#[tokio::test]
#[cfg(unix)]
async fn captured_directory_survives_replacement_and_denies_escape_and_special_files() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("workspace");
    let outside = base.join("outside");
    let beyond = tempfile::tempdir().unwrap();
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("text"), "admitted").unwrap();
    fs::write(outside.join("text"), "secret").unwrap();
    fs::write(root.join("pages"), "x".repeat(20_000)).unwrap();
    fs::write(outside.join("pages"), "y".repeat(20_000)).unwrap();
    symlink(outside.join("text"), outside.join("absolute-link")).unwrap();
    symlink("../outside/text", root.join("escape")).unwrap();
    symlink("text", root.join("inside")).unwrap();
    fs::write(beyond.path().join("secret"), "not admitted").unwrap();
    symlink(beyond.path().join("secret"), root.join("beyond")).unwrap();
    let overlapping = ReadExecutor::new(
        &root,
        ReadScope::Restricted {
            roots: vec![root.clone(), base.clone()],
        },
    )
    .unwrap();
    let outside_cursor = read(&overlapping, json!({"path":"../outside/pages"}))
        .await
        .unwrap()["next"]
        .clone();
    for path in ["../outside/text", "escape"] {
        assert_eq!(
            read(&overlapping, json!({"path":path})).await.unwrap(),
            json!({"content":"secret","offset":0,"returnedLines":1,"totalLines":1,"next":null})
        );
    }
    assert!(read(&overlapping, json!({"path":"beyond"})).await.is_err());
    assert!(
        read(&overlapping, json!({"path":beyond.path().join("secret")}))
            .await
            .is_err()
    );
    let alias = base.join("workspace-alias");
    symlink(&root, &alias).unwrap();
    let executor = ReadExecutor::new(
        &alias,
        ReadScope::Restricted {
            roots: vec![root.clone(), alias.clone()],
        },
    )
    .unwrap();
    assert!(read(&executor, outside_cursor).await.is_err());
    let inside_cursor = read(&executor, json!({"path":"pages"})).await.unwrap()["next"].clone();
    for prefix in [&root, &alias] {
        assert_eq!(
            read(&executor, json!({"path":prefix.join("text")}))
                .await
                .unwrap(),
            json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
        );
    }
    assert_eq!(
        read(&executor, json!({"path":"inside"})).await.unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    for path in [
        outside.join("text"),
        root.join("escape"),
        root.join("../outside/text"),
    ] {
        assert!(matches!(
            read(&executor, json!({"path":path})).await,
            Err(ToolError::Failed(_) | ToolError::Io { .. })
        ));
    }
    fs::rename(&root, base.join("captured")).unwrap();
    symlink(&outside, &root).unwrap();
    let continued = read(&executor, inside_cursor).await.unwrap();
    assert!(!continued["content"].as_str().unwrap().is_empty());
    assert!(
        continued["content"]
            .as_str()
            .unwrap()
            .bytes()
            .all(|byte| byte == b'x')
    );
    assert_eq!(
        read(&executor, json!({"path":alias.join("text")}))
            .await
            .unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    // The same textual root now names attacker content, but its admitted handle
    // still resolves the original directory. No timing-dependent race is needed.
    assert_eq!(
        read(&executor, json!({"path":"text"})).await.unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    assert_eq!(
        read(&executor, json!({"path":root.join("text")}))
            .await
            .unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    assert!(read(&executor, json!({"path":"."})).await.is_err());
    let fifo = base.join("captured/fifo");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        read(&executor, json!({"path":"fifo"})),
    )
    .await
    .expect("opening a FIFO must not wait for a writer")
    .unwrap_err();
    let bypass = ReadExecutor::new(&outside, ReadScope::Unrestricted).unwrap();
    assert_eq!(
        read(&bypass, json!({"path":outside.join("text")}))
            .await
            .unwrap(),
        json!({"content":"secret","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    assert_eq!(
        read(&bypass, json!({"path":"absolute-link"}))
            .await
            .unwrap(),
        json!({"content":"secret","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
}
