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

#![cfg(windows)]

use maka_agent_facts::tools::ToolExecutor;
use maka_fs_tools::{MutationExecutor, ReadExecutor, ReadScope, WriteCoordinator, WriteScope};
use serde_json::json;
use std::{fs, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

async fn read(
    executor: &ReadExecutor,
    path: impl AsRef<Path>,
) -> Result<serde_json::Value, maka_agent_facts::tools::ToolError> {
    executor
        .invoke(
            "Read".into(),
            json!({"path":path.as_ref()}),
            CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn case_sensitive_sibling_roots_do_not_alias_reads_or_mutations() {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
        FileCaseSensitiveInfo, SetFileInformationByHandle,
    };
    let temp = tempfile::tempdir().unwrap();
    let directory = fs::OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(temp.path())
        .unwrap();
    let info = FILE_CASE_SENSITIVE_INFO { Flags: 1 };
    // SAFETY: the handle grants WRITE_ATTRIBUTES; the structure matches the class.
    assert_ne!(
        unsafe {
            SetFileInformationByHandle(
                directory.as_raw_handle(),
                FileCaseSensitiveInfo,
                std::ptr::from_ref(&info).cast(),
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
    drop(directory);
    let upper = temp.path().join("Repo");
    let lower = temp.path().join("repo");
    fs::create_dir(&upper).unwrap();
    fs::create_dir(&lower).unwrap();
    fs::write(upper.join("file"), "upper").unwrap();
    fs::write(lower.join("file"), "lower").unwrap();
    let reader = ReadExecutor::new(
        &upper,
        ReadScope::Restricted {
            roots: vec![upper.clone()],
        },
    )
    .unwrap();
    assert!(read(&reader, lower.join("file")).await.is_err());
    let writes = Arc::new(WriteCoordinator::default());
    let writer = MutationExecutor::new(
        &upper,
        WriteScope::Restricted {
            roots: vec![upper.clone()],
        },
        writes.clone(),
    )
    .unwrap();
    for (name, input) in [
        (
            "Write",
            json!({"path":lower.join("file"),"content":"wrong"}),
        ),
        (
            "apply_patch",
            json!({"callId":"case","operation":{"type":"delete_file","path":lower.join("file")}}),
        ),
    ] {
        assert!(
            writer
                .invoke(name.into(), input, CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(fs::read(upper.join("file")).unwrap(), b"upper");
        assert_eq!(fs::read(lower.join("file")).unwrap(), b"lower");
    }
    let union = MutationExecutor::new(
        &upper,
        WriteScope::Restricted {
            roots: vec![upper.clone(), lower.clone()],
        },
        writes,
    )
    .unwrap();
    union
        .invoke(
            "Write".into(),
            json!({"path":lower.join("file"),"content":"changed"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(fs::read(upper.join("file")).unwrap(), b"upper");
    assert_eq!(fs::read(lower.join("file")).unwrap(), b"changed");
}

#[tokio::test]
async fn windows_path_spellings_preserve_the_captured_scope_and_directory_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Workspace-Ä");
    let outside = temp.path().join("Workspace-Ä-outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("text"), "admitted").unwrap();
    fs::write(outside.join("text"), "outside").unwrap();
    let canonical = root.canonicalize().unwrap();
    let executor = ReadExecutor::new(
        &canonical,
        ReadScope::Restricted {
            roots: vec![canonical.clone()],
        },
    )
    .unwrap();
    for path in [
        root.join("text"),
        canonical.join("text"),
        root.join("text").to_str().unwrap().to_lowercase().into(),
        root.join("text")
            .to_str()
            .unwrap()
            .replace('\\', "/")
            .into(),
        "text".into(),
    ] {
        assert_eq!(
            read(&executor, &path).await.unwrap(),
            json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null}),
            "{path:?}"
        );
    }
    let rooted = root.join("text");
    let mut components = rooted.components();
    components.next().unwrap();
    assert_eq!(
        read(&executor, components.as_path()).await.unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    for path in [
        outside.join("text"),
        root.join("../Workspace-Ä-outside/text"),
        r"C:text".into(),
        r"\\.\pipe\maka-not-a-filesystem-path".into(),
        r"\\?\GLOBALROOT\Device\Null".into(),
    ] {
        assert!(read(&executor, &path).await.is_err(), "{path:?}");
    }
    let union = ReadExecutor::new(
        &canonical,
        ReadScope::Restricted {
            roots: vec![canonical.clone(), temp.path().to_owned()],
        },
    )
    .unwrap();
    assert_eq!(
        read(&union, "../Workspace-Ä-outside/text").await.unwrap(),
        json!({"content":"outside","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    // cap-std keeps Windows directories unrenameable while their capability is
    // held. Unlike Unix, the attempted replacement itself must fail.
    let moved = temp.path().join("moved");
    assert!(fs::rename(&root, &moved).is_err());
    assert_eq!(
        read(&executor, "text").await.unwrap(),
        json!({"content":"admitted","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
    drop(executor);
    drop(union);
    fs::rename(&root, &moved).unwrap();

    let bypass = ReadExecutor::new(&outside, ReadScope::Unrestricted).unwrap();
    assert_eq!(
        read(&bypass, outside.join("text")).await.unwrap(),
        json!({"content":"outside","offset":0,"returnedLines":1,"totalLines":1,"next":null})
    );
}
