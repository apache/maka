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
use maka_fs_tools::{MutationExecutor, ReadExecutor, ReadScope, WriteCoordinator, WriteScope};
use maka_sandbox::filesystem::{Access, Policy, Rule};
use serde_json::json;
use std::{fs, sync::Arc};

#[tokio::test]
async fn read_and_mutations_share_nested_policy_including_missing_targets_and_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    for dir in ["src", "metadata", "private"] {
        fs::create_dir(root.join(dir)).unwrap();
    }
    for (file, content) in [
        ("src/code", "needle public"),
        ("metadata/config", "needle metadata"),
        ("private/token", "needle secret"),
        ("src/key.secret", "needle secret"),
    ] {
        fs::write(root.join(file), content).unwrap();
    }
    fs::hard_link(root.join("private/token"), root.join("src/linked")).unwrap();
    let policy = Arc::new(
        Policy {
            default: Access::Deny,
            rules: vec![
                Rule::subtree(&root, Access::Write),
                Rule::subtree(root.join("metadata"), Access::Read),
                Rule::subtree(root.join("future-metadata"), Access::Read),
                Rule::subtree(root.join("private"), Access::Deny),
            ],
            deny_globs: vec![format!("{}/*.secret", root.join("src").display())],
        }
        .compile()
        .unwrap(),
    );
    let read = ReadExecutor::new(&root, ReadScope::Policy(policy.clone())).unwrap();
    let write = MutationExecutor::new(
        &root,
        WriteScope::Policy(policy),
        Arc::new(WriteCoordinator::default()),
    )
    .unwrap();
    let source = read
        .invoke(
            "Read".into(),
            json!({"path":"src/code"}),
            Default::default(),
        )
        .await
        .unwrap();
    assert!(source.to_string().contains("needle public"));
    for path in ["private/token", "src/key.secret"] {
        assert!(
            read.invoke("Read".into(), json!({"path":path}), Default::default())
                .await
                .is_err()
        );
    }
    for path in [
        "metadata/config",
        "metadata/new",
        "future-metadata",
        "private/token",
        "src/key.secret",
        "src/linked",
    ] {
        assert!(
            write
                .invoke(
                    "Write".into(),
                    json!({"path":path,"content":"changed"}),
                    Default::default()
                )
                .await
                .is_err(),
            "{path}"
        );
    }
    assert!(!root.join("future-metadata").exists());
    assert_eq!(
        fs::read_to_string(root.join("private/token")).unwrap(),
        "needle secret"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("../private", root.join("src/alias")).unwrap();
        std::os::unix::fs::symlink("src/code", root.join("allowed-alias")).unwrap();
        assert!(
            read.invoke(
                "Read".into(),
                json!({"path":"src/alias/token"}),
                Default::default()
            )
            .await
            .is_err()
        );
        assert!(
            read.invoke(
                "Read".into(),
                json!({"path":"allowed-alias"}),
                Default::default()
            )
            .await
            .is_ok()
        );
    }
    write
        .invoke(
            "Write".into(),
            json!({"path":"src/new","content":"normal"}),
            Default::default(),
        )
        .await
        .unwrap();
    let denied = write
        .invoke(
            "apply_patch".into(),
            json!({"callId":"delete", "operation":{"type":"delete_file","path":"metadata/config"}}),
            Default::default(),
        )
        .await
        .unwrap_err();
    assert!(
        denied.to_string().contains("filesystem policy denies"),
        "{denied}"
    );
    assert_eq!(
        fs::read_to_string(root.join("metadata/config")).unwrap(),
        "needle metadata"
    );
    assert_eq!(fs::read_to_string(root.join("src/new")).unwrap(), "normal");
}
