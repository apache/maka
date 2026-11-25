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
async fn apply(executor: &MutationExecutor, patch: &str) -> Result<Value, ToolError> {
    executor
        .invoke(
            "apply_patch".into(),
            json!({"patch": patch}),
            CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn create_update_delete_preserves_file_identity_and_refuses_unsafe_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);
    let path = root.join("text");
    let create = "*** Begin Patch\r\n*** Add File: text\r\n+one\r\n+two\r\n*** End Patch\r\n";
    assert_eq!(
        apply(&executor, create).await.unwrap(),
        json!({
            "status": "completed",
            "applied": [{"type": "create_file", "path": "text"}],
            "output": "Applied 1 file operation."
        })
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
            "*** Begin Patch\n*** Update File: text\n@@\n one\n-two\n+$& 😀\n*** End Patch"
        )
        .await
        .unwrap(),
        json!({
            "status": "completed",
            "applied": [{"type": "update_file", "path": "text"}],
            "output": "Applied 1 file operation."
        })
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
    for patch in [
        "*** Begin Patch\n*** Update File: text\n@@\n-missing\n+new\n*** End Patch",
        "*** Begin Patch\n*** Delete File: .\n*** End Patch",
        "*** Begin Patch\n*** Add File: missing/child\n+new\n*** End Patch",
        "*** Begin Patch\n*** Add File: ../outside\n+new\n*** End Patch",
        "*** Begin Patch\n*** Add File: bad\ntext\n*** End Patch",
        "not a patch",
    ] {
        assert!(matches!(
            apply(&executor, patch).await,
            Err(ToolError::Failed(_) | ToolError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert!(
        executor
            .invoke(
                "apply_patch".into(),
                json!({"patch": null}),
                CancellationToken::new(),
            )
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&path, root.join("alias")).unwrap();
        assert!(
            apply(
                &executor,
                "*** Begin Patch\n*** Delete File: alias\n*** End Patch"
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert_eq!(
        apply(
            &executor,
            "*** Begin Patch\n*** Delete File: text\n*** End Patch"
        )
        .await
        .unwrap(),
        json!({
            "status": "completed",
            "applied": [{"type": "delete_file", "path": "text"}],
            "output": "Applied 1 file operation."
        })
    );
    assert!(!path.exists());
    #[cfg(unix)]
    assert!(root.join("alias").symlink_metadata().is_ok());
    assert!(
        apply(
            &executor,
            "*** Begin Patch\n*** Delete File: text\n*** End Patch"
        )
        .await
        .is_err()
    );
    assert_eq!(
        apply(
            &executor,
            "*** Begin Patch\n*** Add File: empty\n*** End Patch"
        )
        .await
        .unwrap(),
        json!({
            "status": "completed",
            "applied": [{"type": "create_file", "path": "empty"}],
            "output": "Applied 1 file operation."
        })
    );
    assert!(fs::read(root.join("empty")).unwrap().is_empty());
}

#[tokio::test]
async fn envelope_preserves_known_prefix_on_failure_and_stop_without_faking_transactionality() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);
    fs::write(root.join("existing"), "keep\n").unwrap();
    let patch = "*** Begin Patch\n*** Add File: created\n+first 😀\n*** Update File: existing\n@@\n-absent\n+replacement\n*** Delete File: later\n*** End Patch";
    fs::write(root.join("later"), "untouched").unwrap();
    let result = apply(&executor, patch).await.unwrap();
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
    let cancelled = executor
        .invoke(
            "apply_patch".into(),
            json!({"patch": "*** Begin Patch\n*** Delete File: later\n*** End Patch"}),
            token,
        )
        .await
        .unwrap_err();
    assert!(
        cancelled
            .to_string()
            .contains("apply_patch cancelled before operation"),
        "{cancelled}"
    );
    assert_eq!(fs::read(root.join("later")).unwrap(), b"untouched");
    let result = apply(
        &executor,
        "*** Begin Patch\n*** Update File: existing\n@@\n-keep\n+intermediate\n*** Update File: ./existing\n@@\n-intermediate\n+changed\n*** Delete File: later\n*** End Patch",
    )
    .await
    .unwrap();
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
async fn envelope_preserves_applied_prefix_on_io_error() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executor = executor(&root);

    let result = apply(
        &executor,
        "*** Begin Patch\n*** Add File: created_before_io\n+saved\n*** Add File: missing_dir/child\n+blocked\n*** End Patch",
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(
        result["applied"],
        json!([{"type": "create_file", "path": "created_before_io"}])
    );
    assert_eq!(
        result["failed"],
        json!({"type": "create_file", "path": "missing_dir/child"})
    );
    assert!(result.get("stoppedBefore").is_none());
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("Write filesystem error"),
        "{result}"
    );
    assert_eq!(
        fs::read_to_string(root.join("created_before_io")).unwrap(),
        "saved\n"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let readonly = root.join("readonly");
        fs::write(&readonly, "keep\n").unwrap();
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o444)).unwrap();
        if fs::OpenOptions::new().write(true).open(&readonly).is_err() {
            let result = apply(
                &executor,
                "*** Begin Patch\n*** Add File: created_before_perm\n+saved\n*** Update File: readonly\n@@\n-keep\n+edit\n*** End Patch",
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "failed");
            assert_eq!(
                result["applied"],
                json!([{"type": "create_file", "path": "created_before_perm"}])
            );
            assert_eq!(
                result["failed"],
                json!({"type": "update_file", "path": "readonly"})
            );
            assert!(result.get("stoppedBefore").is_none());
            assert!(
                result["error"]
                    .as_str()
                    .unwrap()
                    .contains("Write filesystem error"),
                "{result}"
            );
            assert_eq!(
                fs::read_to_string(root.join("created_before_perm")).unwrap(),
                "saved\n"
            );
            assert_eq!(fs::read(&readonly).unwrap(), b"keep\n");
        }
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o644)).unwrap();
    }
}
