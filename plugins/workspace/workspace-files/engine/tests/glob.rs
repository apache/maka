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

use maka_agent_facts::tools::ToolExecutor;
use maka_fs_tools::{ReadExecutor, ReadScope};
use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::{fs, path::Path};
use tokio_util::sync::CancellationToken;

fn reader(root: &Path) -> ReadExecutor {
    ReadExecutor::new(
        root,
        ReadScope::Restricted {
            roots: vec![root.to_owned()],
        },
    )
    .unwrap()
}

#[tokio::test]
async fn glob_pages_match_in_order_with_count_and_byte_limits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = reader(&root);
    for (cwd, suffix) in [("short", String::new()), ("long", "x".repeat(160))] {
        fs::create_dir(root.join(cwd)).unwrap();
        let expected: Vec<_> = (0..270)
            .map(|index| format!("file-{index:03}{suffix}.txt"))
            .collect();
        for path in expected.iter().rev() {
            fs::write(root.join(cwd).join(path), "").unwrap();
        }
        let mut input = json!({"pattern":"*.txt","cwd":cwd});
        let mut collected = Vec::new();
        let mut complete = false;
        for page_index in 0..10 {
            let page = executor
                .glob(input.clone(), CancellationToken::new())
                .await
                .unwrap();
            let files = page["files"].as_array().unwrap();
            assert!(!files.is_empty() && files.len() <= 128);
            assert!(serde_json::to_vec(&page).unwrap().len() <= 16 * 1024);
            if page_index == 0 {
                if cwd == "short" {
                    assert_eq!(files.len(), 128);
                } else {
                    assert!(files.len() < 128);
                }
                assert_eq!(page["complete"], false);
            }
            collected.extend(files.iter().map(|file| file.as_str().unwrap().to_owned()));
            if page["complete"] == true {
                assert!(page.get("next_after").is_none());
                complete = true;
                break;
            }
            assert_eq!(page.get("next_after"), files.last());
            input["after"] = page["next_after"].clone();
        }
        assert!(complete);
        assert_eq!(collected, expected);
    }
}

#[tokio::test]
#[cfg(unix)]
async fn glob_keeps_captured_authority_and_cannot_walk_external_aliases_or_hide_failures() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    fs::create_dir(base.join("outside")).unwrap();
    fs::write(base.join("outside/secret.txt"), "").unwrap();
    fs::write(root.join("inside.txt"), "").unwrap();
    symlink(base.join("outside"), root.join("escape")).unwrap();
    let executor = reader(&root);
    fs::rename(&root, base.join("captured")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("replacement.txt"), "").unwrap();
    assert_eq!(
        executor
            .invoke(
                "Glob".into(),
                json!({"pattern":"**/*.txt"}),
                CancellationToken::new()
            )
            .await
            .unwrap(),
        json!({"files":["inside.txt"],"complete":true})
    );
    for input in [
        json!({"pattern":"**","cwd":"escape"}),
        json!({"pattern":"*","cwd":base.join("outside")}),
        json!({"pattern":"../*"}),
        json!({"pattern":"*","cwd":null}),
        json!({"pattern":"*","cwd":"inside.txt"}),
        json!({"pattern":"[bad"}),
        json!({"pattern":"{a,b}"}),
        json!({"pattern":"!(a)"}),
    ] {
        assert!(
            executor
                .invoke("Glob".into(), input, CancellationToken::new())
                .await
                .is_err()
        );
    }
    let token = CancellationToken::new();
    token.cancel();
    assert!(
        executor
            .invoke("Glob".into(), json!({"pattern":"*"}), token)
            .await
            .is_err()
    );
    let missing = executor
        .invoke(
            "Glob".into(),
            json!({"pattern":"no-such-name"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(missing, json!({"files":[],"complete":true}));
}
