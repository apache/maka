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
