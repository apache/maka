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
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::symlink};
use std::{fs, path::Path, process::Command};
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
async fn grep(
    reader: &ReadExecutor,
    input: Value,
) -> Result<Value, maka_agent_facts::tools::ToolError> {
    reader
        .invoke("Grep".into(), input, CancellationToken::new())
        .await
}

#[tokio::test]
async fn slice_search_matches_ripgrep_regex_lines_and_complete_ignore_scope() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    for directory in [".git/info", "src", "ignored", ".hidden"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    for (path, text) in [
        (".gitignore", "ignored/\n*.skip\nsrc/drop.txt\n"),
        (".ignore", "!src/drop.txt\n!.hidden/\n"),
        (".rgignore", "src/drop.txt\n"),
        (".git/info/exclude", "excluded.txt\n"),
        ("src/main.rs", "zero\nα token\r\nTOKEN --flag\ntoken\nlast"),
        ("src/drop.txt", "token"),
        ("src/other.txt", "token\ntoken\n"),
        ("src/no.skip", "token"),
        ("ignored/secret.txt", "token"),
        (".hidden/file.txt", "token"),
        ("excluded.txt", "token"),
    ] {
        fs::write(root.join(path), text).unwrap();
    }
    fs::write(root.join("binary"), b"token\0hidden").unwrap();
    fs::write(root.join("many.txt"), "token\n".repeat(60)).unwrap();
    fs::write(root.join("utf8-bom.txt"), "\u{feff}token\n").unwrap();
    for (name, little_endian, bom) in [
        ("utf16-le.txt", true, [0xff, 0xfe]),
        ("utf16-be.txt", false, [0xfe, 0xff]),
    ] {
        let mut bytes = bom.to_vec();
        for unit in "token\n漢字\n".encode_utf16() {
            bytes.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        fs::write(root.join(name), bytes).unwrap();
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, SetFileAttributesW};
        fs::write(root.join("win-hidden.txt"), "token").unwrap();
        fs::create_dir(root.join("win-hidden-dir")).unwrap();
        fs::write(root.join("win-hidden-dir/file.txt"), "token").unwrap();
        for name in ["win-hidden.txt", "win-hidden-dir"] {
            let path: Vec<u16> = root
                .join(name)
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            // SAFETY: the terminated path names only this test's file/directory.
            assert_ne!(
                unsafe { SetFileAttributesW(path.as_ptr(), FILE_ATTRIBUTE_HIDDEN) },
                0
            );
        }
    }
    let executor = reader(&root);
    for (pattern, path, glob) in [
        ("token", ".", None),
        ("(?i)token", "src", None),
        (r"\p{Greek}", ".", None),
        ("--flag", ".", None),
        ("^last$", "src/main.rs", None),
        ("", "src/other.txt", None),
        ("absent", ".", None),
        ("token", ".", Some("*.txt")),
        ("token", ".", Some("!*.txt")),
        ("token", ".", Some("*.skip")),
        ("token", "src/no.skip", None),
        ("^token$", "utf8-bom.txt", None),
        ("漢字", "utf16-le.txt", None),
        ("漢字", "utf16-be.txt", None),
        (r"\Atoken", "src/main.rs", None),
        (r"(?-m)^token", "src/main.rs", None),
        (r"token\z", "src/other.txt", None),
        #[cfg(windows)]
        ("token", "win-hidden.txt", None),
        #[cfg(windows)]
        ("token", ".", Some("*")),
    ] {
        // The original filesystem executor canonicalizes before invoking rg.
        let target = root.join(path).canonicalize().unwrap();
        #[cfg(windows)]
        let target =
            std::path::PathBuf::from(target.to_str().unwrap().strip_prefix(r"\\?\").unwrap());
        let mut args = json!({"pattern":pattern, "path":target});
        let mut command = Command::new("rg");
        command.args(["--no-config", "-n", "--no-heading", "--color=never"]);
        if let Some(glob) = glob {
            args["glob"] = json!(glob);
            command.args(["--glob", glob]);
        }
        let original = command
            .arg("--")
            .arg(pattern)
            .arg(&target)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            matches!(original.status.code(), Some(0 | 1)),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );
        let mut expected: Vec<_> = String::from_utf8_lossy(&original.stdout)
            .split('\n')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        expected.sort();
        let result = grep(&executor, args).await.unwrap();
        let mut actual: Vec<_> = result["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        actual.sort();
        assert_eq!(actual, expected, "{pattern:?} in {path} with {glob:?}");
    }
    for n in 0..6 {
        fs::write(root.join(format!("cap{n}.txt")), "CAP\n".repeat(60)).unwrap();
    }
    fs::create_dir(root.join("z-later")).unwrap();
    fs::write(root.join("z-later/tail.txt"), "CAP\n").unwrap();
    let result = grep(&executor, json!({"pattern":"CAP"})).await.unwrap();
    let mut expected = (0..6)
        .flat_map(|file| {
            let path = root.join(format!("cap{file}.txt"));
            (1..=60).map(move |line| format!("{}:{line}:CAP", path.display()))
        })
        .collect::<Vec<_>>();
    expected.push(format!("{}:1:CAP", root.join("z-later/tail.txt").display()));
    let mut actual = result["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
    assert_eq!(result["complete"], true);
}

#[tokio::test]
#[cfg(unix)]
async fn grep_preserves_capability_and_reports_regex_resource_and_cancellation_failures() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().canonicalize().unwrap();
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    fs::write(base.join("outside.txt"), "OUTSIDE").unwrap();
    fs::write(root.join("inside.txt"), "INSIDE").unwrap();
    symlink(base.join("outside.txt"), root.join("escape.txt")).unwrap();
    let fifo = std::ffi::CString::new(root.join("fifo").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let executor = reader(&root);
    fs::rename(&root, base.join("captured")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("replacement.txt"), "OUTSIDE").unwrap();
    let result = grep(&executor, json!({"pattern":"INSIDE|OUTSIDE"}))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"matches":[format!("{}:1:INSIDE",root.join("inside.txt").display())],"complete":true})
    );
    for args in [
        json!({"pattern":"[bad"}),
        json!({"pattern":r"\n"}),
        json!({"pattern":"x","path":"escape.txt"}),
        json!({"pattern":"x","path":"fifo"}),
        json!({"pattern":"x","path":base.join("outside.txt")}),
        json!({"pattern":"x","glob":null}),
    ] {
        assert!(grep(&executor, args).await.is_err());
    }
    fs::write(
        base.join("captured/large"),
        vec![b'x'; 10 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert_eq!(
        grep(&executor, json!({"pattern":"absent","path":"large"}))
            .await
            .unwrap(),
        json!({"matches":[],"complete":true})
    );
    let token = CancellationToken::new();
    token.cancel();
    assert!(
        executor
            .invoke("Grep".into(), json!({"pattern":"INSIDE"}), token)
            .await
            .is_err()
    );
}
