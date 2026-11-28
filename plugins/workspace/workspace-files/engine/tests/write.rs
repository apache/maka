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
use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn write_contract_authority_bounds_and_inode() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    // Ordinary fixture paths use the same spelling as Node realpath on Windows.
    #[cfg(windows)]
    let root = std::path::PathBuf::from(root.to_str().unwrap().strip_prefix(r"\\?\").unwrap());
    let coordinator = Arc::new(WriteCoordinator::default());
    let executor = MutationExecutor::new(
        &root,
        WriteScope::Restricted {
            roots: vec![root.clone()],
        },
        coordinator.clone(),
    )
    .unwrap();
    fs::write(root.join("text"), "old content").unwrap();
    #[cfg(unix)]
    fs::set_permissions(root.join("text"), fs::Permissions::from_mode(0o640)).unwrap();
    fs::hard_link(root.join("text"), root.join("hard")).unwrap();
    let before = File::from_std(fs::File::open(root.join("text")).unwrap())
        .metadata()
        .unwrap();
    let result = executor
        .invoke(
            "Write".into(),
            json!({"path":"text","content":"零"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"kind":"file_write","path":root.join("text"),"bytes":3,"previousContent":"old content"})
    );
    assert_eq!(fs::read(root.join("hard")).unwrap(), "零".as_bytes());
    let after = File::from_std(fs::File::open(root.join("text")).unwrap())
        .metadata()
        .unwrap();
    assert_eq!(
        (before.dev(), before.ino(), before.permissions()),
        (after.dev(), after.ino(), after.permissions())
    );
    let created = executor
        .invoke(
            "Write".into(),
            json!({"path":"new","content":""}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(fs::read(root.join("new")).unwrap(), b"");
    assert_eq!(created["previousContent"], "");
    for previous in [vec![0xff, 0x00], vec![b'x'; 8193]] {
        fs::write(root.join("new"), &previous).unwrap();
        let result = executor
            .invoke(
                "Write".into(),
                json!({"path":"new", "content":"replacement"}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        if let Ok(text) = std::str::from_utf8(&previous) {
            assert_eq!(result["previousContent"], text);
        } else {
            assert!(result.get("previousContent").is_none());
        }
        assert_eq!(fs::read(root.join("new")).unwrap(), b"replacement");
    }
    fs::create_dir(root.join("dir")).unwrap();
    #[cfg(unix)]
    {
        symlink("text", root.join("link")).unwrap();
        symlink("dir", root.join("dir-link")).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(root.join("fifo"))
                .status()
                .unwrap()
                .success()
        );
    }
    for input in [
        json!({"path":"x".repeat(4097),"content":"x"}),
        json!({"path":"text","content":"x","extra":1}),
        #[cfg(unix)]
        json!({"path":"link","content":"x"}),
        json!({"path":"dir","content":"x"}),
        #[cfg(unix)]
        json!({"path":"dir-link/file","content":"x"}),
        #[cfg(unix)]
        json!({"path":"fifo","content":"x"}),
        json!({"path":"missing/child","content":"x"}),
        json!({"path":"../outside","content":"x"}),
    ] {
        assert!(matches!(
            executor
                .invoke("Write".into(), input, CancellationToken::new())
                .await,
            Err(ToolError::Failed(_) | ToolError::Io { .. })
        ));
    }
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        executor
            .invoke(
                "Write".into(),
                json!({"path":"text","content":"x"}),
                cancelled
            )
            .await
            .is_err()
    );
    let disabled = MutationExecutor::new(&root, WriteScope::Disabled, coordinator.clone()).unwrap();
    assert!(disabled.names().is_empty());
    assert!(
        disabled
            .invoke(
                "Write".into(),
                json!({"path":"text","content":"x"}),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(fs::read(root.join("text")).unwrap(), "零".as_bytes());
    let outside = tempfile::NamedTempFile::new().unwrap();
    assert!(
        executor
            .invoke(
                "Write".into(),
                json!({"path":outside.path(),"content":"x"}),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    let bypass = MutationExecutor::new(&root, WriteScope::Unrestricted, coordinator).unwrap();
    // Canonical path avoids macOS's /var alias, since write paths refuse symlinks.
    bypass
        .invoke(
            "Write".into(),
            json!({"path":outside.path().canonicalize().unwrap(),"content":"bypass"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(fs::read(outside.path()).unwrap(), b"bypass");
}

#[test]
fn editor_saves_the_opened_version_and_rejects_stale_writers() {
    use maka_fs_tools::{
        directory,
        files::{Directory, FileCapture},
        path::WorkspacePath,
    };
    use std::sync::atomic::AtomicBool;
    let f = tempfile::tempdir().unwrap();
    let (workspace, identity) = directory::capture(f.path()).unwrap();
    fs::create_dir(workspace.join("private")).unwrap();
    fs::create_dir(workspace.join("control")).unwrap();
    let root = Directory::open(
        &workspace,
        &identity,
        &workspace.join("private"),
        &workspace.join("control"),
        None,
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    let path = WorkspacePath::from_bytes(b"README.md").unwrap();
    let file = workspace.join("README.md");
    let cancel = AtomicBool::new(false);
    let bytes = "# 标题\r\n\r\n- one\r\n";
    fs::write(&file, bytes).unwrap();
    let FileCapture::Ready(before) = root.read_file(&path, None, &cancel).unwrap() else {
        panic!("text")
    };
    let edited = format!("{bytes}{}", "追加\r\n".repeat(300_000));
    let version = root
        .save_text(&path, &before.version, &edited, None, &cancel)
        .unwrap()
        .unwrap();
    assert!(matches!(
        root.read_file(&path, Some(&version), &cancel).unwrap(),
        FileCapture::Ready(_)
    ));
    assert_eq!(fs::read_to_string(&file).unwrap(), edited);
    assert_eq!(
        root.save_text(&path, &before.version, "stale", None, &cancel)
            .unwrap(),
        None
    );
    let version = root
        .save_text(&path, &version, "smaller", None, &cancel)
        .unwrap()
        .unwrap();
    fs::hard_link(&file, workspace.join("alias.md")).unwrap();
    assert_eq!(
        root.save_text(&path, &version, "draft", None, &cancel)
            .unwrap_err()
            .to_string(),
        "files_hard_link"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("alias.md")).unwrap(),
        "smaller"
    );
    fs::remove_file(workspace.join("alias.md")).unwrap();
    fs::write(&file, "agent").unwrap();
    assert_eq!(
        root.save_text(&path, &version, "draft", None, &cancel)
            .unwrap(),
        None
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "agent");
}

#[tokio::test]
async fn confirmed_writes_compare_the_held_file_and_preserve_batch_versions() {
    use maka_agent_facts::artifact::content_digest;
    use maka_fs_tools::{ConfirmedInputs, WriteOutcome};
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let executor = MutationExecutor::new(
        &root,
        WriteScope::Restricted {
            roots: vec![root.clone()],
        },
        Arc::default(),
    )
    .unwrap();
    let a = root.join("first");
    let b = root.join("second");
    let hashes = || {
        [(&a, "one\n"), (&b, "two\n")]
            .into_iter()
            .map(|(p, s)| {
                (
                    p.to_str().unwrap().to_owned(),
                    content_digest(s.as_bytes())[7..].to_owned(),
                )
            })
            .collect()
    };
    let snapshot = || Arc::new(ConfirmedInputs::new(hashes(), |_, _| Ok(vec![])));
    fs::write(&a, "saved elsewhere\n").unwrap();
    fs::write(&b, "two\n").unwrap();
    let write = |guard| {
        executor.invoke_confirmed(
            "Write".into(),
            json!({"path":"first","content":"approved\n"}),
            CancellationToken::new(),
            guard,
        )
    };
    assert!(
        matches!(write(snapshot()).await.unwrap(), WriteOutcome::Stale(paths) if paths == [a.to_str().unwrap()])
    );
    assert_eq!(fs::read_to_string(&a).unwrap(), "saved elsewhere\n");
    let edit = executor
        .invoke_confirmed(
            "Edit".into(),
            json!({"path":"first","old_string":"one","new_string":"new"}),
            CancellationToken::new(),
            snapshot(),
        )
        .await
        .unwrap();
    assert!(matches!(edit, WriteOutcome::Stale(paths) if paths == [a.to_str().unwrap()]));
    fs::write(&a, "one\n").unwrap();
    assert!(matches!(
        write(snapshot()).await.unwrap(),
        WriteOutcome::Returned(_)
    ));
    assert_eq!(fs::read_to_string(&a).unwrap(), "approved\n");

    fs::write(&a, "one\n").unwrap();
    let patch = "*** Begin Patch
*** Update File: first
@@
-one
+new
*** Update File: ./first
@@
-new
+newer
*** Delete File: second
*** End Patch";
    let batch = |guard| {
        executor.invoke_confirmed(
            "apply_patch".into(),
            json!({"patch":patch}),
            CancellationToken::new(),
            guard,
        )
    };
    let changed = b.to_str().unwrap().to_owned();
    let guard = Arc::new(ConfirmedInputs::new(hashes(), move |_, _| {
        Ok(vec![changed.clone()])
    }));
    assert!(matches!(
        batch(guard).await.unwrap(),
        WriteOutcome::Stale(_)
    ));
    assert_eq!(fs::read_to_string(&a).unwrap(), "one\n");
    assert!(
        matches!(batch(snapshot()).await.unwrap(), WriteOutcome::Returned(value) if value["status"] == "completed")
    );
    assert_eq!(fs::read_to_string(&a).unwrap(), "newer\n");
    assert!(!b.exists());
    let alias = root.join("FIRST");
    if alias.is_file() {
        fs::write(&a, "one\n").unwrap();
        let mut versions = hashes();
        versions.insert(
            alias.to_str().unwrap().to_owned(),
            versions[a.to_str().unwrap()].clone(),
        );
        let guard = Arc::new(ConfirmedInputs::new(versions, |_, _| Ok(vec![])));
        let two_names = "*** Begin Patch\n*** Update File: first\n@@\n-one\n+two\n*** Update File: FIRST\n@@\n-two\n+three\n*** End Patch";
        let result = executor
            .invoke_confirmed(
                "apply_patch".into(),
                json!({"patch":two_names}),
                CancellationToken::new(),
                guard,
            )
            .await
            .unwrap();
        assert!(matches!(result, WriteOutcome::Returned(value) if value["status"] == "completed"));
        assert_eq!(fs::read_to_string(&a).unwrap(), "three\n");
    }
}
