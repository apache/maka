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

use cap_fs_ext::MetadataExt;
use cap_std::fs::File;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_fs_tools::{MutationExecutor, WriteCoordinator, WriteScope};
use serde_json::{Value, json};
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

fn executor(root: &std::path::Path) -> MutationExecutor {
    MutationExecutor::new(
        root,
        WriteScope::Restricted {
            roots: vec![root.into()],
        },
        Arc::new(WriteCoordinator::default()),
    )
    .unwrap()
}
async fn apply(executor: &MutationExecutor, operation: Value) -> Result<Value, ToolError> {
    executor
        .invoke(
            "apply_patch".into(),
            json!({"callId":"opaque:provider-id","operation":operation}),
            CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn native_create_update_delete_preserves_file_identity_and_refuses_unsafe_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);
    let path = root.join("text");
    let create = json!({"type":"create_file","path":"text","diff":"+one\r\n+two\r\n+"});
    assert_eq!(
        apply(&executor, create.clone()).await.unwrap(),
        json!({"status":"completed"})
    );
    assert_eq!(fs::read(&path).unwrap(), b"one\ntwo\n");
    let original = File::from_std(fs::File::open(&path).unwrap())
        .metadata()
        .unwrap();
    assert!(matches!(
        apply(&executor, create).await,
        Err(ToolError::Failed(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), b"one\ntwo\n");
    fs::write(&path, "one\r\ntwo\r\n").unwrap();
    assert_eq!(
        apply(
            &executor,
            json!({"type":"update_file","path":"text",
        "diff":"@@\n one\n-two\n+$& 😀"})
        )
        .await
        .unwrap(),
        json!({"status":"completed"})
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "one\r\n$& 😀\r\n");
    let after = File::from_std(fs::File::open(&path).unwrap())
        .metadata()
        .unwrap();
    assert_eq!(
        (original.dev(), original.ino(), original.permissions()),
        (after.dev(), after.ino(), after.permissions())
    );
    let before = fs::read(&path).unwrap();
    for operation in [
        json!({"type":"update_file","path":"text","diff":"@@\n-missing\n+new"}),
        json!({"type":"update_file","path":"text","diff":"@@\n-one\n+new\n*** Add File: injected\n+bad"}),
        json!({"type":"delete_file","path":"."}),
        json!({"type":"create_file","path":"missing/child","diff":"+new"}),
        json!({"type":"create_file","path":"../outside","diff":"+new"}),
        json!({"type":"update_file","path":"text","diff":null}),
    ] {
        assert!(matches!(
            apply(&executor, operation).await,
            Err(ToolError::Failed(_) | ToolError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert!(!root.join("injected").exists());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&path, root.join("alias")).unwrap();
        assert!(
            apply(&executor, json!({"type":"delete_file","path":"alias"}))
                .await
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert_eq!(
        apply(&executor, json!({"type":"delete_file","path":"text"}))
            .await
            .unwrap(),
        json!({"status":"completed"})
    );
    assert!(!path.exists());
    #[cfg(unix)]
    assert!(root.join("alias").symlink_metadata().is_ok());
    assert!(
        apply(&executor, json!({"type":"delete_file","path":"text"}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn envelope_preserves_known_prefix_on_failure_and_stop_without_faking_transactionality() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);
    fs::write(root.join("existing"), "keep\n").unwrap();
    let patch = "*** Begin Patch\n*** Add File: created\n+first 😀\n*** Update File: existing\n@@\n-absent\n+replacement\n*** Delete File: later\n*** End Patch";
    fs::write(root.join("later"), "untouched").unwrap();
    let result = executor
        .invoke("apply_patch".into(), json!(patch), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(
        result["applied"],
        json!([{"type":"create_file","path":"created"}])
    );
    assert_eq!(
        result["failed"],
        json!({"type":"update_file","path":"existing"})
    );
    assert!(result.get("stoppedBefore").is_none());
    assert_eq!(
        fs::read_to_string(root.join("created")).unwrap(),
        "first 😀\n"
    );
    assert_eq!(fs::read(root.join("existing")).unwrap(), b"keep\n");
    assert_eq!(fs::read(root.join("later")).unwrap(), b"untouched");
    let token = CancellationToken::new();
    token.cancel();
    let result = executor
        .invoke(
            "apply_patch".into(),
            json!("*** Begin Patch\n*** Delete File: later\n*** End Patch"),
            token,
        )
        .await
        .unwrap();
    assert_eq!(result["applied"], json!([]));
    assert_eq!(
        result["stoppedBefore"],
        json!({"type":"delete_file","path":"later"})
    );
    assert_eq!(fs::read(root.join("later")).unwrap(), b"untouched");
    let result = executor.invoke("apply_patch".into(),
        json!("*** Begin Patch\n*** Update File: existing\n@@\n-keep\n+intermediate\n*** Update File: ./existing\n@@\n-intermediate\n+changed\n*** Delete File: later\n*** End Patch"),
        CancellationToken::new()).await.unwrap();
    assert_eq!(
        result,
        json!({"status":"completed","applied":[
        {"type":"update_file","path":"existing"},{"type":"update_file","path":"./existing"},{"type":"delete_file","path":"later"}],
        "output":"Applied 3 file operations."})
    );
    assert_eq!(fs::read(root.join("existing")).unwrap(), b"changed\n");
    assert!(!root.join("later").exists());
}

#[tokio::test]
async fn native_update_large_utf8_source_preserves_bytes_inode_and_mode() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);
    let path = root.join("large");
    let prefix = "unchanged configuration value: 零一二三四五六七八九\n".repeat(40_000);
    fs::write(&path, format!("{prefix}target = old\ntrailer\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    fs::hard_link(&path, root.join("alias")).unwrap();
    let before = File::from_std(fs::File::open(&path).unwrap())
        .metadata()
        .unwrap();
    assert_eq!(apply(&executor, json!({"type":"update_file","path":"large","diff":"@@\n-target = old\n+target = 新\n trailer"})).await.unwrap(),
        json!({"status":"completed"}));
    assert_eq!(
        fs::read(root.join("alias")).unwrap(),
        format!("{prefix}target = 新\ntrailer\n").as_bytes()
    );
    let after = File::from_std(fs::File::open(&path).unwrap())
        .metadata()
        .unwrap();
    assert_eq!(
        (before.dev(), before.ino(), before.permissions()),
        (after.dev(), after.ino(), after.permissions())
    );
}
