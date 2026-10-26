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
use maka_fs_tools::path::WorkspacePath;
use maka_fs_tools::{ReadExecutor, ReadScope};
use serde_json::json;
use std::{fs, sync::atomic::AtomicBool};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn complete_search_keeps_late_deep_and_control_tail_matches() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let reader = ReadExecutor::new(
        &root,
        ReadScope::Restricted {
            roots: vec![root.clone()],
        },
    )
    .unwrap();
    let mut large = b"x\n".repeat(6 * 1024 * 1024);
    large.extend_from_slice(b"late-marker\n");
    fs::write(root.join("large.txt"), &large).unwrap();
    let mut deep = root.join("deep");
    fs::create_dir(&deep).unwrap();
    for _ in 0..129 {
        deep.push("d");
        fs::create_dir(&deep).unwrap();
    }
    fs::write(deep.join("tail.txt"), "deep-marker\n").unwrap();
    fs::create_dir(root.join("names")).unwrap();
    for i in 0..201 {
        fs::write(root.join(format!("names/{i:03}.txt")), []).unwrap();
    }
    fs::create_dir(root.join("controls")).unwrap();
    let control = format!("{}excluded.txt\n", "# comment\n".repeat(30000));
    fs::write(root.join("controls/.ignore"), &control).unwrap();
    fs::write(root.join("controls/excluded.txt"), "control-marker\n").unwrap();
    fs::write(root.join("controls/kept.txt"), "control-marker\n").unwrap();
    let cases = [
        ("Grep", json!({"path":"large.txt","pattern":"late-marker"})),
        ("Grep", json!({"path":"deep","pattern":"deep-marker"})),
        ("Glob", json!({"cwd":"names","pattern":"*.txt"})),
        ("Glob", json!({"cwd":"deep","pattern":"**/tail.txt"})),
        (
            "Grep",
            json!({"path":"controls","pattern":"control-marker"}),
        ),
    ];
    let mut results = Vec::new();
    for (tool, input) in cases {
        results.push(
            reader
                .invoke(tool.into(), input, CancellationToken::new())
                .await,
        );
    }
    let expected = [
        json!({"matches":["6291457:late-marker"],"complete":true}),
        json!({"matches":[format!("{}:1:deep-marker",deep.join("tail.txt").display())],"complete":true}),
        json!({"files":(0..201).map(|i|format!("{i:03}.txt")).collect::<Vec<_>>(),"complete":true}),
        json!({"files":[format!("{}tail.txt","d/".repeat(129))],"complete":true}),
        json!({"matches":[format!("{}:1:control-marker",root.join("controls/kept.txt").display())],"complete":true}),
    ];
    let failures = results
        .into_iter()
        .zip(expected)
        .enumerate()
        .filter_map(|(index, (actual, expected))| match actual {
            Ok(value) if value == expected => None,
            Ok(value) => Some(format!(
                "case{index}: wrong output ({} bytes)",
                value.to_string().len()
            )),
            Err(error) => Some(format!("case{index}: {error}")),
        })
        .collect::<Vec<_>>();
    assert_eq!(fs::read(root.join("large.txt")).unwrap(), large);
    assert_eq!(
        fs::read_to_string(root.join("controls/.ignore")).unwrap(),
        control
    );
    assert!(failures.is_empty(), "{}", failures.join("; "));
}

#[test]
fn complete_current_file_capture_and_existing_marker_keep_original_bytes() {
    use maka_fs_tools::files::{Directory, FileCapture};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let private = temp.path().join("private");
    let control = temp.path().join("control");
    for path in [&root, &private, &control] {
        fs::create_dir(path).unwrap();
    }
    let (root, identity) = maka_fs_tools::directory::capture(&root).unwrap();
    let bytes = "same original UTF8 🦀\n".repeat(150000).into_bytes();
    fs::write(root.join("original.txt"), &bytes).unwrap();
    let marker = format!(
        "{{\"schemaVersion\":1,\"workspaceId\":\"f81d4fae-7dec-11d0-a765-00a0c91e6bf6\"}}{}",
        " ".repeat(8192)
    );
    fs::write(root.join(maka_fs_tools::workspace::MARKER_FILE), &marker).unwrap();
    let marker_result = maka_fs_tools::workspace::read_identity(&root);
    let directory = Directory::open(
        &root,
        &identity,
        &private,
        &control,
        None,
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    let capture = directory.read_file(
        &WorkspacePath::from_bytes(b"original.txt").unwrap(),
        None,
        &AtomicBool::new(false),
    );
    assert_eq!(fs::read(root.join("original.txt")).unwrap(), bytes);
    assert_eq!(
        fs::read_to_string(root.join(maka_fs_tools::workspace::MARKER_FILE)).unwrap(),
        marker
    );
    let captured = match capture {
        Ok(FileCapture::Ready(value)) => value,
        other => panic!("complete file capture expected: {other:?}"),
    };
    assert_eq!(captured.data.len(), bytes.len());
    assert!(captured.data == bytes, "original file bytes changed");
    assert!(
        marker_result.is_ok(),
        "valid complete marker refused: {marker_result:?}"
    );
}

#[test]
fn complete_git_index_paths_keep_exact_raw_bytes_without_materializing_them() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use maka_fs_tools::git::{self, GitArea, GitDiff};
    use std::{
        io::Write,
        process::{Command, Stdio},
        sync::Arc,
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repository");
    let private = temp.path().join("private");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&private).unwrap();
    let run_git =
        |args: &[&str], input: Option<&[u8]>, alternate_index: Option<&std::path::Path>| {
            let mut command = Command::new("git");
            command
                .current_dir(&root)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(index) = alternate_index {
                command.env("GIT_INDEX_FILE", index);
            }
            if input.is_some() {
                command.stdin(Stdio::piped());
            }
            let mut child = command.spawn().unwrap();
            if let Some(input) = input {
                child.stdin.take().unwrap().write_all(input).unwrap();
            }
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "Git plumbing failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
    let git_command = |args: &[&str], input: Option<&[u8]>| run_git(args, input, None);
    git_command(&["init", "--quiet"], None);
    git_command(
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "base",
        ],
        None,
    );
    let oid = String::from_utf8(git_command(
        &["hash-object", "-w", "--stdin"],
        Some(b"original staged bytes\n"),
    ))
    .unwrap();
    let paths = [
        format!(
            "{}{}",
            format!("{}/", "a".repeat(200)).repeat(20),
            "b".repeat(77)
        ),
        format!(
            "{}{}",
            format!("{}/", "c".repeat(200)).repeat(20),
            "d".repeat(80)
        ),
    ];
    let input = paths
        .iter()
        .map(|path| format!("100644 {}\t{path}\n", oid.trim()))
        .collect::<String>();
    git_command(&["update-index", "--index-info"], Some(input.as_bytes()));
    let expected_tree = git_command(&["write-tree"], None);
    assert_eq!(
        paths.iter().map(String::len).collect::<Vec<_>>(),
        [4097, 4100]
    );
    let index = fs::read(root.join(".git/index")).unwrap();
    let head = fs::read(root.join(".git/HEAD")).unwrap();
    let (_, identity) = maka_fs_tools::directory::capture(&root).unwrap();
    let mut results = Vec::new();
    let mut oracles = Vec::new();
    for path in &paths {
        let wire = WorkspacePath {
            bytes_base64: STANDARD.encode(path),
        };
        results.push(git::diff(
            &root,
            &identity,
            &private,
            None,
            GitArea::Staged,
            &wire,
            Arc::new(AtomicBool::new(false)),
        ));
        oracles.push(
            String::from_utf8(git_command(
                &[
                    "diff",
                    "--cached",
                    "--full-index",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-renames",
                    "--",
                    path,
                ],
                None,
            ))
            .unwrap(),
        );
    }
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(root.join(".git/HEAD")).unwrap(), head);
    let mut failures = Vec::new();
    let patches = results
        .into_iter()
        .enumerate()
        .filter_map(|(i, result)| match result {
            Ok(Some(GitDiff::Text { patch })) => Some(patch),
            Ok(_) => {
                failures.push(format!("path{i}: expected a complete staged text patch"));
                None
            }
            Err(error) => {
                failures.push(format!("path{i}: {error}"));
                None
            }
        })
        .collect::<Vec<_>>();
    assert!(failures.is_empty(), "{}", failures.join("; "));
    // C-quoted paths and zero-length hunk spellings can differ while encoding
    // the same exact patch. Let Git independently parse both full outputs and
    // compare every raw path, mode and blob through the resulting tree.
    for (name, patches) in [("actual", &patches), ("oracle", &oracles)] {
        let alternate = temp.path().join(format!("{name}.index"));
        run_git(&["read-tree", "HEAD"], None, Some(&alternate));
        for patch in patches {
            run_git(
                &["apply", "--cached", "--whitespace=nowarn", "-"],
                Some(patch.as_bytes()),
                Some(&alternate),
            );
        }
        assert_eq!(
            run_git(&["write-tree"], None, Some(&alternate)),
            expected_tree,
            "{name} patch must reproduce the complete original staged tree"
        );
    }
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(root.join(".git/HEAD")).unwrap(), head);
    assert!(!root.join("a".repeat(200)).exists());
    assert!(!root.join("c".repeat(200)).exists());
}
